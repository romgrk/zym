/*
 * LspCommands — the window-level `lsp:*` (and `tag:rename`) commands: navigation,
 * hover, references, symbol pickers, code actions, rename, and formatting. Split out
 * of AppWindow so the LSP orchestration isn't tangled into the shell. The GTK-free LSP
 * core lives in `src/lsp/`; this module is the GTK-facing command surface over it.
 *
 * The active editor / cwd / file-open / workspace-edit application all depend on the
 * panel-tree state AppWindow owns, so they're injected as a deps object (the
 * `registerGithubCommands` idiom). Pure dispatch + the per-command pickers live here.
 */
import * as Fs from 'node:fs';
import Gtk from 'gi:Gtk-4.0';
import { zym } from '../zym.ts';
import { TextEditor } from './TextEditor/index.ts';
import { DocumentRegistry } from './TextEditor/DocumentRegistry.ts';
import { buildDefinitionPeek, wrapPeekBody, LIVE_PEEK_HEIGHT } from './TextEditor/buildDefinitionPeek.ts';
import { openWorkspaceSymbolPicker } from './WorkspaceSymbolPicker.ts';
import { openDocumentSymbolPicker } from './DocumentSymbolPicker.ts';
import { openReferencesPicker } from './ReferencesPicker.ts';
import { openPicker, highlightSegment } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { type NavigationKind, type LspDocument } from '../lsp/LspManager.ts';
import { type PositionEncoding } from '../lsp/position.ts';
import type { WorkspaceEdit, CodeAction, Command } from 'vscode-languageserver-protocol';
import type { Disposable } from '../util/eventKit.ts';

export interface LspCommandsDeps {
  overlay: InstanceType<typeof Gtk.Overlay>;
  /** The text editor backing the focused tab, if any. */
  activeEditor: () => TextEditor | null;
  /** The active workbench's root directory (for workspace-symbol scoping). */
  getCwd: () => string;
  /** Open (revealing an already-open tab) `path` and place the cursor. */
  openOrFocusFile: (path: string, cursor: [number, number]) => void;
  /** Apply an LSP WorkspaceEdit to open editors / on-disk files. */
  applyWorkspaceEdit: (edit: WorkspaceEdit, encoding: PositionEncoding) => { applied: number; resourceOps: number };
  /** The shared document registry — a live peek attaches to an already-open document. */
  documents: DocumentRegistry;
  toast: (message: string) => void;
}

/** Register the window-level `lsp:*` / `tag:rename` commands on `.AppWindow`. */
export function registerLspCommands(d: LspCommandsDeps): Disposable {
  return zym.commands.add('.AppWindow', {
    'lsp:go-to-definition': { didDispatch: () => void goto(d, 'definition'), description: 'Go to definition' },
    'lsp:peek-definition': { didDispatch: () => void peekDefinition(d), description: 'Peek definition (inline)' },
    'lsp:go-to-declaration': { didDispatch: () => void goto(d, 'declaration'), description: 'Go to declaration' },
    'lsp:go-to-type-definition': { didDispatch: () => void goto(d, 'typeDefinition'), description: 'Go to type definition' },
    'lsp:go-to-implementation': { didDispatch: () => void goto(d, 'implementation'), description: 'Go to implementation' },
    'lsp:find-references': { didDispatch: () => void findReferences(d), description: 'Find references' },
    'lsp:workspace-symbols': { didDispatch: () => workspaceSymbolPicker(d), description: 'Go to workspace symbol…' },
    'lsp:document-symbols': { didDispatch: () => void documentSymbolPicker(d), description: 'Go to symbol in document…' },
    'lsp:hover': { didDispatch: () => void d.activeEditor()?.hover(), description: 'Show hover (type / docs)' },
    'lsp:code-action': { didDispatch: () => void codeActionMenu(d), description: 'Code action / quick fix…' },
    'lsp:rename': { didDispatch: () => renamePrompt(d), description: 'Rename symbol…' },
    'tag:rename': { didDispatch: () => renameTagPrompt(d), description: 'Rename JSX/HTML tag pair…' },
    'lsp:format': { didDispatch: () => void formatActive(d), description: 'Format document' },
    'lsp:install-server': { didDispatch: () => installServerPicker(d), description: 'Install a language server…' },
  });
}

// The identifier under the cursor (for prefilling the rename prompt). Codepoint-
// aware: columns are codepoints, so index the line as codepoints.
function wordUnderCursor(doc: LspDocument): string {
  const cursor = doc.getCursorBufferPosition();
  const cp = [...doc.lineTextForRow(cursor.row)];
  let start = cursor.column;
  let end = cursor.column;
  while (start > 0 && /\w/.test(cp[start - 1])) start--;
  while (end < cp.length && /\w/.test(cp[end])) end++;
  return cp.slice(start, end).join('');
}

// Resolve a navigation (definition/declaration/type-def/impl) at the active
// editor's cursor and jump there, opening/revealing the target file.
async function goto(d: LspCommandsDeps, kind: NavigationKind) {
  const editor = d.activeEditor();
  if (!editor) return;
  const target = await zym.lsp.goto(editor.lsp, kind);
  if (!target) return;
  d.openOrFocusFile(target.path, [target.point.row, target.point.column]);
}

// See-definition: inline the definition in a focusable peek below the cursor,
// instead of jumping. Toggles closed if one is already open.
async function peekDefinition(d: LspCommandsDeps) {
  const editor = d.activeEditor();
  if (!editor) return;
  if (editor.peekOpen) {
    editor.closePeek();
    return;
  }
  const target = await zym.lsp.goto(editor.lsp, 'definition');
  if (!target) return;

  // If the definition's file is already open, peek a *live* read-only view onto its
  // shared Document — edits in the open file show in the peek and vice versa.
  const openDoc = d.documents.find(target.path);
  if (openDoc) {
    d.documents.acquire(target.path); // hold a ref so closing the source tab won't dispose it
    const peekEditor = new TextEditor({
      document: openDoc,
      onReleaseDocument: () => d.documents.release(openDoc),
      peek: true,
    });
    peekEditor.revealPeekRow(target.point.row);
    const { widget, height } = wrapPeekBody(target, peekEditor.root, LIVE_PEEK_HEIGHT, () => editor.closePeek());
    editor.showPeek({ widget, height });
    return;
  }

  // Otherwise fall back to a read-only snapshot slice read from disk.
  let content: string;
  try {
    content = Fs.readFileSync(target.path, 'utf8');
  } catch {
    d.toast(`Can't read ${target.path}`);
    return;
  }
  const { widget, height } = buildDefinitionPeek(target, content, () => editor.closePeek());
  editor.showPeek({ widget, height });
}

// Find references to the symbol at the cursor and present them in a picker (with
// a source preview) to jump to one.
async function findReferences(d: LspCommandsDeps) {
  const editor = d.activeEditor();
  if (!editor) return;
  const refs = await zym.lsp.references(editor.lsp);
  if (refs.length === 0) {
    zym.notifications.addInfo('No references found');
    return;
  }
  openReferencesPicker(d.overlay, refs, (path, cursor) => d.openOrFocusFile(path, cursor));
}

// Search project-wide symbols (via the active file's language server) in a
// picker and jump to the chosen one.
function workspaceSymbolPicker(d: LspCommandsDeps) {
  const editor = d.activeEditor();
  if (!editor) return;
  if (!zym.lsp.canWorkspaceSymbols(editor.lsp)) {
    zym.notifications.addInfo('No workspace symbol support for this file');
    return;
  }
  openWorkspaceSymbolPicker(d.overlay, editor.lsp, d.getCwd(), (path, cursor) => d.openOrFocusFile(path, cursor));
}

// List the current file's symbol outline (via its language server) in a picker
// and jump to the chosen one within the active editor.
async function documentSymbolPicker(d: LspCommandsDeps) {
  const editor = d.activeEditor();
  if (!editor) return;
  if (!zym.lsp.canDocumentSymbols(editor.lsp)) {
    zym.notifications.addInfo('No document symbol support for this file');
    return;
  }
  await openDocumentSymbolPicker(d.overlay, editor.lsp, (cursor) => {
    editor.restoreCursor(cursor);
    editor.focus();
  }, editor.root);
}

// Offer code actions / quick-fixes at the cursor in a picker; apply the chosen one.
async function codeActionMenu(d: LspCommandsDeps) {
  const editor = d.activeEditor();
  if (!editor || !editor.currentFile) return;
  const actions = await zym.lsp.codeActions(editor.lsp);
  if (actions.length === 0) {
    zym.notifications.addInfo('No code actions available');
    return;
  }
  openPicker({
    host: d.overlay,
    placeholder: 'Code action',
    items: actions.map((a, i) => ({ value: String(i), text: a.title })),
    onSelect: (value) => void runCodeAction(d, editor, actions[Number(value)]),
  });
}

// Apply a chosen code action: resolve its lazy edit, then apply it. Command-only
// actions (workspace/executeCommand) and file resource ops aren't wired yet.
async function runCodeAction(d: LspCommandsDeps, editor: TextEditor, action: Command | CodeAction) {
  const isBareCommand = typeof (action as Command).command === 'string' && !('kind' in action) && !('edit' in action);
  if (isBareCommand) {
    zym.notifications.addWarning(`LSP: "${action.title}" needs command execution (not yet supported)`);
    return;
  }
  const resolved = await zym.lsp.resolveCodeAction(editor.lsp, action as CodeAction);
  if (!resolved.edit) {
    zym.notifications.addWarning(`LSP: "${action.title}" needs command execution (not yet supported)`);
    return;
  }
  const encoding = zym.lsp.completionPositionEncoding(editor.lsp) ?? 'utf-16';
  const { resourceOps } = d.applyWorkspaceEdit(resolved.edit, encoding);
  if (resourceOps > 0) {
    zym.notifications.addWarning(`LSP: "${action.title}" includes ${resourceOps} file operation(s) not yet applied`);
  }
}

// Prompt for a new name (prefilled with the symbol under the cursor) and rename.
function renamePrompt(d: LspCommandsDeps) {
  const editor = d.activeEditor();
  if (!editor || !editor.currentFile) return;
  if (!zym.lsp.canRename(editor.lsp)) {
    zym.notifications.addInfo('Rename is not available here');
    return;
  }
  openPicker({
    host: d.overlay,
    placeholder: 'New name',
    query: wordUnderCursor(editor.lsp),
    items: [],
    actionWhenEmpty: true,
    onSelect: () => {}, // no items — the action row drives the rename
    action: { label: (q) => `Rename to "${q}"`, run: (q) => void runRename(d, editor, q.trim()) },
  });
}

// Rename the JSX/HTML tag at the cursor — both halves of the pair together.
function renameTagPrompt(d: LspCommandsDeps) {
  const editor = d.activeEditor();
  if (!editor) return;
  const names = editor.tagNamesAtCursor();
  if (!names) {
    zym.notifications.addInfo('Not on a JSX/HTML tag');
    return;
  }
  openPicker({
    host: d.overlay,
    placeholder: 'New tag name',
    query: names[0].text,
    items: [],
    actionWhenEmpty: true,
    onSelect: () => {},
    action: {
      label: (q) => `Rename tag to "${q}"`,
      run: (q) => { const n = q.trim(); if (n) editor.applyTagRename(names, n); },
    },
  });
}

async function runRename(d: LspCommandsDeps, editor: TextEditor, newName: string) {
  if (!newName) return;
  const edit = await zym.lsp.rename(editor.lsp, newName);
  if (!edit) {
    zym.notifications.addInfo('Rename produced no changes');
    return;
  }
  const encoding = zym.lsp.completionPositionEncoding(editor.lsp) ?? 'utf-16';
  const { applied, resourceOps } = d.applyWorkspaceEdit(edit, encoding);
  if (resourceOps > 0) zym.notifications.addWarning(`Rename: ${resourceOps} file operation(s) not yet applied`);
  else zym.notifications.addInfo(`Renamed across ${applied} file${applied === 1 ? '' : 's'}`);
}

// Format the active document and apply the edits to its buffer.
async function formatActive(d: LspCommandsDeps) {
  const editor = d.activeEditor();
  if (!editor || !editor.currentFile) return;
  const options = {
    tabSize: (zym.config.get('editor.tabLength') as number) ?? 2,
    insertSpaces: (zym.config.get('editor.insertSpaces') as boolean) ?? true,
  };
  const edits = await zym.lsp.format(editor.lsp, options);
  if (edits.length === 0) {
    zym.notifications.addInfo('No formatting changes');
    return;
  }
  editor.applyLspEdits(edits, zym.lsp.completionPositionEncoding(editor.lsp) ?? 'utf-16');
}

// Pick a language server to install (into the zym-managed dir). Already-
// installed and in-progress servers are shown dimmed with a status note.
function installServerPicker(d: LspCommandsDeps) {
  const items = zym.lsp.installableServers().map((s) => {
    const status = s.installing ? 'installing…' : s.installed ? 'installed' : 'not installed';
    const text = `${s.name}  ${status}`;
    return {
      value: s.name,
      text,
      data: s.name.length,
    };
  });
  openPicker({
    host: d.overlay,
    placeholder: 'Install language server',
    items,
    renderRow: (item, positions) => {
      const split = item.data as number;
      return renderRowSingleLine({
        main: highlightSegment(item.text, 0, split, positions),
        detail: highlightSegment(item.text, split + 2, item.text.length, positions),
      });
    },
    onSelect: (name) => void zym.lsp.installByName(name),
  });
}
