import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.js';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.js'; // registers ActivateNormalMode/ActivateInsertMode/InsertAfter

Gtk.init();

function makeVimState(text = 'hello\nworld\n') {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  const vimState = new VimState(editor, new StatusBarManager());
  return { editor, vimState };
}

test('VimState starts in normal mode: input disabled, mode classes applied', () => {
  const { editor, vimState } = makeVimState();
  assert.equal(vimState.mode, 'normal');
  assert.equal(editor.view.getEditable(), false);
  assert.ok(editor.hasCssClass('vim-mode-plus'));
  assert.ok(editor.hasCssClass('normal-mode'));
});

test('running ActivateInsertMode enables input and swaps the mode class', () => {
  const { editor, vimState } = makeVimState();
  vimState.operationStack.run('ActivateInsertMode');
  assert.equal(vimState.mode, 'insert');
  assert.equal(editor.view.getEditable(), true);
  assert.ok(editor.hasCssClass('insert-mode'));
  assert.ok(!editor.hasCssClass('normal-mode'));
});

test('running ActivateNormalMode returns to normal and disables input', () => {
  const { editor, vimState } = makeVimState();
  vimState.operationStack.run('ActivateInsertMode');
  vimState.operationStack.run('ActivateNormalMode');
  assert.equal(vimState.mode, 'normal');
  assert.equal(editor.view.getEditable(), false);
  assert.ok(editor.hasCssClass('normal-mode'));
  assert.ok(!editor.hasCssClass('insert-mode'));
});

test('InsertAfter moves the cursor right, then enters insert mode', () => {
  const { editor, vimState } = makeVimState('hello\n');
  editor.setCursorBufferPosition(new Point(0, 0));
  vimState.operationStack.run('InsertAfter');
  assert.equal(vimState.mode, 'insert');
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 1]);
});

test('isMode reflects mode and the editor↔vimState registry tracks it', () => {
  const { editor, vimState } = makeVimState();
  assert.ok(vimState.isMode('normal'));
  assert.equal(VimState.get(editor), vimState);
  assert.ok(VimState.has(editor));
});
