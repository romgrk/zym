import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.js';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.js';
import './operator.js';
import './operator-insert.js';
import './text-object.js';
import './motion.js';

Gtk.init();

// Folding is owned by SyntaxController in the app; headless we inject a fold
// provider returning fixed regions so the fold motions / text object are testable.
function setup(text: string, ranges: Array<{ startRow: number; endRow: number }>) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  editor.setFoldProvider({ isFoldedAtRow: () => false, unfoldRow: () => {}, foldableRanges: () => ranges });
  const vimState = new VimState(editor, new StatusBarManager());
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (row: number) => editor.setCursorBufferPosition(new Point(row, 0));
  const row = () => editor.getCursorBufferPosition().row;
  return { editor, run, at, row };
}

const LINES = Array.from({ length: 11 }, (_, i) => `line${i}`).join('\n') + '\n';

test('zj / zk move to the next / previous fold; [z / ]z to the current fold edges', () => {
  const folds = [
    { startRow: 2, endRow: 5 },
    { startRow: 7, endRow: 9 },
  ];
  const { run, at, row } = setup(LINES, folds);
  at(0);
  run('MoveToNextFoldStart'); // zj
  assert.equal(row(), 2);
  run('MoveToNextFoldStart');
  assert.equal(row(), 7);
  at(10);
  run('MoveToPreviousFoldEnd'); // zk
  assert.equal(row(), 9);
  at(4); // inside the first fold
  run('MoveToPreviousFoldStart'); // [z
  assert.equal(row(), 2);
  at(4);
  run('MoveToNextFoldEnd'); // ]z
  assert.equal(row(), 5);
});

test('diz deletes the fold body; daz deletes the whole block', () => {
  const code = 'def f():\n    a = 1\n    b = 2\n    c = 3\nafter\n';
  const fold = [{ startRow: 0, endRow: 3 }];

  const inner = setup(code, fold);
  inner.at(2);
  inner.run('Delete');
  inner.run('InnerFold');
  assert.equal(inner.editor.getText(), 'def f():\nafter\n'); // header kept, body gone

  const around = setup(code, fold);
  around.at(2);
  around.run('Delete');
  around.run('AFold');
  assert.equal(around.editor.getText(), 'after\n'); // whole block gone
});

test('if / af operate on the function (via the syntax provider)', () => {
  const text = 'top\nfunction foo() {\n  let y = 2;\n  return y;\n}\nafter\n';
  const provider = {
    isFoldedAtRow: () => false,
    unfoldRow: () => {},
    foldableRanges: () => [],
    // foo spans rows 1-4; its body statements are rows 2-3.
    functionRangeAt: (row: number) =>
      row >= 1 && row <= 4 ? { outer: { startRow: 1, endRow: 4 }, inner: { startRow: 2, endRow: 3 } } : null,
  };
  const build = () => {
    const buffer = new GtkSource.Buffer();
    buffer.setText(text, -1);
    const view = new GtkSource.View({ buffer });
    const editor = new EditorModel(view, buffer);
    editor.setFoldProvider(provider);
    const vimState = new VimState(editor, new StatusBarManager());
    return { editor, vimState };
  };

  const inner = build();
  inner.editor.setCursorBufferPosition(new Point(2, 2));
  inner.vimState.operationStack.run('Delete');
  inner.vimState.operationStack.run('InnerFunction');
  assert.equal(inner.editor.getText(), 'top\nfunction foo() {\n\n}\nafter\n'); // body gone

  const around = build();
  around.editor.setCursorBufferPosition(new Point(2, 2));
  around.vimState.operationStack.run('Delete');
  around.vimState.operationStack.run('AFunction');
  assert.equal(around.editor.getText(), 'top\n\nafter\n'); // whole function gone

  const off = build();
  off.editor.setCursorBufferPosition(new Point(5, 0)); // not in a function
  off.vimState.operationStack.run('Delete');
  off.vimState.operationStack.run('AFunction');
  assert.equal(off.editor.getText(), text); // no-op
});
