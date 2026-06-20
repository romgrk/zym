/*
 * Document — the model layer behind one or more TextEditor views (the A2
 * "document-model" architecture; see tasks/code-editing/text-editor.md →
 * "Document-model direction (A2)").
 *
 * GtkTextBuffer conflates model and view: a buffer shared by N GtkSourceViews renders
 * the same cursor / selection / decorations / folds in all of them. So instead we own
 * the text here: a **headless model buffer** (never shown) is the single source of
 * truth for text + undo, and each view gets its **own** GtkSource.Buffer kept in sync.
 * Every view is then native and independent — its own cursor, selection, current line,
 * folds, decorations — for free, and we can use GtkSourceView's APIs per view.
 *
 * Sync: a native edit in a view's buffer is forwarded to the model, which mirrors it to
 * the other views (reentrancy-guarded). Undo/redo run on the model (view buffers have
 * native undo off) and propagate out. The mechanics are validated in
 * src/poc/document-model.ts and Document.test.ts.
 *
 * The Document also owns the document-level concerns — file I/O, disk-watching,
 * modified-state, and the LSP document — so views are pure presentation. The LSP
 * lifecycle is genuinely document-level here (one didOpen/didChange/didClose for the
 * file, driven off the model), unlike a shared-buffer design where every view's model
 * observed the edits.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { Adw, Gio, GtkSource, type SourceBuffer } from '../../gi.ts';
import { quilx } from '../../quilx.ts';
import { Point } from '../../text/Point.ts';
import type { LspDocument, DocumentEdit } from '../../lsp/LspManager.ts';
import { DocumentSyntax } from '../../syntax/DocumentSyntax.ts';
import { ProjectionView } from './ProjectionView.ts';
import type { Item } from './ViewProjection.ts';
import type { SyntaxProjection } from '../../syntax/SyntaxProjection.ts';
import type { TextEditorSource } from './TextEditorSource.ts';

// The stable source key for this document's model in each view's ProjectionView. A normal
// file is single-source, so the key is arbitrary but must match the projection's segment.
const SOURCE_KEY = 'model';

// node-gtk quirk: Gio.File instance methods are undefined on the concrete instance,
// so reach them through the prototype (see config/load.ts).
const GioFileProto = (Gio.File as any).prototype;
// node-gtk returns out-param iters directly or as [ok, iter]; normalize.
const asIter = (res: any): any => (Array.isArray(res) ? res[res.length - 1] : res);
const iterAtOffset = (buf: any, off: number): any => asIter(buf.getIterAtOffset(off));

/** The view-side reactions a Document routes to the active (focused) view: cursor
 *  restore + focus on load, modal dialogs, banners, and the cursor for LSP requests. */
export interface DocumentHost {
  /** About to replace the document content (capture the caret when `reload` so a
   *  silent external-change reload keeps it). */
  willReplaceContent(reload: boolean): void;
  /** Content was loaded: restore/place the cursor, refresh diagnostics + git gutter,
   *  apply detected indentation, and grab focus (unless `reload`). Syntax follows the
   *  view buffer's own change automatically. */
  didLoad(content: string, path: string, reload: boolean): void;
  /** Content was written to `path`: refresh the git gutter. */
  didSave(path: string): void;
  /** Present a modal dialog parented to the view (overwrite-confirm). */
  presentDialog(dialog: InstanceType<typeof Adw.AlertDialog>): void;
  /** Whether the view currently holds focus (drives prompt timing). */
  hasFocus(): boolean;
  /** Show a persistent info banner above the content. `action` provides an optional
   *  labelled button alongside the dismiss button. */
  showBanner(message: string, kind: 'error' | 'warning', action?: { label: string; onClick: () => void }): void;
  /** Hide the info banner. */
  hideBanner(): void;
  /** The view's cursor, for LSP requests (completion/hover anchor at the active view). */
  lspCursor(): Point;
}

export class Document implements TextEditorSource {
  // A single file/source — never the multibuffer backing (that's `MultiBufferDocument`).
  readonly isMultiSource = false;
  // The painter backing for `TextEditorSource`: a single-source parse, never a projection.
  get documentSyntax(): DocumentSyntax { return this.syntax; }
  readonly syntaxProjection: SyntaxProjection | null = null;

  // The headless authority: text + the single undo stack. Never attached to a view.
  private readonly model: SourceBuffer;
  // Each open view onto this document, keyed by its view buffer. A ProjectionView owns the
  // view buffer + its sync (write-through view→model, reverse-sync model→view) + folds, over
  // a single full-file editable segment of the model (the identity case). The Document is
  // just the shared source.
  private readonly pvs = new Map<SourceBuffer, ProjectionView>();
  private syncing = false;

  // The shared tree-sitter parse for this document (model coords), created lazily on
  // first access — every view's SyntaxController paints from this ONE parse (Phase 0 of
  // the multibuffer split). Buffer-only / diff documents never access it (their painters
  // parse their own view buffer), so it isn't created for them.
  private _syntax: DocumentSyntax | null = null;
  get syntax(): DocumentSyntax {
    return this._syntax ??= new DocumentSyntax(this.model);
  }

  /** The headless model buffer (text + undo authority). Exposed so a multi-source surface
   *  (the editable diff multibuffer) can use it as a live source: an edit written through to
   *  it propagates to this document's own views + LSP, and saves via this document. */
  get modelBuffer(): SourceBuffer {
    return this.model;
  }

  /** The LSP document identity for this file — one per Document. Text/line read the
   *  model directly; the cursor comes from the active view. */
  readonly lspDocument: LspDocument = {
    getPath: () => this._currentFile,
    getText: () => this.getText(),
    lineTextForRow: (row) => this.lineText(row),
    getCursorBufferPosition: () => this.host?.lspCursor() ?? new Point(0, 0),
  };

  private readonly hosts: DocumentHost[] = [];
  private activeHost: DocumentHost | null = null;
  private get host(): DocumentHost | null {
    return this.activeHost ?? this.hosts[0] ?? null;
  }
  private readonly modifiedHandlers: Array<() => void> = [];
  private readonly titleHandlers: Array<() => void> = [];

  private _currentFile: string | null = null;
  // Whether the file's content has actually been read into the model. A lazily-opened
  // document has its path assigned (so title/currentFile/dedup are live) but its content,
  // LSP, and disk watch deferred until the first view is shown — see `assignPath`/`ensureLoaded`.
  private contentLoaded = false;
  private diskMtimeMs: number | null = null;
  private diskState: 'synced' | 'changed' | 'deleted' = 'synced';
  private fileMonitor: InstanceType<typeof Gio.FileMonitor> | null = null;
  private deletionCheckTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.model = new GtkSource.Buffer();
    this.model.setEnableUndo(true);
    (this.model as any).on('modified-changed', () => {
      for (const callback of this.modifiedHandlers) callback();
    });
    // A model change (a view's write-through, or undo/redo) → tell the LSP (document-level:
    // one didChange off the model). Each view's ProjectionView mirrors the change into its
    // own view buffer itself (reverse-sync), so there's no manual propagate here. Signals
    // fire pre-mutation, so the offset / deleted text describe the pre-edit state.
    (this.model as any).on('insert-text', (iter: any, text: string) => {
      this.lspDidChange([{ start: this.pointAt(iter.getOffset()), oldText: '', newText: text }]);
    });
    (this.model as any).on('delete-range', (start: any, end: any) => {
      const so = start.getOffset();
      const oldText = (this.model as any).getText(start, end, true);
      this.lspDidChange([{ start: this.pointAt(so), oldText, newText: '' }]);
    });
  }

  // --- Text ------------------------------------------------------------------

  /** The canonical document text. */
  getText(): string {
    return (this.model as any).getText(this.model.getStartIter(), this.model.getEndIter(), true);
  }

  /** Text of model row `row` (no trailing newline). For the LSP line cache. */
  private lineText(row: number): string {
    const start = asIter((this.model as any).getIterAtLine(row));
    if (!start) return '';
    const end = start.copy();
    if (!end.endsLine()) end.forwardToLineEnd();
    return (this.model as any).getText(start, end, true);
  }

  private pointAt(offset: number): Point {
    const iter = iterAtOffset(this.model, offset);
    return new Point(iter.getLine(), iter.getLineOffset());
  }

  /** Replace the whole document (a file load/reload). Re-materializes every view (dropping
   *  its folds) and clears the modified flag. */
  setText(text: string): void {
    this.syncing = true;
    try {
      // Drive the bulk replace explicitly: suspend each view's reverse-sync so the
      // whole-buffer delete+insert isn't mirrored edit-by-edit, replace the model, then
      // rebuild each view from the new model (which clears folds + re-materializes).
      for (const pv of this.pvs.values()) pv.suspend();
      this.model.setText(text, -1);
      const items = [this.fullFileItem()];
      for (const pv of this.pvs.values()) {
        pv.resume();
        pv.rebuild(items);
      }
    } finally {
      this.syncing = false;
    }
    this.model.setModified(false);
    for (const cb of this.materializeHandlers) cb(); // marks were dropped by the rebuild → re-project
  }

  /** Restore *unsaved* content on session restore: replace the buffer like
   *  `setText`, but mark it modified (the edits were never written to disk, so the
   *  exit prompt must still protect them). */
  restoreUnsaved(text: string): void {
    this.setText(text);
    this.model.setModified(true);
  }

  isModified(): boolean {
    return this.model.getModified();
  }

  /** Subscribe to modified-state changes; returns a disposer (a shared Document can outlive a
   *  given observer — e.g. a diff multibuffer — so the observer must be able to detach). */
  onModifiedChange(callback: () => void): () => void {
    this.modifiedHandlers.push(callback);
    return () => {
      const i = this.modifiedHandlers.indexOf(callback);
      if (i >= 0) this.modifiedHandlers.splice(i, 1);
    };
  }

  /** Sync a model edit to the language server (a bulk setText / load is covered by
   *  didOpen instead, so it's skipped). No-op for a buffer-only document (no file). */
  private lspDidChange(changes: DocumentEdit[]): void {
    if (this.syncing || !this._currentFile) return;
    quilx.lsp.didChange(this.lspDocument, changes);
  }

  // --- Views -----------------------------------------------------------------

  /** Open a new view onto this document: a ProjectionView over the model (one full-file
   *  editable segment), materialized + kept in sync. Returns its view buffer. Detach with
   *  `removeView` on the view's teardown. */
  createView(): SourceBuffer {
    const pv = new ProjectionView([this.fullFileItem()], new Map([[SOURCE_KEY, this.model]]));
    pv.buffer.setHighlightSyntax(true); // the painter turns this off once it owns highlighting
    this.pvs.set(pv.buffer, pv);
    return pv.buffer;
  }

  removeView(buffer: SourceBuffer): void {
    const pv = this.pvs.get(buffer);
    if (pv) {
      pv.dispose();
      this.pvs.delete(buffer);
    }
  }

  get viewCount(): number {
    return this.pvs.size;
  }

  // --- Hosts (the active view's reactions) -----------------------------------

  addHost(host: DocumentHost): void {
    if (!this.hosts.includes(host)) this.hosts.push(host);
    if (!this.activeHost) this.activeHost = host;
    // A view opening onto an already-changed document gets the banner immediately.
    this.syncBannerForHost(host);
  }
  removeHost(host: DocumentHost): void {
    const index = this.hosts.indexOf(host);
    if (index >= 0) this.hosts.splice(index, 1);
    if (this.activeHost === host) this.activeHost = this.hosts[0] ?? null;
  }
  setActiveHost(host: DocumentHost): void {
    if (this.hosts.includes(host)) this.activeHost = host;
  }

  // --- Undo (model-owned) ----------------------------------------------------

  undo(): void {
    if (this.model.canUndo) this.model.undo();
  }
  redo(): void {
    if (this.model.canRedo) this.model.redo();
  }
  canUndo(): boolean {
    return this.model.canUndo;
  }
  canRedo(): boolean {
    return this.model.canRedo;
  }
  transact(fn: () => void): void {
    this.model.beginUserAction();
    try {
      fn();
    } finally {
      this.model.endUserAction();
    }
  }

  /** Open/close a model undo group. The editor wraps an insert session (and its
   *  `transact`) in these so the forwarded view edits coalesce into one undo step on
   *  the model (the view buffers have native undo off). Matches the `UndoTarget` shape. */
  beginUserAction(): void {
    this.model.beginUserAction();
  }
  endUserAction(): void {
    this.model.endUserAction();
  }

  // --- View sync + folds (delegated to each view's ProjectionView) -----------
  // Each view is a ProjectionView over the model (one full-file editable segment — the
  // identity case): it owns write-through (view→model), reverse-sync (model→view), and its
  // folds. The Document forwards the FoldHost + translation surface SyntaxController /
  // TextEditor use to the PV for the given view buffer (identity when the view has no folds).

  private pvFor(buffer: SourceBuffer): ProjectionView | null {
    return this.pvs.get(buffer) ?? null;
  }

  /** One full-file editable segment over the model — the normal-editor projection. `endRow`
   *  tracks the model's current last line (a fresh item is built on each (re)materialize). */
  private fullFileItem(): Item {
    return {
      type: 'segment',
      segment: {
        sourceKey: SOURCE_KEY,
        startRow: 0,
        endRow: Math.max(0, this.model.getLineCount() - 1),
        editable: true,
        kind: 'real',
      },
    };
  }

  /** Collapse a view range to `placeholder`; returns the fold handle (opaque to callers). */
  foldViewRange(buffer: SourceBuffer, viewStart: number, viewEnd: number, placeholder: string): any {
    return this.pvFor(buffer)?.fold(viewStart, viewEnd, placeholder) ?? null;
  }

  /** Expand a fold (restore its collapsed text). */
  unfoldView(buffer: SourceBuffer, fold: any): void {
    this.pvFor(buffer)?.unfold(fold);
  }

  /** The live [start, end) placeholder offsets of `fold` in its view buffer. */
  foldPlaceholderRange(buffer: SourceBuffer, fold: any): [number, number] {
    return this.pvFor(buffer)?.foldPlaceholderRange(fold) ?? [0, 0];
  }

  /** The model text a fold currently stands in for (for search-reveal matching). */
  foldModelText(buffer: SourceBuffer, fold: any): string {
    return this.pvFor(buffer)?.foldModelText(fold) ?? '';
  }

  /** Whether a fold handle is still live (not subsumed by an enclosing fold). */
  isFoldAlive(fold: any): boolean {
    if (!fold) return false;
    for (const pv of this.pvs.values()) if (pv.isFoldAlive(fold)) return true;
    return false;
  }

  /** Translate a VIEW caret position to MODEL space (folds shift lines + columns) — for LSP. */
  modelPointFromView(buffer: SourceBuffer, point: Point): Point {
    return this.pvFor(buffer)?.modelPointFromView(point) ?? point;
  }

  /** Translate a MODEL caret position to VIEW space (a position inside a fold → its
   *  placeholder). For rendering LSP results (diagnostics, inlay hints) on the collapsed view. */
  viewPointFromModel(buffer: SourceBuffer, point: Point): Point {
    return this.pvFor(buffer)?.viewPointFromModel(point) ?? point;
  }

  /** Text of MODEL row `row` (no newline) — for LSP column-encoding of model ranges. */
  modelLineText(row: number): string {
    return this.lineText(row);
  }

  /** Model line (0-based) shown at VIEW line `viewLine` — for the line-number gutter. */
  modelLineForViewLine(buffer: SourceBuffer, viewLine: number): number {
    return this.pvFor(buffer)?.modelLineForViewLine(viewLine) ?? viewLine;
  }

  /** VIEW line showing model line `modelLine` (its start) — for diagnostics/decorations. */
  viewLineForModelLine(buffer: SourceBuffer, modelLine: number): number {
    return this.pvFor(buffer)?.viewLineForModelLine(modelLine) ?? modelLine;
  }

  // --- block-decoration anchoring (single source: the file is the sole source) -
  /** The view row showing source `row` — `sourceKey` is ignored (one source). Fold-aware. */
  viewRowForSource(buffer: SourceBuffer, _sourceKey: string | undefined, row: number): number | null {
    return this.viewLineForModelLine(buffer, row);
  }
  /** Fired when a view re-materializes (a file load/reload via `setText`), which drops marks. */
  private readonly materializeHandlers = new Set<() => void>();
  onDidMaterialize(cb: () => void): () => void {
    this.materializeHandlers.add(cb);
    return () => this.materializeHandlers.delete(cb);
  }

  // --- Identity --------------------------------------------------------------

  get currentFile(): string | null {
    return this._currentFile;
  }
  get title(): string {
    return this._currentFile ? Path.basename(this._currentFile) : 'Untitled';
  }
  onTitleChange(callback: () => void): void {
    this.titleHandlers.push(callback);
  }
  private emitTitleChange(): void {
    for (const callback of this.titleHandlers) callback();
  }
  hasDiskChange(): boolean {
    return this.diskState !== 'synced';
  }

  /** Release shared resources (last view gone): cancel the monitor + close the LSP doc +
   *  free the shared tree-sitter parse. */
  dispose(): void {
    this.fileMonitor?.cancel();
    this.fileMonitor = null;
    if (this.deletionCheckTimer) clearTimeout(this.deletionCheckTimer);
    this.deletionCheckTimer = null;
    for (const pv of this.pvs.values()) pv.dispose(); // detach any view still attached
    this.pvs.clear();
    this._syntax?.dispose(); // frees the tree + injection parsers; detaches model signals
    this._syntax = null;
    // Only close an LSP doc we actually opened — a lazily-assigned, never-shown document
    // has a path but never ran didOpen.
    if (this.contentLoaded) quilx.lsp.didClose(this.lspDocument);
  }

  // --- File operations -------------------------------------------------------

  /** Whether the file's content has been read into the model yet (false for a document
   *  that has only had its path assigned via `assignPath`). */
  get isLoaded(): boolean {
    return this.contentLoaded;
  }

  /** Lazy open: take on `path`'s identity (title / `currentFile` / dedup key go live now)
   *  WITHOUT reading the file, opening the LSP, or watching disk. The content load is
   *  deferred to `ensureLoaded()`, called when the first view onto this document is shown.
   *  No-op once the content is already loaded (a real load supersedes a pending one). */
  assignPath(path: string): void {
    if (this.contentLoaded) return;
    this._currentFile = path;
    this.emitTitleChange();
  }

  /** Read the assigned file into the model the first time a view is shown — the deferred
   *  half of `assignPath`. Idempotent; a no-op once loaded or with no assigned path. */
  ensureLoaded(): void {
    if (this.contentLoaded || !this._currentFile) return;
    this.loadFile(this._currentFile);
  }

  loadFile(path: string, opts: { silent?: boolean } = {}): void {
    try {
      // Close the old LSP doc before replacing content (a reload re-opens with the new
      // text). A first load — even when the path is already assigned (lazy open) — has
      // nothing open yet, so this is gated on the content having actually been loaded.
      if (this.contentLoaded) quilx.lsp.didClose(this.lspDocument);
      this.host?.willReplaceContent(!!opts.silent);
      const content = Fs.readFileSync(path, 'utf8');
      this.setText(content); // re-syncs every view + clears modified
      this.contentLoaded = true;
      this._currentFile = path;
      this.diskMtimeMs = this.statMtimeMs(path);
      this.setDiskState('synced');
      this.watchFile(path);
      quilx.lsp.didOpen(this.lspDocument);
      this.host?.didLoad(content, path, !!opts.silent);
      this.emitTitleChange();
    } catch (error) {
      this.host?.showBanner(`Could not open ${Path.basename(path)}: ${(error as Error).message}`, 'error');
    }
  }

  save(): void {
    if (this._currentFile) this.saveAs(this._currentFile);
  }

  saveAs(path: string): void {
    const content = this.getText();
    if (path === this._currentFile && this.hasExternalChange()) {
      this.confirmOverwriteThenSave(path, content);
      return;
    }
    this.writeFile(path, content);
  }

  private statMtimeMs(path: string): number | null {
    try {
      return Fs.statSync(path).mtimeMs;
    } catch {
      return null;
    }
  }

  private hasExternalChange(): boolean {
    if (this.diskMtimeMs === null || !this._currentFile) return false;
    const onDisk = this.statMtimeMs(this._currentFile);
    return onDisk !== null && onDisk !== this.diskMtimeMs;
  }

  private confirmOverwriteThenSave(path: string, content: string): void {
    const dialog = new Adw.AlertDialog({
      heading: 'File changed on disk',
      body:
        `${Path.basename(path)} has changed on disk since it was opened. ` +
        `Saving will overwrite those changes.`,
    });
    dialog.addResponse('cancel', 'Cancel');
    dialog.addResponse('reload', 'Reload from Disk');
    dialog.addResponse('overwrite', 'Overwrite');
    dialog.setResponseAppearance('overwrite', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.setDefaultResponse('cancel');
    dialog.setCloseResponse('cancel');
    dialog.on('response', (response: string) => {
      if (response === 'overwrite') this.writeFile(path, content);
      else if (response === 'reload') this.loadFile(path);
    });
    this.host?.presentDialog(dialog);
  }

  private writeFile(path: string, content: string): void {
    try {
      const wasDeleted = this.diskState === 'deleted';
      Fs.writeFileSync(path, content);
      this.diskMtimeMs = this.statMtimeMs(path);
      this.setDiskState('synced');
      this.model.setModified(false);
      const pathChanged = path !== this._currentFile;
      this._currentFile = path;
      if (pathChanged || wasDeleted) this.watchFile(path);
      quilx.lsp.didSave(this.lspDocument);
      this.host?.didSave(path);
      this.emitTitleChange();
      quilx.notifications.addTrace(`Saved ${Path.basename(path)}`);
    } catch (error) {
      this.host?.showBanner(`Could not save: ${(error as Error).message}`, 'error');
    }
  }

  // --- On-disk change detection ----------------------------------------------

  private watchFile(path: string): void {
    this.fileMonitor?.cancel();
    this.fileMonitor = null;
    try {
      const file = Gio.File.newForPath(path);
      const monitor = GioFileProto.monitorFile.call(
        file,
        Gio.FileMonitorFlags.WATCH_MOVES,
        null,
      ) as InstanceType<typeof Gio.FileMonitor>;
      monitor.on('changed', () => this.onDiskChanged());
      this.fileMonitor = monitor;
    } catch (error) {
      console.warn(`[editor] could not watch ${path}: ${(error as Error).message}`);
    }
  }

  private onDiskChanged(): void {
    if (!this._currentFile) return;
    const onDisk = this.statMtimeMs(this._currentFile);
    if (onDisk === null) {
      this.scheduleDeletionCheck();
      return;
    }
    if (this.diskMtimeMs === null || onDisk === this.diskMtimeMs) return;
    if (!this.isModified()) {
      this.loadFile(this._currentFile, { silent: true });
      return;
    }
    this.setDiskState('changed');
  }

  private scheduleDeletionCheck(): void {
    if (this.deletionCheckTimer) return;
    this.deletionCheckTimer = setTimeout(() => {
      this.deletionCheckTimer = null;
      if (this._currentFile && this.statMtimeMs(this._currentFile) === null) {
        this.setDiskState('deleted');
      } else if (this._currentFile) {
        this.onDiskChanged();
      }
    }, 200);
  }

  private setDiskState(state: 'synced' | 'changed' | 'deleted'): void {
    if (state === this.diskState) return;
    this.diskState = state;
    this.emitTitleChange();
    for (const host of this.hosts) this.syncBannerForHost(host);
  }

  private syncBannerForHost(host: DocumentHost): void {
    const path = this._currentFile;
    if (this.diskState === 'synced' || !path) {
      host.hideBanner();
    } else if (this.diskState === 'deleted') {
      host.showBanner('file deleted on disk', 'warning', { label: 'Save', onClick: () => this.save() });
    } else {
      host.showBanner('file changed on disk', 'warning', { label: 'Reload', onClick: () => this.loadFile(path) });
    }
  }
}
