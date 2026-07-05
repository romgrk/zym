import { test } from 'node:test';
import assert from 'node:assert/strict';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.ts';
import { StatusBarManager } from './stubs.ts';
import clipboard from './clipboard.ts';
import './operations/mode.ts';
import './operator.ts';
import './operator-insert.ts';
import './operator-transform-string.ts';
import './text-object.ts';
import './motion.ts';
import './misc-command.ts';

Gtk.init();

function setup(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  view.setTabWidth(4); // match the real editor (bare GtkSourceView defaults to 8)
  const editor = new EditorModel(view, buffer);
  const vimState = new VimState(editor, new StatusBarManager());
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (row: number, col: number) => editor.setCursorBufferPosition(new Point(row, col));
  const line = (row = 0) => editor.lineTextForBufferRow(row);
  const pos = () => editor.getCursorBufferPosition().toArray();
  return { editor, vimState, run, at, line, pos };
}

// --- Change / delete / substitute shortcuts --------------------------------

test('D deletes to end of line', () => {
  const { run, at, line } = setup('abcdef\n');
  at(0, 2);
  run('DeleteToLastCharacterOfLine');
  assert.equal(line(), 'ab');
});

test('C changes to end of line (deletes + enters insert)', () => {
  const { vimState, run, at, line } = setup('abcdef\n');
  at(0, 2);
  run('ChangeToLastCharacterOfLine');
  assert.equal(line(), 'ab');
  assert.equal(vimState.mode, 'insert');
});

test('s substitutes the character under the cursor', () => {
  const { vimState, run, at, line } = setup('abc\n');
  at(0, 0);
  run('Substitute');
  assert.equal(line(), 'bc');
  assert.equal(vimState.mode, 'insert');
});

test('S substitutes the whole line', () => {
  const { vimState, run, at, line } = setup('hello\nworld\n');
  at(0, 2);
  run('SubstituteLine');
  assert.equal(line(0), '');
  assert.equal(vimState.mode, 'insert');
});

test('o / O carry the surrounding indentation', () => {
  const below = setup('def f():\n    a = 1\n    b = 2\n');
  below.at(1, 6); // on the indented "a = 1"
  below.run('InsertBelowWithNewline');
  below.editor.insertText('c = 3');
  below.run('ActivateNormalMode');
  assert.equal(below.editor.getText(), 'def f():\n    a = 1\n    c = 3\n    b = 2\n');

  const above = setup('def f():\n    a = 1\n');
  above.at(1, 6);
  above.run('InsertAboveWithNewline');
  above.editor.insertText('z = 0');
  above.run('ActivateNormalMode');
  assert.equal(above.editor.getText(), 'def f():\n    z = 0\n    a = 1\n');
});

test('cc keeps the changed line indentation', () => {
  const { editor, run, at } = setup('def f():\n    a = 1\n    b = 2\n');
  at(1, 6);
  run('Change');
  run('Change'); // cc
  editor.insertText('x = 9');
  run('ActivateNormalMode');
  assert.equal(editor.getText(), 'def f():\n    x = 9\n    b = 2\n');
});

test('gv reselects the last visual selection', () => {
  const { editor, vimState, run, at } = setup('hello world\n');
  at(0, 0);
  run('ActivateCharacterwiseVisualMode');
  run('MoveToEndOfWord'); // select "hello"
  run('ActivateNormalMode'); // leave visual
  at(0, 9);
  run('SelectPreviousSelection'); // gv
  assert.ok(vimState.isMode('visual'));
  const range = editor.getLastSelection().getBufferRange();
  assert.deepEqual([range.start.toArray(), range.end.toArray()], [[0, 0], [0, 5]]);
});

test('gb selects the latest changed/yanked region', () => {
  const { editor, vimState, run, at } = setup('hello world\n');
  at(0, 0);
  run('Yank');
  run('MoveToEndOfWord'); // ye → yank "hello", sets the `[`/`]` change marks
  at(0, 9); // move the cursor away from the changed region
  run('SelectLatestChange'); // gb
  assert.ok(vimState.isMode('visual'));
  const range = editor.getLastSelection().getBufferRange();
  assert.deepEqual([range.start.toArray(), range.end.toArray()], [[0, 0], [0, 5]]);
});

test('visual o swaps the active end of the selection', () => {
  const { editor, run, at } = setup('hello\n');
  at(0, 1);
  run('ActivateCharacterwiseVisualMode');
  run('MoveToEndOfWord'); // cursor at the far end
  const farEnd = editor.getCursorBufferPosition().toArray();
  run('ReverseSelections'); // o
  assert.notDeepEqual(editor.getCursorBufferPosition().toArray(), farEnd);
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 1]); // back to the start
});

test('insert-mode ctrl-w deletes the word before the cursor', () => {
  const { editor, vimState } = setup('foo bar\n');
  editor.setCursorBufferPosition(new Point(0, 7));
  vimState.activate('insert');
  vimState.operationStack.run('DeleteToPreviousWordBoundary');
  assert.equal(editor.getText(), 'foo \n');
});

test('insert-mode ctrl-u deletes back to the first non-blank', () => {
  const { editor, vimState } = setup('    hello\n');
  editor.setCursorBufferPosition(new Point(0, 9));
  vimState.activate('insert');
  vimState.operationStack.run('DeleteToBeginningOfInsertLine');
  assert.equal(editor.getText(), '    \n');
});

test('. repeats an insert change (ciw)', () => {
  const { editor, vimState, run, at } = setup('aaa bbb ccc\n');
  at(0, 0);
  run('Change');
  run('InnerWord');
  editor.insertText('X');
  run('ActivateNormalMode'); // ciwX -> "X bbb ccc"
  assert.equal(editor.getText(), 'X bbb ccc\n');
  at(0, 4); // on "bbb"
  vimState.operationStack.runRecorded(); // .
  assert.equal(editor.getText(), 'X X ccc\n'); // change repeated on "bbb"
});

test('cc empties the line and leaves the cursor on it (not the next line)', () => {
  const { editor, vimState, run, at, line, pos } = setup('foo\nbar\nbaz\n');
  at(1, 2); // on the middle line "bar"
  run('Change');
  run('Change'); // cc -> Change with a linewise MoveToRelativeLine target
  assert.equal(line(1), ''); // the line is emptied, not removed
  assert.deepEqual(pos(), [1, 0]); // cursor on the emptied line, not [2,0]
  assert.equal(vimState.mode, 'insert');
  editor.insertText('X'); // typing lands on the right line
  assert.equal(editor.getText(), 'foo\nX\nbaz\n');
});

test('X deletes the character before the cursor', () => {
  const { run, at, line } = setup('abc\n');
  at(0, 2); // on 'c'
  run('DeleteLeft');
  assert.equal(line(), 'ac');
});

test('Y yanks the whole line', () => {
  const { run, at } = setup('hello\nworld\n');
  at(0, 1);
  run('YankLine');
  assert.equal(clipboard.read(), 'hello\n');
});

test('~ toggles the character case and moves right', () => {
  const { run, at, line, pos } = setup('aBc\n');
  at(0, 0);
  run('ToggleCaseAndMoveRight');
  assert.equal(line(), 'ABc');
  assert.deepEqual(pos(), [0, 1]);
});

// --- Insert-entry variants -------------------------------------------------

test('o opens a line below and enters insert', () => {
  const { editor, vimState, run, at } = setup('one\ntwo\n');
  at(0, 1);
  run('InsertBelowWithNewline');
  assert.equal(vimState.mode, 'insert');
  assert.equal(editor.getLineCount(), 4); // one, (new), two, trailing
  assert.equal(editor.getCursorBufferPosition().toArray()[0], 1); // on the new line
});

test('O opens a line above and enters insert', () => {
  const { editor, vimState, run, at } = setup('one\ntwo\n');
  at(1, 1);
  run('InsertAboveWithNewline');
  assert.equal(vimState.mode, 'insert');
  assert.equal(editor.getCursorBufferPosition().toArray()[0], 1); // new line above "two"
});

test('I moves to the first non-blank and enters insert', () => {
  const { vimState, run, at, pos } = setup('   abc\n');
  at(0, 5);
  run('InsertAtFirstCharacterOfLine');
  assert.equal(vimState.mode, 'insert');
  assert.deepEqual(pos(), [0, 3]); // first non-blank
});

test('A moves past end of line and enters insert', () => {
  const { vimState, run, at, pos } = setup('abc\n');
  at(0, 0);
  run('InsertAfterEndOfLine');
  assert.equal(vimState.mode, 'insert');
  assert.deepEqual(pos(), [0, 3]); // after the last char
});

// --- Motions ----------------------------------------------------------------

test('} and { move by paragraph', () => {
  const { run, at, pos } = setup('a\n\nb\n\nc\n');
  at(0, 0);
  run('MoveToNextParagraph');
  assert.equal(pos()[0], 1); // the blank line after "a"
  run('MoveToNextParagraph');
  assert.equal(pos()[0], 3); // the next blank line
  run('MoveToPreviousParagraph');
  assert.equal(pos()[0], 1);
});

test('% jumps between matching pairs', () => {
  const { run, at, pos } = setup('foo(bar)\n');
  at(0, 3); // on '('
  run('MoveToPair');
  assert.deepEqual(pos(), [0, 7]); // on ')'
});

test('% matches the preceding bracket when cursor sits just after a close', () => {
  const { run, at, pos } = setup('foo(bar)\n');
  at(0, 8); // after ')', nothing forward on the line
  run('MoveToPair');
  assert.deepEqual(pos(), [0, 3]); // jumps back to '('
});

test('| moves to a column by count', () => {
  const { vimState, run, at, pos } = setup('abcdef\n');
  at(0, 0);
  vimState.operationStack.setCount(3);
  run('MoveToColumn');
  assert.deepEqual(pos(), [0, 2]); // 3| -> column 3 (0-based index 2)
});

test('+ and - move to the first non-blank of adjacent lines', () => {
  const { run, at, pos } = setup('one\n  two\nthree\n');
  at(0, 0);
  run('MoveToFirstCharacterOfLineDown'); // +
  assert.deepEqual(pos(), [1, 2]); // first non-blank of "  two"
  run('MoveToFirstCharacterOfLineUp'); // -
  assert.deepEqual(pos(), [0, 0]);
});

// --- Operator composition with new bits ------------------------------------

test('d} deletes to the next paragraph', () => {
  const { run, at, line } = setup('a\nb\n\nc\n');
  at(0, 0);
  run('Delete');
  run('MoveToNextParagraph');
  assert.equal(line(0), ''); // "a" and "b" removed up to the blank line
});

// --- Indent / outdent / join ------------------------------------------------

test('>> indents the current line by one level', () => {
  const { run, at, line } = setup('abc\n');
  at(0, 0);
  run('Indent'); // >
  run('Indent'); // > again -> >> (same-operator repeat targets the line)
  assert.equal(line(0), '    abc'); // 4-space soft tab
});

test('<< outdents the current line by one level', () => {
  const { run, at, line } = setup('    abc\n');
  at(0, 0);
  run('Outdent');
  run('Outdent');
  assert.equal(line(0), 'abc');
});

test('>j indents the current and next line', () => {
  const { run, at, line } = setup('one\ntwo\nthree\n');
  at(0, 0);
  run('Indent');
  run('MoveDown'); // >j -> covers rows 0-1
  assert.equal(line(0), '    one');
  assert.equal(line(1), '    two');
  assert.equal(line(2), 'three');
});

test('J joins the current line with the next (single space)', () => {
  const { run, at, line } = setup('hello\nworld\n');
  at(0, 0);
  run('Join');
  assert.equal(line(0), 'hello world');
});

test('J strips the next line leading whitespace', () => {
  const { run, at, line } = setup('hello\n    world\n');
  at(0, 0);
  run('Join');
  assert.equal(line(0), 'hello world');
});

test('3J joins three lines', () => {
  const { vimState, run, at, line } = setup('a\nb\nc\nd\n');
  at(0, 0);
  vimState.operationStack.setCount(3);
  run('Join');
  assert.equal(line(0), 'a b c');
  assert.equal(line(1), 'd');
});

// --- Increment / decrement, sentence, ge, H/M/L ----------------------------

test('ctrl-a / ctrl-x increment and decrement the number on the line', () => {
  const { run, at, line } = setup('val 41 end\n');
  at(0, 0); // before the number — finds the next number on the line
  run('Increase');
  assert.equal(line(), 'val 42 end');
  run('Decrease');
  run('Decrease');
  assert.equal(line(), 'val 40 end');
});

test('( and ) move by sentence', () => {
  const { run, at, pos } = setup('One. Two. Three.\n');
  at(0, 0);
  run('MoveToNextSentence');
  assert.deepEqual(pos(), [0, 5]); // start of "Two"
  run('MoveToNextSentence');
  assert.deepEqual(pos(), [0, 10]); // "Three"
  run('MoveToPreviousSentence');
  assert.deepEqual(pos(), [0, 5]);
});

test('ge moves to the previous end of word', () => {
  const { run, at, pos } = setup('foo bar baz\n');
  at(0, 8); // on 'b' of "baz"
  run('MoveToPreviousEndOfWord');
  assert.deepEqual(pos(), [0, 6]); // 'r' of "bar"
});

test('scroll commands run without error (real scrolling needs a realized view)', () => {
  const { run, at } = setup('l0\nl1\nl2\nl3\nl4\nl5\n');
  at(3, 0);
  // Plumbing: ScrollManager registered, Cursor.getScreenPosition + EditorModel
  // pixel/scroll methods present. Behavior (cursor jump + view scroll) depends on
  // the realized viewport, so this just guards the chain against regressions.
  for (const op of [
    'ScrollHalfScreenDown',
    'ScrollHalfScreenUp',
    'ScrollFullScreenDown',
    'ScrollFullScreenUp',
    'ScrollQuarterScreenDown',
    'ScrollQuarterScreenUp',
    'MiniScrollDown', // ctrl-e
    'MiniScrollUp', // ctrl-y
    'RedrawCursorLineAtMiddle', // zz
    'RedrawCursorLineAtTop', // zt
    'RedrawCursorLineAtBottom', // zb
  ]) {
    run(op);
  }
  assert.ok(true);
});

test('H / M / L land on the top / middle / bottom viewport rows in order', () => {
  const { editor, run, at } = setup('l0\nl1\nl2\nl3\nl4\n');
  const row = () => editor.getCursorBufferPosition().toArray()[0];
  at(2, 0);
  run('MoveToTopOfScreen');
  const top = row();
  at(2, 0);
  run('MoveToMiddleOfScreen');
  const mid = row();
  at(2, 0);
  run('MoveToBottomOfScreen');
  const bottom = row();
  assert.ok(top <= mid && mid <= bottom, `expected top<=mid<=bottom, got ${top},${mid},${bottom}`);
});

// --- Toggle line comments (g c / g c c) -------------------------------------

test('g c c toggles the current line comment and back', () => {
  const { editor, run, at, line } = setup('  let a = 1\n');
  editor.setCommentSpecSource(() => ({ line: '//' }));
  at(0, 4);
  run('ToggleLineCommentsCurrentLine');
  assert.equal(line(), '  // let a = 1');
  run('ToggleLineCommentsCurrentLine');
  assert.equal(line(), '  let a = 1');
});

test('g c {motion} toggles the motion rows linewise', () => {
  const { editor, run, at, line } = setup('a\nb\nc\n');
  editor.setCommentSpecSource(() => ({ line: '//' }));
  at(0, 0);
  run('ToggleLineComments');
  run('MoveDown'); // g c j → the current and next row
  assert.equal(line(0), '// a');
  assert.equal(line(1), '// b');
  assert.equal(line(2), 'c');
});

test('visual g c toggles the selected rows and returns to normal mode', () => {
  const { editor, vimState, run, at, line } = setup('a\nb\nc\n');
  editor.setCommentSpecSource(() => ({ line: '//' }));
  at(0, 0);
  run('ActivateLinewiseVisualMode');
  run('MoveDown'); // select rows 0-1
  run('ToggleLineComments');
  assert.equal(line(0), '// a');
  assert.equal(line(1), '// b');
  assert.equal(line(2), 'c');
  assert.ok(vimState.isMode('normal'));
});

test('g c without a comment spec leaves the buffer untouched', () => {
  const { run, at, line } = setup('a\n');
  at(0, 0);
  run('ToggleLineCommentsCurrentLine');
  assert.equal(line(), 'a');
});

test('bottom-anchored visual g c does not leave the cursor below the toggled rows', () => {
  const { editor, run, at } = setup('one\ntwo\nthree\n');
  editor.setCommentSpecSource(() => ({ line: '//' }));
  at(0, 0);
  run('ActivateLinewiseVisualMode');
  run('MoveDown'); // cursor at the BOTTOM of the selection (insert mark on row 2)
  run('ToggleLineComments');
  assert.equal(editor.getText(), '// one\n// two\nthree\n');
  assert.ok(
    editor.getCursorBufferPosition().row <= 1,
    `cursor landed below the toggled rows: ${editor.getCursorBufferPosition().row}`,
  );
});

test('linewise visual keeps the display caret on the selected row (current-line band source)', () => {
  const { editor, run, at } = setup('one\ntwo\nthree\n');
  at(0, 0);
  run('ActivateLinewiseVisualMode');
  run('MoveDown'); // selection rows 0-1; the raw insert mark sits at (2,0)
  assert.equal(editor.getCursorBufferPosition().row, 2, 'raw insert mark is one row below');
  assert.equal(editor.cursorDisplayIter().getLine(), 1, 'display caret stays on the last selected row');
});
