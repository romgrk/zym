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

test('widget mode: one EMPTY navigable header row per file; gaps stay anchor bands', () => {
  // Two changes far apart so the unchanged middle elides to a `⋯` gap between two windows.
  const mid = Array.from({ length: 10 }, (_, i) => `u${i}`).join('\n');
  const oldText = `t0\nXXX\nt2\n${mid}\nb0\nYYY\nb2\n`;
  const newText = `t0\nAAA\nt2\n${mid}\nb0\nBBB\nb2\n`;
  const dmb = buildDiffMultiBuffer([{ path: '/a.ts', oldText, newText }], undefined, { headers: 'widget' });
  // The header row exists (a navigable caret target) but is EMPTY — and no gap/blank rows.
  assert.equal(dmb.rowKinds[0], 'header', 'the file leads with a header block row');
  assert.equal((dmb.items[0] as any).block.text, '', 'the header row carries no text (copy-clean)');
  assert.ok(!dmb.rowKinds.includes('gap') && !dmb.rowKinds.includes('blank'), 'no gap/blank rows in widget mode');
  const p = project(dmb);
  assert.ok(!p.screenText.includes('unchanged'), 'the `⋯ unchanged lines` gap is not buffer text');
  assert.ok(!p.screenText.includes('a.ts'), 'the filename is a widget, not buffer text');
  assert.equal(dmb.headerAnchors.length, 1);
  assert.equal(dmb.headerAnchors[0].viewRow, 0, 'header anchors at its own (first) row');
  assert.equal(dmb.headerAnchors[0].added, 2, 'two added lines');
  assert.equal(dmb.headerAnchors[0].removed, 2, 'two removed lines');
  assert.equal(dmb.gapAnchors.length, 1, 'one between-window gap, as an anchor band');
  assert.match(dmb.gapAnchors[0].label, /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/, 'gap carries the following hunk\'s git `@@ … @@` header');
});

test('widget mode: a collapsed file contributes only its header row', () => {
  const files = [
    { path: '/a.ts', oldText: 'a\nb\nc\n', newText: 'a\nX\nc\n' },
    { path: '/b.ts', oldText: 'p\nq\n', newText: 'p\nQ\n' },
  ];
  const collapsed = buildDiffMultiBuffer(files, undefined, { headers: 'widget', collapsed: (p) => p === '/a.ts' });
  // a.ts collapsed → a single (empty) header row; b.ts expanded → header + its diff rows.
  assert.equal(collapsed.rowKinds[0], 'header', 'a.ts header row');
  assert.equal(collapsed.rowKinds[1], 'header', 'next row is b.ts header — a.ts emitted nothing else');
  assert.equal(collapsed.headerAnchors.length, 2, 'both files still have a header anchor');
  assert.equal(collapsed.headerAnchors[0].viewRow, 0);
  assert.equal(collapsed.headerAnchors[1].viewRow, 1, 'b.ts header directly follows the collapsed a.ts');
  // Expanding a.ts grows the view (its diff rows reappear).
  const expanded = buildDiffMultiBuffer(files, undefined, { headers: 'widget' });
  assert.ok(expanded.rowKinds.length > collapsed.rowKinds.length, 'collapse shrinks the row count');
});

test('widget mode: autoCollapseAtLines folds a big file inline, leaves a small one expanded', () => {
  const big = { path: '/big.ts', oldText: 'o0\no1\no2\no3\no4\no5\n', newText: 'n0\nn1\nn2\nn3\nn4\nn5\n' }; // 6 del + 6 ins = 12
  const small = { path: '/small.ts', oldText: 'p\nq\n', newText: 'p\nQ\n' }; // 1 del + 1 ins = 2
  const files = [big, small];
  const dmb = buildDiffMultiBuffer(files, undefined, { headers: 'widget', autoCollapseAtLines: 10 });
  assert.equal(dmb.headerAnchors[0].added + dmb.headerAnchors[0].removed, 12, 'big.ts change is 12 lines (≥ threshold)');
  // big.ts folds inline → its header is immediately followed by small.ts's header (it emitted nothing else).
  assert.equal(dmb.rowKinds[0], 'header', 'big.ts header row');
  assert.equal(dmb.rowKinds[1], 'header', 'small.ts header directly follows — big.ts folded to header-only');
  // small.ts (2 lines < 10) stays expanded: it contributes diff rows after its header.
  assert.ok(dmb.rowKinds.length > 2, 'small.ts is still expanded');
  // Threshold not met / disabled → nothing folds (both expand).
  const none = buildDiffMultiBuffer(files, undefined, { headers: 'widget', autoCollapseAtLines: 100 });
  assert.ok(none.rowKinds.length > dmb.rowKinds.length, 'a higher threshold folds nothing, so more rows');
  const off = buildDiffMultiBuffer(files, undefined, { headers: 'widget', autoCollapseAtLines: 0 });
  assert.equal(off.rowKinds.length, none.rowKinds.length, '0 disables auto-fold (same as no fold)');
});

test('widget mode: an elided file head is its OWN `above` gap band (split from the header)', () => {
  // Change far from the top so the head elides into a LEADING gap.
  const head = Array.from({ length: 8 }, (_, i) => `h${i}`).join('\n');
  const dmb = buildDiffMultiBuffer([{ path: '/a.ts', oldText: `${head}\nOLD\n`, newText: `${head}\nNEW\n` }], undefined, { headers: 'widget' });
  const leading = dmb.gapAnchors.find((g) => g.placement === 'above');
  assert.ok(leading, 'the elided head is a separate `above` gap band, not a header subtitle');
  assert.equal(leading!.fromTop, false, 'a click reveals from the bottom (toward the content below)');
  assert.equal((dmb.items[0] as any).block.text, '', 'the header row stays empty (no folded gap text)');
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

test('intra-line word diff: the changed token of a modified line gets word ranges', () => {
  // `const x = 1;` → `const y = 1;` — only the `x`/`y` token (cols 6..7) changed.
  const dmb = buildDiffMultiBuffer([{ path: '/a.ts', oldText: 'const x = 1;\n', newText: 'const y = 1;\n' }]);
  const removed = dmb.rowKinds.indexOf('removed');
  const added = dmb.rowKinds.indexOf('added');
  assert.deepEqual(dmb.wordRanges[removed], [[6, 7]], 'the `x` token is the changed span on the removed side');
  assert.deepEqual(dmb.wordRanges[added], [[6, 7]], 'the `y` token is the changed span on the added side');
  assert.equal(dmb.wordRanges[dmb.rowKinds.indexOf('context')], null, 'unchanged rows carry no word ranges');
  assert.equal(dmb.wordRanges.length, dmb.rowKinds.length, 'one word-range slot per view row');
});

test('intra-line word diff: a wholesale line replacement gets none (the line background suffices)', () => {
  const dmb = buildDiffMultiBuffer([{ path: '/a.ts', oldText: 'aaa\n', newText: 'bbb\n' }]);
  assert.equal(dmb.wordRanges[dmb.rowKinds.indexOf('removed')], null, 'no shared content → no word span');
  assert.equal(dmb.wordRanges[dmb.rowKinds.indexOf('added')], null);
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
  assert.equal(gap.block.text, '⋯'); // a TRAILING gap (no hunk follows) — git prints nothing, we show `⋯`
});
