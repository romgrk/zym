/*
 * Editable project-search multibuffer — SURFACE proof (3d / G6,
 * docs/text-editor/multibuffer.md). A `SearchResultsView({ editable: true })` backs each
 * source with a live `Document` from the registry, so editing a result row writes through to
 * the file's model (visible to any open tab, persisted by save), block (header) rows reject
 * edits, undo routes through the coordinating `ProjectionView`, and a row-count-changing edit
 * re-segments analytically. Complements ProjectionView.test.ts (the substrate) by exercising
 * the full editor funnel (vim → setTextInBufferRange → write-through) over real files.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { Gtk } from '../gi.ts';
import { tmpDir as makeTmpDir } from '../util/testTmp.ts';
import { zym } from '../zym.ts';
import { plugins, registerBuiltinPlugins } from '../plugin/index.ts';
import { preloadGrammars, getGrammar, langIdForPath } from '../syntax/grammar.ts';
import { DocumentRegistry } from './TextEditor/DocumentRegistry.ts';
import { SearchResultsView } from './SearchResultsView.ts';
import { Range } from '../text/Range.ts';
import { Point } from '../text/Point.ts';

Gtk.init();
zym.lsp.configure({ enable: false }); // no language servers spawned in the headless test

let hasJs = false;
before(async () => {
  try { registerBuiltinPlugins(); } catch { /* already registered */ }
  await plugins.activateAll();
  await preloadGrammars();
  hasJs = !!getGrammar(langIdForPath('/x.ts') ?? '');
});

function tmpFile(name: string, content: string): string {
  const dir = makeTmpDir('mbedit');
  const p = Path.join(dir, name);
  Fs.writeFileSync(p, content);
  return p;
}

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);

/** Whether view (row, col) carries the search-highlight decoration tag. */
function hasSearchTag(mbv: SearchResultsView, row: number, col: number): boolean {
  const buffer = mbv.editor.sourceView.getBuffer();
  const tag = buffer.getTagTable().lookup('deco:search:highlight');
  if (!tag) return false;
  return asIter(buffer.getIterAtLineOffset(row, col)).hasTag(tag);
}

/** Two files, each shown as one full excerpt. Headers are WIDGETS (not buffer rows), so the
 *  buffer holds only source rows. View layout:
 *  0:alpha 1:beta 2:gamma 3:one 4:two 5:three */
function setup() {
  const a = tmpFile('a.ts', 'alpha\nbeta\ngamma\n');
  const b = tmpFile('b.ts', 'one\ntwo\nthree\n');
  const registry = new DocumentRegistry();
  const mbv = new SearchResultsView({
    editable: true,
    documents: registry,
    excerpts: [
      { path: a, regions: [{ startRow: 0, endRow: 2 }] },
      { path: b, regions: [{ startRow: 0, endRow: 2 }] },
    ],
  });
  const lines = () => mbv.editor.getText().split('\n');
  const edit = (row: number, col: number, text: string, endRow = row, endCol = col) =>
    mbv.editor.model.setTextInBufferRange(new Range(new Point(row, col), new Point(endRow, endCol)), text);
  return { a, b, registry, mbv, lines, edit };
}

test('editable search: opens with the caret at the top (not the materialized end)', () => {
  const { mbv } = setup();
  assert.deepEqual(mbv.editor.model.getCursorBufferPosition().toArray(), [0, 0]);
  mbv.dispose();
});

/** One file with two non-adjacent regions → two segments separated by a `⋯` gap (a WIDGET band,
 *  not a buffer row). View layout (buffer): 0:L0 1:L1 2:L4 3:L5 — only real source rows. */
function setupWithGap() {
  const a = tmpFile('a.ts', 'L0\nL1\nL2\nL3\nL4\nL5\n');
  const registry = new DocumentRegistry();
  const mbv = new SearchResultsView({
    editable: true,
    documents: registry,
    excerpts: [{ path: a, regions: [{ startRow: 0, endRow: 1 }, { startRow: 4, endRow: 5 }] }],
  });
  return { registry, mbv, lines: () => mbv.editor.getText().split('\n') };
}

test('gaps are widgets, not buffer text — only real source rows reach the buffer, no `⋯`', () => {
  const { mbv } = setupWithGap();
  assert.deepEqual(mbv.editor.getText().split('\n'), ['L0', 'L1', 'L4', 'L5'], 'the `⋯` gap is not a buffer row');
  const projection = (mbv as any).projectionView.view;
  for (let r = 0; r < 4; r++) assert.equal(projection.screenToDocument(r, 0).kind, 'document', `row ${r} is a real source row`);
  mbv.dispose();
});

test('copy: yanking across the gap yields only real source lines (no `⋯` to strip)', () => {
  const { mbv } = setupWithGap();
  // A selection spanning the (widget) gap: L1 .. L4 — the buffer has no gap row between them.
  const raw = mbv.editor.model.getTextInBufferRange(new Range(new Point(1, 0), new Point(3, 0)));
  assert.equal(raw, 'L1\nL4\n', 'the copied text is contiguous source lines, no gap marker');
  assert.ok(!raw.includes('⋯'));
  mbv.dispose();
});

test('collapse: toggling a file collapses it to its first row; toggling again expands it', () => {
  const { mbv } = setupWithGap();
  assert.deepEqual(mbv.editor.getText().split('\n'), ['L0', 'L1', 'L4', 'L5']);
  mbv.editor.model.setCursorBufferPosition({ row: 1, column: 0 }); // cursor inside the file
  mbv.toggleCollapseAtCursor();
  assert.deepEqual(mbv.editor.getText().split('\n'), ['L0'], 'collapsed to the first source row');
  mbv.toggleCollapseAtCursor();
  assert.deepEqual(mbv.editor.getText().split('\n'), ['L0', 'L1', 'L4', 'L5'], 'expanded back to full regions');
  mbv.dispose();
});

test('collapse: collapseAll shows one row per file; expandAll restores all', () => {
  const { mbv, lines } = setup(); // a.ts: alpha/beta/gamma, b.ts: one/two/three
  assert.deepEqual(lines(), ['alpha', 'beta', 'gamma', 'one', 'two', 'three']);
  mbv.collapseAll();
  assert.deepEqual(lines(), ['alpha', 'one'], 'each file collapsed to its first row');
  mbv.expandAll();
  assert.deepEqual(lines(), ['alpha', 'beta', 'gamma', 'one', 'two', 'three'], 'all expanded');
  mbv.dispose();
});

test('collapse: a collapsed file still maps its visible row to the source (navigation works)', () => {
  const { mbv } = setupWithGap();
  mbv.collapseAll();
  const target = (mbv as any).projectionView.view.screenToDocument(0, 0);
  assert.equal(target.kind, 'document', 'the surviving row maps to a real source position');
  assert.equal(target.row, 0, 'it is the file\'s first row');
  mbv.dispose();
});

test('headers are widgets, not buffer text (the filename never appears as a buffer row)', () => {
  const { lines, mbv } = setup();
  assert.deepEqual(lines(), ['alpha', 'beta', 'gamma', 'one', 'two', 'three'], 'only source rows reach the buffer');
  assert.ok(!lines().some((l) => l.includes('.ts')), 'no filename header row in the buffer text');
  mbv.dispose();
});

test('search match: the hit span is highlighted at its mapped view position', () => {
  const a = tmpFile('hit.ts', 'const foo = 1;\nbar\n'); // "foo" at source row 0, cols 6..9
  const registry = new DocumentRegistry();
  const mbv = new SearchResultsView({
    editable: true,
    documents: registry,
    excerpts: [{ path: a, regions: [{ startRow: 0, endRow: 1 }], matches: [{ row: 0, startCol: 6, endCol: 9 }] }],
  });
  // view (widget header): 0:'const foo = 1;' 1:'bar' — source row 0 → view row 0, cols pass through
  assert.equal(hasSearchTag(mbv, 0, 6), true, 'first char of the match highlighted');
  assert.equal(hasSearchTag(mbv, 0, 8), true, 'inside the match highlighted');
  assert.equal(hasSearchTag(mbv, 0, 5), false, 'the space before the match is not highlighted');
  assert.equal(hasSearchTag(mbv, 0, 9), false, 'end column is exclusive');
  mbv.dispose();
});

test('editable search: a file opened only by the search gets its grammar parsed (highlighting)', () => {
  if (!hasJs) return; // grammars not vendored in this environment
  const { a, b, registry, mbv } = setup(); // neither file was open before the search
  assert.equal(registry.find(a)!.syntax.hasTree, true, 'a.ts parsed even though no tab opened it');
  assert.equal(registry.find(b)!.syntax.hasTree, true, 'b.ts parsed even though no tab opened it');
  mbv.dispose();
});

test('editable search: an in-place edit writes through to the live Document', () => {
  const { a, b, registry, mbv, lines, edit } = setup();
  edit(1, 0, 'X'); // view row 1 = "beta" (a.ts source row 1)
  assert.equal(registry.find(a)!.getText(), 'alpha\nXbeta\ngamma\n', 'wrote through to a.ts model');
  assert.equal(registry.find(b)!.getText(), 'one\ntwo\nthree\n', 'b.ts untouched');
  assert.equal(lines()[1], 'Xbeta', 'and shows in the multibuffer view');
  mbv.dispose();
});

test('editable search: dd on the last line of an excerpt deletes that source line (boundary)', () => {
  const { a, b, registry, mbv, lines } = setup();
  assert.deepEqual(lines(), ['alpha', 'beta', 'gamma', 'one', 'two', 'three']);
  // `dd` on view row 2 ("gamma", a.ts's last shown line) = delete the linewise range [2,0]–[3,0],
  // whose end row 3 is b.ts's first line (a DIFFERENT source). It must delete a.ts's line, not be
  // rejected as cross-source.
  mbv.editor.model.setTextInBufferRange(new Range(new Point(2, 0), new Point(3, 0)), '');
  assert.equal(registry.find(a)!.getText(), 'alpha\nbeta\n', 'gamma deleted from a.ts');
  assert.equal(registry.find(b)!.getText(), 'one\ntwo\nthree\n', 'b.ts untouched');
  assert.deepEqual(lines(), ['alpha', 'beta', 'one', 'two', 'three'], 'view reflowed, no merge across files');
  mbv.dispose();
});

test('editable search: cc-style clear of an excerpt\'s last line stays inside that excerpt', () => {
  const { a, b, registry, mbv, lines } = setup();
  // What `cc` now does on a single line: clear its CONTENT (keep the line + newline), so it never
  // crosses into the next excerpt. Row 2 = "gamma", a.ts's last shown line, at the boundary.
  const end = mbv.editor.model.bufferRangeForBufferRow(2).end;
  mbv.editor.model.setTextInBufferRange(new Range(new Point(2, 0), new Point(end.row, end.column)), '');
  assert.equal(registry.find(a)!.getText(), 'alpha\nbeta\n\n', 'gamma cleared to an empty line in a.ts');
  assert.equal(registry.find(b)!.getText(), 'one\ntwo\nthree\n', 'b.ts untouched — no insert into the next excerpt');
  assert.deepEqual(lines(), ['alpha', 'beta', '', 'one', 'two', 'three'], 'empty line stays in excerpt 1');
  mbv.dispose();
});

test('editable search: a delete that actually reaches into the next excerpt is still rejected', () => {
  const { a, b, registry, mbv, lines } = setup();
  // [2,0]–[3,1] touches b.ts's first column → genuinely cross-source → rejected, nothing changes.
  mbv.editor.model.setTextInBufferRange(new Range(new Point(2, 0), new Point(3, 1)), '');
  assert.equal(registry.find(a)!.getText(), 'alpha\nbeta\ngamma\n', 'a.ts untouched');
  assert.equal(registry.find(b)!.getText(), 'one\ntwo\nthree\n', 'b.ts untouched');
  assert.deepEqual(lines(), ['alpha', 'beta', 'gamma', 'one', 'two', 'three'], 'view unchanged');
  mbv.dispose();
});

test('editable search: undo routes through the coordinating ProjectionView', () => {
  const { a, registry, mbv, edit } = setup();
  edit(0, 0, 'AA'); // view row 0 = "alpha" → "AAalpha"
  assert.equal(registry.find(a)!.getText(), 'AAalpha\nbeta\ngamma\n');
  mbv.editor.model.undo();
  assert.equal(registry.find(a)!.getText(), 'alpha\nbeta\ngamma\n', 'undo reverted the source');
  mbv.dispose();
});

test('editable search: a multi-line edit re-segments; later rows still map correctly', () => {
  const { a, b, registry, mbv, lines, edit } = setup();
  edit(1, 4, '\nINSERTED'); // append a line after "beta" (a.ts source row 1)
  assert.equal(registry.find(a)!.getText(), 'alpha\nbeta\nINSERTED\ngamma\n', 'source grew by a row');
  assert.deepEqual(
    lines(),
    ['alpha', 'beta', 'INSERTED', 'gamma', 'one', 'two', 'three'],
    'the excerpt grew in place; b.ts excerpt shifted down intact',
  );
  // A subsequent in-place edit on a shifted row below routes to the right source (map rebuilt).
  edit(6, 0, 'Q'); // view row 6 = "three" (b.ts source row 2)
  assert.equal(registry.find(b)!.getText(), 'one\ntwo\nQthree\n', 'edit after the re-segment routed to b.ts');
  mbv.dispose();
});

test('editable search: save() persists every edited file to disk', () => {
  const { a, b, mbv, edit } = setup();
  edit(0, 0, 'A1'); // edit a.ts (view row 0 = "alpha")
  edit(3, 0, 'B1'); // edit b.ts (view row 3 = "one")
  assert.equal(mbv.isModified(), true);
  mbv.save();
  assert.equal(Fs.readFileSync(a, 'utf8'), 'A1alpha\nbeta\ngamma\n', 'a.ts written');
  assert.equal(Fs.readFileSync(b, 'utf8'), 'B1one\ntwo\nthree\n', 'b.ts written');
  assert.equal(mbv.isModified(), false, 'clean after save');
  mbv.dispose();
});

test('editable search: two regions of one file — a multi-line edit in the first shifts the second', () => {
  const a = tmpFile('big.ts', 'r0\nr1\nr2\nr3\nr4\nr5\nr6\nr7\n'); // rows 0..8 (row 8 empty)
  const registry = new DocumentRegistry();
  const mbv = new SearchResultsView({
    editable: true,
    documents: registry,
    excerpts: [{ path: a, regions: [{ startRow: 0, endRow: 1 }, { startRow: 5, endRow: 6 }] }],
  });
  // view (widget header + widget gap): 0:r0 1:r1 2:r5 3:r6 — the `⋯` gap is NOT a buffer row.
  const lines = () => mbv.editor.getText().split('\n');
  assert.deepEqual(lines(), ['r0', 'r1', 'r5', 'r6']);
  // Insert a line in the FIRST region (after r0) — the second region must keep showing r5,r6.
  mbv.editor.model.setTextInBufferRange(new Range(new Point(0, 2), new Point(0, 2)), '\nNEW');
  assert.equal(registry.find(a)!.getText(), 'r0\nNEW\nr1\nr2\nr3\nr4\nr5\nr6\nr7\n', 'source grew');
  assert.deepEqual(lines(), ['r0', 'NEW', 'r1', 'r5', 'r6'], 'second region still shows r5,r6');
  // And editing the second region routes to the correct (unshifted-in-source) rows.
  mbv.editor.model.setTextInBufferRange(new Range(new Point(4, 0), new Point(4, 0)), 'Z'); // view row 4 = r6
  assert.equal(registry.find(a)!.getText(), 'r0\nNEW\nr1\nr2\nr3\nr4\nr5\nZr6\nr7\n', 'second-region edit hit r6');
  mbv.dispose();
});

test('editable search: replace-all across files is one undo step (G6)', () => {
  const a = tmpFile('a.ts', 'x foo y\n');
  const b = tmpFile('b.ts', 'foo bar\n');
  const registry = new DocumentRegistry();
  const mbv = new SearchResultsView({
    editable: true,
    documents: registry,
    excerpts: [
      { path: a, regions: [{ startRow: 0, endRow: 0 }] },
      { path: b, regions: [{ startRow: 0, endRow: 0 }] },
    ],
  });
  // The same path SearchController.replaceAll drives: one transact over the whole scan, so the
  // write-throughs to BOTH files coalesce into one ProjectionView transaction.
  let count = 0;
  mbv.editor.model.scan(/foo/g, ({ replace }) => {
    replace('BAR');
    count++;
  });
  assert.equal(count, 2, 'matched both files');
  assert.equal(registry.find(a)!.getText(), 'x BAR y\n', 'a.ts replaced');
  assert.equal(registry.find(b)!.getText(), 'BAR bar\n', 'b.ts replaced');
  mbv.editor.model.undo(); // ONE undo
  assert.equal(registry.find(a)!.getText(), 'x foo y\n', 'a.ts reverted by the single undo');
  assert.equal(registry.find(b)!.getText(), 'foo bar\n', 'b.ts reverted by the single undo (one cross-file step)');
  mbv.dispose();
});

test('editable search: a file already open in the registry is shared (edit reaches that Document)', () => {
  const a = tmpFile('a.ts', 'alpha\nbeta\ngamma\n');
  const registry = new DocumentRegistry();
  const { document } = registry.acquire(a); // a "tab" opened it first
  document.loadFile(a);
  const mbv = new SearchResultsView({
    editable: true,
    documents: registry,
    excerpts: [{ path: a, regions: [{ startRow: 0, endRow: 2 }] }],
  });
  // view (widget header): 0:alpha 1:beta 2:gamma — edit "alpha"
  mbv.editor.model.setTextInBufferRange(new Range(new Point(0, 0), new Point(0, 0)), 'SHARED ');
  assert.equal(document.getText(), 'SHARED alpha\nbeta\ngamma\n', 'the edit reached the already-open Document');
  mbv.dispose();
  registry.release(document); // drop the "tab"'s ref
});
