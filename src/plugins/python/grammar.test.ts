/*
 * Integration test for the Python plugin's grammar assets against the real binary
 * we ship: the bundled Python wasm loads in the pinned web-tree-sitter, the
 * highlight/fold queries compile (catching node-name drift), and a small sample
 * highlights the captures we expect (functions, types, keywords, strings, …).
 *
 * Uses web-tree-sitter directly (not the registry) so it's hermetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as Path from 'node:path';
import * as Fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const Parser = require_('web-tree-sitter') as any;
const HERE = Path.dirname(fileURLToPath(import.meta.url));
const wtsDir = Path.dirname(require_.resolve('web-tree-sitter'));
const query = (rel: string) => Fs.readFileSync(Path.join(HERE, 'queries', rel), 'utf8');

// Capture names produced for a parsed source, by running a highlights query.
function capturesFor(lang: any, scm: string, src: string): Set<string> {
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(src);
  const names = new Set<string>();
  for (const m of lang.query(scm).matches(tree.rootNode)) {
    for (const c of m.captures) names.add(c.name);
  }
  return names;
}

test('bundled Python grammar: loads, queries compile, highlights core captures', async () => {
  await Parser.init({ locateFile: (n: string) => Path.join(wtsDir, n) });
  const python = await Parser.Language.load(require_.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm'));

  // Highlight + fold queries compile against the grammar.
  assert.ok(python.query(query('python/highlights.scm')).captureNames.length > 0);
  assert.ok(python.query(query('python/folds.scm')).captureNames.includes('fold'));

  const src = [
    '# a comment',
    'import os',
    '',
    'MAX = 42',
    '',
    '@decorator',
    'class Point:',
    '    def __init__(self, x):',
    '        self.x = x',
    '        name = "quilx"',
    '        ok = True',
    '        print(name)',
    '',
  ].join('\n');
  const caps = capturesFor(python, query('python/highlights.scm'), src);
  for (const expected of ['function', 'type', 'keyword', 'string', 'number', 'boolean', 'comment', 'punctuation.bracket']) {
    assert.ok(caps.has(expected), `Python should produce a @${expected} capture`);
  }
});
