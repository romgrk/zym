import { test } from 'node:test';
import assert from 'node:assert/strict';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
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

test('the sequential-paste command cycles to the next yank-history entry (yank-pop)', () => {
  const { editor, run, at, yankWord } = setup('a b c .....\n');
  yankWord(0); // yank "a"
  yankWord(2); // yank "b"
  yankWord(4); // yank "c"  -> history is [c, b, a]
  at(6); // on the first '.'
  run('PutAfter');
  assert.equal(editor.getText(), 'a b c .c....\n');
  run('SequentialPaste'); // replace c with b
  assert.equal(editor.getText(), 'a b c .b....\n');
  run('SequentialPaste'); // replace b with a
  assert.equal(editor.getText(), 'a b c .a....\n');
});

test('sequential paste with an empty register is a harmless no-op', () => {
  // A first paste with nothing in the register cancels without recording a
  // pasted range, but still becomes the "last command". The next paste must not
  // treat that no-op as a sequence to cycle (which used to crash resolving an
  // absent LastPastedRange). Regression for the empty-register PutAfter crash.
  const { editor, vimState, run, at } = setup('a b c .....\n');
  // The unnamed register and the yank ring are process-wide singletons; clear
  // both so the register is genuinely empty regardless of preceding tests.
  vimState.globalState.reset('register');
  vimState.globalState.reset('clipboardHistory');
  at(6);
  run('PutAfter'); // nothing yanked -> no-op
  run('SequentialPaste'); // must not crash, still a no-op
  assert.equal(editor.getText(), 'a b c .....\n');
});

test('regular repeated paste never cycles the yank history', () => {
  const { editor, run, at, yankWord } = setup('a b c .....\n');
  yankWord(0);
  yankWord(2);
  yankWord(4); // history [c, b, a]
  at(6);
  run('PutAfter');
  run('PutAfter');
  assert.equal(editor.getText(), 'a b c .cc....\n');
});

test('a non-paste command breaks the sequence (next paste is normal)', () => {
  const { editor, run, at, yankWord } = setup('a b c .....\n');
  yankWord(0);
  yankWord(2);
  yankWord(4); // history [c, b, a]
  at(6);
  run('PutAfter'); // c
  run('MoveRight'); // breaks the chain
  run('SequentialPaste'); // interruption makes this a fresh paste of c
  assert.equal(editor.getText(), 'a b c .c.c...\n');
});

test('a whole paste cycle is undone by a single u', () => {
  const { editor, run, at, yankWord } = setup('a b c .....\n');
  yankWord(0);
  yankWord(2);
  yankWord(4); // history [c, b, a]
  at(6);
  run('PutAfter'); // c
  run('SequentialPaste'); // -> b
  run('SequentialPaste'); // -> a
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
  run('SequentialPaste'); // c   (group 2)
  assert.equal(editor.getText(), 'a b c .c.c...\n');
  run('Undo'); // undoes only the second paste
  assert.equal(editor.getText(), 'a b c .c....\n');
  run('Undo'); // undoes the first paste
  assert.equal(editor.getText(), 'a b c .....\n');
});
