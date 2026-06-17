import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRowMap, computeHunks, formatHunkPatch, hunkContainsBufferRow } from './hunkPatch.ts';

test('computeHunks classifies modify / add / delete runs', () => {
  // base: a b c d ; target: a B c d e (modify line 1, add line 4)
  const hunks = computeHunks(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'd', 'e']);
  assert.deepEqual(hunks, [
    { oldStart: 1, oldLines: ['b'], newStart: 1, newLines: ['B'] },
    { oldStart: 4, oldLines: [], newStart: 4, newLines: ['e'] },
  ]);
});

test('computeHunks reports a pure deletion', () => {
  const hunks = computeHunks(['a', 'b', 'c'], ['a', 'c']);
  assert.deepEqual(hunks, [{ oldStart: 1, oldLines: ['b'], newStart: 1, newLines: [] }]);
});

test('formatHunkPatch emits a zero-context unified diff for a modify', () => {
  const [hunk] = computeHunks(['a', 'b', 'c'], ['a', 'B', 'c']);
  assert.equal(
    formatHunkPatch('src/x.ts', hunk),
    ['diff --git a/src/x.ts b/src/x.ts', '--- a/src/x.ts', '+++ b/src/x.ts', '@@ -2,1 +2,1 @@', '-b', '+B', ''].join('\n'),
  );
});

test('formatHunkPatch uses the before-line for an empty side', () => {
  // pure insertion after line 0 → old side is `-1,0`
  const [add] = computeHunks(['a'], ['a', 'b']);
  assert.match(formatHunkPatch('f', add), /@@ -1,0 \+2,1 @@/);
  // pure deletion of line 1 → new side is `+1,0`
  const [del] = computeHunks(['a', 'b'], ['a']);
  assert.match(formatHunkPatch('f', del), /@@ -2,1 \+1,0 @@/);
});

test('buildRowMap aligns base rows onto target rows across an insertion', () => {
  // base: a b c ; target: a X b c (insert X at row 1)
  const map = buildRowMap(['a', 'b', 'c'], ['a', 'X', 'b', 'c']);
  assert.deepEqual(map, [0, 2, 3]); // a→0, b→2, c→3
});

test('hunkContainsBufferRow covers the changed buffer rows and the deletion gap', () => {
  const modify: ReturnType<typeof computeHunks>[number] = { oldStart: 1, oldLines: ['b'], newStart: 1, newLines: ['B', 'C'] };
  assert.equal(hunkContainsBufferRow(modify, 1), true);
  assert.equal(hunkContainsBufferRow(modify, 2), true);
  assert.equal(hunkContainsBufferRow(modify, 3), false);

  const deletion: ReturnType<typeof computeHunks>[number] = { oldStart: 2, oldLines: ['x'], newStart: 2, newLines: [] };
  assert.equal(hunkContainsBufferRow(deletion, 1), true); // surviving line above
  assert.equal(hunkContainsBufferRow(deletion, 2), true);
  assert.equal(hunkContainsBufferRow(deletion, 0), false);
});
