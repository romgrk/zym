import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.ts';
import { StatusBarManager } from './stubs.ts';
import settings from './settings.ts';
import './operations/mode.ts';
import './operator-insert.ts';
import './text-object.ts';
import './motion.ts';

Gtk.init();

function setup(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  const vimState = new VimState(editor, new StatusBarManager());
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (row: number, col: number) => editor.setCursorBufferPosition(new Point(row, col));
  const pos = () => editor.getCursorBufferPosition().toArray();
  return { editor, vimState, run, at, pos };
}

test('h/l/j/k move the cursor by character and line', () => {
  const { run, at, pos } = setup('hello\nworld\n');
  at(0, 0);
  run('MoveRight');
  assert.deepEqual(pos(), [0, 1]);
  run('MoveDown');
  assert.deepEqual(pos(), [1, 1]);
  run('MoveLeft');
  assert.deepEqual(pos(), [1, 0]);
  run('MoveUp');
  assert.deepEqual(pos(), [0, 0]);
});

test('h stops at column 0; l reaches one past the last char (onemore default)', () => {
  const { run, at, pos } = setup('ab\n');
  at(0, 0);
  run('MoveLeft');
  assert.deepEqual(pos(), [0, 0]); // can't move before column 0
  run('MoveRight');
  assert.deepEqual(pos(), [0, 1]); // onto 'b'
  run('MoveRight');
  assert.deepEqual(pos(), [0, 2]); // past the last char (virtualedit=onemore)
  run('MoveRight');
  assert.deepEqual(pos(), [0, 2]); // but no further (end of line)
});

test('allowCursorPastEndOfLine=false restores the classic last-char resting', () => {
  settings.set('allowCursorPastEndOfLine', false);
  try {
    const { run, at, pos } = setup('ab\n');
    at(0, 1); // on 'b' (the last char)
    run('MoveRight');
    assert.deepEqual(pos(), [0, 1]); // pulled back to the last char
  } finally {
    settings.set('allowCursorPastEndOfLine', true);
  }
});

test('w / b / e move by word', () => {
  const { run, at, pos } = setup('foo bar baz\n');
  at(0, 0);
  run('MoveToNextWord');
  assert.deepEqual(pos(), [0, 4]); // start of "bar"
  run('MoveToNextWord');
  assert.deepEqual(pos(), [0, 8]); // start of "baz"
  run('MoveToPreviousWord');
  assert.deepEqual(pos(), [0, 4]); // back to "bar"
  run('MoveToEndOfWord');
  assert.deepEqual(pos(), [0, 6]); // end of "bar" (the 'r')
});

test('0 / ^ / $ move within the line', () => {
  const { run, at, pos } = setup('  hello world\n');
  at(0, 7);
  run('MoveToBeginningOfLine');
  assert.deepEqual(pos(), [0, 0]);
  run('MoveToFirstCharacterOfLine');
  assert.deepEqual(pos(), [0, 2]); // first non-blank
  run('MoveToLastCharacterOfLine');
  assert.deepEqual(pos(), [0, 13]); // end of line (onemore default; 'd' is at col 12)
});

test('^ toggles between the first non-blank char and column 0 (^ first)', () => {
  const { run, at, pos } = setup('  hello\n');
  at(0, 5);
  run('MoveToFirstCharacterOfLine');
  assert.deepEqual(pos(), [0, 2]); // first press → first non-blank
  run('MoveToFirstCharacterOfLine');
  assert.deepEqual(pos(), [0, 0]); // already on ^ → toggle to column 0
  run('MoveToFirstCharacterOfLine');
  assert.deepEqual(pos(), [0, 2]); // toggle back to ^
});

test('MoveDown / MoveUp accept a line count (default 1)', () => {
  const { vimState, at, pos } = setup('one\ntwo\nthree\nfour\nfive\n');
  at(0, 0);
  vimState.operationStack.run('MoveDown', { count: 3 });
  assert.deepEqual(pos(), [3, 0]); // down 3 lines
  vimState.operationStack.run('MoveUp', { count: 2 });
  assert.deepEqual(pos(), [1, 0]); // up 2 lines
});

test('gg / G jump to the first and last line', () => {
  const { run, at, pos } = setup('one\ntwo\nthree\n');
  at(1, 1);
  run('MoveToLastLine');
  assert.equal(pos()[0], 2); // last non-empty line
  run('MoveToFirstLine');
  assert.deepEqual(pos(), [0, 0]);
});

test('a count repeats a motion (3 l)', () => {
  const { editor, vimState, run, at, pos } = setup('abcdef\n');
  at(0, 0);
  vimState.operationStack.setCount(3);
  run('MoveRight');
  assert.deepEqual(pos(), [0, 3]);
});

// Display-line motions (gj/gk). The wrap-aware geometry needs a realized view, so
// headless these exercise the buffer-line fallback (and the characterwise wise).
test('gj/gk move by line (buffer-line fallback when unrealized) keeping the column', () => {
  const { run, at, pos } = setup('line0\nline1\nline2\nline3\n');
  at(0, 2);
  run('MoveDownDisplayLine'); // gj
  assert.deepEqual(pos(), [1, 2]);
  run('MoveDownDisplayLine');
  assert.deepEqual(pos(), [2, 2]);
  run('MoveUpDisplayLine'); // gk
  assert.deepEqual(pos(), [1, 2]);
});

test('dgj is a characterwise motion (not the linewise dj)', () => {
  const { editor, run, at } = setup('line0\nline1\nline2\n');
  at(0, 2);
  run('Delete');
  run('MoveDownDisplayLine'); // dgj: delete [0,2)-(1,2) characterwise
  assert.equal(editor.getText(), 'line1\nline2\n');
});

test('displayLineMove reports null when the view is not realized', () => {
  const { editor } = setup('hello world\n');
  assert.equal(editor.displayLineMove({ row: 0, column: 0 }, 'down', null), null);
});

// Subword motions (the defaults for w/b/e/ge): stop at camelCase humps,
// snake_case parts, and acronym runs.
test('w (MoveToNextSubword) stops at camelCase, snake_case and acronym boundaries', () => {
  const a = setup('fooBarBaz qux\n');
  a.at(0, 0);
  a.run('MoveToNextSubword'); assert.deepEqual(a.pos(), [0, 3]); // Bar
  a.run('MoveToNextSubword'); assert.deepEqual(a.pos(), [0, 6]); // Baz
  a.run('MoveToNextSubword'); assert.deepEqual(a.pos(), [0, 10]); // qux

  const b = setup('snake_case_var\n');
  b.at(0, 0);
  b.run('MoveToNextSubword'); assert.deepEqual(b.pos(), [0, 6]); // case
  b.run('MoveToNextSubword'); assert.deepEqual(b.pos(), [0, 11]); // var

  const c = setup('parseURLToString\n');
  c.at(0, 0);
  c.run('MoveToNextSubword'); assert.deepEqual(c.pos(), [0, 5]); // URL (acronym run)
  c.run('MoveToNextSubword'); assert.deepEqual(c.pos(), [0, 8]); // To
  c.run('MoveToNextSubword'); assert.deepEqual(c.pos(), [0, 10]); // String
});

test('e/b/ge subword motions stop at subword ends/starts', () => {
  const e = setup('fooBarBaz\n');
  e.at(0, 0);
  e.run('MoveToEndOfSubword'); assert.deepEqual(e.pos(), [0, 2]); // foo end
  e.run('MoveToEndOfSubword'); assert.deepEqual(e.pos(), [0, 5]); // Bar end

  const b = setup('fooBarBaz\n');
  b.at(0, 8);
  b.run('MoveToPreviousSubword'); assert.deepEqual(b.pos(), [0, 6]); // Baz start
  b.run('MoveToPreviousSubword'); assert.deepEqual(b.pos(), [0, 3]); // Bar start

  const g = setup('fooBarBaz\n');
  g.at(0, 8);
  g.run('MoveToPreviousEndOfSubword'); assert.deepEqual(g.pos(), [0, 5]); // Bar end
  g.run('MoveToPreviousEndOfSubword'); assert.deepEqual(g.pos(), [0, 2]); // foo end
});
