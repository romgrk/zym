/*
 * FileCommands — the window-level `file:*` commands: open (dialog / by-name / by-path),
 * save / save-as, and move / rename (with LSP-driven reference rewrites). Split out of
 * AppWindow so the file-operation orchestration isn't tangled into the shell.
 *
 * The active editor, active workbench cwd, file-open, the editable-surface `save()`
 * target, and workspace-edit application all depend on the panel-tree state AppWindow
 * owns, so they're injected as a deps object (the registerGithubCommands idiom).
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
type ApplicationWindow = InstanceType<typeof Adw.ApplicationWindow>;
import { zym } from '../zym.ts';
import { TextEditor } from './TextEditor/index.ts';
import { openFilePicker } from './FilePicker.ts';
import { openFileOpener, openFolderPicker, openRenamePicker } from './FileOpener.ts';
import { tildify } from '../util/tilde.ts';
import { normalizeWorkspaceEdit } from '../lsp/workspaceEdit.ts';
import { type PositionEncoding } from '../lsp/position.ts';
import type { WorkspaceEdit } from 'vscode-languageserver-protocol';
import { CancellationTokenSource } from 'vscode-languageserver-protocol';
import type { Disposable } from '../util/eventKit.ts';

export interface FileCommandsDeps {
  window: ApplicationWindow;
  overlay: InstanceType<typeof Gtk.Overlay>;
  /** The active workbench's root directory. */
  getCwd: () => string;
  /** The text editor backing the focused tab, if any. */
  activeEditor: () => TextEditor | null;
  /** Open (revealing an already-open tab) `path`. */
  openFile: (path: string) => void;
  /** Apply an LSP WorkspaceEdit to open editors / on-disk files. */
  applyWorkspaceEdit: (edit: WorkspaceEdit, encoding: PositionEncoding) => { applied: number; resourceOps: number };
  /** The active editable surface (project-search or diff multibuffer) that owns a `save()`. */
  activeSavableSurface: () => { save(): void } | null;
}

/** Register the window-level `file:*` commands on `.AppWindow`. */
export function registerFileCommands(d: FileCommandsDeps): Disposable {
  const onEditorFile = () => d.activeEditor()?.currentFile != null;
  return zym.commands.add('.AppWindow', {
    'file:open': { didDispatch: () => openDialog(d), description: 'Open a file (dialog)' },
    'file:find': {
      didDispatch: () => openFilePicker(d.overlay, d.getCwd(), (path) => d.openFile(path)),
      description: 'Find a file by name',
    },
    'file:open-path': {
      didDispatch: () => openFileOpener(d.overlay, d.getCwd(), (path) => d.openFile(path)),
      description: 'Open a file by path',
    },
    'file:move': {
      didDispatch: () => moveActiveFile(d),
      description: 'Move the current file to another folder',
      when: onEditorFile,
    },
    'file:rename': {
      didDispatch: () => renameActiveFile(d),
      description: 'Rename (or relocate) the current file',
      when: onEditorFile,
    },
    'file:save': {
      didDispatch: () => saveActive(d),
      description: 'Save the current file',
      when: () => d.activeEditor() !== null || d.activeSavableSurface() !== null,
    },
    'file:save-as': { didDispatch: () => saveAsDialog(d), description: 'Save the current file as…', when: () => d.activeEditor() !== null },
  });
}

function saveActive(d: FileCommandsDeps) {
  // An editable multibuffer (project search OR diff) saves every file it touched, not one Document.
  const surface = d.activeSavableSurface();
  if (surface) {
    surface.save();
    return;
  }
  const editor = d.activeEditor();
  if (!editor) return;
  if (editor.currentFile) editor.save();
  else saveAsDialog(d);
}

function openDialog(d: FileCommandsDeps) {
  const dialog = new Gtk.FileDialog();
  dialog.setTitle('Open File');
  dialog.open(d.window, null, (self: any, result: any) => {
    try {
      const file = self.openFinish(result);
      if (file) d.openFile(file.getPath());
    } catch {
      // The user dismissed the dialog; nothing to do.
    }
  });
}

function saveAsDialog(d: FileCommandsDeps) {
  const editor = d.activeEditor();
  if (!editor) return;
  const dialog = new Gtk.FileDialog();
  dialog.setTitle('Save File As');
  if (editor.currentFile) dialog.setInitialName(Path.basename(editor.currentFile));
  dialog.save(d.window, null, (self: any, result: any) => {
    try {
      const file = self.saveFinish(result);
      if (file) editor.saveAs(file.getPath());
    } catch {
      // Cancelled.
    }
  });
}

/** Move the current file into a folder chosen from the directory-navigating
 *  picker (folders only), keeping its name. */
function moveActiveFile(d: FileCommandsDeps) {
  const editor = d.activeEditor();
  const file = editor?.currentFile;
  if (!editor || !file) return;
  openFolderPicker(d.overlay, d.getCwd(), Path.dirname(file), (destDir) =>
    relocateFile(d, editor, file, Path.join(destDir, Path.basename(file))),
  );
}

/** Rename (or relocate) the current file by editing its full path in the picker. */
function renameActiveFile(d: FileCommandsDeps) {
  const editor = d.activeEditor();
  const file = editor?.currentFile;
  if (!editor || !file) return;
  openRenamePicker(d.overlay, d.getCwd(), file, (target) => relocateFile(d, editor, file, target));
}

/** Move/rename `from` → `to` on disk, prompting before clobbering an existing
 *  file, then hand off to `performRelocate`. A no-op when the destination equals
 *  the source (e.g. "move here" into the same folder, or rename to the same name). */
function relocateFile(d: FileCommandsDeps, editor: TextEditor, from: string, to: string) {
  if (to === from) return;
  if (Fs.existsSync(to)) {
    const dialog = new Adw.AlertDialog({
      heading: 'Overwrite file?',
      body: `${tildify(to)} already exists. Replace it?`,
    });
    dialog.addResponse('cancel', 'Cancel');
    dialog.addResponse('overwrite', 'Overwrite');
    dialog.setResponseAppearance('overwrite', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.setDefaultResponse('cancel');
    dialog.setCloseResponse('cancel');
    dialog.on('response', (response: string) => {
      if (response === 'overwrite') void performRelocate(d, editor, from, to);
    });
    dialog.present(d.window);
    return;
  }
  void performRelocate(d, editor, from, to);
}

/**
 * The move behind `relocateFile`, run after any overwrite confirmation. First
 * asks the language server how the move rewrites references in other files
 * (`willRenameFiles`, cancellable, with a confirm before applying); then creates
 * missing parents (mkdir -p), moves the file (copy+unlink across filesystems —
 * EXDEV), re-points the open editor, and notifies the server (`didRenameFiles`).
 */
async function performRelocate(d: FileCommandsDeps, editor: TextEditor, from: string, to: string) {
  const rename = await collectRenameEdit(editor, from, to);
  if (rename.cancelled) return; // user cancelled the willRename request

  let refFiles = 0;
  let refEdits = 0;
  if (rename.edit) {
    const { files } = normalizeWorkspaceEdit(rename.edit);
    refFiles = files.length;
    refEdits = files.reduce((n, f) => n + f.edits.length, 0);
    // Confirm before touching other files; declining aborts the whole move so we
    // never leave the file renamed with its references dangling.
    if (refFiles > 0 && !(await confirmReferenceUpdate(d, from, refFiles, refEdits))) return;
  }

  // Apply the reference rewrites while everything is still at its old path (open
  // files in their buffer, closed files on disk), then move + re-point + notify.
  if (rename.edit) d.applyWorkspaceEdit(rename.edit, rename.encoding);
  try {
    Fs.mkdirSync(Path.dirname(to), { recursive: true });
    try {
      Fs.renameSync(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      Fs.copyFileSync(from, to); // cross-device: rename can't, so copy then drop the original
      Fs.unlinkSync(from);
    }
  } catch (error) {
    zym.notifications.addError('Move failed', { detail: (error as Error).message });
    return;
  }
  editor.renameTo(to); // the open editor follows the file (keeps buffer/undo/cursor)
  zym.lsp.didRenameFiles(from, to);
  const inPlace = Path.dirname(from) === Path.dirname(to);
  const base = inPlace ? `Renamed to ${Path.basename(to)}` : `Moved to ${tildify(to)}`;
  const refs = refFiles > 0
    ? ` — updated ${refEdits} reference${refEdits === 1 ? '' : 's'} in ${refFiles} file${refFiles === 1 ? '' : 's'}`
    : '';
  zym.notifications.addInfo(base + refs);
}

/**
 * Ask the primary server how moving `from` → `to` rewrites other files. Shows a
 * cancellable "Updating references…" toast — but only if the request is slow
 * enough to outlast a short delay, so quick renames don't flash it. Returns the
 * edit (possibly null when no server cares), or `{ cancelled }` if the user bailed.
 */
async function collectRenameEdit(
  editor: TextEditor,
  from: string,
  to: string,
): Promise<{ cancelled: true } | { cancelled: false; edit: WorkspaceEdit | null; encoding: PositionEncoding }> {
  const source = new CancellationTokenSource();
  let cancelled = false;
  let toast: ReturnType<typeof zym.notifications.addInfo> | undefined;
  const spinner = setTimeout(() => {
    toast = zym.notifications.addInfo('Updating references…', {
      loading: true,
      dismissable: true,
      buttons: [{ text: 'Cancel', onDidClick: () => { cancelled = true; source.cancel(); } }],
    });
  }, 300);
  let edit: WorkspaceEdit | null = null;
  try {
    edit = await zym.lsp.willRenameFiles(from, to, source.token);
  } catch {
    // Cancellation or a server error — fall through (a server error proceeds as a
    // plain move; an explicit cancel is caught by the flag below).
  } finally {
    clearTimeout(spinner);
    toast?.dismiss();
  }
  if (cancelled) return { cancelled: true };
  return { cancelled: false, edit, encoding: zym.lsp.completionPositionEncoding(editor.lsp) ?? 'utf-16' };
}

/** Confirm applying the cross-file reference rewrites of a move (Move & Update / Cancel). */
function confirmReferenceUpdate(d: FileCommandsDeps, from: string, fileCount: number, editCount: number): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = new Adw.AlertDialog({
      heading: 'Update references?',
      body:
        `Moving ${Path.basename(from)} updates ${editCount} reference${editCount === 1 ? '' : 's'} ` +
        `across ${fileCount} file${fileCount === 1 ? '' : 's'}.`,
    });
    dialog.addResponse('cancel', 'Cancel');
    dialog.addResponse('move', 'Move & Update');
    dialog.setResponseAppearance('move', Adw.ResponseAppearance.SUGGESTED);
    dialog.setDefaultResponse('move');
    dialog.setCloseResponse('cancel');
    dialog.on('response', (response: string) => resolve(response === 'move'));
    dialog.present(d.window);
  });
}
