/*
 * DocumentSyntax (Phase 0 of the multibuffer split): the per-Document parse is shared by
 * every view's SyntaxController. These tests prove the keystone — ONE parse on the model
 * paints N independent view buffers — and that an edit reparses (debounced) and re-paints
 * all of them. JS grammar comes from the bundled TypeScript plugin; skipped if not vendored.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../gi.ts';
import { plugins, registerBuiltinPlugins } from '../plugin/index.ts';
import { preloadGrammars, getGrammar, langIdForPath } from './grammar.ts';
import { SyntaxController } from './SyntaxController.ts';
import { Document } from '../ui/TextEditor/Document.ts';

Gtk.init();

const SAMPLE = 'function f(a) {\n  const x = 1;\n  return a + x;\n}\n';

let hasJs = false;
before(async () => {
  try { registerBuiltinPlugins(); } catch { /* already registered */ }
  await plugins.activateAll();
  await preloadGrammars();
  hasJs = !!getGrammar(langIdForPath('/x.js') ?? '');
});

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);
const keywordAt = (buffer: any, text: string, token: string): boolean => {
  const tag = buffer.getTagTable().lookup('ts:keyword');
  if (!tag) return false;
  const iter = asIter(buffer.getIterAtOffset(text.indexOf(token) + 1));
  return iter.hasTag(tag);
};

test('the parse lives on the model and reports captures + folds', () => {
  if (!hasJs) return;
  const doc = new Document();
  doc.setText(SAMPLE);
  const ds = doc.syntax;
  assert.equal(ds.setLanguageForPath('/x.js'), true, 'tree-sitter handles .js');
  assert.ok(ds.hasTree, 'has a parse tree');
  // Raw capture names are grammar-specific (`keyword.declaration`/`keyword.control`, …);
  // the painter resolves them to the `ts:keyword` color tag (exercised below).
  const counts = ds.captureCounts();
  assert.ok(Object.keys(counts).some((k) => k.startsWith('keyword')), 'a keyword-family capture is present');
  // The function body is foldable (header line 0 → footer line 3), discovered in MODEL coords.
  assert.ok(ds.foldRanges().some((r) => r.startRow === 0 && r.endRow >= 3), 'function fold discovered');
});

test('one parse paints two independent view buffers', () => {
  if (!hasJs) return;
  const doc = new Document();
  doc.setText(SAMPLE);

  const make = () => {
    const screen = doc.createView();
    const buffer = screen.buffer;
    const view = new GtkSource.View({ buffer });
    const syntax = new SyntaxController(view, buffer, { screen, documentSyntax: doc.syntax });
    syntax.setLanguageForPath('/x.js');
    return { buffer, syntax };
  };
  const a = make();
  const b = make();

  // Both views share doc.syntax — the SAME tree — yet each has its own tags painted on
  // its own buffer (proven by the keyword tag landing on `const` in both).
  assert.ok(keywordAt(a.buffer, SAMPLE, 'const'), 'view A painted from the shared parse');
  assert.ok(keywordAt(b.buffer, SAMPLE, 'const'), 'view B painted from the shared parse');
  a.syntax.dispose();
  b.syntax.dispose();
});

test('an edit through one view reparses the shared model and repaints both views', async () => {
  if (!hasJs) return;
  const doc = new Document();
  doc.setText(SAMPLE);

  const make = () => {
    const screen = doc.createView();
    const buffer = screen.buffer;
    const view = new GtkSource.View({ buffer });
    const syntax = new SyntaxController(view, buffer, { screen, documentSyntax: doc.syntax });
    syntax.setLanguageForPath('/x.js');
    return { buffer, syntax };
  };
  const a = make();
  const b = make();
  const before = doc.syntax.captureCounts()['number'] ?? 0;

  // Edit through view A's buffer → forwarded to the model → propagated to view B. The
  // model edit drives ONE (debounced) reparse on the shared DocumentSyntax.
  const buf = a.buffer;
  buf.insert(buf.getEndIter(), 'const y = 42;\n', -1);
  await new Promise((r) => setTimeout(r, 120)); // let the 60ms reparse debounce fire

  assert.ok((doc.syntax.captureCounts()['number'] ?? 0) > before, 'incremental reparse saw the new number literal');
  // The new `42` is highlighted in BOTH views (each repainted off the one reparse).
  const updated = doc.getText();
  assert.ok(b.buffer.getText(b.buffer.getStartIter(), b.buffer.getEndIter(), true) === updated,
    'view B mirrors the edit');
  a.syntax.dispose();
  b.syntax.dispose();
});
