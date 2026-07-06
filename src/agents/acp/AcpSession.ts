/*
 * AcpSession — a ConversationSession over the Agent Client Protocol
 * (https://agentclientprotocol.com), the `acp` agent kind. It spawns an ACP
 * agent (Gemini CLI natively, Claude Code / Codex via their adapters) as a
 * subprocess speaking JSON-RPC over stdio, and maps the protocol onto the
 * domain surface `AgentConversation` renders. See docs/agents/acp.md.
 *
 * Wire plumbing is `@agentclientprotocol/sdk` — unlike the Claude Agent SDK it
 * spawns nothing itself (it takes the streams we hand it), so zym keeps its own
 * spawn discipline: a long-lived streaming child over stdio, the LspClient
 * pattern (works under node-gtk's GLib loop).
 *
 * Protocol → domain mapping:
 *   session/prompt resolves          → turn end (stopReason → idle / interrupted / error)
 *   agent_message_chunk              → assistant-start / assistant-text deltas
 *   agent_thought_chunk              → assistant-thinking deltas
 *   tool_call / tool_call_update     → tool-use / tool-result (+ file-edited on completed edits)
 *   plan                             → plan (rendered into the tasks panel)
 *   session/request_permission       → permission (options + optional diff body)
 *   elicitation/create (form)        → question (the QuestionCard; AskUserQuestion rides this)
 *   usage_update                     → context + result (context-window gauge, cost)
 *   available_commands_update        → init (slash-command completion)
 *   current_mode_update / set_mode   → mode (generic mode state; see getModeState)
 *   session_info_update.title        → session-name (display-only)
 *   session/load (loadSession cap)   → history replay between onReplay(true/false)
 *   unstable_forkSession (fork cap)  → branch (fresh session off the same context)
 *   session/cancel (notify)          ← interrupt() (pending permission/question resolve cancelled)
 *   fs/read_text_file / write_text_file ← served from the injected AcpFsHost (the
 *                                      Document registry: reads see unsaved buffers,
 *                                      writes land in open documents)
 *   terminal/*                       ← zym-owned command execution (AcpTerminalRegistry);
 *                                      live terminals wear the monitor surface (panel
 *                                      with kill buttons, live-output inspect page)
 *
 * Adapter extensions (the official claude-agent-acp; all optional, all under
 * ACP's reserved `_meta` extension channel — anything absent degrades to the
 * generic rendering):
 *   _meta.claudeCode.toolName        → the real claude tool name; the widget's
 *                                      claude-quality rows (Bash, file groups) key off it
 *   _meta.claudeCode.parentToolUseId → subagent activity, captured into per-Task
 *                                      transcripts (the SubagentView drill-down pages)
 *   _meta.terminal_output/exit       → streamed command output for execute tools
 *                                      (advertised via clientCapabilities._meta.terminal_output)
 *   session/new _meta.claudeCode.options.resume → context-only resume fallback
 *                                      when loadSession isn't advertised
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as Fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import type { ReadableStream, WritableStream } from 'node:stream/web';
import {
  client as acpClient,
  ndJsonStream,
  RequestError,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type ClientConnection,
  type ContentBlock,
  type ContentChunk,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type ElicitationContentValue,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type McpServerStdio,
  type PlanEntry as AcpPlanEntry,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type ToolCallContent,
  type ToolCallLocation,
  type ToolCallUpdate,
  type ToolKind,
  type SessionConfigOption,
  type SessionMode,
  type SessionModeState,
  type SetSessionConfigOptionRequest,
  type UsageUpdate,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import { AcpTerminalRegistry, type AcpTerminal } from './terminals.ts';
import { writeAcpOptionsCache, type CachedAgentOptions, type CachedConfigOption } from './optionsCache.ts';
import { Disposable, Emitter } from '../../util/eventKit.ts';
import { AGENT_MODES, type AgentMode, type AgentResume, type AgentStatus } from '../types.ts';
import type {
  AgentQuestion,
  ConfigOption,
  ConversationSession,
  ContextUsage,
  MonitorInfo,
  PermissionDecision,
  PermissionRequest,
  PlanEntry,
  QuestionRequest,
  SubagentInfo,
  SubagentMessage,
  TaskProgress,
} from '../session.ts';
import type { Action } from '../../actions.ts';

/** An MCP server passed to `session/new` (ACP's stdio shape). */
export type AcpMcpServer = McpServerStdio;

/** The zym editor bridge, injected by the kind registry (its implementation
 *  imports Gio, which this module must not — see acp/bridge.ts). */
export interface AcpBridge {
  /** MCP servers to hand the agent at session setup. */
  readonly mcpServers: AcpMcpServer[];
  /** Start watching the bridge's IPC files, reporting into `host`. */
  watch(host: { onActions(actions: Action[]): void; onCwd(cwd: string): void }): Disposable;
  dispose(): void;
}

/** The editor's file backend for the ACP `fs` capability: reads return the live
 *  buffer of an open document (unsaved edits included) and writes land in it,
 *  so the agent and the editor share one view of every file. Injected like the
 *  bridge — the implementation reaches the window's DocumentRegistry (GTK),
 *  which this module must not (see acp/documentFs.ts). */
export interface AcpFsHost {
  /** Full current text of `path` (a throw with `code === 'ENOENT'` becomes
   *  ACP's resource-not-found error). */
  readTextFile(path: string): string | Promise<string>;
  /** Replace `path` with `content`, creating the file (parents included) when new. */
  writeTextFile(path: string, content: string): void | Promise<void>;
}

export interface AcpSessionOptions {
  /** The ACP agent argv (e.g. `['gemini', '--acp']`). */
  command: string[];
  /** Working directory — becomes the ACP session's `cwd`. */
  cwd: string;
  /** Resume a past conversation: `session/load` when the agent advertises
   *  `loadSession` (history replays), `unstable_forkSession` for `fork`, else a
   *  context-only resume via the claude adapter's `_meta` extension. */
  resume?: AgentResume;
  /** The zym editor bridge (set_worktree / set_actions); optional so the
   *  session stays drivable from plain node (tests / spikes). */
  bridge?: AcpBridge;
  /** Editor-backed file access; when present the `fs` capability is advertised
   *  and `fs/read_text_file` / `fs/write_text_file` are served from it. */
  fs?: AcpFsHost;
  /** Launcher selections applied over the protocol (`'default'`/absent = the
   *  agent's own default): `model` rides `_meta.claudeCode.options.model` on
   *  session/new — the claude adapter honors it, and foreign `_meta` MUST be
   *  ignored by other agents (spec) — and `permissionMode` names the session
   *  mode to force after setup instead of the ask-first `default`. */
  model?: string;
  permissionMode?: string;
  /** Generic config options to apply after session setup (ACP
   *  `session/set_config_option`): value id per option id (a boolean for a
   *  boolean option). The launcher fills these from the agent's advertised
   *  `configOptions` (model / effort / …); the `mode` category rides
   *  `permissionMode`, not here. */
  configOptions?: Record<string, string | boolean>;
}

/** A pending agent→client request, resolved by the user's decision. */
interface Pending<T> {
  id: string;
  resolve: (response: T) => void;
}

/** What we track per tool call: the ACP title (permission cards), the claude
 *  tool name when the adapter stamps one (domain `name` — drives the widget's
 *  per-tool rendering), edit paths (reported on completion), accumulated
 *  terminal output, and `done` so a repeated terminal update can't append twice.
 *
 *  `emitted` implements input buffering: the adapter streams the initial
 *  tool_call *before* rawInput has finished streaming (verified — it arrives
 *  `{}` and a refine tool_call_update carries the full input). The widget
 *  builds each row once from the tool-use event, so emission waits for the
 *  input (or for execution to start / finish, whichever comes first). */
interface ToolCallEntry {
  title: string;
  name: string;
  kind: ToolKind;
  rawInput: unknown;
  emitted: boolean;
  done: boolean;
  paths: Set<string>;
  terminalOutput?: string;
  exitCode?: number | null;
  /** A zym terminal embedded in the call's content (`{type:'terminal'}`) — the
   *  row's result falls back to its captured output. */
  terminalId?: string;
}

// Elicitation form-field conventions of the claude adapter (question_<n> +
// question_<n>_custom); generic MCP elicitations with enum fields parse the
// same way, "custom" fields are simply absent then.
const CUSTOM_FIELD_SUFFIX = '_custom';
const OPTION_META_KEY = '_claude/askUserQuestionOption';

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
  private agentCaps: AgentCapabilities = {};
  private authMethodNames: string[] = [];
  private slashCommands: string[] = [];
  // The agent's session modes (session/new / session/load response); surfaced
  // generically via getModeState, and mapped onto AgentMode where ids coincide.
  private availableModes: SessionMode[] = [];
  private currentModeId: string | null = null;
  // The agent's generic config options (session/new + session/set_config_option +
  // config_option_update all carry the full set). The `mode` category is filtered
  // out — it rides the mode channel above. Surfaced via getConfigOptions.
  private availableConfigOptions: SessionConfigOption[] = [];
  // Prompts submitted before the handshake finished; flushed once the session exists.
  private readonly queued: string[] = [];
  // Whether an assistant bubble is open (a new messageId / turn end closes it).
  private assistantOpen = false;
  private lastMessageId: string | null = null;
  private pendingPermission: Pending<RequestPermissionResponse> | null = null;
  // Pending form elicitations (QuestionCard answers), keyed by our generated id,
  // carrying the field keys to write the answers back into.
  private readonly pendingQuestions = new Map<string, {
    resolve: (response: CreateElicitationResponse) => void;
    fields: Array<{ key: string; multiSelect: boolean; hasCustom: boolean }>;
  }>();
  private idCounter = 0;
  private readonly toolCalls = new Map<string, ToolCallEntry>();
  // Captured subagent transcripts (Task tool calls), keyed by the spawning
  // tool call's id — populated from `_meta.claudeCode.parentToolUseId` updates.
  private readonly subagents = new Map<string, SubagentInfo>();
  // zym-owned command execution the agent drives over `terminal/*`; surfaced
  // in the UI through the monitor mapping (getMonitor / onMonitorUpdate).
  private readonly terminals = new AcpTerminalRegistry();
  // First-touch baselines: a file's content the first time this agent edits it,
  // captured when the edit-kind tool_call streams in — which is before the tool
  // executes (verified: the adapter emits tool_call, then permission, then runs)
  // — so the Agent Changes diff has a well-defined OLD side without hooks or
  // snapshot files. `null` = the file didn't exist (a created file).
  private readonly baselines = new Map<string, string | null>();
  // True while session/load replays history (rows render statically).
  private replaying = false;
  private bridgeWatch: Disposable | null = null;
  private readonly stderrTail: string[] = [];
  private exited = false;

  constructor(options: AcpSessionOptions) {
    this.options = options;
  }

  get status(): AgentStatus { return this._status; }
  get permissionMode(): AgentMode { return this._permissionMode; }
  get sessionId(): string | null { return this._sessionId; }

  /** Spawn the agent and run the ACP handshake (initialize + session setup). */
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
    // 'exit' still follows. Closing the SDK connection aborts/cancels the
    // Web-stream wrappers, which destroy the underlying sockets *with an error*
    // — absorb on all three pipes or tearing a session down crashes zym.
    proc.on('error', (err) => this.captureStderr(String((err as Error).message ?? err)));
    proc.on('exit', (code) => this.handleExit(code));
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
      .onRequest('session/request_permission', (ctx) => this.onPermissionRequest(ctx.params))
      .onRequest('elicitation/create', (ctx) => this.onElicitation(ctx.params))
      .onRequest('fs/read_text_file', (ctx) => this.onReadTextFile(ctx.params))
      .onRequest('fs/write_text_file', (ctx) => this.onWriteTextFile(ctx.params))
      .onRequest('terminal/create', (ctx) => this.onTerminalCreate(ctx.params))
      .onRequest('terminal/output', (ctx) => this.onTerminalOutput(ctx.params))
      .onRequest('terminal/wait_for_exit', (ctx) => this.onTerminalWaitForExit(ctx.params))
      .onRequest('terminal/kill', (ctx) => this.onTerminalKill(ctx.params))
      .onRequest('terminal/release', (ctx) => this.onTerminalRelease(ctx.params));
    this.connection = app.connect(stream);
    void this.handshake(this.connection).catch((err: unknown) => {
      if (this.exited) return;
      if (err instanceof RequestError && err.code === RequestError.authRequired().code) {
        const methods = this.authMethodNames.length ? ` (login methods: ${this.authMethodNames.join(', ')})` : '';
        this.emitter.emit('error', {
          message: 'Agent requires login',
          detail: `Authenticate with the agent's own CLI first — run \`${this.options.command.join(' ')}\` in a terminal${methods}.`,
        });
      } else {
        this.emitter.emit('error', { message: 'ACP handshake failed', detail: detailOf(err) || this.recentStderr() });
      }
      this.endReplay();
      this.setStatus('idle');
    });
  }

  private async handshake(conn: ClientConnection): Promise<void> {
    const init = await conn.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'zym', version: '0' },
      clientCapabilities: {
        // fs is live when an editor backend is injected (reads see unsaved
        // buffers — see AcpFsHost). terminal/* is served by AcpTerminalRegistry
        // (zym-owned processes; needs no editor backend). The `_meta`
        // terminal_output channel stays advertised for the agents that stream
        // over it instead (codex-acp, the claude adapter).
        fs: { readTextFile: !!this.options.fs, writeTextFile: !!this.options.fs },
        terminal: true,
        elicitation: { form: {} },
        // Opt into generic session config options (model / effort / … via
        // `configOptions` + `session/set_config_option`); `boolean: {}` also lets
        // the agent send boolean toggles (e.g. the claude adapter's "Fast mode").
        session: { configOptions: { boolean: {} } },
        _meta: { terminal_output: true },
      },
    });
    this.agentName = init.agentInfo?.name ?? '';
    this.agentCaps = init.agentCapabilities ?? {};
    this.authMethodNames = (init.authMethods ?? []).map((m) => m.name);
    const mcpServers = this.options.bridge?.mcpServers ?? [];
    const cwd = this.options.cwd;
    const resume = this.options.resume;

    if (resume?.sessionId && resume.fork && this.agentCaps.sessionCapabilities?.fork) {
      // Branch: a fresh, independent session seeded with the original's context.
      const forked = await conn.agent.request('session/fork', {
        sessionId: resume.sessionId, cwd, mcpServers,
      });
      this._sessionId = forked.sessionId;
      this.applyModes(forked.modes ?? null);
      this.applyConfigOptions(forked.configOptions ?? null);
    } else if (resume?.sessionId && this.agentCaps.loadSession) {
      // Resume with history: the agent replays the whole conversation as
      // session/update notifications before the request resolves.
      this.replaying = true;
      this.emitter.emit('replay', { active: true });
      try {
        const loaded = await conn.agent.request('session/load', { sessionId: resume.sessionId, cwd, mcpServers });
        this._sessionId = resume.sessionId;
        this.applyModes(loaded.modes ?? null);
        this.applyConfigOptions(loaded.configOptions ?? null);
      } finally {
        this.endReplay();
      }
    } else {
      // Fresh session — or a context-only resume through the claude adapter's
      // `_meta` extension when the agent can't replay history. The launcher's
      // model selection rides the same options object (foreign `_meta` is
      // ignored by agents that don't know it, per spec).
      const claudeOptions: Record<string, unknown> = {};
      if (resume?.sessionId) claudeOptions.resume = resume.sessionId;
      if (this.options.model && this.options.model !== 'default') claudeOptions.model = this.options.model;
      const session = await conn.agent.request('session/new', {
        cwd,
        mcpServers,
        ...(Object.keys(claudeOptions).length ? { _meta: { claudeCode: { options: claudeOptions } } } : {}),
      });
      this._sessionId = session.sessionId;
      this.applyModes(session.modes ?? null);
      this.applyConfigOptions(session.configOptions ?? null);
    }

    // Start in the launcher-chosen session mode — else ask-first: the Claude
    // Code adapter defaults its session to `acceptEdits` (verified — it writes
    // files without ever requesting permission), which silently bypasses zym's
    // permission cards. The analog of `claude --permission-mode <mode>`. A
    // chosen mode the agent doesn't advertise falls back to forcing `default`.
    const chosenMode = this.options.permissionMode;
    const targetMode = chosenMode && chosenMode !== 'default' && this.availableModes.some((m) => m.id === chosenMode)
      ? chosenMode
      : 'default';
    if (this.currentModeId && this.currentModeId !== targetMode && this.availableModes.some((m) => m.id === targetMode)) {
      this.requestSetMode(conn, targetMode);
    }
    // Apply the launcher's config-option choices (model / effort / …), then
    // remember what this agent advertised so the next launcher can offer it.
    await this.applyLaunchConfigOptions(conn);
    this.persistOptionsCache();
    if (this.options.bridge) {
      this.bridgeWatch = this.options.bridge.watch({
        onActions: (actions) => this.emitter.emit('actions', { actions }),
        onCwd: (dir) => this.emitter.emit('cwd', { cwd: dir }),
      });
    }
    this.emitInit();
    for (const text of this.queued.splice(0)) this.sendPrompt(text);
  }

  // Close the replay window (idempotent — also called from the handshake's
  // error path so a failed load doesn't leave the widget in replay mode).
  private endReplay(): void {
    if (!this.replaying) return;
    this.replaying = false;
    this.emitter.emit('replay', { active: false });
  }

  private applyModes(modes: SessionModeState | null): void {
    if (!modes) return;
    this.availableModes = modes.availableModes;
    this.applyModeId(modes.currentModeId);
  }

  // Replace the config-option set wholesale (every wire source — session/new, the
  // set-response, config_option_update — carries the full list). The `mode`
  // category is dropped: it duplicates the mode channel (getModeState), which
  // owns the footer's mode dropdown and the ask-first forcing.
  private applyConfigOptions(raw: SessionConfigOption[] | null): void {
    const next = (raw ?? []).filter((o) => o.category !== 'mode' && o.id !== 'mode');
    this.availableConfigOptions = next;
    this.emitter.emit('config-options');
  }

  // Apply the launcher's chosen config values (session/set_config_option), in
  // advertised order so interdependent options settle correctly (e.g. the claude
  // adapter's effort list depends on the chosen model). Best-effort per option —
  // a value no longer valid for the current selection just fails and is skipped.
  private async applyLaunchConfigOptions(conn: ClientConnection): Promise<void> {
    const chosen = this.options.configOptions;
    if (!chosen) return;
    for (const opt of [...this.availableConfigOptions]) {
      if (!Object.prototype.hasOwnProperty.call(chosen, opt.id)) continue;
      await this.sendConfigOption(conn, opt, chosen[opt.id]);
    }
  }

  // Send one session/set_config_option and fold the returned (full) set back in.
  private sendConfigOption(conn: ClientConnection, opt: SessionConfigOption, value: string | boolean): Promise<void> {
    const sessionId = this._sessionId;
    if (!sessionId) return Promise.resolve();
    const body: SetSessionConfigOptionRequest = opt.type === 'boolean'
      ? { sessionId, configId: opt.id, type: 'boolean', value: value === true || value === 'true' }
      : { sessionId, configId: opt.id, value: String(value) };
    return conn.agent.request('session/set_config_option', body)
      .then((res) => {
        if (res?.configOptions) { this.applyConfigOptions(res.configOptions); this.persistOptionsCache(); }
      })
      .catch(() => { /* value not applicable for the current selection — leave as-is */ });
  }

  // Remember what this agent advertised (modes + config options) so the next
  // launcher can offer real choices without a probe spawn. Keyed by the argv.
  private persistOptionsCache(): void {
    if (this.availableModes.length === 0 && this.availableConfigOptions.length === 0) return;
    const snapshot: CachedAgentOptions = {};
    if (this.availableModes.length) {
      snapshot.modes = this.availableModes.map((m) => ({ id: m.id, name: m.name, ...(m.description ? { description: m.description } : {}) }));
      if (this.currentModeId) snapshot.currentModeId = this.currentModeId;
    }
    if (this.availableConfigOptions.length) {
      snapshot.configOptions = this.availableConfigOptions.map(configOptionToCache);
    }
    writeAcpOptionsCache(this.options.command, snapshot);
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

  /** Interrupt the in-flight turn (`session/cancel`). Pending permission /
   *  question requests MUST resolve `cancelled` (spec); the turn then ends with
   *  stopReason `cancelled`. */
  interrupt(): boolean {
    const conn = this.connection;
    const sessionId = this._sessionId;
    if (!conn || !sessionId) return false;
    if (this._status !== 'working' && this._status !== 'waiting') return false;
    this.cancelPendingInteractions();
    void conn.agent.notify('session/cancel', { sessionId });
    return true;
  }

  /** Switch modes when the agent advertises one whose id is a zym AgentMode
   *  (the Claude Code adapter's are); the footer's generic dropdown goes
   *  through setModeById instead. */
  setPermissionMode(mode: AgentMode): void {
    this.setModeById(mode);
  }

  getModeState(): { currentId: string; modes: Array<{ id: string; name: string }> } | null {
    if (this.availableModes.length === 0) return null;
    return {
      currentId: this.currentModeId ?? this.availableModes[0].id,
      modes: this.availableModes.map((m) => ({ id: m.id, name: m.name })),
    };
  }

  setModeById(id: string): void {
    const conn = this.connection;
    const sessionId = this._sessionId;
    if (!conn || !sessionId || id === this.currentModeId) return;
    if (!this.availableModes.some((m) => m.id === id)) return;
    this.requestSetMode(conn, id);
  }

  // Switch session mode optimistically, but honestly: apply it right away (a
  // current_mode_update may refine), and if the agent *rejects* it — e.g. gemini
  // refusing a "privileged" mode (yolo / autoEdit) in an untrusted folder — revert
  // the switch and surface why, instead of leaving the footer showing a mode that
  // never took (which reads as "the mode is broken" when the agent kept prompting).
  private requestSetMode(conn: ClientConnection, modeId: string): void {
    const sessionId = this._sessionId;
    if (!sessionId) return;
    const previous = this.currentModeId;
    void conn.agent.request('session/set_mode', { sessionId, modeId }).catch((err: unknown) => {
      if (this.exited) return;
      if (previous) this.applyModeId(previous); // undo the optimistic switch
      this.emitter.emit('error', { message: `Couldn't switch to mode “${modeId}”`, detail: requestErrorDetail(err) });
    });
    this.applyModeId(modeId); // optimistic; reverted above if the agent rejects it
  }

  getConfigOptions(): ConfigOption[] | null {
    if (this.availableConfigOptions.length === 0) return null;
    return this.availableConfigOptions.map(configOptionToDomain);
  }

  setConfigOption(id: string, value: string | boolean): void {
    const conn = this.connection;
    const opt = this.availableConfigOptions.find((o) => o.id === id);
    if (!conn || !opt) return;
    void this.sendConfigOption(conn, opt, value); // the returned full set corrects the UI
  }

  respondPermission(id: string, decision: PermissionDecision): void {
    if (!this.pendingPermission || this.pendingPermission.id !== id) return; // stale / already answered
    const pending = this.pendingPermission;
    this.pendingPermission = null;
    const optionId = decision.optionId;
    pending.resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
    this.setStatus('working'); // the agent resumes once it reads the decision
  }

  /** Answer a form elicitation (the QuestionCard): selections land in the
   *  question fields; notes ride the adapter's per-question "custom" field
   *  (which takes precedence agent-side, so a note folds the selection in). */
  answerQuestion(id: string, answers: Array<{ header: string; labels: string[]; notes?: string }>): void {
    const pending = this.pendingQuestions.get(id);
    if (!pending) return; // stale / already answered
    this.pendingQuestions.delete(id);
    const content: Record<string, ElicitationContentValue> = {};
    let answered = false;
    pending.fields.forEach((field, index) => {
      const answer = answers[index];
      if (!answer) return;
      const notes = answer.notes?.trim();
      if (answer.labels.length > 0) {
        answered = true;
        content[field.key] = field.multiSelect ? answer.labels : answer.labels[0];
      }
      if (notes && field.hasCustom) {
        answered = true;
        // Agent-side, a custom answer overrides the selection — fold it in.
        content[`${field.key}${CUSTOM_FIELD_SUFFIX}`] = answer.labels.length > 0
          ? `${answer.labels.join(', ')} (note: ${notes})`
          : notes;
      }
    });
    pending.resolve(answered ? { action: 'accept', content } : { action: 'decline' });
    this.setStatus('working');
  }

  getSubagent(id: string): SubagentInfo | undefined { return this.subagents.get(id); }

  /** ACP terminals wear the monitor surface: the running panel lists them with
   *  a kill button (stopTask), the inspect page shows their live output. */
  getMonitor(id: string): MonitorInfo | undefined {
    const terminal = this.terminals.get(id);
    if (!terminal) return undefined;
    const current = terminal.currentOutput();
    const exit = current.exitStatus;
    const status = terminal.status === 'exited'
      ? `exited (${exit?.exitCode ?? exit?.signal ?? '?'})`
      : terminal.status;
    return { id, taskId: id, description: terminal.label, status, outputFile: null, output: current.output };
  }

  stopTask(taskId: string): void { this.terminals.get(taskId)?.kill(); }

  /** Stop the agent process but keep the session object (status → `disconnected`). */
  stop(): void {
    if (this._status === 'disconnected') return;
    this.killProcess();
    this.handleExit(null);
  }

  dispose(): void {
    this.exited = true;
    this.cancelPendingInteractions();
    this.terminals.dispose();
    this.bridgeWatch?.dispose();
    this.bridgeWatch = null;
    this.options.bridge?.dispose();
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
  onReplay(cb: (m: { active: boolean }) => void): Disposable { return this.emitter.on('replay', cb as (v?: unknown) => void); }
  onConfigOptions(cb: () => void): Disposable { return this.emitter.on('config-options', cb as (v?: unknown) => void); }

  // --- protocol → domain --------------------------------------------------------

  private onSessionUpdate(note: SessionNotification): void {
    const update = note.update;
    // Subagent activity (the claude adapter stamps the spawning Task tool's id)
    // is captured into that subagent's transcript, never the main thread.
    const parentId = claudeMeta(update)?.parentToolUseId;
    if (typeof parentId === 'string' && parentId) {
      this.onSubagentChild(parentId, update);
      return;
    }
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.onAssistantChunk(update);
        return;
      case 'agent_thought_chunk': {
        const text = contentText(update.content);
        if (text) this.emitter.emit('assistant-thinking', { delta: text });
        return;
      }
      case 'user_message_chunk': {
        // Replayed history (session/load): re-render the user's past turns.
        // Live turns are rendered locally in prompt(), and the adapter doesn't
        // echo them — only replay produces these.
        const text = contentText(update.content);
        if (text) this.emitter.emit('user-message', { text });
        return;
      }
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
        // The agent pushed a new full config-option set (some agents echo it on
        // the set-response instead — handled there); refresh + re-cache.
        this.applyConfigOptions(update.configOptions);
        this.persistOptionsCache();
        return;
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
    // The claude adapter stamps the real tool name — the widget's per-tool
    // rendering (Bash command rows, collapsed Read/Edit groups) keys off it.
    const claudeName = claudeMeta(call)?.toolName;
    const name = typeof claudeName === 'string' && claudeName ? claudeName : title;
    const entry: ToolCallEntry = { title, name, kind: call.kind ?? 'other', rawInput: call.rawInput, emitted: false, done: false, paths: new Set() };
    this.toolCalls.set(call.toolCallId, entry);
    this.absorbToolMeta(entry, call);
    this.trackEdits(entry, entry.kind, call.locations ?? null, call.content ?? null);
    this.absorbTerminalRef(entry, call.content ?? null);
    // Emit the row now if the input is already usable or the call is past the
    // streaming stage; otherwise wait for the refine update carrying the input.
    if (hasUsableInput(call.rawInput) || (call.status && call.status !== 'pending')) this.emitToolUse(call.toolCallId, entry);
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
    // Absorb refinements (the adapter re-sends title/kind/rawInput once the
    // model finishes streaming the call).
    if (update.rawInput !== undefined) known.rawInput = update.rawInput;
    if (update.title) known.title = update.title;
    if (update.kind) known.kind = update.kind;
    const claudeName = claudeMeta(update)?.toolName;
    if (typeof claudeName === 'string' && claudeName) known.name = claudeName;
    this.absorbToolMeta(known, update);
    this.trackEdits(known, known.kind, update.locations ?? null, update.content ?? null);
    this.absorbTerminalRef(known, update.content ?? null);
    if (this.refreshSubagentInfo(update.toolCallId, known) && known.emitted) {
      this.emitter.emit('subagent-update', { id: update.toolCallId }); // refined description/prompt → refresh the page
    }
    if (!known.emitted && (hasUsableInput(known.rawInput) || (update.status && update.status !== 'pending'))) {
      this.emitToolUse(update.toolCallId, known);
    }
    if (update.status === 'completed' || update.status === 'failed') {
      this.finishToolCall(update.toolCallId, update.status, update.content ?? null, update.rawOutput);
    }
  }

  // Surface the buffered tool row: a Task spawn opens a captured subagent
  // transcript (the widget keys the subagent UI off the domain name 'Agent');
  // everything else is a plain tool row.
  private emitToolUse(id: string, entry: ToolCallEntry): void {
    if (entry.emitted) return;
    entry.emitted = true;
    this.assistantOpen = false; // post-tool text opens a fresh bubble
    if (entry.name === 'Task' || entry.name === 'Agent') {
      const info = this.refreshSubagentInfo(id, entry, true)!;
      this.emitter.emit('subagent-start', { id, agentType: info.agentType, description: info.description });
      this.emitter.emit('tool-use', { id, name: 'Agent', input: entry.rawInput });
    } else {
      this.emitter.emit('tool-use', { id, name: entry.name, input: entry.rawInput });
    }
  }

  // Create/refresh a Task call's captured-subagent record from its (possibly
  // refined) input, merging into whatever a child update already created.
  private refreshSubagentInfo(id: string, entry: ToolCallEntry, create = false): SubagentInfo | undefined {
    const isTask = entry.name === 'Task' || entry.name === 'Agent';
    if (!isTask) return undefined;
    let info = this.subagents.get(id);
    if (!info) {
      if (!create) return undefined;
      info = { id, agentType: 'agent', description: entry.title, prompt: '', status: 'running', messages: [] };
      this.subagents.set(id, info);
    }
    const input = (entry.rawInput && typeof entry.rawInput === 'object' ? entry.rawInput : {}) as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    if (str(input.subagent_type)) info.agentType = str(input.subagent_type);
    if (str(input.description)) info.description = str(input.description);
    if (str(input.prompt)) info.prompt = str(input.prompt);
    return info;
  }

  // Fold a tool update's `_meta.terminal_*` channel (streamed command output;
  // codex-acp-compatible, sent by the claude adapter when we advertise
  // `_meta.terminal_output`) into the call's accumulated output.
  private absorbToolMeta(entry: ToolCallEntry, update: { _meta?: Record<string, unknown> | null }): void {
    const meta = update._meta;
    if (!meta || typeof meta !== 'object') return;
    const output = (meta as { terminal_output?: { data?: unknown } }).terminal_output;
    if (output && typeof output.data === 'string') entry.terminalOutput = output.data;
    const exit = (meta as { terminal_exit?: { exit_code?: unknown } }).terminal_exit;
    if (exit && typeof exit.exit_code === 'number') entry.exitCode = exit.exit_code;
  }

  private finishToolCall(id: string, status: 'completed' | 'failed', content: ToolCallContent[] | null, rawOutput: unknown): void {
    const known = this.toolCalls.get(id);
    if (known?.done) return; // a repeated terminal update must not append twice
    if (known) {
      known.done = true;
      this.emitToolUse(id, known); // a still-buffered row surfaces before its result
    }
    // Only a *completed* edit changed anything — a denied/failed one never
    // touched the file.
    if (known && status === 'completed') {
      for (const path of known.paths) this.emitter.emit('file-edited', { path });
    }
    // A Task completion closes its captured subagent transcript; the result
    // text is the subagent's final answer, appended to its page.
    const sub = this.subagents.get(id);
    if (sub) {
      const answer = toolContentText(content) || rawOutputText(rawOutput);
      if (answer) sub.messages.push({ kind: 'text', text: answer });
      sub.status = 'completed';
      this.emitter.emit('subagent-update', { id });
      this.emitter.emit('subagent-done', { id });
      return; // the widget renders the page, not a result row (no toolRows entry)
    }
    // Prefer the terminal channel's real output (the `_meta` stream, else an
    // embedded zym terminal's capture); fall back to content / rawOutput.
    let text = known?.terminalOutput ?? '';
    if (!text && known?.terminalId) {
      const terminal = this.terminals.get(known.terminalId);
      if (terminal) {
        const current = terminal.currentOutput();
        text = current.output;
        if (known.exitCode == null && current.exitStatus?.exitCode != null) known.exitCode = current.exitStatus.exitCode;
      }
    }
    if (!text) text = toolContentText(content) || rawOutputText(rawOutput);
    if (known?.exitCode != null && known.exitCode !== 0) text = `${text}${text ? '\n' : ''}(exit ${known.exitCode})`;
    this.emitter.emit('tool-result', { id, isError: status === 'failed', text });
  }

  // A subagent's activity (updates stamped with the spawning Task tool's id):
  // capture into its transcript for the drill-down page, never the main thread.
  private onSubagentChild(parentId: string, update: SessionNotification['update']): void {
    let info = this.subagents.get(parentId);
    if (!info) {
      // A child before/without its parent Task row (defensive): open a transcript
      // so nothing is lost; the parent's row appears when its tool_call arrives.
      info = { id: parentId, agentType: 'agent', description: this.toolCalls.get(parentId)?.title ?? '', prompt: '', status: 'running', messages: [] };
      this.subagents.set(parentId, info);
    }
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        // The adapter drops subagent prose today; keep the mapping so it appears
        // if that changes. Merge consecutive text into one message.
        const text = contentText(update.content);
        if (!text) return;
        const last = info.messages[info.messages.length - 1];
        if (last?.kind === 'text') last.text += text;
        else info.messages.push({ kind: 'text', text });
        break;
      }
      case 'tool_call': {
        const claudeName = claudeMeta(update)?.toolName;
        info.messages.push({
          kind: 'tool',
          toolId: update.toolCallId,
          name: typeof claudeName === 'string' && claudeName ? claudeName : (update.title ?? 'tool'),
          input: update.rawInput,
        });
        break;
      }
      case 'tool_call_update': {
        if (update.status !== 'completed' && update.status !== 'failed') return;
        const message = info.messages.find(
          (m): m is Extract<SubagentMessage, { kind: 'tool' }> => m.kind === 'tool' && m.toolId === update.toolCallId,
        );
        if (!message || message.result) return;
        message.result = {
          isError: update.status === 'failed',
          text: toolContentText(update.content ?? null) || rawOutputText(update.rawOutput),
        };
        break;
      }
      default:
        return; // other subagent updates (plans, usage) aren't captured
    }
    this.emitter.emit('subagent-update', { id: parentId });
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
    this.pendingPermission?.resolve({ outcome: { outcome: 'cancelled' } });
    this.pendingPermission = null;
    const toolCall = params.toolCall;
    const known = this.toolCalls.get(toolCall.toolCallId);
    if (known) {
      // The request's toolCall often carries the input the streamed tool_call
      // didn't have yet — absorb it, and make sure the row is on screen before
      // the approval card replaces the prompt.
      if (toolCall.rawInput !== undefined) known.rawInput = toolCall.rawInput;
      this.emitToolUse(toolCall.toolCallId, known);
    }
    const id = `perm-${++this.idCounter}`;
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

  // A form elicitation (an MCP server's request, or the claude adapter's
  // AskUserQuestion bridging) → the interactive QuestionCard. Forms we can't
  // render (url mode, free-form fields without options) are declined.
  private onElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> | CreateElicitationResponse {
    if (params.mode !== 'form') return { action: 'decline' };
    const parsed = parseElicitationForm(params);
    if (!parsed) return { action: 'decline' };
    const id = `question-${++this.idCounter}`;
    this.setStatus('waiting');
    return new Promise((resolve) => {
      this.pendingQuestions.set(id, { resolve, fields: parsed.fields });
      this.emitter.emit('question', { id, questions: parsed.questions });
    });
  }

  // --- fs capability ---------------------------------------------------------
  // Serving these from the editor is the point of the capability: the agent
  // reads what the user actually sees (unsaved buffers included) and its writes
  // land in the open document, not just on disk. Gemini CLI routes its file
  // tools here; the claude adapter defines the plumbing but doesn't call it yet
  // (verified against claude-agent-acp 0.55.0), so its tools still hit disk.

  private async onReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const fs = this.options.fs;
    if (!fs) throw RequestError.methodNotFound('fs/read_text_file'); // capability wasn't advertised
    let content: string;
    try {
      content = await fs.readTextFile(params.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw RequestError.resourceNotFound(params.path);
      throw err; // → the SDK's internal-error response, message preserved
    }
    return { content: sliceLines(content, params.line, params.limit) };
  }

  private async onWriteTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const fs = this.options.fs;
    if (!fs) throw RequestError.methodNotFound('fs/write_text_file');
    await fs.writeTextFile(params.path, params.content);
    return {};
  }

  // --- terminal capability -----------------------------------------------------
  // The agent runs commands *inside zym* (AcpTerminalRegistry — plain child
  // processes with an in-memory output buffer). Each live terminal is surfaced
  // through the monitor surface: a row in the running-terminals panel with a
  // kill button, and an inspect page with (near-)live output. Gemini CLI's
  // shell tool rides this; the claude adapter still streams buffered output
  // over `_meta.terminal_output` instead (verified 0.55.0).

  private onTerminalCreate(params: CreateTerminalRequest): CreateTerminalResponse {
    const terminal = this.terminals.create(params, this.options.cwd);
    // Output/exit changes refresh the monitors panel + any open inspect page
    // (coalesced in the registry); the sub dies with the terminal.
    terminal.onUpdate(() => this.emitter.emit('monitor-update', { id: terminal.id }));
    this.emitter.emit('monitor-update', { id: terminal.id });
    return { terminalId: terminal.id };
  }

  private terminalFor(id: string): AcpTerminal {
    const terminal = this.terminals.get(id);
    if (!terminal) throw RequestError.resourceNotFound(id);
    return terminal;
  }

  private onTerminalOutput(params: TerminalOutputRequest): TerminalOutputResponse {
    const current = this.terminalFor(params.terminalId).currentOutput();
    return {
      output: current.output,
      truncated: current.truncated,
      ...(current.exitStatus ? { exitStatus: current.exitStatus } : {}),
    };
  }

  private async onTerminalWaitForExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const exit = await this.terminalFor(params.terminalId).waitForExit();
    return { exitCode: exit.exitCode, signal: exit.signal };
  }

  private onTerminalKill(params: KillTerminalRequest): KillTerminalResponse {
    this.terminalFor(params.terminalId).kill();
    return {};
  }

  private onTerminalRelease(params: ReleaseTerminalRequest): ReleaseTerminalResponse {
    this.terminals.release(params.terminalId);
    this.emitter.emit('monitor-update', { id: params.terminalId }); // drops out of the panel
    return {};
  }

  private cancelPendingInteractions(): void {
    this.pendingPermission?.resolve({ outcome: { outcome: 'cancelled' } });
    this.pendingPermission = null;
    for (const pending of this.pendingQuestions.values()) pending.resolve({ action: 'cancel' });
    this.pendingQuestions.clear();
  }

  private applyModeId(modeId: string): void {
    if (modeId === this.currentModeId) return;
    this.currentModeId = modeId;
    if (AGENT_MODES.has(modeId as AgentMode)) this._permissionMode = modeId as AgentMode;
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
    this.cancelPendingInteractions();
    this.terminals.dispose(); // nothing left to consume them — kill any strays
    this.endReplay();
    this.bridgeWatch?.dispose();
    this.bridgeWatch = null;
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
    // `disconnected` is terminal for a session object (mirrors the claude kinds).
    if (this._status === 'disconnected' || status === this._status) return;
    this._status = status;
    this.emitter.emit('status');
  }

  // An edit-kind tool call names the files it touches (locations, diff paths) —
  // accumulated on the call, reported when it completes (finishToolCall), and
  // baseline-captured on first touch.
  private trackEdits(entry: ToolCallEntry, kind: ToolKind, locations: ToolCallLocation[] | null, content: ToolCallContent[] | null): void {
    if (kind !== 'edit' && kind !== 'delete' && kind !== 'move') return;
    for (const location of locations ?? []) this.trackEditPath(entry, location.path);
    for (const item of content ?? []) if (item.type === 'diff') this.trackEditPath(entry, item.path);
  }

  private trackEditPath(entry: ToolCallEntry, path: string): void {
    entry.paths.add(path);
    this.captureBaseline(path);
  }

  // Snapshot `path` before its first edit executes. Reads go through the fs
  // host when injected (buffer-aware — a user's unsaved edits from before the
  // agent ran must not be attributed to it). Skipped during history replay:
  // the file already contains the replayed edits, so a capture would lie —
  // resumed sessions fall back to the git HEAD blob in the review diff.
  private captureBaseline(path: string): void {
    if (this.replaying || this.baselines.has(path)) return;
    this.baselines.set(path, null); // reserve; stays null (= created) if unreadable
    try {
      const read = this.options.fs ? this.options.fs.readTextFile(path) : Fs.readFileSync(path, 'utf8');
      if (typeof read === 'string') this.baselines.set(path, read);
      else read.then((text) => this.baselines.set(path, text), () => { /* created */ });
    } catch { /* doesn't exist yet → created */ }
  }

  getBaseline(path: string): string | null | undefined { return this.baselines.get(path); }

  // A tool call can embed a zym terminal (content `{type:'terminal'}`) — remember
  // it so the row's result falls back to the captured output (finishToolCall).
  private absorbTerminalRef(entry: ToolCallEntry, content: ToolCallContent[] | null): void {
    for (const item of content ?? []) {
      if (item.type === 'terminal') entry.terminalId = item.terminalId;
    }
  }
}

// --- pure helpers -----------------------------------------------------------------

/** Flatten a select option's values (a flat list, or grouped) into `{value,name,description}`. */
function selectChoices(option: SessionConfigOption): Array<{ value: string; name: string; description?: string }> {
  if (option.type !== 'select') return [];
  const out: Array<{ value: string; name: string; description?: string }> = [];
  for (const item of option.options) {
    const values = 'group' in item ? item.options : [item]; // a group carries nested options
    for (const v of values) out.push({ value: v.value, name: v.name, ...(v.description ? { description: v.description } : {}) });
  }
  return out;
}

/** ACP `SessionConfigOption` → the tool-agnostic domain `ConfigOption` the UI renders. */
function configOptionToDomain(option: SessionConfigOption): ConfigOption {
  return {
    id: option.id,
    name: option.name,
    ...(option.description ? { description: option.description } : {}),
    ...(option.category ? { category: option.category } : {}),
    kind: option.type,
    current: option.currentValue,
    ...(option.type === 'select' ? { choices: selectChoices(option).map((c) => ({ value: c.value, label: c.name, ...(c.description ? { description: c.description } : {}) })) } : {}),
  };
}

/** ACP `SessionConfigOption` → the cache snapshot (launcher-seed shape). */
function configOptionToCache(option: SessionConfigOption): CachedConfigOption {
  return {
    id: option.id,
    name: option.name,
    ...(option.description ? { description: option.description } : {}),
    ...(option.category ? { category: option.category } : {}),
    kind: option.type,
    current: option.currentValue,
    ...(option.type === 'select' ? { choices: selectChoices(option) } : {}),
  };
}

/** The claude adapter's `_meta.claudeCode` extension on an update, if present. */
function claudeMeta(update: { _meta?: Record<string, unknown> | null }): Record<string, unknown> | undefined {
  const meta = update._meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const claude = (meta as { claudeCode?: unknown }).claudeCode;
  return claude && typeof claude === 'object' ? (claude as Record<string, unknown>) : undefined;
}

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
      return ''; // an embedded terminal's output is pulled in finishToolCall
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

/** The human-facing reason from a JSON-RPC error: the agent's `data.details` when
 *  present (e.g. gemini's "Cannot enable privileged approval modes in an untrusted
 *  folder."), else the message. */
function requestErrorDetail(err: unknown): string {
  const data = err && typeof err === 'object' ? (err as { data?: unknown }).data : undefined;
  const details = data && typeof data === 'object' ? (data as { details?: unknown }).details : undefined;
  return typeof details === 'string' && details ? details : detailOf(err);
}

/** Whether a streamed rawInput is worth rendering: the adapter emits `{}` while
 *  the model is still streaming the call's arguments (see ToolCallEntry.emitted). */
function hasUsableInput(rawInput: unknown): boolean {
  if (rawInput == null) return false;
  if (typeof rawInput !== 'object') return true;
  return Object.keys(rawInput as Record<string, unknown>).length > 0;
}

/** Apply `fs/read_text_file`'s optional window: `line` is the 1-based first
 *  line, `limit` the max number of lines. Exported for tests. */
export function sliceLines(content: string, line?: number | null, limit?: number | null): string {
  if (line == null && limit == null) return content;
  const lines = content.split('\n');
  const start = Math.min(Math.max(0, (line ?? 1) - 1), lines.length);
  const end = limit == null ? lines.length : start + Math.max(0, limit);
  return lines.slice(start, end).join('\n');
}

/** Parse a form elicitation into renderable questions + the field keys to write
 *  answers back into. Follows the claude adapter's AskUserQuestion conventions
 *  (`question_<n>` enums + `question_<n>_custom` free-text "Other" companions);
 *  a generic MCP form parses the same way when its fields are enums. Returns
 *  null when any primary field has no options (we can't render free-form-only
 *  forms — the caller declines). Exported for tests. */
export function parseElicitationForm(params: CreateElicitationRequest & { mode: 'form' }): {
  questions: AgentQuestion[];
  fields: Array<{ key: string; multiSelect: boolean; hasCustom: boolean }>;
} | null {
  const properties = (params.requestedSchema && typeof params.requestedSchema === 'object'
    ? (params.requestedSchema as { properties?: unknown }).properties
    : undefined);
  if (!properties || typeof properties !== 'object') return null;
  const entries = Object.entries(properties as Record<string, unknown>);
  const customKeys = new Set(entries.map(([k]) => k).filter((k) => k.endsWith(CUSTOM_FIELD_SUFFIX)));
  const questions: AgentQuestion[] = [];
  const fields: Array<{ key: string; multiSelect: boolean; hasCustom: boolean }> = [];

  for (const [key, rawField] of entries) {
    if (customKeys.has(key)) continue; // the "Other" companion of its question
    const field = (rawField && typeof rawField === 'object' ? rawField : {}) as Record<string, unknown>;
    const multiSelect = field.type === 'array';
    const items = (field.items && typeof field.items === 'object' ? field.items : {}) as Record<string, unknown>;
    const rawOptions = multiSelect ? items.anyOf : field.oneOf;
    if (!Array.isArray(rawOptions) || rawOptions.length === 0) return null; // free-form field — not renderable
    const options = rawOptions
      .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
      .map((o) => {
        const label = typeof o.const === 'string' ? o.const : '';
        const title = typeof o.title === 'string' ? o.title : '';
        const meta = (o._meta && typeof o._meta === 'object' ? (o._meta as Record<string, unknown>)[OPTION_META_KEY] : undefined);
        const metaDescription = meta && typeof meta === 'object' ? (meta as { description?: unknown }).description : undefined;
        const description = typeof metaDescription === 'string' && metaDescription
          ? metaDescription
          // Fallback: the adapter flattens "label — description" into the title.
          : title.startsWith(`${label} — `) ? title.slice(label.length + 3) : undefined;
        return { label, description };
      })
      .filter((o) => o.label !== '');
    if (options.length === 0) return null;
    const question = typeof field.description === 'string' && field.description ? field.description : params.message;
    questions.push({
      question,
      header: typeof field.title === 'string' && field.title ? field.title : question,
      multiSelect,
      options,
    });
    fields.push({ key, multiSelect, hasCustom: customKeys.has(`${key}${CUSTOM_FIELD_SUFFIX}`) });
  }
  return questions.length > 0 ? { questions, fields } : null;
}
