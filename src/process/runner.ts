/*
 * process/runner.ts — run external commands through a tiny long-lived broker
 * child, so the giant node-gtk parent never fork()s (fork cost scales with its
 * RSS — see runner-main.ts). Generalized from the old git-only broker; any
 * subsystem that shells out (git, gh, …) routes through `runProcess`.
 *
 * Async only. The framing is binary (codec.ts), so a command's stdout/stderr —
 * up to 64 MiB — crosses the pipe as raw bytes, never JSON-escaped.
 *
 * Robustness: the child is lazily (re)spawned on first use and after a crash. If
 * the broker path is unavailable (spawn failed), calls fall back to spawning the
 * command directly from this process — we only lose the fork-cost win, never the
 * result.
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FrameReader, FrameWriter, makeFrameParser, ReqKind, ResKind } from './codec.ts';

const MAX_BUFFER = 64 * 1024 * 1024;
const RUNNER_MAIN = fileURLToPath(new URL('./runner-main.ts', import.meta.url));
const EMPTY = Buffer.alloc(0);

/** A command to run: `file` with `args`, optionally in `cwd`, optionally fed `input` on stdin. */
export interface ProcSpec {
  file: string;
  args: string[];
  cwd?: string;
  /** Written to the command's stdin (e.g. a patch for `git apply`). */
  input?: string | Buffer;
}

export interface ProcResult {
  /** The command exited 0. */
  ok: boolean;
  /** Exit code, or null when the command was killed by a signal. */
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

export type ProcDone = (res: ProcResult) => void;

/** Callbacks for a streaming run: stdout/stderr arrive in chunks, then `onDone`. */
export interface ProcStream {
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  /** Fires once when the command exits (or fails to spawn: `ok=false, code=null`). */
  onDone: (res: { ok: boolean; code: number | null }) => void;
}

/** Controls an in-flight streaming run. */
export interface ProcHandle {
  /** Kill the command; no further callbacks fire. */
  cancel(): void;
}

let child: ChildProcess | null = null;
let nextId = 1;
const pending = new Map<number, ProcDone>();
const streamPending = new Map<number, ProcStream>();

// stdout is ref'd (keeps the host loop alive) only while a request is in flight.
function active(): number {
  return pending.size + streamPending.size;
}
function refLoop(): void {
  if (active() === 0) refable(child?.stdout)?.ref(); // call before adding work
}
function unrefIfIdle(): void {
  if (active() === 0) refable(child?.stdout)?.unref(); // call after removing work
}

// Pipe stdio are net.Sockets at runtime (so they have ref/unref), but they're
// typed as the base Writable/Readable; narrow before toggling the loop ref.
type Refable = { ref(): void; unref(): void };
function refable(s: unknown): Refable | undefined {
  return s && typeof (s as Refable).unref === 'function' ? (s as Refable) : undefined;
}

/** Lazily (re)spawn the broker child and wire its response stream. No-op when healthy. */
function ensureChild(): boolean {
  if (child && child.exitCode === null && !child.killed) return true;
  teardown();
  try {
    child = spawn(process.execPath, [RUNNER_MAIN], { stdio: ['pipe', 'pipe', 'inherit'] });
    child.on('error', () => teardown());
    child.on('exit', () => {
      // Fail any in-flight calls; the next call respawns.
      for (const cb of pending.values()) cb({ ok: false, code: null, stdout: EMPTY, stderr: Buffer.from('process runner exited') });
      pending.clear();
      for (const s of streamPending.values()) s.onDone({ ok: false, code: null });
      streamPending.clear();
      teardown();
    });
    child.stdout!.on('data', makeFrameParser(onResponse));
    // Don't let the broker keep the host's event loop alive: the editor runs the
    // GLib loop forever, but short-lived processes (tests, scripts) must still be
    // able to exit. The child handle + stdin stay unref'd; stdout is ref'd only
    // while requests are in flight (see runProcess / onResponse).
    child.unref();
    refable(child.stdin)?.unref();
    refable(child.stdout)?.unref();
    return true;
  } catch {
    teardown();
    return false;
  }
}

function teardown(): void {
  if (child) {
    child.stdout?.removeAllListeners();
    try { child.kill(); } catch { /* already exited */ }
    child = null;
  }
}

function onResponse(body: Buffer): void {
  const r = new FrameReader(body);
  const kind = r.u8();
  const id = r.u32();
  if (kind === ResKind.RESULT) {
    const ok = r.u8() === 1;
    const codeRaw = r.i32();
    const stdout = Buffer.from(r.bytes()); // copy out of the parser's reused buffer
    const stderr = Buffer.from(r.bytes());
    const cb = pending.get(id);
    if (!cb) return;
    pending.delete(id);
    unrefIfIdle();
    cb({ ok, code: codeRaw < 0 ? null : codeRaw, stdout, stderr });
    return;
  }
  // Streaming response (STDOUT/STDERR chunk or END). A cancelled/unknown id has no
  // handler; drop it (mirrors a stale buffered reply).
  const s = streamPending.get(id);
  if (!s) return;
  if (kind === ResKind.STDOUT) return s.onStdout?.(Buffer.from(r.bytes()));
  if (kind === ResKind.STDERR) return s.onStderr?.(Buffer.from(r.bytes()));
  // END
  const ok = r.u8() === 1;
  const codeRaw = r.i32();
  streamPending.delete(id);
  unrefIfIdle();
  s.onDone({ ok, code: codeRaw < 0 ? null : codeRaw });
}

/** A RUN/STREAM request frame for `spec`, tagged `kind`. */
function requestFrame(kind: number, id: number, spec: ProcSpec): Buffer {
  const input = spec.input == null ? null : Buffer.isBuffer(spec.input) ? spec.input : Buffer.from(spec.input, 'utf8');
  const w = new FrameWriter();
  w.u8(kind).u32(id).str(spec.file).str(spec.cwd ?? '').u32(spec.args.length);
  for (const a of spec.args) w.str(a);
  if (input == null) w.u8(0);
  else w.u8(1).bytes(input);
  return w.frame();
}

/** Run a command via the broker, buffering its output (falls back to a direct spawn if it's down). */
export function runProcess(spec: ProcSpec, onDone: ProcDone): void {
  if (!ensureChild() || !child?.stdin) {
    directRun(spec, onDone);
    return;
  }
  const id = nextId++;
  refLoop();
  pending.set(id, onDone);
  child.stdin.write(requestFrame(ReqKind.RUN, id, spec));
}

/** Run a command via the broker, streaming stdout/stderr as it arrives. Returns a
 *  handle to cancel it. Falls back to a direct streaming spawn if the broker is down. */
export function runProcessStream(spec: ProcSpec, handlers: ProcStream): ProcHandle {
  if (!ensureChild() || !child?.stdin) return directRunStream(spec, handlers);
  const id = nextId++;
  refLoop();
  streamPending.set(id, handlers);
  child.stdin.write(requestFrame(ReqKind.STREAM, id, spec));
  return {
    cancel() {
      if (!streamPending.has(id)) return; // already ended/cancelled
      streamPending.delete(id);
      unrefIfIdle();
      try {
        child?.stdin?.write(new FrameWriter().u8(ReqKind.CANCEL).u32(id).frame());
      } catch {
        /* broker gone — its child dies with it */
      }
    },
  };
}

// Best-effort cleanup so a hard exit doesn't leak the broker child.
// (The child also self-exits on stdin EOF when the parent dies.)
process.on('exit', () => teardown());

// --- direct (no-broker) fallback: spawn from this process --------------------

function directRun(spec: ProcSpec, onDone: ProcDone): void {
  const c = execFile(
    spec.file,
    spec.args,
    { cwd: spec.cwd || undefined, encoding: 'buffer', maxBuffer: MAX_BUFFER },
    (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? null : 0;
      onDone({ ok: !err, code, stdout: (stdout as Buffer) ?? EMPTY, stderr: (stderr as Buffer) ?? EMPTY });
    },
  );
  if (spec.input != null) c.stdin?.end(spec.input);
}

function directRunStream(spec: ProcSpec, handlers: ProcStream): ProcHandle {
  let c: ChildProcess;
  try {
    c = spawn(spec.file, spec.args, { cwd: spec.cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    handlers.onStderr?.(Buffer.from(String((e as Error)?.message ?? e), 'utf8'));
    handlers.onDone({ ok: false, code: null });
    return { cancel() {} };
  }
  let done = false;
  const finish = (res: { ok: boolean; code: number | null }) => {
    if (done) return;
    done = true;
    handlers.onDone(res);
  };
  c.stdout?.on('data', (d: Buffer) => handlers.onStdout?.(d));
  c.stderr?.on('data', (d: Buffer) => handlers.onStderr?.(d));
  c.on('error', (e) => {
    handlers.onStderr?.(Buffer.from(e.message, 'utf8'));
    finish({ ok: false, code: null });
  });
  c.on('close', (code, signal) => finish({ ok: code === 0, code: signal ? null : code }));
  c.stdin?.end(spec.input ?? undefined);
  return {
    cancel() {
      done = true; // suppress onDone
      try {
        c.kill();
      } catch {
        /* already exited */
      }
    },
  };
}
