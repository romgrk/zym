/*
 * acp/terminals.ts — the client side of ACP's `terminal/*` protocol: zym-owned
 * command execution the agent drives (create → output/wait_for_exit → kill /
 * release). Each terminal is a plain child process with an in-memory output
 * buffer (stdout+stderr interleaved), truncated from the head at a UTF-8
 * character boundary when the agent sets `outputByteLimit`, per spec.
 *
 * Runtime-pure (node only, no GTK) like the rest of the AcpSession module
 * chain — the UI surfaces terminals through the session's monitor mapping
 * (getMonitor / onMonitorUpdate / stopTask → the MonitorView panel), not here.
 *
 * Processes spawn detached (their own process group) so kill() can take down
 * the whole tree — a shell command's children die with it. Exit settles on
 * 'close' (all output flushed); a background grandchild holding the pipes open
 * falls back to settling shortly after 'exit' instead.
 */
import { spawn } from 'node:child_process';

export interface TerminalCreateParams {
  command: string;
  args?: string[] | null;
  env?: Array<{ name: string; value: string }> | null;
  cwd?: string | null;
  outputByteLimit?: number | null;
}

export interface TerminalExit {
  exitCode: number | null;
  signal: string | null;
}

/** Coalescing delay for output-update notifications (a chatty command must not
 *  re-render the UI per chunk); exit/kill notify immediately. */
const NOTIFY_DELAY_MS = 80;
/** Grace between kill()'s SIGTERM and the follow-up SIGKILL. */
const KILL_GRACE_MS = 2000;
/** How long after 'exit' to wait for 'close' (output flush) before settling
 *  anyway — a detached grandchild can hold the stdio pipes open forever. */
const CLOSE_GRACE_MS = 500;

/** Trim `text` to at most `limit` UTF-8 bytes, discarding from the beginning
 *  at a character boundary (per spec the retained tail may be slightly short). */
export function clampOutputHead(text: string, limit: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= limit) return { text, truncated: false };
  let start = buf.length - limit;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++; // skip UTF-8 continuation bytes
  return { text: buf.subarray(start).toString('utf8'), truncated: true };
}

export class AcpTerminal {
  readonly id: string;
  /** Display line — the command as requested (for the monitors panel). */
  readonly label: string;
  private readonly pid: number | undefined;
  private readonly limit: number | null;
  private output = '';
  private truncated = false;
  private exit: TerminalExit | null = null;
  private wasKilled = false;
  private settled = false;
  private readonly proc: ReturnType<typeof spawn>;
  private readonly exitWaiters: Array<(e: TerminalExit) => void> = [];
  private readonly updateCbs = new Set<() => void>();
  private notifyTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private closeTimer: NodeJS.Timeout | null = null;

  constructor(id: string, params: TerminalCreateParams, defaultCwd: string) {
    this.id = id;
    this.label = [params.command, ...(params.args ?? [])].join(' ');
    this.limit = params.outputByteLimit ?? null;
    const env = { ...process.env };
    for (const v of params.env ?? []) env[v.name] = v.value;
    const proc = spawn(params.command, params.args ?? [], {
      cwd: params.cwd ?? defaultCwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'], // no stdin: a command that reads gets EOF
      detached: true,
    });
    this.proc = proc;
    this.pid = proc.pid;
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => this.append(chunk));
    proc.stderr?.on('data', (chunk: string) => this.append(chunk));
    // A spawn failure (ENOENT, bad cwd) arrives as 'error' and 'close' may
    // never follow — surface the message as output and settle.
    proc.on('error', (err) => {
      this.append(`${(err as Error).message ?? err}\n`);
      this.settle({ exitCode: null, signal: null });
    });
    // 'close' = exited AND stdio flushed; prefer it so no output is lost.
    proc.on('close', (code, signal) => this.settle({ exitCode: code, signal }));
    proc.on('exit', (code, signal) => {
      if (this.settled || this.closeTimer) return;
      this.closeTimer = setTimeout(() => this.settle({ exitCode: code, signal }), CLOSE_GRACE_MS);
    });
  }

  get status(): 'running' | 'killed' | 'exited' {
    if (!this.exit) return 'running';
    return this.wasKilled ? 'killed' : 'exited';
  }

  currentOutput(): { output: string; truncated: boolean; exitStatus: TerminalExit | null } {
    return { output: this.output, truncated: this.truncated, exitStatus: this.exit };
  }

  waitForExit(): Promise<TerminalExit> {
    if (this.exit) return Promise.resolve(this.exit);
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }

  /** Terminate the command (the terminal stays valid — output/exit readable).
   *  SIGTERM to the process group first, SIGKILL after a grace period. */
  kill(): void {
    if (this.exit) return;
    this.wasKilled = true;
    this.signal('SIGTERM');
    this.killTimer ??= setTimeout(() => this.signal('SIGKILL'), KILL_GRACE_MS);
  }

  onUpdate(cb: () => void): { dispose(): void } {
    this.updateCbs.add(cb);
    return { dispose: () => this.updateCbs.delete(cb) };
  }

  /** Kill + sever listeners/timers (release, or session teardown). */
  dispose(): void {
    this.kill();
    this.updateCbs.clear();
    if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = null; }
  }

  private signal(sig: NodeJS.Signals): void {
    // Negative pid = the whole (detached) process group, children included.
    try {
      if (this.pid) process.kill(-this.pid, sig);
      else this.proc.kill(sig);
    } catch {
      try { this.proc.kill(sig); } catch { /* already gone */ }
    }
  }

  private append(chunk: string): void {
    this.output += chunk;
    if (this.limit != null) {
      const clamped = clampOutputHead(this.output, this.limit);
      this.output = clamped.text;
      if (clamped.truncated) this.truncated = true;
    }
    this.notify(false);
  }

  private settle(exit: TerminalExit): void {
    if (this.settled) return;
    this.settled = true;
    this.exit = exit;
    if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = null; }
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
    for (const resolve of this.exitWaiters.splice(0)) resolve(exit);
    this.notify(true);
  }

  private notify(immediate: boolean): void {
    if (immediate) {
      if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = null; }
      for (const cb of this.updateCbs) cb();
      return;
    }
    this.notifyTimer ??= setTimeout(() => {
      this.notifyTimer = null;
      for (const cb of this.updateCbs) cb();
    }, NOTIFY_DELAY_MS);
  }
}

export class AcpTerminalRegistry {
  private readonly terminals = new Map<string, AcpTerminal>();
  private counter = 0;

  create(params: TerminalCreateParams, defaultCwd: string): AcpTerminal {
    const terminal = new AcpTerminal(`term-${++this.counter}`, params, defaultCwd);
    this.terminals.set(terminal.id, terminal);
    return terminal;
  }

  get(id: string): AcpTerminal | undefined {
    return this.terminals.get(id);
  }

  /** All terminals ever created this session (the monitors panel filters by status). */
  all(): AcpTerminal[] {
    return [...this.terminals.values()];
  }

  /** Kill + forget `id` (its output is no longer retrievable, per spec). */
  release(id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    terminal.dispose();
    this.terminals.delete(id);
  }

  /** Session teardown: kill everything still running. */
  dispose(): void {
    for (const terminal of this.terminals.values()) terminal.dispose();
    this.terminals.clear();
  }
}
