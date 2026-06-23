import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excerptsToItems, GAP_LABEL, type Excerpt, type Segment } from './MultiBufferModel.ts';
import { ViewProjection } from '../TextEditor/ViewProjection.ts';

// The excerpt LAYOUT (header / segment / gap / blank) composed with the unified
// ViewProjection coordinate substrate — no GTK. The coordinate math itself is covered by
// ViewProjection.test.ts; here we check the multibuffer's item layout + that it resolves
// view rows back to sources (the place a stitched coordinate bug must surface).

const FILES: Record<string, string[]> = {
  'a.ts': ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6'],
  'b.ts': ['B0', 'B1', 'B2'],
};
const resolve = (s: Segment): string[] => FILES[s.documentKey].slice(s.startRow, s.endRow + 1);
const seg = (documentKey: string, startRow: number, endRow: number): Segment =>
  ({ documentKey, startRow, endRow, editable: false, kind: 'real' });
const build = (excerpts: Excerpt[]): ViewProjection => ViewProjection.build(excerptsToItems(excerpts), resolve);

test('single excerpt, single segment: text + row mapping', () => {
  const p = build([{ header: 'a.ts', segments: [seg('a.ts', 1, 3)] }]);
  assert.equal(p.screenText, 'a.ts\nl1\nl2\nl3', 'header + the 3 source rows');
  assert.equal(p.screenRowCount, 4);
  assert.equal(p.screenToDocument(0, 0).kind, 'block', 'row 0 is the header');
  assert.deepEqual(p.documentRowAtScreenRow(1), { documentKey: 'a.ts', documentRow: 1 }, 'row 1 → source row 1');
  assert.deepEqual(p.documentRowAtScreenRow(3), { documentKey: 'a.ts', documentRow: 3 });
  assert.equal(p.screenRowForDocument('a.ts', 2), 2, 'source row 2 shown at view row 2');
  assert.equal(p.screenRowForDocument('a.ts', 6), null, 'a source row outside the segment is not shown');
});

test('multiple segments of one file get a gap row between them', () => {
  const p = build([{ header: 'a.ts', segments: [seg('a.ts', 0, 1), seg('a.ts', 4, 5)] }]);
  assert.equal(p.screenText, `a.ts\nl0\nl1\n${GAP_LABEL}\nl4\nl5`); // header, l0, l1, ⋯, l4, l5
  assert.equal(p.screenToDocument(3, 0).kind, 'block', 'the gap row is not a source row');
  assert.deepEqual(p.documentRowAtScreenRow(4), { documentKey: 'a.ts', documentRow: 4 }, 'the second segment resumes at row 4');
  assert.equal(p.screenRowForDocument('a.ts', 4), 4);
});

test('multiple excerpts get a blank separator row and per-file headers', () => {
  const p = build([
    { header: 'a.ts', segments: [seg('a.ts', 0, 0)] },
    { header: 'b.ts', segments: [seg('b.ts', 1, 2)] },
  ]);
  assert.equal(p.screenText, 'a.ts\nl0\n\nb.ts\nB1\nB2'); // a.ts, l0, <blank>, b.ts, B1, B2
  assert.equal(p.screenToDocument(2, 0).kind, 'block', 'blank separator');
  assert.equal(p.screenToDocument(3, 0).kind, 'block', 'b.ts header');
  assert.deepEqual(p.documentRowAtScreenRow(4), { documentKey: 'b.ts', documentRow: 1 });
  assert.equal(p.screenRowForDocument('b.ts', 2), 5);
});

test('blockRows reports each header / gap / blank at its view row', () => {
  const p = build([
    { header: 'a.ts', segments: [seg('a.ts', 0, 1), seg('a.ts', 4, 4)] },
    { header: 'b.ts', segments: [seg('b.ts', 0, 0)] },
  ]);
  // 0:header 1:l0 2:l1 3:gap 4:l4 5:blank 6:header 7:B0
  assert.deepEqual(p.blockRows(), [
    { screenRow: 0, kind: 'header' },
    { screenRow: 3, kind: 'gap' },
    { screenRow: 5, kind: 'blank' },
    { screenRow: 6, kind: 'header' },
  ]);
});

test('segmentRunsInScreenRange returns the source runs overlapping the visible rows', () => {
  const p = build([
    { header: 'a.ts', segments: [seg('a.ts', 0, 2)] }, // view rows 1..3
    { header: 'b.ts', segments: [seg('b.ts', 0, 2)] }, // view rows 6..8
  ]);
  assert.deepEqual(
    p.segmentRunsInScreenRange(0, 3).map((r) => r.documentKey),
    ['a.ts'],
    'only a.ts overlaps the top rows',
  );
  assert.deepEqual(p.segmentRunsInScreenRange(6, 8).map((r) => r.documentKey), ['b.ts']);
  assert.deepEqual(
    p.segmentRunsInScreenRange(3, 6).map((r) => r.documentKey),
    ['a.ts', 'b.ts'],
    'a range straddling the gap returns both',
  );
  // A run carries the source span + the view row it starts at.
  assert.deepEqual(p.segmentRunsInScreenRange(1, 3)[0], {
    documentKey: 'a.ts',
    fromDocumentRow: 0,
    toDocumentRow: 2,
    screenStart: 1,
  });
});

test('editability reflects the segment flag', () => {
  const ro = build([{ header: 'a.ts', segments: [seg('a.ts', 0, 0)] }]);
  assert.equal(ro.isScreenPositionEditable(1, 0), false, 'read-only segment row');
  assert.equal(ro.isScreenPositionEditable(0, 0), false, 'header row');
  const editable: Segment = { documentKey: 'a.ts', startRow: 0, endRow: 0, editable: true, kind: 'real' };
  const rw = build([{ header: 'a.ts', segments: [editable] }]);
  assert.equal(rw.isScreenPositionEditable(1, 0), true, 'an editable real segment row');
});

test('widget-header mode emits ONLY segments (headers + gaps are widgets, not buffer rows)', () => {
  const items = excerptsToItems(
    [
      { header: 'a.ts', segments: [seg('a.ts', 0, 1), seg('a.ts', 4, 4)] },
      { header: 'b.ts', segments: [seg('b.ts', 0, 0)] },
    ],
    { headers: 'widget' },
  );
  // No 'header'/'blank'/'gap' blocks — the surface draws each as a widget band. Only real segments.
  assert.deepEqual(
    items.map((i) => (i.type === 'block' ? `block:${i.block.kind}` : `seg:${i.segment.startRow}`)),
    ['seg:0', 'seg:4', 'seg:0'],
  );
  const p = ViewProjection.build(items, resolve);
  assert.equal(p.screenText, 'l0\nl1\nl4\nB0'); // l0, l1, l4, B0 — no headers/blank/gap rows
  assert.deepEqual(p.documentRowAtScreenRow(0), { documentKey: 'a.ts', documentRow: 0 }, 'first row is a source row, not a header');
});

test('empty excerpt list yields empty text', () => {
  assert.deepEqual(excerptsToItems([]), []);
  const p = ViewProjection.build([], resolve);
  assert.equal(p.screenText, '');
  assert.equal(p.screenRowCount, 0);
});
