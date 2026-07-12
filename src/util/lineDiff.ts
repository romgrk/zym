/*
 * lineDiff — a minimal line-level diff (Myers' O(ND) algorithm).
 *
 * Returns the edit script between two line arrays as an ordered list of ops:
 * `eq` (line unchanged), `del` (line only in `a`), `ins` (line only in `b`).
 * Pure and GTK-free so it can be unit-tested; used by the editor's git gutter to
 * diff the live buffer against the HEAD blob.
 */
export type DiffOp = 'eq' | 'del' | 'ins';

// Bounds so a pathological input (huge and/or wildly diverged file) can't freeze
// the UI: skip the O((n+m)·D) search past these and degrade to a whole-file
// replace (delete-all then insert-all — correct, just non-minimal).
const MAX_LINES = 20000; // combined line count
const MAX_D = 4000; // edit distance to search before giving up

function fullReplace(n: number, m: number): DiffOp[] {
  const ops: DiffOp[] = [];
  for (let i = 0; i < n; i++) ops.push('del');
  for (let j = 0; j < m; j++) ops.push('ins');
  return ops;
}

/** Diff line arrays `a` (old) → `b` (new). Ops are in forward (file) order. */
export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  // Strip the common prefix/suffix before the O((n+m)·D) search: the typical input (an edit, a
  // view splice) changes one small region of a large file, so this reduces the search to the
  // changed core — and lets a huge-but-lightly-changed input diff minimally instead of tripping
  // the size bound below.
  const n = a.length;
  const m = b.length;
  let prefix = 0;
  const maxPrefix = Math.min(n, m);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(n, m) - prefix;
  while (suffix < maxSuffix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;
  if (prefix === 0 && suffix === 0) return myersDiff(a, b);
  const core = myersDiff(a.slice(prefix, n - suffix), b.slice(prefix, m - suffix));
  const ops: DiffOp[] = new Array(prefix).fill('eq');
  for (const op of core) ops.push(op);
  for (let i = 0; i < suffix; i++) ops.push('eq');
  return ops;
}

function myersDiff(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;

  // Fast paths (common while editing): identical, or one side empty.
  if (n === 0) return Array.from({ length: m }, () => 'ins');
  if (m === 0) return Array.from({ length: n }, () => 'del');
  if (n + m > MAX_LINES) return fullReplace(n, m);
  // The edit distance is at least |n − m|; past the cap the search below can only end in
  // `fullReplace` anyway, so skip straight there instead of burning the whole D sweep.
  if (Math.abs(n - m) > MAX_D) return fullReplace(n, m);

  const max = n + m;
  const offset = max; // shift k (which ranges [-max, max]) into a non-negative index
  // v[k] = furthest x reached on diagonal k; one snapshot per edit-distance d.
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  let found = false;
  const limit = Math.min(max, MAX_D);
  for (let d = 0; d <= limit && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const k0 = k + offset;
      // Choose to extend from the diagonal above (down = insert) or left (right = delete).
      let x: number;
      if (k === -d || (k !== d && v[k0 - 1] < v[k0 + 1])) {
        x = v[k0 + 1]; // down: insertion in b
      } else {
        x = v[k0 - 1] + 1; // right: deletion in a
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      } // follow the snake (equal lines)
      v[k0] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }

  // Edit distance exceeded the cap — degrade rather than risk a long search.
  if (!found) return fullReplace(n, m);

  // Backtrack through the per-d snapshots to reconstruct the ops.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vPrev = trace[d];
    const k = x - y;
    const k0 = k + offset;
    const down = k === -d || (k !== d && vPrev[k0 - 1] < vPrev[k0 + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = vPrev[prevK + offset];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('eq');
      x--;
      y--;
    }
    ops.push(down ? 'ins' : 'del');
    x = prevX;
    y = prevY;
  }
  // d === 0: the leading snake of equal lines.
  while (x > 0 && y > 0) {
    ops.push('eq');
    x--;
    y--;
  }
  ops.reverse();
  return ops;
}
