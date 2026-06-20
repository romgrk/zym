/*
 * REAL vim-operator behavior at excerpt boundaries in the editable search multibuffer.
 * Unlike SearchResultsEditable.test.ts (which calls setTextInBufferRange directly, hand-rolling
 * the range each operator *would* produce), this drives the actual vim operation stack — so it
 * catches divergence between what the operator really does and what the substrate assumes. These
 * are the cases the user hit in the running app (cc / visual-c at a boundary, two regions of one
 * file).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { Gtk } from '../gi.ts';
import { quilx } from '../quilx.ts';
import { plugins, registerBuiltinPlugins } from '../plugin/index.ts';
import { preloadGrammars } from '../syntax/grammar.ts';
import { DocumentRegistry } from './TextEditor/DocumentRegistry.ts';
import { SearchResultsView } from './SearchResultsView.ts';
import { Point } from '../text/Point.ts';
import { before } from 'node:test';

Gtk.init();
quilx.lsp.configure({ enable: false });

before(async () => {
  try { registerBuiltinPlugins(); } catch { /* already registered */ }
  await plugins.activateAll();
  await preloadGrammars();
});

let tmpSeq = 0;
function tmpFile(name: string, content: string): string {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), `quilx-mbvim-${tmpSeq++}-`));
  const p = Path.join(dir, name);
  Fs.writeFileSync(p, content);
  return p;
}

function vim(mbv: SearchResultsView) {
  return (mbv.editor as any).vimState;
}
function run(mbv: SearchResultsView, klass: string) {
  vim(mbv).operationStack.run(klass);
}

/** Two files, each one full excerpt. View: 0:alpha 1:beta 2:gamma 3:one 4:two 5:three */
function setupTwoFiles() {
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
  return { a, b, registry, mbv, lines: () => mbv.editor.getText().split('\n') };
}

/** One file, two non-adjacent regions (alpha case): same source, two segments, hidden gap.
 *  source: r0..r7 ; view: 0:r0 1:r1 2:r5 3:r6 */
function setupTwoRegions() {
  const a = tmpFile('big.ts', 'r0\nr1\nr2\nr3\nr4\nr5\nr6\nr7\n');
  const registry = new DocumentRegistry();
  const mbv = new SearchResultsView({
    editable: true,
    documents: registry,
    excerpts: [{ path: a, regions: [{ startRow: 0, endRow: 1 }, { startRow: 5, endRow: 6 }] }],
  });
  return { a, registry, mbv, lines: () => mbv.editor.getText().split('\n') };
}

test('REAL cc on an excerpt\'s last line stays inside that excerpt', () => {
  const { a, b, registry, mbv, lines } = setupTwoFiles();
  mbv.editor.model.setCursorBufferPosition(new Point(2, 0)); // "gamma", a.ts last shown line (boundary)
  run(mbv, 'Change');
  run(mbv, 'Change'); // cc
  // Should leave an EMPTY line in a.ts where gamma was, cursor on it in insert mode — never touch b.ts.
  assert.equal(vim(mbv).mode, 'insert', 'cc enters insert mode');
  assert.equal(registry.find(b)!.getText(), 'one\ntwo\nthree\n', 'b.ts untouched (no cross-excerpt insert)');
  assert.equal(registry.find(a)!.getText(), 'alpha\nbeta\n\n', 'gamma cleared to an empty line in a.ts');
  assert.deepEqual(lines(), ['alpha', 'beta', '', 'one', 'two', 'three'], 'empty line stays in excerpt 1');
  assert.equal(mbv.editor.model.getCursorBufferPosition().row, 2, 'cursor stays on the cleared line');
  mbv.dispose();
});

test('REAL cc on the last line of the FIRST region (hidden gap follows) stays in that region', () => {
  const { a, registry, mbv, lines } = setupTwoRegions();
  // view: 0:r0 1:r1 2:r5 3:r6 — row 1 (r1) is the last line of region 1; a HIDDEN gap (r2..r4)
  // and then region 2 (r5..) follow. cc here must clear r1, never pull r5 up.
  mbv.editor.model.setCursorBufferPosition(new Point(1, 0));
  run(mbv, 'Change');
  run(mbv, 'Change');
  assert.equal(vim(mbv).mode, 'insert', 'cc enters insert mode');
  assert.equal(registry.find(a)!.getText(), 'r0\n\nr2\nr3\nr4\nr5\nr6\nr7\n', 'r1 cleared in place, gap intact');
  assert.deepEqual(lines(), ['r0', '', 'r5', 'r6'], 'region 2 still shows r5,r6 — nothing pulled across the gap');
  mbv.dispose();
});

test('REAL o on a region\'s last line keeps the `⋯` gap below the opened line', () => {
  const { mbv } = setupTwoRegions();
  // view: 0:r0 1:r1 2:r5 3:r6 — the `⋯` gap sits between region 1 (r0,r1) and region 2 (r5,r6).
  const gap = () => ((mbv as any).bands.entries as Map<string, any>).get('gap:0:1')?.handle;
  assert.ok(gap(), 'a gap decoration exists between the two regions');
  // `o` on r1 (region 1's last line) opens a blank below it — the gap must stay BELOW that blank
  // (between region 1's new end and region 2), i.e. anchored to region 2's first row.
  mbv.editor.model.setCursorBufferPosition(new Point(1, 0));
  run(mbv, 'InsertBelowWithNewline');
  (mbv.editor as any).vimState.activate?.('normal');
  // view now: 0:r0 1:r1 2:(blank) 3:r5 4:r6 — the gap must render above r5 (row 3), not above the blank.
  assert.equal(gap().line(), 3, 'gap rides down to region 2\'s first row — the opened line is above it');
  mbv.dispose();
});

test('REAL visual-c across two regions of one file does not corrupt the view/source', () => {
  const { a, registry, mbv, lines } = setupTwoRegions();
  // Visual-select from r1 (view row 1) across the hidden gap into r5 (view row 2), then `c`.
  mbv.editor.model.setCursorBufferPosition(new Point(1, 0));
  run(mbv, 'ActivateCharacterwiseVisualMode');
  run(mbv, 'MoveDown'); // extend the selection into the next region (view row 2 = r5)
  run(mbv, 'MoveRight');
  // The selection spans a segment boundary — the edit must be REJECTED whole (no view corruption).
  const before = registry.find(a)!.getText();
  try { run(mbv, 'Change'); } catch { /* a rejected operator may bail */ }
  assert.equal(registry.find(a)!.getText(), before, 'source unchanged — cross-segment edit rejected');
  assert.deepEqual(lines(), ['r0', 'r1', 'r5', 'r6'], 'view not corrupted');
  mbv.dispose();
});

test('REAL o then u realigns the next excerpt header against a FRESH projection', async () => {
  const { a, b, registry, mbv, lines } = setupTwoFiles();
  const projection = () => (mbv as any).projectionView.view;
  // installBands anchors b.ts's header at this view row; before the edit it is row 3 ("one").
  assert.equal(projection().viewRowForSource(b, 0), 3, 'b.ts header anchors at view row 3 initially');

  mbv.editor.model.setCursorBufferPosition(new Point(0, 0)); // on "alpha"
  run(mbv, 'InsertBelowWithNewline'); // o — inserts a line in a.ts; b.ts header shifts to row 4
  (mbv.editor as any).vimState.activate?.('normal');
  assert.equal(projection().viewRowForSource(b, 0), 4, 'after o, b.ts header is one row lower');

  mbv.editor.model.undo(); // u — reverse-sync mirrors the delete; the remap is DEFERRED
  // The remap is queued (not yet run): band reconcile MUST be skipped now (the map is stale) and
  // deferred to the reflow — otherwise installBands re-anchors the header off the old map.
  assert.equal((mbv as any).projectionView.isSyncPending(), true, 'remap pending right after undo — stale reconcile skipped');
  assert.equal(registry.find(a)!.getText(), 'alpha\nbeta\ngamma\n', 'source restored by undo');
  assert.deepEqual(lines(), ['alpha', 'beta', 'gamma', 'one', 'two', 'three'], 'view realigned after undo');
  // Let the deferred remap settle, then the projection band-anchor must be back to row 3. (Before
  // the fix the map stayed stale and installBands anchored the header off the wrong row.)
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(projection().viewRowForSource(b, 0), 3, 'after the remap settles, b.ts header anchors at row 3 again');
  mbv.dispose();
});
