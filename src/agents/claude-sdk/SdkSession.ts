/*
 * SdkSession — the domain model for one headless `claude -p` agent (the
 * `claude-sdk` kind; see tasks/agents/claude-sdk.md).
 *
 * It owns a ClaudeStreamTransport, builds the argv (stream-json + the
 * permission-prompt-tool wiring), drives turns, and maps the raw stream events
 * into a small, UI-friendly domain: a status (idle/working/waiting/exited), a
 * granular transcript event stream (so the widget appends incrementally rather
 * than re-rendering), permission requests, and the session id.
 *
 * Permissions: claude is launched with `--permission-prompt-tool`, pointed at a
 * tiny stdio MCP server (assets/mcp/quilxPermission.mjs) we provide. When claude
 * needs approval it calls that tool; the server hands the request to us over a
 * file pair (the same atomic tmp+rename + Gio.FileMonitor channel the claude-tui
 * hooks use), we surface it (status → `waiting`), and `respondPermission` writes
 * the decision back for the server to return as the tool result.
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Gio } from '../../gi.ts';
import { Disposable, Emitter } from '../../util/eventKit.ts';
import { ClaudeStreamTransport, type Transport, type TransportOptions } from './transport.ts';
import { userTurn, isSystemInit, isThinkingTokens, isResult, type StreamEvent, type ContentBlock } from './protocol.ts';
import type { AgentStatus } from '../types.ts';

// node-gtk quirk (see claude-tui/session.ts): Gio.File instance methods live on
// the interface prototype, not the concrete wrapper.
const FileProto = (Gio.File as any).prototype;

// The bundled permission-prompt MCP server. This file is at src/agents/claude-sdk/,
// so three `..` reach the repo root.
const PERMISSION_SCRIPT = Path.join(
  Path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'assets', 'mcp', 'quilxPermission.mjs',
);

/** A permission request surfaced from claude (status goes `waiting` until answered). */
export interface PermissionRequest {
  /** Correlates the request with `respondPermission`. */
  id: string;
  /** The tool claude wants to run (e.g. `Bash`, `Write`). */
  toolName: string;
  /** The proposed tool input, shown to the user. */
  input: unknown;
}

/** The user's answer to a permission request. */
export interface PermissionDecision {
  allow: boolean;
  /** Why it was denied (surfaced to claude); only used when `allow` is false. */
  message?: string;
}

export interface SdkSessionOptions {
  /** Base argv (default `['claude']`); the stream-json/permission flags are added. */
  command?: string[];
  /** Working directory for claude. */
  cwd: string;
  /** Override how the transport is created (tests inject a fake). */
  createTransport?: (spec: TransportOptions) => Transport;
}

export class SdkSession {
  private readonly options: SdkSessionOptions;
  private readonly emitter = new Emitter();
  private transport: Transport | null = null;
  private _status: AgentStatus = 'idle';
  private _sessionId: string | null = null;
  // Whether an assistant row is open for the current turn (so the first assistant
  // event of a turn emits `assistant-start` before its content deltas).
  private assistantOpen = false;
  // The permission request/response file pair + its watcher. The server writes the
  // request atomically; we answer by writing the response atomically.
  private readonly permRequestFile: string;
  private readonly permResponseFile: string;
  private readonly mcpConfig: string;
  private permMonitor: InstanceType<typeof Gio.FileMonitor> | null = null;
  private lastPermId: string | null = null;

  constructor(options: SdkSessionOptions) {
    this.options = options;
    const dir = Path.join(process.env.XDG_RUNTIME_DIR || Os.tmpdir(), 'quilx', 'sdk', randomUUID());
    Fs.mkdirSync(dir, { recursive: true });
    this.permRequestFile = Path.join(dir, 'permission.req');
    this.permResponseFile = Path.join(dir, 'permission.res');
    // The permission MCP server inherits the request/response paths and writes the
    // request / polls for the response over them.
    this.mcpConfig = JSON.stringify({
      mcpServers: {
        quilxPerm: {
          command: process.execPath,
          args: [PERMISSION_SCRIPT],
          env: {
            QUILX_PERM_REQUEST: this.permRequestFile,
            QUILX_PERM_RESPONSE: this.permResponseFile,
          },
        },
      },
    });
  }

  /** Spawn claude and start watching for permission requests. */
  start(): void {
    if (this.transport) return;
    const base = this.options.command && this.options.command.length > 0 ? this.options.command : ['claude'];
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      // Use `default` (asks) so the permission-prompt-tool is actually exercised;
      // claude calls our tool for any operation the mode would gate.
      '--permission-mode', 'default',
      '--permission-prompt-tool', 'mcp__quilxPerm__approve',
      '--mcp-config', this.mcpConfig,
      ...base.slice(1),
    ];
    const spec: TransportOptions = { command: base[0], args, cwd: this.options.cwd };
    const transport = (this.options.createTransport ?? ((s) => new ClaudeStreamTransport(s)))(spec);
    this.transport = transport;
    transport.onEvent((event) => this.handleEvent(event));
    transport.onExit((code) => this.handleExit(code));
    transport.start();

    // Watch for permission requests (atomic tmp+rename → WATCH_MOVES).
    const gfile = Gio.File.newForPath(this.permRequestFile);
    this.permMonitor = FileProto.monitorFile.call(gfile, Gio.FileMonitorFlags.WATCH_MOVES, null);
    this.permMonitor!.on('changed', () => this.readPermissionRequest());
  }

  /** Send a user turn. Pushes a user row, then flips to `working`. */
  prompt(text: string): void {
    if (!this.transport?.writable) return;
    this.emitter.emit('user-message', { text });
    this.assistantOpen = false;
    const turn = userTurn(text);
    logSend(turn);
    this.transport.send(turn);
    this.setStatus('working');
  }

  /** Answer a pending permission request (writes the response file for the MCP
   *  server to pick up and return to claude). */
  respondPermission(id: string, decision: PermissionDecision): void {
    if (id !== this.lastPermId) return; // stale / already answered
    const body = decision.allow
      ? { id, behavior: 'allow' }
      : { id, behavior: 'deny', message: decision.message ?? 'Denied by the user.' };
    logPerm('←', body);
    writeAtomic(this.permResponseFile, JSON.stringify(body));
    this.setStatus('working'); // claude resumes once it reads the decision
  }

  /** Interrupt the current turn (best-effort: a fresh user turn after a stop is
   *  the supported steering; a hard interrupt kills + would need a respawn). */
  interrupt(): void {
    // The stream-json protocol has no soft-interrupt we rely on here yet; left as
    // a seam. For now this is a no-op rather than a surprising kill.
  }

  get status(): AgentStatus { return this._status; }
  get sessionId(): string | null { return this._sessionId; }

  onStatus(cb: () => void): Disposable { return this.emitter.on('status', cb as (v?: unknown) => void); }
  onUserMessage(cb: (m: { text: string }) => void): Disposable { return this.emitter.on('user-message', cb as (v?: unknown) => void); }
  onAssistantStart(cb: () => void): Disposable { return this.emitter.on('assistant-start', cb as (v?: unknown) => void); }
  onAssistantText(cb: (m: { delta: string }) => void): Disposable { return this.emitter.on('assistant-text', cb as (v?: unknown) => void); }
  onAssistantThinking(cb: (m: { delta: string }) => void): Disposable { return this.emitter.on('assistant-thinking', cb as (v?: unknown) => void); }
  onToolUse(cb: (m: { name: string; input: unknown }) => void): Disposable { return this.emitter.on('tool-use', cb as (v?: unknown) => void); }
  onPermission(cb: (r: PermissionRequest) => void): Disposable { return this.emitter.on('permission', cb as (v?: unknown) => void); }
  onExit(cb: (code: number | null) => void): Disposable { return this.emitter.on('exit', cb as (v?: unknown) => void); }

  /** Stop the claude process but keep the session object (status → `exited`),
   *  so its widget can linger as the terminal agent's does. */
  stop(): void {
    if (this._status === 'exited') return;
    this.transport?.dispose();
    this.transport = null;
    this.handleExit(null);
  }

  /** Kill claude, stop watching, remove the IPC files. */
  dispose(): void {
    this.permMonitor?.cancel();
    this.permMonitor = null;
    this.transport?.dispose();
    this.transport = null;
    try { Fs.rmSync(Path.dirname(this.permRequestFile), { recursive: true, force: true }); } catch { /* best effort */ }
  }

  // --- event mapping ----------------------------------------------------------

  private handleEvent(event: StreamEvent): void {
    // Log every interaction; an event we don't recognise is logged in red.
    if (this.dispatch(event)) logRecv(event);
    else logUnhandled(event);
  }

  // Returns whether the event was recognised (handled or knowingly ignored).
  private dispatch(event: StreamEvent): boolean {
    if (isSystemInit(event)) {
      this._sessionId = event.session_id;
      return true;
    }
    if (isThinkingTokens(event)) return true; // known; not surfaced in the UI yet
    if (event.type === 'assistant') {
      this.onAssistant((event as { message?: { content?: ContentBlock[] } }).message?.content ?? []);
      return true;
    }
    if (isResult(event)) {
      this.assistantOpen = false;
      this.setStatus('idle');
      return true;
    }
    if (event.type === 'rate_limit_event' || event.type === 'system') return true; // known; ignored
    if (event.type === 'user') return true; // tool results / echoed user turns — known; not surfaced yet
    return false;
  }

  // Each `assistant` event carries the content blocks that just completed (a
  // thinking block, a text block, or a tool_use), not a cumulative snapshot — so
  // we append them. Without --include-partial-messages text arrives per block,
  // not per token (token streaming is a later enhancement).
  private onAssistant(blocks: ContentBlock[]): void {
    for (const block of blocks) {
      if (block.type === 'thinking') {
        this.emitter.emit('assistant-thinking', { delta: (block as { thinking?: string }).thinking ?? '' });
      } else if (block.type === 'text') {
        this.ensureAssistantOpen();
        this.emitter.emit('assistant-text', { delta: (block as { text?: string }).text ?? '' });
      } else if (block.type === 'tool_use') {
        const b = block as { name?: string; input?: unknown };
        this.emitter.emit('tool-use', { name: b.name ?? 'tool', input: b.input });
      }
    }
  }

  private ensureAssistantOpen(): void {
    if (this.assistantOpen) return;
    this.assistantOpen = true;
    this.emitter.emit('assistant-start');
  }

  private handleExit(code: number | null): void {
    this.setStatus('exited');
    this.emitter.emit('exit', code);
  }

  private setStatus(status: AgentStatus): void {
    if (this._status === 'exited' || status === this._status) return;
    this._status = status;
    this.emitter.emit('status');
  }

  // A permission request landed (the MCP server wrote it). Surface it and go
  // `waiting` until `respondPermission`.
  private readPermissionRequest(): void {
    let raw: string;
    try {
      raw = Fs.readFileSync(this.permRequestFile, 'utf8').trim();
    } catch {
      return; // mid-rename / removed
    }
    if (!raw) return;
    let req: { id?: string; tool_name?: string; toolName?: string; input?: unknown };
    try {
      req = JSON.parse(raw);
    } catch {
      return;
    }
    if (!req.id || req.id === this.lastPermId) return; // unchanged / malformed
    this.lastPermId = req.id;
    logPerm('→', req);
    this.setStatus('waiting');
    this.emitter.emit('permission', {
      id: req.id,
      toolName: req.tool_name ?? req.toolName ?? 'tool',
      input: req.input,
    });
  }
}

/** Write `text` to `file` atomically (tmp + rename), so a watcher sees one change. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  try {
    Fs.writeFileSync(tmp, text);
    Fs.renameSync(tmp, file);
  } catch { /* best effort */ }
}

// --- console logging of every JSON interaction (red for unhandled) -----------

const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/** An event received from claude (recognised). */
function logRecv(event: StreamEvent): void {
  console.log(`${DIM}[claude →]${RESET}`, JSON.stringify(event));
}
/** A message sent to claude (a user turn). */
function logSend(message: unknown): void {
  console.log(`${DIM}[claude ←]${RESET}`, JSON.stringify(message));
}
/** An event we don't recognise — surfaced in red. */
function logUnhandled(event: StreamEvent): void {
  console.log(`${RED}[claude → UNHANDLED]${RESET}`, JSON.stringify(event));
}
/** A permission interaction (`→` request from claude, `←` decision to claude). */
function logPerm(direction: '→' | '←', payload: unknown): void {
  console.log(`${DIM}[perm ${direction}]${RESET}`, JSON.stringify(payload));
}
