import { test } from 'node:test';
import assert from 'node:assert/strict';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import { Range } from '../../../text/Range.ts';
import VimState from './vim-state.ts';
import settings from './settings.ts';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.ts';
import './motion.ts';
import './operator.ts';
import './operator-insert.ts';
import './text-object.ts';
import './misc-command.ts';

Gtk.init();

function setup() {
  const buffer = new GtkSource.Buffer();
  buffer.setText(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'), -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  const vimState = new VimState(editor, new StatusBarManager());
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (row: number) => editor.setCursorBufferPosition(new Point(row, 0));
  const row = () => editor.getCursorBufferPosition().row;
  return { editor, vimState, run, at, row };
}

test('jump list: alt-o / alt-i walk the jump motions', () => {
  const { run, at, row } = setup();
  at(0);
  run('MoveToLastLine'); // G -> 99 (records 0)
  run('MoveToFirstLine'); // gg -> 0 (records 99)
  assert.equal(row(), 0);
  run('JumpBackward'); // alt-o
  assert.equal(row(), 99);
  run('JumpBackward');
  assert.equal(row(), 0);
  run('JumpForward'); // alt-i
  assert.equal(row(), 99);
  run('JumpForward');
  assert.equal(row(), 0);
});

test('jump list: only true motions record (operator targets do not)', () => {
  const { editor, vimState, run, at } = setup();
  at(0);
  run('MoveToLastLine'); // G — records line 0
  // A `d}`-style operator motion must NOT add to the jump list.
  editor.setCursorBufferPosition(new Point(50, 0));
  run('Delete');
  run('MoveToNextParagraph'); // operator target (} is a jump motion)
  // alt-o should still go to line 0 (the only recorded jump), not line 50.
  run('JumpBackward');
  assert.equal(editor.getCursorBufferPosition().row, 0);
  void vimState;
});

test('jump list: motions of >= jumpListMinLines lines record without the jump flag', () => {
  const { vimState, run, at, row } = setup();
  at(0);
  vimState.operationStack.setCount(6);
  run('MoveDown'); // 6j — j is not a jump motion, but crosses the threshold
  assert.equal(row(), 6);
  run('JumpBackward'); // alt-o
  assert.equal(row(), 0);
  run('JumpForward'); // alt-i
  assert.equal(row(), 6);
});

test('jump list: motions below jumpListMinLines do not record', () => {
  const { vimState, run, at, row } = setup();
  at(0);
  vimState.operationStack.setCount(5);
  run('MoveDown'); // 5j — under the default threshold of 6
  assert.equal(row(), 5);
  run('JumpBackward'); // nothing recorded — cursor stays put
  assert.equal(row(), 5);
});

test('jump list: jumpListMinLines is configurable and 0 disables distance recording', () => {
  const { vimState, run, at, row } = setup();
  try {
    settings.set('jumpListMinLines', 3);
    at(0);
    vimState.operationStack.setCount(3);
    run('MoveDown'); // 3j records at the lowered threshold
    run('JumpBackward');
    assert.equal(row(), 0);

    settings.set('jumpListMinLines', 0);
    at(10);
    vimState.operationStack.setCount(50);
    run('MoveDown'); // 50j — distance recording disabled
    assert.equal(row(), 60);
    run('JumpBackward');
    assert.equal(row(), 60);
  } finally {
    settings.set('jumpListMinLines', 6);
  }
});

test('change list: g; / g, walk recent edit positions', () => {
  const { editor, run, row } = setup();
  for (const r of [10, 20, 30]) {
    editor.transact(() => editor.setTextInBufferRange(new Range([r, 0], [r, 0]), 'X'));
  }
  editor.setCursorBufferPosition(new Point(50, 0)); // move away from edits
  run('GoToOlderChange'); // g;
  assert.equal(row(), 30);
  run('GoToOlderChange');
  assert.equal(row(), 20);
  run('GoToOlderChange');
  assert.equal(row(), 10);
  run('GoToNewerChange'); // g,
  assert.equal(row(), 20);
});

test('jump positions track edits above them', () => {
  const { editor, run, at, row } = setup();
  at(40);
  run('MoveToLastLine'); // records line 40, cursor at 99
  // insert two lines at the top — the recorded jump should shift down to 42
  editor.transact(() => editor.setTextInBufferRange(new Range([0, 0], [0, 0]), 'a\nb\n'));
  run('JumpBackward');
  assert.equal(row(), 42);
});
