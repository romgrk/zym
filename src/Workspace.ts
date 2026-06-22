/*
 * Workspace — the app-wide entry point for opening files, exposed as
 * `zym.workspace`. The concrete implementation lives in AppWindow (it owns the
 * center panel tree); AppWindow installs it via `setOpener` on construction. This
 * indirection lets any component (lists, panels, future plugins) open a file
 * without threading an `onOpenFile` callback through its constructor.
 *
 * The opener reveals an already-open editor for the path instead of opening a
 * duplicate tab — so "don't re-open what's already open" is the default behaviour
 * everywhere files are opened, not a per-call concern.
 */

import { Disposable, type DisposableLike } from './util/eventKit.ts';
import type { TextEditor } from './ui/TextEditor/index.ts';
import type { TabState } from './SessionManager.ts';
import { zym } from './zym.ts';

export interface OpenFileOptions {
  /** Place the cursor at this `[row, column]` after opening/revealing. */
  cursor?: [number, number];
}

type Opener = (path: string, options?: OpenFileOptions) => void;
type ActiveEditorProvider = () => TextEditor | null;
/** Rebuild a closed tab from its serialized state; returns whether it reopened (a
 *  file whose path no longer exists can't, so the stack moves on to the next entry). */
type TabReopener = (state: TabState) => boolean;

/** A subscriber registered through `observeTextEditors`, plus the per-editor
 *  Disposables its callback returned (torn down on editor close / unobserve). */
interface EditorObserver {
  callback: (editor: TextEditor) => DisposableLike | void;
  perEditor: Map<TextEditor, DisposableLike | null>;
}

/** How many recently-closed tabs to remember for `reopenLastTab`. */
const CLOSED_TAB_HISTORY_LIMIT = 10;

export class Workspace {
  private opener: Opener | null = null;
  private activeEditorProvider: ActiveEditorProvider | null = null;
  private tabReopener: TabReopener | null = null;
  private readonly editors = new Set<TextEditor>();
  private readonly observers = new Set<EditorObserver>();
  // Recently-closed tabs, most-recent last — the reopen stack for `reopenLastTab`.
  // In-memory and per-window; cross-restart restoration is the session's job.
  private readonly closedTabs: TabState[] = [];

  /** Wire the concrete file opener (the AppWindow does this on construction). */
  setOpener(opener: Opener): void {
    this.opener = opener;
  }

  /** Wire the closed-tab rebuilder — like `setOpener`, the concrete reopen lives in the
   *  AppWindow (it owns the panel tree); the history stack lives here. */
  setTabReopener(reopener: TabReopener): void {
    this.tabReopener = reopener;
  }

  // --- closed-tab history ----------------------------------------------------

  /** Record a just-closed tab's restorable state (the host serializes it at close
   *  time). Trims to `CLOSED_TAB_HISTORY_LIMIT` so the stack can't grow unbounded. */
  recordClosedTab(state: TabState): void {
    this.closedTabs.push(state);
    if (this.closedTabs.length > CLOSED_TAB_HISTORY_LIMIT) this.closedTabs.shift();
  }

  /** Reopen the most recently closed tab, skipping entries that can no longer be
   *  rebuilt (e.g. a file deleted in the meantime). Notifies — rather than failing
   *  silently — when the stack is empty or nothing could be reopened. */
  reopenLastTab(): void {
    if (this.tabReopener) {
      while (this.closedTabs.length > 0) {
        const state = this.closedTabs.pop()!;
        if (this.tabReopener(state)) return;
      }
    }
    zym.notifications.addInfo('No recently closed tab to reopen');
  }

  /** Wire the active-editor provider — which editor currently has focus depends on the
   *  panel/focus tree the AppWindow owns, so it injects this (like `setOpener`). */
  setActiveEditorProvider(provider: ActiveEditorProvider): void {
    this.activeEditorProvider = provider;
  }

  /** The text editor with focus, or null (nothing focused, or before the AppWindow has
   *  wired the provider). The app-wide counterpart to AppWindow's private `activeEditor`. */
  getActiveTextEditor(): TextEditor | null {
    return this.activeEditorProvider?.() ?? null;
  }

  // --- text-editor registry --------------------------------------------------

  /**
   * Register a newly-created editor: notify every observer, and return a
   * Disposable that deregisters it (the host calls this when the tab closes). The
   * counterpart to `observeTextEditors`; the AppWindow wires both ends.
   */
  addTextEditor(editor: TextEditor): Disposable {
    this.editors.add(editor);
    for (const observer of this.observers) this.invoke(observer, editor);
    return new Disposable(() => this.removeTextEditor(editor));
  }

  /**
   * Observe text editors: `callback` runs for every editor already open and each
   * one opened later. A Disposable it returns is torn down when that editor
   * closes or this observation is disposed (e.g. a plugin deactivating). Atom's
   * `observeTextEditors` shape — the seam decoration plugins (color preview, and
   * later error lens / code lens) plug into.
   */
  observeTextEditors(callback: (editor: TextEditor) => DisposableLike | void): Disposable {
    const observer: EditorObserver = { callback, perEditor: new Map() };
    this.observers.add(observer);
    for (const editor of this.editors) this.invoke(observer, editor);
    return new Disposable(() => {
      this.observers.delete(observer);
      for (const sub of observer.perEditor.values()) sub?.dispose();
      observer.perEditor.clear();
    });
  }

  private removeTextEditor(editor: TextEditor): void {
    if (!this.editors.delete(editor)) return;
    for (const observer of this.observers) {
      observer.perEditor.get(editor)?.dispose();
      observer.perEditor.delete(editor);
    }
  }

  /** Run one observer's callback for one editor, isolating a thrown callback so a
   *  buggy plugin can't break editor creation. */
  private invoke(observer: EditorObserver, editor: TextEditor): void {
    try {
      observer.perEditor.set(editor, observer.callback(editor) ?? null);
    } catch (error) {
      console.error('observeTextEditors callback failed:', error);
      observer.perEditor.set(editor, null);
    }
  }

  /**
   * Open `path`, revealing an already-open tab instead of duplicating it. No-op
   * (with a warning) until the AppWindow has registered its opener.
   */
  openFile(path: string, options?: OpenFileOptions): void {
    if (!this.opener) {
      console.warn('zym.workspace.openFile called before an opener was registered');
      return;
    }
    this.opener(path, options);
  }
}
