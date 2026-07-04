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
import { SESSION_VERSION, emptySessionState, type SessionState, type TabState, type ProjectState } from './SessionManager.ts';
import type { RestoredChild } from './ui/PanelGroup.ts';
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
  /** Build a file editor tab for restore (no panel attach); `null` to skip. The
   *  restore carries the saved cursor, scroll, and any cached unsaved content. */
  createEditorTab: (
    path: string,
    restore: { cursor?: [number, number]; scroll?: number; unsavedText?: string },
  ) => RestoredChild | null;
  /** Build a terminal tab for restore (no panel attach); `null` to skip. */
  createTerminalTab: (cwd: string) => RestoredChild | null;
  /** Snapshot every open project (its default workbench + the agents under it) for
   *  serialization; `projects[0]` is the primary. */
  serializeProjects: () => ProjectState[];
  /** The focused owner at save time — a project index, plus an agent index within it
   *  when an agent workbench is active. */
  getActive: () => SessionState['active'];
  /** Rebuild the whole window from a saved session — projects + their agents + docks +
   *  window + focus — using `buildChild` (this controller's per-tab deserialize, which
   *  carries the unsaved-buffer cache + missing-file tracking) for editor/terminal tabs.
   *  Owns activation order: a project must be active while its agents relaunch so they
   *  associate with it. */
  restoreSession: (state: SessionState, buildChild: (tab: TabState) => RestoredChild | null) => void;
  /** Current window-level dock state, for serialization. */
  getDocks: () => SessionDocks;
  /** Current window geometry, for serialization (omit if unavailable). */
  getWindow?: () => SessionState['window'];
  /** The unsaved contents of currently-modified editors, cached so a restore can
   *  bring the edits back. */
  collectUnsaved?: () => { path: string; text: string }[];
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
    // Maintain the cross-instance lock across the name change: release the outgoing
    // session (if we held it) and claim the incoming one, so a second window opening
    // the same name is warned before both autosave over each other (docs/session-management.md).
    const previous = this.currentName;
    if (previous !== null && previous !== name) zym.session.releaseLock(previous);
    this.currentName = name;
    if (name !== null) zym.session.acquireLock(name);
    this.opts.onNameChange?.(name);
  }

  /** Release the active session's cross-instance lock — called on window quit so the
   *  lock file is cleared promptly (a crash instead leaves a stale, dead-PID lock). */
  releaseLock(): void {
    if (this.currentName !== null) zym.session.releaseLock(this.currentName);
  }

  // --- Serialize -------------------------------------------------------------

  /** Snapshot the live window (all projects + their agents) as a session. */
  serialize(): SessionState {
    const projects = this.opts.serializeProjects();
    // Clamp a stale active reference to a project that actually exists.
    const active = this.opts.getActive();
    return {
      version: SESSION_VERSION,
      name: this.currentName ?? undefined,
      savedAt: '', // stamped by SessionManager.save
      projects,
      active: active.project >= 0 && active.project < projects.length ? active : { project: 0 },
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
   * Close the active session and reset the window to a fresh, unnamed slate rooted at
   * `root` (the launch dir). Same replace-semantics as `open()` — flush the outgoing
   * named session, tear down its agents + extra projects — but applies an empty
   * single-project layout instead of a saved one, so the window drops back to the
   * ephemeral default session. See docs/session-management.md "Commands".
   */
  closeToFresh(root: string): void {
    this.open(emptySessionState(root));
  }

  /**
   * Rebuild the live window from `state`, replacing the current projects/agents. The
   * per-project widget walk + activation is delegated to `restoreSession` (the host owns
   * the collaborators); this layer wraps it with the unsaved-buffer cache + missing-file
   * bookkeeping. Relaunch is fine because `open()` is explicit, not a surprise.
   */
  applyState(state: SessionState): void {
    this.missing = [];
    this.restoringState = state;
    this.opts.restoreSession(state, (tab) => this.deserialize(tab));
    this.restoringState = null;

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
