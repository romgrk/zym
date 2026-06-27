/*
 * wordDiff tests — the intra-line ("word-by-word") change spans + their display refinement.
 * Pure, no GTK.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeIntraLineDiff, refineWordRanges } from './wordDiff.ts';

test('computeIntraLineDiff: per-side changed spans + shared-content flag', () => {
  // `foo(bar` → `baz(qux`: foo→baz and bar→qux changed; the `(` is shared.
  const { oldRanges, newRanges, hasCommon } = computeIntraLineDiff('foo(bar', 'baz(qux');
  assert.equal(hasCommon, true, 'the common `(` counts as shared content');
  assert.deepEqual(oldRanges, [[0, 3], [4, 7]]);
  assert.deepEqual(newRanges, [[0, 3], [4, 7]]);
});

test('computeIntraLineDiff: a wholesale replacement shares nothing', () => {
  const { hasCommon } = computeIntraLineDiff('aaa', 'bbb');
  assert.equal(hasCommon, false);
});

test('refineWordRanges: bridges a lone unchanged punctuation char between two changes', () => {
  // `if (foo.bar)` → `if (baz.qux)`: foo→baz, bar→qux; the common `.` must not split the run.
  assert.deepEqual(refineWordRanges('if (baz.qux)', [[4, 7], [8, 11]]), [[4, 11]]);
});

test('refineWordRanges: does NOT bridge across a real unchanged word', () => {
  // `XXX bar YYY`: the unchanged `bar` is a meaningful token — keep the two spans apart.
  assert.deepEqual(refineWordRanges('XXX bar YYY', [[0, 3], [8, 11]]), [[0, 3], [8, 11]]);
});

test('refineWordRanges: whitespace-only margins promote to a full-line highlight', () => {
  // `  foo = 1` → `  bar = 2`: both sides changed, only indentation + ` = ` common → line highlight.
  assert.deepEqual(refineWordRanges('  bar = 2', [[2, 5], [8, 9]]), []);
});

test('refineWordRanges: a partial change keeps its word span (no promotion)', () => {
  // `const x = 1;` → `const y = 1;`: only the `y` token changed; the rest stays plain.
  assert.deepEqual(refineWordRanges('const y = 1;', [[6, 7]]), [[6, 7]]);
});

test('refineWordRanges: no ranges → nothing to paint', () => {
  assert.deepEqual(refineWordRanges('anything', []), []);
});
