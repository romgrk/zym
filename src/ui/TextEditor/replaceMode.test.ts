import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../gi.ts';
import { EditorModel } from './EditorModel.ts';
import { Point } from '../../text/Point.ts';
import { replaceOverwrite, replaceBackspace } from './replaceMode.ts';

Gtk.init();

function model(text: string, col: number) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  editor.setCursorBufferPosition(new Point(0, col));
  return editor;
}

const col = (e: EditorModel) => e.getCursorBufferPosition().column;

test('typing overwrites characters under the cursor', () => {
  const e = model('abcde', 0);
  const stack: string[] = [];
  replaceOverwrite(e, stack, 'X');
  replaceOverwrite(e, stack, 'Y');
  assert.equal(e.getText(), 'XYcde');
  assert.equal(col(e), 2);
});

test('overwriting past end-of-line appends', () => {
  const e = model('ab', 2); // cursor at EOL
  const stack: string[] = [];
  replaceOverwrite(e, stack, 'c');
  replaceOverwrite(e, stack, 'd');
  assert.equal(e.getText(), 'abcd');
});

test('backspace restores the overwritten characters', () => {
  const e = model('abcde', 0);
  const stack: string[] = [];
  replaceOverwrite(e, stack, 'X');
  replaceOverwrite(e, stack, 'Y'); // "XYcde", cursor at 2
  replaceBackspace(e, stack); // restore 'b'
  assert.equal(e.getText(), 'Xbcde');
  assert.equal(col(e), 1);
  replaceBackspace(e, stack); // restore 'a'
  assert.equal(e.getText(), 'abcde');
  assert.equal(col(e), 0);
});

test('backspace over an appended character deletes it', () => {
  const e = model('ab', 2);
  const stack: string[] = [];
  replaceOverwrite(e, stack, 'c'); // "abc" (appended)
  replaceBackspace(e, stack);
  assert.equal(e.getText(), 'ab');
  assert.equal(col(e), 2);
});

test('backspace at column 0 is a no-op', () => {
  const e = model('abc', 0);
  replaceBackspace(e, []);
  assert.equal(e.getText(), 'abc');
  assert.equal(col(e), 0);
});

test('a mid-line overwrite then backspace restores exactly', () => {
  const e = model('hello', 2); // on the first 'l'
  const stack: string[] = [];
  replaceOverwrite(e, stack, 'L'); // "heLlo"
  assert.equal(e.getText(), 'heLlo');
  replaceBackspace(e, stack);
  assert.equal(e.getText(), 'hello'); // 'l' restored
  assert.equal(col(e), 2);
});
