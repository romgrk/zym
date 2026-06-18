/*
 * Integration test for the C / C++ plugin's grammar assets against the real
 * binaries we ship: the bundled C and C++ wasms load in the pinned
 * web-tree-sitter, the highlight/fold queries compile (catching node-name drift),
 * and small samples highlight the captures we expect.
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

test('bundled C grammar: loads, queries compile, highlights the core captures', async () => {
  await Parser.init({ locateFile: (n: string) => Path.join(wtsDir, n) });
  const c = await Parser.Language.load(require_.resolve('tree-sitter-wasms/out/tree-sitter-c.wasm'));

  assert.ok(c.query(query('c/highlights.scm')).captureNames.length > 0);
  assert.ok(c.query(query('c/folds.scm')).captureNames.includes('fold'));

  const src = [
    '#include <stdio.h>',
    '#define MAX 10',
    '// line comment',
    'enum Color { RED, GREEN };',
    'int add(int a, int b) {',
    '  const char *s = "hi\\n";',
    '  int n = 42;',
    '  return a + b + n; // sum',
    '}',
    '',
  ].join('\n');
  const caps = capturesFor(c, query('c/highlights.scm'), src);
  for (const expected of [
    'keyword.import', 'function', 'type', 'type.builtin', 'string',
    'string.escape', 'number', 'comment', 'constant', 'operator', 'punctuation.bracket',
  ]) {
    assert.ok(caps.has(expected), `C should produce a @${expected} capture`);
  }

  // keep-footer: an `if` with an `else` keeps its `} else …` line on its own line.
  const ifElse = 'int f(){\n  if (a) {\n    x();\n  } else {\n    y();\n  }\n}';
  assert.ok(capturesFor(c, query('c/folds.scm'), ifElse).has('fold.keepFooter'),
    'C if/else should produce a @fold.keepFooter capture');
  const plainIf = 'int f(){\n  if (a) {\n    x();\n  }\n}';
  assert.ok(!capturesFor(c, query('c/folds.scm'), plainIf).has('fold.keepFooter'),
    'a plain C if (no else) should not keep-footer');
});

test('bundled C++ grammar: loads, queries compile, highlights the core captures', async () => {
  await Parser.init({ locateFile: (n: string) => Path.join(wtsDir, n) });
  const cpp = await Parser.Language.load(require_.resolve('tree-sitter-wasms/out/tree-sitter-cpp.wasm'));

  assert.ok(cpp.query(query('cpp/highlights.scm')).captureNames.length > 0);
  assert.ok(cpp.query(query('cpp/folds.scm')).captureNames.includes('fold'));

  const src = [
    '#include <string>',
    '// a comment',
    'namespace ns {',
    'template<typename T> class Foo {',
    ' public:',
    '  T value;',
    '  T get() const { return this->value; }',
    '};',
    '}',
    'int main() {',
    '  auto *f = new ns::Foo<int>();',
    '  std::string s = "x";',
    '  return f == nullptr ? 1 : 0;',
    '}',
    '',
  ].join('\n');
  const caps = capturesFor(cpp, query('cpp/highlights.scm'), src);
  for (const expected of [
    'keyword.import', 'keyword.declaration', 'keyword.operator', 'function',
    'type', 'type.class', 'type.builtin', 'property', 'variable.special',
    'string', 'comment', 'constant.builtin', 'operator', 'punctuation.bracket',
  ]) {
    assert.ok(caps.has(expected), `C++ should produce a @${expected} capture`);
  }

  // keep-footer: `} else …` and `} catch (…) {` lines stay on their own line.
  const ifElse = 'int f(){\n  if (a) {\n    x();\n  } else {\n    y();\n  }\n}';
  assert.ok(capturesFor(cpp, query('cpp/folds.scm'), ifElse).has('fold.keepFooter'),
    'C++ if/else should produce a @fold.keepFooter capture');
  const tryCatch = 'int f(){\n  try {\n    a();\n  } catch (int e) {\n    b();\n  }\n}';
  assert.ok(capturesFor(cpp, query('cpp/folds.scm'), tryCatch).has('fold.keepFooter'),
    'C++ try/catch should produce a @fold.keepFooter capture');
  const plainIf = 'int f(){\n  if (a) {\n    x();\n  }\n}';
  assert.ok(!capturesFor(cpp, query('cpp/folds.scm'), plainIf).has('fold.keepFooter'),
    'a plain C++ if (no else) should not keep-footer');
});
