/*
 * MultiBufferModel — the multibuffer's excerpt LAYOUT (docs/text-editor/multibuffer.md). It
 * models a multi-file surface as a list of **excerpts** (a filename header + ordered source
 * **segments**) and flattens them into the ordered `Item[]` that `CoordinatesMap` (the unified
 * coordinate substrate) materializes: a blank separator between excerpts, a header row, each
 * segment's rows, and a `⋯` gap row between non-adjacent segments of one file.
 *
 * The coordinate math (view ↔ source, painting runs, block-row styling) now lives in
 * `CoordinatesMap` — this is just the multibuffer-specific item layout on top of it; the
 * `MultiBufferProjection` class that used to own the coordinate map was retired when the
 * single-file editor and the multibuffer were unified onto one substrate (Phase 3a).
 */
import type { Item, Segment as ProjectionSegment } from '../TextEditor/CoordinatesMap.ts';

/** A contiguous slice of one source, projected into the multibuffer. Re-exported from the
 *  unified substrate so excerpt builders keep a stable import here. */
export type Segment = ProjectionSegment;

/** One excerpt: a header (filename) + ordered segments (one source each; gaps between
 *  non-adjacent segments of the same file). */
export interface Excerpt {
  /** The header label shown as a non-editable block row (e.g. the file path). */
  header: string;
  segments: Segment[];
}

/** A matched span within a source line (e.g. a project-search hit), to highlight in the view.
 *  `row` is a 0-based SOURCE line; `startCol`/`endCol` are codepoint columns within it. */
export interface MatchRange {
  row: number;
  startCol: number;
  endCol: number;
}

/** The label shown on a gap row between two non-adjacent segments of one file. */
export const GAP_LABEL = '⋯';

export interface ExcerptLayoutOptions {
  /** How the filename header + gaps are rendered. `'block'` (default) emits a header text row in
   *  the buffer (plus a blank separator between excerpts and a `⋯` gap row between non-adjacent
   *  segments). `'widget'` emits NONE of those rows — the surface draws each header AND gap as a
   *  real widget band (so neither is navigable/copyable buffer text); only real source segments
   *  reach the buffer. */
  headers?: 'block' | 'widget';
}

/**
 * Flatten `excerpts` into the ordered projection items `CoordinatesMap.build` consumes.
 * Block-header layout per excerpt: a blank separator before all but the first, a header row,
 * then each segment's rows with a `⋯` gap row between non-adjacent segments of the same
 * excerpt. Widget-header layout drops the blank + header rows (see `ExcerptLayoutOptions`).
 */
export function excerptsToItems(excerpts: Excerpt[], opts: ExcerptLayoutOptions = {}): Item[] {
  const widgetHeaders = opts.headers === 'widget';
  const items: Item[] = [];
  excerpts.forEach((excerpt, excerptIndex) => {
    if (!widgetHeaders) {
      if (excerptIndex > 0) items.push({ type: 'block', block: { kind: 'blank', text: '' } });
      items.push({ type: 'block', block: { kind: 'header', text: excerpt.header } });
    }
    excerpt.segments.forEach((segment, segmentIndex) => {
      // Block-header layout emits a `⋯` gap row between non-adjacent segments; widget layout emits
      // none — the surface draws each gap as a widget band (so it's not navigable/copyable text),
      // exactly like the headers.
      if (segmentIndex > 0 && !widgetHeaders) items.push({ type: 'block', block: { kind: 'gap', text: GAP_LABEL } });
      items.push({ type: 'segment', segment });
    });
  });
  return items;
}
