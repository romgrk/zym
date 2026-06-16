/*
 * Tests for computeFoldRanges against a real TypeScript parse: block folds (via
 * the vendored folds.scm and via the foldTypes fallback) plus run folds for
 * consecutive import statements and line comments.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as Path from 'node:path';
import * as Fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeFoldRanges } from './folds.ts';

const require_ = createRequire(import.meta.url);
const Parser = require_('web-tree-sitter') as any;
const wtsDir = Path.dirname(require_.resolve('web-tree-sitter'));
const tsWasm = require_.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm');
const HERE = Path.dirname(fileURLToPath(import.meta.url));
const foldsScm = Path.resolve(HERE, '../plugins/typescript/queries/typescript/folds.scm');

const FOLD_TYPES = new Set(['statement_block', 'object', 'array', 'class_body']);
const RUN_RE = /comment|import/;

const SRC = [
  "import a from 'a';", // 0  ┐ import run
  "import b from 'b';", // 1  │
  "import c from 'c';", // 2  ┘
  '',                    // 3
  '// one',              // 4  ┐ line-comment run
  '// two',              // 5  ┘
  'function f() {',      // 6  ┐ block (statement_block 6..9)
  '  const o = {',       // 7  ┐ object 7..8
  '  };',                // 8  ┘
  '}',                   // 9  ┘
].join('\n');

test('folds: block folds (folds.scm) + import run + comment run', async () => {
  await Parser.init({ locateFile: (n: string) => Path.join(wtsDir, n) });
  const lang = await Parser.Language.load(tsWasm);
  const parser = new Parser();
  parser.setLanguage(lang);
  const root = parser.parse(SRC).rootNode;
  const query = lang.query(Fs.readFileSync(foldsScm, 'utf8'));

  const ranges = computeFoldRanges(root, query, FOLD_TYPES, RUN_RE).map((r): [number, number] => [r.startRow, r.endRow]);
  // import run [0..2] → endRow 3; comment run [4..5] → endRow 6; function body 6..9; object 7..8 too short (1 line → dropped).
  assert.deepEqual(ranges, [[0, 3], [4, 6], [6, 9]]);
});

test('folds: foldTypes fallback when no folds query (no comment folding)', async () => {
  await Parser.init({ locateFile: (n: string) => Path.join(wtsDir, n) });
  const lang = await Parser.Language.load(tsWasm);
  const parser = new Parser();
  parser.setLanguage(lang);
  const r = parser.parse(SRC).rootNode;
  // No query → foldTypes drives blocks; runs still fold; the block comment isn't a foldType.
  const ranges = computeFoldRanges(r, null, FOLD_TYPES, RUN_RE).map((x): [number, number] => [x.startRow, x.endRow]);
  assert.deepEqual(ranges, [[0, 3], [4, 6], [6, 9]]);
});
