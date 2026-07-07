/*
 * agents/session.ts — the tool-agnostic conversation-session vocabulary: the
 * domain types and the `ConversationSession` interface that `AgentConversation`
 * (the native transcript UI) consumes. `AcpSession` (the Agent Client Protocol
 * kind) is the implementation. The UI holds a `ConversationSession`, never a
 * concrete class, so a new agent protocol only has to map its wire events onto
 * this surface.
 *
 * Everything here mirrors what a live turn produces: a status, granular
 * transcript events (so the widget appends incrementally), permission
 * requests, and session metadata. Optional members are capabilities a
 * protocol may not have — the widget guards each with `?.`.
 */
import type { Disposable } from '../util/eventKit.ts';
import type { Action } from '../actions.ts';
import type { AgentMode, AgentStatus } from './types.ts';

/** One selectable option of a permission request (the ACP shape; claude's binary
 *  allow/deny requests omit `options` and the widget renders its own set). */
export interface PermissionOption {
  /** Identifier returned to the agent as the decision (`PermissionDecision.optionId`). */
  id: string;
  /** Button label shown to the user. */
  label: string;
  /** UI hint: whether choosing this option allows or rejects, once or persistently. */
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

/** A permission request surfaced from the agent (status goes `waiting` until answered). */
export interface PermissionRequest {
  /** Correlates the request with `respondPermission`. */
  id: string;
  /** The tool the agent wants to run (e.g. `Bash`, or an ACP tool-call title). */
  toolName: string;
  /** The proposed tool input, shown to the user. */
  input: unknown;
  /** The agent's own options (ACP). Absent → the widget offers its default set. */
  options?: PermissionOption[];
  /** A file change to preview as a diff (ACP edit tool-calls carry it). */
  diff?: { path: string; oldText: string | null; newText: string };
}

/** The user's answer to a permission request. */
export interface PermissionDecision {
  allow: boolean;
  /** Why it was denied (surfaced to the agent); only used when `allow` is false. */
  message?: string;
  /** The chosen option (when the request carried `options`). */
  optionId?: string;
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

/** An `AskUserQuestion` request surfaced from the agent (status `waiting` until
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

/** A live background process surfaced in the monitors panel: an ACP terminal
 *  (keyed by its terminalId; `taskId` is what `stopTask` kills), or the legacy
 *  `Monitor` tool shape. Output is in-memory (`output`) for ACP terminals,
 *  file-based (`outputFile`) for the legacy path. */
export interface MonitorInfo {
  id: string;
  taskId: string | null;
  description: string;
  status: string;
  outputFile: string | null;
  output?: string | null;
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

/** One entry of the agent's reported execution plan (ACP `plan`; rendered into the
 *  same sticky panel the claude Task tools drive). */
export interface PlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** One generic session config option the agent advertises (ACP
 *  `SessionConfigOption`) — a `select` dropdown (model / reasoning effort / …) or
 *  a `boolean` toggle. Distinct from the permission-mode channel (`getModeState`):
 *  the `mode` category is dropped upstream, since modes ride that channel. Options
 *  are interdependent (choosing a model can change which efforts exist), so the UI
 *  rebuilds the whole set whenever `onConfigOptions` fires. */
export interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  /** ACP semantic category (`model` / `thought_level` / `model_config` / …); UX
   *  only, may be an unknown string or absent. */
  category?: string;
  kind: 'select' | 'boolean';
  /** The currently selected value (a value id for `select`, a boolean for `boolean`). */
  current: string | boolean;
  /** The selectable values (`select` only). */
  choices?: Array<{ value: string; label: string; description?: string }>;
}

/**
 * The session surface `AgentConversation` (and its child views) consume. The
 * required core is what every protocol can provide; the optional members are
 * per-protocol capabilities:
 *
 * - `onQuestion`/`answerQuestion` — interactive questions (ACP form elicitation;
 *   claude's AskUserQuestion rides it through the adapter).
 * - `onPlan` — ACP's execution plan (full replace per update).
 * - `onFileEdited` — protocols that report edited paths directly (ACP tool-call
 *   locations); the widget also derives edits from claude-named tool inputs.
 * - `onTopic` — protocols that report an evolving conversation topic (ACP
 *   `session_info_update.title`); shown as the sidebar subtitle, never persisted.
 *
 * (`getSubagent`/`getMonitor` are required but may always return undefined; the
 * subagent/monitor views only act on ids the session itself surfaced.)
 */
export interface ConversationSession {
  readonly status: AgentStatus;
  readonly permissionMode: AgentMode;
  readonly sessionId: string | null;

  /** Spawn/connect the agent process. Idempotent. */
  start(): void;
  /** Send a user turn (emits `user-message`, flips to `working`). */
  prompt(text: string): void;
  /** Interrupt the in-flight turn. Returns whether one was actually running. */
  interrupt(): boolean;
  /** Stop the agent process but keep the session object (status → `disconnected`). */
  stop(): void;
  /** Kill the process and tear down watchers/IPC. */
  dispose(): void;
  /** Change the permission mode mid-session (no-op when unsupported). */
  setPermissionMode(mode: AgentMode): void;
  /** Answer a pending permission request. */
  respondPermission(id: string, decision: PermissionDecision): void;

  /** A captured subagent transcript (for the subagent page), or undefined. A
   *  protocol without captured subagents always returns undefined. */
  getSubagent(id: string): SubagentInfo | undefined;
  /** A captured shell monitor (for the monitors panel/inspect page), or undefined. */
  getMonitor(id: string): MonitorInfo | undefined;
  /** Cancel a running background task (e.g. a shell monitor) by its task id. */
  stopTask(taskId: string): void;

  // --- optional capabilities --------------------------------------------------

  /** First-touch baseline: the file's content the first time this session
   *  edited it (`null` = didn't exist), or undefined for files it never
   *  touched / when the protocol can't capture one. Feeds the Agent Changes
   *  review diff (old side). */
  getBaseline?(path: string): string | null | undefined;
  /** Answer a question request (paired with `onQuestion`). */
  answerQuestion?(id: string, answers: Array<{ header: string; labels: string[]; notes?: string }>): void;

  // --- events -------------------------------------------------------------------
  onStatus(cb: () => void): Disposable;
  onMode(cb: () => void): Disposable;
  onUserMessage(cb: (m: { text: string }) => void): Disposable;
  onAssistantStart(cb: () => void): Disposable;
  onAssistantText(cb: (m: { delta: string }) => void): Disposable;
  onAssistantThinking(cb: (m: { delta: string }) => void): Disposable;
  onToolUse(cb: (m: { id: string; name: string; input: unknown }) => void): Disposable;
  onToolResult(cb: (m: { id: string; isError: boolean; text: string }) => void): Disposable;
  onResult(cb: (m: { costUsd?: number; contextWindow?: number }) => void): Disposable;
  onContext(cb: (m: ContextUsage) => void): Disposable;
  onInit(cb: (m: { model: string; slashCommands: string[] }) => void): Disposable;
  onError(cb: (m: { message: string; detail?: string }) => void): Disposable;
  onInterrupted(cb: () => void): Disposable;
  onUnhandled(cb: (m: { event: unknown }) => void): Disposable;
  onPermission(cb: (r: PermissionRequest) => void): Disposable;
  onActions(cb: (m: { actions: Action[] }) => void): Disposable;
  onCwd(cb: (m: { cwd: string }) => void): Disposable;
  onExit(cb: (m: { code: number | null; stderr: string }) => void): Disposable;
  onThinkingTokens(cb: (m: { tokens: number }) => void): Disposable;
  onTaskProgress(cb: (m: TaskProgress) => void): Disposable;
  onSubagentUpdate(cb: (m: { id: string }) => void): Disposable;
  onSubagentDone(cb: (m: { id: string }) => void): Disposable;
  onMonitorUpdate(cb: (m: { id: string }) => void): Disposable;

  /** The session's mode state when the agent advertises modes (ACP session
   *  modes: ask/architect/code, claude's default/acceptEdits/…), else null. The
   *  widget feeds its mode dropdown from this, falling back to the fixed
   *  claude cycle. `onMode` fires on any change (id or available set). */
  getModeState?(): { currentId: string; modes: Array<{ id: string; name: string }> } | null;
  /** Switch to an advertised mode by id (pairs with getModeState). */
  setModeById?(id: string): void;

  /** The session's generic config options (ACP `configOptions` — model / effort /
   *  … — the `mode` category excluded, since it rides `getModeState`), or null
   *  when the agent advertises none. The footer renders a control per option;
   *  `onConfigOptions` fires whenever the set or a current value changes. */
  getConfigOptions?(): ConfigOption[] | null;
  /** Change a config option (`select` → a value id, `boolean` → a flag). The agent
   *  echoes the full updated set, which re-fires `onConfigOptions`. */
  setConfigOption?(id: string, value: string | boolean): void;

  // --- optional events ----------------------------------------------------------
  onQuestion?(cb: (r: QuestionRequest) => void): Disposable;
  /** The agent reported its execution plan (full replace per update). */
  onPlan?(cb: (m: { entries: PlanEntry[] }) => void): Disposable;
  /** The agent edited a file at `path` (absolute). */
  onFileEdited?(cb: (m: { path: string }) => void): Disposable;
  /** The agent reported an evolving conversation *topic* (ACP
   *  `session_info_update.title`) — what it's currently about, not a stable name.
   *  The widget shows it as the sidebar-header subtitle (and seeds the name once
   *  from the first); never persisted. */
  onTopic?(cb: (m: { topic: string | null }) => void): Disposable;
  /** A resumed conversation's history is being replayed into the transcript
   *  (`active` true → rows render statically, edits seed silently; false →
   *  live again). Driven by ACP `session/load`. */
  onReplay?(cb: (m: { active: boolean }) => void): Disposable;
  /** The agent's generic config options changed — the set, or a current value
   *  (pairs with `getConfigOptions`). */
  onConfigOptions?(cb: () => void): Disposable;
}
