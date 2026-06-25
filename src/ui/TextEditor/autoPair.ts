/*
 * autoPair — auto-close brackets and quotes while typing in insert mode.
 *
 * Pure logic over an EditorModel so it's unit-testable; TextEditor wires it to a
 * key controller on the view. Each entry point returns whether it handled the
 * keystroke (the caller then consumes the key so the view doesn't also insert it).
 *
 * Behaviors:
 *  - opening a bracket inserts the matching close and sits between them;
 *  - typing a closer that's already right after the cursor steps over it instead
 *    of inserting a duplicate ("type-over");
 *  - backspace inside an empty pair deletes both halves.
 *
 * Guards keep it unobtrusive: brackets don't auto-close directly before a word,
 * and quotes don't pair after a word/another quote (so apostrophes and the end of
 * a string stay literal).
 *
 * Multi-cursor: consuming the keystroke suppresses the view's native insert (and
 * the live replication that mirrors it onto the extra cursors), so whenever we do
 * handle a key we must act at *every* cursor ourselves — each one evaluating its
 * own surrounding context. The handle-or-not decision has to be uniform (the key
 * is consumed for all cursors or none), so the primary cursor decides; an extra
 * cursor that locally wouldn't pair just gets the bare character inserted.
 */
import type { EditorModel } from './EditorModel.ts';
import type { Selection } from './Selection.ts';

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
const CLOSE_TO_OPEN: Record<string, string> = {};
for (const [open, close] of Object.entries(PAIRS)) CLOSE_TO_OPEN[close] = open;

const isWord = (ch: string): boolean => /\w/.test(ch);

/** What auto-pair should do for one cursor. `pass` means "not auto-pair's
 *  business": the primary falls the key through; an extra inserts the bare char. */
type AutoPairAction = { kind: 'pass' } | { kind: 'pair'; text: string } | { kind: 'over' };

/** Decide the action for a cursor sitting at (row, column) typing `ch`. */
function insertActionAt(editor: EditorModel, row: number, column: number, ch: string): AutoPairAction {
  const isOpener = PAIRS[ch] !== undefined;
  const isCloser = CLOSE_TO_OPEN[ch] !== undefined;
  const line = editor.lineTextForBufferRow(row);
  const after = line[column] ?? '';

  // Type-over: a closer (or quote) already sitting after the cursor.
  if (isCloser && after === ch) return { kind: 'over' };
  if (!isOpener) return { kind: 'pass' }; // a bare closer with nothing to step over

  const close = PAIRS[ch];
  if (ch === close) {
    const before = column === 0 ? '' : line[column - 1] ?? '';
    if (isWord(before) || before === ch || isWord(after)) return { kind: 'pass' }; // apostrophe / string end
  } else if (isWord(after)) {
    return { kind: 'pass' }; // don't wrap a following word
  }
  return { kind: 'pair', text: ch + close };
}

/** Handle a typed character; returns true when auto-pair consumed it. */
export function handleAutoPairInsert(editor: EditorModel, ch: string): boolean {
  if (PAIRS[ch] === undefined && CLOSE_TO_OPEN[ch] === undefined) return false;

  // The primary cursor decides whether the key is ours: if it would only insert
  // the bare character, fall through so the view inserts it and (with multiple
  // cursors) mirrors that onto the extras itself.
  const primary = editor.getCursorBufferPosition();
  if (insertActionAt(editor, primary.row, primary.column, ch).kind === 'pass') return false;

  editor.applyAutoPairEdit((selection: Selection) => {
    const pos = selection.getHeadBufferPosition();
    const action = insertActionAt(editor, pos.row, pos.column, ch);
    if (action.kind === 'over') {
      selection.setBufferRange([[pos.row, pos.column + 1], [pos.row, pos.column + 1]]); // step over the closer
    } else if (action.kind === 'pair') {
      editor.setTextInBufferRange([[pos.row, pos.column], [pos.row, pos.column]], action.text);
      selection.setBufferRange([[pos.row, pos.column + 1], [pos.row, pos.column + 1]]); // between the pair
    } else {
      editor.setTextInBufferRange([[pos.row, pos.column], [pos.row, pos.column]], ch); // bare char; cursor advances
    }
  });
  return true;
}

/** Handle backspace; returns true when it deleted an empty pair. */
export function handleAutoPairBackspace(editor: EditorModel): boolean {
  // As with insert, the primary decides; only an empty pair under it is ours.
  const primary = editor.getCursorBufferPosition();
  if (!isEmptyPairAt(editor, primary.row, primary.column)) return false;

  editor.applyAutoPairEdit((selection: Selection) => {
    const pos = selection.getHeadBufferPosition();
    if (isEmptyPairAt(editor, pos.row, pos.column)) {
      editor.setTextInBufferRange([[pos.row, pos.column - 1], [pos.row, pos.column + 1]], ''); // delete both halves
    } else if (pos.column > 0) {
      editor.setTextInBufferRange([[pos.row, pos.column - 1], [pos.row, pos.column]], ''); // plain backspace
    }
    // column 0: nothing to delete on this row — skip (matches live replication's rule)
  });
  return true;
}

/** Whether (row, column) sits between an opener and its matching closer. */
function isEmptyPairAt(editor: EditorModel, row: number, column: number): boolean {
  const line = editor.lineTextForBufferRow(row);
  const before = column === 0 ? '' : line[column - 1] ?? '';
  const after = line[column] ?? '';
  return before !== '' && PAIRS[before] === after;
}
