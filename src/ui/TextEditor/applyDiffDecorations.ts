/*
 * applyDiffDecorations — paint a diff's line backgrounds (and intra-line word
 * spans) onto an editor decoration layer. Shared by the unified `DiffView` and
 * the side-by-side panes, which pass their respective line arrays (both carry a
 * `kind`, `text`, and optional `wordRanges`).
 */
import { Point } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';
import type { DecorationLayer } from './TextDecorations.ts';
import type { WordRange } from '../../util/wordDiff.ts';

export type { WordRange };

interface DecoratableLine {
  kind: string;
  text: string;
  wordRanges?: WordRange[];
}

const WORD_STYLE = { added: 'word-add', removed: 'word-del' } as const;

/**
 * Re-sync `layer` with `lines`' diff decorations (full-line backgrounds for
 * added/removed/filler, plus word-level spans on modified lines).
 *
 * A full-line background spans `[row, 0)`→`[row+1, 0)` so it covers the line's
 * trailing newline (paragraph-background paints the paragraph that newline belongs
 * to). The final line of an **unterminated** buffer (`terminated === false`) has no
 * next line, so that range would collapse to empty (the end point clamps back to the
 * row start) — span its content instead, which still paints the whole paragraph. An
 * empty unterminated last line can't be painted at all, so callers terminate the
 * buffer in exactly that case (see `needsTrailingNewline`).
 */
export function applyDiffDecorations(
  layer: DecorationLayer,
  lines: readonly DecoratableLine[],
  terminated: boolean = true,
): void {
  layer.clear();
  const lastRow = lines.length - 1;
  lines.forEach((line, row) => {
    if (line.kind === 'context') return;
    const fullLine =
      !terminated && row === lastRow
        ? new Range(new Point(row, 0), new Point(row, [...line.text].length))
        : new Range(new Point(row, 0), new Point(row + 1, 0));
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
