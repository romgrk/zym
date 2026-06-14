import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.js';
import { StatusBarManager } from './stubs.ts';
import clipboard from './clipboard.ts';
import './operations/mode.js';
import './operator.js';
import './operator-insert.js';
import './operator-transform-string.js';
import './text-object.js';
import './motion.js';

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
