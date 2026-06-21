import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk } from '../../gi.ts';
import { Document } from './Document.ts';
import { Point } from '../../text/Point.ts';

// Document owns headless GtkSource buffers + per-view mirrors, so these need GTK.
Gtk.init();

const asIter = (res: any): any => (Array.isArray(res) ? res[res.length - 1] : res);
const insertAt = (buf: any, off: number, text: string) => buf.insert(asIter(buf.getIterAtOffset(off)), text, -1);
const deleteRange = (buf: any, a: number, b: number) =>
  buf.delete(asIter(buf.getIterAtOffset(a)), asIter(buf.getIterAtOffset(b)));
const textOf = (buf: any): string => buf.getText(buf.getStartIter(), buf.getEndIter(), true);

function setup(text: string) {
  const doc = new Document();
  doc.setText(text);
  const a = doc.createView();
  const b = doc.createView();
  const synced = () => textOf(a) === doc.getText() && textOf(b) === doc.getText();
  return { doc, a, b, synced };
}

test('a new view is seeded with the current document text', () => {
  const { doc, a, b } = setup('hello\nworld\n');
  assert.equal(textOf(a), 'hello\nworld\n');
  assert.equal(textOf(b), 'hello\nworld\n');
  assert.equal(doc.getText(), 'hello\nworld\n');
});

test('a native edit in one view propagates to the model and the other views', () => {
  const { doc, a, b, synced } = setup('abc\n');
  insertAt(a, 0, 'X'); // like typing in view A
  assert.ok(synced(), 'all buffers equal after insert in A');
  assert.ok(textOf(b).startsWith('X'), 'B mirrored A');

  insertAt(b, 4, 'YY'); // type in view B
  assert.ok(synced(), 'all buffers equal after insert in B');

  deleteRange(a, 0, 1); // delete the X in view A
  assert.ok(synced(), 'all buffers equal after delete in A');
  assert.ok(!doc.getText().includes('X'), 'X removed everywhere');
});

test('undo/redo run on the model and propagate to every view', () => {
  const { doc, a, synced } = setup('abc\n');
  insertAt(a, 0, 'Z');
  const afterEdit = doc.getText();
  doc.undo();
  assert.ok(synced(), 'synced after undo');
  assert.ok(!doc.getText().includes('Z'), 'undo reverted the insert in all views');
  doc.redo();
  assert.ok(synced(), 'synced after redo');
  assert.equal(doc.getText(), afterEdit, 'redo re-applied');
});

test('setText re-syncs every view and clears modified', () => {
  const { doc, a, b } = setup('one\n');
  insertAt(a, 0, 'x');
  assert.ok(doc.isModified(), 'edits set modified');
  doc.setText('brand new\ncontent\n');
  assert.equal(textOf(a), 'brand new\ncontent\n');
  assert.equal(textOf(b), 'brand new\ncontent\n');
  assert.equal(doc.isModified(), false, 'setText clears modified');
});

test('removed views stop receiving edits', () => {
  const { doc, a, b } = setup('hi\n');
  doc.removeView(b);
  insertAt(a, 0, 'Q');
  assert.equal(doc.getText(), 'Qhi\n');
  assert.equal(textOf(a), 'Qhi\n');
  assert.equal(textOf(b), 'hi\n', 'detached view no longer mirrors');
});

test('500 deterministic-random cross-view edits never desync', () => {
  const { a, b, synced } = setup('the quick brown fox\n');
  let ok = true;
  for (let i = 0; i < 500 && ok; i++) {
    const buf = i % 2 === 0 ? a : b;
    const len = textOf(buf).length;
    const off = (i * 7919) % Math.max(1, len);
    if (i % 3 === 0 && len > 4) {
      const s = Math.min(off, len - 2);
      deleteRange(buf, s, s + 1);
    } else {
      insertAt(buf, Math.min(off, len), String.fromCharCode(97 + (i % 26)));
    }
    ok = synced();
  }
  assert.ok(ok, 'stayed in sync across 500 random edits');
});

// --- Folds (view-side projection of a collapsed model range) -----------------
//
// foldViewRange replaces a view span with a placeholder; the model is the full text.
// So a folded view's text is the COLLAPSED text (not equal to the model), while any
// unfolded view and the model stay in lock-step. Offsets translate across folds.

const SAMPLE = "import {\n  X,\n} from './git.ts';\n";
// view offsets in SAMPLE: `import {`=0..7, `\n`=8, `  X,`=9..12, `\n`=13, `}`=14...
const FOLD = [8, 14] as const; // collapse `\n  X,\n` (after `{`, up to `}`)

test('foldViewRange collapses the view and leaves the model + other views intact', () => {
  const { doc, a, b } = setup(SAMPLE);
  doc.foldViewRange(a, FOLD[0], FOLD[1], '[...]');
  assert.equal(textOf(a), "import {[...]} from './git.ts';\n", 'view A is collapsed to one line');
  assert.equal(doc.getText(), SAMPLE, 'model untouched');
  assert.equal(textOf(b), SAMPLE, 'other view untouched');
});

test('unfoldView restores the collapsed text exactly', () => {
  const { doc, a } = setup(SAMPLE);
  const fold = doc.foldViewRange(a, FOLD[0], FOLD[1], '[...]');
  doc.unfoldView(a, fold!);
  assert.equal(textOf(a), SAMPLE);
});

test('an edit before a fold maps to the right model offset', () => {
  const { doc, a, b } = setup(SAMPLE);
  doc.foldViewRange(a, FOLD[0], FOLD[1], '[...]');
  insertAt(a, 0, 'Q');
  assert.equal(doc.getText(), 'Q' + SAMPLE);
  assert.equal(textOf(a), "Qimport {[...]} from './git.ts';\n");
  assert.equal(textOf(b), 'Q' + SAMPLE);
});

test('an edit after a fold maps past the collapsed body', () => {
  const { doc, a } = setup(SAMPLE);
  doc.foldViewRange(a, FOLD[0], FOLD[1], '[...]');
  insertAt(a, textOf(a).length - 1, '!'); // just before the trailing newline
  assert.equal(textOf(a), "import {[...]} from './git.ts';!\n");
  assert.equal(doc.getText(), "import {\n  X,\n} from './git.ts';!\n");
});

test('a plain view edit propagates into a folded view, kept collapsed', () => {
  const { doc, a, b } = setup(SAMPLE);
  doc.foldViewRange(a, FOLD[0], FOLD[1], '[...]');
  insertAt(b, 0, 'Z');
  assert.equal(doc.getText(), 'Z' + SAMPLE);
  assert.equal(textOf(a), "Zimport {[...]} from './git.ts';\n");
});

test('modelPointFromView maps a caret after a fold to the file line', () => {
  const { doc, a } = setup(SAMPLE);
  doc.foldViewRange(a, FOLD[0], FOLD[1], '[...]');
  // view line 0 = "import {[...]} from './git.ts';" — the `}` is at view column 13.
  const p = doc.modelPointFromView(a, new Point(0, 13));
  assert.equal(p.row, 2, 'maps onto the model footer line');
  assert.equal(p.column, 0, 'the `}` is column 0 on model line 2');
});

test('modelLineForViewLine reflects the collapsed lines', () => {
  const { doc, a } = setup(SAMPLE);
  doc.foldViewRange(a, FOLD[0], FOLD[1], '[...]');
  // view line 0 holds model line 0; view line 1 (after the fold) is model line 3 (the blank).
  assert.equal(doc.modelLineForViewLine(a, 0), 0);
  assert.equal(doc.modelLineForViewLine(a, 1), 3);
});

test('unfold after edits around the fold restores the live model text', () => {
  const { doc, a, b } = setup(SAMPLE);
  const fold = doc.foldViewRange(a, FOLD[0], FOLD[1], '[...]');
  insertAt(b, 0, 'Z');                 // before the fold, via the other view
  insertAt(b, doc.getText().length - 1, '!'); // after the fold
  doc.unfoldView(a, fold!);
  assert.equal(textOf(a), doc.getText(), 'unfolded view equals the live model');
  assert.equal(doc.getText(), "Zimport {\n  X,\n} from './git.ts';!\n");
});

test('600 edits with a fold present never desync the model', () => {
  const { doc, a, b } = setup('the quick brown fox jumps over the lazy dog\n');
  const fold = doc.foldViewRange(a, 4, 16, '[...]'); // collapse "quick brown " in view A
  let ok = true;
  let why = '';
  for (let i = 0; i < 600 && ok; i++) {
    if (i % 2 === 0) {
      // edit the plain view B anywhere
      const len = textOf(b).length;
      const off = (i * 7919) % Math.max(1, len);
      if (i % 3 === 0 && len > 6) deleteRange(b, Math.min(off, len - 2), Math.min(off, len - 2) + 1);
      else insertAt(b, Math.min(off, len), String.fromCharCode(97 + (i % 26)));
    } else {
      insertAt(a, 0, '.'); // edit the folded view, always before the fold
    }
    if (textOf(b) !== doc.getText()) { ok = false; why = `B desync @${i}`; }
  }
  assert.ok(ok, why || 'B mirrored the model across 600 edits');
  // and the fold still round-trips
  doc.unfoldView(a, fold!);
  assert.equal(textOf(a), doc.getText(), 'A unfolds to the live model after the fuzz');
});

// --- Translation round-trips + nested folds ----------------------------------

test('viewPointFromModel inverts modelPointFromView across a fold (boundary guard)', () => {
  const { doc, a } = setup(SAMPLE);
  doc.foldViewRange(a, FOLD[0], FOLD[1], '[...]');
  const mp = new Point(3, 0); // a model line below the fold
  const vp = doc.viewPointFromModel(a, mp);
  assert.deepEqual(doc.modelPointFromView(a, vp).toArray(), mp.toArray(), 'point round-trips');
  assert.equal(doc.modelLineForViewLine(a, doc.viewLineForModelLine(a, 3)), 3, 'line round-trips');
});

test('two folds compose: edits stay in sync and both unfold to the model', () => {
  const { doc, a, b } = setup('A {\n 1\n}\nB {\n 2\n}\n');
  const t = () => textOf(a);
  const fA = doc.foldViewRange(a, t().indexOf('A {') + 3, t().indexOf('}'), '[3]');
  const bOpen = t().indexOf('B {') + 3;
  const fB = doc.foldViewRange(a, bOpen, t().indexOf('}', bOpen), '[3]');
  assert.equal(t(), 'A {[3]}\nB {[3]}\n');
  assert.equal(doc.getText(), 'A {\n 1\n}\nB {\n 2\n}\n', 'model intact');
  insertAt(b, 0, 'Z'); // edit before both folds via the plain view
  assert.equal(doc.getText(), 'ZA {\n 1\n}\nB {\n 2\n}\n');
  assert.equal(t(), 'ZA {[3]}\nB {[3]}\n', 'folds tracked the edit');
  doc.unfoldView(a, fB!);
  doc.unfoldView(a, fA!);
  assert.equal(t(), doc.getText());
});

test('folding a region that already contains a fold (nesting) keeps the model intact', () => {
  const { doc, a } = setup('out {\n in {\n  x\n }\n}\n');
  const t = () => textOf(a);
  doc.foldViewRange(a, t().indexOf('in {') + 4, t().indexOf('}'), '[3]'); // fold inner
  assert.equal(t(), 'out {\n in {[3]}\n}\n');
  // now fold outer — its body contains the inner placeholder
  const fOuter = doc.foldViewRange(a, t().indexOf('out {') + 5, t().lastIndexOf('}'), '[5]');
  assert.equal(t(), 'out {[5]}\n', 'outer collapses, subsuming the inner fold');
  assert.equal(doc.getText(), 'out {\n in {\n  x\n }\n}\n', 'model never corrupted by nesting');
  insertAt(a, 0, 'Z'); // edit after nesting still translates correctly
  assert.equal(doc.getText(), 'Zout {\n in {\n  x\n }\n}\n');
  doc.unfoldView(a, fOuter!);
  assert.equal(t(), 'Zout {\n in {\n  x\n }\n}\n', 'unfolding the outer restores the full body');
});

test('an edit after a nested (subsumed) fold lands at the right model offset', () => {
  const { doc, a } = setup('out {\n in {\n  x\n }\n}\n');
  const t = () => textOf(a);
  doc.foldViewRange(a, t().indexOf('in {') + 4, t().indexOf('}'), '[3]');
  doc.foldViewRange(a, t().indexOf('out {') + 5, t().lastIndexOf('}'), '[5]');
  // view is 'out {[5]}\n'; insert right after the `}` (before the trailing newline)
  insertAt(a, t().length - 1, '!');
  assert.equal(doc.getText(), 'out {\n in {\n  x\n }\n}!\n', 'edit maps past the FULL body, no double-count');
});
