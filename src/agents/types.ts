/*
 * agents/types.ts — the tool-agnostic vocabulary shared by every agent
 * implementation (the `claude-tui` terminal host and the `claude-sdk` headless
 * one), so `AgentTerminal`, the registry, sidebar, and picker never depend on a
 * specific tool.
 *
 * A concrete implementation (e.g. `claude-tui`'s `ClaudeSession`) is an
 * `AgentDriver`: it augments the argv to spawn and, once `watch`n, reports live
 * state back through an `AgentHost`. The terminal host is the `AgentHost`; it
 * exposes only `status` / `changedFiles` / etc. upward, never the driver.
 */

/** Live status of an agent session. */
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'exited';

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

import { Gtk } from '../gi.ts';
import type { TabState } from '../SessionManager.ts';
import type { WorktreeInfo } from '../git.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

/**
 * The host-facing surface every agent implementation exposes, so the registry
 * (`quilx.agents`), the workbench owner machinery, the sidebar (`WorkbenchList`),
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
  readonly title: string;
  readonly status: AgentStatus;
  readonly permissionMode: AgentMode;
  readonly changedFiles: string[];
  readonly worktree: WorktreeInfo | null;
  readonly effectiveCwd: string;
  readonly sessionId: string | null;
  readonly renamed: boolean;
  readonly exited: boolean;
  readonly needsAttention: boolean;
  readonly unannouncedWorktree: string | null;

  onTitleChange(callback: () => void): () => void;
  onDidChangeStatus(callback: () => void): () => void;
  onDidChangePermissionMode(callback: () => void): () => void;
  onDidChangeFiles(callback: () => void): () => void;
  onDidChangeWorktree(callback: () => void): () => void;
  onDidChangeAttention(callback: () => void): () => void;

  /** Spawn/begin the agent after it has been mounted. A host that spawns in its
   *  constructor (the terminal) implements this as a no-op; one that defers
   *  spawning until mounted (the headless sdk) starts here. */
  start(): void;
  setViewed(viewed: boolean): void;
  clearUnannouncedWorktree(): void;
  rename(name: string): void;
  /** Restart an exited agent in place (no-op while running / unsupported). */
  resume(): void;
  /** Stop the agent's process (keeps the widget listed as `exited`). */
  kill(): void;
  focus(): void;
  /** Push editor context (a selection / file path) into the agent's input. */
  deliver(text: string): void;
  serialize(): TabState | null;
  isModified(): boolean;
  getModifiedLabel(): string;
}
