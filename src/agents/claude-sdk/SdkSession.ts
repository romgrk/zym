/*
 * SdkSession — the domain model for one headless `claude -p` agent (the
 * `claude-sdk` kind; see docs/agents/claude-sdk.md).
 *
 * It owns a ClaudeStreamTransport, builds the argv (stream-json + the
 * permission-prompt-tool wiring), drives turns, and maps the raw stream events
 * into a small, UI-friendly domain: a status (idle/working/waiting/exited), a
 * granular transcript event stream (so the widget appends incrementally rather
 * than re-rendering), permission requests, and the session id.
 *
 * Permissions: claude is launched with `--permission-prompt-tool`, pointed at a
 * tiny stdio MCP server (assets/mcp/zymPermission.mjs) we provide. When claude
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
import type { ReplayEntry } from './transcript.ts';
import type { AgentMode, AgentResume, AgentStatus } from '../types.ts';
import { resumeFlags } from '../resume.ts';
import { parseActions, type AgentAction } from '../actions.ts';
import { AGENT_SYSTEM_PROMPT } from '../prompts.ts';

const AGENT_MODES = new Set<AgentMode>(['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);

// node-gtk quirk (see claude-tui/session.ts): Gio.File instance methods live on
// the interface prototype, not the concrete wrapper.
const FileProto = (Gio.File as any).prototype;

// The bundled permission-prompt MCP server. This file is at src/agents/claude-sdk/,
// so three `..` reach the repo root.
const PERMISSION_SCRIPT = Path.join(
  Path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'assets', 'mcp', 'zymPermission.mjs',
);

// The bundled agent↔editor bridge MCP server. The sdk runs it only for its
// `set_actions` tool (it has no live worktree re-rooting), so it passes only
// ZYM_ACTIONS_FILE — the bridge then advertises just that tool.
const BRIDGE_SCRIPT = Path.join(
  Path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'assets', 'mcp', 'zymBridge.mjs',
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

/** One question from an `AskUserQuestion` tool call. */
export interface AgentQuestion {
  /** The question prompt shown to the user. */
  question: string;
  /** A short label/category for the question (defaults to the question text). */
  header: string;
  /** Whether multiple options may be chosen. */
  multiSelect: boolean;
  /** The offered choices. */
  options: Array<{ label: string; description?: string }>;
}

/** An `AskUserQuestion` request surfaced from claude (status `waiting` until
 *  answered via `answerQuestion`). It rides the same permission channel as a
 *  normal approval, but is interactive — the user picks options, not allow/deny. */
export interface QuestionRequest {
  id: string;
  questions: AgentQuestion[];
}

/** One entry in a subagent's captured transcript. */
export type SubagentMessage =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; toolId: string; name: string; input: unknown; result?: { isError: boolean; text: string } };

/** A spawned subagent's conversation, kept out of the main thread and shown on a
 *  dedicated page. Keyed by the spawning `Agent` tool's tool_use_id. */
export interface SubagentInfo {
  id: string;
  agentType: string;
  description: string;
  /** The instruction the main agent gave the subagent (shown atop its page). */
  prompt: string;
  status: 'running' | 'completed';
  messages: SubagentMessage[];
}

/** A shell monitor (the `Monitor` tool), keyed by its tool_use_id. `taskId` (from
 *  task_started) is what `stopTask` cancels; `outputFile` arrives on completion. */
export interface MonitorInfo {
  id: string;
  taskId: string | null;
  description: string;
  status: string;
  outputFile: string | null;
}

/** Live progress for a subagent (Task) or background task, keyed by `id` (the
 *  originating tool_use_id). */
export interface TaskProgress {
  id: string;
  description: string;
  subagentType?: string;
  lastTool?: string;
  tokens: number;
  toolUses: number;
  durationMs: number;
  status: string;
  done: boolean;
}

/**
 * Per-message context occupancy: `tokens` is the running window total (input +
 * both cache tiers), broken out into its parts. `output` is the turn's generated
 * tokens (not part of the window total) — surfaced for the detail popover.
 */
export interface ContextUsage {
  tokens: number;
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

export interface SdkSessionOptions {
  /** Base argv (default `['claude']`); the stream-json/permission flags are added. */
  command?: string[];
  /** Working directory for claude. */
  cwd: string;
  /** Resume a past conversation (`--resume`/`--continue`) instead of starting fresh. */
  resume?: AgentResume;
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
  // Set while an interrupt is in flight, so the `error_during_execution` result it
  // produces is treated as an intentional stop rather than surfaced as an error.
  private interrupting = false;
  // The request_id of an in-flight interrupt; its `control_response` success flips
  // the status to idle immediately, ahead of the trailing `result` event.
  private interruptReqId: string | null = null;
  // Subagent transcripts, keyed by the spawning `Agent` tool's tool_use_id. Their
  // events (parent_tool_use_id set) are captured here, not shown in the main thread.
  private readonly subagents = new Map<string, SubagentInfo>();
  // Shell monitors (the `Monitor` tool), keyed by tool_use_id; task_id maps back here.
  private readonly monitors = new Map<string, MonitorInfo>();
  private readonly taskToMonitor = new Map<string, string>();
  // The permission request/response file pair + its watcher. The server writes the
  // request atomically; we answer by writing the response atomically.
  private readonly permRequestFile: string;
  private readonly permResponseFile: string;
  // The `set_actions` bridge tool writes the registered actions here (atomic);
  // we watch it and emit an `actions` event.
  private readonly actionsFile: string;
  // The `set_worktree` bridge tool writes the agent's current worktree to
  // `<statusFile>.cwd` (atomic); we watch it and emit a `cwd` event so the
  // workbench re-roots to the worktree the agent moved into.
  private readonly statusFile: string;
  private readonly mcpConfig: string;
  private permMonitor: InstanceType<typeof Gio.FileMonitor> | null = null;
  private actionsMonitor: InstanceType<typeof Gio.FileMonitor> | null = null;
  private cwdMonitor: InstanceType<typeof Gio.FileMonitor> | null = null;
  private lastPermId: string | null = null;
  private lastActions: string | null = null;
  private lastCwd: string | null = null;

  constructor(options: SdkSessionOptions) {
    this.options = options;
    const dir = Path.join(process.env.XDG_RUNTIME_DIR || Os.tmpdir(), 'zym', 'sdk', randomUUID());
    Fs.mkdirSync(dir, { recursive: true });
    this.permRequestFile = Path.join(dir, 'permission.req');
    this.permResponseFile = Path.join(dir, 'permission.res');
    this.actionsFile = Path.join(dir, 'actions.json');
    this.statusFile = Path.join(dir, 'status');
    // Two bundled MCP servers: the permission server inherits the request/response
    // paths (writes the request / polls for the response); the bridge inherits the
    // status + actions files so its set_worktree / set_actions tools write there.
    this.mcpConfig = JSON.stringify({
      mcpServers: {
        zymPerm: {
          command: process.execPath,
          args: [PERMISSION_SCRIPT],
          env: {
            ZYM_PERM_REQUEST: this.permRequestFile,
            ZYM_PERM_RESPONSE: this.permResponseFile,
          },
        },
        zym: {
          command: process.execPath,
          args: [BRIDGE_SCRIPT],
          env: { ZYM_STATUS_FILE: this.statusFile, ZYM_ACTIONS_FILE: this.actionsFile },
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
      // Resume flags (--resume <id> / --continue / --fork-session), when resuming a
      // past session: claude reloads its transcript into context. It does NOT replay
      // that history as stream events (verified) — the UI transcript is rebuilt
      // separately by replaying claude's on-disk transcript (see SdkSession.replay).
      ...resumeFlags(this.options.resume),
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages', // token-level deltas (stream_event), for smooth streaming
      // Use `default` (asks) so the permission-prompt-tool is actually exercised;
      // claude calls our tool for any operation the mode would gate.
      '--permission-mode', 'default',
      '--permission-prompt-tool', 'mcp__zymPerm__approve',
      // Pre-allow the bridge tools so announcing a worktree / registering actions
      // never prompts the user.
      '--allowedTools', 'mcp__zym__set_worktree,mcp__zym__set_actions',
      '--append-system-prompt', AGENT_SYSTEM_PROMPT,
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

    // Watch for registered actions (set_actions writes atomically → WATCH_MOVES).
    const afile = Gio.File.newForPath(this.actionsFile);
    this.actionsMonitor = FileProto.monitorFile.call(afile, Gio.FileMonitorFlags.WATCH_MOVES, null);
    this.actionsMonitor!.on('changed', () => this.readActions());

    // Watch for worktree moves (set_worktree writes `<statusFile>.cwd` atomically).
    const cfile = Gio.File.newForPath(`${this.statusFile}.cwd`);
    this.cwdMonitor = FileProto.monitorFile.call(cfile, Gio.FileMonitorFlags.WATCH_MOVES, null);
    this.cwdMonitor!.on('changed', () => this.readCwd());
  }

  /** Send a user turn. Pushes a user row, then flips to `working`. */
  prompt(text: string): void {
    if (!this.transport?.writable) return;
    this.emitter.emit('user-message', { text });
    this.assistantOpen = false;
    this.interrupting = false;
    this.interruptReqId = null;
    const turn = userTurn(text);
    logSend(turn);
    this.transport.send(turn);
    this.setStatus('working');
  }

  /** Rebuild the visible transcript from a past conversation by re-emitting the
   *  same domain events a live turn would, so the widget's row handlers
   *  (`AgentConversation.wireSession`) draw exactly what they'd draw live. Called
   *  before `start()` on a resume; `--resume` restores claude's *context* but does
   *  not replay history as stream events (verified), so the rows are rebuilt here
   *  from claude's on-disk transcript (see ./transcript.ts → readTranscript). */
  replay(entries: ReplayEntry[]): void {
    for (const e of entries) {
      switch (e.kind) {
        case 'user':
          this.emitter.emit('user-message', { text: e.text });
          break;
        case 'thinking':
          this.emitter.emit('assistant-thinking', { delta: e.text });
          break;
        case 'text':
          // A fresh assistant bubble per text block (post-tool text is its own block).
          this.emitter.emit('assistant-start');
          this.emitter.emit('assistant-text', { delta: e.text });
          break;
        case 'tool_use':
          // The widget decides how to draw it (AgentConversation renders Agent /
          // Monitor / AskUserQuestion as static rows while replaying, since their
          // live interactive widgets expect a lifecycle that a replay has no events for).
          this.emitter.emit('tool-use', { id: e.id, name: e.name, input: e.input });
          break;
        case 'tool_result':
          this.emitter.emit('tool-result', { id: e.id, isError: e.isError, text: e.text });
          break;
      }
    }
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

  /** Answer an `AskUserQuestion` request. The selection is delivered as the tool
   *  result through the permission channel's `deny` message — the only path that
   *  carries text back to claude. (An `allow` just runs the tool, which has no
   *  interactive client in headless mode and returns "did not answer"; the
   *  permission `updatedInput` cannot carry the answer either — both verified.)
   *  An empty selection mirrors the native "user did not answer" outcome. */
  answerQuestion(id: string, answers: Array<{ header: string; labels: string[]; notes?: string }>): void {
    if (id !== this.lastPermId) return; // stale / already answered
    const answered = answers.filter((a) => a.labels.length > 0);
    const message = answered.length === 0
      ? 'The user did not answer the questions.'
      : `The user answered:\n${answered.map((a) => `- ${a.header}: ${a.labels.join(', ')}${a.notes ? ` (note: ${a.notes})` : ''}`).join('\n')}`;
    const body = { id, behavior: 'deny', message };
    logPerm('←', body);
    writeAtomic(this.permResponseFile, JSON.stringify(body));
    this.setStatus('working');
  }

  /** Interrupt the in-flight turn via a control_request. claude stops the turn and
   *  emits an `error_during_execution` result, which we treat as an intentional
   *  stop (not a failure — see `onResultEvent`). Returns whether an interrupt was
   *  actually sent (false = nothing was running, so the caller can fall back). */
  interrupt(): boolean {
    if (!this.transport?.writable) return false;
    if (this._status !== 'working' && this._status !== 'waiting') return false;
    this.interrupting = true;
    const requestId = `zym-${++this.controlReqId}`;
    this.interruptReqId = requestId;
    const message = { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } };
    logSend(message);
    this.transport.send(message);
    return true;
  }

  get status(): AgentStatus { return this._status; }
  get permissionMode(): AgentMode { return this._permissionMode; }
  get model(): string | null { return this._model; }
  get sessionId(): string | null { return this._sessionId; }

  /** Change the permission mode mid-session (claude's `shift-tab` cycle) via a
   *  control_request on stdin; claude acks with a control_response. */
  setPermissionMode(mode: AgentMode): void {
    if (!this.transport?.writable || mode === this._permissionMode) return;
    const message = { type: 'control_request', request_id: `zym-${++this.controlReqId}`, request: { subtype: 'set_permission_mode', mode } };
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
  onContext(cb: (m: ContextUsage) => void): Disposable { return this.emitter.on('context', cb as (v?: unknown) => void); }
  onInit(cb: (m: { model: string; slashCommands: string[] }) => void): Disposable { return this.emitter.on('init', cb as (v?: unknown) => void); }
  onError(cb: (m: { message: string }) => void): Disposable { return this.emitter.on('error', cb as (v?: unknown) => void); }
  onInterrupted(cb: () => void): Disposable { return this.emitter.on('interrupted', cb as (v?: unknown) => void); }
  onThinkingTokens(cb: (m: { tokens: number }) => void): Disposable { return this.emitter.on('thinking-tokens', cb as (v?: unknown) => void); }
  onTaskProgress(cb: (m: TaskProgress) => void): Disposable { return this.emitter.on('task-progress', cb as (v?: unknown) => void); }
  onSubagentStart(cb: (m: { id: string; agentType: string; description: string }) => void): Disposable { return this.emitter.on('subagent-start', cb as (v?: unknown) => void); }
  onMonitorStart(cb: (m: { id: string; description: string }) => void): Disposable { return this.emitter.on('monitor-start', cb as (v?: unknown) => void); }
  onMonitorUpdate(cb: (m: { id: string }) => void): Disposable { return this.emitter.on('monitor-update', cb as (v?: unknown) => void); }
  onSubagentUpdate(cb: (m: { id: string }) => void): Disposable { return this.emitter.on('subagent-update', cb as (v?: unknown) => void); }
  onSubagentDone(cb: (m: { id: string }) => void): Disposable { return this.emitter.on('subagent-done', cb as (v?: unknown) => void); }
  onUnhandled(cb: (m: { event: unknown }) => void): Disposable { return this.emitter.on('unhandled', cb as (v?: unknown) => void); }
  onPermission(cb: (r: PermissionRequest) => void): Disposable { return this.emitter.on('permission', cb as (v?: unknown) => void); }
  onQuestion(cb: (r: QuestionRequest) => void): Disposable { return this.emitter.on('question', cb as (v?: unknown) => void); }
  onActions(cb: (m: { actions: AgentAction[] }) => void): Disposable { return this.emitter.on('actions', cb as (v?: unknown) => void); }
  onCwd(cb: (m: { cwd: string }) => void): Disposable { return this.emitter.on('cwd', cb as (v?: unknown) => void); }
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
    this.actionsMonitor?.cancel();
    this.actionsMonitor = null;
    this.cwdMonitor?.cancel();
    this.cwdMonitor = null;
    this.transport?.dispose();
    this.transport = null;
    try { Fs.rmSync(Path.dirname(this.permRequestFile), { recursive: true, force: true }); } catch { /* best effort */ }
  }

  // --- event mapping ----------------------------------------------------------

  private handleEvent(event: StreamEvent): void {
    // Log every interaction; an event we don't recognise is logged in red AND
    // surfaced in the conversation (raw JSON) so nothing is silently dropped.
    if (this.dispatch(event)) { logRecv(event); return; }
    logUnhandled(event);
    this.emitter.emit('unhandled', { event });
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
    if (event.type === 'control_response') {
      // Ack of a control_request we sent. When it's our interrupt's success, drop
      // out of `working` right away — feedback ahead of the trailing `result`.
      const resp = (event as { response?: { request_id?: string; subtype?: string } }).response;
      if (resp?.subtype === 'success' && resp.request_id && resp.request_id === this.interruptReqId) {
        this.interruptReqId = null;
        this.setStatus('idle');
      }
      return true;
    }
    if (isThinkingTokens(event)) {
      this.emitter.emit('thinking-tokens', { tokens: (event as { estimated_tokens?: number }).estimated_tokens ?? 0 });
      return true;
    }
    // Events from a spawned subagent carry parent_tool_use_id (the `Agent` tool's
    // id); they're captured into that subagent's transcript, never the main thread.
    const parent = parentToolUseId(event);
    if (event.type === 'stream_event') {
      if (parent) return true; // subagent text isn't streamed to the main thread; captured below
      this.onStreamEvent(event);
      return true;
    }
    if (event.type === 'assistant') {
      const message = (event as { message?: { content?: ContentBlock[]; usage?: TokenUsage } }).message;
      if (parent) { this.onSubagentAssistant(parent, message?.content ?? []); return true; }
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
    if (event.type === 'system') {
      const sub = (event as { subtype?: string }).subtype;
      // Subagent / background-task lifecycle — live progress for the Task/Bash row.
      if (sub === 'task_started' || sub === 'task_progress' || sub === 'task_notification' || sub === 'task_updated') {
        this.onTaskEvent(event as unknown as Record<string, unknown>, sub);
        return true;
      }
      return true; // other system subtypes: known; ignored
    }
    if (event.type === 'rate_limit_event') return true; // known; ignored
    if (event.type === 'user') {
      if (parent) { this.onSubagentUser(parent, event); return true; }
      this.onUser(event); // tool results / echoed user turns
      return true;
    }
    return false;
  }

  // Normalize a task_started/progress/notification event and emit it keyed by the
  // originating tool_use_id, so the matching tool row can show live progress. A
  // local_agent task also opens/closes a captured subagent transcript.
  private onTaskEvent(e: Record<string, unknown>, subtype: string): void {
    const usage = (e.usage ?? {}) as { total_tokens?: number; tool_uses?: number; duration_ms?: number };
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    const id = str(e.tool_use_id) ?? '';
    const taskId = str(e.task_id);

    // Monitor lifecycle (a `Monitor` tool — tracked by tool_use_id at spawn time).
    if (subtype === 'task_started' && id && taskId && this.monitors.has(id)) {
      this.monitors.get(id)!.taskId = taskId;
      this.taskToMonitor.set(taskId, id);
    }
    if (subtype === 'task_updated' && taskId) {
      const mid = this.taskToMonitor.get(taskId);
      const status = (e.patch && typeof e.patch === 'object' ? (e.patch as { status?: unknown }).status : undefined);
      if (mid && typeof status === 'string') { this.monitors.get(mid)!.status = status; this.emitter.emit('monitor-update', { id: mid }); }
      return; // task_updated carries no usage — nothing more to surface
    }
    if (subtype === 'task_notification' && id && this.monitors.has(id)) {
      const m = this.monitors.get(id)!;
      if (str(e.status)) m.status = str(e.status)!;
      if (str(e.output_file)) m.outputFile = str(e.output_file)!;
      this.emitter.emit('monitor-update', { id });
    }

    if (subtype === 'task_started' && id && str(e.task_type) === 'local_agent') {
      const info: SubagentInfo = { id, agentType: str(e.subagent_type) ?? 'agent', description: str(e.description) ?? '', prompt: str(e.prompt) ?? '', status: 'running', messages: [] };
      this.subagents.set(id, info);
      this.emitter.emit('subagent-start', { id, agentType: info.agentType, description: info.description });
    } else if (subtype === 'task_notification' && id) {
      const info = this.subagents.get(id);
      if (info) { info.status = 'completed'; this.emitter.emit('subagent-done', { id }); }
    }
    this.emitter.emit('task-progress', {
      id,
      description: str(e.description) ?? str(e.summary) ?? '',
      subagentType: str(e.subagent_type),
      lastTool: str(e.last_tool_name),
      tokens: usage.total_tokens ?? 0,
      toolUses: usage.tool_uses ?? 0,
      durationMs: usage.duration_ms ?? 0,
      status: str(e.status) ?? (subtype === 'task_started' ? 'started' : 'running'),
      done: subtype === 'task_notification',
    });
  }

  // Capture a subagent's assistant message (text + tool_use) into its transcript.
  private onSubagentAssistant(parentId: string, blocks: ContentBlock[]): void {
    const info = this.subagents.get(parentId);
    if (!info) return;
    for (const block of blocks) {
      if (block.type === 'text') {
        const text = (block as { text?: string }).text ?? '';
        if (text) info.messages.push({ kind: 'text', text });
      } else if (block.type === 'tool_use') {
        const b = block as { id?: string; name?: string; input?: unknown };
        info.messages.push({ kind: 'tool', toolId: b.id ?? '', name: b.name ?? 'tool', input: b.input });
      }
    }
    this.emitter.emit('subagent-update', { id: parentId });
  }

  // Attach a subagent's tool_result to the matching tool message in its transcript.
  private onSubagentUser(parentId: string, event: StreamEvent): void {
    const info = this.subagents.get(parentId);
    if (!info) return;
    const content = (event as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const b = block as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
      if (b.type !== 'tool_result' || !b.tool_use_id) continue;
      const msg = info.messages.find((m): m is Extract<SubagentMessage, { kind: 'tool' }> => m.kind === 'tool' && m.toolId === b.tool_use_id);
      if (msg) msg.result = { isError: !!b.is_error, text: toolResultText(b.content) };
    }
    this.emitter.emit('subagent-update', { id: parentId });
  }

  /** A captured subagent transcript (for the subagent page), or undefined. */
  getSubagent(id: string): SubagentInfo | undefined { return this.subagents.get(id); }

  /** A captured shell monitor (for the monitors panel/inspect page), or undefined. */
  getMonitor(id: string): MonitorInfo | undefined { return this.monitors.get(id); }

  /** Cancel a running task (e.g. a shell monitor) by its task_id via the control
   *  protocol (`stop_task`) — verified against the CLI. */
  stopTask(taskId: string): void {
    if (!this.transport?.writable) return;
    const message = { type: 'control_request', request_id: `zym-${++this.controlReqId}`, request: { subtype: 'stop_task', task_id: taskId } };
    logSend(message);
    this.transport.send(message);
  }

  // The per-message usage is the real context occupancy at that point (input +
  // both cache tiers); the aggregate result.usage sums every tool-loop request,
  // so it over-counts. Ignore the synthetic 0-token messages.
  private onUsage(usage: TokenUsage | undefined): void {
    if (!usage) return;
    const input = usage.input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const tokens = input + cacheRead + cacheCreation;
    if (tokens > 0) this.emitter.emit('context', { tokens, input, cacheRead, cacheCreation, output });
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
    // An interrupt we sent ends the turn with `error_during_execution` — that's the
    // intended outcome, not a failure to surface.
    const interrupted = this.interrupting;
    this.interrupting = false;
    if (interrupted) { this.emitter.emit('interrupted'); return; }
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
      const text = toolResultText(b.content);
      this.emitter.emit('tool-result', { id: b.tool_use_id, isError: !!b.is_error, text });
      // An `Agent` tool result is the subagent's final answer — also append it to
      // that subagent's transcript so its page shows the complete conversation. The
      // result carries a trailing agentId/usage metadata block; strip it.
      const sub = this.subagents.get(b.tool_use_id);
      if (sub) {
        const answer = stripSubagentMeta(text);
        if (answer) { sub.messages.push({ kind: 'text', text: answer }); this.emitter.emit('subagent-update', { id: b.tool_use_id }); }
      }
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
        if (b.name === 'Monitor' && b.id) {
          const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>;
          const description = typeof input.description === 'string' ? input.description
            : typeof input.command === 'string' ? input.command : 'monitor';
          this.monitors.set(b.id, { id: b.id, taskId: null, description, status: 'running', outputFile: null });
          this.emitter.emit('monitor-start', { id: b.id, description });
        }
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
    const toolName = req.tool_name ?? req.toolName ?? 'tool';
    // AskUserQuestion is interactive, not an approval: surface its questions/options
    // so the user picks an answer (delivered via `answerQuestion`), not allow/deny.
    if (toolName === 'AskUserQuestion') {
      const questions = parseQuestions(req.input);
      if (questions.length > 0) { this.emitter.emit('question', { id: req.id, questions }); return; }
    }
    this.emitter.emit('permission', { id: req.id, toolName, input: req.input });
  }

  // The bridge's `set_actions` tool writes the registered actions (a JSON array)
  // atomically to actionsFile; parse + emit them (empty array clears the set).
  private readActions(): void {
    let raw: string;
    try {
      raw = Fs.readFileSync(this.actionsFile, 'utf8').trim();
    } catch {
      return; // mid-rename / removed
    }
    if (!raw || raw === this.lastActions) return; // unchanged
    this.lastActions = raw;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // mid-write / malformed
    }
    this.emitter.emit('actions', { actions: parseActions(parsed) });
  }

  // The `set_worktree` bridge tool writes the agent's current worktree path
  // atomically to `<statusFile>.cwd`; emit it so the workbench re-roots.
  private readCwd(): void {
    let raw: string;
    try {
      raw = Fs.readFileSync(`${this.statusFile}.cwd`, 'utf8').trim();
    } catch {
      return; // mid-rename / removed
    }
    if (!raw || raw === this.lastCwd) return; // empty (pre-report) or unchanged
    this.lastCwd = raw;
    this.emitter.emit('cwd', { cwd: raw });
  }
}

/** Parse an `AskUserQuestion` tool input into the questions we render. Drops any
 *  malformed question (no usable options). Exported for testing. */
export function parseQuestions(input: unknown): AgentQuestion[] {
  const raw = input && typeof input === 'object' ? (input as { questions?: unknown }).questions : undefined;
  if (!Array.isArray(raw)) return [];
  const out: AgentQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const qq = q as Record<string, unknown>;
    const options = Array.isArray(qq.options)
      ? qq.options
          .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
          .map((o) => ({ label: typeof o.label === 'string' ? o.label : '', description: typeof o.description === 'string' ? o.description : undefined }))
          .filter((o) => o.label !== '')
      : [];
    if (options.length === 0) continue;
    const question = typeof qq.question === 'string' ? qq.question : '';
    out.push({
      question,
      header: typeof qq.header === 'string' && qq.header ? qq.header : (question || 'Question'),
      multiSelect: qq.multiSelect === true,
      options,
    });
  }
  return out;
}

/** The `parent_tool_use_id` of an event (the spawning `Agent` tool), or null for
 *  main-agent events. */
function parentToolUseId(event: StreamEvent): string | null {
  const p = (event as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  return typeof p === 'string' && p ? p : null;
}

/** Strip the trailing `agentId: … (use SendMessage…)` + `<usage>…</usage>` metadata
 *  block that the Agent tool appends to a subagent's final answer. */
function stripSubagentMeta(text: string): string {
  return text.replace(/\s*agentId:\s*\S+\s*\(use SendMessage[\s\S]*$/, '').trimEnd();
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
// The JSONL debug file is opt-in via `ZYM_SDK_DEBUG` — out-of-band inspection
// (UX analysis of what the stream carries). Off by default so unit-test runs of
// this module don't pollute the file with fake-transport turns. DEBUG ONLY —
// remove (file + console) before merge.

const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

// Append-only JSONL: one {t, dir, payload} record per interaction. Only written
// when ZYM_SDK_DEBUG is set (any non-empty value); the path is then logged once.
const DEBUG_LOG_FILE = process.env.ZYM_SDK_DEBUG ? Path.join(Os.tmpdir(), 'zym-sdk-debug.jsonl') : null;
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
