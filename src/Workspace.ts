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
import type { Gtk } from './gi.ts';
import type { TextEditor } from './ui/TextEditor/index.ts';
import type { Workbench } from './ui/Workbench.ts';

export interface OpenFileOptions {
  /** Place the cursor at this `[row, column]` after opening/revealing. */
  cursor?: [number, number];
}

export interface OpenTabOptions {
  /** Tab title (may include a leading icon glyph). */
  title: string;
  /** Keep the tab bar visible even as a lone tab. */
  requireTabBar?: boolean;
  /** Run when the tab is closed — e.g. dispose the hosted view. */
  onClose?: () => void;
}

type Widget = InstanceType<typeof Gtk.Widget>;
type Opener = (path: string, options?: OpenFileOptions) => void;
type ActiveEditorProvider = () => TextEditor | null;
type ActiveWorkbenchProvider = () => Workbench | null;
/** Hosts a widget as a center tab — selected, focused, torn down on close (AppWindow owns the tree). */
type TabHost = (widget: Widget, options: OpenTabOptions) => void;

/** A subscriber registered through `observeTextEditors`, plus the per-editor
 *  Disposables its callback returned (torn down on editor close / unobserve). */
interface EditorObserver {
  callback: (editor: TextEditor) => DisposableLike | void;
  perEditor: Map<TextEditor, DisposableLike | null>;
}

export class Workspace {
  private opener: Opener | null = null;
  private activeEditorProvider: ActiveEditorProvider | null = null;
  private activeWorkbenchProvider: ActiveWorkbenchProvider | null = null;
  private tabHost: TabHost | null = null;
  private readonly editors = new Set<TextEditor>();
  private readonly observers = new Set<EditorObserver>();

  /** Wire the concrete file opener (the AppWindow does this on construction). */
  setOpener(opener: Opener): void {
    this.opener = opener;
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

  /** Wire the active-workbench provider (the AppWindow injects this, like `setOpener`). */
  setActiveWorkbenchProvider(provider: ActiveWorkbenchProvider): void {
    this.activeWorkbenchProvider = provider;
  }

  /** The active workbench, or null before the AppWindow has wired the provider. Lets
   *  app-wide components read its cwd / git without threading it through call sites. */
  getActiveWorkbench(): Workbench | null {
    return this.activeWorkbenchProvider?.() ?? null;
  }

  /** Wire the center-tab host (the AppWindow injects this, like `setOpener`). */
  setTabHost(host: TabHost): void {
    this.tabHost = host;
  }

  /** Open `widget` as a center tab — selected, focused, and (if `onClose` is given)
   *  torn down when the tab closes. The seam any component uses to host a tab without
   *  threading the workbench through. No-op (with a warning) before a host is wired. */
  openTab(widget: Widget, options: OpenTabOptions): void {
    if (!this.tabHost) {
      console.warn('zym.workspace.openTab called before a host was registered');
      return;
    }
    this.tabHost(widget, options);
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
