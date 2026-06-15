import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeDiff, splitLines, splitSides } from './DiffModel.ts';

const kinds = (text: string, other: string) => computeDiff(text, other).lines.map((l) => `${l.kind[0]}:${l.text}`);

describe('splitLines', () => {
  it('treats a single trailing newline as a terminator', () => {
    assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
    assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
    assert.deepEqual(splitLines(''), []);
    assert.deepEqual(splitLines('a\n\n'), ['a', '']); // a genuine blank line is kept
  });
});

describe('computeDiff', () => {
  it('reports no changes and no hunks for identical text', () => {
    const model = computeDiff('a\nb\nc', 'a\nb\nc');
    assert.deepEqual(model.lines.map((l) => l.kind), ['context', 'context', 'context']);
    assert.deepEqual(model.hunks, []);
    assert.deepEqual(model.stats, { added: 0, removed: 0 });
  });

  it('marks added lines and tracks new rows', () => {
    const model = computeDiff('a\nc', 'a\nb\nc');
    assert.deepEqual(kinds('a\nc', 'a\nb\nc'), ['c:a', 'a:b', 'c:c']);
    assert.deepEqual(model.stats, { added: 1, removed: 0 });
    const added = model.lines.find((l) => l.kind === 'added')!;
    assert.equal(added.oldRow, null);
    assert.equal(added.newRow, 1);
  });

  it('marks removed lines and tracks old rows', () => {
    const model = computeDiff('a\nb\nc', 'a\nc');
    assert.deepEqual(model.lines.map((l) => l.kind), ['context', 'removed', 'context']);
    assert.deepEqual(model.stats, { added: 0, removed: 1 });
    const removed = model.lines.find((l) => l.kind === 'removed')!;
    assert.equal(removed.oldRow, 1);
    assert.equal(removed.newRow, null);
  });

  it('renders a modified line as a removed + added pair in one hunk', () => {
    const model = computeDiff('a\nB\nc', 'a\nb\nc');
    assert.deepEqual(model.lines.map((l) => l.kind), ['context', 'removed', 'added', 'context']);
    assert.equal(model.hunks.length, 1);
    assert.deepEqual(
      { start: model.hunks[0].startRow, count: model.hunks[0].rowCount, ...model.stats },
      { start: 1, count: 2, added: 1, removed: 1 },
    );
  });

  it('groups separate changed regions into separate hunks', () => {
    const model = computeDiff('a\nb\nc\nd\ne', 'a\nB\nc\nd\nE');
    assert.equal(model.hunks.length, 2);
    assert.equal(model.hunks[0].oldStart, 1); // 'b' → 'B'
    assert.equal(model.hunks[1].oldStart, 4); // 'e' → 'E'
  });

  it('handles whole-file insert and delete', () => {
    assert.deepEqual(computeDiff('', 'x\ny').lines.map((l) => l.kind), ['added', 'added']);
    assert.deepEqual(computeDiff('x\ny', '').lines.map((l) => l.kind), ['removed', 'removed']);
  });
});

describe('splitSides', () => {
  const sides = (a: string, b: string) => splitSides(computeDiff(a, b));

  it('keeps both panes equal length and aligns context', () => {
    const { left, right } = sides('a\nb\nc', 'a\nb\nc');
    assert.equal(left.length, right.length);
    assert.deepEqual(left.map((l) => l.text), ['a', 'b', 'c']);
    assert.deepEqual(right.map((l) => l.text), ['a', 'b', 'c']);
    assert.ok(left.every((l) => l.kind === 'context'));
  });

  it('pairs a modified line (removed left, added right) on the same row', () => {
    const { left, right } = sides('a\nB\nc', 'a\nb\nc');
    assert.deepEqual(left.map((l) => `${l.kind[0]}:${l.text}`), ['c:a', 'r:B', 'c:c']);
    assert.deepEqual(right.map((l) => `${l.kind[0]}:${l.text}`), ['c:a', 'a:b', 'c:c']);
  });

  it('pads the shorter side of an uneven change with fillers', () => {
    // old has one line, new has two → right gains a line; left pads with a filler.
    const { left, right } = sides('a\nx\nb', 'a\nx1\nx2\nb');
    assert.equal(left.length, right.length);
    const change = left.findIndex((l) => l.kind !== 'context');
    assert.equal(left[change].kind, 'removed'); // 'x'
    assert.equal(left[change + 1].kind, 'filler'); // pad for the extra new line
    assert.equal(right[change].kind, 'added');
    assert.equal(right[change + 1].kind, 'added');
  });

  it('pure insert pads the left side', () => {
    const { left, right } = sides('a\nc', 'a\nb\nc');
    assert.deepEqual(left.map((l) => l.kind), ['context', 'filler', 'context']);
    assert.deepEqual(right.map((l) => l.kind), ['context', 'added', 'context']);
  });
});
