/*
 * agents/session.ts — the tool-agnostic conversation-session vocabulary: the
 * domain types and the `ConversationSession` interface that `AgentConversation`
 * (the native transcript UI) consumes. `claude-sdk`'s `SdkSession` is the
 * reference implementation; `acp`'s `AcpSession` (the Agent Client Protocol
 * kind) is the second. The UI holds a `ConversationSession`, never a concrete
 * class, so a new agent protocol only has to map its wire events onto this
 * surface.
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

/** One entry of the agent's reported execution plan (ACP `plan`; rendered into the
 *  same sticky panel the claude Task tools drive). */
export interface PlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * The session surface `AgentConversation` (and its child views) consume. The
 * required core is what every protocol can provide; the optional members are
 * per-protocol capabilities:
 *
 * - `onQuestion`/`answerQuestion` — claude's interactive `AskUserQuestion`.
 * - `onPlan` — ACP's execution plan (full replace per update).
 * - `onFileEdited` — protocols that report edited paths directly (ACP tool-call
 *   locations); claude-sdk edits are derived from tool inputs by the widget.
 * - `onSessionName` — protocols that carry a session title (ACP
 *   `session_info_update`); never persisted by the widget.
 *
 * (`getSubagent`/`getMonitor` are required but may always return undefined; the
 * subagent/monitor views only act on ids the session itself surfaced. A resumed
 * transcript is rebuilt by the claude-sdk kind via its own `replay` — that stays
 * off this interface because its entry type is claude-transcript-shaped.)
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
  /** Answer an `AskUserQuestion` request (claude-sdk; paired with `onQuestion`). */
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

  // --- optional events ----------------------------------------------------------
  onQuestion?(cb: (r: QuestionRequest) => void): Disposable;
  /** The agent reported its execution plan (full replace per update). */
  onPlan?(cb: (m: { entries: PlanEntry[] }) => void): Disposable;
  /** The agent edited a file at `path` (absolute). */
  onFileEdited?(cb: (m: { path: string }) => void): Disposable;
  /** The agent reported a session title (shown, never persisted by the widget). */
  onSessionName?(cb: (m: { name: string | null }) => void): Disposable;
}
