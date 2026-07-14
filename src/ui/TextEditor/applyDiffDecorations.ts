/*
 * applyDiffDecorations — paint a diff's line backgrounds (and intra-line word
 * spans) onto an editor decoration layer, from the per-row kinds the diff
 * multibuffer computes (`DiffMultiBuffer.rowKinds` / `wordRanges`).
 */
import type { DecorationLayer } from './TextDecorations.ts';
import type { RowWindow } from './Screen.ts';
import type { WordRange } from '../../util/wordDiff.ts';

export type { WordRange };

interface DecoratableLine {
  kind: string;
  wordRanges?: WordRange[];
}

const WORD_STYLE = { added: 'word-add', removed: 'word-del' } as const;

/**
 * Re-sync `layer` with `lines`' diff decorations: full-line backgrounds for
 * added/removed rows — contiguous same-kind rows painted as ONE range, since each
 * application is a native tag call — plus word-level spans on modified lines.
 * Row-run backgrounds span each run's trailing newline (`decorateRows`), so the
 * paragraph background covers the full lines even on an unterminated final row.
 *
 * `window` (when given) scopes the re-sync to those rows: only they are cleared and
 * re-decorated. For a splice that changed a small span of a large view, the rows
 * outside kept their text — and tags ride edits — so their decorations are already
 * correct, while a buffer-wide clear invalidates the whole layout.
 */
export function applyDiffDecorations(layer: DecorationLayer, lines: readonly DecoratableLine[], window?: RowWindow): void {
  const from = window ? Math.max(0, window.from) : 0;
  const toExclusive = window ? Math.min(lines.length, window.toExclusive) : lines.length;
  if (window) layer.clearRows(from, toExclusive);
  else layer.clear();
  for (let row = from; row < toExclusive; ) {
    const kind = lines[row].kind;
    if (kind !== 'added' && kind !== 'removed') {
      row++;
      continue;
    }
    let end = row;
    while (end + 1 < toExclusive && lines[end + 1].kind === kind) end++;
    layer.decorateRows(row, end + 1, kind);
    // The changed chars within each modified line, over the run's full-line background.
    for (let r = row; r <= end; r++) {
      const wordRanges = lines[r].wordRanges;
      if (!wordRanges) continue;
      for (const [start, stop] of wordRanges) layer.decorateSpan(r, start, stop, WORD_STYLE[kind]);
    }
    row = end + 1;
  }
}
