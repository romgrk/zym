import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { quilx } from '../../../quilx.ts';
import { EditorModel } from '../EditorModel.ts';
import { attachVim } from './index.ts';

Gtk.init();

function makeEditor(text = 'hello\n'): { editor: EditorModel; view: InstanceType<typeof GtkSource.View> } {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  return { editor: new EditorModel(view, buffer), view };
}

test('attachVim registers per-view commands that dispatch to its VimState', () => {
  const { editor, view } = makeEditor();
  const vimState = attachVim(editor);
  assert.equal(vimState.mode, 'normal');

  // Dispatch the command bound to this view instance — the keymap layer does the
  // same once a keystroke is matched.
  const dispatched = quilx.commands.dispatch(view, 'vim-mode-plus:activate-insert-mode');
  assert.ok(dispatched);
  assert.equal(vimState.mode, 'insert');
  assert.equal(view.getEditable(), true);

  quilx.commands.dispatch(view, 'vim-mode-plus:activate-normal-mode');
  assert.equal(vimState.mode, 'normal');
  assert.equal(view.getEditable(), false);
});

test('commands are isolated per editor instance', () => {
  const a = makeEditor();
  const b = makeEditor();
  const vimA = attachVim(a.editor);
  const vimB = attachVim(b.editor);

  quilx.commands.dispatch(a.view, 'vim-mode-plus:activate-insert-mode');
  assert.equal(vimA.mode, 'insert');
  assert.equal(vimB.mode, 'normal'); // editor B unaffected
});
