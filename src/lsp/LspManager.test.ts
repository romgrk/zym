import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { Point } from '../text/Point.ts';
import { resolveRootDir, locationToTarget, primaryKeyOf, type LspDocument } from './LspManager.ts';
import { serverKey } from './LanguageServer.ts';
import type { ActiveServer } from '../lang/types.ts';
import { pathToUri } from './position.ts';

function tmpTree(): string {
  return Fs.mkdtempSync(Path.join(Os.tmpdir(), 'quilx-lsp-'));
}

test('resolveRootDir picks the nearest dir with a root marker', () => {
  const root = tmpTree();
  Fs.writeFileSync(Path.join(root, 'package.json'), '{}');
  const sub = Path.join(root, 'src', 'deep');
  Fs.mkdirSync(sub, { recursive: true });
  const file = Path.join(sub, 'a.ts');
  Fs.writeFileSync(file, '');
  assert.equal(resolveRootDir(file, ['package.json', 'tsconfig.json']), root);
  Fs.rmSync(root, { recursive: true, force: true });
});

test('resolveRootDir falls back to .git, then to the file dir', () => {
  const root = tmpTree();
  Fs.mkdirSync(Path.join(root, '.git'));
  const sub = Path.join(root, 'pkg');
  Fs.mkdirSync(sub);
  const file = Path.join(sub, 'main.rs');
  Fs.writeFileSync(file, '');
  // No Cargo.toml anywhere → falls back to the .git dir.
  assert.equal(resolveRootDir(file, ['Cargo.toml']), root);

  // Neither marker nor .git → the file's own directory.
  const bare = tmpTree();
  const f2 = Path.join(bare, 'x.rs');
  Fs.writeFileSync(f2, '');
  assert.equal(resolveRootDir(f2, ['Cargo.toml']), bare);

  Fs.rmSync(root, { recursive: true, force: true });
  Fs.rmSync(bare, { recursive: true, force: true });
});

test('resolveRootDir prefers a closer marker over a farther .git', () => {
  const root = tmpTree();
  Fs.mkdirSync(Path.join(root, '.git'));
  const inner = Path.join(root, 'inner');
  Fs.mkdirSync(inner);
  Fs.writeFileSync(Path.join(inner, 'Cargo.toml'), '');
  const file = Path.join(inner, 'src.rs');
  Fs.writeFileSync(file, '');
  assert.equal(resolveRootDir(file, ['Cargo.toml']), inner);
  Fs.rmSync(root, { recursive: true, force: true });
});

const active = (name: string, opts: { group?: string; priority?: number } = {}): ActiveServer => ({
  server: { name, command: name, group: opts.group, priority: opts.priority },
  rootDir: '/proj',
});

test('primaryKeyOf: a grouped server wins over an ungrouped linter', () => {
  // tsserver (grouped) + eslint (ungrouped) → requests target tsserver.
  const servers = [active('eslint'), active('tsserver', { group: 'js-types', priority: 10 })];
  assert.equal(primaryKeyOf(servers), serverKey('tsserver', '/proj'));
});

test('primaryKeyOf: among grouped servers the highest priority wins', () => {
  const servers = [
    active('tsserver', { group: 'js-types', priority: 10 }),
    active('deno', { group: 'js-types', priority: 30 }),
  ];
  assert.equal(primaryKeyOf(servers), serverKey('deno', '/proj'));
});

test('primaryKeyOf: with only ungrouped servers, falls back to the first', () => {
  assert.equal(primaryKeyOf([active('eslint'), active('other')]), serverKey('eslint', '/proj'));
  assert.equal(primaryKeyOf([]), null);
});

const fakeDoc = (path: string | null, lines: string[]): LspDocument => ({
  getPath: () => path,
  getText: () => lines.join('\n'),
  lineTextForRow: (row) => lines[row] ?? '',
  getCursorBufferPosition: () => Point.ZERO,
});

test('locationToTarget converts using the open doc when same file', () => {
  const doc = fakeDoc('/proj/a.ts', ['const a = 1', 'let b\u{1F600}c = 2']);
  const target = locationToTarget(pathToUri('/proj/a.ts'), { line: 1, character: 8 }, 'utf-16', doc);
  assert.equal(target.path, '/proj/a.ts');
  // char 8 in utf-16 over "let b😀c = 2" → codepoint column 7 (emoji is 2 units).
  assert.deepEqual(target.point.toArray(), [1, 7]);
});

test('locationToTarget reads a different file from disk', () => {
  const root = tmpTree();
  const other = Path.join(root, 'other.ts');
  Fs.writeFileSync(other, 'line0\nconst target = 1\n');
  const doc = fakeDoc('/proj/a.ts', ['irrelevant']);
  const target = locationToTarget(pathToUri(other), { line: 1, character: 6 }, 'utf-16', doc);
  assert.equal(target.path, other);
  assert.deepEqual(target.point.toArray(), [1, 6]);
  Fs.rmSync(root, { recursive: true, force: true });
});
