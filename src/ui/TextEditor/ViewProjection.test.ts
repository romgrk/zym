/*
 * ViewProjection coordinate-substrate tests (Phase 2a, docs/text-editor/multibuffer.md).
 * Pure + GTK-free: the place a stitched-coordinate or fold-composition bug must surface in
 * isolation. Covers the three correctness pillars: (1) the single-file IDENTITY path, (2)
 * the multi-source segment map, (3) the fold transform composed on top — plus editability
 * gating and codepoint (astral) offset math.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ViewProjection, type Item } from './ViewProjection.ts';

const rowsOf = (text: string): string[] => text.split('\n');

/** A resolver over a fixed set of in-memory sources (documentKey → full text). */
function resolverFor(sources: Record<string, string>) {
  const rows: Record<string, string[]> = {};
  for (const [key, text] of Object.entries(sources)) rows[key] = rowsOf(text);
  return {
    rows,
    resolve: (seg: { documentKey: string; startRow: number; endRow: number }) =>
      rows[seg.documentKey].slice(seg.startRow, seg.endRow + 1),
  };
}

/** One full-file editable segment (the normal-editor degenerate case). */
function fileItem(documentKey: string, lastRow: number): Item {
  return { type: 'segment', segment: { documentKey, startRow: 0, endRow: lastRow, editable: true, kind: 'real' } };
}

// --- 1. single-file identity -------------------------------------------------

test('single full-file segment is the identity path', () => {
  const text = 'const x = 1;\nconst y = 2;\n';
  const { resolve, rows } = resolverFor({ 'f.ts': text });
  const p = ViewProjection.build([fileItem('f.ts', rows['f.ts'].length - 1)], resolve);

  assert.equal(p.isIdentity, true);
  assert.equal(p.bufferText, text, 'projection round-trips the file exactly');
  assert.equal(p.screenText, text);
  assert.equal(p.screenRowCount, 3); // "const x = 1;", "const y = 2;", ""

  // source ↔ view is identity (row + codepoint column pass through).
  assert.deepEqual(p.screenToDocument(0, 6), { kind: 'document', documentKey: 'f.ts', row: 0, column: 6, segmentIndex: 0 });
  assert.deepEqual(p.documentToScreen('f.ts', 1, 0), { row: 1, column: 0 });
  assert.equal(p.screenRowForDocument('f.ts', 1), 1);
  assert.equal(p.isScreenPositionEditable(1, 0), true);
  assert.equal(p.isScreenRangeEditable(0, 2), true);
});

test('identity projection rejects a foreign source key', () => {
  const { resolve, rows } = resolverFor({ 'f.ts': 'a\nb\n' });
  const p = ViewProjection.build([fileItem('f.ts', rows['f.ts'].length - 1)], resolve);
  assert.equal(p.documentToScreen('other.ts', 0, 0), null);
});

// --- 2. multi-source segment map ---------------------------------------------

test('multi-source projection maps each row to its source (and blocks)', () => {
  const a = '// a\nconst aaa = 1;\nfunction fa() {}\n';
  const b = 'const bbb = 2;\nlet ccc = 3;\n';
  const { resolve } = resolverFor({ 'a.ts': a, 'b.ts': b });
  const items: Item[] = [
    { type: 'block', block: { kind: 'header', text: 'a.ts' } },
    { type: 'segment', segment: { documentKey: 'a.ts', startRow: 1, endRow: 2, editable: false, kind: 'real' } },
    { type: 'block', block: { kind: 'blank', text: '' } },
    { type: 'block', block: { kind: 'header', text: 'b.ts' } },
    { type: 'segment', segment: { documentKey: 'b.ts', startRow: 0, endRow: 1, editable: false, kind: 'real' } },
  ];
  const p = ViewProjection.build(items, resolve);

  // 0:a.ts 1:const aaa 2:function fa 3:<blank> 4:b.ts 5:const bbb 6:let ccc
  assert.equal(p.isIdentity, false);
  assert.equal(p.bufferRowCount, 7);
  assert.equal(p.bufferText, 'a.ts\nconst aaa = 1;\nfunction fa() {}\n\nb.ts\nconst bbb = 2;\nlet ccc = 3;');

  assert.deepEqual(p.screenToDocument(0, 0), { kind: 'block', block: 'header' });
  assert.deepEqual(p.screenToDocument(3, 0), { kind: 'block', block: 'blank' });
  assert.equal(p.screenToDocument(1, 0).kind, 'document');
  assert.deepEqual(p.documentRowAtScreenRow(2), { documentKey: 'a.ts', documentRow: 2 });
  assert.deepEqual(p.documentRowAtScreenRow(6), { documentKey: 'b.ts', documentRow: 1 });
  assert.equal(p.documentRowAtScreenRow(4), null, 'a header row has no source');

  // The B excerpt's source rows 0,1 translate to view rows 5,6 — the coordinate map at work.
  assert.equal(p.screenRowForDocument('b.ts', 0), 5);
  assert.equal(p.screenRowForDocument('b.ts', 1), 6);
  assert.equal(p.bufferRowForDocument('a.ts', 2), 2);

  assert.deepEqual(p.blockRows(), [
    { screenRow: 0, kind: 'header' },
    { screenRow: 3, kind: 'blank' },
    { screenRow: 4, kind: 'header' },
  ]);
});

// --- 3. fold transform -------------------------------------------------------

test('a fold collapses projection rows into a placeholder and translates around it', () => {
  const text = 'L0\nL1\nL2\nL3\nL4\n';
  const { resolve, rows } = resolverFor({ f: text });
  const p = ViewProjection.build([fileItem('f', rows['f'].length - 1)], resolve);

  // Collapse rows 1..3 (L1,L2,L3) into "[3]". Projection offsets: row1 start = 3,
  // end of row3 content = 11 (L3 start 9 + len 2).
  const fold = p.addFold(3, 11, '[3]');
  assert.equal(p.isIdentity, false);
  assert.equal(p.screenText, 'L0\n[3]\nL4\n');
  assert.equal(p.screenRowCount, 4); // L0, [3], L4, ""

  // L4 (source row 4) is shown on view row 2; round-trips both ways.
  assert.deepEqual(p.screenToDocument(2, 0), { kind: 'document', documentKey: 'f', row: 4, column: 0, segmentIndex: 0 });
  assert.deepEqual(p.documentToScreen('f', 4, 0), { row: 2, column: 0 });

  // The placeholder row is "inside a fold" — no live source position.
  assert.deepEqual(p.screenToDocument(1, 0), { kind: 'fold' });
  assert.deepEqual(p.screenToDocument(1, 1), { kind: 'fold' });

  // A folded source row (L2) maps onto the placeholder's start.
  assert.deepEqual(p.documentToScreen('f', 2, 0), { row: 1, column: 0 });

  // Rows above the fold are untouched.
  assert.deepEqual(p.screenToDocument(0, 1), { kind: 'document', documentKey: 'f', row: 0, column: 1, segmentIndex: 0 });

  // Removing the fold restores identity.
  p.removeFold(fold!);
  assert.equal(p.isIdentity, true);
  assert.equal(p.screenText, text);
});

test('fold composes with the multi-source map', () => {
  const a = '// a\nconst aaa = 1;\nfunction fa() {}\n';
  const b = 'const bbb = 2;\nlet ccc = 3;\n';
  const { resolve } = resolverFor({ 'a.ts': a, 'b.ts': b });
  const items: Item[] = [
    { type: 'block', block: { kind: 'header', text: 'a.ts' } },
    { type: 'segment', segment: { documentKey: 'a.ts', startRow: 1, endRow: 2, editable: false, kind: 'real' } },
    { type: 'block', block: { kind: 'blank', text: '' } },
    { type: 'block', block: { kind: 'header', text: 'b.ts' } },
    { type: 'segment', segment: { documentKey: 'b.ts', startRow: 0, endRow: 1, editable: false, kind: 'real' } },
  ];
  const p = ViewProjection.build(items, resolve);

  // Collapse B's two body rows. Projection offset of b's first row (view row 5) = 43;
  // end of its last row's content = 70.
  assert.equal(p.screenRowForDocument('b.ts', 0), 5);
  p.addFold(43, 70, '[2]');

  assert.equal(p.screenText, 'a.ts\nconst aaa = 1;\nfunction fa() {}\n\nb.ts\n[2]');
  assert.deepEqual(p.screenToDocument(5, 0), { kind: 'fold' });
  // The A excerpt above the fold is unaffected.
  assert.deepEqual(p.documentRowAtScreenRow(1), { documentKey: 'a.ts', documentRow: 1 });
  // A folded B source row maps onto the placeholder row.
  assert.deepEqual(p.documentToScreen('b.ts', 0, 0), { row: 5, column: 0 });
  // Block rows still resolve (none were inside the fold).
  assert.deepEqual(p.blockRows(), [
    { screenRow: 0, kind: 'header' },
    { screenRow: 3, kind: 'blank' },
    { screenRow: 4, kind: 'header' },
  ]);
});

// --- 4. editability gating ---------------------------------------------------

test('editability gates blocks, phantoms, cross-source ranges, and folds', () => {
  const { resolve } = resolverFor({ f1: 'a\nb\n', f2: 'c\nd\n', base: 'old\n' });
  const items: Item[] = [
    { type: 'block', block: { kind: 'header', text: 'f1' } },
    { type: 'segment', segment: { documentKey: 'f1', startRow: 0, endRow: 1, editable: true, kind: 'real' } },
    // a diff "removed" row: real text from the base blob, but read-only.
    { type: 'segment', segment: { documentKey: 'base', startRow: 0, endRow: 0, editable: false, kind: 'phantom' } },
    { type: 'segment', segment: { documentKey: 'f2', startRow: 0, endRow: 1, editable: true, kind: 'real' } },
  ];
  const p = ViewProjection.build(items, resolve);
  // rows: 0:f1(header) 1:a 2:b 3:old(phantom) 4:c 5:d

  assert.equal(p.isScreenPositionEditable(0, 0), false, 'header block is not editable');
  assert.equal(p.isScreenPositionEditable(1, 0), true, 'f1 body is editable');
  assert.equal(p.isScreenPositionEditable(3, 0), false, 'phantom removed row is not editable');

  assert.equal(p.isScreenRangeEditable(1, 2), true, 'both f1 rows, one source');
  assert.equal(p.isScreenRangeEditable(1, 3), false, 'range hits the phantom row');
  assert.equal(p.isScreenRangeEditable(4, 5), true, 'both f2 rows, one source');
  assert.equal(p.isScreenRangeEditable(2, 4), false, 'range crosses phantom + sources');
});

test('an adjacent two-source range is not editable (would span sources)', () => {
  const { resolve } = resolverFor({ f1: 'a\nb\n', f2: 'c\nd\n' });
  const items: Item[] = [
    { type: 'segment', segment: { documentKey: 'f1', startRow: 0, endRow: 1, editable: true, kind: 'real' } },
    { type: 'segment', segment: { documentKey: 'f2', startRow: 0, endRow: 1, editable: true, kind: 'real' } },
  ];
  const p = ViewProjection.build(items, resolve); // rows: 0:a 1:b 2:c 3:d
  assert.equal(p.isScreenRangeEditable(0, 1), true, 'within f1');
  assert.equal(p.isScreenRangeEditable(2, 3), true, 'within f2');
  assert.equal(p.isScreenRangeEditable(1, 2), false, 'spans f1 → f2');
});

// --- 5. codepoint (astral) offset math ---------------------------------------

test('fold offsets are codepoint-accurate across astral characters', () => {
  // "x😀y" is 3 codepoints (😀 is one codepoint / two UTF-16 units). A header forces the
  // non-identity path so the fold offset math (cpLength) is actually exercised.
  const { resolve } = resolverFor({ s: 'x😀y\nz\n' });
  const items: Item[] = [
    { type: 'block', block: { kind: 'header', text: 'h' } },
    { type: 'segment', segment: { documentKey: 's', startRow: 0, endRow: 2, editable: true, kind: 'real' } },
  ];
  const p = ViewProjection.build(items, resolve);
  // rows: 0:"h" 1:"x😀y" 2:"z" 3:""  — projection offsets in codepoints: h@0, x😀y@2, z@6.

  // Column 3 on the astral row is *after* "y" (codepoints, not UTF-16 units).
  assert.deepEqual(p.screenToDocument(1, 3), { kind: 'document', documentKey: 's', row: 0, column: 3, segmentIndex: 0 });

  // Fold the astral row (projection offsets 2..5) → if cpLength were UTF-16 the range/offset
  // would be off by one and "z" would land on the wrong row.
  p.addFold(2, 5, '·');
  assert.equal(p.screenText, 'h\n·\nz\n');
  assert.deepEqual(p.documentToScreen('s', 1, 0), { row: 2, column: 0 }, '"z" stays on its row past the astral fold');
  assert.deepEqual(p.screenToDocument(1, 0), { kind: 'fold' });
});
