/*
 * EditorModel — a buffer-centric editing model over a GtkSource view + buffer.
 *
 * GtkSourceView gives us a widget and a `GtkTextBuffer`, but it speaks in
 * `GtkTextIter`s and byte/char offsets. The vim layer (and everything ported
 * from vim-mode-plus) instead thinks in `Point`s and `Range`s and asks the
 * editor high-level questions ("what's the text on row 4?", "clip this position
 * into the buffer"). EditorModel is that translation layer: a first-class,
 * idiomatic API expressed in zym `Point`/`Range`, backed by the live buffer.
 *
 * Positions are zero-based `(row, column)` where column is a **codepoint** offset
 * within the line (matching `GtkTextIter` line offsets, and the convention
 * `lsp/position.ts` converts to/from). This is the single column convention for
 * zym Points — anything mapping a JS string offset (which is UTF-16) to a Point
 * must count codepoints, not code units, so surrogate pairs (non-BMP, e.g. emoji)
 * count as one column. Cursors/selections, mutation, scanning, and markers build
 * on the `Point`↔`TextIter` bridge established here.
 */
import { Point, type PointLike } from '../../text/Point.ts';
import { Range, type RangeLike } from '../../text/Range.ts';
import { unwrapIter, clamp, type TextIter } from './iter.ts';
import { Selection } from './Selection.ts';
import { Cursor } from './Cursor.ts';
import { MarkerLayer } from './MarkerLayer.ts';
import { Emitter, Disposable } from '../../util/eventKit.ts';
import { theme } from '../../theme/theme.ts';
import { Gtk, type SourceBuffer, type SourceView } from '../../gi.ts';

/** Cursor shapes the vim layer switches between per mode. */
export const CursorType = { BEAM: 'beam', BLOCK: 'block', UNDERLINE: 'underline' } as const;

/** What undo/redo + undo-grouping route to. A `GtkSource.Buffer` satisfies it natively
 *  (buffer-only editors); a document-backed view points it at the `Document` model. */
export interface UndoTarget {
  undo(): void;
  redo(): void;
  beginUserAction(): void;
  endUserAction(): void;
}

// Fallback line height (px) when the view isn't realized, so the scroll math has
// a non-zero divisor in headless contexts.
const DEFAULT_LINE_HEIGHT = 18;
// How many leading lines `getLineHeightInPixels` samples to find the base (band-free) line height
// — see the method. A handful always includes plain content lines in any real diff/file.
const LINE_HEIGHT_SAMPLE = 16;

// Rows per chunk for the windowed backward scan (`b`/`ge`/etc.): big enough that
// the previous match is almost always in the first window, small enough that one
// window is cheap on a huge buffer.
const BACKWARD_SCAN_WINDOW_ROWS = 200;

/** A UTF-16 low surrogate (the second half of a non-BMP codepoint pair). */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Fold state, supplied by the host (SyntaxController) so motions can see folds. */
export interface FoldProvider {
  /** Whether `row` is hidden inside a collapsed fold. */
  isFoldedAtRow(row: number): boolean;
  /** Reveal `row` by unfolding the fold(s) that hide it. */
  unfoldRow(row: number): void;
  /** Inclusive `[startRow, endRow]` of every foldable region (for fold motions /
   *  the fold text object). */
  foldableRanges?(): Array<{ startRow: number; endRow: number }>;
  /** The function enclosing `(row, column)` — outer (whole def) and inner (body)
   *  line spans — for the `if`/`af` text object. Null when off a function. */
  functionRangeAt?(
    row: number,
    column: number,
  ): { outer: { startRow: number; endRow: number }; inner: { startRow: number; endRow: number } } | null;
  /** The class/interface/enum enclosing `(row, column)`, for the `ic`/`ac` text object. */
  classRangeAt?(
    row: number,
    column: number,
  ): { outer: { startRow: number; endRow: number }; inner: { startRow: number; endRow: number } } | null;
}

/** The `if`/`af` function ranges, as linewise Ranges. */
export interface FunctionRange {
  outer: Range;
  inner: Range;
}

/** How EditorModel reaches the fold projection: placeholder ranges are atomic to the
 *  cursor, editing one reveals it, and search runs over the unfolded document. */
export interface FoldAccess {
  /** View-offset [start, end) ranges of every collapsed-fold placeholder. */
  placeholderRanges(): Array<[number, number]>;
  /** Unfold the fold whose placeholder contains `viewOffset`; true if one did. */
  unfoldAt(viewOffset: number): boolean;
  /** Expand every fold (so a search sees the whole document). */
  unfoldAll(): void;
  /** MODEL caret → VIEW caret (folds shift lines/cols); for rendering LSP results. */
  viewPointFromModel(point: Point): Point;
  /** MODEL line text (no newline) — for LSP column-encoding of model-space ranges. */
  modelLineText(row: number): string;
  /** Reveal folds whose collapsed model content matches `test` (search). */
  revealFoldsMatching(test: (text: string) => boolean): void;
}

export class EditorModel {
  // The vim layer reaches `editorElement.constructor.CursorType`; EditorModel is
  // both the `editor` and the `editorElement`, so it carries it statically.
  static readonly CursorType = CursorType;

  readonly view: SourceView;
  readonly buffer: SourceBuffer;
  // Where undo grouping + undo/redo go. For a buffer-only editor it's the view buffer
  // (native undo); for a document-backed view it's the Document (the model owns undo,
  // view buffers have native undo off), set via `setUndoTarget`.
  private undoTarget: UndoTarget;

  // The primary Selection is backed by the buffer's native insert/selection-bound
  // pair. Secondary selections (visual-block rows; later multi-cursor) carry their
  // own marks and are painted with `extraSelectionTag` since GtkTextView only
  // renders the native one.
  // Not `readonly`: when the primary is removed while secondaries remain (a
  // visual-block whose head is a lower row), primary-ness — the native marks and
  // caret — is transferred onto a survivor, which then becomes `this.selection`.
  private selection: Selection;
  private extraSelections: Selection[] = [];
  private extraSelectionTag?: InstanceType<typeof Gtk.TextTag>;
  private extraCursorTag?: InstanceType<typeof Gtk.TextTag>;
  private defaultMarkerLayer?: MarkerLayer;
  private foldProvider: FoldProvider | null = null;
  private checkpointCounter = 0;
  private readonly emitter = new Emitter();
  private destroyed = false;

  // Buffer-change extents collected from the pre-edit `insert-text`/
  // `delete-range` signals, flushed as a `did-change-text` event on the
  // following `changed` (post-mutation). See installChangeTracking.
  private pendingTextChanges: BufferChange[] = [];
  // Changes accumulated since each live checkpoint, keyed by checkpoint id. Used
  // by `getChangeSinceCheckpoint` (the vim layer records insert-mode text this
  // way, for blockwise-insert replication and insert dot-repeat).
  private checkpointChanges = new Map<number, BufferChange[]>();

  // Block-cursor rendering: GTK has no CSS for a block caret, so normal/visual
  // mode hides the native beam and paints a reverse-video tag over the character
  // under the cursor (cursor color as background, editor background as the glyph
  // color) — the effect a terminal block cursor uses. `blockCursor` is the
  // current mode's desired shape.
  private blockCursor = false;
  // Whether the view currently holds focus. While unfocused, the solid block is
  // replaced by the host widget's hollow-rectangle caret.
  private focused = true;
  // Where to paint the block caret, when it should differ from the insert mark.
  // In linewise visual mode the buffer selection runs to the next line's start
  // (to cover the trailing newline), but the caret belongs on the current line;
  // the vim layer points this at the selection's logical head. null = insert mark.
  private cursorDisplayPoint: Point | null = null;
  // Maps a selection to its *visual* caret position. In visual mode the buffer
  // selection is select-right-extended (head one past the last selected char),
  // so the secondary block carets (visual-block / multi-cursor) would paint one
  // column too far right; the vim layer installs this to normalize the head back
  // onto the last selected char. null/unset = the raw head (plain multi-cursor).
  private cursorDisplayResolver: ((selection: Selection) => PointLike | null) | null = null;
  private readonly cursorTag: InstanceType<typeof Gtk.TextTag>;

  // The on-character block caret is a reverse-video tag (keeps the glyph
  // legible). When there's no glyph to cover (empty line / past end-of-line /
  // end-of-buffer) or the view is unfocused, the host widget overlays a box
  // instead — `filled` for a focused block, `hollow` when unfocused. The host
  // sets this; `hidden` means the tag (or native caret) covers it.
  onCursorOverlay?: (kind: 'hidden' | 'hollow' | 'filled', iter?: TextIter) => void;

  // Host-drawn carets for the *extra* cursors (multi-cursor / blockwise). Block
  // carets over a glyph are painted as tags; beam carets (insert mode) and carets
  // with no glyph to cover are drawn by the host here. Empty array clears them.
  onExtraCursors?: (carets: Array<{ iter: TextIter; beam: boolean }>) => void;

  /** Route undo/redo + undo-grouping to a different target than the view buffer — the
   *  `Document` model, for a document-backed view (whose buffer has native undo off). */
  setUndoTarget(target: UndoTarget): void {
    this.undoTarget = target;
  }

  constructor(view: SourceView, buffer: SourceBuffer) {
    this.view = view;
    this.buffer = buffer;
    this.undoTarget = buffer; // default: the view buffer's native undo (buffer-only editors)
    // Selector identity for command/keymap rules: the view is the focused widget
    // and carries the mode CSS classes, so keymaps target it as `#TextEditor`
    // (e.g. `#TextEditor.normal-mode`) instead of the raw `GtkSourceView` type tag.
    this.view.setName('TextEditor');
    this.selection = new Selection(this);
    // Indent with spaces by default; the host overrides via `setIndentation`
    // (config default + per-file detection). Without this a bare GtkSourceView
    // defaults to tabs, which the indent/auto-indent paths would then emit.
    this.view.setInsertSpacesInsteadOfTabs(true);
    this.cursorTag = this.createCursorTag();
    this.view.setOverwrite(false); // the block look comes from the tag, not overwrite
    // Keep the block caret on the insert mark even when it moves outside the vim
    // layer (e.g. a mouse click placing the cursor), not just after operations.
    this.buffer.on('notify::cursor-position', () => this.onCursorMoved());
    this.installChangeTracking();
  }

  // --- Buffer-change events --------------------------------------------------

  /**
   * Bridge GtkTextBuffer's edit signals to Atom-`TextBuffer`-shaped
   * `did-change-text` events. The `insert-text`/`delete-range` user handlers run
   * before the buffer's default handler mutates it (RUN_LAST), so their iters
   * and `text` describe the pre-edit state — exactly what we need to compute each
   * change's `oldRange`/`newRange`/`oldText`/`newText`. We stash the change and
   * emit it on the next `changed` (which fires *after* the mutation), so
   * subscribers observe the post-change buffer, matching the Atom contract.
   *
   * Each primitive insert/delete is delivered as its own one-change event;
   * coalescing several edits of one user action into a single event is not done
   * (no consumer needs it). The array is swapped out before emitting, so a
   * listener that edits the buffer re-enters cleanly.
   */
  private installChangeTracking(): void {
    this.buffer.on('insert-text', (location: TextIter, text: string) =>
      this.pendingTextChanges.push(this.insertChange(location, text)),
    );
    this.buffer.on('delete-range', (start: TextIter, end: TextIter) =>
      this.pendingTextChanges.push(this.deleteChange(start, end)),
    );
    this.buffer.on('changed', () => {
      if (this.pendingTextChanges.length === 0) return;
      const changes = this.pendingTextChanges;
      this.pendingTextChanges = [];
      for (const recorded of this.checkpointChanges.values()) recorded.push(...changes);
      this.emitter.emit('did-change-text', { changes });
    });
  }

  /** The change an insertion of `text` at `location` (pre-edit) will produce. */
  private insertChange(location: TextIter, text: string): BufferChange {
    const start = this.pointAtIter(location);
    // Mirror SyntaxController's column math: tree-sitter/GTK columns coincide for
    // ASCII; `text.length` is JS UTF-16 units, the project-wide column convention.
    const newlines = text.split('\n').length - 1;
    const lastNewline = text.lastIndexOf('\n');
    const end = new Point(
      start.row + newlines,
      newlines === 0 ? start.column + text.length : text.length - lastNewline - 1,
    );
    return { oldRange: new Range(start, start), newRange: new Range(start, end), oldText: '', newText: text };
  }

  /** The change a deletion of `[start, end)` (pre-edit) will produce. */
  private deleteChange(start: TextIter, end: TextIter): BufferChange {
    const startPoint = this.pointAtIter(start);
    const endPoint = this.pointAtIter(end);
    const oldText = this.buffer.getText(start, end, true);
    return {
      oldRange: new Range(startPoint, endPoint),
      newRange: new Range(startPoint, startPoint),
      oldText,
      newText: '',
    };
  }

  /** Subscribe to buffer text changes (Atom `TextBuffer.onDidChangeText` shape). */
  onDidChangeText(callback: (event: BufferChangeEvent) => void): Disposable {
    return this.emitter.on('did-change-text', callback as (value?: unknown) => void);
  }

  private createCursorTag(): InstanceType<typeof Gtk.TextTag> {
    // Reverse video: fill with the cursor color, draw the glyph in the editor
    // background color so it stays legible on the solid block.
    const tag = new Gtk.TextTag({
      name: 'vim-block-cursor',
      background: theme.ui.editor.foreground,
      foreground: theme.ui.editor.background,
    });
    this.buffer.getTagTable().add(tag);
    return tag;
  }

  /** The vim layer treats the model as its own `editorElement`. */
  get element(): this {
    return this;
  }

  isAlive(): boolean {
    return !this.destroyed;
  }

  isEmpty(): boolean {
    return this.buffer.getCharCount() === 0;
  }

  /** True once at least one secondary selection (extra cursor) exists. */
  hasMultipleCursors(): boolean {
    return this.extraSelections.length > 0;
  }

  /** Fire destruction (called by the host widget when the editor goes away). */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emitter.emit('did-destroy');
  }

  onDidDestroy(callback: () => void): Disposable {
    return this.emitter.on('did-destroy', callback);
  }

  // Fires when a secondary selection is added (multi-cursor / blockwise). The vim
  // layer subscribes to keep visual-mode state reconciled with the live set.
  onDidAddSelection(callback: (selection: Selection) => void): Disposable {
    return this.emitter.on('did-add-selection', callback as (value: unknown) => void);
  }

  onDidChangeSelectionRange(_callback: (event: unknown) => void): Disposable {
    return new Disposable(() => {});
  }

  // --- Point ↔ TextIter bridge ----------------------------------------------

  /**
   * An iter at `point`, clamped into the buffer. Rows past the end land on the
   * last row; columns past a line's end land at its end (before the newline).
   */
  iterAtPoint(point: PointLike): TextIter {
    const p = Point.fromObject(point);
    const lastRow = this.getLastBufferRow();
    const row = clamp(p.row, 0, lastRow);
    const iter = this.iterAtLineStart(row);

    const maxColumn = this.maxColumnForLineStart(iter);
    iter.setLineOffset(clamp(p.column, 0, maxColumn));
    return iter;
  }

  /** The `Point` for `iter`. */
  pointAtIter(iter: TextIter): Point {
    return new Point(iter.getLine(), iter.getLineOffset());
  }

  /** A fresh iter at the start of `row` (assumes `row` is already valid). */
  private iterAtLineStart(row: number): TextIter {
    return unwrapIter(this.buffer.getIterAtLine(row));
  }

  /** The last valid column on the line whose start is `lineStart` (excludes the newline). */
  private maxColumnForLineStart(lineStart: TextIter): number {
    const end = lineStart.copy();
    // On a non-empty line, walk to just before the paragraph delimiter. On an
    // empty line `endsLine()` is already true, so the max column is 0.
    if (!end.endsLine()) end.forwardToLineEnd();
    return end.getLineOffset();
  }

  // --- Buffer shape ----------------------------------------------------------

  /** Number of lines in the buffer. */
  getLineCount(): number {
    return this.buffer.getLineCount();
  }

  /** Index of the last row. */
  getLastBufferRow(): number {
    return this.buffer.getLineCount() - 1;
  }

  /** The end-of-file position. */
  getEofBufferPosition(): Point {
    return this.pointAtIter(this.buffer.getEndIter());
  }

  // Git-hunk navigation (vim `]h`/`[h`). The host (TextEditor) registers a
  // provider backed by the GitGutter's line→change map; absent (buffer-only
  // editors, no repo) it yields no hunks and the motions no-op.
  private hunkProvider?: () => number[];

  setHunkProvider(provider: () => number[]): void {
    this.hunkProvider = provider;
  }

  /** Sorted buffer rows where each git hunk begins (empty when unavailable). */
  getHunkStartRows(): number[] {
    return this.hunkProvider?.() ?? [];
  }

  /** `point` clamped to a real position within the buffer. */
  clipBufferPosition(point: PointLike): Point {
    return this.pointAtIter(this.iterAtPoint(point));
  }

  // Identity stubs: `screen` should fold/wrap-project `buffer` (WIP) — see
  // docs/text-editor/coordinates.md.
  screenPositionForBufferPosition(point: PointLike, _options?: unknown): Point {
    return this.clipBufferPosition(point);
  }

  bufferPositionForScreenPosition(point: PointLike, _options?: unknown): Point {
    return this.clipBufferPosition(point);
  }

  bufferRowForScreenRow(screenRow: number): number {
    return clamp(screenRow, 0, this.getLastBufferRow());
  }

  screenRowForBufferRow(bufferRow: number): number {
    return clamp(bufferRow, 0, this.getLastBufferRow());
  }

  /** Clamp a screen position. Identity stub — see docs/text-editor/coordinates.md. */
  clipScreenPosition(point: PointLike, _options?: unknown): Point {
    return this.clipBufferPosition(point);
  }

  /** The visible screen-row range as `[firstVisibleScreenRow, lastVisibleScreenRow]`. */
  getVisibleRowRange(): [number, number] {
    return [this.getFirstVisibleScreenRow(), this.getLastVisibleScreenRow()];
  }

  bufferRangeForScreenRange(screenRange: RangeLike): Range {
    const r = Range.fromObject(screenRange);
    return new Range(this.bufferPositionForScreenPosition(r.start), this.bufferPositionForScreenPosition(r.end));
  }

  screenRangeForBufferRange(bufferRange: RangeLike): Range {
    const r = Range.fromObject(bufferRange);
    return new Range(this.screenPositionForBufferPosition(r.start), this.screenPositionForBufferPosition(r.end));
  }

  /** True when `row` is empty or contains only whitespace. */
  isBufferRowBlank(row: number): boolean {
    return /^\s*$/.test(this.lineTextForBufferRow(row));
  }

  // --- Text ------------------------------------------------------------------

  /** The entire buffer text, including text hidden by folds. */
  getText(): string {
    const [start, end] = this.buffer.getBounds();
    return this.buffer.getText(start, end, true);
  }

  /** The text within `range`. */
  getTextInBufferRange(range: RangeLike): string {
    const r = Range.fromObject(range);
    return this.buffer.getText(this.iterAtPoint(r.start), this.iterAtPoint(r.end), true);
  }


  /** The text of `row`, excluding its trailing newline. */
  lineTextForBufferRow(row: number): string {
    const start = this.iterAtLineStart(clamp(row, 0, this.getLastBufferRow()));
    const end = start.copy();
    if (!end.endsLine()) end.forwardToLineEnd();
    return this.buffer.getText(start, end, true);
  }

  /**
   * The codepoint length of `row` (its last valid column). The codepoint-correct
   * replacement for `lineTextForBufferRow(row).length`, which is UTF-16 and so
   * over-counts on non-BMP characters — see the column-convention note up top.
   */
  lineLength(row: number): number {
    const start = this.iterAtLineStart(clamp(row, 0, this.getLastBufferRow()));
    const end = start.copy();
    if (!end.endsLine()) end.forwardToLineEnd();
    return end.getLineOffset();
  }

  /**
   * The range spanning `row`. Without `includeNewline` it stops at the line's
   * last character; with it, it extends to the start of the next row (or EOF on
   * the last row).
   */
  bufferRangeForBufferRow(row: number, options: { includeNewline?: boolean } = {}): Range {
    const clamped = clamp(row, 0, this.getLastBufferRow());
    const start = this.iterAtLineStart(clamped);
    const end = start.copy();
    if (options.includeNewline) end.forwardLine();
    else if (!end.endsLine()) end.forwardToLineEnd();
    return new Range(this.pointAtIter(start), this.pointAtIter(end));
  }

  // --- Cursor (single insertion point) --------------------------------------

  /** The primary cursor position (the buffer's insert mark). */
  getCursorBufferPosition(): Point {
    const iter = unwrapIter(this.buffer.getIterAtMark(this.buffer.getInsert()));
    return this.pointAtIter(iter);
  }

  /** Move the primary cursor to `point` (clamped), collapsing any selection. */
  setCursorBufferPosition(point: PointLike): void {
    // Atom semantics: setting *the* cursor collapses to a single one. The vim
    // layer relies on this to drop a visual-block's extra cursors (e.g. leaving
    // insert mode after `ctrl-v I`).
    if (this.extraSelections.length) this.clearExtraSelections();
    this.buffer.placeCursor(this.snapOutOfFold(this.iterAtPoint(point)));
  }

  // --- Fold awareness (the [...] placeholder is atomic + non-editable) --------

  private foldAccess: FoldAccess | null = null;
  private lastCursorOffset = 0;
  private snappingCursor = false;
  // A true read-only viewer (a multibuffer results surface / diff pane): edits are no-ops and
  // input is never enabled — `view.setEditable(false)` alone doesn't suffice, since vim's
  // mode handling re-enables it on insert and normal-mode operators (x/dd/p) mutate the
  // buffer programmatically through `setTextInBufferRange`, bypassing the native editable flag.
  private readOnly = false;
  // Per-row editability gate (the editable diff multibuffer): only some view rows accept edits
  // (new-side real rows), others reject (removed phantom / header / gap). Like `readOnly`,
  // vim operators bypass the native editable tag, so the model must check.
  private editableAt: ((startRow: number, endRow: number) => boolean) | null = null;

  /** Restrict edits to rows where `check(startRow, endRow)` holds (view rows). */
  setEditableCheck(check: ((startRow: number, endRow: number) => boolean) | null): void {
    this.editableAt = check;
  }

  /** Wire the fold projection (the editor passes its SyntaxController's view). */
  setFoldAccess(access: FoldAccess): void {
    this.foldAccess = access;
  }

  /** Reveal folds whose collapsed content matches — so a search finds matches inside
   *  them while leaving non-matching folds closed. */
  revealFoldsMatching(test: (text: string) => boolean): void {
    this.foldAccess?.revealFoldsMatching(test);
  }

  /** MODEL row text (the LSP file's line), falling back to the view when no folds. */
  modelLineTextForRow(row: number): string {
    return this.foldAccess ? this.foldAccess.modelLineText(row) : this.lineTextForBufferRow(row);
  }

  /** Translate a MODEL range (LSP result) into VIEW space for rendering on the buffer. */
  viewRangeFromModel(range: Range): Range {
    if (!this.foldAccess) return Range.fromObject(range);
    const r = Range.fromObject(range);
    return new Range(this.foldAccess.viewPointFromModel(r.start), this.foldAccess.viewPointFromModel(r.end));
  }

  private offsetOf(iter: TextIter): number {
    return iter.getOffset();
  }

  private iterAtOffset(offset: number): TextIter {
    return unwrapIter(this.buffer.getIterAtOffset(offset));
  }

  /** If `iter` lands strictly inside a fold placeholder, return its near/far edge by
   *  travel direction (so a motion jumps over the atomic `[...]`); else `iter`. */
  private snapOutOfFold(iter: TextIter): TextIter {
    if (!this.foldAccess) return iter;
    const off = iter.getOffset();
    const cur = this.offsetOf(unwrapIter(this.buffer.getIterAtMark(this.buffer.getInsert())));
    for (const [p, e] of this.foldAccess.placeholderRanges()) {
      if (off > p && off < e) return this.iterAtOffset(off >= cur ? e : p);
    }
    return iter;
  }

  /** Cursor moved (any source incl. native clicks/arrows): keep the primary caret out
   *  of a placeholder's interior. Only when there's no selection (placeCursor would
   *  otherwise collapse it); selection-driven motions snap via setCursorBufferPosition. */
  private onCursorMoved(): void {
    if (!this.snappingCursor && this.foldAccess) {
      const insert = unwrapIter(this.buffer.getIterAtMark(this.buffer.getInsert()));
      const bound = unwrapIter(this.buffer.getIterAtMark(this.buffer.getSelectionBound()));
      const off = insert.getOffset();
      if (off === bound.getOffset()) {
        for (const [p, e] of this.foldAccess.placeholderRanges()) {
          if (off > p && off < e) {
            this.snappingCursor = true;
            this.buffer.placeCursor(this.iterAtOffset(off >= this.lastCursorOffset ? e : p));
            this.snappingCursor = false;
            break;
          }
        }
      }
      this.lastCursorOffset = this.offsetOf(unwrapIter(this.buffer.getIterAtMark(this.buffer.getInsert())));
    }
    this.refreshCursorStyle();
  }

  // --- Selections & cursors (single, surfaced as arrays) ---------------------

  /** The most recently added selection (Atom semantics) — the primary when there
   *  are no secondaries; for visual-block this is the block's last row. */
  getLastSelection(): Selection {
    return this.extraSelections.length ? this.extraSelections[this.extraSelections.length - 1] : this.selection;
  }

  getSelections(): Selection[] {
    return [this.selection, ...this.extraSelections];
  }

  getSelectionsOrderedByBufferPosition(): Selection[] {
    return this.getSelections()
      .slice()
      .sort((a, b) => a.getBufferRange().start.compare(b.getBufferRange().start));
  }

  getLastCursor(): Cursor {
    return this.getLastSelection().cursor;
  }

  getCursors(): Cursor[] {
    return this.getSelections().map((s) => s.cursor);
  }

  getCursorsOrderedByBufferPosition(): Cursor[] {
    return this.getSelectionsOrderedByBufferPosition().map((s) => s.cursor);
  }

  // --- Secondary selections (visual-block; later multi-cursor) ---------------

  /** Add a secondary selection over `range` and return it. */
  addSelectionForBufferRange(range: RangeLike, options: { reversed?: boolean } = {}): Selection {
    const r = Range.fromObject(range);
    const head = this.buffer.createMark(null, this.iterAtPoint(r.start), false);
    const tail = this.buffer.createMark(null, this.iterAtPoint(r.start), false);
    const selection = new Selection(this, { head, tail });
    this.extraSelections.push(selection);
    selection.setBufferRange(r, options);
    this.emitter.emit('did-add-selection', selection);
    return selection;
  }

  /**
   * Transfer primary-ness from a primary being destroyed onto a surviving
   * selection, so the native marks (and the rendered caret) live on. Called from
   * `Selection.destroy` — the vim layer's `removeSelections({except: head})`
   * destroys every block member but the head, and when the head is a lower row
   * the head is a *secondary* while the primary is among the destroyed.
   *
   * The last extra is chosen: in every blockwise path that removes the primary,
   * the surviving head is the bottom row (the last extra), so the caret lands
   * right and the kept selection's identity is stable. The removed primary is
   * re-backed with the promoted selection's freed anonymous marks, which its
   * `destroy()` then deletes. Returns false when there is no survivor (the
   * primary is the only selection), leaving it in place.
   */
  promoteAnotherToPrimary(oldPrimary: Selection): boolean {
    const target = this.extraSelections[this.extraSelections.length - 1];
    if (!target) return false;
    const head = target.getHeadIter();
    const tail = target.getTailIter();
    const freed = target.getMarkPair(); // target's anonymous marks
    this.removeExtraSelection(target);
    target.rebindMarks(this.buffer.getInsert(), this.buffer.getSelectionBound(), true);
    this.buffer.selectRange(head, tail); // native insert at the head
    oldPrimary.rebindMarks(freed.head, freed.tail, false);
    this.selection = target;
    return true;
  }

  /** Drop a destroyed secondary selection (called from `Selection.destroy`). */
  removeExtraSelection(selection: Selection): void {
    const index = this.extraSelections.indexOf(selection);
    if (index >= 0) this.extraSelections.splice(index, 1);
  }

  /** Destroy every secondary selection (e.g. leaving visual-block). */
  clearExtraSelections(): void {
    for (const selection of this.extraSelections.slice()) selection.destroy();
  }

  /**
   * Repaint the secondary selections (multi-cursor / blockwise): a selection
   * background over each non-empty range, plus a caret per extra cursor so they
   * are visible (the native caret renders only the primary). Called after
   * operations settle and after each multi-cursor insert replication.
   *
   * The caret follows the current cursor *shape*: in normal/visual (block) mode
   * it's a reverse-video block over the head character (a tag); in insert (beam)
   * mode — and wherever there's no glyph to reverse-video (EOL / empty line) — it
   * is drawn by the host as an overlay caret via `onExtraCursors` (beam = a thin
   * bar, matching the primary's insert-mode caret).
   */
  renderExtraSelections(): void {
    if (!this.extraSelectionTag) {
      this.extraSelectionTag = new Gtk.TextTag({
        name: 'vim-extra-selection',
        background: theme.ui.surface.selected,
      });
      this.buffer.getTagTable().add(this.extraSelectionTag);
    }
    if (!this.extraCursorTag) {
      // Same reverse-video styling as the primary block caret.
      this.extraCursorTag = new Gtk.TextTag({
        name: 'vim-extra-cursor',
        background: theme.ui.editor.foreground,
        foreground: theme.ui.editor.background,
      });
      this.buffer.getTagTable().add(this.extraCursorTag);
    }
    const [start, end] = this.buffer.getBounds();
    this.buffer.removeTag(this.extraSelectionTag, start, end);
    this.buffer.removeTag(this.extraCursorTag, start, end);
    const tagTableSize = this.buffer.getTagTable().getSize();
    this.extraSelectionTag.setPriority(tagTableSize - 2);
    this.extraCursorTag.setPriority(tagTableSize - 1); // caret above its own selection bg

    const beam = !this.blockCursor; // insert mode → thin beam carets
    const overlayCarets: Array<{ iter: TextIter; beam: boolean }> = [];
    for (const selection of this.extraSelections) {
      const r = selection.getBufferRange();
      if (!r.isEmpty()) {
        this.buffer.applyTag(this.extraSelectionTag, this.iterAtPoint(r.start), this.iterAtPoint(r.end));
      }
      const headPoint = this.cursorDisplayResolver?.(selection) ?? selection.getHeadBufferPosition();
      const headIter = this.iterAtPoint(headPoint);
      const noGlyph = headIter.endsLine() || headIter.isEnd();
      if (!beam && !noGlyph) {
        // Block caret over the character — a reverse-video tag (cheap, no widget).
        const next = headIter.copy();
        next.forwardChar();
        this.buffer.applyTag(this.extraCursorTag, headIter, next);
      } else {
        // Beam caret, or a block where there's no glyph to cover — host-drawn.
        overlayCarets.push({ iter: headIter, beam });
      }
    }
    this.onExtraCursors?.(overlayCarets);
  }

  getSelectedText(): string {
    return this.selection.getText();
  }

  getSelectedBufferRange(): Range {
    return this.selection.getBufferRange();
  }

  setSelectedBufferRange(range: RangeLike, options: { reversed?: boolean } = {}): void {
    this.selection.setBufferRange(Range.fromObject(range), options);
  }

  getSelectedBufferRanges(): Range[] {
    return this.getSelections().map((s) => s.getBufferRange());
  }

  /**
   * Replace all selections with one per range: the first becomes the primary,
   * the rest secondaries (Atom semantics). `getSelections()` afterward returns
   * them in the same order as `ranges` — the occurrence path relies on this to
   * migrate per-selection mutation state by index.
   */
  setSelectedBufferRanges(ranges: RangeLike[], options: { reversed?: boolean } = {}): void {
    if (!ranges.length) throw new Error('setSelectedBufferRanges: at least one range is required');
    this.clearExtraSelections();
    this.setSelectedBufferRange(ranges[0], options);
    for (let i = 1; i < ranges.length; i++) this.addSelectionForBufferRange(ranges[i], options);
  }

  /** Replace every multi-row selection with one single-row selection per row it
   *  spans (visual-block `I`/`A` over a non-blockwise visual selection). */
  splitSelectionsIntoLines(): void {
    const ranges: Range[] = [];
    for (const range of this.getSelectedBufferRanges()) {
      if (range.start.row === range.end.row) {
        ranges.push(range);
        continue;
      }
      const { start, end } = range;
      ranges.push(new Range(start, new Point(start.row, this.lineLength(start.row))));
      for (let row = start.row + 1; row < end.row; row++) {
        ranges.push(new Range(new Point(row, 0), new Point(row, this.lineLength(row))));
      }
      ranges.push(new Range(new Point(end.row, 0), end));
    }
    this.setSelectedBufferRanges(ranges);
  }

  /**
   * Merge selections that share any buffer row into one spanning selection,
   * destroying the absorbed ones (used by linewise occurrence so adjacent
   * single-line selections collapse into a block). The lowest-positioned
   * selection of each overlapping run survives.
   */
  mergeSelectionsOnSameRows(): void {
    const ordered = this.getSelectionsOrderedByBufferPosition();
    let keeper = ordered[0];
    for (let i = 1; i < ordered.length; i++) {
      const selection = ordered[i];
      const keeperRange = keeper.getBufferRange();
      const range = selection.getBufferRange();
      if (range.start.row <= keeperRange.end.row) {
        keeper.setBufferRange(new Range(keeperRange.start, Point.max(keeperRange.end, range.end)));
        selection.destroy();
      } else {
        keeper = selection;
      }
    }
  }

  // --- Mutation --------------------------------------------------------------

  /** Replace the current selection with `text`, leaving the cursor after it. */
  insertText(text: string): Range {
    return this.selection.insertText(text);
  }

  /**
   * Replace the text in `range` with `text` as one undo step, and return the
   * range the new text occupies.
   */
  setTextInBufferRange(range: RangeLike, text: string): Range {
    const r = Range.fromObject(range);
    // A read-only viewer rejects every edit — this is the single funnel all vim operators
    // (and programmatic edits) route through, so gating it here blocks them all.
    if (this.readOnly) return new Range(r.start, r.start);
    // A partially-editable surface (the multibuffers) rejects edits touching non-editable rows.
    // A range ending at column 0 of `end.row` (a linewise `dd`/`cc`, range `[L,0]–[L+1,0]`) does
    // NOT modify `end.row` — only `L`'s newline — so don't require `end.row` (which may be the next
    // excerpt's first row, a different source) to be editable; gate on the last TOUCHED row.
    if (this.editableAt) {
      const lastTouched = r.end.column === 0 && r.end.row > r.start.row ? r.end.row - 1 : r.end.row;
      if (!this.editableAt(r.start.row, lastTouched)) return new Range(r.start, r.start);
    }
    // An edit spanning a fold placeholder reveals those folds first, then acts on the
    // real (former-folded) text — so deleting/changing a selection that includes a
    // folded region works. Marks keep the edit range across the expansion.
    if (this.foldAccess) {
      const s0 = this.iterAtPoint(r.start).getOffset();
      const e0 = this.iterAtPoint(r.end).getOffset();
      const touched = this.foldAccess.placeholderRanges().filter(([p, pe]) => s0 < pe && e0 > p);
      if (touched.length) {
        const sm = this.buffer.createMark(null, this.iterAtOffset(s0), true);
        const em = this.buffer.createMark(null, this.iterAtOffset(e0), false);
        let revealed = false;
        for (const [p] of touched) revealed = this.foldAccess.unfoldAt(p) || revealed;
        const ns = unwrapIter(this.buffer.getIterAtMark(sm)).getOffset();
        const ne = unwrapIter(this.buffer.getIterAtMark(em)).getOffset();
        this.buffer.deleteMark(sm);
        this.buffer.deleteMark(em);
        // Recurse only if a fold actually opened, else we'd loop forever on the same range.
        if (revealed) {
          return this.setTextInBufferRange(
            new Range(this.pointAtIter(this.iterAtOffset(ns)), this.pointAtIter(this.iterAtOffset(ne))),
            text,
          );
        }
      }
    }
    return this.transact(() => {
      const start = this.iterAtPoint(r.start);
      const end = this.iterAtPoint(r.end);
      if (start.compare(end) !== 0) this.buffer.delete(start, end);

      // `insert` advances the iter to the end of the inserted text, giving us
      // the new range without a second position lookup.
      const insertIter = this.iterAtPoint(r.start);
      const startPoint = this.pointAtIter(insertIter);
      if (text.length > 0) this.buffer.insert(insertIter, text, -1);
      return new Range(startPoint, this.pointAtIter(insertIter));
    });
  }

  /** Move the cursor to the end of its line (just past the last character). */
  moveToEndOfLine(): void {
    const row = this.getCursorBufferPosition().row;
    this.setCursorBufferPosition(this.bufferRangeForBufferRow(row).end);
  }

  /** Move the cursor to column 0 of its line (`gI`). */
  moveToBeginningOfLine(): void {
    this.setCursorBufferPosition(new Point(this.getCursorBufferPosition().row, 0));
  }

  /** Move the cursor to the first non-blank character of its line (or col 0). */
  moveToFirstCharacterOfLine(): void {
    const row = this.getCursorBufferPosition().row;
    const firstNonBlank = this.lineTextForBufferRow(row).search(/\S/);
    this.setCursorBufferPosition(new Point(row, firstNonBlank < 0 ? 0 : firstNonBlank));
  }

  /** The leading whitespace of `row`, verbatim (tabs/spaces as written). */
  leadingWhitespaceForBufferRow(row: number): string {
    return this.lineTextForBufferRow(row).match(/^[\t ]*/)![0];
  }

  /** Open a blank line below the cursor's line and put the cursor on it (`o`),
   *  carrying the current line's indentation (vim `autoindent`). */
  insertNewlineBelow(): void {
    const row = this.getCursorBufferPosition().row;
    const indent = this.leadingWhitespaceForBufferRow(row);
    const lineEnd = this.bufferRangeForBufferRow(row).end;
    this.setTextInBufferRange(new Range(lineEnd, lineEnd), '\n' + indent);
    this.setCursorBufferPosition(new Point(row + 1, indent.length));
  }

  /** Open a blank line above the cursor's line and put the cursor on it (`O`),
   *  carrying the current line's indentation. */
  insertNewlineAbove(): void {
    const row = this.getCursorBufferPosition().row;
    const indent = this.leadingWhitespaceForBufferRow(row);
    const lineStart = new Point(row, 0);
    this.setTextInBufferRange(new Range(lineStart, lineStart), indent + '\n');
    this.setCursorBufferPosition(new Point(row, indent.length));
  }

  /** Duplicate the cursor's line, inserting the copy below; the cursor follows
   *  the copy down (keeping its column). */
  duplicateLineBelow(): void {
    const cursor = this.getCursorBufferPosition();
    const lineText = this.lineTextForBufferRow(cursor.row);
    const lineEnd = this.bufferRangeForBufferRow(cursor.row).end;
    this.transact(() => this.setTextInBufferRange(new Range(lineEnd, lineEnd), '\n' + lineText));
    this.setCursorBufferPosition(new Point(cursor.row + 1, cursor.column));
  }

  /** Duplicate the cursor's line, inserting the copy above; the cursor stays on
   *  the upper copy (keeping its column). */
  duplicateLineAbove(): void {
    const cursor = this.getCursorBufferPosition();
    const lineText = this.lineTextForBufferRow(cursor.row);
    const lineStart = new Point(cursor.row, 0);
    this.transact(() => this.setTextInBufferRange(new Range(lineStart, lineStart), lineText + '\n'));
    this.setCursorBufferPosition(new Point(cursor.row, cursor.column));
  }

  /**
   * `o`/`O` carry indentation themselves (`insertNewlineBelow`/`Above`), so the
   * vim layer's separate auto-indent-empty-rows pass is left off — running it
   * would re-derive `O`'s indent from the wrong reference line.
   */
  get autoIndent(): boolean {
    return false;
  }

  /**
   * A syntactic indent source (tree-sitter — see SyntaxController.indentLevelForRow),
   * injected by TextEditor. When set and it returns a level, it wins; otherwise we
   * fall back to copy-the-line-above.
   */
  private indentSource: ((row: number) => number | null) | null = null;
  setIndentSource(fn: ((row: number) => number | null) | null): void {
    this.indentSource = fn;
  }

  /** The indent level a line at `row` should take: the syntactic level from the
   *  indent source if available, else the nearest non-blank line above it (vim
   *  `autoindent`), or 0 at the top. */
  suggestedIndentForBufferRow(row: number): number {
    const syntactic = this.indentSource?.(row);
    if (syntactic != null) return syntactic;
    for (let r = row - 1; r >= 0; r--) {
      if (!this.isBufferRowBlank(r)) return this.indentationForBufferRow(r);
    }
    return 0;
  }

  /** Re-indent `row` to its suggested level, replacing the existing leading
   *  whitespace; keeps the cursor after the indent when it's on that row. */
  autoIndentBufferRow(row: number): void {
    const indent = this.buildIndentString(this.suggestedIndentForBufferRow(row));
    const current = this.leadingWhitespaceForBufferRow(row);
    if (current === indent) return;
    this.setTextInBufferRange(new Range(new Point(row, 0), new Point(row, current.length)), indent);
    const cursor = this.getCursorBufferPosition();
    if (cursor.row === row && cursor.column <= Math.max(current.length, indent.length)) {
      this.setCursorBufferPosition(new Point(row, indent.length));
    }
  }

  /** Replace `row`'s leading whitespace so it sits at indent level `newLevel`. */
  setIndentationForBufferRow(row: number, newLevel: number): void {
    const indent = this.buildIndentString(Math.max(0, newLevel));
    const current = this.leadingWhitespaceForBufferRow(row);
    if (current === indent) return;
    this.setTextInBufferRange(new Range(new Point(row, 0), new Point(row, current.length)), indent);
  }

  // --- Undo grouping ---------------------------------------------------------

  /** Run `fn`, coalescing every buffer change it makes into a single undo step. */
  transact<T>(fn: () => T): T {
    this.undoTarget.beginUserAction();
    try {
      return fn();
    } finally {
      this.undoTarget.endUserAction();
    }
  }

  /**
   * Open/close an undo group that spans *several* operations, so edits from more
   * than one command coalesce into a single undo step. GTK user actions nest by
   * count, so an inner `transact` (or native edit) keeps the group open until the
   * matching `endUndoGroup`. Use `transact` for a single self-contained edit; use
   * this only when the group must outlive one operation (paste cycling groups the
   * initial paste and each subsequent cycle). Callers MUST balance the pair.
   */
  beginUndoGroup(): void {
    this.undoTarget.beginUserAction();
  }
  endUndoGroup(): void {
    this.undoTarget.endUserAction();
  }

  /**
   * An opaque handle marking "now" in the edit history. Change coalescing is
   * done by `transact` (GTK user actions), so this pairs with
   * `groupChangesSinceCheckpoint` only to satisfy the ported call sites.
   */
  createCheckpoint(): number {
    const id = ++this.checkpointCounter;
    this.checkpointChanges.set(id, []);
    return id;
  }

  groupChangesSinceCheckpoint(checkpoint: number): boolean {
    this.checkpointChanges.delete(checkpoint);
    return true;
  }

  /**
   * The net text change since `checkpoint`, in Atom's aggregated shape
   * (`{start, oldExtent, newExtent, newText}`), or `undefined` if nothing
   * changed. Accurate for the contiguous insert-mode edits it's used on (typed
   * text, an in-place replacement); for interleaved edits at scattered points it
   * reports the bounding region, which is good enough for the insert-text and
   * blockwise-replication callers.
   */
  getChangeSinceCheckpoint(checkpoint: number): AggregatedChange | undefined {
    const changes = this.checkpointChanges.get(checkpoint);
    if (!changes || changes.length === 0) return undefined;

    // `start` is the earliest touched point; nothing before it moves, so it
    // reads the same in original and current coordinates. `end` is in current
    // coordinates — `newText` is simply the buffer text now spanning the region.
    let start = changes[0].newRange.start;
    let end = changes[0].newRange.end;
    let pureInsertion = true;
    for (const change of changes) {
      if (change.oldText.length) pureInsertion = false;
      if (change.oldRange.start.isLessThan(start)) start = change.oldRange.start;
      if (change.newRange.start.isLessThan(start)) start = change.newRange.start;
      if (change.newRange.end.isGreaterThan(end)) end = change.newRange.end;
    }
    const newText = this.getTextInBufferRange(new Range(start, end));
    const newExtent = end.traversalFrom(start);
    // For pure insertions the replaced span is empty; otherwise approximate it by
    // the new extent (an equal-size replacement) — only the rarely-hit insert
    // dot-repeat-with-deletion path depends on this being exact.
    const oldExtent = pureInsertion ? new Point(0, 0) : newExtent;
    return { start, oldExtent, newExtent, newText };
  }

  /**
   * Revert edits made since `checkpoint`. GTK has no checkpoint API, so this is a
   * no-op for now; only the cancel-input operator path (not basic edits) relies
   * on it, and is revisited when that path is exercised.
   */
  revertToCheckpoint(checkpoint: number): void {
    this.checkpointChanges.delete(checkpoint);
  }

  undo(): void {
    this.undoTarget.undo();
  }

  redo(): void {
    this.undoTarget.redo();
  }

  /**
   * A minimal Atom-`TextBuffer`-shaped handle. Only `onDidChangeText` is used (by
   * Undo/Redo to collect changed ranges); it delegates to the model's live
   * change events (see installChangeTracking).
   */
  getBuffer(): { onDidChangeText(callback: (event: BufferChangeEvent) => void): Disposable } {
    return { onDidChangeText: (callback) => this.onDidChangeText(callback) };
  }

  // --- Scanning --------------------------------------------------------------

  /** Scan the whole buffer for `regex`, forward. See `scanInBufferRange`. */
  scan(regex: RegExp, iterator: ScanIterator): void {
    this.scanInBufferRange(regex, new Range(Point.ZERO, this.getEofBufferPosition()), iterator);
  }

  /**
   * Call `iterator` for each `regex` match within `range`, front to back. The
   * iterator receives the match, its text, its buffer `range`, a `stop()` to end
   * early, and a `replace(text)` to substitute the match. Replacements are
   * applied together as one undo step after the scan (high offset to low, so the
   * ranges stay valid); this suits independent substitutions, not edits whose
   * result the scan must re-read.
   */
  scanInBufferRange(regex: RegExp, range: RangeLike, iterator: ScanIterator): void {
    this.runScan(regex, range, iterator, false);
  }

  /** Like `scanInBufferRange`, but visits matches back to front. */
  backwardsScanInBufferRange(regex: RegExp, range: RangeLike, iterator: ScanIterator): void {
    this.runScan(regex, range, iterator, true);
  }

  /**
   * Match `regex` over `range` and drive `iterator`. Tuned so navigation motions
   * (`w`/`e`/`b`/`ge`, which scan toward EOF/BOF for the next match) stay cheap on
   * large buffers — the path that made them crawl was rebuilding every match's
   * Point from offset 0 (O(text²)) and scanning to the buffer edge regardless:
   *
   *  - **Incremental Point conversion.** Match offsets only move forward within a
   *    pass, so one cursor sweeps the text once — converting N matches is O(text),
   *    not O(text) per match.
   *  - **Lazy forward scan** that yields one match at a time and stops the moment
   *    `iterator` calls `stop()` — finding the next word doesn't read to EOF.
   *  - **Windowed backward scan.** Reverse order needs matches collected first, so
   *    rather than read `[BOF, from]`, it sweeps line-aligned windows from the end
   *    and stops once satisfied. Safe because every backward caller's regex is
   *    line-local (word/sentence/find-char/markers), so no match straddles a
   *    line-aligned window boundary.
   */
  private runScan(regex: RegExp, rangeLike: RangeLike, iterator: ScanIterator, reverse: boolean): void {
    const range = Range.fromObject(rangeLike);

    let stopped = false;
    const stop = () => {
      stopped = true;
    };
    const replacements: Array<[Range, string]> = [];
    const visit = (match: RegExpExecArray, matchText: string, hitRange: Range): void => {
      iterator({
        match,
        matchText,
        range: hitRange,
        stop,
        // Defer the edit (applied high→low after the scan), but return the range
        // the new text will occupy — Atom's `replace` contract that callers like
        // Increase/Decrease read back.
        replace: (replacement: string): Range => {
          replacements.push([hitRange, replacement]);
          const lines = replacement.split('\n');
          const end =
            lines.length === 1
              ? new Point(hitRange.start.row, hitRange.start.column + replacement.length)
              : new Point(hitRange.start.row + lines.length - 1, lines[lines.length - 1].length);
          return new Range(hitRange.start, end);
        },
      });
    };

    // Monotonic UTF-16 offset → buffer Point over `text` (starting at `from`).
    // Offsets must be requested non-decreasing — true within one regex pass.
    const makePointAt = (text: string, from: Point) => {
      let i = 0;
      let row = from.row;
      let column = from.column;
      return (offset: number): Point => {
        while (i < offset) {
          const code = text.charCodeAt(i);
          if (code === 10 /* \n */) {
            row++;
            column = 0;
            i += 1;
          } else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(text.charCodeAt(i + 1))) {
            column += 1; // surrogate pair = one codepoint column
            i += 2;
          } else {
            column += 1;
            i += 1;
          }
        }
        return new Point(row, column);
      };
    };
    const freshRegex = () => new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');

    if (!reverse) {
      const text = this.getTextInBufferRange(range);
      const pointAt = makePointAt(text, range.start);
      const re = freshRegex();
      let match: RegExpExecArray | null;
      while (!stopped && (match = re.exec(text)) !== null) {
        const matchText = match[0];
        visit(match, matchText, new Range(pointAt(match.index), pointAt(match.index + matchText.length)));
        if (matchText.length === 0) re.lastIndex++; // don't spin on zero-width matches
      }
    } else {
      // Sweep line-aligned windows from `range.end` back toward `range.start`.
      let windowEnd = range.end;
      while (!stopped && windowEnd.isGreaterThan(range.start)) {
        const startRow = windowEnd.row - BACKWARD_SCAN_WINDOW_ROWS;
        const windowStart = startRow <= range.start.row ? range.start : new Point(startRow, 0);
        const text = this.getTextInBufferRange(new Range(windowStart, windowEnd));
        const pointAt = makePointAt(text, windowStart);
        const re = freshRegex();
        const hits: ScanMatch[] = [];
        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
          const matchText = match[0];
          hits.push({
            match,
            matchText,
            range: new Range(pointAt(match.index), pointAt(match.index + matchText.length)),
          });
          if (matchText.length === 0) re.lastIndex++;
        }
        for (let k = hits.length - 1; k >= 0 && !stopped; k--) visit(hits[k].match, hits[k].matchText, hits[k].range);
        if (windowStart.isEqual(range.start)) break;
        windowEnd = windowStart;
      }
    }

    if (replacements.length > 0) {
      replacements.sort((a, b) => b[0].start.compare(a[0].start));
      this.transact(() => {
        for (const [r, t] of replacements) this.setTextInBufferRange(r, t);
      });
    }
  }

  // --- Markers ---------------------------------------------------------------

  /** A fresh marker layer over this buffer (vim marks, search/flash highlights). */
  addMarkerLayer(): MarkerLayer {
    return new MarkerLayer(this);
  }

  /** Mark a single position on the shared default layer (e.g. `o`/`O` recall). */
  markBufferPosition(point: PointLike): ReturnType<MarkerLayer['markBufferPosition']> {
    return (this.defaultMarkerLayer ??= this.addMarkerLayer()).markBufferPosition(Point.fromObject(point));
  }

  // --- Folding ---------------------------------------------------------------
  // The fold state lives in SyntaxController (the `invisible`-tag mechanism); the
  // host wires it in via setFoldProvider so motions can see/reveal folds without
  // EditorModel depending on SyntaxController directly.

  setFoldProvider(provider: FoldProvider): void {
    this.foldProvider = provider;
  }

  /** Whether `row` is hidden inside a collapsed fold (so motions skip past it). */
  isFoldedAtBufferRow(row: number): boolean {
    return this.foldProvider?.isFoldedAtRow(row) ?? false;
  }

  /** Reveal `row` if a fold hides it (e.g. a motion landed inside a fold). */
  unfoldBufferRow(row: number): void {
    this.foldProvider?.unfoldRow(row);
  }

  /** Every foldable region as a linewise Range (fold motions, `iz`/`az`). */
  getFoldableRanges(): Range[] {
    const ranges = this.foldProvider?.foldableRanges?.() ?? [];
    return ranges.map((r) => new Range(new Point(r.startRow, 0), new Point(r.endRow, 0)));
  }

  /** The function enclosing `point` (whole def + body), as linewise Ranges, or
   *  null when the cursor isn't in a function (or there's no parse tree). */
  getFunctionRange(point: PointLike): FunctionRange | null {
    return this.nodeRange(point, this.foldProvider?.functionRangeAt);
  }

  /** The class enclosing `point` (whole def + body), as linewise Ranges, or null. */
  getClassRange(point: PointLike): FunctionRange | null {
    return this.nodeRange(point, this.foldProvider?.classRangeAt);
  }

  private nodeRange(
    point: PointLike,
    at: ((row: number, column: number) => { outer: { startRow: number; endRow: number }; inner: { startRow: number; endRow: number } } | null) | undefined,
  ): FunctionRange | null {
    const p = Point.fromObject(point);
    const r = at?.(p.row, p.column);
    if (!r) return null;
    const rowRange = (s: { startRow: number; endRow: number }) =>
      new Range(new Point(s.startRow, 0), new Point(s.endRow, this.lineLength(s.endRow)));
    return { outer: rowRange(r.outer), inner: rowRange(r.inner) };
  }

  /**
   * Add an extra cursor one row below the bottom-most cursor, at the same column
   * (clamped to that row's length) — "add cursor below" multi-cursor. Returns
   * the new selection, or null if there's no row below. Repaint with
   * `renderExtraSelections` after.
   */
  addCursorBelow(): Selection | null {
    const cursors = this.getCursorsOrderedByBufferPosition();
    const from = cursors[cursors.length - 1].getBufferPosition();
    const row = from.row + 1;
    if (row > this.getLastBufferRow()) return null;
    const point = new Point(row, Math.min(from.column, this.lineLength(row)));
    return this.addSelectionForBufferRange(new Range(point, point));
  }

  /** "Add cursor above": one row above the top-most cursor, same column. */
  addCursorAbove(): Selection | null {
    const cursors = this.getCursorsOrderedByBufferPosition();
    const from = cursors[0].getBufferPosition();
    const row = from.row - 1;
    if (row < 0) return null;
    const point = new Point(row, Math.min(from.column, this.lineLength(row)));
    return this.addSelectionForBufferRange(new Range(point, point));
  }

  // --- Multi-cursor live edit replication ------------------------------------

  private multiCursorReplication = false;
  private replicatingEdit = false;
  private replicationSub?: Disposable;
  private replicationQueue: BufferChange[] = [];
  private replicationScheduled = false;

  /**
   * Start mirroring the primary cursor's edits onto every extra cursor — so
   * typing (or backspacing) in insert mode with multiple cursors inserts at each
   * cursor incrementally, not only on leaving insert. The vim layer turns this on
   * when entering insert with >1 selection and off on leave.
   *
   * Replication is **deferred** to a microtask rather than run inside the
   * `changed` signal: a buffer mutation invalidates every outstanding `TextIter`,
   * so editing mid-signal would corrupt the originating edit (and a mirror on a
   * line above the primary would shift it). Off-signal, the primary edit has
   * settled and each mirror uses the extra cursor's mark (which tracks edits).
   *
   * The whole insert session is wrapped in one user action so it undoes as a
   * single step: the per-keystroke replication inserts at the extra cursors
   * otherwise break GTK's adjacent-insert coalescing, leaving the primary's
   * keystrokes to undo one character at a time.
   */
  beginMultiCursorEditReplication(): void {
    if (this.multiCursorReplication) return;
    this.multiCursorReplication = true;
    this.undoTarget.beginUserAction();
    this.replicationSub = this.onDidChangeText((event) => {
      if (this.replicatingEdit || this.extraSelections.length === 0) return;
      this.replicationQueue.push(...event.changes);
      if (!this.replicationScheduled) {
        this.replicationScheduled = true;
        queueMicrotask(() => this.flushReplication());
      }
    });
  }

  endMultiCursorEditReplication(): void {
    if (!this.multiCursorReplication) return; // never started / already ended — keep user actions balanced
    if (this.replicationQueue.length) this.flushReplication(); // drain pending synchronously
    this.multiCursorReplication = false;
    this.replicationSub?.dispose();
    this.replicationSub = undefined;
    this.undoTarget.endUserAction(); // close the session-wide undo group opened on begin
  }

  /** Whether live multi-cursor replication is active (the vim layer skips its
   *  leave-insert replay when it is, to avoid double-inserting). */
  isReplicatingMultiCursorEdits(): boolean {
    return this.multiCursorReplication;
  }

  /** Apply the queued primary edits to every extra cursor. Mirrored edits fire
   *  their own change events; `replicatingEdit` keeps them out of the queue. */
  private flushReplication(): void {
    this.replicationScheduled = false;
    const changes = this.replicationQueue;
    this.replicationQueue = [];
    if (!changes.length || this.extraSelections.length === 0) return;
    this.replicatingEdit = true;
    try {
      this.transact(() => {
        for (const change of changes) {
          if (change.oldText === '' && change.newText !== '') {
            // Pure insertion: insert the same text at each extra cursor. Marks have
            // right gravity, so the cursor advances past the inserted text.
            for (const selection of this.extraSelections) {
              const at = selection.getHeadBufferPosition();
              this.setTextInBufferRange(new Range(at, at), change.newText);
            }
          } else if (change.newText === '' && change.oldText !== '') {
            // Pure deletion (backspace): delete the same number of columns before
            // each extra cursor. Skip multi-line deletions (line-join at column 0).
            const { start, end } = change.oldRange;
            if (start.row !== end.row) continue;
            const width = end.column - start.column;
            for (const selection of this.extraSelections) {
              const head = selection.getHeadBufferPosition();
              const from = new Point(head.row, Math.max(0, head.column - width));
              if (from.column === head.column) continue;
              this.setTextInBufferRange(new Range(from, head), '');
            }
          }
          // Replacements (both sides non-empty) are left to the leave-insert path.
        }
      });
    } finally {
      this.replicatingEdit = false;
    }
    this.renderExtraSelections();
  }

  // --- Multi-cursor reconciliation -------------------------------------------

  /**
   * Collapse cursors that have landed on the same position into one (e.g. after
   * a motion drives several cursors to the same spot). The earliest-positioned
   * survivor is kept — the primary wins ties since `getSelections()` lists it
   * first. No-op while single-cursor.
   */
  mergeCursors(): void {
    if (!this.extraSelections.length) return;
    const seen = new Set<string>();
    for (const selection of this.getSelectionsOrderedByBufferPosition()) {
      const head = selection.getHeadBufferPosition();
      const key = `${head.row},${head.column}`;
      if (seen.has(key)) selection.destroy();
      else seen.add(key);
    }
  }

  /**
   * Merge selections whose ranges overlap into one spanning selection,
   * destroying the absorbed ones. Called after a select-motion so overlapping
   * visual selections coalesce. No-op while single-cursor.
   */
  mergeIntersectingSelections(): void {
    if (!this.extraSelections.length) return;
    const ordered = this.getSelectionsOrderedByBufferPosition();
    let keeper = ordered[0];
    for (let i = 1; i < ordered.length; i++) {
      const selection = ordered[i];
      const keeperRange = keeper.getBufferRange();
      const range = selection.getBufferRange();
      if (keeperRange.intersectsWith(range)) {
        keeper.setBufferRange(new Range(keeperRange.start, Point.max(keeperRange.end, range.end)));
        selection.destroy();
      } else {
        keeper = selection;
      }
    }
  }

  /** Whether soft tabs (spaces) are used; selects the column-based motion path
   *  and whether indentation is built from spaces or tabs. Reflects the view. */
  get softTabs(): boolean {
    return this.view.getInsertSpacesInsteadOfTabs();
  }

  /** Display width of a tab stop (used to build/measure indentation). */
  getTabLength(): number {
    return this.view.getTabWidth() || 4;
  }

  /** Apply an indentation style: spaces-vs-tabs and the indent/tab width. */
  setIndentation({ useSpaces, width }: { useSpaces: boolean; width: number }): void {
    this.view.setInsertSpacesInsteadOfTabs(useSpaces);
    this.view.setTabWidth(width);
    (this.view as { setIndentWidth(w: number): void }).setIndentWidth(width);
  }

  /** The indent level of `row` (leading whitespace width ÷ tab length). */
  indentationForBufferRow(row: number): number {
    const leading = this.lineTextForBufferRow(row).match(/^\s*/)![0];
    const tabLength = this.getTabLength();
    let width = 0;
    for (const ch of leading) width += ch === '\t' ? tabLength : 1;
    return width / tabLength;
  }

  /** Whitespace for `level` indent steps (spaces with soft tabs, else tabs). */
  buildIndentString(level: number): string {
    if (this.softTabs) return ' '.repeat(Math.max(0, Math.round(level * this.getTabLength())));
    return '\t'.repeat(Math.max(0, Math.round(level)));
  }

  /** Atom's atomic-soft-tabs feature is not modeled. */
  hasAtomicSoftTabs(): boolean {
    return false;
  }

  /**
   * Syntax scope at a position. Grammar-scope integration for the vim layer is
   * not wired yet, so this reports no scopes (pair-finding falls back to plain
   * text matching).
   */
  scopeDescriptorForBufferPosition(_point: PointLike): { getScopesArray(): string[] } {
    return { getScopesArray: () => [] };
  }

  // --- View surface (mode scoping, input gating, cursor) ---------------------
  //
  // EditorModel doubles as the ported code's `editorElement`: the vim layer
  // drives mode through CSS classes on the view (the KeymapManager matches
  // selectors like `#TextEditor.normal-mode` against them), gates text input
  // per mode, and switches the cursor between block and beam. The CSS methods
  // keep the Atom `editorElement` names so vendored code calls them unchanged.

  addCssClass(name: string): void {
    this.view.addCssClass(name);
  }

  removeCssClass(name: string): void {
    this.view.removeCssClass(name);
  }

  hasCssClass(name: string): boolean {
    return this.view.hasCssClass(name);
  }

  toggleCssClass(name: string, on: boolean): void {
    if (on) this.view.addCssClass(name);
    else this.view.removeCssClass(name);
  }

  /** Enable or disable user text input (normal/visual disable it; insert enables). A
   *  read-only viewer never enables input, whatever the vim mode. */
  setInputEnabled(enabled: boolean): void {
    const allow = enabled && !this.readOnly;
    this.view.setEditable(allow);
    // Mark the view as taking text input while editable, so the keymap releases
    // `space` (the leader prefix) in insert mode but keeps it as a leader in
    // normal/visual mode. See the `.has-text-input` rule in the default keymap.
    this.toggleCssClass('has-text-input', allow);
  }

  /** Make this a read-only viewer: edits no-op and input stays disabled regardless of mode. */
  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    if (readOnly) this.setInputEnabled(false);
  }

  /** Whether this editor rejects edits (a results/diff viewer). */
  isReadOnly(): boolean {
    return this.readOnly;
  }

  /** Set the cursor shape from a `CursorType` value (vim switches per mode). */
  setCursorType(type: (typeof CursorType)[keyof typeof CursorType]): void {
    this.blockCursor = type !== CursorType.BEAM;
    this.refreshCursorStyle();
    // Extra carets follow the same shape (block ↔ beam), so re-render them when
    // the mode switches — e.g. entering insert turns multi-cursor blocks to beams.
    if (this.extraSelections.length) this.renderExtraSelections();
  }

  /** Override where the block caret is painted (`null` = the insert mark). The
   *  caller refreshes; see `cursorDisplayPoint`. */
  setCursorDisplayPoint(point: PointLike | null): void {
    this.cursorDisplayPoint = point ? Point.fromObject(point) : null;
  }

  /** Install the visual caret-position resolver for secondary selections (see
   *  `cursorDisplayResolver`). The vim layer sets this once; `null` restores the
   *  raw-head behavior. */
  setCursorDisplayResolver(resolver: ((selection: Selection) => PointLike | null) | null): void {
    this.cursorDisplayResolver = resolver;
  }

  /**
   * Reflect the editor's focus on the cursor: when the view loses focus the
   * solid block is dropped in favour of the host widget's hollow-rectangle
   * caret (see TextEditor), and restored on focus-in.
   */
  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.refreshCursorStyle();
  }

  /**
   * Re-paint the block cursor at the current cursor position. Called on every
   * mode change and after every operation (the cursor moved). In beam mode (or
   * when the cursor sits at end-of-line with no character to cover), the native
   * caret is shown instead. While unfocused, the block is not painted — the host
   * widget overlays a hollow rectangle in its place.
   */
  refreshCursorStyle(): void {
    const [start, end] = this.buffer.getBounds();
    this.buffer.removeTag(this.cursorTag, start, end);

    if (!this.blockCursor) {
      this.view.setCursorVisible(true);
      this.onCursorOverlay?.('hidden');
      return;
    }

    const iter = this.cursorDisplayPoint
      ? this.iterAtPoint(this.cursorDisplayPoint)
      : unwrapIter(this.buffer.getIterAtMark(this.buffer.getInsert()));

    if (!this.focused) {
      // An inactive editor shows no caret at all (no block, no overlay).
      this.view.setCursorVisible(false);
      this.onCursorOverlay?.('hidden');
      return;
    }

    if (iter.endsLine() || iter.isEnd()) {
      // No glyph to cover (empty line / past end-of-line / end-of-buffer) — a
      // filled overlay block stands in for the reverse-video caret.
      this.view.setCursorVisible(false);
      this.onCursorOverlay?.('filled', iter);
      return;
    }

    let next = iter.copy();
    next.forwardChar();
    // A fold placeholder is one atomic glyph — cover the whole `[...]` when on it.
    if (this.foldAccess) {
      const off = iter.getOffset();
      for (const [p, e] of this.foldAccess.placeholderRanges()) {
        if (off === p) { next = this.iterAtOffset(e); break; }
      }
    }
    // Raise the cursor tag above any syntax tags so its reverse-video foreground
    // wins (tag priority is creation order; syntax tags are created later).
    this.cursorTag.setPriority(this.buffer.getTagTable().getSize() - 1);
    this.buffer.applyTag(this.cursorTag, iter, next);
    this.view.setCursorVisible(false); // the block stands in for the caret
    this.onCursorOverlay?.('hidden', iter);
  }

  focus(): void {
    this.view.grabFocus();
  }

  /**
   * Atom's editor `component` (the rendering layer). The vim layer only reaches
   * for it to await the next render frame (e.g. find highlighting after a jump)
   * or force a synchronous redraw; GtkTextView paints on its own, so these are
   * inert here — `getNextUpdatePromise` resolves immediately.
   */
  get component(): { getNextUpdatePromise(): Promise<void>; updateSync(): void } {
    return {
      getNextUpdatePromise: () => Promise.resolve(),
      updateSync: () => {},
    };
  }

  /**
   * `scroll_to_mark`'s `within_margin` (a fraction of the viewport) sized to ~one
   * line — a small vim-style `scrolloff`. A fixed fraction (e.g. 0.1) is several
   * lines on a tall window, which would fight the line-scroll commands (ctrl-e/y):
   * those keep the cursor a couple of lines from the edge, so a larger margin
   * here re-scrolls the view straight back. Clamped to the legal [0, 0.5] range.
   */
  private scrollMarginFraction(): number {
    const height = this.getHeight();
    return height > 0 ? Math.min(0.49, this.getLineHeightInPixels() / height) : 0;
  }

  /**
   * Scroll the view just enough to keep the cursor (insert mark) on screen. The
   * vim layer drives the cursor with programmatic mark moves, which — unlike
   * interactive editing — don't auto-scroll GtkTextView, so we do it explicitly
   * after the cursor settles. No-op until the view is realized (e.g. in tests).
   */
  scrollCursorOnscreen(): void {
    if (!this.view.getRealized()) return;
    this.view.scrollToMark(this.buffer.getInsert(), this.scrollMarginFraction(), false, 0, 0);
  }

  scrollToCursorPosition(_options?: unknown): void {
    this.scrollCursorOnscreen();
  }

  scrollToBufferPosition(point: PointLike, _options?: unknown): void {
    if (!this.view.getRealized()) return;
    this.view.scrollToIter(this.iterAtPoint(point), this.scrollMarginFraction(), false, 0, 0);
  }

  scrollToScreenPosition(point: PointLike, options?: unknown): void {
    this.scrollToBufferPosition(point, options);
  }

  // --- Viewport & pixel geometry ---------------------------------------------
  //
  // Read-side geometry for the features that need to know what's on screen or
  // where a buffer position lands in pixels: vim H/M/L + scroll commands (visible
  // rows), and popover anchoring for LSP hover / code actions (pixel rect). All
  // require a realized, allocated view, so each falls back gracefully when the
  // view isn't realized (e.g. headless tests). The realized paths use
  // `getVisibleRect`/`getLineAtY`/`getIterLocation`, which need interactive
  // verification.

  /** The topmost buffer row currently visible (row 0 when not realized). */
  getFirstVisibleScreenRow(): number {
    return this.visibleRowRange()[0];
  }

  /** The bottommost buffer row currently visible (last row when not realized). */
  getLastVisibleScreenRow(): number {
    return this.visibleRowRange()[1];
  }

  /** The inclusive `[first, last]` visible buffer rows; whole buffer if unrealized. */
  private visibleRowRange(): [number, number] {
    if (!this.view.getRealized()) return [0, this.getLastBufferRow()];
    const rect = this.view.getVisibleRect() as PixelRect;
    const top = this.bufferRowAtY(rect.y);
    const bottom = this.bufferRowAtY(rect.y + Math.max(0, rect.height - 1));
    return [top, bottom];
  }

  /** The buffer row whose line box contains buffer-coordinate `y`. */
  private bufferRowAtY(y: number): number {
    // get_line_at_y has out-args (iter, line_top); node-gtk returns them as an array.
    const result = this.view.getLineAtY(y);
    const iter = Array.isArray(result) ? result[0] : result;
    return iter.getLine();
  }

  /**
   * The widget-relative pixel rectangle of `point`'s character cell, for
   * anchoring a popover (LSP hover, code actions) at a buffer position. Null when
   * the view isn't realized.
   */
  pixelRectForBufferPosition(point: PointLike): PixelRect | null {
    if (!this.view.getRealized()) return null;
    // Buffer coords → the WIDGET window (accounts for the gutter + scroll offset),
    // mirroring TextEditor's unfocused-caret placement.
    const cell = this.view.getIterLocation(this.iterAtPoint(point)) as PixelRect;
    const [x, y] = this.view.bufferToWindowCoords(Gtk.TextWindowType.WIDGET, cell.x, cell.y);
    return { x, y, width: cell.width, height: cell.height };
  }

  // --- Scrolling (pixel-based, for ctrl-d/u/f/b) -----------------------------
  // Document-pixel coordinates throughout: `getIterLocation`'s y and the vertical
  // adjustment's value share the same scroll-independent space, so the vim Scroll
  // motion can add pixels and convert back via `getLineAtY`.

  /** Document-pixel offset of the viewport's top edge. */
  getScrollTop(): number {
    return this.view.getVadjustment()?.getValue() ?? 0;
  }

  setScrollTop(top: number): void {
    this.view.getVadjustment()?.setValue(top);
  }

  /**
   * Pin `row` to the very top of the viewport by setting the scroll adjustment
   * directly to that line's document-pixel offset — an instant jump, unlike
   * `scrollToBufferPosition` (`scroll_to_iter`), which on a not-yet-laid-out view
   * animates toward an estimate and can undershoot. Needs a realized, laid-out view
   * (the caller defers until `getHeight() > 0`); a no-op otherwise.
   */
  setTopBufferRow(row: number): void {
    if (!this.view.getRealized()) return;
    const loc = this.view.getIterLocation(this.iterAtPoint({ row, column: 0 })) as PixelRect;
    this.setScrollTop(loc.y);
  }

  /** The viewport height in pixels (0 when not realized). */
  getHeight(): number {
    return this.view.getHeight();
  }

  /** Pixel height of one rendered line. Sampled as the MINIMUM Y-range over the first several
   *  lines, not measured on row 0 alone: a block decoration (the diff multibuffer's header/gap
   *  bands) reserves pixels-above/below on its anchor line via a tag — and buffer row 0 always
   *  carries the header band — which inflates that line's Y-range. A plain text line is never
   *  shorter than the base height, so the smallest sampled Y-range is the true single-line height
   *  (used to scroll exactly one line for ctrl-e/ctrl-y). */
  getLineHeightInPixels(): number {
    const sample = Math.min(this.buffer.getLineCount(), LINE_HEIGHT_SAMPLE);
    let min = 0;
    for (let row = 0; row < sample; row++) {
      const range = this.view.getLineYrange(this.iterAtLineStart(row));
      const height = Array.isArray(range) ? range[1] : 0;
      if (height > 0 && (min === 0 || height < min)) min = height;
    }
    return min || DEFAULT_LINE_HEIGHT;
  }

  /** Number of whole lines that fit in the viewport (at least 1). */
  getRowsPerPage(): number {
    return Math.max(1, Math.floor(this.getHeight() / this.getLineHeightInPixels()));
  }

  /** Document-pixel top/left of `point`'s character cell (scroll-independent). */
  pixelPositionForScreenPosition(point: PointLike): { top: number; left: number } {
    const cell = this.view.getIterLocation(this.iterAtPoint(point)) as PixelRect;
    return { top: cell.y, left: cell.x };
  }

  /**
   * One display (soft-wrapped) line up or down from `point`, preserving the
   * visual x-pixel `goalX` (the column a run of `gj`/`gk` aims for). Wrap-aware
   * via the view geometry: it reads the cursor cell's pixel rect and asks the
   * view for the iter one line-height above/below at the goal x. Returns null
   * when the view isn't realized (headless) — callers fall back to a buffer-line
   * step.
   */
  displayLineMove(
    point: PointLike,
    direction: 'up' | 'down',
    goalX: number | null,
  ): { point: Point; goalX: number } | null {
    if (!this.view.getRealized()) return null;
    const iter = this.iterAtPoint(point);
    const x = goalX ?? (this.view.getIterLocation(iter) as PixelRect).x;
    // Move by one DISPLAY (wrapped) row using the view's own layout. This is
    // correct under soft-wrap (a buffer line can span several display rows) AND for
    // mixed-height lines (a scaled Markdown heading is taller than its unscaled
    // `##` markers) — pixel-stepping by the cursor glyph or whole-line height would
    // under/overshoot in those cases. `forward/backward_display_line` mutate the
    // iter in place and return whether it moved (false at the first/last row).
    const moved = direction === 'down'
      ? this.view.forwardDisplayLine(iter)
      : this.view.backwardDisplayLine(iter);
    if (!moved) return null; // already on the first/last display row
    // Those land at the target row's start column; re-snap to the goal visual x on
    // that row so the cursor keeps its column (Vim's goal-column behavior). Probe
    // at the row's MIDDLE y, not its top: get_iter_at_location at an exact row-top
    // boundary returns the row above (the boundary is that row's bottom edge).
    const cell = this.view.getIterLocation(iter) as PixelRect;
    const midY = cell.y + Math.max(1, Math.floor(cell.height / 2));
    const result = this.view.getIterAtLocation(x, midY) as unknown[];
    const target = (Array.isArray(result) ? result : [result]).find(
      (r): r is TextIter => Boolean(r) && typeof (r as TextIter).getLine === 'function',
    );
    if (!target) return null;
    return { point: this.pointAtIter(unwrapIter(target)), goalX: x };
  }

  /** The buffer Point nearest a document-pixel `top` (column 0). */
  screenPositionForPixelPosition(pixel: { top: number }): Point {
    const top = Math.max(0, Math.round(pixel.top));
    // `getLineAtY` needs a realized, laid-out view; off-screen it returns junk.
    // Approximate by uniform line height otherwise (keeps headless a safe no-op).
    const row = this.view.getRealized()
      ? this.bufferRowAtY(top)
      : clamp(Math.round(top / this.getLineHeightInPixels()), 0, this.getLastBufferRow());
    return new Point(row, 0);
  }

  /** Identity stub — see docs/text-editor/coordinates.md. */
  getCursorScreenPosition(): Point {
    return this.getCursorBufferPosition();
  }

  /** Atom's scroll-past-end editor option; not modeled. */
  getScrollPastEnd(): boolean {
    return false;
  }

}

/** A pixel rectangle (`x`/`y` widget-relative for `pixelRectForBufferPosition`). */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One text change, in the Atom `TextBuffer` change shape. `oldRange`/`oldText`
 * describe what was there before, `newRange`/`newText` what replaced it; a pure
 * deletion has an empty `newRange`, a pure insertion an empty `oldRange`.
 */
export interface BufferChange {
  oldRange: Range;
  newRange: Range;
  oldText: string;
  newText: string;
}

/** The event passed to `onDidChangeText`, batching the changes of one edit. */
export interface BufferChangeEvent {
  changes: BufferChange[];
}

/**
 * A run of changes collapsed into one replacement, in Atom's
 * `getChangeSinceCheckpoint` shape: replace `oldExtent` worth of text at `start`
 * with `newText` (which spans `newExtent`).
 */
export interface AggregatedChange {
  start: Point;
  oldExtent: Point;
  newExtent: Point;
  newText: string;
}

/** The argument passed to a scan iterator for each match. */
export interface ScanMatchResult {
  match: RegExpExecArray;
  matchText: string;
  range: Range;
  stop(): void;
  replace(text: string): void;
}

export type ScanIterator = (result: ScanMatchResult) => void;

interface ScanMatch {
  match: RegExpExecArray;
  matchText: string;
  range: Range;
}
