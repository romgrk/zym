/*
 * CoordinatesMap — the unified per-view coordinate substrate behind every TextEditor (the
 * keystone of docs/text-editor/multibuffer.md, Phase 2). It models what one
 * GtkSource.View shows as an ordered list of ITEMS — `segment`s (a contiguous row range of
 * some document) and `block`s (synthesized header / gap / blank rows) — and provides the
 * coordinate map between the three spaces of docs/text-editor/coordinates.md:
 *
 *   document  (documentKey, row, col)   text living in each document model buffer
 *     ↕   segment map     (generalizes MultiBufferModel; single file = identity)
 *   buffer    (row, col)                the items concatenated into one stream
 *     ↕   fold transform  (collapsed buffer ranges → placeholders)
 *   screen    (row, col)                what's actually shown / lives in the view buffer
 *
 * A normal file is the degenerate case: ONE full-file segment, no blocks, no folds — every
 * translation is identity and short-circuits (the zero-cost single-file path; hard problem
 * #6 / G10). Stitching many documents (the multibuffer) is the same machinery with more
 * items; folds are just another transform on top (hard problem #3) — so a fold and an
 * excerpt boundary live in one coordinate stack instead of two mechanisms.
 *
 * Pure + GTK-free so the coordinate math is unit-tested in isolation (CoordinatesMap.test.ts)
 * — the place a stitched-coordinate or fold-composition bug must surface. The materialize +
 * reverse-sync (2b), edit write-through (2c), and live-fold (2d) layers sit on TOP of this.
 *
 * Offsets and columns are COUNTED IN CODEPOINTS, to match GtkTextBuffer iter semantics — a
 * JS string's UTF-16 `.length` differs only on astral text, but the editor is careful about
 * it elsewhere (toCodepointColumn), so the substrate is too.
 */

export type SegmentKind = 'real' | 'phantom';

/** A contiguous slice of one document projected into the screen. */
export interface Segment {
  /** Stable key for the document (a file path / blob id). The materialize layer maps it to
   *  a `Document` / parsed blob. */
  documentKey: string;
  /** Document model rows `[startRow, endRow]` (inclusive) this segment projects. */
  startRow: number;
  endRow: number;
  /** Whether edits on these rows write through to the document. A single-file segment is
   *  editable; diff "removed" rows / headers are not. */
  editable: boolean;
  /** `real` = mapped to live document text; `phantom` = synthesized read-only rows (a diff's
   *  removed lines, mapped to a base blob). */
  kind: SegmentKind;
}

export type BlockKind = 'header' | 'gap' | 'blank';

/** A synthesized, non-document row (a filename header, a `⋯` elision gap, a blank separator).
 *  Never editable; carries no document mapping. */
export interface Block {
  kind: BlockKind;
  text: string;
}

/** One entry in the ordered buffer: a document slice or a synthesized block. */
export type Item =
  | { type: 'segment'; segment: Segment }
  | { type: 'block'; block: Block };

/** Resolve a segment to its document text rows (`endRow - startRow + 1` of them, each WITHOUT
 *  a trailing newline). For a single full-file segment this is the file split on '\n'
 *  (the trailing empty element included, so a join round-trips the file exactly). */
export type ResolveLines = (segment: Segment) => string[];

/** A position resolved back to a document. */
export interface DocumentPosition {
  documentKey: string;
  row: number;
  column: number;
  /** Index into the buffer's segments (which segment carried it). */
  segmentIndex: number;
}

/** What a screen position maps down to. `block` = a synthesized row (header/gap/blank);
 *  `fold` = inside a collapsed placeholder (no live document position). */
export type ScreenTarget =
  | ({ kind: 'document' } & DocumentPosition)
  | { kind: 'block'; block: BlockKind }
  | { kind: 'fold' };

/** Per-buffer-row metadata: which item produced it, and (for a segment row) the document
 *  row it shows. One entry per buffer row — simple and O(rows); a run-length / sum-tree
 *  index is a Phase-4 perf concern, not a correctness one. */
type RowInfo =
  | { kind: 'segment'; documentKey: string; documentRow: number; editable: boolean; segmentIndex: number }
  | { kind: BlockKind };

/** A collapsed run, in BUFFER codepoint offsets `[start, end)`, shown as `placeholder`.
 *  The fold transform splices these out of the buffer to form the screen. Returned by
 *  `addFold` as an opaque HANDLE: its `start`/`end` are mutated in place as edits shift the
 *  buffer (the analytic equivalent of today's fold marks), so a held handle stays live. */
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

export class CoordinatesMap {
  /** The concatenated buffer text (segments + blocks), pre-fold. */
  readonly bufferText: string;
  /** Number of buffer rows (== buffer line count). */
  readonly bufferRowCount: number;

  private readonly items: Item[];
  private readonly segments: Segment[];
  private readonly rows: string[]; // buffer rows (the literal lines; join('\n') == text)
  private readonly rowInfo: RowInfo[];
  private readonly bufferRowStart: number[]; // codepoint offset of each buffer row's start
  /** A single full-file segment with no blocks: buffer row === document row, so every
   *  document↔buffer step is identity and can short-circuit. */
  private readonly singleDocument: boolean;
  private readonly _soleDocumentKey: string | null;

  // --- fold state (buffer↔screen); mutated by addFold/removeFold/clearFolds ---
  private folds: Fold[] = []; // sorted ascending by `start`, non-overlapping
  // Screen text + line-start table, derived from the buffer + current folds. Rebuilt
  // (lazily) whenever folds change; null when no folds (screen == buffer, identity).
  private _screenText: string | null = null;
  private _screenRowStart: number[] | null = null;

  private constructor(
    items: Item[],
    segments: Segment[],
    rows: string[],
    rowInfo: RowInfo[],
    bufferRowStart: number[],
  ) {
    this.items = items;
    this.segments = segments;
    this.rows = rows;
    this.rowInfo = rowInfo;
    this.bufferRowStart = bufferRowStart;
    this.bufferText = rows.join('\n');
    this.bufferRowCount = rows.length;
    const seg = items.length === 1 && items[0].type === 'segment' ? items[0].segment : null;
    this.singleDocument = !!seg && seg.startRow === 0;
    this._soleDocumentKey = this.singleDocument ? seg!.documentKey : null;
  }

  /**
   * Build a CoordinatesMap from an ordered item list. `resolveLines(segment)` returns the
   * document rows the segment covers. The single-file case is `build([{type:'segment',
   * segment:{documentKey, startRow:0, endRow:lastRow, editable:true, kind:'real'}}], …)`.
   */
  static build(items: Item[], resolveLines: ResolveLines): CoordinatesMap {
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
          documentKey: seg.documentKey,
          documentRow: seg.startRow + i,
          editable: seg.editable,
          segmentIndex,
        });
      });
    });
    // Codepoint offset of each row start: prior rows' codepoints + one '\n' separator each.
    const bufferRowStart: number[] = new Array(rows.length);
    let off = 0;
    for (let r = 0; r < rows.length; r++) {
      bufferRowStart[r] = off;
      off += cpLength(rows[r]) + 1; // +1 for the row's trailing '\n'
    }
    return new CoordinatesMap(items, segments, rows, rowInfo, bufferRowStart);
  }

  // --- folds (buffer↔screen transform) -------------------------------------

  /** Whether every translation short-circuits to identity (single full-file document, no
   *  collapsed folds). The common single-file path pays nothing. */
  get isIdentity(): boolean {
    return this.singleDocument && this.folds.length === 0;
  }

  /** Whether this projects a single full-file document (segment map is identity, folds aside).
   *  The sync layer uses this — not `isIdentity` — so single-file editing stays incremental
   *  WITH folds present (folds are handled as an offset transform, not a re-segment). */
  get isSingleDocument(): boolean {
    return this.singleDocument;
  }

  /** The sole document key for a single-document buffer (else null). */
  get soleDocumentKey(): string | null {
    return this._soleDocumentKey;
  }

  /** Collapse buffer codepoint range `[start, end)` to `placeholder`. Returns the fold
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

  /** Drop every fold whose buffer range lies within `[start, end]` — used when a new
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

  /** The fold whose collapsed range contains buffer offset `off` (inclusive of both
   *  ends), or null — so the sync layer can tell an edit absorbed by a fold from one it
   *  must mirror into the view. */
  foldContaining(off: number): Fold | null {
    for (const f of this.folds) if (off >= f.start && off <= f.end) return f;
    return null;
  }

  /** Public offset transforms (buffer ↔ screen, codepoints) for the sync layer. They use
   *  only the fold spans — independent of the (possibly stale-after-edit) row arrays — so a
   *  single-document screen translates correctly off the live buffers + shifted fold spans. */
  bufferOffsetToScreen(off: number): number {
    return this.bufferToScreenOffset(off);
  }
  screenOffsetToBuffer(off: number): number {
    return this.screenToBufferOffset(off);
  }

  /** Shift fold spans for an insert of `len` codepoints at buffer offset `off` — the
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

  /** Shift fold spans for a delete of buffer range `[start, end)`: a boundary after the
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
    this._screenText = null;
    this._screenRowStart = null;
  }

  /** The screen text: the buffer with each fold range replaced by its placeholder. */
  get screenText(): string {
    if (this.folds.length === 0) return this.bufferText;
    if (this._screenText !== null) return this._screenText;
    const cps = [...this.bufferText];
    const out: string[] = [];
    let cursor = 0;
    for (const f of this.folds) {
      out.push(cps.slice(cursor, f.start).join(''));
      out.push(f.placeholder);
      cursor = f.end;
    }
    out.push(cps.slice(cursor).join(''));
    return (this._screenText = out.join(''));
  }

  /** Number of screen rows (== view buffer line count). */
  get screenRowCount(): number {
    return this.screenRowStarts().length;
  }

  private screenRowStarts(): number[] {
    if (this.folds.length === 0) return this.bufferRowStart;
    if (this._screenRowStart !== null) return this._screenRowStart;
    const starts: number[] = [0];
    const text = this.screenText;
    let off = 0;
    for (const ch of text) {
      off++;
      if (ch === '\n') starts.push(off);
    }
    return (this._screenRowStart = starts);
  }

  // --- offset ↔ (row, col), per space ----------------------------------------

  private bufferOffsetAt(row: number, column: number): number {
    return this.bufferRowStart[Math.max(0, Math.min(row, this.bufferRowCount - 1))] + column;
  }

  private bufferRowColAt(offset: number): [number, number] {
    const row = lastLE(this.bufferRowStart, offset);
    return [row, offset - this.bufferRowStart[row]];
  }

  private screenOffsetAt(row: number, column: number): number {
    const starts = this.screenRowStarts();
    return starts[Math.max(0, Math.min(row, starts.length - 1))] + column;
  }

  private screenRowColAt(offset: number): [number, number] {
    const starts = this.screenRowStarts();
    const row = lastLE(starts, offset);
    return [row, offset - starts[row]];
  }

  // --- fold offset transform (buffer ↔ screen) -----------------------------
  // Each fold shifts everything after it by `placeholderLen - rangeLen` (negative when
  // collapsing). A position inside a fold collapses to its placeholder start. Mirrors the
  // mark-based Document.toModelOffset/toViewOffset, but analytic (recomputed from `folds`).

  private bufferToScreenOffset(bufferOffset: number): number {
    if (this.folds.length === 0) return bufferOffset;
    let delta = 0;
    for (const f of this.folds) {
      if (f.end <= bufferOffset) delta += cpLength(f.placeholder) - (f.end - f.start);
      else if (f.start < bufferOffset) return f.start + delta; // inside the collapsed range
      else break;
    }
    return bufferOffset + delta;
  }

  private screenToBufferOffset(screenOffset: number): number {
    if (this.folds.length === 0) return screenOffset;
    let collapsed = 0; // proj chars collapsed away before the current fold
    for (const f of this.folds) {
      const screenStart = f.start - collapsed;
      const screenEnd = screenStart + cpLength(f.placeholder);
      if (screenEnd <= screenOffset) collapsed += (f.end - f.start) - cpLength(f.placeholder);
      else if (screenStart <= screenOffset) return f.start; // inside (or at the start of) the placeholder
      else break;
    }
    return screenOffset + collapsed;
  }

  /** Each fold's `[screenStart, screenEnd)` codepoint range in VIEW space (the placeholder it
   *  occupies) alongside its buffer range — so position lookups detect a placeholder
   *  hit exactly (the placeholder start is part of the fold, not the document row before it). */
  private foldScreenRanges(): Array<{ vs: number; ve: number }> {
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

  // --- document ↔ buffer (segment map) -------------------------------------

  /** Projection row showing `(documentKey, documentRow)`, or null if it isn't projected. The
   *  first segment that covers it wins (a row shown in two excerpts resolves to the first). */
  bufferRowForDocument(documentKey: string, documentRow: number): number | null {
    if (this.singleDocument) return documentKey === this.soleDocumentKey ? documentRow : null;
    for (let r = 0; r < this.rowInfo.length; r++) {
      const info = this.rowInfo[r];
      if (info.kind === 'segment' && info.documentKey === documentKey && info.documentRow === documentRow) return r;
    }
    return null;
  }

  /** The document position shown at buffer `row`, or null for a block row. */
  documentAtBufferRow(row: number): DocumentPosition | null {
    const info = this.rowInfo[row];
    if (!info || info.kind !== 'segment') return null;
    return { documentKey: info.documentKey, row: info.documentRow, column: 0, segmentIndex: info.segmentIndex };
  }

  // --- composed document ↔ screen ------------------------------------------------

  /** The screen position showing document `(documentKey, row, column)`, or null if that document
   *  row isn't projected, or `{ folded: true }` shape collapsed — callers that don't care
   *  get the placeholder position. Columns are codepoints and pass through verbatim (a
   *  segment row is a verbatim copy of its document row). */
  documentToScreen(documentKey: string, row: number, column: number): { row: number; column: number } | null {
    if (this.isIdentity) {
      return documentKey === this.soleDocumentKey ? { row, column } : null;
    }
    if (this.folds.length === 0) {
      // No fold collapse → buffer row == screen row, columns pass through; index by the
      // (edit-stable) row map, so in-place reverse-sync needs no remap.
      const bufferRow = this.bufferRowForDocument(documentKey, row);
      return bufferRow === null ? null : { row: bufferRow, column };
    }
    const bufferRow = this.bufferRowForDocument(documentKey, row);
    if (bufferRow === null) return null;
    const screenOffset = this.bufferToScreenOffset(this.bufferOffsetAt(bufferRow, column));
    const [vr, vc] = this.screenRowColAt(screenOffset);
    return { row: vr, column: vc };
  }

  /** What screen `(row, column)` maps down to: a live document position, a synthesized block
   *  row, or inside a collapsed fold. */
  screenToDocument(row: number, column: number): ScreenTarget {
    if (this.isIdentity) {
      return { kind: 'document', documentKey: this.soleDocumentKey!, row, column, segmentIndex: 0 };
    }
    if (this.folds.length === 0) {
      // No fold collapse → screen row == buffer row, and segment rows are verbatim copies
      // (columns pass through). Index `rowInfo` directly — independent of the offset table,
      // which goes stale after an in-place edit until a remap; this stays valid as long as
      // the row COUNT is unchanged, so multi-document in-place editing needs no remap.
      const info = this.rowInfo[row];
      if (!info || info.kind !== 'segment') return { kind: 'block', block: (info?.kind ?? 'blank') as BlockKind };
      return { kind: 'document', documentKey: info.documentKey, row: info.documentRow, column, segmentIndex: info.segmentIndex };
    }
    const screenOffset = this.screenOffsetAt(row, column);
    // Inside a placeholder: the screen offset falls within a fold's screen range.
    for (const r of this.foldScreenRanges()) {
      if (screenOffset >= r.vs && screenOffset < r.ve) return { kind: 'fold' };
    }
    const bufferOffset = this.screenToBufferOffset(screenOffset);
    const [bufferRow, bufferCol] = this.bufferRowColAt(bufferOffset);
    const info = this.rowInfo[bufferRow];
    if (!info || info.kind !== 'segment') {
      return { kind: 'block', block: (info?.kind ?? 'blank') as BlockKind };
    }
    return {
      kind: 'document',
      documentKey: info.documentKey,
      row: info.documentRow,
      column: bufferCol,
      segmentIndex: info.segmentIndex,
    };
  }

  /** Screen row → document row (gutter line numbers); null for a block / folded row. */
  documentRowAtScreenRow(screenRow: number): { documentKey: string; documentRow: number } | null {
    const target = this.screenToDocument(screenRow, 0);
    return target.kind === 'document' ? { documentKey: target.documentKey, documentRow: target.row } : null;
  }

  /** Screen row showing document `(documentKey, documentRow)`, or null. */
  screenRowForDocument(documentKey: string, documentRow: number): number | null {
    const pos = this.documentToScreen(documentKey, documentRow, 0);
    return pos ? pos.row : null;
  }

  /** Contiguous runs of ONE segment's rows within screen rows `[screenFrom, screenTo]` — what the
   *  multi-document painter iterates (each run highlighted from its document's own grammar). A run
   *  carries the document row span it covers + the screen row it starts at, so the painter places
   *  it (screenRow = screenStart + documentRow − fromDocumentRow). Block rows break a run; folds split
   *  it (a folded document row isn't a live row). */
  segmentRunsInScreenRange(
    screenFrom: number,
    screenTo: number,
  ): Array<{ documentKey: string; fromDocumentRow: number; toDocumentRow: number; screenStart: number }> {
    const runs: Array<{
      documentKey: string;
      segmentIndex: number;
      fromDocumentRow: number;
      toDocumentRow: number;
      screenStart: number;
    }> = [];
    let cur: (typeof runs)[number] | null = null;
    for (let row = Math.max(0, screenFrom); row <= screenTo; row++) {
      const t = this.screenToDocument(row, 0);
      if (t.kind !== 'document') {
        cur = null;
        continue;
      }
      if (cur && cur.documentKey === t.documentKey && cur.segmentIndex === t.segmentIndex && t.row === cur.toDocumentRow + 1) {
        cur.toDocumentRow = t.row;
      } else {
        cur = { documentKey: t.documentKey, segmentIndex: t.segmentIndex, fromDocumentRow: t.row, toDocumentRow: t.row, screenStart: row };
        runs.push(cur);
      }
    }
    return runs.map(({ documentKey, fromDocumentRow, toDocumentRow, screenStart }) => ({
      documentKey,
      fromDocumentRow,
      toDocumentRow,
      screenStart,
    }));
  }

  // --- editability (write-through gating; hard problem #1) -------------------

  /** Whether screen `(row, column)` is editable: a real, editable segment row not inside a
   *  fold. Block rows, phantom (diff-removed) rows, and folded ranges are not editable. */
  isScreenPositionEditable(row: number, column: number): boolean {
    if (this.isIdentity) return true; // single editable full-file document
    const target = this.screenToDocument(row, column);
    if (target.kind !== 'document') return false;
    const seg = this.segments[target.segmentIndex];
    return !!seg && seg.editable && seg.kind === 'real';
  }

  /** Whether a screen range `[startRow..endRow]` is wholly editable AND maps to a single
   *  SEGMENT — the precondition for a write-through edit. A single document is not enough: two
   *  regions of one file are the same document but DIFFERENT segments, with hidden rows between
   *  them, so a screen range spanning them maps to a non-contiguous document range. Such an edit
   *  must be rejected at the funnel (`setTextInBufferRange`), BEFORE GTK mutates the view —
   *  rejecting later (in write-through) is too late, since the screen edit already happened and
   *  the screen/document diverge (hard problem #1). Columns aren't needed: editability + segment
   *  membership are per-row. */
  isScreenRangeEditable(startRow: number, endRow: number): boolean {
    if (this.isIdentity) return true;
    let segIndex: number | null = null;
    for (let r = startRow; r <= endRow; r++) {
      const target = this.screenToDocument(r, 0);
      if (target.kind !== 'document') return false;
      const seg = this.segments[target.segmentIndex];
      if (!seg || !seg.editable || seg.kind !== 'real') return false;
      if (segIndex === null) segIndex = target.segmentIndex;
      else if (segIndex !== target.segmentIndex) return false; // spans a segment boundary / hidden gap
    }
    return true;
  }

  // --- block rows (for the materialize layer to style headers / gaps) --------

  /** Each block row's screen position + kind (so the materialize/decorate layer can style
   *  filename headers and `⋯` gaps). Skips block rows hidden inside a fold. */
  blockRows(): Array<{ screenRow: number; kind: BlockKind }> {
    const out: Array<{ screenRow: number; kind: BlockKind }> = [];
    for (let bufferRow = 0; bufferRow < this.rowInfo.length; bufferRow++) {
      const info = this.rowInfo[bufferRow];
      if (info.kind === 'segment') continue;
      const screenOffset = this.bufferToScreenOffset(this.bufferRowStart[bufferRow]);
      const [vr] = this.screenRowColAt(screenOffset);
      // A block row swallowed into a fold maps onto the placeholder row; skip it.
      const bufferOff = this.bufferRowStart[bufferRow];
      if (this.folds.some((f) => bufferOff >= f.start && bufferOff < f.end)) continue;
      out.push({ screenRow: vr, kind: info.kind });
    }
    return out;
  }
}
