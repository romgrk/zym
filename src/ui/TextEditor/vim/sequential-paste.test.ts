import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.js';
import { StatusBarManager } from './stubs.ts';
import settings from './settings.ts';
import './operations/mode.js';
import './operator.js';
import './operator-insert.js';
import './text-object.js';
import './motion.js';
import './misc-command.js';

Gtk.init();
// Use the internal register (not the system clipboard) so the yank ring is
// deterministic. File-isolated: node:test runs each file in its own process.
settings.set('useClipboardAsDefaultRegister', false);
settings.set('sequentialPaste', true);

function setup(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  const vimState = new VimState(editor, new StatusBarManager());
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (col: number) => editor.setCursorBufferPosition(new Point(0, col));
  const yankWord = (col: number) => {
    at(col);
    run('Yank');
    run('InnerWord');
  };
  return { editor, vimState, run, at, yankWord };
}

test('a second paste cycles to the next yank-history entry (yank-pop)', () => {
  const { editor, run, at, yankWord } = setup('a b c .....\n');
  yankWord(0); // yank "a"
  yankWord(2); // yank "b"
  yankWord(4); // yank "c"  -> history is [c, b, a]
  at(6); // on the first '.'
  run('PutAfter');
  assert.equal(editor.getText(), 'a b c .c....\n');
  run('PutAfter'); // sequential: replace c with b
  assert.equal(editor.getText(), 'a b c .b....\n');
  run('PutAfter'); // sequential: replace b with a
  assert.equal(editor.getText(), 'a b c .a....\n');
});

test('a non-paste command breaks the sequence (next paste is normal)', () => {
  const { editor, run, at, yankWord } = setup('a b c .....\n');
  yankWord(0);
  yankWord(2);
  yankWord(4); // history [c, b, a]
  at(6);
  run('PutAfter'); // c
  run('MoveRight'); // breaks the chain
  run('PutAfter'); // normal paste of the most-recent yank again -> c
  assert.equal(editor.getText(), 'a b c .c.c...\n');
});
