/*
 * replaceMode — the buffer edits behind vim's Replace mode (`R`): overwrite the
 * character under the cursor as you type, and walk back restoring the originally
 * overwritten characters on backspace. Pure over an `EditorModel` (+ a per-session
 * stack), so it is headless-testable; the host (`TextEditor`) drives it from the
 * insert-mode key controller while the vim layer is in the `replace` submode.
 *
 * The stack holds one entry per typed character: the replaced character, or `''`
 * when the character was appended past end-of-line (nothing to restore).
 */
import { Point } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';
import type { EditorModel } from './EditorModel.ts';

/** Overwrite the char under the cursor with `ch` (or append at end-of-line),
 *  recording what was replaced so backspace can restore it. */
export function replaceOverwrite(editor: EditorModel, stack: string[], ch: string): void {
  const pos = editor.getCursorBufferPosition();
  const atEol = pos.column >= editor.lineLength(pos.row);
  if (atEol) {
    editor.setTextInBufferRange(new Range(pos, pos), ch); // append past EOL
    stack.push('');
  } else {
    const span = new Range(pos, new Point(pos.row, pos.column + 1));
    stack.push(editor.getTextInBufferRange(span));
    editor.setTextInBufferRange(span, ch);
  }
  editor.setCursorBufferPosition(new Point(pos.row, pos.column + 1));
}

/** Step back one column, restoring the previously overwritten character (or
 *  deleting an appended one). No-op at column 0. */
export function replaceBackspace(editor: EditorModel, stack: string[]): void {
  const pos = editor.getCursorBufferPosition();
  if (pos.column === 0) return; // at line start — nothing to undo
  const original = stack.pop();
  const prev = new Point(pos.row, pos.column - 1);
  // A recorded overwrite restores its original char; an append (or no record)
  // just removes the typed character.
  editor.setTextInBufferRange(new Range(prev, pos), original ? original : '');
  editor.setCursorBufferPosition(prev);
}
