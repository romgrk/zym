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
import { FrameReader, FrameWriter, makeFrameParser } from './codec.ts';

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

let child: ChildProcess | null = null;
let nextId = 1;
const pending = new Map<number, ProcDone>();

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
  const id = r.u32();
  const ok = r.u8() === 1;
  const codeRaw = r.i32();
  const stdout = Buffer.from(r.bytes()); // copy out of the parser's reused buffer
  const stderr = Buffer.from(r.bytes());
  const cb = pending.get(id);
  if (!cb) return;
  pending.delete(id);
  if (pending.size === 0) refable(child?.stdout)?.unref(); // no work left: release the loop
  cb({ ok, code: codeRaw < 0 ? null : codeRaw, stdout, stderr });
}

/** Run a command via the broker (falls back to a direct spawn if it's down). */
export function runProcess(spec: ProcSpec, onDone: ProcDone): void {
  if (!ensureChild() || !child?.stdin) {
    directRun(spec, onDone);
    return;
  }
  const id = nextId++;
  if (pending.size === 0) refable(child.stdout)?.ref(); // keep the loop alive until the reply lands
  pending.set(id, onDone);
  const input = spec.input == null ? null : Buffer.isBuffer(spec.input) ? spec.input : Buffer.from(spec.input, 'utf8');
  const w = new FrameWriter();
  w.u32(id).str(spec.file).str(spec.cwd ?? '').u32(spec.args.length);
  for (const a of spec.args) w.str(a);
  if (input == null) w.u8(0);
  else w.u8(1).bytes(input);
  child.stdin.write(w.frame());
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
