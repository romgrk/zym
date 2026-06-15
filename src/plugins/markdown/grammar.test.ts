/*
 * Integration test for the vendored Markdown grammar assets: the two wasms load
 * in the pinned web-tree-sitter, the highlights queries compile, and the plugin's
 * injection queries (MD_INJECTIONS) compile against the real grammar and resolve
 * a fenced ```ts block to TypeScript captures — i.e. the whole highlighting +
 * injection pipeline, end to end, against the actual binaries we ship.
 *
 * Uses web-tree-sitter directly (not the registry) so it's hermetic. Skips itself
 * if the grammar wasm hasn't been vendored (the plugin is LSP-only until then).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as Path from 'node:path';
import * as Fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MD_INJECTIONS } from './index.ts';

const require_ = createRequire(import.meta.url);
const Parser = require_('web-tree-sitter') as any;
const HERE = Path.dirname(fileURLToPath(import.meta.url));
const wtsDir = Path.dirname(require_.resolve('web-tree-sitter'));
const wasm = (name: string) => Path.join(HERE, 'grammars', name);
const query = (rel: string) => Fs.readFileSync(Path.join(HERE, 'queries', rel), 'utf8');

test('vendored Markdown grammar: loads, queries compile, fenced code injects', { skip: !Fs.existsSync(wasm('tree-sitter-markdown.wasm')) && 'grammar wasm not vendored' }, async () => {
  await Parser.init({ locateFile: (n: string) => Path.join(wtsDir, n) });
  const block = await Parser.Language.load(wasm('tree-sitter-markdown.wasm'));
  const inline = await Parser.Language.load(wasm('tree-sitter-markdown-inline.wasm'));
  const ts = await Parser.Language.load(require_.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm'));

  // Highlights queries compile against their grammars (catches node-name drift).
  assert.ok(block.query(query('markdown/highlights.scm')).captureNames.length > 0);
  assert.ok(inline.query(query('markdown-inline/highlights.scm')).captureNames.length > 0);

  // The plugin's injection queries compile against the block grammar.
  const injections = MD_INJECTIONS.map((i) => ({ q: block.query(i.query), language: i.language }));

  const parser = new Parser();
  parser.setLanguage(block);
  const md = '# Title\n\nA **bold** word and `code`.\n\n```ts\nconst x: number = 1\n```\n';
  const tree = parser.parse(md);

  // Inline self-injection: at least the one paragraph's inline span.
  const inlineInj = injections.find((c) => c.language === 'markdown-inline')!;
  assert.ok(inlineInj.q.matches(tree.rootNode).length >= 1, 'inline injection should match');

  // Fenced injection: resolves the info string to `ts` and captures the content.
  const fenced = injections.find((c) => !c.language)!;
  const matches = fenced.q.matches(tree.rootNode);
  assert.equal(matches.length, 1);
  const lang = matches[0].captures.find((c: any) => c.name === 'language')!.node.text;
  assert.equal(lang, 'ts');
  const content = matches[0].captures.find((c: any) => c.name === 'content')!.node;

  // The resolved guest grammar (TypeScript) highlights the fenced content, with
  // positions absolute (via includedRanges) — the cross-plugin injection payoff.
  const tp = new Parser();
  tp.setLanguage(ts);
  const sub = tp.parse(md, undefined, {
    includedRanges: [{
      startIndex: content.startIndex, endIndex: content.endIndex,
      startPosition: content.startPosition, endPosition: content.endPosition,
    }],
  });
  const tsHl = ts.query(Fs.readFileSync(
    Path.resolve(HERE, '../typescript/queries/typescript/highlights.scm'), 'utf8'));
  const caps = tsHl.captures(sub.rootNode);
  assert.ok(caps.length >= 3, 'TypeScript should highlight inside the fenced block');
  assert.ok(caps.some((c: any) => c.node.startIndex >= content.startIndex), 'captures land in the fence');
});
