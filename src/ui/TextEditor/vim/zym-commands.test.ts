import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.ts';
import { Base } from './base.ts';
import { StatusBarManager } from './stubs.ts';
import { tmpDir } from '../../../util/testTmp.ts';
import './operations/mode.ts';
import './motion.ts';
import './operator.ts';
import './operator-insert.ts';
import './text-object.ts';
import { filenameTokenAt, resolveFilePath, googleSearchUrl } from './zym-commands.ts';

Gtk.init();

function setup(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  const vimState = new VimState(editor, new StatusBarManager());
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (row: number, col: number) => editor.setCursorBufferPosition(new Point(row, col));
  return { editor, vimState, run, at };
}

// filenameTokenAt — pure token extraction
// ---------------------------------------------------------------------------

test('filenameTokenAt: cursor inside a path token', () => {
  const line = 'import { x } from "./foo/bar.ts";';
  const col = line.indexOf('bar');
  assert.equal(filenameTokenAt(line, col), './foo/bar.ts');
});

test('filenameTokenAt: cursor at the start of the token', () => {
  const line = 'see ./a/b.txt here';
  assert.equal(filenameTokenAt(line, line.indexOf('./a')), './a/b.txt');
});

test('filenameTokenAt: cursor at the end of the token (on the delimiter)', () => {
  const line = 'path/to/file.md, rest';
  // column points at the comma right after the token
  assert.equal(filenameTokenAt(line, 'path/to/file.md'.length), 'path/to/file.md');
});

test('filenameTokenAt: cursor on whitespace seeks the next token', () => {
  const line = '   ./next.ts';
  assert.equal(filenameTokenAt(line, 0), './next.ts');
});

test('filenameTokenAt: no token on/after the cursor returns empty', () => {
  assert.equal(filenameTokenAt('a/b.ts   ', 8), '');
  assert.equal(filenameTokenAt('', 0), '');
});

test('filenameTokenAt: stops at quotes and parentheses', () => {
  const line = "require('lib/util.js')";
  assert.equal(filenameTokenAt(line, line.indexOf('util')), 'lib/util.js');
});

// resolveFilePath — path resolution against existing files
// ---------------------------------------------------------------------------

test('resolveFilePath: absolute path that exists', () => {
  const dir = tmpDir('gf');
  const file = Path.join(dir, 'abs.txt');
  Fs.writeFileSync(file, 'x');
  assert.equal(resolveFilePath(file, null, dir), file);
});

test('resolveFilePath: relative to the current file directory', () => {
  const dir = tmpDir('gf');
  const sub = Path.join(dir, 'sub');
  Fs.mkdirSync(sub);
  const target = Path.join(sub, 'sibling.ts');
  Fs.writeFileSync(target, 'x');
  const currentFile = Path.join(sub, 'main.ts');
  assert.equal(resolveFilePath('./sibling.ts', currentFile, dir), target);
});

test('resolveFilePath: relative to the project root', () => {
  const root = tmpDir('gf');
  const target = Path.join(root, 'src', 'thing.ts');
  Fs.mkdirSync(Path.dirname(target), { recursive: true });
  Fs.writeFileSync(target, 'x');
  const rel = Path.join('src', 'thing.ts');
  assert.equal(resolveFilePath(rel, null, root), target);
});

test('resolveFilePath: ~ expands to the home directory', () => {
  // Resolution requires the file to exist; assert the candidate when present.
  const home = Os.homedir();
  const entries = Fs.readdirSync(home).filter((e) => {
    try { return Fs.statSync(Path.join(home, e)).isFile(); } catch { return false; }
  });
  if (entries.length === 0) return; // no file in $HOME — skip
  const token = '~/' + entries[0];
  assert.equal(resolveFilePath(token, null, home), Path.join(home, entries[0]));
});

test('resolveFilePath: missing file returns null', () => {
  assert.equal(resolveFilePath('./does-not-exist-xyz.ts', null, tmpDir('gf')), null);
});

test('resolveFilePath: a directory is not a valid target', () => {
  const dir = tmpDir('gf');
  assert.equal(resolveFilePath(dir, null, dir), null);
});

// googleSearchUrl — query encoding
// ---------------------------------------------------------------------------

test('googleSearchUrl: encodes the query', () => {
  assert.equal(
    googleSearchUrl('foo bar & baz'),
    'https://www.google.com/search?q=foo%20bar%20%26%20baz',
  );
});

// Operation query extraction (editor-dependent) via the operation instances
// ---------------------------------------------------------------------------

test('GoogleSearch.getQuery: word under the cursor in normal mode', () => {
  const { vimState, at } = setup('const fooBar = 1\n');
  at(0, 8); // inside "fooBar"
  const op = Base.getInstance(vimState, 'GoogleSearch') as Base & { getQuery(): string };
  assert.equal(op.getQuery(), 'fooBar');
});

test('GoogleSearch.getQuery: selection in visual mode', () => {
  const { vimState, run, at } = setup('hello world\n');
  at(0, 0);
  run('ActivateCharacterwiseVisualMode');
  run('MoveToEndOfWord'); // select "hello"
  const op = Base.getInstance(vimState, 'GoogleSearch') as Base & { getQuery(): string };
  assert.equal(op.getQuery(), 'hello');
});

test('GoToFile.getFileToken: token under the cursor', () => {
  const { vimState, at } = setup('import x from "./mod/thing.ts"\n');
  at(0, 16); // inside "./mod/thing.ts"
  const op = Base.getInstance(vimState, 'GoToFile') as Base & { getFileToken(): string };
  assert.equal(op.getFileToken(), './mod/thing.ts');
});

test('GoToFile via the operation stack: unresolved token is a no-op (no throw)', () => {
  // End-to-end dispatch: a token that resolves to no file just notifies; it must
  // not throw, open a browser, or move the cursor. (A resolvable token would call
  // workspace.openFile, which we don't exercise here.)
  const { editor, vimState, at } = setup('./definitely-missing-xyz.ts\n');
  at(0, 4);
  assert.doesNotThrow(() => vimState.operationStack.run('GoToFile'));
  assert.equal(editor.getCursorBufferPosition().row, 0);
  assert.ok(vimState.isMode('normal'));
});
