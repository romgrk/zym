/*
 * LspCommands — the window-level `lsp:*` (and `tag:rename`) commands: navigation,
 * hover, references, symbol pickers, code actions, rename, and formatting. Split out
 * of AppWindow so the LSP orchestration isn't tangled into the shell. The GTK-free LSP
 * core lives in `src/lsp/`; this module is the GTK-facing command surface over it.
 *
 * Atom-style, the active editor, active workbench cwd, picker host, file-open, and
 * workspace-edit application are read off the `zym` globals; only the shared document
 * registry (a live peek attaches to an already-open document) is injected.
 */
import * as Fs from 'node:fs';
import { zym } from '../zym.ts';
import { TextEditor } from './TextEditor/index.ts';
import { DocumentRegistry } from './TextEditor/DocumentRegistry.ts';
import { buildDefinitionPeek, wrapPeekBody, LIVE_PEEK_HEIGHT } from './TextEditor/buildDefinitionPeek.ts';
import { openWorkspaceSymbolPicker } from './WorkspaceSymbolPicker.ts';
import { openDocumentSymbolPicker } from './DocumentSymbolPicker.ts';
import { openReferencesPicker } from './ReferencesPicker.ts';
import { openPicker, highlightSegment } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { type NavigationKind } from '../lsp/LspManager.ts';
import type { CodeAction, Command } from 'vscode-languageserver-protocol';
import type { Disposable } from '../util/eventKit.ts';

export interface LspCommandsDeps {
  /** The shared document registry — a live peek attaches to an already-open document. */
  documents: DocumentRegistry;
}

const host = () => zym.workspace.getPickerHost();
const activeEditor = () => zym.workspace.getActiveTextEditor();

/** Register the window-level `lsp:*` / `tag:rename` commands on `.AppWindow`. */
export function registerLspCommands(d: LspCommandsDeps): Disposable {
  return zym.commands.add('.AppWindow', {
    'lsp:go-to-definition': { didDispatch: () => void goto('definition'), description: 'Go to definition' },
    'lsp:peek-definition': { didDispatch: () => void peekDefinition(d), description: 'Peek definition (inline)' },
    'lsp:go-to-declaration': { didDispatch: () => void goto('declaration'), description: 'Go to declaration' },
    'lsp:go-to-type-definition': { didDispatch: () => void goto('typeDefinition'), description: 'Go to type definition' },
    'lsp:go-to-implementation': { didDispatch: () => void goto('implementation'), description: 'Go to implementation' },
    'lsp:find-references': { didDispatch: () => void findReferences(), description: 'Find references' },
    'lsp:workspace-symbols': { didDispatch: () => workspaceSymbolPicker(), description: 'Go to workspace symbol…' },
    'lsp:document-symbols': { didDispatch: () => void documentSymbolPicker(), description: 'Go to symbol in document…' },
    'lsp:hover': { didDispatch: () => void activeEditor()?.hover(), description: 'Show hover (type / docs)' },
    'lsp:code-action': { didDispatch: () => void codeActionMenu(), description: 'Code action / quick fix…' },
    'lsp:rename': { didDispatch: () => renamePrompt(), description: 'Rename symbol…' },
    'tag:rename': { didDispatch: () => renameTagPrompt(), description: 'Rename JSX/HTML tag pair…' },
    'lsp:format': { didDispatch: () => void formatActive(), description: 'Format document' },
    'lsp:install-server': { didDispatch: () => installServerPicker(), description: 'Install a language server…' },
  });
}

// Resolve a navigation (definition/declaration/type-def/impl) at the active
// editor's cursor and jump there, opening/revealing the target file.
async function goto(kind: NavigationKind) {
  const editor = activeEditor();
  if (!editor) return;
  const target = await zym.lsp.goto(editor.lsp, kind);
  if (!target) return;
  zym.workspace.openFile(target.path, { cursor: [target.point.row, target.point.column] });
}

// See-definition: inline the definition in a focusable peek below the cursor,
// instead of jumping. Toggles closed if one is already open.
async function peekDefinition(d: LspCommandsDeps) {
  const editor = activeEditor();
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
    zym.notifications.addInfo(`Can't read ${target.path}`);
    return;
  }
  const { widget, height } = buildDefinitionPeek(target, content, () => editor.closePeek());
  editor.showPeek({ widget, height });
}

// Find references to the symbol at the cursor and present them in a picker (with
// a source preview) to jump to one.
async function findReferences() {
  const editor = activeEditor();
  if (!editor) return;
  const refs = await zym.lsp.references(editor.lsp);
  if (refs.length === 0) {
    zym.notifications.addInfo('No references found');
    return;
  }
  const cwd = zym.workspace.getActiveWorkbench()!.cwd;
  openReferencesPicker(host(), refs, cwd, (path, cursor) => zym.workspace.openFile(path, { cursor }));
}

// Search project-wide symbols in a picker and jump to the chosen one. Project-
// scoped, so it runs from any tab: the active file's language server when there is
// one, else the first running server that supports workspace symbols.
function workspaceSymbolPicker() {
  const doc = activeEditor()?.lsp ?? null;
  if (!zym.lsp.canWorkspaceSymbols(doc)) {
    zym.notifications.addInfo('No workspace symbol search available (no language server running)');
    return;
  }
  const cwd = zym.workspace.getActiveWorkbench()!.cwd;
  openWorkspaceSymbolPicker(host(), doc, cwd, (path, cursor) => zym.workspace.openFile(path, { cursor }));
}

// List the current file's symbol outline (via its language server) in a picker
// and jump to the chosen one within the active editor.
async function documentSymbolPicker() {
  const editor = activeEditor();
  if (!editor) return;
  if (!zym.lsp.canDocumentSymbols(editor.lsp)) {
    zym.notifications.addInfo('No document symbol support for this file');
    return;
  }
  await openDocumentSymbolPicker(host(), editor.lsp, (cursor) => {
    editor.restoreCursor(cursor);
    editor.focus();
  }, editor.root);
}

// Offer code actions / quick-fixes at the cursor in a picker; apply the chosen one.
async function codeActionMenu() {
  const editor = activeEditor();
  if (!editor || !editor.currentFile) return;
  const actions = await zym.lsp.codeActions(editor.lsp);
  if (actions.length === 0) {
    zym.notifications.addInfo('No code actions available');
    return;
  }
  openPicker({
    host: host(),
    placeholder: 'Code action',
    items: actions.map((a, i) => ({ value: String(i), text: a.title })),
    onSelect: (value) => void runCodeAction(editor, actions[Number(value)]),
  });
}

// Apply a chosen code action: resolve its lazy edit, then apply it. Command-only
// actions (workspace/executeCommand) and file resource ops aren't wired yet.
async function runCodeAction(editor: TextEditor, action: Command | CodeAction) {
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
  const { resourceOps } = zym.workspace.applyWorkspaceEdit(resolved.edit, encoding);
  if (resourceOps > 0) {
    zym.notifications.addWarning(`LSP: "${action.title}" includes ${resourceOps} file operation(s) not yet applied`);
  }
}

// Prompt for a new name (prefilled with the symbol under the cursor) and rename.
function renamePrompt() {
  const editor = activeEditor();
  if (!editor || !editor.currentFile) return;
  if (!zym.lsp.canRename(editor.lsp)) {
    zym.notifications.addInfo('Rename is not available here');
    return;
  }
  openPicker({
    host: host(),
    placeholder: 'New name',
    query: editor.getWordUnderCursor(),
    items: [],
    actionWhenEmpty: true,
    onSelect: () => {}, // no items — the action row drives the rename
    action: { label: (q) => `Rename to "${q}"`, run: (q) => void runRename(editor, q.trim()) },
  });
}

// Rename the JSX/HTML tag at the cursor — both halves of the pair together.
function renameTagPrompt() {
  const editor = activeEditor();
  if (!editor) return;
  const names = editor.tagNamesAtCursor();
  if (!names) {
    zym.notifications.addInfo('Not on a JSX/HTML tag');
    return;
  }
  openPicker({
    host: host(),
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

async function runRename(editor: TextEditor, newName: string) {
  if (!newName) return;
  const edit = await zym.lsp.rename(editor.lsp, newName);
  if (!edit) {
    zym.notifications.addInfo('Rename produced no changes');
    return;
  }
  const encoding = zym.lsp.completionPositionEncoding(editor.lsp) ?? 'utf-16';
  const { applied, resourceOps } = zym.workspace.applyWorkspaceEdit(edit, encoding);
  if (resourceOps > 0) zym.notifications.addWarning(`Rename: ${resourceOps} file operation(s) not yet applied`);
  else zym.notifications.addInfo(`Renamed across ${applied} file${applied === 1 ? '' : 's'}`);
}

// Format the active document and apply the edits to its buffer.
async function formatActive() {
  const editor = activeEditor();
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
function installServerPicker() {
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
    host: host(),
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
