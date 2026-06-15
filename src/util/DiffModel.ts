/*
 * DiffModel — the structured input a diff viewer renders, computed from two
 * texts via the line-level `diffLines`. Pure and GTK-free (unit-tested); the
 * editor's diff panes consume it.
 *
 * `lines` is the unified line list (context + removed + added, in file order) —
 * exactly the rows a synthesized inline (unified) buffer holds, each tagged with
 * its `kind` (for the line decoration + gutter glyph) and its source rows.
 * `hunks` are the contiguous changed regions, for hunk navigation / fold-unchanged
 * (each points at a `lines` row range). See tasks/code-editing/diff.md.
 */
import { diffLines } from './lineDiff.ts';

export type DiffLineKind = 'context' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 0-based row in the old text, or null for an added line. */
  oldRow: number | null;
  /** 0-based row in the new text, or null for a removed line. */
  newRow: number | null;
}

export interface DiffHunk {
  /** Index of the hunk's first line in `DiffModel.lines` (the unified buffer row). */
  startRow: number;
  /** Number of `lines` rows the hunk spans. */
  rowCount: number;
  added: number;
  removed: number;
  /** First old/new rows the hunk touches (null when it has none of that side). */
  oldStart: number | null;
  newStart: number | null;
}

export interface DiffModel {
  lines: DiffLine[];
  hunks: DiffHunk[];
  stats: { added: number; removed: number };
}

/** Split text into lines, treating a single trailing newline as a terminator
 *  (so "a\nb" and "a\nb\n" both yield ["a", "b"]); "" yields []. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Compute the diff model between `oldText` and `newText`. */
export function computeDiff(oldText: string, newText: string): DiffModel {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffLines(a, b);

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op === 'eq') {
      lines.push({ kind: 'context', text: a[i], oldRow: i, newRow: j });
      i++;
      j++;
    } else if (op === 'del') {
      lines.push({ kind: 'removed', text: a[i], oldRow: i, newRow: null });
      i++;
      removed++;
    } else {
      lines.push({ kind: 'added', text: b[j], oldRow: null, newRow: j });
      j++;
      added++;
    }
  }

  return { lines, hunks: buildHunks(lines), stats: { added, removed } };
}

export type SideLineKind = 'context' | 'added' | 'removed' | 'filler';

/** One row of a side-by-side pane. `filler` is a blank alignment pad (the other
 *  side changed). */
export interface SideLine {
  kind: SideLineKind;
  text: string;
}

export interface SideBySide {
  left: SideLine[]; // old text + fillers where the new side added
  right: SideLine[]; // new text + fillers where the old side removed
}

/**
 * Split a `DiffModel` into two line-aligned panes for a side-by-side view: each
 * row pairs the old and new line (or a blank filler when only one side changed),
 * so both arrays have equal length and row N is the same content on both sides.
 * Within a changed run, removed/added lines are paired up; the shorter side is
 * padded with fillers.
 */
export function splitSides(model: DiffModel): SideBySide {
  const left: SideLine[] = [];
  const right: SideLine[] = [];
  let dels: string[] = [];
  let adds: string[] = [];

  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      left.push(i < dels.length ? { kind: 'removed', text: dels[i] } : { kind: 'filler', text: '' });
      right.push(i < adds.length ? { kind: 'added', text: adds[i] } : { kind: 'filler', text: '' });
    }
    dels = [];
    adds = [];
  };

  for (const line of model.lines) {
    if (line.kind === 'removed') dels.push(line.text);
    else if (line.kind === 'added') adds.push(line.text);
    else {
      flush();
      left.push({ kind: 'context', text: line.text });
      right.push({ kind: 'context', text: line.text });
    }
  }
  flush();
  return { left, right };
}

/** Group consecutive changed (non-context) lines into hunks. */
function buildHunks(lines: DiffLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let start = -1;
  for (let row = 0; row <= lines.length; row++) {
    const changed = row < lines.length && lines[row].kind !== 'context';
    if (changed && start === -1) {
      start = row;
    } else if (!changed && start !== -1) {
      hunks.push(makeHunk(lines, start, row));
      start = -1;
    }
  }
  return hunks;
}

function makeHunk(lines: DiffLine[], start: number, end: number): DiffHunk {
  let added = 0;
  let removed = 0;
  let oldStart: number | null = null;
  let newStart: number | null = null;
  for (let row = start; row < end; row++) {
    const line = lines[row];
    if (line.kind === 'added') added++;
    else if (line.kind === 'removed') removed++;
    if (oldStart === null && line.oldRow !== null) oldStart = line.oldRow;
    if (newStart === null && line.newRow !== null) newStart = line.newRow;
  }
  return { startRow: start, rowCount: end - start, added, removed, oldStart, newStart };
}
