/*
 * agents/types.ts — the tool-agnostic vocabulary shared by every agent
 * implementation (the `claude-tui` terminal host and the `acp` conversation
 * host), so `AgentTerminal`, the registry, sidebar, and picker never depend on
 * a specific tool.
 *
 * A concrete implementation (e.g. `claude-tui`'s `ClaudeSession`) is an
 * `AgentDriver`: it augments the argv to spawn and, once `watch`n, reports live
 * state back through an `AgentHost`. The terminal host is the `AgentHost`; it
 * exposes only `status` / `changedFiles` / etc. upward, never the driver.
 */

/** Live status of an agent session. */
// `disconnected`: the agent's process isn't running — it either exited, or was
// resumed but not yet reconnected; the next user turn (re)spawns it. The single
// "not running" state (it replaced the former separate `exited`). See AgentConversation.
// `error`: error-colored; POC-only for now — no production path emits it yet.
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'disconnected' | 'error';

/** An agent's permission mode (Claude's `shift-tab` cycle; other tools may map a
 *  subset). `default` asks; the rest auto-allow to varying degrees, `plan` only
 *  plans. Tool-agnostic in shape, claude-flavoured in its values for now. */
export type AgentMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions';

/** The `AgentMode` values, as a runtime guard for mode strings reported by an
 *  agent (claude's `permissionMode`, an ACP session mode id). */
export const AGENT_MODES: ReadonlySet<AgentMode> = new Set<AgentMode>([
  'default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions',
]);

/** Resume a past conversation rather than starting fresh. */
export interface AgentResume {
  /** Resume a specific session id. */
  sessionId?: string;
  /** Continue the most recent conversation in the cwd. */
  continue?: boolean;
  /** Branch a copy instead of appending to the original. */
  fork?: boolean;
}

/** Callbacks a driver pushes live state through as its session progresses. The
 *  terminal/UI host implements this; the driver never touches the host's UI. */
export interface AgentHost {
  /** The spawned child's pid, or null before it has spawned. */
  getPid(): number | null;
  /** A new session status was reported. */
  onStatus(status: AgentStatus): void;
  /** The permission mode changed. */
  onMode(mode: AgentMode): void;
  /** The edited-files list grew (deduped, launch order). Absolute paths. */
  onChangedFiles(files: string[]): void;
  /** The session name changed (e.g. `/rename` / auto-summary), or null when cleared. */
  onSessionName(name: string | null): void;
  /** The agent moved into a different git worktree. Absolute path. */
  onCwd(cwd: string): void;
  /** A worktree the agent created but may not have announced (used to warn). Absolute path. */
  onWorktreeCreated(path: string): void;
  /** The agent's registered runnable actions changed (the full set, possibly empty). */
  onActions(actions: Action[]): void;
}

/** A concrete agent integration: it owns the real argv to spawn and reports live
 *  state to an `AgentHost`. `null`-returning factories let a host run a command
 *  plain (no integration). */
export interface AgentDriver {
  /** The argv to actually spawn (the base argv, possibly augmented). */
  readonly command: string[];
  /** The provider's session id once known (null until then). */
  readonly sessionId: string | null;
  /** Start reporting live state to `host`. */
  watch(host: AgentHost): void;
  /** Tear down watchers / IPC. Called when the agent process exits. */
  dispose(): void;
}

/** Builds an `AgentDriver` for a base command, or returns null when the command
 *  has no integration for this factory (then the host runs it plain). */
export type AgentDriverFactory = (baseCommand: string[], resume?: AgentResume) => AgentDriver | null;

// --- Agent (the workbench/sidebar-facing surface) ----------------------------

import type Gtk from 'gi:Gtk-4.0'; // type-positions only — keeps this module runtime-pure (importable off-app, e.g. tests)
import type { TabState } from '../SessionManager.ts';
import type { Action } from '../actions.ts';
import type { WorkbenchActions } from '../ui/workbench/WorkbenchActions.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

/**
 * The host-facing surface every agent implementation exposes, so the registry
 * (`zym.agents`), the workbench owner machinery, the sidebar (`WorkbenchList`),
 * and the picker stay tool-agnostic — they hold `Agent`, never a concrete class.
 * Both the terminal `AgentTerminal` and the headless `AgentConversation` implement it.
 *
 * `root` is the widget pinned as the agent's center tab. The rest mirrors the
 * status / attention / changed-files / worktree / lifecycle surface the chrome
 * reads. Implementations that don't (yet) support a capability return a benign
 * default (e.g. a headless agent with no live worktree returns its launch cwd).
 */
export interface Agent {
  readonly root: Widget;
  /** Optional per-agent widgets the agent sidebar packs into its header bar (e.g. the
   *  conversation host's subagent/monitor count buttons). Stable instances; omitted by agents
   *  (like the terminal) that contribute none. */
  readonly headerWidgets?: Widget[];
  readonly title: string;
  readonly status: AgentStatus;
  readonly permissionMode: AgentMode;
  readonly changedFiles: string[];
  readonly sessionId: string | null;
  readonly renamed: boolean;
  readonly exited: boolean;
  readonly needsAttention: boolean;
  readonly unannouncedWorktree: string | null;

  onTitleChange(callback: () => void): () => void;
  onDidChangeStatus(callback: () => void): () => void;
  onDidChangePermissionMode(callback: () => void): () => void;
  onDidChangeFiles(callback: () => void): () => void;
  /** The agent announced (via set_worktree) that it moved into `cwd` — the host re-roots
   *  the agent's workbench there (workbench.cwd is the single source of truth for the
   *  editor root; the agent no longer stores it). */
  onDidChangeWorktree(callback: (cwd: string) => void): () => void;
  onDidChangeAttention(callback: () => void): () => void;

  /** Spawn/begin the agent after it has been mounted. A host that spawns in its
   *  constructor (the terminal) implements this as a no-op; one that defers
   *  spawning until mounted (the headless sdk) starts here. */
  start(): void;
  setViewed(viewed: boolean): void;
  clearUnannouncedWorktree(): void;
  rename(name: string): void;
  /** Bind the agent to its workbench's action set: from here the agent pipes its
   *  reported `set_actions` straight into the workbench (which owns the runnable set
   *  — running, the header-bar buttons, and `space x` all go through `WorkbenchActions`).
   *  The agent keeps no action state of its own. AppWindow calls this once the
   *  workbench exists. */
  bindActions(controller: WorkbenchActions): void;
  /** Restart an exited agent in place (no-op while running / unsupported). */
  resume(): void;
  /** Stop the agent's process (keeps the widget listed as `exited`). */
  kill(): void;
  focus(): void;
  /** Push editor context (a selection / file path) into the agent's input. With
   *  `submit`, send it as a turn immediately (TUI: assumes Enter submits) instead
   *  of leaving it in the prompt for the user to edit + submit. `focus` (default
   *  true) moves keyboard focus into the agent's input; pass false to deliver in
   *  the background (e.g. a diff comment) and leave the cursor where it is. */
  deliver(text: string, options?: { submit?: boolean; focus?: boolean }): void;
  serialize(): TabState | null;
  isModified(): boolean;
  getModifiedLabel(): string;
}
