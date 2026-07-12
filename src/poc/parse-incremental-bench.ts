#!/usr/bin/env node
/*
 * BENCH: is web-tree-sitter's incremental reparse actually incremental for us?
 *
 * Loads the repo's own grammar for a file, does a full parse, then repeatedly
 * applies a single-character tree.edit + reparse (the exact shape
 * DocumentSyntax.reparse runs per keystroke) and times it. No GTK.
 *
 *   node src/poc/parse-incremental-bench.ts <file>
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { plugins, registerBuiltinPlugins, disabledPluginIds } from '../plugin/index.ts';
import { preloadGrammars, getGrammar, createParser, langIdForPath } from '../syntax/grammar.ts';

const file = Path.resolve(process.argv[2] ?? '/tmp/zym-bench-repo/mid.ts');
let text = Fs.readFileSync(file, 'utf8');

registerBuiltinPlugins();
await plugins.activateAll(disabledPluginIds());
await preloadGrammars();

const langId = langIdForPath(file);
const grammar = getGrammar(langId!);
if (!grammar) { console.error('no grammar for', file); process.exit(1); }
const parser = createParser(grammar);

const t0 = performance.now();
let tree = parser.parse(text);
console.log(`full parse: ${(performance.now() - t0).toFixed(1)} ms (${text.length} chars, lang ${langId})`);

// Type 30 chars mid-file, one edit + reparse each, like DocumentSyntax does.
const at = Math.floor(text.length / 2);
const lineStart = text.lastIndexOf('\n', at) + 1;
const row = (text.slice(0, at).match(/\n/g) ?? []).length;
const col = at - lineStart;

const times: number[] = [];
for (let i = 0; i < 30; i++) {
  const idx = at + i;
  text = text.slice(0, idx) + 'x' + text.slice(idx);
  tree.edit({
    startIndex: idx,
    oldEndIndex: idx,
    newEndIndex: idx + 1,
    startPosition: { row, column: col + i },
    oldEndPosition: { row, column: col + i },
    newEndPosition: { row, column: col + i + 1 },
  });
  const t1 = performance.now();
  const next = parser.parse(text, tree);
  times.push(performance.now() - t1);
  tree.delete();
  tree = next;
}
times.sort((a, b) => a - b);
console.log(`incremental reparse: p50 ${times[15].toFixed(1)} ms, max ${times[29].toFixed(1)} ms`);
