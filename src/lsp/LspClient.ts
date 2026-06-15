/*
 * LspClient — the transport for one language-server process.
 *
 * Wraps a spawned child process in a `vscode-jsonrpc` message connection (which
 * handles JSON-RPC 2.0 framing over stdio). Node child_process + stream IO work
 * under node-gtk's GLib loop — see the `node-gtk-node-io-lsp` finding; the only
 * rule is that the loop must run from a macrotask, which the app already does.
 *
 * This layer is protocol-agnostic plumbing: spawn, request/notify/onNotification,
 * and an exit event (fired when the process or connection goes away). The LSP
 * lifecycle (initialize/shutdown), capabilities, and document tracking live one
 * layer up in `LanguageServer`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import { Emitter, Disposable } from '../util/eventKit.ts';
import type { ServerDef } from '../lang/types.ts';

export class LspClient {
  readonly spec: ServerDef;
  readonly rootDir: string;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private connection: MessageConnection | null = null;
  private readonly emitter = new Emitter();
  private stopped = false;
  private exited = false;

  constructor(spec: ServerDef, rootDir: string) {
    this.spec = spec;
    this.rootDir = rootDir;
  }

  /** A human-readable label, e.g. `rust-analyzer @ /home/me/proj`. */
  get label(): string {
    return `${this.spec.name} @ ${this.rootDir}`;
  }

  /**
   * Spawn the server and establish the connection. Throws if the process fails
   * to spawn (e.g. the command is not on PATH).
   */
  start(): void {
    const proc = spawn(this.spec.command, this.spec.args ?? [], {
      cwd: this.rootDir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    // A spawn failure (e.g. command not on PATH) surfaces to callers as the
    // initialize request rejecting when the connection closes below; this handler
    // just keeps Node from treating 'error' as an uncaught exception.
    proc.on('error', () => {});
    // A crash trips both `proc 'exit'` and the connection's `onClose`; emit our
    // own `exit` only once (whichever fires first; proc carries the exit code).
    proc.on('exit', (code) => this.emitExit(code));
    proc.stderr.resume(); // drain stderr so a chatty server can't block on a full pipe

    const connection = createMessageConnection(
      new StreamMessageReader(proc.stdout),
      new StreamMessageWriter(proc.stdin),
    );
    this.connection = connection;

    connection.onClose(() => this.emitExit(null));

    connection.listen();
  }

  // The request/notification type objects carry their own param/result types,
  // but vscode-jsonrpc's many overloads don't unify cleanly through a generic
  // wrapper. We type these loosely here; `LanguageServer` provides the typed API.
  // Whether the server's stdin is still open for writing. Writing to a dead
  // stream is the dangerous case: vscode-jsonrpc's sendRequest writes inside an
  // async Promise executor that re-throws on failure, producing an unhandled
  // rejection that the caller can't catch — so it would crash the whole app
  // (e.g. opening a file after a server failed to spawn). We refuse to write at
  // all once the stream is gone.
  private get writable(): boolean {
    const stdin = this.proc?.stdin;
    return !!this.connection && !this.exited && !this.stopped && !!stdin && !stdin.destroyed;
  }

  sendRequest<R = any>(type: any, params?: any): Promise<R> {
    if (!this.writable) return Promise.reject(new Error(`LspClient not writable: ${this.label}`));
    return this.connection!.sendRequest(type, params);
  }

  sendNotification(type: any, params?: any): void {
    // Fire-and-forget, so also swallow any late write failure for good measure.
    if (!this.writable) return;
    this.connection!.sendNotification(type, params).catch(() => {});
  }

  onNotification(type: any, handler: (params: any) => void): Disposable {
    if (!this.connection) throw new Error(`LspClient not started: ${this.label}`);
    const sub = this.connection.onNotification(type, handler);
    return new Disposable(() => sub.dispose());
  }

  /** Fires `(code: number | null)` when the server process exits unexpectedly. */
  onExit(handler: (code: number | null) => void): Disposable {
    return this.emitter.on('exit', handler as (v?: unknown) => void);
  }

  // Emit `exit` at most once per instance, and never after a deliberate dispose.
  private emitExit(code: number | null): void {
    if (this.stopped || this.exited) return;
    this.exited = true;
    this.emitter.emit('exit', code);
  }

  /** Tear down the connection and kill the process (no graceful shutdown here). */
  dispose(): void {
    this.stopped = true;
    this.connection?.dispose();
    this.connection = null;
    this.proc?.kill();
    this.proc = null;
  }
}
