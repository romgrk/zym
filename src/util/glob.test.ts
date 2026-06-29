import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, compileGlobFilter } from './glob.ts';

test('globToRegExp: segment vs. cross-segment wildcards', () => {
  assert.ok(globToRegExp('*.ts').test('a.ts'));
  assert.ok(!globToRegExp('*.ts').test('dir/a.ts')); // `*` stays within a segment
  assert.ok(globToRegExp('**/*.ts').test('dir/sub/a.ts'));
  assert.ok(globToRegExp('**/*.{ts,tsx}').test('x.tsx'));
});

const sel = (pattern: string, paths: string[]) => paths.filter((p) => compileGlobFilter(pattern).test(p));

test('compileGlobFilter: a no-slash term matches the basename at any depth', () => {
  const paths = ['src/ui/DiffView.ts', 'src/ui/DiffView.test.ts', 'README.md', 'docs/index.md'];
  assert.deepEqual(sel('*.ts', paths), ['src/ui/DiffView.ts', 'src/ui/DiffView.test.ts']);
  assert.deepEqual(sel('*.md', paths), ['README.md', 'docs/index.md']);
});

test('compileGlobFilter: a term with a slash matches the whole relative path', () => {
  const paths = ['src/ui/DiffView.ts', 'src/lsp/glob.ts', 'docs/index.md'];
  assert.deepEqual(sel('src/ui/*', paths), ['src/ui/DiffView.ts']);
  assert.deepEqual(sel('src/**', paths), ['src/ui/DiffView.ts', 'src/lsp/glob.ts']);
  assert.deepEqual(sel('docs/**', paths), ['docs/index.md']);
});

test('compileGlobFilter: comma joins terms, "!" negates (exclusion wins)', () => {
  const paths = ['a.ts', 'a.test.ts', 'b.tsx', 'c.md'];
  // every .ts except tests
  assert.deepEqual(sel('*.ts, !*.test.ts', paths), ['a.ts']);
  // union of positives
  assert.deepEqual(sel('*.tsx, *.md', paths), ['b.tsx', 'c.md']);
  // only-negative → everything but the excluded
  assert.deepEqual(sel('!*.md', paths), ['a.ts', 'a.test.ts', 'b.tsx']);
});

test('compileGlobFilter: blank / whitespace-only patterns select nothing', () => {
  assert.ok(compileGlobFilter('').isEmpty);
  assert.ok(compileGlobFilter('  ,  ').isEmpty);
  assert.deepEqual(sel('', ['a.ts']), []);
  // whitespace around terms is trimmed
  assert.deepEqual(sel('  *.ts ,  !*.test.ts ', ['a.ts', 'a.test.ts']), ['a.ts']);
});
