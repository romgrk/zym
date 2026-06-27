/*
 * diffMultiBuffer — assemble a CONTINUOUS multi-file diff into the projection model the diff
 * multibuffer surface renders (docs/text-editor/multibuffer.md, Phase 3b / G5 — the editable
 * diff that replaces GitStagingView). For each changed file it emits a filename header block,
 * then the file's diff WINDOWED like a real diff — changed hunks plus a few lines of context,
 * with long unchanged runs elided to a `⋯ N unchanged lines` gap row — via `diffRows` +
 * `rowsToItems` (context/added → editable new-side rows, removed → read-only phantom old-side
 * rows). It also returns the per-row diff KIND the surface paints as added/removed backgrounds.
 *
 * Pure + GTK-free: the surface materializes a `CoordinatesMap` over the sources, paints each
 * side from its own grammar (`ExcerptSyntaxProjection`), and applies the decorations from
 * `rowKinds`. Eliding here keeps the diff readable without needing live folds.
 */
import type { Item } from '../TextEditor/CoordinatesMap.ts';
import { diffRows, rowsToItems, type DiffRow } from './diffSegments.ts';
import { computeIntraLineDiff, refineWordRanges, type WordRange } from '../../util/wordDiff.ts';
import { diffLines } from '../../util/lineDiff.ts';
import * as Path from 'node:path';

/** One changed file: its base (old / HEAD) and current (new / working) content. */
export interface DiffFile {
  path: string;
  /** Header label; defaults to a path relative to `cwd` (or the basename). */
  label?: string;
  oldText: string;
  newText: string;
  /** The staged (index) blob, when known — `git show :path`. Drives the per-row staged/unstaged
   *  classification (the gutter marker). Omitted in read-only mode / outside a repo. */
  indexText?: string;
}

/** The kind of each projection row, for decorations / gutters. */
export type DiffRowKind = 'header' | 'blank' | 'gap' | 'context' | 'added' | 'removed';

/** Whether a changed row's change is already in the index. `null` for rows with no change to stage
 *  (header/blank/gap/context, and any file whose `indexText` wasn't supplied). */
export type StagedState = 'staged' | 'unstaged' | null;

export interface DiffMultiBuffer {
  /** The ordered projection items for `CoordinatesMap.build`. */
  items: Item[];
  /** Per projection row (0-based), aligned with the materialized view. */
  rowKinds: DiffRowKind[];
  /** Per projection row: the intra-line ("word-by-word") changed-character spans for an
   *  added/removed row that modifies a counterpart line, or `null` (unchanged row, or a
   *  wholesale add/remove the full-line background already covers). */
  wordRanges: (WordRange[] | null)[];
  /** Per projection row: whether the change there is staged / unstaged (the gutter marker), or
   *  `null` for an unchanged / non-stageable row, or any file with no `indexText`. */
  stagedState: StagedState[];
  /** Per projection row: the 1-based OLD / NEW file line number, or null (header/gap/blank,
   *  and the side a row doesn't exist on — added has no old, removed no new). For the gutters. */
  oldNums: (number | null)[];
  newNums: (number | null)[];
  /** Source key → its line array, for `resolveLines` + parsing. The new side of file `p` is
   *  keyed `new:<p>`, the old (base) side `old:<p>` — two sources, same grammar. */
  sources: Map<string, string[]>;
  /** Source key → the path whose grammar highlights it. */
  language: Map<string, string>;
  /** Widget mode only: each file's header. `viewRow` is the EMPTY, navigable `block` row emitted as
   *  the file's first row — the surface places the filename widget OVER it and the caret lands on it
   *  (collapse toggle). `added`/`removed` are the file's change counts (the `+N −M` stat). */
  headerAnchors: Array<{
    path: string;
    label: string;
    viewRow: number;
    added: number;
    removed: number;
  }>;
  /** Widget mode only: each `⋯` gap, a decoration band (not a navigable buffer row). A LEADING gap
   *  (the elided file head) anchors `'above'` the first content row; a between/trailing gap anchors
   *  `'below'` the last shown row before the elision. `revealRows` are the new-side rows it elides;
   *  `fromTop` is the chunk a click reveals first (true = the top chunk, for a between gap; false =
   *  the bottom chunk nearest the content, for a leading gap). */
  gapAnchors: Array<{ viewRow: number; label: string; revealRows: number[]; placement: 'above' | 'below'; fromTop: boolean }>;
}

export interface DiffLayoutOptions {
  /** `'block'` (default) emits a filename header TEXT row + a blank separator per file;
   *  `'widget'` emits an EMPTY navigable header `block` row per file (the surface floats a filename
   *  widget above it and the caret lands on it for collapse), so the filename itself isn't copyable
   *  buffer text. */
  headers?: 'block' | 'widget';
  /** Expand-context: force these (otherwise-elided) NEW-side rows visible. Returns true for a
   *  new-side row the user has revealed, so it shows as context instead of folding into a gap. */
  reveal?: (newRow: number) => boolean;
  /** Per-file collapse (widget mode): returns true for a file the user has collapsed, which then
   *  contributes ONLY its header row (no windows/gaps/decorations) — a one-line overview entry. */
  collapsed?: (path: string) => boolean;
}

const newKey = (path: string): string => `new:${path}`;
const oldKey = (path: string): string => `old:${path}`;
const OP_KIND = { eq: 'context', ins: 'added', del: 'removed' } as const;

/**
 * Classify each change in the displayed worktree↔HEAD diff as staged or unstaged, by where it sits
 * relative to the index — the same model `GitGutter` uses (unstaged = index↔worktree, staged =
 * HEAD↔index). Returns two membership lookups:
 *   - `wtInIndex[worktreeRow]` — true when that worktree line is already in the index (so a row
 *     ADDED vs HEAD is a STAGED addition; false = an unstaged addition).
 *   - `headRemovedInIndex[headRow]` — true when that HEAD line is also gone from the index (so a
 *     row REMOVED vs HEAD is a STAGED deletion; false = an unstaged deletion).
 */
function classifyStaged(headLines: string[], indexLines: string[], worktreeLines: string[]): {
  wtInIndex: boolean[];
  headRemovedInIndex: boolean[];
} {
  const wtInIndex = new Array<boolean>(worktreeLines.length).fill(false);
  let wi = 0;
  for (const op of diffLines(indexLines, worktreeLines)) {
    if (op === 'ins') wtInIndex[wi++] = false; // in worktree, not in index → unstaged add
    else if (op === 'eq') wtInIndex[wi++] = true; // in both → already staged
    // 'del' consumes an index line only — no worktree row to mark
  }
  const headRemovedInIndex = new Array<boolean>(headLines.length).fill(false);
  let hi = 0;
  for (const op of diffLines(headLines, indexLines)) {
    if (op === 'del') headRemovedInIndex[hi++] = true; // gone from the index → staged deletion
    else if (op === 'eq') headRemovedInIndex[hi++] = false; // still in the index → unstaged deletion
    // 'ins' is an index-only addition — no HEAD row to mark
  }
  return { wtInIndex, headRemovedInIndex };
}

// Lines of unchanged context kept around each change; unchanged runs longer than this on a
// side collapse to a `⋯` gap. A gap shorter than MIN_ELIDE is shown instead (eliding it saves
// nothing). Matches the search multibuffer's context feel.
const CONTEXT = 3;
const MIN_ELIDE = 2;

/** Assemble the windowed diff projection for `files`. `cwd` (optional) relativizes labels. */
export function buildDiffMultiBuffer(files: DiffFile[], cwd?: string, opts: DiffLayoutOptions = {}): DiffMultiBuffer {
  const widgetHeaders = opts.headers === 'widget';
  const items: Item[] = [];
  const rowKinds: DiffRowKind[] = [];
  const wordRanges: (WordRange[] | null)[] = [];
  const stagedState: StagedState[] = [];
  const oldNums: (number | null)[] = [];
  const newNums: (number | null)[] = [];
  const sources = new Map<string, string[]>();
  const language = new Map<string, string>();
  const headerAnchors: DiffMultiBuffer['headerAnchors'] = [];
  const gapAnchors: DiffMultiBuffer['gapAnchors'] = [];
  const split = (text: string): string[] => text.split('\n');
  // Emit one row: its kind + the old/new line numbers it carries.
  const block = (kind: DiffRowKind): void => {
    rowKinds.push(kind);
    wordRanges.push(null);
    stagedState.push(null);
    oldNums.push(null);
    newNums.push(null);
  };

  files.forEach((file, fileIndex) => {
    const nKey = newKey(file.path);
    const oKey = oldKey(file.path);
    const oldLines = split(file.oldText);
    const newLines = split(file.newText);
    sources.set(nKey, newLines);
    sources.set(oKey, oldLines);
    language.set(nKey, file.path);
    language.set(oKey, file.path);

    const recs = diffRows(oldLines, newLines);
    // Skip files with no text change — a "changed files" diff shouldn't list them, and showing
    // a bare `⋯ N unchanged lines` for them (e.g. a mode-only change, or the node_modules
    // symlink whose blob round-trips equal) is just a non-expandable dead entry.
    if (!recs.some((r) => r.op !== 'eq')) return;

    const label = file.label ?? (cwd ? Path.relative(cwd, file.path) : Path.basename(file.path));
    // Per-file change counts — shown on the header widget (`+N −M`), the only content of a
    // collapsed file's one-line overview entry.
    const added = recs.reduce((n, r) => n + (r.op === 'ins' ? 1 : 0), 0);
    const removed = recs.reduce((n, r) => n + (r.op === 'del' ? 1 : 0), 0);
    if (widgetHeaders) {
      // The file's first row is an EMPTY, read-only, NAVIGABLE `block` row — the caret target the
      // collapse toggle keys off — that the surface places the filename widget OVER. Empty text so a
      // cross-file copy carries no header text. `viewRow` is recorded before the row is emitted.
      headerAnchors.push({ path: file.path, label, viewRow: rowKinds.length, added, removed });
      items.push({ type: 'block', block: { kind: 'header', text: '' } });
      block('header');
      // A COLLAPSED file contributes only its header row — no windows, gaps, or decorations.
      if (opts.collapsed?.(file.path)) return;
    } else {
      if (fileIndex > 0) {
        items.push({ type: 'block', block: { kind: 'blank', text: '' } });
        block('blank');
      }
      items.push({ type: 'block', block: { kind: 'header', text: label } });
      block('header');
    }

    // Staged/unstaged classification (the gutter marker), when the index blob is known. A row
    // ADDED vs HEAD is staged iff its worktree line is already in the index; a row REMOVED vs HEAD
    // is staged iff that HEAD line is also gone from the index.
    const staged = file.indexText !== undefined ? classifyStaged(oldLines, split(file.indexText), newLines) : null;
    const stagedFor = (rec: DiffRow): StagedState => {
      if (!staged || rec.op === 'eq') return null;
      const inIndex = rec.op === 'ins' ? staged.wtInIndex[rec.newRow] : staged.headRemovedInIndex[rec.oldRow];
      return inIndex ? 'staged' : 'unstaged';
    };

    // Emit an elided `⋯` gap: a block row (block mode), or — in widget mode — a band anchor (never a
    // navigable buffer row). A LEADING gap (the elided file head) is its OWN band anchored `'above'`
    // the first content row (the next row to be emitted) — separate from the header; a between/
    // trailing gap anchors `'below'` the last shown row (`rowKinds.length - 1`).
    const emitGap = (rows: DiffRow[], leading: boolean): void => {
      const count = rows.length;
      const revealRows = rows.map((r) => r.newRow); // the elided new-side rows (expand-context)
      if (!widgetHeaders) {
        items.push({ type: 'block', block: { kind: 'gap', text: gapLabel(count) } });
        block('gap');
      } else if (leading) {
        // A click reveals from the BOTTOM (the rows nearest the content below it).
        gapAnchors.push({ viewRow: rowKinds.length, label: gapLabel(count), revealRows, placement: 'above', fromTop: false });
      } else {
        gapAnchors.push({ viewRow: rowKinds.length - 1, label: gapLabel(count), revealRows, placement: 'below', fromTop: true });
      }
    };

    // Mark every row within CONTEXT of a change as visible; the rest are elided gaps.
    const visible = new Array(recs.length).fill(false);
    recs.forEach((r, i) => {
      if (r.op === 'eq') return;
      for (let k = Math.max(0, i - CONTEXT); k <= Math.min(recs.length - 1, i + CONTEXT); k++) visible[k] = true;
    });
    // Force user-revealed rows visible (expand-context) — they show as context, not a gap.
    if (opts.reveal) for (let i = 0; i < recs.length; i++) if (recs[i].op === 'eq' && opts.reveal(recs[i].newRow)) visible[i] = true;
    // Show, don't elide, gaps shorter than MIN_ELIDE.
    for (let i = 0; i < recs.length; ) {
      if (visible[i]) { i++; continue; }
      let j = i;
      while (j < recs.length && !visible[j]) j++;
      if (j - i < MIN_ELIDE) for (let k = i; k < j; k++) visible[k] = true;
      i = j;
    }

    let firstItem = true; // a gap before the first window is LEADING (no content row above it)
    for (let i = 0; i < recs.length; ) {
      if (visible[i]) {
        let j = i;
        while (j < recs.length && visible[j]) j++;
        const window = recs.slice(i, j);
        items.push(...rowsToItems(window, nKey, oKey).items);
        const baseRow = rowKinds.length; // view row of window[0] (before its rows are pushed)
        for (const rec of window) {
          rowKinds.push(OP_KIND[rec.op]);
          wordRanges.push(null);
          stagedState.push(stagedFor(rec));
          oldNums.push(rec.op === 'ins' ? null : rec.oldRow + 1);
          newNums.push(rec.op === 'del' ? null : rec.newRow + 1);
        }
        annotateWordDiffs(window, baseRow, oldLines, newLines, wordRanges);
        firstItem = false;
        i = j;
      } else {
        let j = i;
        while (j < recs.length && !visible[j]) j++;
        emitGap(recs.slice(i, j), firstItem);
        firstItem = false;
        i = j;
      }
    }
  });

  return { items, rowKinds, wordRanges, stagedState, oldNums, newNums, sources, language, headerAnchors, gapAnchors };
}

/** Within one visible `window` of rows (its first at view row `baseRow`), pair each hunk's
 *  removed↔added lines and write their intra-line change spans into `out` at the matching view
 *  rows. A hunk is a maximal run of changed (non-`eq`) rows; eq/context rows split hunks. Lines
 *  with no shared content are skipped — the full-line background already says enough. */
function annotateWordDiffs(
  window: readonly DiffRow[],
  baseRow: number,
  oldLines: readonly string[],
  newLines: readonly string[],
  out: (WordRange[] | null)[],
): void {
  for (let h = 0; h < window.length; ) {
    if (window[h].op === 'eq') { h++; continue; }
    let k = h;
    const dels: number[] = []; // offsets (within `window`) of this hunk's removed rows
    const adds: number[] = []; // …and its added rows
    while (k < window.length && window[k].op !== 'eq') {
      if (window[k].op === 'del') dels.push(k);
      else adds.push(k);
      k++;
    }
    for (let p = 0; p < Math.min(dels.length, adds.length); p++) {
      const oldText = oldLines[window[dels[p]].oldRow];
      const newText = newLines[window[adds[p]].newRow];
      const { oldRanges, newRanges, hasCommon } = computeIntraLineDiff(oldText, newText);
      if (!hasCommon) continue; // wholly different — let the line backgrounds carry it
      const del = refineWordRanges(oldText, oldRanges);
      const add = refineWordRanges(newText, newRanges);
      if (del.length) out[baseRow + dels[p]] = del;
      if (add.length) out[baseRow + adds[p]] = add;
    }
    h = k;
  }
}

function gapLabel(count: number): string {
  return `⋯ ${count} unchanged line${count === 1 ? '' : 's'}`;
}
