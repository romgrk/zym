/*
 * process/runner-main.ts — the process-runner child (see runner.ts for the why).
 *
 * Why it exists: the main zym process is a long-lived node-gtk process that
 * accrues a large resident set (1+ GiB). On this platform node spawns children
 * with a plain `fork()` (libuv's posix_spawn fast path isn't compiled into the
 * prebuilt binary), so every subprocess copies the parent's page tables — tens
 * of ms each at that RSS, and the git poller fires a steady stream of them.
 *
 * This child is a tiny, near-empty node process. The parent forks the BIG
 * process exactly once to launch it; thereafter every command runs by forking
 * THIS small process (~1 ms regardless of how large the editor grows). It reads
 * framed requests on stdin and writes framed responses on stdout (id-keyed, many
 * in flight) — the binary framing in codec.ts.
 *
 * Keep imports minimal — every module loaded here is pure overhead on the one
 * thing this process is for: staying small.
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import process from 'node:process';
import { FrameReader, FrameWriter, makeFrameParser, ReqKind, ResKind } from './codec.ts';

const MAX_BUFFER = 64 * 1024 * 1024;
const EMPTY = Buffer.alloc(0);

interface RunResult {
  ok: boolean;
  code: number; // exit code, or -1 when killed by a signal
  stdout: Buffer;
  stderr: Buffer;
}

/** A spec parsed from a RUN/STREAM request body (after the id). */
interface Spec {
  file: string;
  cwd: string;
  args: string[];
  input: Buffer | null;
}

function send(frame: Buffer): void {
  process.stdout.write(frame);
}

/** Run one command, buffering its output; `input` (if given) is written to stdin. */
function runBuffered(spec: Spec, cb: (r: RunResult) => void): void {
  let child;
  try {
    child = execFile(
      spec.file,
      spec.args,
      { cwd: spec.cwd || undefined, encoding: 'buffer', maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? -1 : 0;
        cb({ ok: !err, code, stdout: (stdout as Buffer) ?? EMPTY, stderr: (stderr as Buffer) ?? EMPTY });
      },
    );
  } catch (e) {
    cb({ ok: false, code: -1, stdout: EMPTY, stderr: Buffer.from(String((e as Error)?.message ?? e), 'utf8') });
    return;
  }
  if (spec.input != null) child.stdin?.end(spec.input);
}

// Live streaming children, keyed by request id, so CANCEL can kill them.
const streaming = new Map<number, ChildProcess>();

/** Run one command, forwarding stdout/stderr chunks as they arrive, then END. */
function runStreaming(id: number, spec: Spec): void {
  let child: ChildProcess;
  try {
    child = spawn(spec.file, spec.args, { cwd: spec.cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    send(new FrameWriter().u8(ResKind.STDERR).u32(id).bytes(Buffer.from(String((e as Error)?.message ?? e), 'utf8')).frame());
    send(new FrameWriter().u8(ResKind.END).u32(id).u8(0).i32(-1).frame());
    return;
  }
  streaming.set(id, child);
  child.stdout?.on('data', (d: Buffer) => send(new FrameWriter().u8(ResKind.STDOUT).u32(id).bytes(d).frame()));
  child.stderr?.on('data', (d: Buffer) => send(new FrameWriter().u8(ResKind.STDERR).u32(id).bytes(d).frame()));
  child.on('error', (e) => send(new FrameWriter().u8(ResKind.STDERR).u32(id).bytes(Buffer.from(e.message, 'utf8')).frame()));
  child.on('close', (code, signal) => {
    streaming.delete(id);
    send(new FrameWriter().u8(ResKind.END).u32(id).u8(code === 0 ? 1 : 0).i32(signal ? -1 : code ?? -1).frame());
  });
  // Close stdin (no streaming command feeds it today) so stdin-reading tools see EOF.
  child.stdin?.end(spec.input ?? undefined);
}

/** Read a RUN/STREAM request body after its `kind` + `id`. */
function readSpec(r: FrameReader): Spec {
  const file = r.str();
  const cwd = r.str();
  const argc = r.u32();
  const args: string[] = [];
  for (let i = 0; i < argc; i++) args.push(r.str());
  const input = r.u8() ? Buffer.from(r.bytes()) : null;
  return { file, cwd, args, input };
}

const onFrame = (body: Buffer): void => {
  const r = new FrameReader(body);
  const kind = r.u8();
  const id = r.u32();
  if (kind === ReqKind.CANCEL) {
    streaming.get(id)?.kill();
    return;
  }
  const spec = readSpec(r);
  if (kind === ReqKind.STREAM) {
    runStreaming(id, spec);
    return;
  }
  runBuffered(spec, (res) => {
    send(new FrameWriter().u8(ResKind.RESULT).u32(id).u8(res.ok ? 1 : 0).i32(res.code).bytes(res.stdout).bytes(res.stderr).frame());
  });
};

process.stdin.on('data', makeFrameParser(onFrame));
// Parent gone (pipe closed): nothing left to serve — exit.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
