/*
 * hunkPatch — turn a line-level diff into git "hunks" and synthesize the unified
 * diff for a single one, so the editor can stage / unstage / revert a hunk under
 * the cursor.
 *
 * A `Hunk` is one maximal run of changed lines between a base (`a`) and a target
 * (`b`): the lines removed from `a` (`oldLines`, at `oldStart`) and the lines
 * added in `b` (`newLines`, at `newStart`), both 0-based. `computeHunks` groups
 * the `diffLines` edit script; `formatHunkPatch` emits a zero-context unified
 * diff for one hunk, applied with `git apply --unidiff-zero --recount` (so the
 * exact `@@` counts don't have to be perfect). Pure / GTK-free for unit testing.
 */
import { diffLines } from './lineDiff.ts';

export interface Hunk {
  /** 0-based row in the base (`a`) where the change begins. */
  oldStart: number;
  /** Lines removed from the base (empty for a pure insertion). */
  oldLines: string[];
  /** 0-based row in the target (`b`) where the change begins. */
  newStart: number;
  /** Lines added in the target (empty for a pure deletion). */
  newLines: string[];
}

/** Group the `a`→`b` edit script into hunks (maximal runs of changed lines). */
export function computeHunks(a: readonly string[], b: readonly string[]): Hunk[] {
  const ops = diffLines(a, b);
  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i] === 'eq') {
      ai++;
      bi++;
      i++;
      continue;
    }
    const hunk: Hunk = { oldStart: ai, oldLines: [], newStart: bi, newLines: [] };
    while (i < ops.length && ops[i] !== 'eq') {
      if (ops[i] === 'del') hunk.oldLines.push(a[ai++]);
      else hunk.newLines.push(b[bi++]);
      i++;
    }
    hunks.push(hunk);
  }
  return hunks;
}

/**
 * Map each base (`a`) row to the target (`b`) row it aligns with — used to place
 * staged hunks (computed in index coordinates) onto buffer rows. A deleted base
 * row maps to the buffer row that took its place.
 */
export function buildRowMap(a: readonly string[], b: readonly string[]): number[] {
  const ops = diffLines(a, b);
  const map = new Array<number>(a.length);
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    if (op === 'eq') map[ai++] = bi++;
    else if (op === 'del') map[ai++] = bi;
    else bi++;
  }
  return map;
}

/**
 * Synthesize a zero-context unified diff for one hunk (the `a`→`b` change), as
 * the input to `git apply`. `relPath` is the repo-relative path. Apply forward to
 * stage (`--cached`) or reverse to unstage (`--cached --reverse`); pair with
 * `--unidiff-zero --recount` so git tolerates the exact line counts.
 */
export function formatHunkPatch(relPath: string, hunk: Hunk): string {
  const oldCount = hunk.oldLines.length;
  const newCount = hunk.newLines.length;
  // Unified-diff start lines are 1-based; for an empty side git uses the row
  // *before* the change (so a pure insertion is `-N,0`, a pure deletion `+N,0`).
  const oldStart = oldCount > 0 ? hunk.oldStart + 1 : hunk.oldStart;
  const newStart = newCount > 0 ? hunk.newStart + 1 : hunk.newStart;
  const lines = [
    `diff --git a/${relPath} b/${relPath}`,
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...hunk.oldLines.map((line) => `-${line}`),
    ...hunk.newLines.map((line) => `+${line}`),
  ];
  return lines.join('\n') + '\n';
}

/** Whether a hunk covers `row` on the target (buffer) side — for matching the
 *  hunk under the cursor. A pure deletion has no buffer rows, so it matches the
 *  surviving line on either side of the gap (where the gutter marker sits). */
export function hunkContainsBufferRow(hunk: Hunk, row: number): boolean {
  if (hunk.newLines.length === 0) return row === hunk.newStart - 1 || row === hunk.newStart;
  return row >= hunk.newStart && row < hunk.newStart + hunk.newLines.length;
}
