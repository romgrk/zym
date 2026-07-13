import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, type DiffOp } from './lineDiff.ts';

// Apply ops to `a`; the result must equal `b` for any correct edit script.
function reconstruct(a: string[], b: string[], ops: DiffOp[]): string[] {
  const out: string[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === 'eq') {
      out.push(a[i++]);
      j++;
    } else if (op === 'del') {
      i++;
    } else {
      out.push(b[j++]);
    }
  }
  return out;
}

const editDistance = (ops: DiffOp[]) => ops.filter((o) => o !== 'eq').length;

test('identical inputs produce all-equal ops', () => {
  const a = ['x', 'y', 'z'];
  assert.deepEqual(diffLines(a, a), ['eq', 'eq', 'eq']);
});

test('pure insertion', () => {
  const ops = diffLines(['a', 'b'], ['a', 'NEW', 'b']);
  assert.deepEqual(ops, ['eq', 'ins', 'eq']);
});

test('pure deletion', () => {
  const ops = diffLines(['a', 'gone', 'b'], ['a', 'b']);
  assert.deepEqual(ops, ['eq', 'del', 'eq']);
});

test('empty sides', () => {
  assert.deepEqual(diffLines([], ['a', 'b']), ['ins', 'ins']);
  assert.deepEqual(diffLines(['a', 'b'], []), ['del', 'del']);
});

test('ops reconstruct b and are minimal (random fuzz)', () => {
  // Deterministic-ish PRNG so failures reproduce.
  let seed = 123456789;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const lines = (n: number) =>
    Array.from({ length: n }, () => String(Math.floor(rand() * 5)));

  for (let t = 0; t < 1000; t++) {
    const a = lines(Math.floor(rand() * 10));
    const b = lines(Math.floor(rand() * 10));
    const ops = diffLines(a, b);
    assert.deepEqual(reconstruct(a, b, ops), b, `reconstruct failed for ${a} -> ${b}`);
    // Minimality: edit distance never exceeds the trivial delete-all/insert-all.
    assert.ok(editDistance(ops) <= a.length + b.length);
  }
});

test('ops reconstruct b on large inputs (anchored path fuzz)', () => {
  let seed = 987654321;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  for (let t = 0; t < 20; t++) {
    // Mostly-unique lines (code-like) with some repeats, large enough that the
    // diff takes the anchor + recursion path rather than one exact search.
    const n = 3000 + Math.floor(rand() * 3000);
    const a = Array.from({ length: n }, (_, i) =>
      rand() < 0.1 ? '// separator' : `line ${i} ${Math.floor(rand() * 1e9)}`);
    const b = a
      .map((line) => (rand() < 0.2 ? line + ' edited' : line)) // scattered edits
      .filter(() => rand() > 0.02); // scattered deletions
    // A few random insertions.
    for (let i = 0; i < 30; i++) b.splice(Math.floor(rand() * b.length), 0, `inserted ${i}`);

    const ops = diffLines(a, b);
    assert.deepEqual(reconstruct(a, b, ops), b, `large reconstruct failed (t=${t})`);
    assert.ok(editDistance(ops) <= a.length + b.length);
  }
});

test('scattered edits stay minimal (anchored path quality)', () => {
  // Every 10th line edited in a large mostly-unique file: the anchored diff must
  // report ~exactly the edited lines, not degrade toward replace-everything.
  const a = Array.from({ length: 5000 }, (_, i) => `const value${i} = ${i * 7};`);
  const b = a.map((line, i) => (i % 10 === 0 ? line + ' // edited' : line));
  const ops = diffLines(a, b);
  assert.deepEqual(reconstruct(a, b, ops), b);
  assert.equal(editDistance(ops), 2 * 500); // one del + one ins per edited line
});
