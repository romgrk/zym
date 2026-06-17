import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.js';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.js';
import './motion.js';

Gtk.init();

// Git hunks are owned by GitGutter in the app; headless we inject the hunk-start
// rows directly so the `]h` / `[h` motions are testable.
function setup(text: string, hunkRows: number[]) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  editor.setHunkProvider(() => hunkRows);
  const vimState = new VimState(editor, new StatusBarManager());
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (row: number) => editor.setCursorBufferPosition(new Point(row, 0));
  const row = () => editor.getCursorBufferPosition().row;
  return { editor, run, at, row };
}

const LINES = Array.from({ length: 11 }, (_, i) => `line${i}`).join('\n') + '\n';

test(']h / [h move to the next / previous git hunk', () => {
  const { run, at, row } = setup(LINES, [2, 5, 9]);

  at(0);
  run('MoveToNextHunk'); // ]h
  assert.equal(row(), 2);
  run('MoveToNextHunk');
  assert.equal(row(), 5);

  at(10);
  run('MoveToPreviousHunk'); // [h
  assert.equal(row(), 9);
  run('MoveToPreviousHunk');
  assert.equal(row(), 5);
});

test(']h / [h from inside a hunk go to the adjacent one, not the current row', () => {
  const { run, at, row } = setup(LINES, [2, 5, 9]);

  at(5); // on a hunk start
  run('MoveToNextHunk');
  assert.equal(row(), 9);
  at(5);
  run('MoveToPreviousHunk');
  assert.equal(row(), 2);
});

test(']h / [h no-op at the last / first hunk and with no hunks', () => {
  const present = setup(LINES, [2, 5, 9]);
  present.at(9);
  present.run('MoveToNextHunk'); // already at the last hunk
  assert.equal(present.row(), 9);
  present.at(2);
  present.run('MoveToPreviousHunk'); // already at the first hunk
  assert.equal(present.row(), 2);

  const none = setup(LINES, []);
  none.at(4);
  none.run('MoveToNextHunk');
  assert.equal(none.row(), 4);
  none.run('MoveToPreviousHunk');
  assert.equal(none.row(), 4);
});
