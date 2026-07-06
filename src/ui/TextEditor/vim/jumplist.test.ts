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
  // Capture the jump hints the vim layer emits into the workspace jump engine.
  const jumpRows: number[] = [];
  vimState.onDidRecordJump((point: Point) => jumpRows.push(point.row));
  return { editor, vimState, run, at, row, jumpRows };
}

// The vim layer no longer keeps its own jump ring: jump motions emit a hint that
// the single workspace engine (GlobalJumpList) folds in. These tests cover which
// motions hint and with what departed position; the ring walk lives in
// GlobalJumpList.test.ts.

test('jump list: jump motions emit a hint with the departed position', () => {
  const { run, at, jumpRows } = setup();
  at(0);
  run('MoveToLastLine'); // G -> 99, hint departs 0
  run('MoveToFirstLine'); // gg -> 0, hint departs 99
  assert.deepEqual(jumpRows, [0, 99]);
});

test('jump list: only true motions hint (operator targets do not)', () => {
  const { editor, run, at, jumpRows } = setup();
  at(0);
  run('MoveToLastLine'); // G — hints line 0
  // A `d}`-style operator motion must NOT hint a jump.
  editor.setCursorBufferPosition(new Point(50, 0));
  run('Delete');
  run('MoveToNextParagraph'); // operator target (} is a jump motion)
  assert.deepEqual(jumpRows, [0]); // only the G, not the operator target
});

test('jump list: motions of >= jumpListMinLines lines hint without the jump flag', () => {
  const { vimState, run, at, row, jumpRows } = setup();
  at(0);
  vimState.operationStack.setCount(6);
  run('MoveDown'); // 6j — j is not a jump motion, but crosses the threshold
  assert.equal(row(), 6);
  assert.deepEqual(jumpRows, [0]);
});

test('jump list: motions below jumpListMinLines do not hint', () => {
  const { vimState, run, at, row, jumpRows } = setup();
  at(0);
  vimState.operationStack.setCount(5);
  run('MoveDown'); // 5j — under the default threshold of 6
  assert.equal(row(), 5);
  assert.deepEqual(jumpRows, []);
});

test('jump list: jumpListMinLines is configurable and 0 disables distance hints', () => {
  const { vimState, run, at, jumpRows } = setup();
  try {
    settings.set('jumpListMinLines', 3);
    at(0);
    vimState.operationStack.setCount(3);
    run('MoveDown'); // 3j hints at the lowered threshold
    assert.deepEqual(jumpRows, [0]);

    settings.set('jumpListMinLines', 0);
    at(10);
    vimState.operationStack.setCount(50);
    run('MoveDown'); // 50j — distance hinting disabled
    assert.deepEqual(jumpRows, [0]); // unchanged: no new hint
  } finally {
    settings.set('jumpListMinLines', 6);
  }
});

test('jump list: JumpBackward / JumpForward delegate to the workspace navigator', () => {
  const { vimState, run } = setup();
  const calls: string[] = [];
  vimState.setJumpNavigator({
    backward: () => calls.push('backward'),
    forward: () => calls.push('forward'),
  });
  run('JumpBackward');
  run('JumpForward');
  assert.deepEqual(calls, ['backward', 'forward']);
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
