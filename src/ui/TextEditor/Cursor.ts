/*
 * Cursor — the head of a Selection, expressed as a buffer Point.
 *
 * GtkTextBuffer has a single insertion point (the "insert" mark), so an editor
 * has exactly one Cursor today; it is surfaced through `EditorModel.getCursors()`
 * as a one-element array so ported vim-mode-plus code (which assumes there may be
 * many) runs unchanged. `goalColumn` remembers the column an up/down motion is
 * aiming for across short lines; it is consumed by the movement layer (phase 3c).
 */
import { Point } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';
import { unwrapIter, clamp } from './iter.ts';
import type { EditorModel } from './EditorModel.ts';
import type { Selection } from './Selection.ts';

export class Cursor {
  readonly editor: EditorModel;
  readonly selection: Selection;
  goalColumn: number | null = null;

  constructor(editor: EditorModel, selection: Selection) {
    this.editor = editor;
    this.selection = selection;
  }

  getBufferPosition(): Point {
    const { buffer } = this.editor;
    return this.editor.pointAtIter(unwrapIter(buffer.getIterAtMark(buffer.getInsert())));
  }

  /**
   * Move the cursor to `point` (clamped), collapsing any selection. Clears the
   * vertical-motion `goalColumn` — an explicit/horizontal move resets the target.
   */
  setBufferPosition(point: Point): void {
    this.goalColumn = null;
    this.editor.setCursorBufferPosition(point);
  }

  getBufferRow(): number {
    return this.getBufferPosition().row;
  }

  getBufferColumn(): number {
    return this.getBufferPosition().column;
  }

  isAtBeginningOfLine(): boolean {
    return this.getBufferColumn() === 0;
  }

  isAtEndOfLine(): boolean {
    const position = this.getBufferPosition();
    return position.column === this.editor.lineTextForBufferRow(position.row).length;
  }

  /** With a single cursor there is only ever one, so it is always the last. */
  isLastCursor(): boolean {
    return true;
  }

  /** The range of the line the cursor is on. */
  getCurrentLineBufferRange(options: { includeNewline?: boolean } = {}): Range {
    return this.editor.bufferRangeForBufferRow(this.getBufferRow(), options);
  }

  moveToBeginningOfLine(): void {
    this.setBufferPosition(new Point(this.getBufferRow(), 0));
  }

  /** Jump to the first non-whitespace character of the line (or column 0 if blank). */
  moveToFirstCharacterOfLine(): void {
    const row = this.getBufferRow();
    const firstNonBlank = this.editor.lineTextForBufferRow(row).search(/\S/);
    this.setBufferPosition(new Point(row, firstNonBlank < 0 ? 0 : firstNonBlank));
  }

  moveToEndOfLine(): void {
    const row = this.getBufferRow();
    this.setBufferPosition(new Point(row, this.editor.lineTextForBufferRow(row).length));
  }

  // --- Directional movement --------------------------------------------------

  /**
   * Move left `count` characters. With `allowWrap`, moving left from column 0
   * wraps to the end of the previous line; otherwise it stops at column 0.
   */
  moveLeft(count = 1, options: { allowWrap?: boolean } = {}): void {
    let { row, column } = this.getBufferPosition();
    for (let i = 0; i < count; i++) {
      if (column > 0) column--;
      else if (options.allowWrap && row > 0) column = this.editor.lineTextForBufferRow(--row).length;
      else break;
    }
    this.setBufferPosition(new Point(row, column));
  }

  /**
   * Move right `count` characters. With `allowWrap`, moving right from a line's
   * end wraps to the start of the next line; otherwise it stops at line end.
   */
  moveRight(count = 1, options: { allowWrap?: boolean } = {}): void {
    let { row, column } = this.getBufferPosition();
    const lastRow = this.editor.getLastBufferRow();
    for (let i = 0; i < count; i++) {
      const length = this.editor.lineTextForBufferRow(row).length;
      if (column < length) column++;
      else if (options.allowWrap && row < lastRow) {
        row++;
        column = 0;
      } else break;
    }
    this.setBufferPosition(new Point(row, column));
  }

  moveUp(count = 1): void {
    this.moveVertically(-count);
  }

  moveDown(count = 1): void {
    this.moveVertically(count);
  }

  /**
   * Move `delta` rows, keeping the column at the remembered `goalColumn` so the
   * cursor returns to its target column after passing through shorter lines
   * (clearing the goal would make vertical motion "stick" to short lines).
   */
  private moveVertically(delta: number): void {
    const position = this.getBufferPosition();
    if (this.goalColumn == null) this.goalColumn = position.column;
    const goal = this.goalColumn;

    const row = clamp(position.row + delta, 0, this.editor.getLastBufferRow());
    const column = Math.min(goal, this.editor.lineTextForBufferRow(row).length);
    this.editor.setCursorBufferPosition(new Point(row, column));
    this.goalColumn = goal; // setCursorBufferPosition doesn't touch it; be explicit
  }
}
