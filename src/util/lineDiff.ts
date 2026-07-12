/*
 * lineDiff — a line-level diff: patience-style anchoring over a Myers core.
 *
 * Returns the edit script between two line arrays as an ordered list of ops:
 * `eq` (line unchanged), `del` (line only in `a`), `ins` (line only in `b`).
 * Pure and GTK-free so it can be unit-tested; used by the git gutter, the diff
 * views, and the buffer/disk resync paths.
 *
 * Shape (why not plain Myers): Myers' O((n+m)·D) search is exact but blows up
 * on a large file that has diverged a lot — D grows with the number of edited
 * lines, and the git gutter re-diffs on every typing pause. So:
 *
 *   1. trim the common prefix/suffix (typical edits are clustered, and a clean
 *      file must cost ~nothing no matter its size);
 *   2. run exact Myers only on small middles;
 *   3. split large middles on unique-common-line anchors (patience diff: lines
 *      occurring exactly once on both sides, chained by LIS) and recurse — for
 *      code this resolves scattered edits in ~O(n log n);
 *   4. an anchor-free large segment gets a bounded Myers search, and past the
 *      bounds degrades to a segment-local replace (delete-all + insert-all —
 *      correct, just non-minimal) instead of freezing the UI.
 */
export type DiffOp = 'eq' | 'del' | 'ins';

// Run exact Myers below this combined (n+m) segment size: worst case ~4M snake
// steps, low single-digit ms.
const MYERS_EXACT = 2048;
// Edit-distance cap for the bounded search on anchor-free segments.
const MYERS_MAX_D = 1024;
// Combined size past which an anchor-free segment skips the search entirely.
const SEARCH_MAX = 20000;
// Anchor recursion guard (adversarial nesting); past it segments degrade.
const MAX_DEPTH = 32;

/** Diff line arrays `a` (old) → `b` (new). Ops are in forward (file) order. */
export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  diffRange(a, 0, a.length, b, 0, b.length, 0, ops);
  return ops;
}

function pushRepeat(out: DiffOp[], op: DiffOp, count: number): void {
  for (let i = 0; i < count; i++) out.push(op);
}

function diffRange(
  a: readonly string[], a0: number, a1: number,
  b: readonly string[], b0: number, b1: number,
  depth: number, out: DiffOp[],
): void {
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) { out.push('eq'); a0++; b0++; }
  let suffix = 0;
  while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) { a1--; b1--; suffix++; }

  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0 || m === 0) {
    pushRepeat(out, 'del', n);
    pushRepeat(out, 'ins', m);
  } else if (n + m <= MYERS_EXACT) {
    myers(a, a0, a1, b, b0, b1, n + m, out); // exact: always succeeds
  } else {
    const anchors = depth < MAX_DEPTH ? uniqueCommonAnchors(a, a0, a1, b, b0, b1) : [];
    if (anchors.length > 0) {
      let pa = a0;
      let pb = b0;
      for (const { ia, ib } of anchors) {
        diffRange(a, pa, ia, b, pb, ib, depth + 1, out);
        out.push('eq');
        pa = ia + 1;
        pb = ib + 1;
      }
      diffRange(a, pa, a1, b, pb, b1, depth + 1, out);
    } else if (!(n + m <= SEARCH_MAX && myers(a, a0, a1, b, b0, b1, MYERS_MAX_D, out))) {
      pushRepeat(out, 'del', n);
      pushRepeat(out, 'ins', m);
    }
  }

  pushRepeat(out, 'eq', suffix);
}

interface Anchor { ia: number; ib: number }

/** Patience anchors for `a[a0..a1)` / `b[b0..b1)`: lines occurring exactly once
 *  on each side, reduced to an ordered chain by LIS over the `b` rows. */
function uniqueCommonAnchors(
  a: readonly string[], a0: number, a1: number,
  b: readonly string[], b0: number, b1: number,
): Anchor[] {
  interface Occ { ca: number; cb: number; ib: number }
  const occ = new Map<string, Occ>();
  for (let i = a0; i < a1; i++) {
    const e = occ.get(a[i]);
    if (e) e.ca++;
    else occ.set(a[i], { ca: 1, cb: 0, ib: -1 });
  }
  for (let j = b0; j < b1; j++) {
    const e = occ.get(b[j]);
    if (e) { e.cb++; e.ib = j; }
  }
  const cand: Anchor[] = [];
  for (let i = a0; i < a1; i++) {
    const e = occ.get(a[i])!;
    if (e.ca === 1 && e.cb === 1) cand.push({ ia: i, ib: e.ib });
  }
  if (cand.length === 0) return cand;

  // LIS (strictly increasing ib) via patience sorting with back-pointers; cand
  // is already sorted by ia.
  const tails: number[] = []; // candidate index holding the smallest tail ib per chain length
  const prev = new Int32Array(cand.length).fill(-1);
  for (let c = 0; c < cand.length; c++) {
    const x = cand[c].ib;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cand[tails[mid]].ib < x) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[c] = tails[lo - 1];
    tails[lo] = c;
  }
  const chain: Anchor[] = [];
  for (let c = tails[tails.length - 1]; c !== -1; c = prev[c]) chain.push(cand[c]);
  chain.reverse();
  return chain;
}

/**
 * Myers' O((n+m)·D) search on `a[a0..a1)` → `b[b0..b1)`, bounded to `maxD`.
 * Appends ops to `out` and returns true when the edit distance is within the
 * bound; returns false (nothing emitted) otherwise. Per-step trace rows hold
 * only the diagonals a step touches (2d+1), so memory is O(D²), not O((n+m)·D).
 */
function myers(
  a: readonly string[], a0: number, a1: number,
  b: readonly string[], b0: number, b1: number,
  maxD: number, out: DiffOp[],
): boolean {
  const n = a1 - a0;
  const m = b1 - b0;
  const max = n + m;
  const offset = max; // shift k (which ranges [-max, max]) into a non-negative index
  // v[k] = furthest x reached on diagonal k.
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  let found = false;
  const limit = Math.min(max, maxD);
  for (let d = 0; d <= limit && !found; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
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
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
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
  if (!found) return false;

  // Backtrack through the per-d trace rows (row d is indexed by k + d).
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vPrev = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && vPrev[k - 1 + d] < vPrev[k + 1 + d]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = vPrev[prevK + d];
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
  for (let i = ops.length - 1; i >= 0; i--) out.push(ops[i]);
  return true;
}
