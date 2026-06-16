/*
 * Integration test for the CSS plugin's grammar assets against the real binaries
 * we ship: the bundled CSS wasm + the vendored SCSS wasm load in the pinned
 * web-tree-sitter, the highlight/fold queries compile (catching node-name drift),
 * and a small sample highlights the captures we expect (selectors, properties,
 * `$variables`, SCSS at-rules).
 *
 * Uses web-tree-sitter directly (not the registry) so it's hermetic. Skips the
 * SCSS half if the grammar wasn't vendored (the plugin is LSP-only for SCSS then).
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
const SCSS_WASM = Path.join(HERE, 'grammars', 'tree-sitter-scss.wasm');

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

test('bundled CSS grammar: loads, queries compile, highlights selectors + values', async () => {
  await Parser.init({ locateFile: (n: string) => Path.join(wtsDir, n) });
  const css = await Parser.Language.load(require_.resolve('tree-sitter-wasms/out/tree-sitter-css.wasm'));

  // Highlight + fold queries compile against the grammar.
  assert.ok(css.query(query('css/highlights.scm')).captureNames.length > 0);
  assert.ok(css.query(query('css/folds.scm')).captureNames.includes('fold'));

  const src = '/* c */\n.box, a:hover {\n  color: #fff;\n  width: 10px;\n}\n@media (min-width: 600px) { .box { color: red; } }\n';
  const caps = capturesFor(css, query('css/highlights.scm'), src);
  for (const expected of ['comment', 'attribute', 'tag', 'property', 'constant', 'number', 'keyword']) {
    assert.ok(caps.has(expected), `CSS should produce a @${expected} capture`);
  }
});

test('vendored SCSS grammar: loads, queries compile, highlights $vars + @mixin', {
  skip: !Fs.existsSync(SCSS_WASM) && 'SCSS grammar wasm not vendored',
}, async () => {
  await Parser.init({ locateFile: (n: string) => Path.join(wtsDir, n) });
  const scss = await Parser.Language.load(SCSS_WASM);

  assert.ok(scss.query(query('scss/highlights.scm')).captureNames.length > 0);
  assert.ok(scss.query(query('scss/folds.scm')).captureNames.includes('fold'));

  const src = [
    '$brand: #3498db;',
    '@mixin pad($x) { padding: $x; }',
    '.card {',
    '  color: $brand;',
    '  @include pad(8px);',
    '  &:hover { color: darken($brand, 10%); }',
    '}',
    '',
  ].join('\n');
  const caps = capturesFor(scss, query('scss/highlights.scm'), src);
  for (const expected of ['variable.special', 'keyword', 'function', 'property', 'constant']) {
    assert.ok(caps.has(expected), `SCSS should produce a @${expected} capture`);
  }
});
