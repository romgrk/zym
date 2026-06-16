/*
 * Integration test for the HTML plugin's grammar pipeline against the real
 * binaries we ship: the bundled HTML + CSS wasms load in the pinned
 * web-tree-sitter, the highlight/fold queries compile (catching node-name drift),
 * and the plugin's injection queries resolve a <style> block to CSS captures and
 * a <script> block to JS (the TypeScript plugin's tsx grammar) — the whole
 * cross-plugin injection path, end to end.
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
const wasm = (spec: string) => require_.resolve(spec);
const query = (rel: string) => Fs.readFileSync(Path.join(HERE, 'queries', rel), 'utf8');

const HTML = 'tree-sitter-wasms/out/tree-sitter-html.wasm';
const CSS = 'tree-sitter-wasms/out/tree-sitter-css.wasm';
const TSX = 'tree-sitter-wasms/out/tree-sitter-tsx.wasm';

function rangeOf(node: any) {
  return [{
    startIndex: node.startIndex, endIndex: node.endIndex,
    startPosition: node.startPosition, endPosition: node.endPosition,
  }];
}

test('bundled HTML grammar: loads, queries compile, <style>/<script> inject', async () => {
  await Parser.init({ locateFile: (n: string) => Path.join(wtsDir, n) });
  const html = await Parser.Language.load(wasm(HTML));
  const css = await Parser.Language.load(wasm(CSS));
  const tsx = await Parser.Language.load(wasm(TSX));

  // Highlight + fold queries compile against their grammars.
  assert.ok(html.query(query('html/highlights.scm')).captureNames.length > 0);
  assert.ok(html.query(query('html/folds.scm')).captureNames.includes('fold'));
  assert.ok(css.query(query('css/highlights.scm')).captureNames.length > 0);

  const styleInj = html.query('(style_element (raw_text) @content)');
  const scriptInj = html.query('(script_element (raw_text) @content)');

  const parser = new Parser();
  parser.setLanguage(html);
  const src = [
    '<!DOCTYPE html>',
    '<html>',
    '<head><style>.a { color: #fff; width: 10px; }</style></head>',
    '<body>',
    '<script>const x = 1;</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
  const tree = parser.parse(src);

  // <style> → CSS: the injected CSS grammar highlights inside the raw_text.
  const styleContent = styleInj.matches(tree.rootNode)[0].captures
    .find((c: any) => c.name === 'content').node;
  const cp = new Parser();
  cp.setLanguage(css);
  const cssCaps = css.query(query('css/highlights.scm'))
    .captures(cp.parse(src, undefined, { includedRanges: rangeOf(styleContent) }).rootNode);
  assert.ok(cssCaps.length >= 3, 'CSS should highlight inside <style>');
  assert.ok(cssCaps.some((c: any) => c.name === 'property'), 'a CSS property is captured');
  assert.ok(cssCaps.every((c: any) => c.node.startIndex >= styleContent.startIndex),
    'captures land inside the <style> block');

  // <script> → JS: the TypeScript plugin's tsx grammar highlights the raw_text.
  const scriptContent = scriptInj.matches(tree.rootNode)[0].captures
    .find((c: any) => c.name === 'content').node;
  const tp = new Parser();
  tp.setLanguage(tsx);
  const tsxHl = tsx.query(Fs.readFileSync(
    Path.resolve(HERE, '../typescript/queries/tsx/highlights.scm'), 'utf8'));
  const jsCaps = tsxHl.captures(
    tp.parse(src, undefined, { includedRanges: rangeOf(scriptContent) }).rootNode);
  assert.ok(jsCaps.length >= 2, 'JS should highlight inside <script>');
  assert.ok(jsCaps.some((c: any) => c.node.startIndex >= scriptContent.startIndex),
    'captures land inside the <script> block');
});
