/*
 * AcpSession — a ConversationSession over the Agent Client Protocol
 * (https://agentclientprotocol.com), the `acp` agent kind. It spawns an ACP
 * agent (Gemini CLI natively, Claude Code / Codex via their adapters) as a
 * subprocess speaking JSON-RPC over stdio, and maps the protocol onto the same
 * domain surface `SdkSession` exposes, so `AgentConversation` renders it
 * unchanged. See docs/agents/acp.md.
 *
 * Wire plumbing is `@agentclientprotocol/sdk` — unlike the Claude Agent SDK it
 * spawns nothing itself (it takes the streams we hand it), so zym keeps its own
 * spawn discipline: a long-lived streaming child over stdio, the LspClient /
 * ClaudeStreamTransport pattern (works under node-gtk's GLib loop; see
 * claude-sdk/transport.ts for the rationale).
 *
 * Protocol → domain mapping:
 *   session/prompt resolves        → turn end (stopReason → idle / interrupted / error)
 *   agent_message_chunk            → assistant-start / assistant-text deltas
 *   agent_thought_chunk            → assistant-thinking deltas
 *   tool_call / tool_call_update   → tool-use / tool-result (+ file-edited for edits)
 *   plan                           → plan (rendered into the tasks panel)
 *   session/request_permission     → permission (options + optional diff body)
 *   usage_update                   → context + result (context-window gauge, cost)
 *   available_commands_update      → init (slash-command completion)
 *   current_mode_update            → mode (when the id maps onto an AgentMode)
 *   session_info_update.title      → session-name (display-only)
 *   session/cancel (notify)        ← interrupt
 *
 * Not wired yet (see docs/agents/acp.md): fs/terminal client capabilities,
 * resume via session/load, the zymBridge MCP tools (set_worktree/set_actions),
 * and auth flows (`authMethods` surfaces as an error row for now).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { ReadableStream, WritableStream } from 'node:stream/web';
import {
  client as acpClient,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type ContentBlock,
  type ContentChunk,
  type PlanEntry as AcpPlanEntry,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason,
  type ToolCallContent,
  type ToolCallLocation,
  type ToolCallUpdate,
  type ToolKind,
  type SessionMode,
  type UsageUpdate,
} from '@agentclientprotocol/sdk';
import { Disposable, Emitter } from '../../util/eventKit.ts';
import { AGENT_MODES, type AgentMode, type AgentStatus } from '../types.ts';
import type {
  ConversationSession,
  ContextUsage,
  MonitorInfo,
  PermissionDecision,
  PermissionRequest,
  PlanEntry,
  QuestionRequest,
  SubagentInfo,
  TaskProgress,
} from '../session.ts';
import type { Action } from '../../actions.ts';

export interface AcpSessionOptions {
  /** The ACP agent argv (e.g. `['gemini', '--acp']`). */
  command: string[];
  /** Working directory — becomes the ACP session's `cwd`. */
  cwd: string;
}

/** A pending `session/request_permission`, resolved by `respondPermission`. */
interface PendingPermission {
  id: string;
  resolve: (response: RequestPermissionResponse) => void;
}

export class AcpSession implements ConversationSession {
  private readonly options: AcpSessionOptions;
  private readonly emitter = new Emitter();
  private proc: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientConnection | null = null;
  private _status: AgentStatus = 'idle';
  private _permissionMode: AgentMode = 'default';
  private _sessionId: string | null = null;
  // The agent's display name (initialize agentInfo), surfaced as the "model".
  private agentName = '';
  private slashCommands: string[] = [];
  // The agent's session modes (session/new response); setPermissionMode only maps
  // onto them when an id coincides with an AgentMode (the claude adapter's do).
  private availableModes: SessionMode[] = [];
  // Prompts submitted before the handshake finished; flushed once the session exists.
  private readonly queued: string[] = [];
  // Whether an assistant bubble is open (a new messageId / turn end closes it).
  private assistantOpen = false;
  private lastMessageId: string | null = null;
  private pendingPermission: PendingPermission | null = null;
  private permCounter = 0;
  // Tool calls seen this session: title/kind for permission fallbacks, `done` so a
  // repeated terminal update can't append a second result to the row, and the
  // edit-kind paths accumulated from locations/diffs — reported as changed files
  // only when the call *completes* (a denied edit never touched the file).
  private readonly toolCalls = new Map<string, { title: string; kind: ToolKind; done: boolean; paths: Set<string> }>();
  private readonly stderrTail: string[] = [];
  private exited = false;

  constructor(options: AcpSessionOptions) {
    this.options = options;
  }

  get status(): AgentStatus { return this._status; }
  get permissionMode(): AgentMode { return this._permissionMode; }
  get sessionId(): string | null { return this._sessionId; }

  /** Spawn the agent and run the ACP handshake (initialize + session/new). */
  start(): void {
    if (this.proc) return;
    const argv = this.options.command;
    const proc = spawn(argv[0], argv.slice(1), {
      cwd: this.options.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    // A spawn failure (ENOENT for a missing agent binary) arrives as 'error';
    // 'exit' still follows. Absorb stdin EPIPE like the claude transport does —
    // a write to a just-crashed child must not take zym down.
    proc.on('error', (err) => this.captureStderr(String((err as Error).message ?? err)));
    proc.on('exit', (code) => this.handleExit(code));
    // Closing the SDK connection aborts/cancels the Web-stream wrappers, which
    // destroy the underlying sockets *with an error* — absorb on all three pipes
    // or the teardown of a session crashes zym with an unhandled 'error'.
    proc.stdin.on('error', () => { /* pipe closed; surfaced via 'exit' */ });
    proc.stdout.on('error', () => { /* stream cancelled on close */ });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('error', () => { /* stream cancelled on close */ });
    proc.stderr.on('data', (chunk: string) => this.captureStderr(chunk));

    // The SDK frames newline-delimited JSON over the Web-stream pair; node wraps
    // the child's stdio. (Node types the wrappers loosely — the payload is bytes.)
    const stream = ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
    );
    const app = acpClient({ name: 'zym' })
      .onNotification('session/update', (ctx) => this.onSessionUpdate(ctx.params))
      .onRequest('session/request_permission', (ctx) => this.onPermissionRequest(ctx.params));
    this.connection = app.connect(stream);
    void this.handshake(this.connection).catch((err: unknown) => {
      if (this.exited) return;
      this.emitter.emit('error', { message: 'ACP handshake failed', detail: detailOf(err) || this.recentStderr() });
      this.setStatus('idle');
    });
  }

  private async handshake(conn: ClientConnection): Promise<void> {
    const init = await conn.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'zym', version: '0' },
      // No client capabilities yet: the agent reads/writes/executes on its own
      // side; fs (unsaved-buffer serving) and terminals are planned (docs).
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    this.agentName = init.agentInfo?.name ?? '';
    const session = await conn.agent.request('session/new', { cwd: this.options.cwd, mcpServers: [] });
    this._sessionId = session.sessionId;
    if (session.modes) {
      this.availableModes = session.modes.availableModes;
      this.applyModeId(session.modes.currentModeId);
      // Start in the ask-first mode when the agent has one: the Claude Code
      // adapter defaults its session to `acceptEdits` (verified — it writes files
      // without ever requesting permission), which silently bypasses zym's
      // permission cards. Mirrors claude-sdk's `--permission-mode default`.
      if (session.modes.currentModeId !== 'default' && this.availableModes.some((m) => m.id === 'default')) {
        void conn.agent.request('session/set_mode', { sessionId: session.sessionId, modeId: 'default' }).catch(() => { /* agent default stays */ });
        this.applyModeId('default');
      }
    }
    this.emitInit();
    for (const text of this.queued.splice(0)) this.sendPrompt(text);
  }

  private emitInit(): void {
    this.emitter.emit('init', {
      model: this.agentName || this.options.command[0],
      slashCommands: this.slashCommands,
    });
  }

  /** Send a user turn. Queued until the handshake completes. */
  prompt(text: string): void {
    if (this._status === 'disconnected') return;
    this.emitter.emit('user-message', { text });
    this.assistantOpen = false;
    this.setStatus('working');
    if (!this._sessionId) { this.queued.push(text); return; }
    this.sendPrompt(text);
  }

  private sendPrompt(text: string): void {
    const conn = this.connection;
    const sessionId = this._sessionId;
    if (!conn || !sessionId) return;
    conn.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
      .then((res) => this.onTurnEnd(res.stopReason))
      .catch((err: unknown) => {
        if (this.exited) return; // the exit row already tells the story
        this.emitter.emit('error', { message: 'Agent error', detail: detailOf(err) || this.recentStderr() });
        this.setStatus('idle');
      });
  }

  // The turn's terminal outcome, from the session/prompt response.
  private onTurnEnd(stopReason: StopReason): void {
    this.assistantOpen = false;
    if (stopReason === 'cancelled') this.emitter.emit('interrupted');
    else if (stopReason !== 'end_turn') this.emitter.emit('error', { message: `Agent stopped (${stopReason})` });
    this.setStatus('idle');
  }

  /** Interrupt the in-flight turn (`session/cancel`). A pending permission request
   *  MUST resolve `cancelled` (spec); the turn then ends with stopReason `cancelled`. */
  interrupt(): boolean {
    const conn = this.connection;
    const sessionId = this._sessionId;
    if (!conn || !sessionId) return false;
    if (this._status !== 'working' && this._status !== 'waiting') return false;
    this.resolvePendingPermission({ outcome: { outcome: 'cancelled' } });
    void conn.agent.notify('session/cancel', { sessionId });
    return true;
  }

  /** Switch modes when the agent advertises one whose id is a zym AgentMode (the
   *  Claude Code adapter's modes are; e.g. Gemini's ask/code/architect are not). */
  setPermissionMode(mode: AgentMode): void {
    const conn = this.connection;
    const sessionId = this._sessionId;
    if (!conn || !sessionId || mode === this._permissionMode) return;
    if (!this.availableModes.some((m) => m.id === mode)) return;
    void conn.agent.request('session/set_mode', { sessionId, modeId: mode }).catch(() => { /* mode stays */ });
    this.applyModeId(mode); // optimistic; a current_mode_update corrects it
  }

  respondPermission(id: string, decision: PermissionDecision): void {
    if (!this.pendingPermission || this.pendingPermission.id !== id) return; // stale / already answered
    const optionId = decision.optionId;
    this.resolvePendingPermission(
      optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } },
    );
    this.setStatus('working'); // the agent resumes once it reads the decision
  }

  getSubagent(_id: string): SubagentInfo | undefined { return undefined; }
  getMonitor(_id: string): MonitorInfo | undefined { return undefined; }
  stopTask(_taskId: string): void { /* no background tasks over ACP */ }

  /** Stop the agent process but keep the session object (status → `disconnected`). */
  stop(): void {
    if (this._status === 'disconnected') return;
    this.killProcess();
    this.handleExit(null);
  }

  dispose(): void {
    this.exited = true;
    this.resolvePendingPermission({ outcome: { outcome: 'cancelled' } });
    this.connection?.close();
    this.connection = null;
    this.killProcess();
  }

  // --- events -----------------------------------------------------------------

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
  onError(cb: (m: { message: string; detail?: string }) => void): Disposable { return this.emitter.on('error', cb as (v?: unknown) => void); }
  onInterrupted(cb: () => void): Disposable { return this.emitter.on('interrupted', cb as (v?: unknown) => void); }
  onUnhandled(cb: (m: { event: unknown }) => void): Disposable { return this.emitter.on('unhandled', cb as (v?: unknown) => void); }
  onPermission(cb: (r: PermissionRequest) => void): Disposable { return this.emitter.on('permission', cb as (v?: unknown) => void); }
  onActions(cb: (m: { actions: Action[] }) => void): Disposable { return this.emitter.on('actions', cb as (v?: unknown) => void); }
  onCwd(cb: (m: { cwd: string }) => void): Disposable { return this.emitter.on('cwd', cb as (v?: unknown) => void); }
  onExit(cb: (m: { code: number | null; stderr: string }) => void): Disposable { return this.emitter.on('exit', cb as (v?: unknown) => void); }
  onThinkingTokens(cb: (m: { tokens: number }) => void): Disposable { return this.emitter.on('thinking-tokens', cb as (v?: unknown) => void); }
  onTaskProgress(cb: (m: TaskProgress) => void): Disposable { return this.emitter.on('task-progress', cb as (v?: unknown) => void); }
  onSubagentUpdate(cb: (m: { id: string }) => void): Disposable { return this.emitter.on('subagent-update', cb as (v?: unknown) => void); }
  onSubagentDone(cb: (m: { id: string }) => void): Disposable { return this.emitter.on('subagent-done', cb as (v?: unknown) => void); }
  onMonitorUpdate(cb: (m: { id: string }) => void): Disposable { return this.emitter.on('monitor-update', cb as (v?: unknown) => void); }
  onQuestion(cb: (r: QuestionRequest) => void): Disposable { return this.emitter.on('question', cb as (v?: unknown) => void); }
  onPlan(cb: (m: { entries: PlanEntry[] }) => void): Disposable { return this.emitter.on('plan', cb as (v?: unknown) => void); }
  onFileEdited(cb: (m: { path: string }) => void): Disposable { return this.emitter.on('file-edited', cb as (v?: unknown) => void); }
  onSessionName(cb: (m: { name: string | null }) => void): Disposable { return this.emitter.on('session-name', cb as (v?: unknown) => void); }

  // --- protocol → domain --------------------------------------------------------

  private onSessionUpdate(note: SessionNotification): void {
    const update = note.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.onAssistantChunk(update);
        return;
      case 'agent_thought_chunk': {
        const text = contentText(update.content);
        if (text) this.emitter.emit('assistant-thinking', { delta: text });
        return;
      }
      case 'user_message_chunk':
        return; // history replay (session/load) — not wired yet; live turns render locally
      case 'tool_call':
        this.onToolCall(update);
        return;
      case 'tool_call_update':
        this.onToolCallUpdate(update);
        return;
      case 'plan':
        this.emitter.emit('plan', { entries: update.entries.map(planEntry) });
        return;
      case 'available_commands_update':
        this.slashCommands = update.availableCommands.map((c) => c.name);
        this.emitInit(); // refresh the slash-completion source (model unchanged)
        return;
      case 'current_mode_update':
        this.applyModeId(update.currentModeId);
        return;
      case 'usage_update':
        this.onUsage(update);
        return;
      case 'session_info_update':
        if (update.title !== undefined) this.emitter.emit('session-name', { name: update.title ?? null });
        return;
      case 'config_option_update':
      case 'plan_update': // unstable granular plan patches — the full `plan` replaces suffice
      case 'plan_removed':
        return; // known; ignored
      default:
        this.emitter.emit('unhandled', { event: update });
    }
  }

  // Streamed assistant text. A change of messageId is a new message → fresh bubble.
  private onAssistantChunk(chunk: ContentChunk): void {
    const text = contentText(chunk.content);
    if (!text) return;
    if (chunk.messageId && chunk.messageId !== this.lastMessageId) {
      this.lastMessageId = chunk.messageId;
      this.assistantOpen = false;
    }
    if (!this.assistantOpen) {
      this.assistantOpen = true;
      this.emitter.emit('assistant-start');
    }
    this.emitter.emit('assistant-text', { delta: text });
  }

  private onToolCall(call: ToolCallUpdate & { title?: string | null }): void {
    const title = call.title ?? 'tool';
    const entry = { title, kind: call.kind ?? 'other', done: false, paths: new Set<string>() };
    this.toolCalls.set(call.toolCallId, entry);
    this.assistantOpen = false; // post-tool text opens a fresh bubble (mirrors claude-sdk)
    this.emitter.emit('tool-use', { id: call.toolCallId, name: title, input: call.rawInput });
    this.trackEdits(entry, call.kind ?? 'other', call.locations ?? null, call.content ?? null);
    if (call.status === 'completed' || call.status === 'failed') this.finishToolCall(call.toolCallId, call.status, call.content ?? null, call.rawOutput);
  }

  private onToolCallUpdate(update: ToolCallUpdate): void {
    const known = this.toolCalls.get(update.toolCallId);
    // An update for a call we never saw opens its row first (defensive: agents may
    // emit the initial tool_call with terminal status in one go, or skip it);
    // onToolCall also tracks its edits and handles a terminal status.
    if (!known) {
      this.onToolCall(update);
      return;
    }
    this.trackEdits(known, update.kind ?? known.kind, update.locations ?? null, update.content ?? null);
    if (update.status === 'completed' || update.status === 'failed') {
      this.finishToolCall(update.toolCallId, update.status, update.content ?? null, update.rawOutput);
    }
  }

  private finishToolCall(id: string, status: 'completed' | 'failed', content: ToolCallContent[] | null, rawOutput: unknown): void {
    const known = this.toolCalls.get(id);
    if (known?.done) return; // a repeated terminal update must not append twice
    if (known) known.done = true;
    // Only a *completed* edit changed anything — a denied/failed one never touched
    // the file (verified: the adapter reports the write's locations up front).
    if (known && status === 'completed') {
      for (const path of known.paths) this.emitter.emit('file-edited', { path });
    }
    const text = toolContentText(content) || rawOutputText(rawOutput);
    this.emitter.emit('tool-result', { id, isError: status === 'failed', text });
  }

  // An edit-kind tool call names the files it touches (locations, diff paths) —
  // accumulated on the call, reported when it completes (finishToolCall).
  private trackEdits(entry: { paths: Set<string> }, kind: ToolKind, locations: ToolCallLocation[] | null, content: ToolCallContent[] | null): void {
    if (kind !== 'edit' && kind !== 'delete' && kind !== 'move') return;
    for (const location of locations ?? []) entry.paths.add(location.path);
    for (const item of content ?? []) if (item.type === 'diff') entry.paths.add(item.path);
  }

  private onUsage(usage: UsageUpdate): void {
    // ACP reports one occupancy number (no cache-tier breakdown) — the gauge reads
    // `tokens`; the popover's tiers stay zero.
    this.emitter.emit('context', { tokens: usage.used, input: usage.used, cacheRead: 0, cacheCreation: 0, output: 0 });
    this.emitter.emit('result', {
      costUsd: usage.cost && usage.cost.currency === 'USD' ? usage.cost.amount : undefined,
      contextWindow: usage.size,
    });
  }

  private onPermissionRequest(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // Only one outstanding request at a time (the turn blocks on it); a stale one
    // — shouldn't happen — is cancelled rather than leaked.
    this.resolvePendingPermission({ outcome: { outcome: 'cancelled' } });
    const toolCall = params.toolCall;
    const known = this.toolCalls.get(toolCall.toolCallId);
    const id = `perm-${++this.permCounter}`;
    const request: PermissionRequest = {
      id,
      toolName: toolCall.title ?? known?.title ?? 'tool',
      input: toolCall.rawInput,
      options: params.options.map((o) => ({ id: o.optionId, label: o.name, kind: o.kind })),
      diff: firstDiff(toolCall.content ?? null),
    };
    this.setStatus('waiting');
    return new Promise((resolve) => {
      this.pendingPermission = { id, resolve };
      this.emitter.emit('permission', request);
    });
  }

  private resolvePendingPermission(response: RequestPermissionResponse): void {
    const pending = this.pendingPermission;
    if (!pending) return;
    this.pendingPermission = null;
    pending.resolve(response);
  }

  private applyModeId(modeId: string): void {
    if (!AGENT_MODES.has(modeId as AgentMode) || modeId === this._permissionMode) return;
    this._permissionMode = modeId as AgentMode;
    this.emitter.emit('mode');
  }

  // --- process lifecycle ---------------------------------------------------------

  private killProcess(): void {
    const proc = this.proc;
    if (!proc) return;
    proc.stdout.removeAllListeners();
    proc.stderr.removeAllListeners();
    // Re-arm the error absorbers removeAllListeners just dropped — the SDK
    // connection teardown destroys these sockets with an error (see start()).
    proc.stdout.on('error', () => { /* stream cancelled on close */ });
    proc.stderr.on('error', () => { /* stream cancelled on close */ });
    try { proc.kill(); } catch { /* already gone */ }
  }

  private handleExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.resolvePendingPermission({ outcome: { outcome: 'cancelled' } });
    this.connection?.close();
    this.connection = null;
    this.setStatus('disconnected');
    if (code != null && code !== 0) console.warn(`[acp] agent exited (code ${code})${this.stderrTail.length ? `\n${this.recentStderr()}` : ''}`);
    this.emitter.emit('exit', { code, stderr: this.recentStderr() });
  }

  private captureStderr(chunk: string): void {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trimEnd();
      if (trimmed) this.stderrTail.push(trimmed);
    }
    const MAX = 40;
    if (this.stderrTail.length > MAX) this.stderrTail.splice(0, this.stderrTail.length - MAX);
  }

  private recentStderr(maxLines = 12): string {
    return this.stderrTail.slice(-maxLines).join('\n');
  }

  private setStatus(status: AgentStatus): void {
    // `disconnected` is terminal for a session object (mirrors SdkSession).
    if (this._status === 'disconnected' || status === this._status) return;
    this._status = status;
    this.emitter.emit('status');
  }
}

// --- pure helpers -----------------------------------------------------------------

/** The renderable text of a content block (only text carries prose; a resource
 *  link renders as its uri so it isn't silently dropped). */
function contentText(block: ContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'resource_link') return block.uri;
  return '';
}

/** Flatten a tool call's content into the row's result preview. */
function toolContentText(content: ToolCallContent[] | null): string {
  if (!content) return '';
  return content
    .map((item) => {
      if (item.type === 'content') return contentText(item.content);
      if (item.type === 'diff') return `[diff] ${item.path}`;
      return ''; // terminal content needs the terminal capability (not advertised)
    })
    .filter(Boolean)
    .join('\n');
}

function rawOutputText(rawOutput: unknown): string {
  if (rawOutput == null) return '';
  if (typeof rawOutput === 'string') return rawOutput;
  try { return JSON.stringify(rawOutput, null, 2); } catch { return String(rawOutput); }
}

/** The first diff of a tool call's content (the permission card's preview body). */
function firstDiff(content: ToolCallContent[] | null): PermissionRequest['diff'] {
  for (const item of content ?? []) {
    if (item.type === 'diff') return { path: item.path, oldText: item.oldText ?? null, newText: item.newText };
  }
  return undefined;
}

function planEntry(entry: AcpPlanEntry): PlanEntry {
  return { content: entry.content, status: entry.status };
}

function detailOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return err == null ? '' : String(err);
}
