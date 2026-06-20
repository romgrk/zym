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
import { userTurn, isSystemInit, isThinkingTokens, isResult, type StreamEvent, type ContentBlock, type Usage as TokenUsage } from './protocol.ts';
import type { AgentMode, AgentStatus } from '../types.ts';

const AGENT_MODES = new Set<AgentMode>(['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);

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
  private _permissionMode: AgentMode = 'default';
  private _sessionId: string | null = null;
  private _model: string | null = null;
  private controlReqId = 0;
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
      '--include-partial-messages', // token-level deltas (stream_event), for smooth streaming
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
  get permissionMode(): AgentMode { return this._permissionMode; }
  get model(): string | null { return this._model; }
  get sessionId(): string | null { return this._sessionId; }

  /** Change the permission mode mid-session (claude's `shift-tab` cycle) via a
   *  control_request on stdin; claude acks with a control_response. */
  setPermissionMode(mode: AgentMode): void {
    if (!this.transport?.writable || mode === this._permissionMode) return;
    const message = { type: 'control_request', request_id: `quilx-${++this.controlReqId}`, request: { subtype: 'set_permission_mode', mode } };
    logSend(message);
    this.transport.send(message);
    this.setMode(mode); // optimistic; the control_response confirms it
  }

  onStatus(cb: () => void): Disposable { return this.emitter.on('status', cb as (v?: unknown) => void); }
  onMode(cb: () => void): Disposable { return this.emitter.on('mode', cb as (v?: unknown) => void); }
  onUserMessage(cb: (m: { text: string }) => void): Disposable { return this.emitter.on('user-message', cb as (v?: unknown) => void); }
  onAssistantStart(cb: () => void): Disposable { return this.emitter.on('assistant-start', cb as (v?: unknown) => void); }
  onAssistantText(cb: (m: { delta: string }) => void): Disposable { return this.emitter.on('assistant-text', cb as (v?: unknown) => void); }
  onAssistantThinking(cb: (m: { delta: string }) => void): Disposable { return this.emitter.on('assistant-thinking', cb as (v?: unknown) => void); }
  onToolUse(cb: (m: { id: string; name: string; input: unknown }) => void): Disposable { return this.emitter.on('tool-use', cb as (v?: unknown) => void); }
  onToolResult(cb: (m: { id: string; isError: boolean; text: string }) => void): Disposable { return this.emitter.on('tool-result', cb as (v?: unknown) => void); }
  onResult(cb: (m: { costUsd?: number; contextWindow?: number }) => void): Disposable { return this.emitter.on('result', cb as (v?: unknown) => void); }
  onContext(cb: (m: { tokens: number }) => void): Disposable { return this.emitter.on('context', cb as (v?: unknown) => void); }
  onInit(cb: (m: { model: string; slashCommands: string[] }) => void): Disposable { return this.emitter.on('init', cb as (v?: unknown) => void); }
  onError(cb: (m: { message: string }) => void): Disposable { return this.emitter.on('error', cb as (v?: unknown) => void); }
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
      const init = event as { permissionMode?: string; model?: string; slash_commands?: string[] };
      if (init.permissionMode) this.setMode(init.permissionMode as AgentMode);
      if (init.model) this._model = init.model;
      this.emitter.emit('init', { model: init.model ?? '', slashCommands: Array.isArray(init.slash_commands) ? init.slash_commands : [] });
      return true;
    }
    // `system/status` carries live status (e.g. "requesting") AND mode changes
    // claude makes itself — keep our permission mode in sync with it.
    if (event.type === 'system' && (event as { subtype?: string }).subtype === 'status') {
      const s = event as { status?: string | null; permissionMode?: string };
      if (s.permissionMode) this.setMode(s.permissionMode as AgentMode);
      if (s.status === 'requesting') this.setStatus('working');
      return true;
    }
    if (event.type === 'control_response') return true; // ack of a control_request we sent
    if (isThinkingTokens(event)) return true; // known; not surfaced in the UI yet
    if (event.type === 'stream_event') { this.onStreamEvent(event); return true; }
    if (event.type === 'assistant') {
      const message = (event as { message?: { content?: ContentBlock[]; usage?: TokenUsage } }).message;
      this.onAssistant(message?.content ?? []);
      this.onUsage(message?.usage); // live context occupancy (per-message, not the aggregate)
      return true;
    }
    if (isResult(event)) {
      this.assistantOpen = false;
      this.onResultEvent(event);
      this.setStatus('idle');
      return true;
    }
    if (event.type === 'rate_limit_event' || event.type === 'system') return true; // known; ignored
    if (event.type === 'user') { this.onUser(event); return true; } // tool results / echoed user turns
    return false;
  }

  // The per-message usage is the real context occupancy at that point (input +
  // both cache tiers); the aggregate result.usage sums every tool-loop request,
  // so it over-counts. Ignore the synthetic 0-token messages.
  private onUsage(usage: TokenUsage | undefined): void {
    if (!usage) return;
    const tokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    if (tokens > 0) this.emitter.emit('context', { tokens });
  }

  // A turn's result: cost + the model's context window (for the % gauge), and an
  // error notice when the turn ended badly (refusal / max-turns / api error).
  private onResultEvent(event: StreamEvent): void {
    const r = event as {
      total_cost_usd?: number; is_error?: boolean; subtype?: string; stop_reason?: string;
      api_error_status?: string | null; terminal_reason?: string | null; result?: string;
      modelUsage?: Record<string, { contextWindow?: number }>;
    };
    const window = this._model ? r.modelUsage?.[this._model]?.contextWindow : undefined;
    this.emitter.emit('result', { costUsd: r.total_cost_usd, contextWindow: window });
    const failed = r.is_error === true || !!r.api_error_status || r.stop_reason === 'refusal'
      || (!!r.terminal_reason && r.terminal_reason !== 'completed')
      || (typeof r.subtype === 'string' && r.subtype.startsWith('error'));
    if (failed) {
      const reason = r.api_error_status || r.subtype || r.stop_reason || r.terminal_reason || 'error';
      this.emitter.emit('error', { message: r.result ? `${reason}: ${r.result}` : `Agent error (${reason})` });
    }
  }

  // A `user` event carries tool_result blocks (the output of a tool the agent ran)
  // — surface each so the matching tool row can show its status + a preview.
  private onUser(event: StreamEvent): void {
    const content = (event as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const b = block as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
      if (b.type !== 'tool_result' || !b.tool_use_id) continue;
      this.emitter.emit('tool-result', { id: b.tool_use_id, isError: !!b.is_error, text: toolResultText(b.content) });
    }
  }

  // A complete `assistant` event closes the message. For normal turns the text
  // already streamed token-by-token via `stream_event` deltas (--include-partial-
  // messages), so we only surface tool_use blocks here. But slash-command replies
  // (e.g. /context, /compact) arrive complete with NO preceding deltas — if nothing
  // streamed this turn (`!assistantOpen`), surface the full text now, otherwise it
  // would be lost.
  private onAssistant(blocks: ContentBlock[]): void {
    for (const block of blocks) {
      if (block.type === 'text') {
        const text = (block as { text?: string }).text ?? '';
        if (!this.assistantOpen && text) {
          this.ensureAssistantOpen();
          this.emitter.emit('assistant-text', { delta: text });
        }
      } else if (block.type === 'tool_use') {
        const b = block as { id?: string; name?: string; input?: unknown };
        this.emitter.emit('tool-use', { id: b.id ?? '', name: b.name ?? 'tool', input: b.input });
      }
    }
  }

  // A partial-message event: a token-level delta for the streaming text/thinking.
  private onStreamEvent(event: StreamEvent): void {
    const inner = (event as { event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } } }).event;
    if (inner?.type !== 'content_block_delta') return;
    const d = inner.delta;
    if (d?.type === 'text_delta') {
      this.ensureAssistantOpen();
      this.emitter.emit('assistant-text', { delta: d.text ?? '' });
    } else if (d?.type === 'thinking_delta') {
      this.emitter.emit('assistant-thinking', { delta: d.thinking ?? '' });
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

  private setMode(mode: AgentMode): void {
    if (!AGENT_MODES.has(mode) || mode === this._permissionMode) return;
    this._permissionMode = mode;
    this.emitter.emit('mode');
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

/** Flatten a tool_result's `content` (a string, or an array of text blocks) to text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? (b as { text?: string }).text ?? '' : ''))
      .join('');
  }
  return '';
}

/** Write `text` to `file` atomically (tmp + rename), so a watcher sees one change. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  try {
    Fs.writeFileSync(tmp, text);
    Fs.renameSync(tmp, file);
  } catch { /* best effort */ }
}

// --- logging of every JSON interaction (console + an optional debug file) ----
//
// The console mirror is always on (the primary way to watch the stream live).
// The JSONL debug file is opt-in via `QUILX_SDK_DEBUG` — out-of-band inspection
// (UX analysis of what the stream carries). Off by default so unit-test runs of
// this module don't pollute the file with fake-transport turns. DEBUG ONLY —
// remove (file + console) before merge.

const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

// Append-only JSONL: one {t, dir, payload} record per interaction. Only written
// when QUILX_SDK_DEBUG is set (any non-empty value); the path is then logged once.
const DEBUG_LOG_FILE = process.env.QUILX_SDK_DEBUG ? Path.join(Os.tmpdir(), 'quilx-sdk-debug.jsonl') : null;
if (DEBUG_LOG_FILE) console.log(`${DIM}[claude] debug log → ${DEBUG_LOG_FILE}${RESET}`);
function fileLog(dir: string, payload: unknown): void {
  if (!DEBUG_LOG_FILE) return;
  try {
    Fs.appendFileSync(DEBUG_LOG_FILE, JSON.stringify({ t: Date.now(), dir, payload }) + '\n');
  } catch {
    /* logging must never break the session */
  }
}

/** An event received from claude (recognised). */
function logRecv(event: StreamEvent): void {
  console.log(`${DIM}[claude →]${RESET}`, JSON.stringify(event));
  // Skip the high-frequency token deltas in the file — keep it readable; the
  // complete `assistant` events still capture the content.
  const e = event as { type?: string; subtype?: string };
  if (e.type === 'stream_event' || (e.type === 'system' && e.subtype === 'thinking_tokens')) return;
  fileLog('recv', event);
}
/** A message sent to claude (a user turn / control request). */
function logSend(message: unknown): void {
  console.log(`${DIM}[claude ←]${RESET}`, JSON.stringify(message));
  fileLog('send', message);
}
/** An event we don't recognise — surfaced in red. */
function logUnhandled(event: StreamEvent): void {
  console.log(`${RED}[claude → UNHANDLED]${RESET}`, JSON.stringify(event));
  fileLog('unhandled', event);
}
/** A permission interaction (`→` request from claude, `←` decision to claude). */
function logPerm(direction: '→' | '←', payload: unknown): void {
  console.log(`${DIM}[perm ${direction}]${RESET}`, JSON.stringify(payload));
  fileLog(direction === '→' ? 'perm-req' : 'perm-res', payload);
}
