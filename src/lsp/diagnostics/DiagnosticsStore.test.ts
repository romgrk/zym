import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Diagnostic } from 'vscode-languageserver-protocol';
import { DiagnosticsStore } from './DiagnosticsStore.ts';

// A diagnostic on a single line (its `start` drives merge ordering).
function diag(line: number, message: string): Diagnostic {
  return { range: { start: { line, character: 0 }, end: { line, character: 1 } }, message };
}

test('two servers for one path accumulate instead of clobbering', () => {
  const store = new DiagnosticsStore();
  store.set('tsserver', '/a.ts', [diag(2, 'ts error')], 'utf-16');
  store.set('eslint', '/a.ts', [diag(5, 'lint warn')], 'utf-8');

  const merged = store.get('/a.ts');
  assert.equal(merged.length, 2);
  assert.equal(store.count, 2);
  // Merged and sorted by position; each carries its own server's encoding.
  assert.deepEqual(merged.map((e) => e.diagnostic.message), ['ts error', 'lint warn']);
  assert.equal(merged[0].encoding, 'utf-16'); // tsserver (line 2)
  assert.equal(merged[1].encoding, 'utf-8'); // eslint (line 5)
});

test('a server replacing its own set leaves the other server untouched', () => {
  const store = new DiagnosticsStore();
  store.set('tsserver', '/a.ts', [diag(2, 'ts error')], 'utf-16');
  store.set('eslint', '/a.ts', [diag(5, 'lint warn')], 'utf-16');

  // tsserver re-publishes (its error is fixed → empty); eslint's stays.
  store.set('tsserver', '/a.ts', [], 'utf-16');
  assert.deepEqual(store.get('/a.ts').map((e) => e.diagnostic.message), ['lint warn']);
  assert.equal(store.count, 1);
});

test('clearServer drops one server; clear drops the whole path', () => {
  const store = new DiagnosticsStore();
  store.set('tsserver', '/a.ts', [diag(0, 'a')], 'utf-16');
  store.set('eslint', '/a.ts', [diag(1, 'b')], 'utf-16');

  store.clearServer('eslint', '/a.ts');
  assert.deepEqual(store.get('/a.ts').map((e) => e.diagnostic.message), ['a']);
  assert.deepEqual(store.paths(), ['/a.ts']);

  store.clear('/a.ts');
  assert.deepEqual(store.get('/a.ts'), []);
  assert.deepEqual(store.paths(), []);
  assert.equal(store.count, 0);
});

test('clearing the last server for a path removes the path entry', () => {
  const store = new DiagnosticsStore();
  store.set('tsserver', '/a.ts', [diag(0, 'a')], 'utf-16');
  store.set('tsserver', '/a.ts', [], 'utf-16'); // server clears its diagnostics
  assert.deepEqual(store.paths(), []);
});

test('did-update fires with the affected path on set and clear', () => {
  const store = new DiagnosticsStore();
  const seen: string[] = [];
  store.onDidUpdate((p) => seen.push(p));
  store.set('tsserver', '/a.ts', [diag(0, 'a')], 'utf-16');
  store.clear('/a.ts');
  assert.deepEqual(seen, ['/a.ts', '/a.ts']);
});
