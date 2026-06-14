/*
 * Vim wiring — connects the vendored vim core to quilx's command/keymap system.
 *
 * `attachVim` builds one VimState per editor and registers its commands against
 * that editor's view *instance* (so a keystroke dispatches to the right editor's
 * VimState). The keymaps are registered once, globally, scoped by mode CSS class
 * (`GtkSourceView.normal-mode` / `.insert-mode`) — the KeymapManager matches a
 * focused view against them and dispatches the bound command, which the per-view
 * command bundle resolves to `vimState.operationStack.run(...)`.
 *
 * This is the phase-4 skeleton: only mode transitions are wired. Motions,
 * operators, and the rest register their commands/keymaps the same way as they
 * come online.
 */
import { quilx } from '../../../quilx.ts';
import type { EditorModel } from '../EditorModel.ts';
import VimState from './vim-state.js';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.js'; // self-registers the mode operations

let keymapsRegistered = false;

function registerKeymapsOnce(): void {
  if (keymapsRegistered) return;
  keymapsRegistered = true;

  quilx.keymaps.add('vim-mode-plus', {
    'GtkSourceView.normal-mode': {
      i: 'vim-mode-plus:activate-insert-mode',
      a: 'vim-mode-plus:insert-after',
    },
    'GtkSourceView.insert-mode': {
      escape: 'vim-mode-plus:activate-normal-mode',
    },
  });
}

/** Create and wire a VimState for `editor`, returning it. */
export function attachVim(editor: EditorModel): VimState {
  registerKeymapsOnce();

  const vimState = new VimState(editor, new StatusBarManager());

  quilx.commands.add(editor.view, {
    'vim-mode-plus:activate-normal-mode': () => {
      vimState.operationStack.run('ActivateNormalMode');
    },
    'vim-mode-plus:activate-insert-mode': () => {
      vimState.operationStack.run('ActivateInsertMode');
    },
    'vim-mode-plus:insert-after': () => {
      vimState.operationStack.run('InsertAfter');
    },
  });

  return vimState;
}
