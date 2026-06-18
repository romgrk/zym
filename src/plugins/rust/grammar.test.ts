/*
 * Integration test for the Rust plugin's grammar assets against the real binary
 * we ship: the bundled Rust wasm loads in the pinned web-tree-sitter, the
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

test('bundled Rust grammar: loads, queries compile, highlights core captures', async () => {
  await Parser.init({ locateFile: (n: string) => Path.join(wtsDir, n) });
  const rust = await Parser.Language.load(require_.resolve('tree-sitter-wasms/out/tree-sitter-rust.wasm'));

  // Highlight + fold queries compile against the grammar.
  assert.ok(rust.query(query('rust/highlights.scm')).captureNames.length > 0);
  assert.ok(rust.query(query('rust/folds.scm')).captureNames.includes('fold'));

  const src = [
    '// a comment',
    'use std::collections::HashMap;',
    '',
    'const MAX: u32 = 42;',
    '',
    'struct Point { x: f64, y: f64 }',
    '',
    'fn main() {',
    '    let name = "quilx";',
    '    let ok = true;',
    '    println!("{}", name);',
    '}',
    '',
  ].join('\n');
  const caps = capturesFor(rust, query('rust/highlights.scm'), src);
  for (const expected of ['function', 'type', 'keyword', 'string', 'number', 'boolean', 'comment', 'punctuation.bracket']) {
    assert.ok(caps.has(expected), `Rust should produce a @${expected} capture`);
  }

  // keep-footer: an `if` with an `else` branch keeps its `} else …` line on its
  // own line (the consequence is captured @fold.keepFooter); a plain `if` is just
  // @fold. See folding.md.
  const ifElse = 'fn f() {\n    if a {\n        x();\n    } else {\n        y();\n    }\n}';
  const foldCaps = capturesFor(rust, query('rust/folds.scm'), ifElse);
  assert.ok(foldCaps.has('fold.keepFooter'), 'if/else should produce a @fold.keepFooter capture');

  const plainIf = 'fn f() {\n    if a {\n        x();\n    }\n}';
  const plainCaps = capturesFor(rust, query('rust/folds.scm'), plainIf);
  assert.ok(!plainCaps.has('fold.keepFooter'), 'a plain if (no else) should not keep-footer');
});
