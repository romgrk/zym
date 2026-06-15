/*
 * applyDiffDecorations — paint a diff's line backgrounds (and intra-line word
 * spans) onto an editor decoration layer. Shared by the unified `DiffView` and
 * the side-by-side panes, which pass their respective line arrays (both carry a
 * `kind` and optional `wordRanges`).
 */
import { Point } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';
import type { DecorationLayer } from './DecorationController.ts';
import type { WordRange } from '../../util/DiffModel.ts';

interface DecoratableLine {
  kind: string;
  wordRanges?: WordRange[];
}

const WORD_STYLE = { added: 'word-add', removed: 'word-del' } as const;

/** Re-sync `layer` with `lines`' diff decorations (full-line backgrounds for
 *  added/removed/filler, plus word-level spans on modified lines). */
export function applyDiffDecorations(layer: DecorationLayer, lines: readonly DecoratableLine[]): void {
  layer.clear();
  lines.forEach((line, row) => {
    if (line.kind === 'context') return;
    const fullLine = new Range(new Point(row, 0), new Point(row + 1, 0));
    if (line.kind === 'filler') {
      layer.decorate(fullLine, 'filler');
      return;
    }
    // added | removed: full-line background, plus the changed chars within it.
    layer.decorate(fullLine, line.kind as 'added' | 'removed');
    const wordStyle = WORD_STYLE[line.kind as 'added' | 'removed'];
    if (wordStyle && line.wordRanges) {
      for (const [start, end] of line.wordRanges) {
        layer.decorate(new Range(new Point(row, start), new Point(row, end)), wordStyle);
      }
    }
  });
}
