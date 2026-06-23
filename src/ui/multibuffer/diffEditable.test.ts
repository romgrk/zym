/*
 * Editable diff multibuffer — MECHANISM proof (Phase 3b/G5). Proves the substrate supports an
 * editable diff over a LIVE Document on the new side + a base blob on the old side: an in-place
 * edit to a new-side (context/added) row writes through to the Document's model (which would
 * propagate to the file's own tab + save), a removed (phantom, old-side) row rejects edits,
 * and the ProjectionView coordinates undo. The GUI surface (acquiring live Documents, flipping
 * the view editable, save) is the remaining wiring; this pins the model-level behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource, type SourceBuffer } from '../../gi.ts';
import { Document } from '../TextEditor/Document.ts';
import { ProjectionView } from '../TextEditor/ProjectionView.ts';
import { buildDiffMultiBuffer } from './diffMultiBuffer.ts';

Gtk.init();

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);
const textOf = (b: any): string => b.getText(b.getStartIter(), b.getEndIter(), true);
const insertAtRow = (buf: any, row: number, text: string) =>
  buf.insert(asIter(buf.getIterAtLine(row)), text, -1);

function setup(oldText: string, newText: string) {
  const path = '/a.ts';
  const doc = new Document();
  doc.setText(newText); // the new side IS a live Document (its model)
  const oldBuf = new GtkSource.Buffer() as SourceBuffer;
  oldBuf.setText(oldText, -1);
  const dmb = buildDiffMultiBuffer([{ path, oldText, newText }]);
  const sources = new Map<string, SourceBuffer>([
    [`new:${path}`, doc.modelBuffer],
    [`old:${path}`, oldBuf],
  ]);
  const pv = new ProjectionView(dmb.items, sources);
  return { path, doc, oldBuf, pv };
}

test('editing a context/added row writes through to the live new-side Document', () => {
  const { path, doc, pv } = setup('a\nb\nc\n', 'a\nX\nc\n');
  // view rows: 0 header, 1 a(ctx), 2 b(removed), 3 X(added), 4 c(ctx), 5 ""(ctx)
  const aRow = pv.view.screenRowForDocument(`new:${path}`, 0)!; // the `a` context line (new row 0)
  insertAtRow(pv.buffer, aRow, 'Z');
  assert.equal(doc.getText(), 'Za\nX\nc\n', 'edit wrote through to the live Document model');
  assert.equal((textOf(pv.buffer) as string).split('\n')[aRow], 'Za', 'and shows in the diff view');
});

test('editing a removed (phantom old-side) row is rejected — the base blob is read-only', () => {
  const { path, doc, oldBuf, pv } = setup('a\nb\nc\n', 'a\nX\nc\n');
  const bRow = pv.view.screenRowForDocument(`old:${path}`, 1)!; // removed `b` (old row 1)
  insertAtRow(pv.buffer, bRow, 'Q');
  assert.equal(textOf(oldBuf), 'a\nb\nc\n', 'base blob unchanged');
  assert.equal(doc.getText(), 'a\nX\nc\n', 'new-side Document unchanged');
});

test('the ProjectionView coordinates undo of a diff edit', () => {
  const { path, doc, pv } = setup('a\nb\nc\n', 'a\nX\nc\n');
  const xRow = pv.view.screenRowForDocument(`new:${path}`, 1)!; // the added `X` (new row 1)
  pv.beginUserAction();
  insertAtRow(pv.buffer, xRow, 'YY');
  pv.endUserAction();
  assert.equal(doc.getText(), 'a\nYYX\nc\n', 'edit applied to the new side');
  assert.equal(pv.canUndo(), true);
  pv.undo();
  assert.equal(doc.getText(), 'a\nX\nc\n', 'undo reverted the new-side Document');
});
