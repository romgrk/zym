import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
import { SyntaxController } from './SyntaxController.ts';
import { Document } from '../ui/TextEditor/Document.ts';
import { plugins, registerBuiltinPlugins } from '../plugin/index.ts';
import { preloadGrammars, getGrammar, langIdForPath } from './grammar.ts';

Gtk.init();

let hasTs = false;
before(async () => {
  try { registerBuiltinPlugins(); } catch { /* already registered */ }
  await plugins.activateAll();
  await preloadGrammars();
  hasTs = !!getGrammar(langIdForPath('/x.ts') ?? '');
});

// SyntaxController is normally built inside the app's activate handler; it builds
// safely headless too. Folding physically collapses a body to `[...]` in the VIEW
// buffer while the Document (model) keeps the full text. These tests register a
// foldable region by hand (the parse-driven discovery needs a grammar) and drive
// the public fold toggle; bracket-match tests reuse the same buffer.
function setup(text: string) {
  const doc = new Document();
  doc.setText(text);
  const screen = doc.createView();
  const buffer = screen.buffer;
  const view = new GtkSource.View({ buffer });
  const syntax = new SyntaxController(view, buffer, { screen });
  const textOf = () => buffer.getText(buffer.getStartIter(), buffer.getEndIter(), true);
  const registerFoldable = (startLine: number, endLine: number) =>
    syntax.foldsByHeaderLine.set(startLine, { startLine, endLine, folded: false });
  return { doc, buffer, view, syntax, textOf, registerFoldable };
}

test('folding collapses the body to a placeholder in the view, not the model', () => {
  const { doc, syntax, textOf, registerFoldable } = setup('function f() {\n  a;\n  b;\n}\nafter\n');
  registerFoldable(0, 3);
  syntax.toggleHeaderLine(0);
  assert.equal(textOf(), 'function f() {[4]}\nafter\n', 'view is one navigable line');
  assert.equal(doc.getText(), 'function f() {\n  a;\n  b;\n}\nafter\n', 'model keeps the body');
});

test('folding an indented function joins `}` flush (hides leading indent)', () => {
  const { syntax, textOf } = setup('class C {\n  method() {\n    a;\n    b;\n  }\n}\n');
  // The method body: header line 1 (`  method() {`), footer line 4 (`  }`). The
  // indentation before `}` must be hidden so the footer joins flush, like top level.
  syntax.foldsByHeaderLine.set(1, { startLine: 1, endLine: 4, folded: false });
  syntax.toggleHeaderLine(1);
  assert.equal(textOf(), 'class C {\n  method() {[4]}\n}\n');
});

test('folding a comment/import run keeps the following line on its own line', () => {
  const { syntax, textOf } = setup('// one\n// two\n// three\nconst x = 1;\n');
  // A run's endLine is the line AFTER the run (the next statement) — joinFooter:false
  // so it is not pulled onto the folded run. (walkRuns sets this in computeFoldRanges.)
  syntax.foldsByHeaderLine.set(0, { startLine: 0, endLine: 3, folded: false, joinFooter: false });
  syntax.toggleHeaderLine(0);
  assert.equal(textOf(), '// one[2]\nconst x = 1;\n');
});

test('unfolding restores the body in the view', () => {
  const { doc, syntax, textOf, registerFoldable } = setup('function f() {\n  a;\n}\nafter\n');
  registerFoldable(0, 2);
  syntax.toggleHeaderLine(0); // fold — placeholder stays on line 0
  syntax.toggleHeaderLine(0); // unfold
  assert.equal(textOf(), doc.getText());
});

test('a collapsed fold maps the gutter line back to the model line', () => {
  const { syntax, registerFoldable } = setup('function f() {\n  a;\n  b;\n}\nafter\n');
  registerFoldable(0, 3);
  syntax.toggleHeaderLine(0);
  // view line 0 = the folded one-liner (model 0); view line 1 = `after` (model 4).
  assert.equal(syntax.modelLineFor(0), 0);
  assert.equal(syntax.modelLineFor(1), 4);
});

// Bracket matching is cursor-driven (notify::cursor-position) and text-based, so
// it works headless without a grammar.
test('bracket match: highlights the bracket under the cursor and its pair', () => {
  const { buffer } = setup('foo(bar)\n');
  const at = (off: number) => {
    const r = buffer.getIterAtOffset(off);
    return Array.isArray(r) ? r[r.length - 1] : r;
  };
  const tag = buffer.getTagTable().lookup('bracket-match')!;
  assert.ok(tag, 'bracket-match tag exists');

  buffer.placeCursor(at(3)); // on the '('
  assert.ok(at(3).hasTag(tag), 'the ( under the cursor is highlighted');
  assert.ok(at(7).hasTag(tag), 'its matching ) is highlighted');
  assert.ok(!at(5).hasTag(tag), 'a char between the brackets is not');

  buffer.placeCursor(at(5)); // inside `bar`, not adjacent to a bracket
  assert.ok(at(3).hasTag(tag), 'the enclosing ( stays highlighted from inside');
  assert.ok(at(7).hasTag(tag), 'and the enclosing )');
  assert.ok(!at(5).hasTag(tag), 'the cursor char itself is not highlighted');

  buffer.placeCursor(at(1)); // before any bracket, not enclosed → cleared
  assert.ok(!at(3).hasTag(tag), 'outside any pair clears the highlight');
  assert.ok(!at(7).hasTag(tag), 'and its former match');
});

test('a viewport sub-range paint does not bleed a wide capture past the painted range', () => {
  if (!hasTs) return;
  // `call(() => { …big body… })`: the body is captured whole by `(arrow_function) @function`.
  // Painting only the head (as the viewport painter does on open) must not let that broad
  // color spill onto body tokens far below the painted range — the additive scroll paint can't
  // remove a stray tag, so it would survive (all-yellow body) until an edit's full repaint.
  const body = Array.from({ length: 120 }, (_, i) => `  const v${i} = ${i};`).join('\n');
  const { buffer, syntax } = setup(`const fn = call(() => {\n${body}\n})\n`);
  syntax.setLanguageForPath('/x.ts'); // headless: a correct whole-buffer paint (view unrealized)

  const fnTag = buffer.getTagTable().lookup('ts:function')!;
  const kwTag = buffer.getTagTable().lookup('ts:keyword')!;
  assert.ok(fnTag && kwTag, 'function + keyword color tags exist');
  const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);
  const iterAt = (line: number, col: number): any => asIter(buffer.getIterAtLineOffset(line, col));

  // Repaint ONLY the head — the private painter the viewport/scroll path drives (there is no
  // public headless trigger: a viewport repaint needs a realized, sized view).
  (syntax as unknown as { paintViewLines(a: number, b: number): void }).paintViewLines(0, 10);

  const deep = iterAt(60, 2); // the `const` of a body line well below the painted range
  assert.ok(deep.hasTag(kwTag), 'the deep keyword keeps its own color');
  assert.ok(!deep.hasTag(fnTag), 'the broad @function capture does not bleed past the range');
});

test('a keep-footer fold (if/else branch) leaves the footer line on its own line', () => {
  const { syntax, textOf } = setup('if (x) {\n  a;\n  b;\n} else {\n  c;\n}\n');
  // The consequence block of an if-with-else: keep its footer (`} else {`) on its line.
  syntax.foldsByHeaderLine.set(0, { startLine: 0, endLine: 3, folded: false, joinFooter: false });
  syntax.toggleHeaderLine(0);
  assert.equal(textOf(), 'if (x) {[2]\n} else {\n  c;\n}\n');
});
