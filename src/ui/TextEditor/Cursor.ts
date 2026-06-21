/*
 * Cursor — the head of a Selection, expressed as a buffer Point.
 *
 * GtkTextBuffer has a single insertion point (the "insert" mark), so an editor
 * has exactly one Cursor today; it is surfaced through `EditorModel.getCursors()`
 * as a one-element array so ported vim-mode-plus code (which assumes there may be
 * many) runs unchanged. `goalColumn` remembers the column an up/down motion is
 * aiming for across short lines; it is consumed by the movement layer (phase 3c).
 */
import { Point, type PointLike } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';
import { clamp } from './iter.ts';
import { DEFAULT_NON_WORD_CHARACTERS } from './vim/utils.ts';
import type { EditorModel } from './EditorModel.ts';
import type { Selection } from './Selection.ts';

const escapeRegExp = (s: string): string => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

export class Cursor {
  readonly editor: EditorModel;
  readonly selection: Selection;
  goalColumn: number | null = null;
  // The visual x-pixel a run of display-line motions (`gj`/`gk`) aims for, the
  // wrap-aware analogue of `goalColumn`. Cleared by any explicit/horizontal move.
  goalPixelX: number | null = null;

  constructor(editor: EditorModel, selection: Selection) {
    this.editor = editor;
    this.selection = selection;
  }

  getBufferPosition(): Point {
    return this.selection.getHeadBufferPosition();
  }

  /** Screen and buffer positions coincide (no soft-wrap / folds). */
  getScreenPosition(): Point {
    return this.getBufferPosition();
  }

  getScreenRow(): number {
    return this.getBufferRow();
  }

  /**
   * Move the cursor to `point` (clamped), collapsing any selection. Clears the
   * vertical-motion `goalColumn` — an explicit/horizontal move resets the target.
   * `options` (e.g. `autoscroll`) is accepted for API compatibility and ignored.
   */
  setBufferPosition(point: PointLike, _options?: unknown): void {
    this.goalColumn = null;
    this.goalPixelX = null;
    const iter = this.editor.iterAtPoint(point);
    // Extend (move only the head) while a motion is targeting a selection;
    // otherwise collapse the selection onto the point.
    if (this.selection.modifying) this.selection.moveHead(iter);
    else this.selection.collapseTo(iter);
  }

  /** The non-word characters for this cursor (used to build word regexes). */
  getNonWordCharacters(): string {
    return DEFAULT_NON_WORD_CHARACTERS;
  }

  /**
   * A regex matching word/non-word runs from the cursor, mirroring Atom's
   * `Cursor.wordRegExp`. Word motions (`w`/`b`/`e`) use it for boundaries.
   */
  wordRegExp({ includeNonWordCharacters = true }: { includeNonWordCharacters?: boolean } = {}): RegExp {
    const nonWord = escapeRegExp(this.getNonWordCharacters());
    let source = `^[\t ]*$|[^\\s${nonWord}]+`;
    if (includeNonWordCharacters) source += `|[${nonWord}]+`;
    return new RegExp(source, 'g');
  }

  /**
   * A regex matching subword segments, mirroring Atom's `Cursor.subwordRegExp`:
   * camelCase humps, snake_case parts, and acronym runs each count as a segment
   * (e.g. `parseURLToString` → `parse`, `URL`, `To`, `String`). Subword motions
   * (`w`/`b`/`e`/`ge` when remapped) use it for boundaries.
   */
  subwordRegExp({ includeNonWordCharacters = true }: { includeNonWordCharacters?: boolean } = {}): RegExp {
    const nonWord = escapeRegExp(this.getNonWordCharacters());
    const lower = 'a-z\\d';
    const upper = 'A-Z';
    const segments = [
      '^[\t ]+', // leading indentation
      `[${upper}]+(?![${lower}])`, // an acronym run: the URL in parseURL
      `[${upper}]?[${lower}]+`, // a camelCase hump / word
    ];
    if (includeNonWordCharacters) segments.push(`[${nonWord}]+`);
    return new RegExp(segments.join('|'), 'g');
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
    return position.column === this.editor.lineLength(position.row);
  }

  /** With a single cursor there is only ever one, so it is always the last. */
  isLastCursor(): boolean {
    return true;
  }

  /** Scroll the view to keep the cursor visible. */
  autoscroll(_options?: unknown): void {
    this.editor.scrollCursorOnscreen();
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
    this.setBufferPosition(new Point(row, this.editor.lineLength(row)));
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
      else if (options.allowWrap && row > 0) column = this.editor.lineLength(--row);
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
      const length = this.editor.lineLength(row);
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

  /** Move one display (soft-wrapped) line up — `gk`. */
  moveDisplayUp(): void {
    this.moveByDisplayLine('up');
  }

  /** Move one display (soft-wrapped) line down — `gj`. */
  moveDisplayDown(): void {
    this.moveByDisplayLine('down');
  }

  /**
   * Step one display line, preserving the visual x (`goalPixelX`). Falls back to
   * a buffer-line step when the view geometry isn't available (headless / not yet
   * realized), so the motion still moves sensibly off-screen and in tests.
   */
  private moveByDisplayLine(direction: 'up' | 'down'): void {
    const result = this.editor.displayLineMove(this.getBufferPosition(), direction, this.goalPixelX);
    if (!result) {
      this.moveVertically(direction === 'down' ? 1 : -1);
      return;
    }
    const iter = this.editor.iterAtPoint(result.point);
    if (this.selection.modifying) this.selection.moveHead(iter);
    else this.selection.collapseTo(iter);
    this.goalPixelX = result.goalX;
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
    const column = Math.min(goal, this.editor.lineLength(row));
    const iter = this.editor.iterAtPoint(new Point(row, column));
    // Respect a targeting motion (extend) vs a plain move (collapse); works for
    // secondary selections too.
    if (this.selection.modifying) this.selection.moveHead(iter);
    else this.selection.collapseTo(iter);
    this.goalColumn = goal; // the moves above clear it; restore explicitly
  }
}
