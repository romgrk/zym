/*
 * Mark-anchor survival — the invariant the declarative block-decoration refactor rests on.
 *
 * BlockDecorations anchors each band with a left-gravity GtkTextMark on the VIEW buffer. The claim:
 * after initial placement that mark tracks every INCREMENTAL view edit on its own — write-through,
 * the reverse-sync mirror of an undo, and the diff's retarget splice — so a band needs NO per-edit
 * re-projection (the per-edit installBands re-derivation in the surfaces was both unnecessary and
 * the cause of the `o u` header misposition: it re-seated the mark to a row recomputed from a stale
 * projection). The ONE case the mark cannot survive is a full re-materialize (setText destroys
 * marks): collapse/rebuild/initial — exactly where re-projection IS required.
 *
 * These tests anchor a RAW mark on the view buffer (same primitive BlockDecorations uses) and drive
 * each edit path WITHOUT touching the bands, asserting the mark stays on its content.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { Gtk, GLib } from '../../gi.ts';
import { quilx } from '../../quilx.ts';
import { plugins, registerBuiltinPlugins } from '../../plugin/index.ts';
import { preloadGrammars } from '../../syntax/grammar.ts';
import { DocumentRegistry } from './DocumentRegistry.ts';
import { SearchResultsView } from '../SearchResultsView.ts';
import { ContinuousDiffView } from '../ContinuousDiffView.ts';
import { Range } from '../../text/Range.ts';
import { Point } from '../../text/Point.ts';

Gtk.init();
quilx.lsp.configure({ enable: false });

before(async () => {
  try { registerBuiltinPlugins(); } catch { /* already registered */ }
  await plugins.activateAll();
  await preloadGrammars();
});

let tmpSeq = 0;
function tmpFile(name: string, content: string): string {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), `quilx-mbanchor-${tmpSeq++}-`));
  const p = Path.join(dir, name);
  Fs.writeFileSync(p, content);
  return p;
}

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);
const pumpUntil = (done: () => boolean, maxFrames = 90) => {
  const ctx = GLib.MainContext.default();
  for (let i = 0; i < maxFrames && !done(); i++) ctx.iteration(true);
};

/** A left-gravity mark on `buffer` at the start of view `line` — the exact primitive a band uses.
 *  Returns helpers to read the mark's current line and the text of that line. */
function anchorAt(buffer: any, line: number) {
  const mark = buffer.createMark(null, asIter(buffer.getIterAtLine(line)), true /* left gravity */);
  const lineOf = () => asIter(buffer.getIterAtMark(mark)).getLine();
  const textOf = () => {
    const start = asIter(buffer.getIterAtMark(mark));
    const end = start.copy();
    if (!end.endsLine()) end.forwardToLineEnd();
    return buffer.getText(start, end, true);
  };
  return { mark, lineOf, textOf };
}

function setupSearch() {
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
  return { a, b, registry, mbv, buffer: (mbv.editor.model as any).buffer };
}

test('anchor survives write-through + undo with NO re-projection (the o-u case, mark-only)', () => {
  const { mbv, buffer } = setupSearch();
  // view: 0:alpha 1:beta 2:gamma 3:one 4:two 5:three — anchor b.ts's header at row 3 ("one").
  const anchor = anchorAt(buffer, 3);
  assert.equal(anchor.lineOf(), 3);
  assert.equal(anchor.textOf(), 'one');

  // Write-through: open a line inside excerpt 1 (after "alpha"). b.ts shifts down by one.
  mbv.editor.model.setTextInBufferRange(new Range(new Point(0, 5), new Point(0, 5)), '\nNEW');
  assert.equal(anchor.lineOf(), 4, 'mark tracked the inserted row — no installBands needed');
  assert.equal(anchor.textOf(), 'one', 'still anchored to its own content');

  // Undo: the reverse-sync mirror deletes the row from the view SYNCHRONOUSLY (only the coordinate
  // remap is deferred). The mark moves back immediately — i.e. a band would already be correct
  // BEFORE the deferred remap, which is why no reflow re-seat is required.
  mbv.editor.model.undo();
  assert.equal(anchor.lineOf(), 3, 'mark tracked the undo back to row 3, synchronously');
  assert.equal(anchor.textOf(), 'one');
  mbv.dispose();
});

test('anchor survives the diff retarget splice (re-diff) — minimal splice keeps marks', async () => {
  const oldText = 'line1\nline2\nline3\n';
  const newText = 'line1\nCHANGED\nline3\n';
  const path = tmpFile('f.ts', newText);
  const registry = new DocumentRegistry();
  const mbv = new ContinuousDiffView({ editable: true, documents: registry, files: [{ path, oldText, newText }] });
  const buffer = (mbv.editor.model as any).buffer;
  // Anchor the stable context line "line3" — it stays present across the re-diff.
  const lines: string[] = mbv.editor.getText().split('\n');
  const anchor = anchorAt(buffer, lines.indexOf('line3'));
  assert.equal(anchor.textOf(), 'line3');

  // Edit the new side (insert a row near the top) → re-diff → retarget splices the view.
  const l1 = mbv.editor.getText().split('\n').indexOf('line1');
  mbv.editor.model.setTextInBufferRange(new Range(new Point(l1, 5), new Point(l1, 5)), '\nNEWLINE');
  await new Promise((r) => setTimeout(r, 220)); // > REDIFF debounce
  pumpUntil(() => mbv.editor.getText().includes('NEWLINE'));

  assert.equal(anchor.textOf(), 'line3', 'mark followed its content through the retarget splice');
  mbv.dispose();
});

test('collapse/expand ALSO preserves the anchor — it splices (retarget), not materializes', () => {
  const { mbv, buffer } = setupSearch();
  const anchor = anchorAt(buffer, 3); // b.ts header at "one"
  assert.equal(anchor.textOf(), 'one');
  // collapseAll() re-flows via ProjectionView.retarget (a minimal splice), so the mark rides it:
  // collapsing a.ts to one row deletes "beta"/"gamma", and the b.ts header follows up to row 1.
  mbv.collapseAll();
  assert.deepEqual(mbv.editor.getText().split('\n'), ['alpha', 'one'], 'collapsed form');
  assert.equal(anchor.textOf(), 'one', 'the header mark followed the splice — no re-derive of its line needed');
  assert.equal(anchor.lineOf(), 1, 'now on row 1, tracked by the mark');
  mbv.dispose();
});

test('only a true materialize (ProjectionView.rebuild / reload) drops the anchor — the lone re-project point', () => {
  const { mbv, buffer } = setupSearch();
  const anchor = anchorAt(buffer, 3);
  assert.equal(anchor.textOf(), 'one');
  // rebuild() goes through materialize() → buffer.setText, which destroys marks (they collapse to
  // the start). This is the ONE path (initial build, explicit rebuild, Document file-reload) where
  // a band must be re-placed from a fresh projection; every incremental edit/splice above does not.
  (mbv as any).projectionView.rebuild();
  assert.notEqual(anchor.textOf(), 'one', 'the pre-materialize mark no longer tracks its content — re-project here');
  mbv.dispose();
});
