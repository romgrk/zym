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
import type { PanelGroup, RestoredChild } from './ui/PanelGroup.ts';
import type { FileTree } from './ui/FileTree.ts';
import type { DockSide } from './ui/Workbench.ts';

export interface SessionDocks {
  notificationLog: boolean;
  leftSplit?: number;
  // Per-side dock visibility (the dock-visibility toggle). Absent in sessions saved
  // before this existed, so restore treats a missing entry as "shown".
  visible?: Record<DockSide, boolean>;
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
  /** One `WorkspaceState` per open agent workbench (root + layout + `agent`
   *  identity), appended after the user workspace. Empty when no agents. */
  serializeAgentWorkspaces?: () => WorkspaceState[];
  /** Relaunch an agent workbench (resumed) from its saved workspace. */
  restoreAgent?: (workspace: WorkspaceState) => void;
}

export class SessionController {
  private readonly opts: SessionControllerOptions;
  private autosaveTimer: NodeJS.Timeout | null = null;
  // Files skipped during the in-flight restore (no longer on disk), aggregated
  // into a single notification at the end.
  private missing: string[] = [];
  // The session being restored, so `deserialize` can read cached unsaved buffers.
  private restoringState: SessionState | null = null;

  constructor(opts: SessionControllerOptions) {
    this.opts = opts;
  }

  // --- Serialize -------------------------------------------------------------

  /** Snapshot the live workbench as a session for this root. */
  serialize(): SessionState {
    const user: WorkspaceState = {
      root: this.opts.root,
      layout: this.opts.center.serializeLayout(this.opts.serializeChild),
      fileTree: { expanded: this.opts.fileTree.serializeExpanded() },
    };
    // The user workspace is primary (index 0); each open agent workbench follows.
    return {
      version: SESSION_VERSION,
      savedAt: '', // stamped by SessionManager.save
      workspaces: [user, ...(this.opts.serializeAgentWorkspaces?.() ?? [])],
      activeWorkspace: 0,
      docks: this.opts.getDocks(),
      window: this.opts.getWindow?.(),
    };
  }

  /** Persist the current session now (best effort; never throws to the caller).
   *  Also caches the unsaved contents of modified editors beside the session. */
  saveNow(): void {
    try {
      const state = this.serialize();
      zym.session.save(state);
      zym.session.writeBuffers(state, this.opts.collectUnsaved?.() ?? []);
    } catch (error) {
      console.warn(`[session] save failed: ${(error as Error).message}`);
    }
  }

  // --- Autosave --------------------------------------------------------------

  /** Schedule a debounced autosave, if `session.autosave` is enabled. */
  scheduleAutosave(): void {
    if (zym.config.get('session.autosave') !== true) return;
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    const ms = Math.max(0, Number(zym.config.get('session.autosaveDebounceMs') ?? 1000));
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      this.saveNow();
    }, ms);
  }

  /** Cancel any pending autosave and flush once on quit (if autosave is on). */
  flush(): void {
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    if (zym.config.get('session.autosave') === true) this.saveNow();
  }

  // --- Restore ---------------------------------------------------------------

  /**
   * Restore the saved session for this root into the workbench, replacing the
   * current layout. Returns false if there is no saved session. Missing files
   * are skipped and reported; agents are recorded-only (not relaunched yet).
   */
  restore(): boolean {
    const state = zym.session.load(this.opts.root);
    if (!state) return false;
    // workspaces[0] is the primary (user) root; the rest are agent workbenches.
    const user = state.workspaces[0];
    if (!user) return false;

    this.missing = [];
    this.restoringState = state;
    this.opts.center.restoreLayout(user.layout, (tab) => this.deserialize(tab));
    if (user.fileTree) this.opts.fileTree.restoreExpanded(user.fileTree.expanded);
    if (state.docks) this.opts.applyDocks(state.docks);
    if (state.window) this.opts.applyWindow?.(state.window);

    // Relaunch the agent workbenches (resumed to their conversation/worktree). This
    // only runs on an explicit restore / opt-in launch, so re-running them is the
    // user's intent, not a surprise.
    for (const ws of state.workspaces.slice(1)) {
      if (ws.agent) this.opts.restoreAgent?.(ws);
    }
    this.restoringState = null;

    if (this.missing.length > 0) {
      const n = this.missing.length;
      zym.notifications.addWarning(`${n} file${n === 1 ? '' : 's'} could not be reopened`, {
        detail: 'They no longer exist on disk and were skipped while restoring the session.',
      });
    }
    return true;
  }

  /** Should a bare launch (no explicit file arg) restore a saved session? */
  shouldRestoreOnLaunch(): boolean {
    return zym.config.get('session.restoreOnLaunch') === true && zym.session.load(this.opts.root) !== null;
  }

  /** The saved window geometry for this root, without a full restore — so the host
   *  can size the window before mapping it (GTK4 ignores resize once shown). */
  loadWindow(): SessionState['window'] {
    return zym.session.load(this.opts.root)?.window;
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
