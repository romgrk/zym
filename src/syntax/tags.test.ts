import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as Path from 'node:path';
import { tagNamesAt } from './tags.ts';

const require_ = createRequire(import.meta.url);
const Parser = require_('web-tree-sitter') as any;
const wtsDir = Path.dirname(require_.resolve('web-tree-sitter'));
const tsxWasm = require_.resolve('tree-sitter-wasms/out/tree-sitter-tsx.wasm');

test('tagNamesAt returns both tag-name ranges of a paired element', async () => {
  await Parser.init({ locateFile: (n: string) => Path.join(wtsDir, n) });
  const lang = await Parser.Language.load(tsxWasm);
  const parser = new Parser();
  parser.setLanguage(lang);
  //               <div className="a">child</div>;
  // columns:      0         1         2         3
  const root = parser.parse('const x = <div className="a">child</div>;').rootNode;

  // cursor on the opening `div` (col 11) → both `div` names.
  const names = tagNamesAt(root, 0, 11);
  assert.ok(names);
  assert.equal(names!.length, 2);
  assert.deepEqual(names!.map((n) => n.text), ['div', 'div']);
  // opening name [11,14), closing name after `</`.
  assert.deepEqual([names![0].startColumn, names![0].endColumn], [11, 14]);
  assert.ok(names![1].startColumn > names![0].endColumn, 'closing name is later');

  // cursor in the child text also resolves to the enclosing element.
  assert.deepEqual(tagNamesAt(root, 0, 30)!.map((n) => n.text), ['div', 'div']);
});

test('self-closing tag yields a single name; non-tags yield null', async () => {
  await Parser.init({ locateFile: (n: string) => Path.join(wtsDir, n) });
  const lang = await Parser.Language.load(tsxWasm);
  const parser = new Parser();
  parser.setLanguage(lang);

  const root = parser.parse('const y = <br/>;\nconst z = 1 + 2;').rootNode;
  const br = tagNamesAt(root, 0, 11); // on `br`
  assert.deepEqual(br!.map((n) => n.text), ['br']);
  assert.equal(tagNamesAt(root, 1, 12), null, 'plain expression → no tag');
});
