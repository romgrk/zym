/*
 * transport.ts — the long-lived streaming transport for one headless `claude -p`
 * process (the `claude-sdk` agent kind; see tasks/agents/claude-sdk.md).
 *
 * Modeled on LspClient: a streaming child process over stdio works under
 * node-gtk's GLib loop (the `node-gtk-node-io-lsp` finding) — the only rule is
 * that the loop runs from a macrotask, which the app already does. We spawn the
 * child *directly* (not through process/runner.ts: that broker is one-shot
 * request/response, for short git/gh commands, and can't stream a persistent
 * process). The fork cost is paid once and amortised over the session's life,
 * exactly as for an LSP server.
 *
 * The protocol is newline-delimited JSON, not LSP's Content-Length framing: one
 * JSON object per line out (`StreamEvent`), one user turn per line in. This layer
 * is protocol-agnostic plumbing — spawn, send a message, an event stream, and an
 * exit event; argv construction and event→domain mapping live in SdkSession.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Disposable, Emitter } from '../../util/eventKit.ts';
import type { StreamEvent } from './protocol.ts';

export interface TransportOptions {
  /** The claude executable (resolved name or absolute path). */
  command: string;
  /** Full argv after the program (the stream-json flags, model, etc.). */
  args: string[];
  /** Working directory for the child. */
  cwd: string;
  /** Extra environment, merged over `process.env`. */
  env?: Record<string, string>;
}

/** The slice of the transport SdkSession depends on — so a test can inject a fake
 *  without spawning a real claude. */
export interface Transport {
  readonly writable: boolean;
  start(): void;
  send(message: unknown): void;
  onEvent(handler: (event: StreamEvent) => void): Disposable;
  onExit(handler: (code: number | null) => void): Disposable;
  dispose(): void;
}

export class ClaudeStreamTransport implements Transport {
  private readonly options: TransportOptions;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readonly emitter = new Emitter();
  // Partial trailing line carried between stdout chunks (a JSON object may span
  // two 'data' events; we only parse on a newline boundary).
  private stdoutBuffer = '';
  private stopped = false;
  private exited = false;
  private startError: Error | null = null;

  constructor(options: TransportOptions) {
    this.options = options;
  }

  /** Why the process failed to spawn, if it did (e.g. ENOENT for a missing claude). */
  get failureReason(): string | undefined {
    return this.startError?.message;
  }

  /** Whether the child is alive and its stdin still open for a new turn. */
  get writable(): boolean {
    const stdin = this.proc?.stdin;
    return !this.exited && !this.stopped && !!stdin && !stdin.destroyed;
  }

  /** Spawn the child and start streaming its stdout. Safe to call once. */
  start(): void {
    if (this.proc) return;
    const proc = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    // A spawn failure (ENOENT/EACCES) arrives as 'error'; record the reason and
    // keep Node from treating it as an uncaught exception. 'exit' still fires.
    proc.on('error', (err) => { this.startError = err as Error; });
    proc.on('exit', (code) => this.emitExit(code));

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    // claude writes diagnostics / progress to stderr; surface for debugging and
    // drain so a full pipe can't block the child.
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => this.emitter.emit('stderr', chunk));
  }

  /** Write one message (a user turn) to the child's stdin as a JSON line. No-op
   *  if the child is gone (the caller checks `writable` to surface that). */
  send(message: unknown): void {
    if (!this.writable) return;
    this.proc!.stdin.write(JSON.stringify(message) + '\n');
  }

  /** Subscribe to parsed stream events (one per stdout line). */
  onEvent(handler: (event: StreamEvent) => void): Disposable {
    return this.emitter.on('event', handler as (value?: unknown) => void);
  }

  /** Subscribe to raw stderr chunks (diagnostics). */
  onStderr(handler: (chunk: string) => void): Disposable {
    return this.emitter.on('stderr', handler as (value?: unknown) => void);
  }

  /** Fires `(code: number | null)` once when the process exits. */
  onExit(handler: (code: number | null) => void): Disposable {
    return this.emitter.on('exit', handler as (value?: unknown) => void);
  }

  /** Kill the child and stop streaming (no graceful drain). */
  dispose(): void {
    this.stopped = true;
    this.proc?.stdout?.removeAllListeners();
    this.proc?.stderr?.removeAllListeners();
    try { this.proc?.kill(); } catch { /* already gone */ }
    this.proc = null;
  }

  // --- internals -------------------------------------------------------------

  // Split the stdout stream on newlines and parse each complete line as JSON. A
  // malformed line is dropped (never breaks the stream); the last, possibly
  // partial, line is held until its terminating newline arrives.
  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.parseLine(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private parseLine(line: string): void {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      return; // not JSON (a stray log line) — ignore
    }
    if (event && typeof event === 'object' && typeof event.type === 'string') {
      this.emitter.emit('event', event);
    }
  }

  // Emit `exit` at most once, and never after a deliberate dispose.
  private emitExit(code: number | null): void {
    if (this.stopped || this.exited) return;
    this.exited = true;
    this.emitter.emit('exit', code);
  }
}
