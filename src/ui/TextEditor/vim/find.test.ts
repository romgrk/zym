import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.ts';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.ts';
import './operator.ts';
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
  // Drive a find: run the motion (which arms input capture), then inject the
  // target character the way the key grab would.
  const find = (klass: string, char: string) => {
    vimState.operationStack.run(klass);
    vimState.setInputChar(char);
  };
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (row: number, col: number) => editor.setCursorBufferPosition(new Point(row, col));
  const pos = () => editor.getCursorBufferPosition().toArray();
  return { editor, vimState, find, run, at, pos };
}

test('f / F jump onto the target character on the cursor line', () => {
  const { find, at, pos } = setup('foo bar foo\n'); // f0 o1 o2 _3 b4 a5 r6 _7 f8 o9 o10
  at(0, 0);
  find('Find', 'o');
  assert.deepEqual(pos(), [0, 1]); // first 'o' after the cursor
  find('Find', 'o');
  assert.deepEqual(pos(), [0, 2]); // next 'o'
  find('FindBackwards', 'f');
  assert.deepEqual(pos(), [0, 0]); // back to the first 'f'
});

test('t / T stop next to the target character', () => {
  const { find, at, pos } = setup('foo bar baz\n'); // r at 6, b at 8
  at(0, 0);
  find('Till', 'r');
  assert.deepEqual(pos(), [0, 5]); // one before 'r'
  at(0, 10);
  find('TillBackwards', 'b');
  assert.deepEqual(pos(), [0, 9]); // one after 'b'
});

test('a find that fails leaves the cursor put', () => {
  const { find, at, pos } = setup('hello\n');
  at(0, 1);
  find('Find', 'z'); // no 'z' on the line
  assert.deepEqual(pos(), [0, 1]);
});

test('; and , repeat the last find forwards and backwards', () => {
  const { find, vimState, at, pos } = setup('a.b.c.d\n'); // dots at 1,3,5
  at(0, 0);
  find('Find', '.');
  assert.deepEqual(pos(), [0, 1]);
  vimState.operationStack.runCurrentFind();
  assert.deepEqual(pos(), [0, 3]);
  vimState.operationStack.runCurrentFind();
  assert.deepEqual(pos(), [0, 5]);
  vimState.operationStack.runCurrentFind({ reverse: true });
  assert.deepEqual(pos(), [0, 3]);
});

test('a find in visual mode records as the last command (so ; repeats it)', () => {
  // In visual mode a motion runs wrapped in an implicit `VisualModeSelect`; the
  // `;` (repeat-find-or-start-leap) heuristic keys off `lastCommandName` being a
  // find name, so the wrapper must be unwrapped — else `;` wrongly starts a leap.
  const FIND_NAMES = ['Find', 'FindBackwards', 'Till', 'TillBackwards'];
  const { find, run, vimState, at } = setup('foo bar foo bar\n');
  at(0, 0);
  run('ActivateCharacterwiseVisualMode');
  find('Find', 'b'); // v f b
  assert.ok(FIND_NAMES.includes(vimState.operationStack.getLastCommandName() ?? ''));
  assert.ok(vimState.globalState.get('currentFind'));

  // A non-find motion in visual mode must NOT look like a find (so `;` leaps).
  run('MoveToNextWholeWord');
  assert.ok(!FIND_NAMES.includes(vimState.operationStack.getLastCommandName() ?? ''));
});

test('f / F / t / T search across lines (findAcrossLines default)', () => {
  const { find, at, pos } = setup('abc\nde xf\n'); // x at row1 col3
  at(0, 0);
  find('Find', 'x');
  assert.deepEqual(pos(), [1, 3]); // crossed to the next line
  at(0, 0);
  find('Till', 'x');
  assert.deepEqual(pos(), [1, 2]); // one before x, across the line

  const back = setup('ax cd\nefg\n'); // x at row0 col1
  back.at(1, 2);
  back.find('FindBackwards', 'x');
  assert.deepEqual(back.pos(), [0, 1]); // backward across the line
  back.at(1, 2);
  back.find('TillBackwards', 'x');
  assert.deepEqual(back.pos(), [0, 2]); // one after x
});

test('df<char> deletes inclusively up to the found character', () => {
  const { vimState, editor, at } = setup('abcXdef\n'); // X at col 3
  at(0, 0);
  vimState.operationStack.run('Delete');
  vimState.operationStack.run('Find');
  vimState.setInputChar('X');
  assert.equal(editor.lineTextForBufferRow(0), 'def');
});
