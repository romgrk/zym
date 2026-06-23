/*
 * diffSegments — the diff-duality coordinate model (docs/text-editor/multibuffer.md, Phase
 * 3b; the foundation for the editable diff multibuffer that replaces GitStagingView, G5).
 *
 * `diffRows` is the per-row line diff: each row carries its op (`eq`/`ins`/`del`) and BOTH the
 * old and new source-line indices (so the surface can show old|new line numbers and window the
 * diff). `rowsToItems` turns a contiguous run of those rows into `ViewProjection` items —
 * `eq`/`ins` → editable `real` rows over the NEW source (context + added), `del` → read-only
 * `phantom` rows over the OLD blob (removed) — merging contiguous same-side rows into segments.
 * `diffSegments` composes them for a whole file.
 *
 * So editing a diff is just normal editing of the new document (write-through); removed lines
 * are real, non-editable view rows over the base — not EOL virtual text. Pure + GTK-free.
 */
import { diffLines, type DiffOp } from '../../util/lineDiff.ts';
import type { Item, Segment } from '../TextEditor/ViewProjection.ts';

/** One diff row: its op + the old/new source-line index it sits at (the irrelevant side
 *  holds the current cursor, for stable windowing — `eq` advances both, `ins` new, `del` old). */
export interface DiffRow {
  op: DiffOp;
  oldRow: number;
  newRow: number;
}

export interface DiffProjection {
  /** Segments for `ViewProjection.build` (new-side editable real + old-side phantom). */
  items: Item[];
  /** The diff op of each projection row, in order — for decorations / fold-unchanged. */
  ops: DiffOp[];
}

/** The per-row line diff of OLD → NEW, in forward order, with both side indices. */
export function diffRows(oldLines: readonly string[], newLines: readonly string[]): DiffRow[] {
  const ops = diffLines(oldLines, newLines);
  const rows: DiffRow[] = [];
  let oldRow = 0;
  let newRow = 0;
  for (const op of ops) {
    rows.push({ op, oldRow, newRow });
    if (op === 'eq') {
      oldRow++;
      newRow++;
    } else if (op === 'ins') {
      newRow++;
    } else {
      oldRow++;
    }
  }
  return rows;
}

/**
 * Turn a CONTIGUOUS run of diff rows into projection items: `eq`/`ins` map to the new source,
 * `del` to the old blob; contiguous same-side rows merge into one segment. (`del` between two
 * new runs splits them — view order stays correct.)
 */
export function rowsToItems(rows: readonly DiffRow[], newKey: string, oldKey: string): DiffProjection {
  const items: Item[] = [];
  const ops: DiffOp[] = [];
  let cur: Segment | null = null;
  for (const rec of rows) {
    const isNew = rec.op !== 'del';
    const documentKey = isNew ? newKey : oldKey;
    const sourceRow = isNew ? rec.newRow : rec.oldRow;
    const kind: Segment['kind'] = isNew ? 'real' : 'phantom';
    if (cur && cur.documentKey === documentKey && cur.kind === kind && sourceRow === cur.endRow + 1) {
      cur.endRow = sourceRow;
    } else {
      cur = { documentKey, startRow: sourceRow, endRow: sourceRow, editable: isNew, kind };
      items.push({ type: 'segment', segment: cur });
    }
    ops.push(rec.op);
  }
  return { items, ops };
}

/** Build the diff projection items for a whole file OLD → NEW. */
export function diffSegments(
  oldLines: readonly string[],
  newLines: readonly string[],
  newKey: string,
  oldKey: string,
): DiffProjection {
  return rowsToItems(diffRows(oldLines, newLines), newKey, oldKey);
}
