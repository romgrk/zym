import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.ts';
import { StatusBarManager } from './stubs.ts';
import settings from './settings.ts';
import './operations/mode.ts';
import './operator.ts';
import './operator-insert.ts';
import './text-object.ts';
import './motion.ts';
import './misc-command.ts';

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

test('a whole paste cycle is undone by a single u', () => {
  const { editor, run, at, yankWord } = setup('a b c .....\n');
  yankWord(0);
  yankWord(2);
  yankWord(4); // history [c, b, a]
  at(6);
  run('PutAfter'); // c
  run('PutAfter'); // -> b
  run('PutAfter'); // -> a
  assert.equal(editor.getText(), 'a b c .a....\n');
  run('Undo'); // one step reverts the initial paste + both cycles
  assert.equal(editor.getText(), 'a b c .....\n');
});

test('breaking the chain splits the pastes into separate undo steps', () => {
  const { editor, run, at, yankWord } = setup('a b c .....\n');
  yankWord(0);
  yankWord(2);
  yankWord(4); // history [c, b, a]
  at(6);
  run('PutAfter'); // c   (group 1)
  run('MoveRight'); // breaks the chain, commits group 1
  run('PutAfter'); // c   (group 2)
  assert.equal(editor.getText(), 'a b c .c.c...\n');
  run('Undo'); // undoes only the second paste
  assert.equal(editor.getText(), 'a b c .c....\n');
  run('Undo'); // undoes the first paste
  assert.equal(editor.getText(), 'a b c .....\n');
});
