/*
 * Selection — the span between a "head" (cursor) and "tail" (anchor) mark, plus
 * its Cursor. A selection is *reversed* when the head sits before the tail (it
 * grew leftward/upward). All mutation routes through `EditorModel` so it shares
 * the one undo-grouping path.
 *
 * The *primary* selection is backed by GtkTextBuffer's native "insert" /
 * "selection-bound" marks (so GtkTextView renders it). *Secondary* selections —
 * used for visual-block (one per block row) and, later, multi-cursor — carry
 * their own anonymous marks and are rendered by `EditorModel` as decorations.
 * The two cases differ only in how the marks move (native `placeCursor`/
 * `selectRange` for the primary; `moveMark` for secondaries).
 */
import { Point } from '../../text/Point.ts';
import { Range, type RangeLike } from '../../text/Range.ts';
import { unwrapIter, type TextIter, type TextMark } from './iter.ts';
import { Cursor } from './Cursor.ts';
import { Emitter, type Disposable } from '../../util/eventKit.ts';
import type { EditorModel } from './EditorModel.ts';

export interface SetBufferRangeOptions {
  /** Place the head (cursor) at the start of the range rather than the end. */
  reversed?: boolean;
}

export class Selection {
  readonly editor: EditorModel;
  readonly cursor: Cursor;
  // Whether this selection is backed by the buffer's native insert/selection-bound
  // marks (so GtkTextView renders it). Not `readonly`: when the primary is removed
  // while secondaries remain, primary-ness is transferred onto a survivor — see
  // `EditorModel.promoteAnotherToPrimary`.
  isPrimary: boolean;
  goalColumn: number | null = null;
  // Stashed by the mouse-interaction layer (shift+click) to preserve the
  // pre-click tail screen range; see VimState.observeMouse.
  initialScreenRange?: Range;

  // While true, moving the cursor extends the selection (moves the head mark
  // only) instead of collapsing it. Set during `modifySelection`.
  modifying = false;

  private headMark: TextMark;
  private tailMark: TextMark;
  private destroyed = false;
  private readonly emitter = new Emitter();
  // Captured on destroy so position queries still answer afterwards (matching
  // Atom, where a destroyed marker keeps reporting its last range). The vim layer
  // reads member cursors in an `onDidFinishOperation` hook that runs *after* a
  // blockwise mutation has torn the member selections down.
  private lastHeadPosition?: Point;
  private lastTailPosition?: Point;

  /** Without `marks`, this is the primary selection (native insert/bound). */
  constructor(editor: EditorModel, marks?: { head: TextMark; tail: TextMark }) {
    this.editor = editor;
    if (marks) {
      this.headMark = marks.head;
      this.tailMark = marks.tail;
      this.isPrimary = false;
    } else {
      this.headMark = editor.buffer.getInsert();
      this.tailMark = editor.buffer.getSelectionBound();
      this.isPrimary = true;
    }
    this.cursor = new Cursor(editor, this);
  }

  /**
   * Run `fn` while extending the selection: cursor moves inside `fn` move the
   * head mark and leave the tail (anchor) put. This is how a motion grows an
   * operator's target range (e.g. the `w` in `dw`).
   */
  modifySelection(fn: () => void): void {
    const wasModifying = this.modifying;
    this.modifying = true;
    try {
      fn();
    } finally {
      this.modifying = wasModifying;
    }
  }

  getHeadIter(): TextIter {
    return unwrapIter(this.editor.buffer.getIterAtMark(this.headMark));
  }

  getTailIter(): TextIter {
    return unwrapIter(this.editor.buffer.getIterAtMark(this.tailMark));
  }

  getHeadBufferPosition(): Point {
    if (this.destroyed) return this.lastHeadPosition!;
    return this.editor.pointAtIter(this.getHeadIter());
  }

  getTailBufferPosition(): Point {
    if (this.destroyed) return this.lastTailPosition!;
    return this.editor.pointAtIter(this.getTailIter());
  }

  // --- Mark movement (primary uses native selection; secondary moves marks) --

  /** Move the head mark to `iter`, keeping the tail anchored (extends). */
  moveHead(iter: TextIter): void {
    this.editor.buffer.moveMark(this.headMark, iter);
  }

  /** Collapse the selection onto `iter` (both marks). */
  collapseTo(iter: TextIter): void {
    if (this.isPrimary) {
      this.editor.buffer.placeCursor(iter);
    } else {
      this.editor.buffer.moveMark(this.headMark, iter);
      this.editor.buffer.moveMark(this.tailMark, iter);
    }
  }

  private setHeadTail(headIter: TextIter, tailIter: TextIter): void {
    if (this.isPrimary) {
      this.editor.buffer.selectRange(headIter, tailIter); // first iter becomes the head
    } else {
      this.editor.buffer.moveMark(this.headMark, headIter);
      this.editor.buffer.moveMark(this.tailMark, tailIter);
    }
  }

  getBufferRange(): Range {
    return new Range(this.getHeadBufferPosition(), this.getTailBufferPosition());
  }

  /** The inclusive `[startRow, endRow]` the selection spans. */
  getBufferRowRange(): [number, number] {
    const range = this.getBufferRange();
    return [range.start.row, range.end.row];
  }

  isEmpty(): boolean {
    return this.getHeadBufferPosition().isEqual(this.getTailBufferPosition());
  }

  isLastSelection(): boolean {
    return this.editor.getLastSelection() === this;
  }

  /** @internal The mark pair currently backing this selection. */
  getMarkPair(): { head: TextMark; tail: TextMark } {
    return { head: this.headMark, tail: this.tailMark };
  }

  /** @internal Re-back this selection with a different mark pair and role. Used
   *  by `EditorModel.promoteAnotherToPrimary` to move the native marks (and the
   *  rendered caret) from a removed primary onto a surviving selection. */
  rebindMarks(head: TextMark, tail: TextMark, isPrimary: boolean): void {
    this.headMark = head;
    this.tailMark = tail;
    this.isPrimary = isPrimary;
  }

  /** Destroy this selection (drop it from the editor, free its marks). The
   *  primary owns the buffer's native marks, which can't be deleted; when it is
   *  removed while secondaries remain, primary-ness is first transferred onto a
   *  survivor (this selection then holds that survivor's freed anonymous marks).
   *  If the primary is the only selection, this is a no-op — it persists. */
  destroy(): void {
    if (this.destroyed) return;
    // Snapshot before any mark juggling (promotion rebinds this husk's marks),
    // so post-destroy position reads return this selection's actual last range.
    this.lastHeadPosition = this.getHeadBufferPosition();
    this.lastTailPosition = this.getTailBufferPosition();
    if (this.isPrimary && !this.editor.promoteAnotherToPrimary(this)) return;
    this.destroyed = true;
    this.editor.buffer.deleteMark(this.headMark);
    this.editor.buffer.deleteMark(this.tailMark);
    this.editor.removeExtraSelection(this);
    this.emitter.emit('did-destroy');
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Fires when this selection is destroyed (multi-cursor / blockwise teardown).
   *  The register manager uses it to drop per-selection clipboard state. */
  onDidDestroy(callback: () => void): Disposable {
    return this.emitter.on('did-destroy', callback as (value: unknown) => void);
  }

  /** Scroll the view to keep this selection's head on screen — or land it at the configured
   *  center fraction when `center` is set. See docs/text-editor/index.md (Centering). */
  autoscroll(options?: { center?: boolean }): void {
    if (options?.center) this.editor.centerCursor();
    else this.editor.scrollCursorOnscreen();
  }

  /** True when the head is before the tail (the selection grew backward). */
  isReversed(): boolean {
    return !this.isEmpty() && this.getHeadBufferPosition().isLessThan(this.getTailBufferPosition());
  }

  /** Order against `other` by buffer range (start, then end). Mirrors Atom's
   *  `Selection.compare`; used to sort selections by buffer position. */
  compare(other: Selection): -1 | 0 | 1 {
    return this.getBufferRange().compare(other.getBufferRange());
  }

  setBufferRange(range: RangeLike, options: SetBufferRangeOptions = {}): void {
    // Coerce — the vim layer (e.g. BlockwiseSelection) passes `[[r,c],[r,c]]`.
    const r = Range.fromObject(range);
    // Matching Atom: when `reversed` isn't given, preserve the selection's
    // current orientation. The vim layer relies on this — linewise visual
    // re-expands (applyWise) and re-normalizes the selection without re-stating
    // reversed each time, so forcing head-at-end here would flip an upward
    // (reversed) selection and collapse its far end on the next motion.
    const reversed = options.reversed ?? this.isReversed();
    const startIter = this.editor.iterAtPoint(r.start);
    const endIter = this.editor.iterAtPoint(r.end);
    if (reversed) this.setHeadTail(startIter, endIter);
    else this.setHeadTail(endIter, startIter);
  }

  getText(): string {
    return this.editor.getTextInBufferRange(this.getBufferRange());
  }

  /** Collapse the selection to its head, leaving the cursor there. */
  clear(): void {
    this.collapseTo(this.getHeadIter());
  }

  /** Extend the selection `columnCount` columns to the right (no line wrap).
   *  Mirrors Atom's `Selection.selectRight`; used by visual-block insert repeat. */
  selectRight(columnCount = 1): void {
    this.modifySelection(() => this.cursor.moveRight(columnCount));
  }

  /** Replace the selected text with `text`, leaving the cursor after it. */
  insertText(text: string): Range {
    const range = this.editor.setTextInBufferRange(this.getBufferRange(), text);
    this.collapseTo(this.editor.iterAtPoint(range.end));
    return range;
  }

  deleteSelectedText(): void {
    this.editor.setTextInBufferRange(this.getBufferRange(), '');
  }

  // --- Linewise edits (indent / outdent / join) ------------------------------

  /** The `[startRow, endRow]` to edit linewise, dropping a trailing row the
   *  selection only touches at column 0 (so a `(r,0)-(r+1,0)` span is just `r`). */
  private linewiseRowRange(): [number, number] {
    const range = this.getBufferRange();
    let endRow = range.end.row;
    if (endRow > range.start.row && range.end.column === 0) endRow -= 1;
    return [range.start.row, endRow];
  }

  /** Toggle line comments on every spanned row (vim `g c`). Blank rows are left
   *  alone; the delimiters come from the editor's comment-spec source. */
  toggleLineComments(): void {
    const [startRow, endRow] = this.linewiseRowRange();
    this.editor.toggleLineCommentsForBufferRows(startRow, endRow);
  }

  /** Indent every spanned row by one level (`>`). Blank rows are left alone. */
  indentSelectedRows(): void {
    const [startRow, endRow] = this.linewiseRowRange();
    const indent = this.editor.buildIndentString(1);
    this.editor.transact(() => {
      for (let row = endRow; row >= startRow; row--) {
        if (this.editor.lineTextForBufferRow(row).length === 0) continue;
        const start = new Point(row, 0);
        this.editor.setTextInBufferRange(new Range(start, start), indent);
      }
    });
  }

  /** Outdent every spanned row by one level (`<`): a leading tab or up to one
   *  tab-width of leading spaces. */
  outdentSelectedRows(): void {
    const [startRow, endRow] = this.linewiseRowRange();
    const tabLength = this.editor.getTabLength();
    this.editor.transact(() => {
      for (let row = endRow; row >= startRow; row--) {
        const line = this.editor.lineTextForBufferRow(row);
        let removeCols = 0;
        if (line[0] === '\t') removeCols = 1;
        else while (removeCols < tabLength && line[removeCols] === ' ') removeCols++;
        if (removeCols > 0) {
          this.editor.setTextInBufferRange(new Range(new Point(row, 0), new Point(row, removeCols)), '');
        }
      }
    });
  }

  /** Join the spanned rows into one, replacing each newline (and the next line's
   *  leading whitespace) with a single space; an empty selection joins with the
   *  following line. */
  joinLines(): void {
    const range = this.getBufferRange();
    const startRow = range.start.row;
    let endRow = range.end.row;
    if (startRow === endRow) endRow = startRow + 1; // empty/single-line: join next
    if (endRow > this.editor.getLastBufferRow()) return;
    this.editor.transact(() => {
      for (let row = endRow - 1; row >= startRow; row--) {
        const lineEnd = this.editor.bufferRangeForBufferRow(row).end;
        const nextLine = this.editor.lineTextForBufferRow(row + 1);
        const leading = nextLine.match(/^\s*/)![0].length;
        const sep = nextLine.length === leading ? '' : ' '; // no trailing space onto a blank line
        this.editor.setTextInBufferRange(new Range(lineEnd, new Point(row + 1, leading)), sep);
      }
    });
  }
}
