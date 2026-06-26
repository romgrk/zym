/*
 * SourceLineNumberGutter label logic — the pure core of the per-excerpt line-number gutter
 * (docs/text-editor/multibuffer.md). A multibuffer view row maps to a SOURCE line (or to a
 * synthesized header/gap/blank row); `lineNumberLabel` must render `documentRow + 1` for real
 * rows and all-blank for block rows, right-aligned to the column width. The GtkSource renderer
 * itself is display-only (verified in the app); this pins the math.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk } from '../gi.ts';
import { CoordinatesMap } from './TextEditor/CoordinatesMap.ts';
import { excerptsToItems, type Excerpt } from './multibuffer/MultiBufferModel.ts';
import { lineNumberLabel } from './SourceLineNumberGutter.ts';

Gtk.init();

const seg = (documentKey: string, startRow: number, endRow: number) =>
  ({ documentKey, startRow, endRow, editable: false, kind: 'real' as const });

test('line-number gutter: source rows show documentRow+1; block rows are blank', () => {
  // Two files. a.ts rows 0..2 shown; b.ts rows 5..6 shown (so the labels are 6,7, not 1,2).
  const lines: Record<string, string[]> = {
    'a.ts': ['a0', 'a1', 'a2', ''],
    'b.ts': ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', ''],
  };
  const excerpts: Excerpt[] = [
    { header: 'a.ts', segments: [seg('a.ts', 0, 2)] },
    { header: 'b.ts', segments: [seg('b.ts', 5, 6)] },
  ];
  const projection = CoordinatesMap.build(excerptsToItems(excerpts), (s) => lines[s.documentKey].slice(s.startRow, s.endRow + 1));
  // View: 0:hdrA 1:a0 2:a1 3:a2 4:<blank> 5:hdrB 6:b5 7:b6
  const labels = Array.from({ length: 8 }, (_, row) => lineNumberLabel(projection, row, 1));
  assert.deepEqual(labels, [' ', '1', '2', '3', ' ', ' ', '6', '7'], 'numbers track the source rows; blocks blank');
});

test('line-number gutter: labels are right-aligned to the column width', () => {
  const lines: Record<string, string[]> = { f: Array.from({ length: 12 }, (_, i) => `r${i}`) };
  const excerpts: Excerpt[] = [{ header: 'f', segments: [seg('f', 8, 10)] }]; // rows show 9,10,11
  const projection = CoordinatesMap.build(excerptsToItems(excerpts), (s) => lines[s.documentKey].slice(s.startRow, s.endRow + 1));
  // View: 0:hdr 1:r8 2:r9 3:r10 — width 2 (max line number 11/12 → 2 digits)
  assert.equal(lineNumberLabel(projection, 0, 2), '  ', 'header → two blanks');
  assert.equal(lineNumberLabel(projection, 1, 2), ' 9', 'single digit padded to width 2');
  assert.equal(lineNumberLabel(projection, 3, 2), '11', 'two digits fill the width');
});

test('line-number gutter: a gap row between non-adjacent segments of one file is blank', () => {
  const lines: Record<string, string[]> = { f: Array.from({ length: 10 }, (_, i) => `r${i}`) };
  const excerpts: Excerpt[] = [{ header: 'f', segments: [seg('f', 0, 1), seg('f', 5, 6)] }];
  const projection = CoordinatesMap.build(excerptsToItems(excerpts), (s) => lines[s.documentKey].slice(s.startRow, s.endRow + 1));
  // View: 0:hdr 1:r0 2:r1 3:⋯(gap) 4:r5 5:r6
  assert.equal(lineNumberLabel(projection, 3, 1), ' ', 'gap row blank');
  assert.equal(lineNumberLabel(projection, 4, 1), '6', 'first row after the gap is source row 5 → label 6');
});
