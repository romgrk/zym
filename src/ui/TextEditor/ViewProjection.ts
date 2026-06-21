/*
 * ViewProjection — the unified per-view coordinate substrate behind every TextEditor (the
 * keystone of tasks/code-editing/multibuffer.md, Phase 2). It models what one
 * GtkSource.View shows as an ordered list of ITEMS — `segment`s (a contiguous row range of
 * some source) and `block`s (synthesized header / gap / blank rows) — and provides the
 * coordinate map between three spaces:
 *
 *   source  (sourceKey, row, col)   text living in each source model buffer
 *     ↕   segment map     (generalizes MultiBufferModel; single file = identity)
 *   projection (row, col)           the items concatenated into one stream
 *     ↕   fold transform  (collapsed projection ranges → placeholders)
 *   view    (row, col)              what's actually shown / lives in the view buffer
 *
 * A normal file is the degenerate case: ONE full-file segment, no blocks, no folds — every
 * translation is identity and short-circuits (the zero-cost single-file path; hard problem
 * #6 / G10). Stitching many sources (the multibuffer) is the same machinery with more
 * items; folds are just another transform on top (hard problem #3) — so a fold and an
 * excerpt boundary live in one coordinate stack instead of two mechanisms.
 *
 * Pure + GTK-free so the coordinate math is unit-tested in isolation (ViewProjection.test.ts)
 * — the place a stitched-coordinate or fold-composition bug must surface. The materialize +
 * reverse-sync (2b), edit write-through (2c), and live-fold (2d) layers sit on TOP of this.
 *
 * Offsets and columns are COUNTED IN CODEPOINTS, to match GtkTextBuffer iter semantics — a
 * JS string's UTF-16 `.length` differs only on astral text, but the editor is careful about
 * it elsewhere (toCodepointColumn), so the substrate is too.
 */

export type SegmentKind = 'real' | 'phantom';

/** A contiguous slice of one source projected into the view. */
export interface Segment {
  /** Stable key for the source (a file path / blob id). The materialize layer maps it to
   *  a `Document` / parsed blob. */
  sourceKey: string;
  /** Source model rows `[startRow, endRow]` (inclusive) this segment projects. */
  startRow: number;
  endRow: number;
  /** Whether edits on these rows write through to the source. A single-file segment is
   *  editable; diff "removed" rows / headers are not. */
  editable: boolean;
  /** `real` = mapped to live source text; `phantom` = synthesized read-only rows (a diff's
   *  removed lines, mapped to a base blob). */
  kind: SegmentKind;
}

export type BlockKind = 'header' | 'gap' | 'blank';

/** A synthesized, non-source row (a filename header, a `⋯` elision gap, a blank separator).
 *  Never editable; carries no source mapping. */
export interface Block {
  kind: BlockKind;
  text: string;
}

/** One entry in the ordered projection: a source slice or a synthesized block. */
export type Item =
  | { type: 'segment'; segment: Segment }
  | { type: 'block'; block: Block };

/** Resolve a segment to its source text rows (`endRow - startRow + 1` of them, each WITHOUT
 *  a trailing newline). For a single full-file segment this is the file split on '\n'
 *  (the trailing empty element included, so a join round-trips the file exactly). */
export type ResolveLines = (segment: Segment) => string[];

/** A position resolved back to a source. */
export interface SourcePosition {
  sourceKey: string;
  row: number;
  column: number;
  /** Index into the projection's segments (which segment carried it). */
  segmentIndex: number;
}

/** What a view position maps down to. `block` = a synthesized row (header/gap/blank);
 *  `fold` = inside a collapsed placeholder (no live source position). */
export type ViewTarget =
  | ({ kind: 'source' } & SourcePosition)
  | { kind: 'block'; block: BlockKind }
  | { kind: 'fold' };

/** Per-projection-row metadata: which item produced it, and (for a segment row) the source
 *  row it shows. One entry per projection row — simple and O(rows); a run-length / sum-tree
 *  index is a Phase-4 perf concern, not a correctness one. */
type RowInfo =
  | { kind: 'segment'; sourceKey: string; sourceRow: number; editable: boolean; segmentIndex: number }
  | { kind: BlockKind };

/** A collapsed run, in PROJECTION codepoint offsets `[start, end)`, shown as `placeholder`.
 *  The fold transform splices these out of the projection to form the view. Returned by
 *  `addFold` as an opaque HANDLE: its `start`/`end` are mutated in place as edits shift the
 *  projection (the analytic equivalent of today's fold marks), so a held handle stays live. */
export interface Fold {
  start: number;
  end: number;
  placeholder: string;
}

// --- codepoint helpers (GtkTextBuffer counts characters, JS strings count UTF-16 units) ---

/** Codepoint length of `s` (surrogate pairs count as one). */
function cpLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Rightmost index `i` with `starts[i] <= value` (the row/fold containing an offset). */
function lastLE(starts: number[], value: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export class ViewProjection {
  /** The concatenated projection text (segments + blocks), pre-fold. */
  readonly projectionText: string;
  /** Number of projection rows (== projection buffer line count). */
  readonly projectionRowCount: number;

  private readonly items: Item[];
  private readonly segments: Segment[];
  private readonly rows: string[]; // projection rows (the literal lines; join('\n') == text)
  private readonly rowInfo: RowInfo[];
  private readonly projRowStart: number[]; // codepoint offset of each projection row's start
  /** A single full-file segment with no blocks: projection row === source row, so every
   *  source↔projection step is identity and can short-circuit. */
  private readonly singleSource: boolean;
  private readonly soleSourceKey: string | null;

  // --- fold state (projection↔view); mutated by addFold/removeFold/clearFolds ---
  private folds: Fold[] = []; // sorted ascending by `start`, non-overlapping
  // View text + line-start table, derived from the projection + current folds. Rebuilt
  // (lazily) whenever folds change; null when no folds (view == projection, identity).
  private _viewText: string | null = null;
  private _viewRowStart: number[] | null = null;

  private constructor(
    items: Item[],
    segments: Segment[],
    rows: string[],
    rowInfo: RowInfo[],
    projRowStart: number[],
  ) {
    this.items = items;
    this.segments = segments;
    this.rows = rows;
    this.rowInfo = rowInfo;
    this.projRowStart = projRowStart;
    this.projectionText = rows.join('\n');
    this.projectionRowCount = rows.length;
    const seg = items.length === 1 && items[0].type === 'segment' ? items[0].segment : null;
    this.singleSource = !!seg && seg.startRow === 0;
    this.soleSourceKey = this.singleSource ? seg!.sourceKey : null;
  }

  /**
   * Build a projection from an ordered item list. `resolveLines(segment)` returns the
   * source rows the segment covers. The single-file case is `build([{type:'segment',
   * segment:{sourceKey, startRow:0, endRow:lastRow, editable:true, kind:'real'}}], …)`.
   */
  static build(items: Item[], resolveLines: ResolveLines): ViewProjection {
    const rows: string[] = [];
    const rowInfo: RowInfo[] = [];
    const segments: Segment[] = [];
    items.forEach((item) => {
      if (item.type === 'block') {
        rows.push(item.block.text);
        rowInfo.push({ kind: item.block.kind });
        return;
      }
      const seg = item.segment;
      const segmentIndex = segments.length;
      segments.push(seg);
      const body = resolveLines(seg);
      body.forEach((line, i) => {
        rows.push(line);
        rowInfo.push({
          kind: 'segment',
          sourceKey: seg.sourceKey,
          sourceRow: seg.startRow + i,
          editable: seg.editable,
          segmentIndex,
        });
      });
    });
    // Codepoint offset of each row start: prior rows' codepoints + one '\n' separator each.
    const projRowStart: number[] = new Array(rows.length);
    let off = 0;
    for (let r = 0; r < rows.length; r++) {
      projRowStart[r] = off;
      off += cpLength(rows[r]) + 1; // +1 for the row's trailing '\n'
    }
    return new ViewProjection(items, segments, rows, rowInfo, projRowStart);
  }

  // --- folds (projection↔view transform) -------------------------------------

  /** Whether every translation short-circuits to identity (single full-file source, no
   *  collapsed folds). The common single-file path pays nothing. */
  get isIdentity(): boolean {
    return this.singleSource && this.folds.length === 0;
  }

  /** Whether this projects a single full-file source (segment map is identity, folds aside).
   *  The sync layer uses this — not `isIdentity` — so single-file editing stays incremental
   *  WITH folds present (folds are handled as an offset transform, not a re-segment). */
  get isSingleSource(): boolean {
    return this.singleSource;
  }

  /** The sole source key for a single-source projection (else null). */
  get soleKey(): string | null {
    return this.soleSourceKey;
  }

  /** Collapse projection codepoint range `[start, end)` to `placeholder`. Returns the fold
   *  HANDLE (or null if empty). Folds are kept sorted by start; callers ensure they don't
   *  overlap (a fold subsuming inner folds drops them via `removeFoldsWithin` first). */
  addFold(start: number, end: number, placeholder: string): Fold | null {
    if (end <= start) return null;
    const fold: Fold = { start, end, placeholder };
    this.folds.push(fold);
    this.folds.sort((a, b) => a.start - b.start);
    this.invalidateView();
    return fold;
  }

  /** Remove a fold by handle (no-op if already gone). */
  removeFold(fold: Fold): void {
    const i = this.folds.indexOf(fold);
    if (i >= 0) {
      this.folds.splice(i, 1);
      this.invalidateView();
    }
  }

  /** Drop every fold whose projection range lies within `[start, end]` — used when a new
   *  outer fold subsumes inner ones (their bodies are now part of its collapsed range). */
  removeFoldsWithin(start: number, end: number): void {
    const before = this.folds.length;
    this.folds = this.folds.filter((f) => !(f.start >= start && f.end <= end));
    if (this.folds.length !== before) this.invalidateView();
  }

  clearFolds(): void {
    if (this.folds.length === 0) return;
    this.folds = [];
    this.invalidateView();
  }

  /** The collapsed runs (live handles), sorted by start. */
  foldSpans(): ReadonlyArray<Fold> {
    return this.folds;
  }

  /** The fold whose collapsed range contains projection offset `off` (inclusive of both
   *  ends), or null — so the sync layer can tell an edit absorbed by a fold from one it
   *  must mirror into the view. */
  foldContaining(off: number): Fold | null {
    for (const f of this.folds) if (off >= f.start && off <= f.end) return f;
    return null;
  }

  /** Public offset transforms (projection ↔ view, codepoints) for the sync layer. They use
   *  only the fold spans — independent of the (possibly stale-after-edit) row arrays — so a
   *  single-source view translates correctly off the live buffers + shifted fold spans. */
  projOffsetToView(off: number): number {
    return this.projToViewOffset(off);
  }
  viewOffsetToProj(off: number): number {
    return this.viewToProjOffset(off);
  }

  /** Shift fold spans for an insert of `len` codepoints at projection offset `off` — the
   *  analytic equivalent of left-gravity start / right-gravity end marks (Document's folds):
   *  a fold strictly after the insert shifts whole; an insert at/inside `[start, end]` grows
   *  the fold (absorbed). Mutates handles in place so held handles stay live. */
  shiftFoldsForInsert(off: number, len: number): void {
    if (len <= 0 || this.folds.length === 0) return;
    for (const f of this.folds) {
      if (off < f.start) f.start += len;
      if (off <= f.end) f.end += len;
    }
    this.invalidateView();
  }

  /** Shift fold spans for a delete of projection range `[start, end)`: a boundary after the
   *  range shifts left by its length; a boundary inside it clamps to `start` (so a fold whose
   *  body is partly/wholly deleted shrinks). Folds emptied to nothing are dropped. */
  shiftFoldsForDelete(start: number, end: number): void {
    if (end <= start || this.folds.length === 0) return;
    const d = end - start;
    const shift = (p: number): number => (p <= start ? p : p >= end ? p - d : start);
    for (const f of this.folds) {
      f.start = shift(f.start);
      f.end = shift(f.end);
    }
    this.folds = this.folds.filter((f) => f.end > f.start);
    this.folds.sort((a, b) => a.start - b.start);
    this.invalidateView();
  }

  private invalidateView(): void {
    this._viewText = null;
    this._viewRowStart = null;
  }

  /** The view text: projection with each fold range replaced by its placeholder. */
  get viewText(): string {
    if (this.folds.length === 0) return this.projectionText;
    if (this._viewText !== null) return this._viewText;
    const cps = [...this.projectionText];
    const out: string[] = [];
    let cursor = 0;
    for (const f of this.folds) {
      out.push(cps.slice(cursor, f.start).join(''));
      out.push(f.placeholder);
      cursor = f.end;
    }
    out.push(cps.slice(cursor).join(''));
    return (this._viewText = out.join(''));
  }

  /** Number of view rows (== view buffer line count). */
  get viewRowCount(): number {
    return this.viewRowStarts().length;
  }

  private viewRowStarts(): number[] {
    if (this.folds.length === 0) return this.projRowStart;
    if (this._viewRowStart !== null) return this._viewRowStart;
    const starts: number[] = [0];
    const text = this.viewText;
    let off = 0;
    for (const ch of text) {
      off++;
      if (ch === '\n') starts.push(off);
    }
    return (this._viewRowStart = starts);
  }

  // --- offset ↔ (row, col), per space ----------------------------------------

  private projOffsetAt(row: number, column: number): number {
    return this.projRowStart[Math.max(0, Math.min(row, this.projectionRowCount - 1))] + column;
  }

  private projRowColAt(offset: number): [number, number] {
    const row = lastLE(this.projRowStart, offset);
    return [row, offset - this.projRowStart[row]];
  }

  private viewOffsetAt(row: number, column: number): number {
    const starts = this.viewRowStarts();
    return starts[Math.max(0, Math.min(row, starts.length - 1))] + column;
  }

  private viewRowColAt(offset: number): [number, number] {
    const starts = this.viewRowStarts();
    const row = lastLE(starts, offset);
    return [row, offset - starts[row]];
  }

  // --- fold offset transform (projection ↔ view) -----------------------------
  // Each fold shifts everything after it by `placeholderLen - rangeLen` (negative when
  // collapsing). A position inside a fold collapses to its placeholder start. Mirrors the
  // mark-based Document.toModelOffset/toViewOffset, but analytic (recomputed from `folds`).

  private projToViewOffset(projOffset: number): number {
    if (this.folds.length === 0) return projOffset;
    let delta = 0;
    for (const f of this.folds) {
      if (f.end <= projOffset) delta += cpLength(f.placeholder) - (f.end - f.start);
      else if (f.start < projOffset) return f.start + delta; // inside the collapsed range
      else break;
    }
    return projOffset + delta;
  }

  private viewToProjOffset(viewOffset: number): number {
    if (this.folds.length === 0) return viewOffset;
    let collapsed = 0; // proj chars collapsed away before the current fold
    for (const f of this.folds) {
      const viewStart = f.start - collapsed;
      const viewEnd = viewStart + cpLength(f.placeholder);
      if (viewEnd <= viewOffset) collapsed += (f.end - f.start) - cpLength(f.placeholder);
      else if (viewStart <= viewOffset) return f.start; // inside (or at the start of) the placeholder
      else break;
    }
    return viewOffset + collapsed;
  }

  /** Each fold's `[viewStart, viewEnd)` codepoint range in VIEW space (the placeholder it
   *  occupies) alongside its projection range — so position lookups detect a placeholder
   *  hit exactly (the placeholder start is part of the fold, not the source row before it). */
  private foldViewRanges(): Array<{ vs: number; ve: number }> {
    const out: Array<{ vs: number; ve: number }> = [];
    let collapsed = 0;
    for (const f of this.folds) {
      const vs = f.start - collapsed;
      const ve = vs + cpLength(f.placeholder);
      out.push({ vs, ve });
      collapsed += (f.end - f.start) - cpLength(f.placeholder);
    }
    return out;
  }

  // --- source ↔ projection (segment map) -------------------------------------

  /** Projection row showing `(sourceKey, sourceRow)`, or null if it isn't projected. The
   *  first segment that covers it wins (a row shown in two excerpts resolves to the first). */
  projectionRowForSource(sourceKey: string, sourceRow: number): number | null {
    if (this.singleSource) return sourceKey === this.soleSourceKey ? sourceRow : null;
    for (let r = 0; r < this.rowInfo.length; r++) {
      const info = this.rowInfo[r];
      if (info.kind === 'segment' && info.sourceKey === sourceKey && info.sourceRow === sourceRow) return r;
    }
    return null;
  }

  /** The source position shown at projection `row`, or null for a block row. */
  sourceAtProjectionRow(row: number): SourcePosition | null {
    const info = this.rowInfo[row];
    if (!info || info.kind !== 'segment') return null;
    return { sourceKey: info.sourceKey, row: info.sourceRow, column: 0, segmentIndex: info.segmentIndex };
  }

  // --- composed source ↔ view ------------------------------------------------

  /** The view position showing source `(sourceKey, row, column)`, or null if that source
   *  row isn't projected, or `{ folded: true }` shape collapsed — callers that don't care
   *  get the placeholder position. Columns are codepoints and pass through verbatim (a
   *  segment row is a verbatim copy of its source row). */
  sourceToView(sourceKey: string, row: number, column: number): { row: number; column: number } | null {
    if (this.isIdentity) {
      return sourceKey === this.soleSourceKey ? { row, column } : null;
    }
    if (this.folds.length === 0) {
      // No fold collapse → projection row == view row, columns pass through; index by the
      // (edit-stable) row map, so in-place reverse-sync needs no remap.
      const projRow = this.projectionRowForSource(sourceKey, row);
      return projRow === null ? null : { row: projRow, column };
    }
    const projRow = this.projectionRowForSource(sourceKey, row);
    if (projRow === null) return null;
    const viewOffset = this.projToViewOffset(this.projOffsetAt(projRow, column));
    const [vr, vc] = this.viewRowColAt(viewOffset);
    return { row: vr, column: vc };
  }

  /** What view `(row, column)` maps down to: a live source position, a synthesized block
   *  row, or inside a collapsed fold. */
  viewToSource(row: number, column: number): ViewTarget {
    if (this.isIdentity) {
      return { kind: 'source', sourceKey: this.soleSourceKey!, row, column, segmentIndex: 0 };
    }
    if (this.folds.length === 0) {
      // No fold collapse → view row == projection row, and segment rows are verbatim copies
      // (columns pass through). Index `rowInfo` directly — independent of the offset table,
      // which goes stale after an in-place edit until a remap; this stays valid as long as
      // the row COUNT is unchanged, so multi-source in-place editing needs no remap.
      const info = this.rowInfo[row];
      if (!info || info.kind !== 'segment') return { kind: 'block', block: (info?.kind ?? 'blank') as BlockKind };
      return { kind: 'source', sourceKey: info.sourceKey, row: info.sourceRow, column, segmentIndex: info.segmentIndex };
    }
    const viewOffset = this.viewOffsetAt(row, column);
    // Inside a placeholder: the view offset falls within a fold's view range.
    for (const r of this.foldViewRanges()) {
      if (viewOffset >= r.vs && viewOffset < r.ve) return { kind: 'fold' };
    }
    const projOffset = this.viewToProjOffset(viewOffset);
    const [projRow, projCol] = this.projRowColAt(projOffset);
    const info = this.rowInfo[projRow];
    if (!info || info.kind !== 'segment') {
      return { kind: 'block', block: (info?.kind ?? 'blank') as BlockKind };
    }
    return {
      kind: 'source',
      sourceKey: info.sourceKey,
      row: info.sourceRow,
      column: projCol,
      segmentIndex: info.segmentIndex,
    };
  }

  /** View row → source row (gutter line numbers); null for a block / folded row. */
  sourceRowAtViewRow(viewRow: number): { sourceKey: string; sourceRow: number } | null {
    const target = this.viewToSource(viewRow, 0);
    return target.kind === 'source' ? { sourceKey: target.sourceKey, sourceRow: target.row } : null;
  }

  /** View row showing source `(sourceKey, sourceRow)`, or null. */
  viewRowForSource(sourceKey: string, sourceRow: number): number | null {
    const pos = this.sourceToView(sourceKey, sourceRow, 0);
    return pos ? pos.row : null;
  }

  /** Contiguous runs of ONE segment's rows within view rows `[viewFrom, viewTo]` — what the
   *  multi-source painter iterates (each run highlighted from its source's own grammar). A run
   *  carries the source row span it covers + the view row it starts at, so the painter places
   *  it (viewRow = viewStart + sourceRow − fromSourceRow). Block rows break a run; folds split
   *  it (a folded source row isn't a live row). */
  segmentRunsInViewRange(
    viewFrom: number,
    viewTo: number,
  ): Array<{ sourceKey: string; fromSourceRow: number; toSourceRow: number; viewStart: number }> {
    const runs: Array<{
      sourceKey: string;
      segmentIndex: number;
      fromSourceRow: number;
      toSourceRow: number;
      viewStart: number;
    }> = [];
    let cur: (typeof runs)[number] | null = null;
    for (let row = Math.max(0, viewFrom); row <= viewTo; row++) {
      const t = this.viewToSource(row, 0);
      if (t.kind !== 'source') {
        cur = null;
        continue;
      }
      if (cur && cur.sourceKey === t.sourceKey && cur.segmentIndex === t.segmentIndex && t.row === cur.toSourceRow + 1) {
        cur.toSourceRow = t.row;
      } else {
        cur = { sourceKey: t.sourceKey, segmentIndex: t.segmentIndex, fromSourceRow: t.row, toSourceRow: t.row, viewStart: row };
        runs.push(cur);
      }
    }
    return runs.map(({ sourceKey, fromSourceRow, toSourceRow, viewStart }) => ({
      sourceKey,
      fromSourceRow,
      toSourceRow,
      viewStart,
    }));
  }

  // --- editability (write-through gating; hard problem #1) -------------------

  /** Whether view `(row, column)` is editable: a real, editable segment row not inside a
   *  fold. Block rows, phantom (diff-removed) rows, and folded ranges are not editable. */
  isViewPositionEditable(row: number, column: number): boolean {
    if (this.isIdentity) return true; // single editable full-file source
    const target = this.viewToSource(row, column);
    if (target.kind !== 'source') return false;
    const seg = this.segments[target.segmentIndex];
    return !!seg && seg.editable && seg.kind === 'real';
  }

  /** Whether a view range `[startRow..endRow]` is wholly editable AND maps to a single
   *  SEGMENT — the precondition for a write-through edit. A single source is not enough: two
   *  regions of one file are the same source but DIFFERENT segments, with hidden rows between
   *  them, so a view range spanning them maps to a non-contiguous source range. Such an edit
   *  must be rejected at the funnel (`setTextInBufferRange`), BEFORE GTK mutates the view —
   *  rejecting later (in write-through) is too late, since the view edit already happened and
   *  the view/source diverge (hard problem #1). Columns aren't needed: editability + segment
   *  membership are per-row. */
  isViewRangeEditable(startRow: number, endRow: number): boolean {
    if (this.isIdentity) return true;
    let segIndex: number | null = null;
    for (let r = startRow; r <= endRow; r++) {
      const target = this.viewToSource(r, 0);
      if (target.kind !== 'source') return false;
      const seg = this.segments[target.segmentIndex];
      if (!seg || !seg.editable || seg.kind !== 'real') return false;
      if (segIndex === null) segIndex = target.segmentIndex;
      else if (segIndex !== target.segmentIndex) return false; // spans a segment boundary / hidden gap
    }
    return true;
  }

  // --- block rows (for the materialize layer to style headers / gaps) --------

  /** Each block row's view position + kind (so the materialize/decorate layer can style
   *  filename headers and `⋯` gaps). Skips block rows hidden inside a fold. */
  blockRows(): Array<{ viewRow: number; kind: BlockKind }> {
    const out: Array<{ viewRow: number; kind: BlockKind }> = [];
    for (let projRow = 0; projRow < this.rowInfo.length; projRow++) {
      const info = this.rowInfo[projRow];
      if (info.kind === 'segment') continue;
      const viewOffset = this.projToViewOffset(this.projRowStart[projRow]);
      const [vr] = this.viewRowColAt(viewOffset);
      // A block row swallowed into a fold maps onto the placeholder row; skip it.
      const projOff = this.projRowStart[projRow];
      if (this.folds.some((f) => projOff >= f.start && projOff < f.end)) continue;
      out.push({ viewRow: vr, kind: info.kind });
    }
    return out;
  }
}
