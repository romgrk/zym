/*
 * Integration test for the Bash plugin's grammar assets against the real binary we
 * ship: the bundled Bash wasm loads in the pinned web-tree-sitter, the highlight/fold
 * queries compile (catching node-name drift), and a small sample highlights the
 * captures we expect (commands, keywords, strings, numbers, special parameters, …).
 *
 * Loads the runtime through the production `initTreeSitter`, so the libc shim it
 * installs (`isalpha`, which the Bash external scanner imports and the runtime omits)
 * is exercised here — without it, `parser.parse` faults mid-scan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as Path from 'node:path';
import * as Fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initTreeSitter } from '../../src/syntax/grammar.ts';

const require_ = createRequire(import.meta.url);
const Parser = require_('web-tree-sitter') as any;
const HERE = Path.dirname(fileURLToPath(import.meta.url));
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

test('bundled Bash grammar: loads, queries compile, highlights core captures', async () => {
  await initTreeSitter();
  const bash = await Parser.Language.load(require_.resolve('tree-sitter-wasms/out/tree-sitter-bash.wasm'));

  // Highlight + fold queries compile against the grammar.
  assert.ok(bash.query(query('bash/highlights.scm')).captureNames.length > 0);
  assert.ok(bash.query(query('bash/folds.scm')).captureNames.includes('fold'));

  const src = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'readonly MAX=42',
    '',
    'greet() {',
    '  local who="$1"',
    '  echo "hello, ${who}!"',
    '}',
    '',
    'if [[ -d "$HOME" ]]; then',
    '  greet world && echo "$?"',
    'fi',
    '',
  ].join('\n');
  const caps = capturesFor(bash, query('bash/highlights.scm'), src);
  for (const expected of ['function', 'keyword', 'string', 'number', 'comment', 'variable.special', 'operator', 'punctuation.bracket']) {
    assert.ok(caps.has(expected), `Bash should produce a @${expected} capture`);
  }

  // Block constructs fold: a `for … do … done` loop (do_group) and an `if … fi`
  // both yield a @fold.
  const loop = 'for f in a b c; do\n  echo "$f"\ndone';
  assert.ok(capturesFor(bash, query('bash/folds.scm'), loop).has('fold'), 'a do-group should fold');
  const cond = 'if true; then\n  echo hi\nfi';
  assert.ok(capturesFor(bash, query('bash/folds.scm'), cond).has('fold'), 'an if-statement should fold');
});
