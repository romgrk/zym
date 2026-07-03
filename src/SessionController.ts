/*
 * SessionController — drives session save/restore/autosave for one window.
 *
 * It owns the *policy* (when to save, how to rebuild a workspace, debounced
 * autosave, the launch-restore decision) while leaving the *widget construction*
 * to the host (AppWindow) via the `createEditorTab` / `createTerminalTab`
 * callbacks. That split keeps all GTK widget wiring in AppWindow and all the
 * session bookkeeping here, so the contended window class stays thin.
 *
 * Storage and format live in `zym.session` (SessionManager); this is the layer
 * that walks the live workbench into a `SessionState` and back. Agents are
 * recorded but not relaunched on restore (an opt-in relaunch is a later phase);
 * files whose path no longer exists are skipped and surfaced as one notification.
 */
import * as Fs from 'node:fs';
import { zym } from './zym.ts';
import { SESSION_VERSION, type SessionState, type TabState, type WorkspaceState } from './SessionManager.ts';
import type { Action } from './actions.ts';
import type { PanelGroup, RestoredChild } from './ui/PanelGroup.ts';
import type { FileTree } from './ui/FileTree.ts';
import type { DockSide } from './ui/workbench/Workbench.ts';

export interface SessionDocks {
  notificationLog: boolean;
  // Per-side dock visibility (the dock-visibility toggle). Absent in sessions saved
  // before this existed, so restore treats a missing entry as "shown".
  visible?: Record<DockSide, boolean>;
  // Per-side resized extent (width for left/right, height for top/bottom) so a dragged
  // Gtk.Paned handle is restored. Absent sides fall back to their default size.
  sizes?: Partial<Record<DockSide, number>>;
}

export interface SessionControllerOptions {
  /** The workspace root this session belongs to (the window cwd). */
  root: string;
  center: PanelGroup;
  fileTree: FileTree;
  /** Serialize one tab's widget to its persistent state (`null` to skip). */
  serializeChild: Parameters<PanelGroup['serializeLayout']>[0];
  /** Build a file editor tab for restore (no panel attach); `null` to skip. The
   *  restore carries the saved cursor, scroll, and any cached unsaved content. */
  createEditorTab: (
    path: string,
    restore: { cursor?: [number, number]; scroll?: number; unsavedText?: string },
  ) => RestoredChild | null;
  /** Build a terminal tab for restore (no panel attach); `null` to skip. */
  createTerminalTab: (cwd: string) => RestoredChild | null;
  /** Current window-level dock state, for serialization. */
  getDocks: () => SessionDocks;
  /** Apply restored window-level dock state. */
  applyDocks: (docks: SessionDocks) => void;
  /** Current window geometry, for serialization (omit if unavailable). */
  getWindow?: () => SessionState['window'];
  /** Apply restored window geometry. */
  applyWindow?: (window: NonNullable<SessionState['window']>) => void;
  /** The unsaved contents of currently-modified editors, cached so a restore can
   *  bring the edits back. */
  collectUnsaved?: () => { path: string; text: string }[];
  /** The user workbench's live action set (docs/workbench.md), for
   *  serialization; an empty set is omitted from the saved workspace. */
  serializeUserActions?: () => Action[];
  /** Apply a restored action set to the user workbench. */
  restoreUserActions?: (actions: Action[]) => void;
  /** One `WorkspaceState` per open agent workbench (root + layout + `agent`
   *  identity), appended after the user workspace. Empty when no agents. */
  serializeAgentWorkspaces?: () => WorkspaceState[];
  /** Relaunch an agent workbench (resumed) from its saved workspace; returns a handle
   *  (the relaunched agent) so `activateWorkspace` can focus it, or null on failure. */
  restoreAgent?: (workspace: WorkspaceState) => unknown;
  /** Index into the serialized workspaces of the workbench that currently has focus
   *  (0 = the user workspace, n = the nth agent workspace). Used for serialization. */
  getActiveWorkspace?: () => number;
  /** Focus the restored active workspace after a restore. `index` is the saved
   *  `activeWorkspace`; `restored[i]` is the handle `restoreAgent` returned for
   *  workspace `i + 1` (null when it couldn't relaunch). */
  activateWorkspace?: (index: number, restored: unknown[]) => void;
  /** Close every open agent — the replace-semantics teardown `open()` runs before
   *  applying a different session (docs/session-management.md). */
  closeAllAgents?: () => void;
  /** Notified whenever the active session name changes (save-as / open / rename /
   *  forget) so the host can refresh the window title + sidebar header. */
  onNameChange?: (name: string | null) => void;
}

export class SessionController {
  private readonly opts: SessionControllerOptions;
  private autosaveTimer: NodeJS.Timeout | null = null;
  // Files skipped during the in-flight restore (no longer on disk), aggregated
  // into a single notification at the end.
  private missing: string[] = [];
  // The session being restored, so `deserialize` can read cached unsaved buffers.
  private restoringState: SessionState | null = null;
  // The active session's name, or null for the ephemeral default session. This is
  // the persistence gate: while null, autosave/flush/save all no-op and nothing
  // ever reaches disk (docs/session-management.md "Session identity").
  private currentName: string | null = null;

  constructor(opts: SessionControllerOptions) {
    this.opts = opts;
  }

  /** The active session's name, or null for the unnamed/default (ephemeral) session. */
  get sessionName(): string | null {
    return this.currentName;
  }

  private setName(name: string | null): void {
    this.currentName = name;
    this.opts.onNameChange?.(name);
  }

  // --- Serialize -------------------------------------------------------------

  /** Snapshot the live workbench as a session for this root. */
  serialize(): SessionState {
    const user: WorkspaceState = {
      root: this.opts.root,
      layout: this.opts.center.serializeLayout(this.opts.serializeChild),
      fileTree: { expanded: this.opts.fileTree.serializeExpanded() },
    };
    const userActions = this.opts.serializeUserActions?.();
    if (userActions && userActions.length > 0) user.actions = userActions;
    // The user workspace is primary (index 0); each open agent workbench follows.
    const workspaces = [user, ...(this.opts.serializeAgentWorkspaces?.() ?? [])];
    // The focused workbench is restored as the active one; clamp a stale index to a
    // workspace that actually exists.
    const active = this.opts.getActiveWorkspace?.() ?? 0;
    return {
      version: SESSION_VERSION,
      name: this.currentName ?? undefined,
      savedAt: '', // stamped by SessionManager.save
      workspaces,
      activeWorkspace: active >= 0 && active < workspaces.length ? active : 0,
      docks: this.opts.getDocks(),
      window: this.opts.getWindow?.(),
    };
  }

  /** Persist the current session now (best effort; never throws to the caller).
   *  Also caches the unsaved contents of modified editors beside the session.
   *  **No-op for the unnamed/default session** — only a named session persists. */
  saveNow(): void {
    if (this.currentName === null) return; // ephemeral default session — never persists
    try {
      const state = this.serialize();
      zym.session.save(state);
      zym.session.writeBuffers(state, this.opts.collectUnsaved?.() ?? []);
    } catch (error) {
      console.warn(`[session] save failed: ${(error as Error).message}`);
    }
  }

  // --- Autosave --------------------------------------------------------------

  /** Schedule a debounced autosave, if named and `session.autosave` is enabled. */
  scheduleAutosave(): void {
    if (this.currentName === null) return; // nothing to autosave for the default session
    if (zym.config.get('session.autosave') !== true) return;
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    const ms = Math.max(0, Number(zym.config.get('session.autosaveDebounceMs') ?? 1000));
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      this.saveNow();
    }, ms);
  }

  /** Cancel any pending autosave and flush once on quit (named + autosave on). */
  flush(): void {
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    if (this.currentName !== null && zym.config.get('session.autosave') === true) this.saveNow();
  }

  // --- Naming (save-as / rename / forget) ------------------------------------

  /** Promote the current (usually unnamed) session to a named one and persist it.
   *  Also forks a named session under a new name. */
  saveAs(name: string): void {
    this.setName(name);
    this.saveNow();
  }

  /** Rename the active named session (moves its json + buffer cache). No-op on the
   *  unnamed session — the host offers save-as there instead. */
  renameTo(newName: string): void {
    if (this.currentName === null) return;
    this.saveNow(); // flush the latest state into the old-name file first
    const state = zym.session.loadByName(this.currentName);
    if (state) zym.session.rename(state, newName);
    this.setName(newName);
  }

  /** Detach from the active name without deleting anything — the session becomes the
   *  ephemeral default again (e.g. after the active session is forgotten). */
  becomeUnnamed(): void {
    this.setName(null);
  }

  // --- Open / apply ----------------------------------------------------------

  /**
   * Switch this window into `state` (a named session from the picker). Replace
   * semantics: flush the current named session, tear down its agents, apply the
   * target layout/agents/docks/window, and adopt its name.
   */
  open(state: SessionState): void {
    this.flush(); // persist the outgoing named session (no-op if unnamed)
    this.opts.closeAllAgents?.(); // replace semantics — the old session's agents go
    this.applyState(state);
    this.setName(state.name ?? null);
  }

  /**
   * Rebuild the live workbench from `state`, replacing the current layout. Missing
   * files are skipped and reported; agent workspaces are relaunched (resumed).
   * Relaunch is fine because `open()` is explicit, not a surprise.
   */
  applyState(state: SessionState): void {
    // workspaces[0] is the primary (user) root; the rest are agent workbenches.
    const user = state.workspaces[0];
    if (!user) return;

    this.missing = [];
    this.restoringState = state;
    this.opts.center.restoreLayout(user.layout, (tab) => this.deserialize(tab));
    if (user.fileTree) this.opts.fileTree.restoreExpanded(user.fileTree.expanded);
    if (user.actions) this.opts.restoreUserActions?.(user.actions);
    if (state.docks) this.opts.applyDocks(state.docks);
    if (state.window) this.opts.applyWindow?.(state.window);

    // Relaunch the agent workbenches (resumed to their conversation/worktree). The
    // returned handles are aligned with `workspaces[1..]` so `activateWorkspace` can
    // focus the one that had focus.
    const restored: unknown[] = [];
    for (const ws of state.workspaces.slice(1)) {
      restored.push(ws.agent ? this.opts.restoreAgent?.(ws) ?? null : null);
    }
    this.restoringState = null;

    // Re-focus the workbench that was active when the session was saved (the user
    // workspace, or one of the relaunched agents).
    this.opts.activateWorkspace?.(state.activeWorkspace, restored);

    if (this.missing.length > 0) {
      const n = this.missing.length;
      zym.notifications.addWarning(`${n} file${n === 1 ? '' : 's'} could not be reopened`, {
        detail: 'They no longer exist on disk and were skipped while restoring the session.',
      });
    }
  }

  // Rebuild one tab during restore. Files that vanished are skipped (and counted) and
  // a dirty file's unsaved edits are pulled from the buffer cache; the per-kind
  // reconstruction itself is shared with `tab:reopen-last` (see deserializeTab).
  private deserialize(tab: TabState): RestoredChild | null {
    return deserializeTab(tab, this.opts, {
      onMissingFile: (path) => this.missing.push(path),
      unsavedText: (path) =>
        this.restoringState ? zym.session.readBuffer(this.restoringState, path) ?? undefined : undefined,
    });
  }
}

/** Builders that turn a tab's persistent state back into a (detached) tab widget. */
export interface TabBuilders {
  createEditorTab: (
    path: string,
    restore: { cursor?: [number, number]; scroll?: number; unsavedText?: string },
  ) => RestoredChild | null;
  createTerminalTab: (cwd: string) => RestoredChild | null;
}

/**
 * Rebuild one tab from its persistent state into a *detached* `RestoredChild` (the
 * caller places it — a restored split-tree leaf, or the active pane for
 * `tab:reopen-last`). Returns null for a tab that can't be rebuilt: a file whose path
 * no longer exists (reported via `onMissingFile` so restore can count it and reopen
 * can skip to the next entry), or an agent (never rebuilt through this path).
 *
 * The restore-only concerns are hooks: `unsavedText` supplies a dirty file's cached
 * edits (reopen has none, since the cache is only written on session save).
 */
export function deserializeTab(
  tab: TabState,
  builders: TabBuilders,
  hooks: { onMissingFile?: (path: string) => void; unsavedText?: (path: string) => string | undefined } = {},
): RestoredChild | null {
  switch (tab.kind) {
    case 'file': {
      if (!Fs.existsSync(tab.path)) {
        hooks.onMissingFile?.(tab.path);
        return null;
      }
      const unsavedText = tab.dirty ? hooks.unsavedText?.(tab.path) : undefined;
      return builders.createEditorTab(tab.path, { cursor: tab.cursor, scroll: tab.scroll, unsavedText });
    }
    case 'terminal':
      return builders.createTerminalTab(tab.cwd);
    case 'agent':
      return null;
  }
}
