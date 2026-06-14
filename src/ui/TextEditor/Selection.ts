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

  constructor(editor: EditorModel) {
    this.editor = editor;
    this.cursor = new Cursor(editor, this);
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
}
