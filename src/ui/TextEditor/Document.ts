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
import { Adw, Gio, GLib, GtkSource, type SourceBuffer } from '../../gi.ts';
import { quilx } from '../../quilx.ts';
import { Point } from '../../text/Point.ts';
import type { LspDocument, DocumentEdit } from '../../lsp/LspManager.ts';

type EditKind = 'insert' | 'delete';

// node-gtk quirk: Gio.File instance methods are undefined on the concrete instance,
// so reach them through the prototype (see config/load.ts).
const GioFileProto = (Gio.File as any).prototype;
// node-gtk returns out-param iters directly or as [ok, iter]; normalize.
const asIter = (res: any): any => (Array.isArray(res) ? res[res.length - 1] : res);
const iterAtOffset = (buf: any, off: number): any => asIter(buf.getIterAtOffset(off));

/**
 * A collapsed region in ONE view: the view buffer's text for the model range
 * [mStart, mEnd) is physically replaced by a short placeholder ([pStart, pEnd) in
 * the view) — so the view renders the fold on a single line (GtkTextView can't join
 * lines across an invisible newline). Marks track both ranges across edits. Folds
 * are per-view (one view can fold what another shows expanded), and make the view's
 * offsets/lines diverge from the model's — every view↔model translation walks them.
 */
interface Fold {
  pStart: any; // view mark — placeholder start
  pEnd: any; // view mark — placeholder end
  mStart: any; // model mark — collapsed range start
  mEnd: any; // model mark — collapsed range end
}

/** A view's buffer + the guard that keeps a model-applied edit from forwarding back. */
interface ViewEntry {
  buffer: SourceBuffer;
  suppress: boolean;
  folds: Fold[];
}

/** The view-side reactions a Document routes to the active (focused) view: cursor
 *  restore + focus on load, modal dialogs, toasts, and the cursor for LSP requests. */
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
  /** Surface an error message (load/save failures). */
  toast(message: string): void;
  /** Reflect an on-disk change (or its resolution) in the view's warning banner.
   *  Shown persistently until the user reloads/saves it away — not a transient toast. */
  onDiskStateChanged(state: 'synced' | 'changed' | 'deleted', path: string | null): void;
  /** The view's cursor, for LSP requests (completion/hover anchor at the active view). */
  lspCursor(): Point;
}

export class Document {
  // The headless authority: text + the single undo stack. Never attached to a view.
  private readonly model: SourceBuffer;
  private readonly views = new Set<ViewEntry>();
  private origin: ViewEntry | null = null;
  private syncing = false;

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
  private deletionCheckTimer = 0;

  constructor() {
    this.model = new GtkSource.Buffer();
    this.model.setEnableUndo(true);
    (this.model as any).on('modified-changed', () => {
      for (const callback of this.modifiedHandlers) callback();
    });
    // A model change (a forwarded view edit, or undo/redo) → mirror to every view
    // except its origin, and tell the LSP (document-level: one didChange off the
    // model, vs a shared-buffer design where every view's model would fire it).
    // Signals fire pre-mutation, so the offset / deleted text describe the pre-edit
    // state (what the delta needs).
    (this.model as any).on('insert-text', (iter: any, text: string) => {
      this.propagate('insert', iter.getOffset(), text, 0);
      this.lspDidChange([{ start: this.pointAt(iter.getOffset()), oldText: '', newText: text }]);
    });
    (this.model as any).on('delete-range', (start: any, end: any) => {
      const so = start.getOffset();
      const eo = end.getOffset();
      const oldText = (this.model as any).getText(start, end, true);
      this.propagate('delete', so, '', eo);
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

  /** Replace the whole document (a file load/reload). Re-syncs every view directly
   *  and clears the modified flag. */
  setText(text: string): void {
    this.syncing = true;
    try {
      this.model.setText(text, -1);
      for (const view of this.views) {
        view.suppress = true;
        view.buffer.setText(text, -1); // whole-buffer replace drops all folds
        view.folds.length = 0;
        view.suppress = false;
      }
    } finally {
      this.syncing = false;
    }
    this.model.setModified(false);
  }

  isModified(): boolean {
    return this.model.getModified();
  }

  onModifiedChange(callback: () => void): void {
    this.modifiedHandlers.push(callback);
  }

  /** Sync a model edit to the language server (a bulk setText / load is covered by
   *  didOpen instead, so it's skipped). No-op for a buffer-only document (no file). */
  private lspDidChange(changes: DocumentEdit[]): void {
    if (this.syncing || !this._currentFile) return;
    quilx.lsp.didChange(this.lspDocument, changes);
  }

  // --- Views -----------------------------------------------------------------

  /** Open a new view onto this document: a per-view buffer seeded with the current
   *  text and kept in sync. Detach with `removeView` on the view's teardown. */
  createView(): SourceBuffer {
    const buffer = new GtkSource.Buffer();
    buffer.setEnableUndo(false); // the model owns undo
    buffer.setHighlightSyntax(true);
    const entry: ViewEntry = { buffer, suppress: false, folds: [] };

    (buffer as any).on('insert-text', (iter: any, text: string) => {
      if (!entry.suppress) this.forward(entry, 'insert', iter.getOffset(), text);
    });
    (buffer as any).on('delete-range', (start: any, end: any) => {
      if (!entry.suppress) this.forward(entry, 'delete', start.getOffset(), end.getOffset());
    });

    entry.suppress = true;
    buffer.setText(this.getText(), -1);
    buffer.setModified(false);
    entry.suppress = false;

    this.views.add(entry);
    return buffer;
  }

  removeView(buffer: SourceBuffer): void {
    for (const entry of this.views) {
      if (entry.buffer === buffer) {
        this.views.delete(entry);
        return;
      }
    }
  }

  get viewCount(): number {
    return this.views.size;
  }

  // --- Hosts (the active view's reactions) -----------------------------------

  addHost(host: DocumentHost): void {
    if (!this.hosts.includes(host)) this.hosts.push(host);
    if (!this.activeHost) this.activeHost = host;
    // A view opening onto an already-changed document gets the banner immediately.
    host.onDiskStateChanged(this.diskState, this._currentFile);
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

  // --- Sync internals --------------------------------------------------------

  private forward(view: ViewEntry, kind: EditKind, offset: number, textOrEnd: string | number): void {
    // The signal carries VIEW offsets (which count this view's anchors); the model
    // is anchor-free, so translate before applying.
    this.origin = view;
    try {
      if (kind === 'insert') {
        this.model.insert(iterAtOffset(this.model, this.toModelOffset(view, offset)), textOrEnd as string, -1);
      } else {
        this.model.delete(
          iterAtOffset(this.model, this.toModelOffset(view, offset)),
          iterAtOffset(this.model, this.toModelOffset(view, textOrEnd as number)),
        );
      }
    } finally {
      this.origin = null;
    }
  }

  private propagate(kind: EditKind, offset: number, text: string, end: number): void {
    if (this.syncing) return;
    // `offset`/`end` are MODEL offsets; translate into each view's fold-shifted space.
    for (const view of this.views) {
      if (view === this.origin) continue;
      // An edit inside one of this view's collapsed ranges is absorbed by the fold
      // (its model marks track it); applying it would corrupt the placeholder.
      if (this.editInsideFold(view, kind, offset, end)) continue;
      view.suppress = true;
      try {
        if (kind === 'insert') {
          view.buffer.insert(iterAtOffset(view.buffer, this.toViewOffset(view, offset)), text, -1);
        } else {
          view.buffer.delete(
            iterAtOffset(view.buffer, this.toViewOffset(view, offset)),
            iterAtOffset(view.buffer, this.toViewOffset(view, end)),
          );
        }
      } finally {
        view.suppress = false;
      }
    }
  }

  // --- Folds (view-side projection of collapsed model ranges) -----------------

  private entryFor(buffer: SourceBuffer): ViewEntry | null {
    for (const entry of this.views) if (entry.buffer === buffer) return entry;
    return null;
  }

  private markOff(buffer: any, mark: any): number {
    return asIter(buffer.getIterAtMark(mark)).getOffset();
  }

  /** Whether a model edit falls within one of this view's collapsed ranges (so the
   *  fold absorbs it instead of the view rendering it). Insert: at/inside [mStart,mEnd];
   *  delete: fully inside. */
  private editInsideFold(view: ViewEntry, kind: EditKind, offset: number, end: number): boolean {
    for (const f of view.folds) {
      const ms = this.markOff(this.model, f.mStart);
      const me = this.markOff(this.model, f.mEnd);
      if (kind === 'insert') {
        if (offset >= ms && offset <= me) return true;
      } else if (offset >= ms && end <= me) {
        return true;
      }
    }
    return false;
  }

  /** Whether a fold handle is still live (not subsumed by an enclosing fold / deleted). */
  isFoldAlive(fold: Fold): boolean {
    return !!fold && !!fold.pStart && !fold.pStart.getDeleted();
  }

  /** Forget a fold and free its four marks (used when an enclosing fold subsumes it). */
  private dropFold(view: ViewEntry, fold: Fold): void {
    const i = view.folds.indexOf(fold);
    if (i >= 0) view.folds.splice(i, 1);
    for (const m of [fold.pStart, fold.pEnd]) if (m && !m.getDeleted()) (view.buffer as any).deleteMark(m);
    for (const m of [fold.mStart, fold.mEnd]) if (m && !m.getDeleted()) (this.model as any).deleteMark(m);
  }

  /** This view's folds resolved to live offsets, ascending by view position. */
  private foldSpans(view: ViewEntry): Array<{ ps: number; pe: number; ms: number; me: number }> {
    return view.folds
      .filter((f) => !f.pStart.getDeleted()) // defensive: skip any subsumed/dead fold
      .map((f) => ({
        ps: this.markOff(view.buffer, f.pStart),
        pe: this.markOff(view.buffer, f.pEnd),
        ms: this.markOff(this.model, f.mStart),
        me: this.markOff(this.model, f.mEnd),
      }))
      .sort((a, b) => a.ps - b.ps);
  }

  /** VIEW buffer offset → MODEL offset. Each fold before the offset stands in `pLen`
   *  view chars for `mLen` model chars; an offset inside a placeholder collapses to
   *  the fold's model start. */
  private toModelOffset(view: ViewEntry, viewOffset: number): number {
    if (view.folds.length === 0) return viewOffset;
    let delta = 0;
    for (const f of this.foldSpans(view)) {
      if (f.pe <= viewOffset) delta += (f.me - f.ms) - (f.pe - f.ps);
      else if (f.ps < viewOffset) return f.ms; // inside the placeholder
      else break;
    }
    return viewOffset + delta;
  }

  /** MODEL offset → VIEW buffer offset. Inverse of toModelOffset; a model offset
   *  inside a collapsed range maps to the placeholder start. */
  private toViewOffset(view: ViewEntry, modelOffset: number): number {
    if (view.folds.length === 0) return modelOffset;
    let delta = 0;
    for (const f of this.foldSpans(view).sort((a, b) => a.ms - b.ms)) {
      if (f.me <= modelOffset) delta += (f.pe - f.ps) - (f.me - f.ms);
      else if (f.ms < modelOffset) return f.ps; // inside the collapsed range
      else break;
    }
    return modelOffset + delta;
  }

  /**
   * Collapse the VIEW text spanning view offsets [viewStart, viewEnd) to `placeholder`
   * (e.g. `[...]`), recording the model range it stands for. The model is untouched;
   * the view renders the fold on one line. Returns an opaque handle for `unfoldView`.
   */
  foldViewRange(buffer: SourceBuffer, viewStart: number, viewEnd: number, placeholder: string): Fold | null {
    const view = this.entryFor(buffer);
    if (!view || viewEnd <= viewStart) return null;
    const buf = buffer as any;
    // Resolve the model range this view span maps to BEFORE collapsing.
    const ms = this.toModelOffset(view, viewStart);
    const me = this.toModelOffset(view, viewEnd);
    const mStart = (this.model as any).createMark(null, iterAtOffset(this.model, ms), true);
    const mEnd = (this.model as any).createMark(null, iterAtOffset(this.model, me), false);
    // Subsume any folds whose placeholder lies inside the range being collapsed (this
    // fold now represents their model content too). Their placeholder is about to be
    // deleted by the collapse; drop them so they don't double-count in translation. The
    // model range above already accounted for them, so `[ms, me)` spans their bodies.
    for (const inner of [...view.folds]) {
      const ps = this.markOff(buf, inner.pStart);
      if (ps >= viewStart && this.markOff(buf, inner.pEnd) <= viewEnd) {
        this.dropFold(view, inner);
      }
    }
    // Replace the view text with the placeholder (suppressed → never forwarded).
    view.suppress = true;
    try {
      buf.delete(iterAtOffset(buf, viewStart), iterAtOffset(buf, viewEnd));
      buf.insert(iterAtOffset(buf, viewStart), placeholder, -1);
    } finally {
      view.suppress = false;
    }
    const pStart = buf.createMark(null, iterAtOffset(buf, viewStart), false);
    const pEnd = buf.createMark(null, iterAtOffset(buf, viewStart + placeholder.length), true);
    const fold: Fold = { pStart, pEnd, mStart, mEnd };
    view.folds.push(fold);
    return fold;
  }

  /** Expand a fold: replace its placeholder with the current model text of its range. */
  unfoldView(buffer: SourceBuffer, fold: Fold): void {
    const view = this.entryFor(buffer);
    if (!view) return;
    const idx = view.folds.indexOf(fold);
    if (idx < 0) return;
    view.folds.splice(idx, 1);
    const buf = buffer as any;
    const ms = this.markOff(this.model, fold.mStart);
    const me = this.markOff(this.model, fold.mEnd);
    const body = (this.model as any).getText(iterAtOffset(this.model, ms), iterAtOffset(this.model, me), true);
    const ps = this.markOff(buf, fold.pStart);
    const pe = this.markOff(buf, fold.pEnd);
    view.suppress = true;
    try {
      buf.delete(iterAtOffset(buf, ps), iterAtOffset(buf, pe));
      buf.insert(iterAtOffset(buf, ps), body, -1);
    } finally {
      view.suppress = false;
    }
    (this.model as any).deleteMark(fold.mStart);
    (this.model as any).deleteMark(fold.mEnd);
    buf.deleteMark(fold.pStart);
    buf.deleteMark(fold.pEnd);
  }

  /** The live [start, end) placeholder offsets of `fold` in its view buffer. */
  foldPlaceholderRange(buffer: SourceBuffer, fold: Fold): [number, number] {
    return [this.markOff(buffer as any, fold.pStart), this.markOff(buffer as any, fold.pEnd)];
  }

  /** The model text a fold currently stands in for (its `[mStart, mEnd)` range). */
  foldModelText(_buffer: SourceBuffer, fold: Fold): string {
    const ms = this.markOff(this.model, fold.mStart);
    const me = this.markOff(this.model, fold.mEnd);
    return (this.model as any).getText(iterAtOffset(this.model, ms), iterAtOffset(this.model, me), true);
  }

  /** Translate a VIEW caret position to MODEL space (folds shift lines + columns).
   *  Used for LSP requests so positions match the file. */
  modelPointFromView(buffer: SourceBuffer, point: Point): Point {
    const view = this.entryFor(buffer);
    if (!view || view.folds.length === 0) return point;
    const viewOffset = asIter((buffer as any).getIterAtLineOffset(point.row, point.column)).getOffset();
    const iter = iterAtOffset(this.model, this.toModelOffset(view, viewOffset));
    return new Point(iter.getLine(), iter.getLineOffset());
  }

  /** Translate a MODEL caret position to VIEW space (folds collapse lines/cols). A
   *  position inside a folded range maps to its placeholder. For rendering LSP results
   *  (diagnostics, inlay hints) on the collapsed view. */
  viewPointFromModel(buffer: SourceBuffer, point: Point): Point {
    const view = this.entryFor(buffer);
    if (!view || view.folds.length === 0) return point;
    const modelOffset = asIter((this.model as any).getIterAtLineOffset(point.row, point.column)).getOffset();
    const iter = iterAtOffset(buffer, this.toViewOffset(view, modelOffset));
    return new Point(iter.getLine(), iter.getLineOffset());
  }

  /** Text of MODEL row `row` (no newline) — for LSP column-encoding of model ranges. */
  modelLineText(row: number): string {
    return this.lineText(row);
  }

  /** Model line (0-based) shown at VIEW line `viewLine` — for the line-number gutter. */
  modelLineForViewLine(buffer: SourceBuffer, viewLine: number): number {
    const view = this.entryFor(buffer);
    if (!view || view.folds.length === 0) return viewLine;
    const viewOffset = asIter((buffer as any).getIterAtLine(viewLine)).getOffset();
    return iterAtOffset(this.model, this.toModelOffset(view, viewOffset)).getLine();
  }

  /** VIEW line showing model line `modelLine` (its start) — for diagnostics/decorations. */
  viewLineForModelLine(buffer: SourceBuffer, modelLine: number): number {
    const view = this.entryFor(buffer);
    if (!view || view.folds.length === 0) return modelLine;
    const modelOffset = asIter((this.model as any).getIterAtLine(modelLine)).getOffset();
    return iterAtOffset(buffer, this.toViewOffset(view, modelOffset)).getLine();
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

  /** Release shared resources (last view gone): cancel the monitor + close the LSP doc. */
  dispose(): void {
    this.fileMonitor?.cancel();
    this.fileMonitor = null;
    if (this.deletionCheckTimer) GLib.sourceRemove(this.deletionCheckTimer);
    this.deletionCheckTimer = 0;
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
      this.host?.toast(`Could not open ${Path.basename(path)}: ${(error as Error).message}`);
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
      this.host?.toast(`Could not save: ${(error as Error).message}`);
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
    this.deletionCheckTimer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, 200, () => {
      this.deletionCheckTimer = 0;
      if (this._currentFile && this.statMtimeMs(this._currentFile) === null) {
        this.setDiskState('deleted');
      } else if (this._currentFile) {
        this.onDiskChanged();
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  private setDiskState(state: 'synced' | 'changed' | 'deleted'): void {
    if (state === this.diskState) return;
    this.diskState = state;
    this.emitTitleChange();
    // Every view onto this document shows (or hides) its own banner — the warning
    // is persistent, so unlike the old toast there's no focus gating or one-shot dedup.
    for (const host of this.hosts) host.onDiskStateChanged(state, this._currentFile);
  }
}
