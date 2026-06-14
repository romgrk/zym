/*
 * Selection — the span between the buffer's "insert" (head) and
 * "selection-bound" (tail) marks, plus its Cursor.
 *
 * GtkTextBuffer supports a single selection, so an EditorModel owns exactly one
 * Selection, surfaced through `getSelections()` as a one-element array. The head
 * is where the cursor is and the tail is the fixed anchor; a selection is
 * *reversed* when the head sits before the tail (it grew leftward/upward). All
 * mutation routes through `EditorModel` so it shares the one undo-grouping path.
 */
import { Point } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';
import { unwrapIter } from './iter.ts';
import { Cursor } from './Cursor.ts';
import type { EditorModel } from './EditorModel.ts';

export interface SetBufferRangeOptions {
  /** Place the head (cursor) at the start of the range rather than the end. */
  reversed?: boolean;
}

export class Selection {
  readonly editor: EditorModel;
  readonly cursor: Cursor;
  goalColumn: number | null = null;

  // While true, moving the cursor extends the selection (moves the head mark
  // only) instead of collapsing it. Set during `modifySelection`.
  modifying = false;

  constructor(editor: EditorModel) {
    this.editor = editor;
    this.cursor = new Cursor(editor, this);
  }

  /**
   * Run `fn` while extending the selection: cursor moves inside `fn` move the
   * head (insert mark) and leave the tail (anchor) put. This is how a motion
   * grows an operator's target range (e.g. the `w` in `dw`).
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

  getHeadBufferPosition(): Point {
    const { buffer } = this.editor;
    return this.editor.pointAtIter(unwrapIter(buffer.getIterAtMark(buffer.getInsert())));
  }

  getTailBufferPosition(): Point {
    const { buffer } = this.editor;
    return this.editor.pointAtIter(unwrapIter(buffer.getIterAtMark(buffer.getSelectionBound())));
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

  /** With a single selection, it is always the last one. */
  isLastSelection(): boolean {
    return true;
  }

  /**
   * Atom destroys transient extra selections; GtkTextBuffer has only one, which
   * persists, so this is a no-op. (The mutation manager only destroys selections
   * created after the `will-select` checkpoint, which the lone selection isn't.)
   */
  destroy(): void {}

  /** True when the head is before the tail (the selection grew backward). */
  isReversed(): boolean {
    return !this.isEmpty() && this.getHeadBufferPosition().isLessThan(this.getTailBufferPosition());
  }

  setBufferRange(range: Range, options: SetBufferRangeOptions = {}): void {
    const { buffer } = this.editor;
    const startIter = this.editor.iterAtPoint(range.start);
    const endIter = this.editor.iterAtPoint(range.end);
    // selectRange(insert, bound): the first iter becomes the head (cursor).
    if (options.reversed) buffer.selectRange(startIter, endIter);
    else buffer.selectRange(endIter, startIter);
  }

  getText(): string {
    return this.editor.getTextInBufferRange(this.getBufferRange());
  }

  /** Collapse the selection to its head, leaving the cursor there. */
  clear(): void {
    this.editor.setCursorBufferPosition(this.getHeadBufferPosition());
  }

  /** Replace the selected text with `text`, leaving the cursor after it. */
  insertText(text: string): Range {
    const range = this.editor.setTextInBufferRange(this.getBufferRange(), text);
    this.editor.setCursorBufferPosition(range.end);
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
