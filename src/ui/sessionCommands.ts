/*
 * SessionCommands — the window-level `session:*` commands (save / save-as / open /
 * close / rename / delete) for the named-session model (docs/session-management.md).
 * Split out of AppWindow so the session orchestration isn't tangled into the shell.
 *
 * Atom-style, only the module-specific collaborator — the `SessionController` (per-window
 * session state + persistence policy) — is injected; the picker host, notifications,
 * config, and the `SessionManager` (`zym.session`) are read off the `zym` globals, and
 * dialogs present on `zym.window`.
 */
import Adw from 'gi:Adw-1';
import { zym } from '../zym.ts';
import { openSessionPicker, promptSessionName } from './SessionPicker.ts';
import { confirmUnsavedWork } from './confirmUnsavedWork.ts';
import type { SessionController } from '../SessionController.ts';
import type { SessionState } from '../SessionManager.ts';
import type { Disposable } from '../util/eventKit.ts';

export interface SessionCommandsDeps {
  /** The per-window session policy/state owner (save / open / close / rename lifecycle). */
  sessionController: SessionController;
}

const host = () => zym.workspace.getPickerHost();
const toast = (message: string) => zym.notifications.addInfo(message);

/**
 * Register the window-level `session:*` commands on `.AppWindow`. A window starts in the
 * unnamed/default session, which never persists; naming it (save / save-as) promotes it to
 * an autosaving named session, and `open` switches between them.
 */
export function registerSessionCommands(d: SessionCommandsDeps): Disposable {
  const sc = d.sessionController;
  return zym.commands.add('.AppWindow', {
    'session:save': { didDispatch: () => saveSession(sc), description: 'Save the session (names it if unnamed)' },
    'session:save-as': { didDispatch: () => promptSaveSessionAs(sc), description: 'Save the session under a name' },
    'session:open': { didDispatch: () => openSession(sc), description: 'Open a saved session' },
    'session:close': { didDispatch: () => closeSession(sc), description: 'Close the active session and reset the window' },
    'session:rename': { didDispatch: () => promptRenameSession(sc), description: 'Rename the current session' },
    'session:delete': { didDispatch: () => deleteSession(sc), description: 'Delete a saved session' },
  });
}

// `session:save` — flush a named session; on the unnamed default it acts as save-as
// (mirrors an editor's Save on an untitled buffer).
function saveSession(sc: SessionController): void {
  if (sc.sessionName === null) {
    promptSaveSessionAs(sc);
    return;
  }
  sc.saveNow();
  toast(`Session “${sc.sessionName}” saved`);
}

function promptSaveSessionAs(sc: SessionController): void {
  promptSessionName(host(), {
    placeholder: 'Save session as…',
    initial: sc.sessionName ?? '',
    actionLabel: (name) => `Save session as: ${name}`,
    onSubmit: (name) => {
      sc.saveAs(name);
      toast(`Session saved as “${name}”`);
    },
  });
}

function promptRenameSession(sc: SessionController): void {
  const current = sc.sessionName;
  if (current === null) {
    // Nothing named yet — renaming the default session is really a first save.
    promptSaveSessionAs(sc);
    return;
  }
  promptSessionName(host(), {
    placeholder: 'Rename session…',
    initial: current,
    actionLabel: (name) => `Rename session to: ${name}`,
    onSubmit: (name) => {
      if (name === current) return;
      sc.renameTo(name);
      toast(`Session renamed to “${name}”`);
    },
  });
}

function openSession(sc: SessionController): void {
  openSessionPicker(host(), {
    sessions: zym.session.list(),
    activeName: sc.sessionName,
    placeholder: 'Open session…',
    emptyMessage: 'No saved sessions yet — save one with space s a',
    onSelect: (state) => switchToSession(sc, state),
  });
}

// Switch into a saved session. Two gates, in order: (1) if another running instance
// already has this session open, warn first — both windows would autosave and overwrite
// each other's state; (2) opening replaces this window (tearing down its editors), so
// unsaved editor work is guarded by the same prompt as quitting.
function switchToSession(sc: SessionController, state: SessionState): void {
  const holder = state.name != null ? zym.session.lockHolder(state.name) : null;
  if (holder) {
    confirmOpenElsewhere(state, () => guardUnsavedThenOpen(sc, state));
    return;
  }
  guardUnsavedThenOpen(sc, state);
}

// The unsaved-editor guard around opening `state`; drops unwritten edits only after the
// same Save/Discard/Cancel prompt as quitting.
function guardUnsavedThenOpen(sc: SessionController, state: SessionState): void {
  const modified =
    zym.config.get('session.promptOnExitWhenModified') === true ? zym.session.collectModified() : [];
  if (modified.length === 0) {
    sc.open(state);
    return;
  }
  confirmUnsavedWork(
    modified,
    `Opening “${zym.session.label(state)}” replaces this window. The following will be lost:`,
    () => sc.open(state),
  );
}

// Confirm opening a session another live instance already holds. "Open Anyway" is
// destructive-styled because both windows will then autosave over each other; the default
// is Cancel.
function confirmOpenElsewhere(state: SessionState, onProceed: () => void): void {
  const label = zym.session.label(state);
  const dialog = new Adw.AlertDialog({
    heading: 'Session already open',
    body: `“${label}” is open in another window. Opening it here lets both windows overwrite each other’s saved state.`,
  });
  dialog.addResponse('cancel', 'Cancel');
  dialog.addResponse('open', 'Open Anyway');
  dialog.setResponseAppearance('open', Adw.ResponseAppearance.DESTRUCTIVE);
  dialog.setDefaultResponse('cancel');
  dialog.setCloseResponse('cancel');
  dialog.on('response', (response: string) => {
    if (response === 'open') onProceed();
  });
  dialog.present(zym.window!);
}

// `session:close` — flush the active named session, then reset the window to a fresh,
// unnamed slate rooted at the launch dir. Tears down editors/agents/extra projects like a
// session switch, so it's guarded by the same unsaved-work prompt (a named close still
// caches unsaved buffers, but the file on disk is untouched, so warn before dropping the
// live edits). A no-op with a toast on the unnamed default session — nothing named to close.
function closeSession(sc: SessionController): void {
  const name = sc.sessionName;
  if (name === null) {
    toast('No open session to close');
    return;
  }
  const proceed = () => {
    sc.closeToFresh(process.cwd());
    toast(`Session “${name}” closed`);
  };
  const modified =
    zym.config.get('session.promptOnExitWhenModified') === true ? zym.session.collectModified() : [];
  if (modified.length === 0) proceed();
  else confirmUnsavedWork(modified, `Closing “${name}” resets this window. The following will be lost:`, proceed);
}

function deleteSession(sc: SessionController): void {
  openSessionPicker(host(), {
    sessions: zym.session.list(),
    activeName: sc.sessionName,
    placeholder: 'Delete session…',
    emptyMessage: 'No saved sessions to delete',
    onSelect: (state) => {
      const label = zym.session.label(state);
      // Forgetting the active session drops back to the unnamed/default session (the live
      // window stays exactly as it is — only its persistence is gone).
      if (state.name != null && state.name === sc.sessionName) sc.becomeUnnamed();
      zym.session.delete(state);
      toast(`Session “${label}” deleted`);
    },
  });
}
