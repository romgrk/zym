/*
 * Regression tests for foldAll / unfoldAll (SyntaxController) over the Screen fold
 * substrate. Guards two bugs found in GUI testing:
 *   1. nested `zm` drove folds from stale view-line snapshots → the outer fold ate past its
 *      footer into the next statement (and was O(folds²) slow);
 *   2. `zr` (unfoldAll) didn't repaint, so a restored body — spliced between the `{` and `}`
 *      (both punctuation-tagged) — inherited the punctuation tag and showed in delimiter color.
 * Needs GTK + a bundled grammar; gated if the grammar isn't vendored.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
import { plugins, registerBuiltinPlugins } from '../plugin/index.ts';
import { preloadGrammars, getGrammar, langIdForPath } from './grammar.ts';
import { Document } from '../ui/TextEditor/Document.ts';
import { SyntaxController } from './SyntaxController.ts';

Gtk.init();

let hasJs = false;
before(async () => {
  try { registerBuiltinPlugins(); } catch { /* already registered */ }
  await plugins.activateAll();
  await preloadGrammars();
  hasJs = !!getGrammar(langIdForPath('/x.ts') ?? '');
});

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);

function setup(src: string) {
  const doc = new Document();
  doc.setText(src);
  const screen = doc.createView();
  const buffer: any = screen.buffer;
  const view = new GtkSource.View({ buffer });
  const syntax = new SyntaxController(view, buffer, { folding: true, screen, documentSyntax: doc.syntax });
  syntax.setLanguageForPath('/x.ts');
  const text = () => buffer.getText(buffer.getStartIter(), buffer.getEndIter(), true) as string;
  const tagsAt = (row: number, col: number): string[] =>
    (asIter(buffer.getIterAtLineOffset(row, col)).getTags() || []).map((t: any) => t.getProperty?.('name') ?? t.name ?? '?');
  return { doc, buffer, syntax, text, tagsAt };
}

const NESTED = `export interface Host {
  a(): void;
  b(): void;
}

export class Doc {
  m1() {
    return 1;
  }
  m2() {
    return 2;
  }
}
`;

test('foldAll collapses nested folds without eating past the footer', () => {
  if (!hasJs) return;
  const { syntax, text, doc } = setup(NESTED);
  syntax.foldAll();
  // Each top-level fold stays closed at its own `}` — no joining into the next statement.
  assert.match(
    text(),
    /^export interface Host \{\[\d+\]\}\n\nexport class Doc \{\[\d+\]\}\n?$/,
    `unexpected folded view:\n${text()}`,
  );
  assert.equal(doc.getText(), NESTED, 'model never mutated by folding');
});

test('documentFoldRangeAtRow reports a closed fold span in DOCUMENT rows (vim j/k skip a fold)', () => {
  if (!hasJs) return;
  const { syntax } = setup(NESTED);
  syntax.foldAll();
  // The interface is document rows 0–3, the class 5–12 (the blank line 4 sits between, unfolded).
  // The vim layer speaks `buffer` (== document), so the whole span reads as one folded line —
  // j/k must skip it instead of stepping through the now-hidden body rows.
  assert.deepEqual(syntax.documentFoldRangeAtRow(0), { startRow: 0, endRow: 3 }); // the header itself
  assert.deepEqual(syntax.documentFoldRangeAtRow(2), { startRow: 0, endRow: 3 }); // a hidden body row
  assert.equal(syntax.documentFoldRangeAtRow(4), null);                          // the blank line
  assert.deepEqual(syntax.documentFoldRangeAtRow(8), { startRow: 5, endRow: 12 });
});

test('unfoldAll restores the text exactly and re-highlights (no delimiter-colored body)', () => {
  if (!hasJs) return;
  const { syntax, text, tagsAt, doc } = setup(NESTED);
  syntax.foldAll();
  syntax.unfoldAll();
  assert.equal(text(), NESTED, 'unfoldAll restores the exact text');
  assert.equal(doc.getText(), NESTED);
  // The leading whitespace of a body line must NOT carry the `{`/`}` punctuation tag the
  // splice would otherwise leave behind; the keyword on that line keeps its own tag.
  assert.deepEqual(tagsAt(1, 1), [], 'body whitespace has no inherited punctuation tag');
  assert.deepEqual(tagsAt(1, 2), ['ts:property'], '`a` member is re-highlighted normally (not the delimiter color)');
});

test('foldAll then unfoldAll round-trips on a single function', () => {
  if (!hasJs) return;
  const { syntax, text } = setup('function foo() {\n  const x = 1;\n  return x;\n}\n');
  syntax.foldAll();
  assert.match(text(), /^function foo\(\) \{\[\d+\]\}\n?$/);
  syntax.unfoldAll();
  assert.equal(text(), 'function foo() {\n  const x = 1;\n  return x;\n}\n');
});

const CLASS = 'export class Doc {\n  m1() {\n    return 1;\n  }\n  m2() {\n    return 2;\n  }\n}\n';

test('zm then opening an outer fold keeps its inner folds closed (nested close-all)', () => {
  if (!hasJs) return;
  const { syntax, text, buffer } = setup(CLASS);
  syntax.foldAll();
  assert.match(text(), /^export class Doc \{\[\d+\]\}\n?$/, 'foldAll collapses the whole class');
  // Open the class (caret on its placeholder line): it must reveal with m1/m2 STILL collapsed
  // (zm closed every level), not a fully-expanded body.
  buffer.placeCursor(asIter(buffer.getIterAtLine(0)));
  syntax.setFoldAtCursor(false);
  assert.match(
    text(),
    /^export class Doc \{\n {2}m1\(\) \{\[\d+\]\}\n {2}m2\(\) \{\[\d+\]\}\n\}\n?$/,
    `inner method folds should stay closed after opening the class:\n${text()}`,
  );
});

test('zc on an already-closed fold closes its parent (close outward by level)', () => {
  if (!hasJs) return;
  const { syntax, text, buffer } = setup(CLASS);
  // Close the inner method m1 (caret on its body).
  buffer.placeCursor(asIter(buffer.getIterAtLine(2)));
  syntax.setFoldAtCursor(true);
  assert.match(text(), /m1\(\) \{\[\d+\]\}/, 'm1 folds first');
  assert.match(text(), /^export class Doc \{\n/, 'class Doc still open after first zc');
  // Caret now rests on m1's placeholder; a second zc closes the enclosing class.
  syntax.setFoldAtCursor(true);
  assert.match(text(), /^export class Doc \{\[\d+\]\}\n?$/, `class Doc should close on the second zc:\n${text()}`);
});

test('closing a fold from inside the body lands the caret before the marker, not on it', () => {
  if (!hasJs) return;
  const { syntax, buffer, text } = setup('function foo() {\n  const x = 1;\n  return x;\n}\n');
  buffer.placeCursor(asIter(buffer.getIterAtLine(1))); // inside the body
  syntax.setFoldAtCursor(true);
  assert.match(text(), /^function foo\(\) \{\[\d+\]\}\n?$/, 'fold collapses');
  const cur = asIter(buffer.getIterAtMark(buffer.getInsert()));
  assert.equal(cur.getLine(), 0, 'caret moved up to the header line');
  assert.equal(cur.getChar(), '{', "caret sits on the `{` before the marker, not on the `[N]`");
});

test('opening a fold reports its revealed body range (so the caret can land inside it)', () => {
  if (!hasJs) return;
  const { syntax, buffer, text } = setup('function foo() {\n  const x = 1;\n  return x;\n}\n');
  buffer.placeCursor(asIter(buffer.getIterAtLine(1)));
  syntax.setFoldAtCursor(true);
  const range = syntax.setFoldAtCursor(false); // open
  assert.ok(range, 'open returns the revealed range (not null), regardless of caret-on-marker');
  assert.deepEqual(range[0], [0, 16], 'range starts just after the header `{`');
  assert.equal(range[1][0], 3, 'range ends on the footer line — the body in between is what was revealed');
  assert.equal(text(), 'function foo() {\n  const x = 1;\n  return x;\n}\n', 'text restored on open');
});

test('zC closes the cursor fold recursively: collapses, and reopening keeps children closed', () => {
  if (!hasJs) return;
  const { syntax, text, buffer } = setup(CLASS);
  // Caret on the (fully expanded) class header. zC closes the class AND records m1/m2 closed.
  buffer.placeCursor(asIter(buffer.getIterAtLine(0)));
  syntax.setFoldAtCursorRecursive(true);
  assert.match(text(), /^export class Doc \{\[\d+\]\}\n?$/, `zC collapses the whole class:\n${text()}`);
  // Reopening the class one level reveals m1/m2 STILL folded — proof zC marked every level
  // closed (a plain zc on the open class would have left the methods expanded).
  buffer.placeCursor(asIter(buffer.getIterAtLine(0)));
  syntax.setFoldAtCursor(false);
  assert.match(
    text(),
    /^export class Doc \{\n {2}m1\(\) \{\[\d+\]\}\n {2}m2\(\) \{\[\d+\]\}\n\}\n?$/,
    `inner method folds should stay closed after zC then opening the class:\n${text()}`,
  );
});

test('zO opens the cursor fold recursively: fully expands a collapsed subtree', () => {
  if (!hasJs) return;
  const { syntax, text, buffer } = setup(CLASS);
  syntax.foldAll(); // everything closed; the class placeholder subsumes m1/m2
  buffer.placeCursor(asIter(buffer.getIterAtLine(0)));
  // zO must fully expand — NOT the one-level zo, which would leave m1/m2 folded.
  syntax.setFoldAtCursorRecursive(false);
  assert.equal(text(), CLASS, `zO fully expands the class and its methods:\n${text()}`);
});

test('zO opens already-collapsed children of an expanded fold', () => {
  if (!hasJs) return;
  const { syntax, text, buffer } = setup(CLASS);
  syntax.foldAll();
  buffer.placeCursor(asIter(buffer.getIterAtLine(0)));
  syntax.setFoldAtCursor(false); // open the class one level: m1/m2 remain folded
  assert.match(text(), /m1\(\) \{\[\d+\]\}/, 'methods start folded');
  // Caret on the now-expanded class header; zO opens the nested method folds too.
  buffer.placeCursor(asIter(buffer.getIterAtLine(0)));
  syntax.setFoldAtCursorRecursive(false);
  assert.equal(text(), CLASS, `zO reveals the nested method folds:\n${text()}`);
});

test('editing + undo with folds collapsed writes through and stays consistent', () => {
  if (!hasJs) return;
  const src = 'export class Doc {\n  m1() {\n    return 1;\n  }\n}\n';
  const { syntax, buffer, doc, text } = setup(src);
  syntax.foldAll();
  const folded = text();
  // Insert before the fold (view offset 0) → writes through to the model; view stays folded.
  buffer.insert(asIter(buffer.getIterAtOffset(0)), 'X', -1);
  assert.equal(doc.getText(), 'X' + src, 'edit wrote through to the model past the fold');
  assert.equal(text(), 'X' + folded, 'view kept the fold collapsed, edit applied before it');
  doc.undo();
  assert.equal(doc.getText(), src, 'undo reverted the model');
  assert.equal(text(), folded, 'undo kept the fold collapsed');
  syntax.unfoldAll();
  assert.equal(text(), src, 'unfolds back to the original after edit+undo');
});
