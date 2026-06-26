/*
 * diffMultiBuffer tests (Phase 3b / G5 foundation) — pure, no GTK. Assembles a continuous
 * multi-file diff into CoordinatesMap items + per-row diff kinds, composed with the unified
 * CoordinatesMap to prove interleaving, editability (new editable / removed phantom), and the
 * row-kind alignment the surface uses for decorations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiffMultiBuffer } from './diffMultiBuffer.ts';
import { CoordinatesMap, type Segment } from '../TextEditor/CoordinatesMap.ts';

function project(dmb: ReturnType<typeof buildDiffMultiBuffer>): CoordinatesMap {
  return CoordinatesMap.build(dmb.items, (s: Segment) => dmb.sources.get(s.documentKey)!.slice(s.startRow, s.endRow + 1));
}

test('widget mode: no header/blank/gap block rows — headers + gaps are anchors, not buffer text', () => {
  // Two changes far apart so the unchanged middle elides to a `⋯` gap between two windows.
  const mid = Array.from({ length: 10 }, (_, i) => `u${i}`).join('\n');
  const oldText = `t0\nXXX\nt2\n${mid}\nb0\nYYY\nb2\n`;
  const newText = `t0\nAAA\nt2\n${mid}\nb0\nBBB\nb2\n`;
  const dmb = buildDiffMultiBuffer([{ path: '/a.ts', oldText, newText }], undefined, { headers: 'widget' });
  assert.ok(!dmb.rowKinds.includes('header') && !dmb.rowKinds.includes('gap') && !dmb.rowKinds.includes('blank'),
    'no header/gap/blank rows in widget mode');
  const p = project(dmb);
  assert.ok(!p.screenText.includes('unchanged'), 'the `⋯ unchanged lines` gap is not buffer text');
  assert.equal(dmb.headerAnchors.length, 1);
  assert.equal(dmb.headerAnchors[0].viewRow, 0, 'header anchors above the first content row');
  assert.equal(dmb.gapAnchors.length, 1, 'one between-window gap, as an anchor band');
  assert.ok(dmb.gapAnchors[0].label.includes('unchanged'), 'gap carries its `⋯ N unchanged lines` label');
});

test('reveal forces elided rows visible (expand-context)', () => {
  const mid = Array.from({ length: 12 }, (_, i) => `u${i}`).join('\n');
  const file = { path: '/a.ts', oldText: `X\n${mid}\nY\n`, newText: `A\n${mid}\nB\n` };
  const collapsed = buildDiffMultiBuffer([file], undefined, { headers: 'widget' });
  const gapRows = collapsed.gapAnchors[0].revealRows;
  assert.ok(gapRows.length > 0, 'the unchanged middle elides to a gap');
  const expanded = buildDiffMultiBuffer([file], undefined, { headers: 'widget', reveal: (r) => gapRows.slice(0, 3).includes(r) });
  assert.ok(project(expanded).screenText.length > project(collapsed).screenText.length, 'revealing rows grows the view');
  assert.ok(expanded.gapAnchors[0].revealRows.length < gapRows.length, 'and shrinks the remaining gap');
});

test('single-file diff: header + context/added/removed rows, kinds aligned', () => {
  const dmb = buildDiffMultiBuffer([{ path: '/a.ts', oldText: 'a\nb\nc\n', newText: 'a\nX\nc\n' }]);
  const p = project(dmb);
  // rows: 0:a.ts(header) 1:a(ctx) 2:b(removed) 3:X(added) 4:c(ctx) 5:""(ctx, trailing)
  assert.equal(p.screenText, 'a.ts\na\nb\nX\nc\n');
  assert.deepEqual(dmb.rowKinds, ['header', 'context', 'removed', 'added', 'context', 'context']);
  // removed line maps to the OLD source (read-only phantom); added/context to the NEW source.
  assert.equal(p.isScreenPositionEditable(2, 0), false, 'removed line is a read-only phantom');
  assert.equal(p.isScreenPositionEditable(3, 0), true, 'added line is editable (new side)');
  assert.deepEqual(p.documentRowAtScreenRow(2), { documentKey: 'old:/a.ts', documentRow: 1 }, 'removed `b` from old blob');
  assert.deepEqual(p.documentRowAtScreenRow(3), { documentKey: 'new:/a.ts', documentRow: 1 }, 'added `X` from new');
});

test('per-row old/new line numbers (for the gutters): blank where a side has no line', () => {
  const dmb = buildDiffMultiBuffer([{ path: '/a.ts', oldText: 'a\nb\nc\n', newText: 'a\nX\nc\n' }]);
  // rows: header, a(ctx), b(removed), X(added), c(ctx), ""(ctx)
  assert.deepEqual(dmb.oldNums, [null, 1, 2, null, 3, 4], 'removed has an old line; added has none');
  assert.deepEqual(dmb.newNums, [null, 1, null, 2, 3, 4], 'added has a new line; removed has none');
});

test('multi-file diff: blank separator + per-file headers, kinds aligned across files', () => {
  const dmb = buildDiffMultiBuffer([
    { path: '/a.ts', oldText: 'x\n', newText: 'x\ny\n' }, // add a line
    { path: '/b.ts', oldText: 'p\nq\n', newText: 'q\n' }, // remove a line
  ]);
  const p = project(dmb);
  // a.ts: header, x(ctx), y(added), ""(ctx)   blank   b.ts: header, p(removed), q(ctx), ""(ctx)
  assert.equal(p.screenText, 'a.ts\nx\ny\n\n\nb.ts\np\nq\n');
  assert.deepEqual(dmb.rowKinds, [
    'header', 'context', 'added', 'context',
    'blank',
    'header', 'removed', 'context', 'context',
  ]);
  assert.equal(dmb.rowKinds.length, p.screenRowCount, 'one kind per view row');
  // the second file's removed `p` resolves to b.ts's old blob.
  assert.deepEqual(p.documentRowAtScreenRow(6), { documentKey: 'old:/b.ts', documentRow: 0 });
});

test('header label is relative to cwd when given', () => {
  const dmb = buildDiffMultiBuffer([{ path: '/repo/src/a.ts', oldText: 'a\n', newText: 'b\n' }], '/repo');
  assert.equal((dmb.items[0] as any).block.text, 'src/a.ts');
});

test('a file with no text change is skipped entirely (no dead `⋯ unchanged` entry)', () => {
  const dmb = buildDiffMultiBuffer([{ path: '/a.ts', oldText: 'a\nb\n', newText: 'a\nb\n' }]);
  assert.deepEqual(dmb.items, [], 'no header, no gap — the unchanged file produces nothing');
  assert.deepEqual(dmb.rowKinds, []);
});

test('stagedState is null on every row when no index blob is supplied', () => {
  const dmb = buildDiffMultiBuffer([{ path: '/a.ts', oldText: 'a\nb\nc\n', newText: 'a\nX\nc\n' }]);
  assert.equal(dmb.stagedState.length, dmb.rowKinds.length, 'one staged-state per row');
  assert.ok(dmb.stagedState.every((s) => s === null), 'no classification without an index');
});

test('stagedState: addition already in the index reads staged, not-yet in index reads unstaged', () => {
  // HEAD has neither X nor Y; the index has only X staged; the worktree adds both.
  const dmb = buildDiffMultiBuffer([
    { path: '/a.ts', oldText: 'a\nc\n', indexText: 'a\nX\nc\n', newText: 'a\nX\nY\nc\n' },
  ]);
  // rows: header, a(ctx), X(added→staged), Y(added→unstaged), c(ctx), ""(ctx)
  assert.deepEqual(dmb.rowKinds, ['header', 'context', 'added', 'added', 'context', 'context']);
  assert.deepEqual(dmb.stagedState, [null, null, 'staged', 'unstaged', null, null]);
});

test('stagedState: deletion gone from the index reads staged, still in index reads unstaged', () => {
  // HEAD has b and d; the index has dropped b (staged delete) but kept d; worktree drops both.
  const dmb = buildDiffMultiBuffer([
    { path: '/a.ts', oldText: 'a\nb\nd\ne\n', indexText: 'a\nd\ne\n', newText: 'a\ne\n' },
  ]);
  // rows: header, a(ctx), b(removed→staged), d(removed→unstaged), e(ctx), ""(ctx)
  assert.deepEqual(dmb.rowKinds, ['header', 'context', 'removed', 'removed', 'context', 'context']);
  assert.deepEqual(dmb.stagedState, [null, null, 'staged', 'unstaged', null, null]);
});

test('stagedState: untracked file (empty HEAD+index) is all-unstaged; fully-staged reads staged', () => {
  const unstaged = buildDiffMultiBuffer([{ path: '/n.ts', oldText: '', indexText: '', newText: 'x\ny\n' }]);
  assert.ok(unstaged.stagedState.filter((s) => s !== null).every((s) => s === 'unstaged'));
  const staged = buildDiffMultiBuffer([{ path: '/n.ts', oldText: '', indexText: 'x\ny\n', newText: 'x\ny\n' }]);
  assert.ok(staged.stagedState.filter((s) => s !== null).every((s) => s === 'staged'));
});

test('long unchanged runs are elided to a ⋯ gap; the change + context stay', () => {
  const base = Array.from({ length: 22 }, (_, i) => `L${i}`);
  const oldText = base.join('\n') + '\n';
  const changed = [...base];
  changed[1] = 'CHANGED';
  const newText = changed.join('\n') + '\n';
  const dmb = buildDiffMultiBuffer([{ path: '/a.ts', oldText, newText }]);
  // header, L0(ctx), L1-old(removed), L1-new(added), L2/L3/L4(ctx), then the rest elided.
  assert.deepEqual(dmb.rowKinds, ['header', 'context', 'removed', 'added', 'context', 'context', 'context', 'gap']);
  const gap = dmb.items[dmb.items.length - 1] as { type: 'block'; block: { kind: string; text: string } };
  assert.equal(gap.block.kind, 'gap');
  assert.match(gap.block.text, /^⋯ \d+ unchanged lines$/);
});
