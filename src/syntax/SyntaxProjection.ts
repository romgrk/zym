/*
 * SyntaxProjection — how the per-view painter (`SyntaxController`) sources highlight
 * captures when the view is NOT a 1:1 window on a single Document. The painter normally
 * paints one `DocumentSyntax` translated through its fold projection; a projection lets it
 * instead paint MANY sources stitched into one buffer — the multibuffer (one parse per
 * source Document, projected at translated rows). This is the plan's "translate model→view
 * through that view's projection: folds today, excerpts later".
 *
 * The painter owns the buffer + its `HighlightTags` and builds the iters; a projection only
 * says, for a visible view-row range, which sources to query and where their rows land.
 */
import type { DocumentSyntax } from './DocumentSyntax.ts';

/** One source's contribution to a visible view-row range: query `[fromRow, toRow]` of
 *  `syntax` (source model rows) and paint each captured `sourceRow` at view row
 *  `viewStart + (sourceRow - sourceStart)`. The mapping is linear (a contiguous slice). */
export interface SyntaxSlice {
  syntax: DocumentSyntax;
  fromRow: number;
  toRow: number;
  /** The source row shown at `viewStart`. */
  sourceStart: number;
  /** The view row showing `sourceStart`. */
  viewStart: number;
}

export interface SyntaxProjection {
  /** Whether any source has a parse to read (else the painter no-ops). */
  hasContent(): boolean;
  /** The slices overlapping view rows `[viewFrom, viewTo]` (inclusive), clamped to the
   *  visible portion of each so an off-screen excerpt isn't queried. */
  paintSlices(viewFrom: number, viewTo: number): SyntaxSlice[];
  /** Subscribe to any source reparse (a live-edited source re-projects); returns a
   *  disposer. The painter repaints on fire. */
  onDidReparse(callback: () => void): () => void;
  /** Lazily parse the sources whose excerpts overlap view rows `[viewFrom, viewTo]` — for a
   *  multibuffer whose excerpt sources parse on demand as they near the viewport, rather than
   *  all up front. The editor (`TextEditor`) calls this on viewport change. Idempotent per
   *  source. Optional: a projection whose sources are always parsed omits it. */
  ensureParsedForRange?(viewFrom: number, viewTo: number): void;
  /** Style the non-source rows (filename headers, `⋯` gaps) on `buffer` — invoked after a
   *  full repaint. Tag creation/idempotency is the projection's concern. */
  decorate(buffer: any): void;
}
