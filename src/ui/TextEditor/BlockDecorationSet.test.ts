/*
 * BlockDecorationSet — the declarative source-anchored layer. Asserts the contract the refactor
 * rests on: a decoration is declared once against a SOURCE anchor; its view position then rides the
 * primitive's mark across edits with NO further set() call; the editor re-projects it only on a
 * re-materialize; and set() reconciles add/remove/move by id. Drives a real SearchResultsView
 * editor (so `blockDecorations()` is wired to a live ProjectionView).
 *
 * Bands need a mapped view to actually PLACE their overlay (headless views aren't mapped), so these
 * assert the ANCHOR (the decoration's resolved/tracked line via the primitive's mark), which is what
 * placement reads — see BlockDecorationAnchor.test.ts for the mark-survival proof this builds on.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { Gtk } from '../../gi.ts';
import { tmpDir as makeTmpDir } from '../../util/testTmp.ts';
import { zym } from '../../zym.ts';
import { plugins, registerBuiltinPlugins } from '../../plugin/index.ts';
import { preloadGrammars } from '../../syntax/grammar.ts';
import { DocumentRegistry } from './DocumentRegistry.ts';
import { SearchResultsView } from '../SearchResultsView.ts';
import { Range } from '../../text/Range.ts';
import { Point } from '../../text/Point.ts';

Gtk.init();
zym.lsp.configure({ enable: false });

before(async () => {
  try { registerBuiltinPlugins(); } catch { /* already registered */ }
  await plugins.activateAll();
  await preloadGrammars();
});

function tmpFile(name: string, content: string): string {
  const dir = makeTmpDir('bdset');
  const p = Path.join(dir, name);
  Fs.writeFileSync(p, content);
  return p;
}

/** Two files, each one excerpt. view: 0:alpha 1:beta 2:gamma 3:one 4:two 5:three */
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
  return { a, b, mbv };
}

const noWidget = () => new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
const handleOf = (decos: any, id: string) => (decos.entries as Map<string, any>).get(id)?.handle;

test('a source-anchored decoration resolves to the right view row at set()', () => {
  const { a, b, mbv } = setup();
  const decos = mbv.editor.blockDecorations();
  decos.set([
    { id: 'h:a', key: 'a', anchor: { documentKey: a, row: 0 }, placement: 'above', build: noWidget },
    { id: 'h:b', key: 'b', anchor: { documentKey: b, row: 0 }, placement: 'above', build: noWidget },
  ]);
  // a.ts row 0 → view row 0; b.ts row 0 → view row 3 (resolved via the live projection).
  assert.equal(handleOf(decos, 'h:a').line(), 0, 'a.ts header anchors at view row 0');
  assert.equal(handleOf(decos, 'h:b').line(), 3, 'b.ts header anchors at view row 3');
  mbv.dispose();
});

test('the anchor rides edits with NO further set() (write-through + undo)', () => {
  const { b, mbv } = setup();
  const decos = mbv.editor.blockDecorations();
  decos.set([{ id: 'h:b', key: 'b', anchor: { documentKey: b, row: 0 }, placement: 'above', build: noWidget }]);
  const handle = handleOf(decos, 'h:b');
  assert.equal(handle.line(), 3);

  // Open a line in excerpt 1 — b.ts header must follow to row 4 via its mark, no set() called.
  mbv.editor.model.setTextInBufferRange(new Range(new Point(0, 5), new Point(0, 5)), '\nNEW');
  assert.equal(handle.line(), 4, 'mark tracked the inserted row');
  mbv.editor.model.undo();
  assert.equal(handle.line(), 3, 'mark tracked the undo back — no re-projection needed');
  mbv.dispose();
});

test('set() reconciles by id: move, rekey, and remove', () => {
  const { a, b, mbv } = setup();
  const decos = mbv.editor.blockDecorations();
  decos.set([
    { id: 'h:a', key: 'a', anchor: { documentKey: a, row: 0 }, placement: 'above', build: noWidget },
    { id: 'h:b', key: 'b', anchor: { documentKey: b, row: 0 }, placement: 'above', build: noWidget },
  ]);
  const aHandle = handleOf(decos, 'h:a');
  // Re-set with h:a moved to b.ts row 1 and h:b dropped.
  decos.set([{ id: 'h:a', key: 'a', anchor: { documentKey: b, row: 1 }, placement: 'above', build: noWidget }]);
  assert.equal(handleOf(decos, 'h:b'), undefined, 'h:b removed (gone from the spec list)');
  assert.equal(handleOf(decos, 'h:a'), aHandle, 'h:a reused the same handle (reconciled by id)');
  assert.equal(aHandle.line(), 4, 'h:a moved to b.ts row 1 = view row 4');
  mbv.dispose();
});

test('reproject() re-places anchors after a re-materialize drops the marks', () => {
  const { b, mbv } = setup();
  const decos = mbv.editor.blockDecorations();
  decos.set([{ id: 'h:b', key: 'b', anchor: { documentKey: b, row: 0 }, placement: 'above', build: noWidget }]);
  const handle = handleOf(decos, 'h:b');
  assert.equal(handle.line(), 3);
  // Force a materialize (rebuild) — marks collapse to row 0. The editor's onDidMaterialize fires
  // reproject(), which re-seats the anchor onto b.ts row 0 (still view row 3).
  (mbv as any).projectionView.rebuild();
  assert.equal(handle.line(), 3, 're-projected back to b.ts header after materialize');
  mbv.dispose();
});
