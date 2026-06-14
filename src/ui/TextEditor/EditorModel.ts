/*
 * EditorModel — a buffer-centric editing model over a GtkSource view + buffer.
 *
 * GtkSourceView gives us a widget and a `GtkTextBuffer`, but it speaks in
 * `GtkTextIter`s and byte/char offsets. The vim layer (and everything ported
 * from vim-mode-plus) instead thinks in `Point`s and `Range`s and asks the
 * editor high-level questions ("what's the text on row 4?", "clip this position
 * into the buffer"). EditorModel is that translation layer: a first-class,
 * idiomatic API expressed in quilx `Point`/`Range`, backed by the live buffer.
 *
 * Positions are zero-based `(row, column)` where column is a *character* offset
 * within the line (matching `GtkTextIter` line offsets). This is phase 3a: the
 * position/text foundation. Cursors/selections, mutation, scanning, and markers
 * build on the `Point`↔`TextIter` bridge established here.
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

// Fraction of the visible area to keep as margin when scrolling the cursor into
// view (a small vim-style `scrolloff`).
const SCROLL_MARGIN = 0.1;

export class EditorModel {
  // The vim layer reaches `editorElement.constructor.CursorType`; EditorModel is
  // both the `editor` and the `editorElement`, so it carries it statically.
  static readonly CursorType = CursorType;

  readonly view: SourceView;
  readonly buffer: SourceBuffer;

  // GtkTextBuffer has a single insert/selection-bound pair, so there is exactly
  // one Selection. It is exposed through the array-shaped accessors below.
  private readonly selection: Selection;
  private defaultMarkerLayer?: MarkerLayer;
  private checkpointCounter = 0;
  private readonly emitter = new Emitter();
  private destroyed = false;

  // Block-cursor rendering: GTK has no CSS for a block caret, so normal/visual
  // mode hides the native beam and paints a reverse-video tag over the character
  // under the cursor (cursor color as background, editor background as the glyph
  // color) — the effect a terminal block cursor uses. `blockCursor` is the
  // current mode's desired shape.
  private blockCursor = false;
  private readonly cursorTag: InstanceType<typeof Gtk.TextTag>;

  constructor(view: SourceView, buffer: SourceBuffer) {
    this.view = view;
    this.buffer = buffer;
    this.selection = new Selection(this);
    this.cursorTag = this.createCursorTag();
    this.view.setOverwrite(false); // the block look comes from the tag, not overwrite
  }

  private createCursorTag(): InstanceType<typeof Gtk.TextTag> {
    // Reverse video: fill with the cursor color, draw the glyph in the editor
    // background color so it stays legible on the solid block.
    const tag = new Gtk.TextTag({
      name: 'vim-block-cursor',
      background: theme.ui.fg,
      foreground: theme.ui.bg ?? '#000000',
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

  /** GtkTextBuffer has a single cursor; multi-cursor is not modeled yet. */
  hasMultipleCursors(): boolean {
    return false;
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

  // Selection-change hooks the vim layer subscribes to. They are inert until the
  // visual-mode reconciliation lands (phase 6); returning a Disposable keeps the
  // ported subscription bookkeeping happy.
  onDidAddSelection(_callback: (selection: Selection) => void): Disposable {
    return new Disposable(() => {});
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

  /** `point` clamped to a real position within the buffer. */
  clipBufferPosition(point: PointLike): Point {
    return this.pointAtIter(this.iterAtPoint(point));
  }

  // Screen and buffer coordinates coincide (no soft-wrap; folds ignored for
  // motion purposes), so these conversions are identity + clamp.
  screenPositionForBufferPosition(point: PointLike, _options?: unknown): Point {
    return this.clipBufferPosition(point);
  }

  bufferPositionForScreenPosition(point: PointLike, _options?: unknown): Point {
    return this.clipBufferPosition(point);
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
    this.buffer.placeCursor(this.iterAtPoint(point));
  }

  // --- Selections & cursors (single, surfaced as arrays) ---------------------

  getLastSelection(): Selection {
    return this.selection;
  }

  getSelections(): Selection[] {
    return [this.selection];
  }

  /** With one selection, ordering is trivial. */
  getSelectionsOrderedByBufferPosition(): Selection[] {
    return [this.selection];
  }

  getLastCursor(): Cursor {
    return this.selection.cursor;
  }

  getCursors(): Cursor[] {
    return [this.selection.cursor];
  }

  /** With one cursor, ordering is trivial. */
  getCursorsOrderedByBufferPosition(): Cursor[] {
    return [this.selection.cursor];
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

  /** Open a blank line below the cursor's line and put the cursor on it (`o`). */
  insertNewlineBelow(): void {
    const row = this.getCursorBufferPosition().row;
    const lineEnd = this.bufferRangeForBufferRow(row).end;
    this.setTextInBufferRange(new Range(lineEnd, lineEnd), '\n');
    this.setCursorBufferPosition(new Point(row + 1, 0));
  }

  /** Open a blank line above the cursor's line and put the cursor on it (`O`). */
  insertNewlineAbove(): void {
    const row = this.getCursorBufferPosition().row;
    const lineStart = new Point(row, 0);
    this.setTextInBufferRange(new Range(lineStart, lineStart), '\n');
    this.setCursorBufferPosition(new Point(row, 0));
  }

  /**
   * Whether the view auto-indents new lines. Reported as false to the vim layer
   * so `o`/`O` open a plain blank line (auto-indent-on-open is not modeled yet).
   */
  get autoIndent(): boolean {
    return false;
  }

  /** Auto-indent a row. Not modeled yet; no-op (only reached when `autoIndent`). */
  autoIndentBufferRow(_row: number): void {}

  // --- Undo grouping ---------------------------------------------------------

  /** Run `fn`, coalescing every buffer change it makes into a single undo step. */
  transact<T>(fn: () => T): T {
    this.buffer.beginUserAction();
    try {
      return fn();
    } finally {
      this.buffer.endUserAction();
    }
  }

  /**
   * An opaque handle marking "now" in the edit history. Change coalescing is
   * done by `transact` (GTK user actions), so this pairs with
   * `groupChangesSinceCheckpoint` only to satisfy the ported call sites.
   */
  createCheckpoint(): number {
    return ++this.checkpointCounter;
  }

  groupChangesSinceCheckpoint(_checkpoint: number): boolean {
    return true;
  }

  /**
   * Revert edits made since `checkpoint`. GTK has no checkpoint API, so this is a
   * no-op for now; only the cancel-input operator path (not basic edits) relies
   * on it, and is revisited when that path is exercised.
   */
  revertToCheckpoint(_checkpoint: number): void {}

  undo(): void {
    this.buffer.undo();
  }

  redo(): void {
    this.buffer.redo();
  }

  /**
   * A minimal Atom-`TextBuffer`-shaped handle. Only `onDidChangeText` is used so
   * far (by Undo/Redo to collect changed ranges); GtkTextBuffer has no equivalent
   * event here, so it is an inert subscription — fine while the undo/redo
   * cursor-positioning and flash configs are off.
   */
  getBuffer(): { onDidChangeText(callback: (event: unknown) => void): Disposable } {
    return { onDidChangeText: () => new Disposable(() => {}) };
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
    this.iterateMatches(this.collectMatches(regex, range), iterator);
  }

  /** Like `scanInBufferRange`, but visits matches back to front. */
  backwardsScanInBufferRange(regex: RegExp, range: RangeLike, iterator: ScanIterator): void {
    this.iterateMatches(this.collectMatches(regex, range).reverse(), iterator);
  }

  private collectMatches(regex: RegExp, rangeLike: RangeLike): ScanMatch[] {
    const range = Range.fromObject(rangeLike);
    const text = this.getTextInBufferRange(range);
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    const matches: ScanMatch[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const matchText = match[0];
      const start = this.pointAtTextOffset(range.start, text, match.index);
      const end = this.pointAtTextOffset(range.start, text, match.index + matchText.length);
      matches.push({ match, matchText, range: new Range(start, end) });
      if (matchText.length === 0) re.lastIndex++; // don't spin on zero-width matches
    }
    return matches;
  }

  private iterateMatches(matches: ScanMatch[], iterator: ScanIterator): void {
    let stopped = false;
    const stop = () => {
      stopped = true;
    };
    const replacements: Array<[Range, string]> = [];

    for (const hit of matches) {
      iterator({
        match: hit.match,
        matchText: hit.matchText,
        range: hit.range,
        stop,
        replace: (text: string) => replacements.push([hit.range, text]),
      });
      if (stopped) break;
    }

    if (replacements.length > 0) {
      replacements.sort((a, b) => b[0].start.compare(a[0].start));
      this.transact(() => {
        for (const [range, text] of replacements) this.setTextInBufferRange(range, text);
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

  // --- Folding (deferred) ----------------------------------------------------
  // Real fold integration with SyntaxController lands in a later phase; motions
  // treat the buffer as unfolded for now.

  isFoldedAtBufferRow(_row: number): boolean {
    return false;
  }

  unfoldBufferRow(_row: number): void {}

  // --- Multi-cursor reconciliation (single cursor: no-ops) -------------------

  mergeCursors(): void {}
  mergeIntersectingSelections(): void {}

  /** Whether soft tabs (spaces) are used; selects the column-based motion path. */
  get softTabs(): boolean {
    return true;
  }

  /** Display width of a tab stop (used to build/measure indentation). */
  getTabLength(): number {
    return this.view.getTabWidth() || 4;
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
  // selectors like `GtkSourceView.normal-mode` against them), gates text input
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

  /** Enable or disable user text input (normal/visual disable it; insert enables). */
  setInputEnabled(enabled: boolean): void {
    this.view.setEditable(enabled);
    // Mark the view as taking text input while editable, so the keymap releases
    // `space` (the leader prefix) in insert mode but keeps it as a leader in
    // normal/visual mode. See the `.has-text-input` rule in the default keymap.
    this.toggleCssClass('has-text-input', enabled);
  }

  /** Set the cursor shape from a `CursorType` value (vim switches per mode). */
  setCursorType(type: (typeof CursorType)[keyof typeof CursorType]): void {
    this.blockCursor = type !== CursorType.BEAM;
    this.refreshCursorStyle();
  }

  /**
   * Re-paint the block cursor at the current cursor position. Called on every
   * mode change and after every operation (the cursor moved). In beam mode (or
   * when the cursor sits at end-of-line with no character to cover), the native
   * caret is shown instead.
   */
  refreshCursorStyle(): void {
    const [start, end] = this.buffer.getBounds();
    this.buffer.removeTag(this.cursorTag, start, end);

    if (!this.blockCursor) {
      this.view.setCursorVisible(true);
      return;
    }

    const iter = unwrapIter(this.buffer.getIterAtMark(this.buffer.getInsert()));
    if (iter.endsLine() || iter.isEnd()) {
      // Nothing to cover (EOL / empty line / EOF) — fall back to the native caret.
      this.view.setCursorVisible(true);
      return;
    }
    const next = iter.copy();
    next.forwardChar();
    // Raise the cursor tag above any syntax tags so its reverse-video foreground
    // wins (tag priority is creation order; syntax tags are created later).
    this.cursorTag.setPriority(this.buffer.getTagTable().getSize() - 1);
    this.buffer.applyTag(this.cursorTag, iter, next);
    this.view.setCursorVisible(false); // the block stands in for the caret
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
   * Scroll the view just enough to keep the cursor (insert mark) on screen. The
   * vim layer drives the cursor with programmatic mark moves, which — unlike
   * interactive editing — don't auto-scroll GtkTextView, so we do it explicitly
   * after the cursor settles. No-op until the view is realized (e.g. in tests).
   */
  scrollCursorOnscreen(): void {
    if (!this.view.getRealized()) return;
    this.view.scrollToMark(this.buffer.getInsert(), SCROLL_MARGIN, false, 0, 0);
  }

  scrollToCursorPosition(_options?: unknown): void {
    this.scrollCursorOnscreen();
  }

  scrollToBufferPosition(point: PointLike, _options?: unknown): void {
    if (!this.view.getRealized()) return;
    this.view.scrollToIter(this.iterAtPoint(point), SCROLL_MARGIN, false, 0, 0);
  }

  scrollToScreenPosition(point: PointLike, options?: unknown): void {
    this.scrollToBufferPosition(point, options);
  }

  /** The buffer Point at character `offset` into `text`, which begins at `start`. */
  private pointAtTextOffset(start: Point, text: string, offset: number): Point {
    let row = start.row;
    let lineStart = 0;
    for (let i = 0; i < offset; i++) {
      if (text.charCodeAt(i) === 10 /* \n */) {
        row++;
        lineStart = i + 1;
      }
    }
    const column = (row === start.row ? start.column : 0) + (offset - lineStart);
    return new Point(row, column);
  }
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
