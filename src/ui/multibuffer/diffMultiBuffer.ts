/*
 * diffMultiBuffer — assemble a CONTINUOUS multi-file diff into the projection model the diff
 * multibuffer surface renders (tasks/code-editing/multibuffer.md, Phase 3b / G5 — the editable
 * diff that replaces GitStagingView). For each changed file it emits a filename header block,
 * then the file's diff WINDOWED like a real diff — changed hunks plus a few lines of context,
 * with long unchanged runs elided to a `⋯ N unchanged lines` gap row — via `diffRows` +
 * `rowsToItems` (context/added → editable new-side rows, removed → read-only phantom old-side
 * rows). It also returns the per-row diff KIND the surface paints as added/removed backgrounds.
 *
 * Pure + GTK-free: the surface materializes a `ViewProjection` over the sources, paints each
 * side from its own grammar (`ExcerptSyntaxProjection`), and applies the decorations from
 * `rowKinds`. Eliding here keeps the diff readable without needing live folds.
 */
import type { Item } from '../TextEditor/ViewProjection.ts';
import { diffRows, rowsToItems, type DiffRow } from './diffSegments.ts';
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
  /** The ordered projection items for `ViewProjection.build`. */
  items: Item[];
  /** Per projection row (0-based), aligned with the materialized view. */
  rowKinds: DiffRowKind[];
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
  /** Widget mode only: where each file's header widget anchors (the view row its content starts
   *  on, since no header/blank rows are emitted). `subtitle` carries a LEADING `⋯` gap (elided
   *  rows above the first shown row) folded into the header, as it shares the anchor row. */
  headerAnchors: Array<{
    path: string;
    label: string;
    viewRow: number;
    subtitle?: string;
    /** New-side rows elided by a LEADING gap (for expand-context — reveal a chunk on demand). */
    leadingRevealRows?: number[];
  }>;
  /** Widget mode only: each between/trailing `⋯` gap, anchored BELOW `viewRow` (the last shown
   *  row before the elision) — a decoration band, not a navigable buffer row. `revealRows` are
   *  the new-side rows it elides (expand-context reveals a chunk of them). */
  gapAnchors: Array<{ viewRow: number; label: string; revealRows: number[] }>;
}

export interface DiffLayoutOptions {
  /** `'block'` (default) emits a filename header text row + a blank separator per file;
   *  `'widget'` emits neither (the surface draws a header widget above each file via
   *  `headerAnchors`), so the filename isn't navigable buffer text. */
  headers?: 'block' | 'widget';
  /** Expand-context: force these (otherwise-elided) NEW-side rows visible. Returns true for a
   *  new-side row the user has revealed, so it shows as context instead of folding into a gap. */
  reveal?: (newRow: number) => boolean;
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

    // Staged/unstaged classification (the gutter marker), when the index blob is known. A row
    // ADDED vs HEAD is staged iff its worktree line is already in the index; a row REMOVED vs HEAD
    // is staged iff that HEAD line is also gone from the index.
    const staged = file.indexText !== undefined ? classifyStaged(oldLines, split(file.indexText), newLines) : null;
    const stagedFor = (rec: DiffRow): StagedState => {
      if (!staged || rec.op === 'eq') return null;
      const inIndex = rec.op === 'ins' ? staged.wtInIndex[rec.newRow] : staged.headRemovedInIndex[rec.oldRow];
      return inIndex ? 'staged' : 'unstaged';
    };

    const label = file.label ?? (cwd ? Path.relative(cwd, file.path) : Path.basename(file.path));
    let header: DiffMultiBuffer['headerAnchors'][number] | null = null;
    if (widgetHeaders) {
      // No header/blank rows in the buffer — the surface anchors a header widget above the row
      // the file's content starts on (recorded now, before its first row is emitted).
      header = { path: file.path, label, viewRow: rowKinds.length };
      headerAnchors.push(header);
    } else {
      if (fileIndex > 0) {
        items.push({ type: 'block', block: { kind: 'blank', text: '' } });
        block('blank');
      }
      items.push({ type: 'block', block: { kind: 'header', text: label } });
      block('header');
    }

    // Emit an elided `⋯` gap: a block row (block mode), or — in widget mode — a LEADING gap folds
    // into the header subtitle (it shares the header's anchor row), any other anchors a band
    // below the last shown row (`rowKinds.length - 1`). Never a navigable buffer row in widget mode.
    const emitGap = (rows: DiffRow[], leading: boolean): void => {
      const count = rows.length;
      const revealRows = rows.map((r) => r.newRow); // the elided new-side rows (expand-context)
      if (!widgetHeaders) {
        items.push({ type: 'block', block: { kind: 'gap', text: gapLabel(count) } });
        block('gap');
      } else if (leading && header) {
        header.subtitle = gapLabel(count);
        header.leadingRevealRows = revealRows;
      } else {
        gapAnchors.push({ viewRow: rowKinds.length - 1, label: gapLabel(count), revealRows });
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
        for (const rec of window) {
          rowKinds.push(OP_KIND[rec.op]);
          stagedState.push(stagedFor(rec));
          oldNums.push(rec.op === 'ins' ? null : rec.oldRow + 1);
          newNums.push(rec.op === 'del' ? null : rec.newRow + 1);
        }
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

  return { items, rowKinds, stagedState, oldNums, newNums, sources, language, headerAnchors, gapAnchors };
}

function gapLabel(count: number): string {
  return `⋯ ${count} unchanged line${count === 1 ? '' : 's'}`;
}
