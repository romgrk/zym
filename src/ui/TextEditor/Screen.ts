/*
 * Screen — the per-view materialization + sync layer that sits on top of
 * CoordinatesMap (Phase 2b/2c of docs/text-editor/multibuffer.md). It owns ONE view
 * `GtkSource.Buffer`, materialized from a `CoordinatesMap` over a set of source buffers, and
 * keeps the two in lock-step:
 *
 *   - reverse-sync (source → view): a change in a source buffer is mirrored into the view
 *     buffer at its projected location (Phase 2b);
 *   - write-through (view → source): an edit in the view buffer is routed to `(segment,
 *     sourceOffset)` → the right source buffer (Phase 2c).
 *
 * This generalizes today's `Document.createView`/`forward`/`propagate` (which sync ONE model
 * buffer to ONE view) to N sources stitched into one view, with the coordinate map +
 * editability gating delegated to `CoordinatesMap`. The single full-file source is the
 * IDENTITY case: `screenToDocument`/`documentToScreen` short-circuit, so the sync is a 1:1 mirror —
 * byte-for-byte today's Document behavior, which the headless tests pin down.
 *
 * Editable real segments are the only rows a view edit may touch; block (header/gap/blank)
 * and phantom (diff-removed) rows carry a non-editable TextTag so the user can't type there
 * (the same trick the fold placeholder + mb:header tags already use). A multi-source editable
 * surface (the editable project search, G6) writes through to the targeted source; an in-place
 * edit needs no remap (the row-direct map is stable), and a row-count-changing edit that stays
 * within one segment re-segments analytically (`resegment`) — growing/shrinking that segment's
 * window and shifting later same-source segments, then rebuilding the coordinate map WITHOUT
 * re-materializing (GTK applies the same edit to the view, so no flash / cursor jump).
 */
import { Gtk, GtkSource, type SourceBuffer } from '../../gi.ts';
import { Point } from '../../text/Point.ts';
import { CoordinatesMap, type Item, type Fold } from './CoordinatesMap.ts';
import { diffLines } from '../../util/lineDiff.ts';

// node-gtk returns out-param iters directly or as [ok, iter]; normalize to an iter.
const asIter = (res: any): any => (Array.isArray(res) ? res[res.length - 1] : res);
const iterAtOffset = (buf: any, off: number): any => asIter(buf.getIterAtOffset(off));

/** Codepoint length of `s` (GtkTextIter offsets count characters, not UTF-16 units). */
function cpLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Number of newlines in `text` (rows a multi-line insert adds to its source). */
function newlineCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++;
  return n;
}

/** Text of `buf` row `row` (no trailing newline). */
function lineText(buf: any, row: number): string {
  const start = asIter(buf.getIterAtLine(row));
  if (!start) return '';
  const end = start.copy();
  if (!end.endsLine()) end.forwardToLineEnd();
  return buf.getText(start, end, true);
}

const READONLY_TAG = 'vp:readonly';

interface Connection {
  target: any;
  event: string;
  cb: (...args: any[]) => any;
}

export class Screen {
  /** The materialized view buffer (what a GtkSource.View shows). */
  readonly buffer: SourceBuffer;

  private readonly sources: Map<string, SourceBuffer>;
  private items: Item[];
  private projection: CoordinatesMap;

  // Reentrancy guards: a view edit writes through to a source, whose own change signal
  // must NOT echo back into the view (and vice-versa). `viewSuppress` silences the view's
  // handler while we mirror INTO it; `sourceSuppress` holds the keys we're writing through
  // to, so their change signals are ignored.
  private viewSuppress = false;
  private readonly sourceSuppress = new Set<string>();
  private readonly connections: Connection[] = [];
  private disposed = false;

  // Cross-source undo (multibuffer, G7): each user action is a transaction recording which
  // source keys it touched; undo/redo replay those sources' OWN native undo, in reverse, as
  // one step — so a multi-file edit (e.g. replace-all) is one undo. A single-source editor
  // uses its Document's undo instead, so this stays dormant there.
  private readonly undoStack: string[][] = [];
  private readonly redoStack: string[][] = [];
  private currentTxn: Set<string> | null = null;
  private readonly openActions = new Set<string>();
  private actionDepth = 0; // re-entrancy depth for begin/endUserAction (nested transacts)

  /**
   * Build the view buffer from `items` over `sources` (keyed by `Segment.documentKey`). The
   * normal-editor case is `new Screen([fullFileSegment], new Map([[path, model]]))`.
   */
  constructor(items: Item[], sources: Map<string, SourceBuffer>) {
    this.sources = sources;
    this.items = items;
    this.buffer = new GtkSource.Buffer();
    this.buffer.setEnableUndo(false); // the source models own undo (as Document's views do)
    const table = this.buffer.getTagTable();
    table.add(new Gtk.TextTag({ name: READONLY_TAG, editable: false }));
    this.projection = CoordinatesMap.build(items, (seg) => this.sourceLines(seg));
    this.materialize();
    this.wireView();
    for (const [key, buf] of this.sources) this.wireSource(key, buf);
  }

  /** The current coordinate map (for the painter / gutter / editability queries). */
  get view(): CoordinatesMap {
    return this.projection;
  }

  private sourceLines(seg: { documentKey: string; startRow: number; endRow: number }): string[] {
    const buf = this.sources.get(seg.documentKey);
    if (!buf) return [];
    const out: string[] = [];
    for (let r = seg.startRow; r <= seg.endRow; r++) out.push(lineText(buf, r));
    return out;
  }

  // --- materialization (build the view text + lock down non-editable rows) ----

  private materialize(): void {
    this.viewSuppress = true;
    try {
      this.buffer.setText(this.projection.screenText, -1);
      this.applyReadonlyTags();
      this.buffer.setModified(false);
    } finally {
      this.viewSuppress = false;
    }
    // setText destroyed every view-buffer mark — the lone event a block decoration's mark anchor
    // can't ride (every incremental edit/splice it does). Notify so anchored decorations re-place
    // from the fresh projection. Fired after the rebuild, so subscribers read the new buffer.
    for (const cb of this.materializeHandlers) cb();
  }

  // Subscribers (block-decoration sets) notified after every materialize (initial / rebuild /
  // reload), the one place marks are lost. Incremental edits/splices never fire this.
  private readonly materializeHandlers = new Set<() => void>();
  onDidMaterialize(cb: () => void): () => void {
    this.materializeHandlers.add(cb);
    return () => this.materializeHandlers.delete(cb);
  }

  /** Tag every non-editable row (block / phantom) so the user can't type there. Identity
   *  (single editable full-file source) needs none — skip the per-row sweep entirely. */
  private applyReadonlyTags(): void {
    if (this.projection.isIdentity) return;
    const buffer = this.buffer as any;
    const tag = buffer.getTagTable().lookup(READONLY_TAG);
    const rowCount = this.projection.screenRowCount;
    for (let row = 0; row < rowCount; row++) {
      if (this.projection.isScreenPositionEditable(row, 0)) continue;
      const start = asIter(buffer.getIterAtLine(row));
      const end = asIter(buffer.getIterAtLine(row + 1)); // includes the trailing '\n' → spans the row
      const endIter = end.getLine() === row ? this.endOfLine(row) : end;
      buffer.applyTag(tag, start, endIter);
    }
  }

  private endOfLine(row: number): any {
    const iter = asIter(this.buffer.getIterAtLine(row));
    if (!iter.endsLine()) iter.forwardToLineEnd();
    return iter;
  }

  // --- write-through (view → source) -----------------------------------------
  //
  // The view edit has NOT been applied to the view buffer yet (we're a "before" handler, as
  // Document is); GTK applies it after we return. We mirror it into the source so the source
  // stays authoritative; reverse-sync from that source is suppressed so it doesn't
  // double-apply (and GTK gives the originating view the text). SINGLE-SOURCE is offset-based:
  // projection offset == source offset, so a view offset → source offset is just the fold
  // transform (`screenOffsetToBuffer`). Multi-source *editable* write-through is Phase 3a — a
  // read-only multi-source projection fires no view edits here (the readonly tag blocks them).

  private wireView(): void {
    this.connect(this.buffer, 'insert-text', (iter: any, text: string) => {
      if (this.viewSuppress) return;
      this.writeThroughInsert(iter, text);
    });
    this.connect(this.buffer, 'delete-range', (start: any, end: any) => {
      if (this.viewSuppress) return;
      this.writeThroughDelete(start, end);
    });
  }

  private writeThroughInsert(iter: any, text: string): void {
    // SINGLE-SOURCE: offset-based (proj == source), fold-aware via the offset transform.
    if (this.projection.isSingleDocument) {
      const src = this.soleSource();
      if (!src) return;
      const srcOffset = this.projection.screenOffsetToBuffer(iter.getOffset());
      this.suppressing(this.projection.soleDocumentKey!, () => src.insert(iterAtOffset(src, srcOffset), text, -1));
      return;
    }
    // MULTI-SOURCE: route the edit to the segment's source. The readonly tag blocks edits on
    // block / phantom rows, so a view edit only reaches here on an editable real segment;
    // we still gate, since a headless caller can edit any row. An in-place insert needs no
    // remap (the row-direct map is stable); a multi-line insert grows the segment window and
    // re-segments below.
    const row = iter.getLine();
    const col = iter.getLineOffset();
    const target = this.projection.screenToDocument(row, col);
    if (target.kind !== 'document' || !this.projection.isScreenPositionEditable(row, col)) return;
    const src = this.sources.get(target.documentKey);
    if (!src) return;
    this.noteSourceEdit(target.documentKey);
    this.suppressing(target.documentKey, () =>
      src.insert(asIter(src.getIterAtLineOffset(target.row, target.column)), text, -1),
    );
    const added = newlineCount(text);
    if (added > 0) this.resegment(target.documentKey, target.row, added);
  }

  private writeThroughDelete(startIter: any, endIter: any): void {
    if (this.projection.isSingleDocument) {
      const src = this.soleSource();
      if (!src) return;
      const s = this.projection.screenOffsetToBuffer(startIter.getOffset());
      const e = this.projection.screenOffsetToBuffer(endIter.getOffset());
      if (e <= s) return; // a delete wholly inside a fold placeholder maps to a zero range
      this.suppressing(this.projection.soleDocumentKey!, () => src.delete(iterAtOffset(src, s), iterAtOffset(src, e)));
      return;
    }
    // MULTI-SOURCE: a delete within ONE editable segment routes to its source. A delete ending at
    // COLUMN 0 of `endLine` (a linewise `dd`/`cc`, range `[L,0]–[L+1,0]`) only removes through the
    // end of row L's source line — even when row L+1 begins a DIFFERENT excerpt — so it still maps
    // wholly to source `a`. Any other span across segments/blocks is rejected (boundary clamp —
    // hard problem #1).
    const startLine = startIter.getLine();
    const startCol = startIter.getLineOffset();
    const endLine = endIter.getLine();
    const endCol = endIter.getLineOffset();
    const a = this.projection.screenToDocument(startLine, startCol);
    if (a.kind !== 'document') return;
    if (!this.projection.isScreenPositionEditable(startLine, startCol)) return;
    let bRow: number;
    let bCol: number;
    if (endCol === 0 && endLine > startLine) {
      // The last TOUCHED view row is endLine-1; it must be in the SAME SEGMENT as `a` — same source
      // AND contiguous source rows. (Two regions of one file are the same source but different
      // segments, with HIDDEN rows between them; deleting across that gap would silently remove the
      // unshown lines.) The source deletion ends at the start of the next source line.
      const last = this.projection.screenToDocument(endLine - 1, 0);
      if (last.kind !== 'document' || last.documentKey !== a.documentKey || last.segmentIndex !== a.segmentIndex) return;
      bRow = last.row + 1;
      bCol = 0;
    } else {
      const b = this.projection.screenToDocument(endLine, endCol);
      if (b.kind !== 'document' || b.documentKey !== a.documentKey || b.segmentIndex !== a.segmentIndex) return;
      bRow = b.row;
      bCol = b.column;
    }
    const src = this.sources.get(a.documentKey);
    if (!src) return;
    this.noteSourceEdit(a.documentKey);
    this.suppressing(a.documentKey, () =>
      src.delete(
        asIter(src.getIterAtLineOffset(a.row, a.column)),
        asIter(src.getIterAtLineOffset(bRow, bCol)),
      ),
    );
    const removed = bRow - a.row; // rows merged away by a multi-line delete (0 = in-place)
    if (removed > 0) this.resegment(a.documentKey, a.row, -removed);
  }

  /** Source `key` gained/lost `rowDelta` rows at source row `editRow`. Shift the segment
   *  windows to track it: a segment wholly below the edit moves by `rowDelta`; the segment
   *  spanning `editRow` grows (insert) or shrinks (delete); one above is untouched. Pure index
   *  arithmetic (reads no source text), so it's valid in a before-handler too — the universal
   *  rule for BOTH write-through (the edit just happened on the source) and reverse-sync (the
   *  edit is about to happen). The map rebuild — which DOES read source text — is the caller's
   *  job, at the right moment. */
  private adjustItems(key: string, editRow: number, rowDelta: number): void {
    if (rowDelta === 0) return;
    for (const item of this.items) {
      if (item.type !== 'segment') continue;
      const seg = item.segment;
      if (seg.documentKey !== key) continue;
      if (editRow < seg.startRow) {
        seg.startRow += rowDelta;
        seg.endRow += rowDelta;
      } else if (editRow <= seg.endRow) {
        seg.endRow += rowDelta;
      }
    }
  }

  /** A view edit changed source `key`'s row count by `rowDelta` at source row `editRow` — a
   *  multi-line insert/delete that stayed WITHIN one editable segment (the write-through gates
   *  guarantee that). Adjust the windows, then rebuild the coordinate map from the now-edited
   *  source WITHOUT re-materializing: GTK is applying the same edit to the view buffer, so the
   *  rebuilt map matches the post-edit view (no flash, no cursor jump). This is the multibuffer
   *  counterpart of folds' analytic mark gravity — excerpt windows that track edits.
   *  Single-source edits use the offset path and never reach here. */
  private resegment(key: string, editRow: number, rowDelta: number): void {
    this.adjustItems(key, editRow, rowDelta);
    this.projection = CoordinatesMap.build(this.items, (seg) => this.sourceLines(seg));
  }

  // --- reverse-sync (source → view) ------------------------------------------
  //
  // A source change (another view, undo/redo, reload — or our own write-through, suppressed).
  // The signal fires BEFORE the source mutates, so the projection still reflects the pre-edit
  // source: translate + mirror with the CURRENT map/fold spans. SINGLE-SOURCE is offset-based
  // (proj == source) and fold-aware: an edit a fold absorbs doesn't touch the view (the
  // placeholder stays; the fold just grows). MULTI-SOURCE mirrors the edit at the translated
  // row(s) — in-place OR row-count-changing — and then remaps the coordinate map WITHOUT
  // re-materializing (so an undo of a multi-line edit doesn't flash/clear the whole buffer or
  // reset the cursor); only an edit that can't be mirrored cleanly (an endpoint outside a shown
  // segment / crossing a region boundary) falls back to a full re-materialize.

  private wireSource(key: string, buf: SourceBuffer): void {
    this.connect(buf, 'insert-text', (iter: any, text: string) => this.onSourceInsert(key, iter, text));
    this.connect(buf, 'delete-range', (start: any, end: any) => this.onSourceDelete(key, start, end));
  }

  private onSourceInsert(key: string, iter: any, text: string): void {
    if (!this.projection.isSingleDocument) {
      if (this.sourceSuppress.has(key)) return;
      if (this.replaying && this.resyncHandler) return; // diff undo/redo: afterReplay re-derives once
      // A COMPUTED surface (a diff) can't be re-flowed by window arithmetic — the row's
      // classification (added/context) + the elision can change — so always re-derive it.
      if (text.includes('\n') && this.resyncHandler) return this.scheduleRebuild();
      const sr = iter.getLine();
      const pos = this.projection.documentToScreen(key, sr, iter.getLineOffset());
      if (text.includes('\n')) {
        // A row-count change (undo / another view / external). When the insert point is in a
        // shown segment, MIRROR the exact text into the view + grow the windows, then remap the
        // coordinate map only (no re-materialize → no whole-buffer flash, cursor preserved) —
        // the same analytic move write-through makes. If the point isn't shown (an edit beyond
        // the excerpt), fall back to a full rebuild so the regenerated view reflects the clamp.
        this.adjustItems(key, sr, newlineCount(text));
        if (pos) {
          // Mark the remap pending BEFORE mirroring: applyToView fires the view's 'changed', whose
          // observers (the search results' band reconcile) must defer their projection-dependent work
          // to the post-rebuild reflow rather than read the now-stale current map.
          this.scheduleRemap();
          this.applyToView((b) => b.insert(asIter(b.getIterAtLineOffset(pos.row, pos.column)), text, -1));
          return;
        }
        return this.scheduleRebuild();
      }
      if (pos) this.applyToView((b) => b.insert(asIter(b.getIterAtLineOffset(pos.row, pos.column)), text, -1));
      return;
    }
    const off = iter.getOffset();
    if (!this.sourceSuppress.has(key) && !this.projection.foldContaining(off)) {
      const viewOff = this.projection.bufferOffsetToScreen(off);
      this.applyToView((buffer) => buffer.insert(iterAtOffset(buffer, viewOff), text, -1));
    }
    this.projection.shiftFoldsForInsert(off, cpLength(text));
  }

  private onSourceDelete(key: string, startIter: any, endIter: any): void {
    if (!this.projection.isSingleDocument) {
      if (this.sourceSuppress.has(key)) return;
      if (this.replaying && this.resyncHandler) return; // diff undo/redo: afterReplay re-derives once
      // A COMPUTED surface (a diff) always re-derives on a row-count change (see onSourceInsert).
      if (startIter.getLine() !== endIter.getLine() && this.resyncHandler) return this.scheduleRebuild();
      const a = this.projection.documentToScreen(key, startIter.getLine(), startIter.getLineOffset());
      const b = this.projection.documentToScreen(key, endIter.getLine(), endIter.getLineOffset());
      if (startIter.getLine() !== endIter.getLine()) {
        const removed = endIter.getLine() - startIter.getLine();
        this.adjustItems(key, startIter.getLine(), -removed);
        // MIRROR + remap (no flash) when both endpoints map into the SAME shown run — i.e. the
        // view span equals the source span, so there's no block (gap) row in between. Otherwise
        // (endpoint off-screen, or the delete crosses a region boundary) fall back to a rebuild.
        if (a && b && b.row - a.row === removed) {
          // Flag the remap pending BEFORE mirroring (see onSourceInsert) so band-reconcile observers
          // defer to the reflow instead of reading the stale map mid-undo.
          this.scheduleRemap();
          this.applyToView((buf) => buf.delete(asIter(buf.getIterAtLineOffset(a.row, a.column)), asIter(buf.getIterAtLineOffset(b.row, b.column))));
          return;
        }
        return this.scheduleRebuild();
      }
      if (a && b) this.applyToView((buf) => buf.delete(asIter(buf.getIterAtLineOffset(a.row, a.column)), asIter(buf.getIterAtLineOffset(b.row, b.column))));
      return;
    }
    const startOff = startIter.getOffset();
    const endOff = endIter.getOffset();
    if (!this.sourceSuppress.has(key)) {
      const fold = this.projection.foldContaining(startOff);
      const absorbed = !!fold && startOff >= fold.start && endOff <= fold.end; // fully inside a fold
      if (!absorbed) {
        const vs = this.projection.bufferOffsetToScreen(startOff);
        const ve = this.projection.bufferOffsetToScreen(endOff);
        if (ve > vs) this.applyToView((buffer) => buffer.delete(iterAtOffset(buffer, vs), iterAtOffset(buffer, ve)));
      }
    }
    this.projection.shiftFoldsForDelete(startOff, endOff);
  }

  // --- folds (view-side collapse; the analytic transform, hard problem #3) ----

  /** Collapse view codepoint range `[viewStart, viewEnd)` to `placeholder` and return its
   *  handle. The source is untouched (it's the full text); the view renders the fold on one
   *  line, the placeholder tagged read-only. Single-source only (the editor's fold use case);
   *  a fold makes the view non-identity but stays incrementally synced via the offset
   *  transform. Subsumes any inner folds in the range (their bodies join this collapse). */
  fold(viewStart: number, viewEnd: number, placeholder: string): Fold | null {
    if (!this.projection.isSingleDocument || viewEnd <= viewStart) return null;
    const projStart = this.projection.screenOffsetToBuffer(viewStart);
    const projEnd = this.projection.screenOffsetToBuffer(viewEnd);
    if (projEnd <= projStart) return null;
    this.projection.removeFoldsWithin(projStart, projEnd); // an outer fold subsumes inner ones
    const handle = this.projection.addFold(projStart, projEnd, placeholder);
    if (!handle) return null;
    this.applyToView((buffer) => {
      buffer.delete(iterAtOffset(buffer, viewStart), iterAtOffset(buffer, viewEnd));
      buffer.insert(iterAtOffset(buffer, viewStart), placeholder, -1);
      const tag = buffer.getTagTable().lookup(READONLY_TAG);
      buffer.applyTag(tag, iterAtOffset(buffer, viewStart), iterAtOffset(buffer, viewStart + cpLength(placeholder)));
    });
    return handle;
  }

  /** Expand a fold: replace its placeholder with the current source text of its range. */
  unfold(handle: Fold): void {
    const src = this.soleSource();
    if (!src) return;
    const viewStart = this.projection.bufferOffsetToScreen(handle.start);
    const placeholderLen = cpLength(handle.placeholder);
    const body = src.getText(iterAtOffset(src, handle.start), iterAtOffset(src, handle.end), true); // proj == source
    this.projection.removeFold(handle);
    this.applyToView((buffer) => {
      buffer.delete(iterAtOffset(buffer, viewStart), iterAtOffset(buffer, viewStart + placeholderLen));
      buffer.insert(iterAtOffset(buffer, viewStart), body, -1);
    });
  }

  // --- screen ↔ document translation (the FoldHost surface SyntaxController consumes) --------
  // Single-document only (the editor's fold host is per-file): the offset transform composes
  // the fold collapse and buffer offset == document offset. A non-single-document projection
  // returns identity (its painter uses the SyntaxProjection path, not this).

  /** The document (file) line shown at screen line `screenLine` — for the line-number gutter. */
  documentLineForScreenLine(screenLine: number): number {
    const src = this.soleSource();
    if (!src) return screenLine;
    const screenOff = asIter(this.buffer.getIterAtLine(screenLine)).getOffset();
    return iterAtOffset(src, this.projection.screenOffsetToBuffer(screenOff)).getLine();
  }

  /** The screen line showing document line `documentLine` (its start) — for diagnostics/decorations. */
  screenLineForDocumentLine(documentLine: number): number {
    const src = this.soleSource();
    if (!src) return documentLine;
    const srcOff = asIter(src.getIterAtLine(documentLine)).getOffset();
    return iterAtOffset(this.buffer, this.projection.bufferOffsetToScreen(srcOff)).getLine();
  }

  /** Translate a SCREEN caret to DOCUMENT coordinates (folds shift lines + columns) — for LSP. */
  documentPointFromScreen(point: Point): Point {
    const src = this.soleSource();
    if (!src) return point;
    const viewOff = asIter(this.buffer.getIterAtLineOffset(point.row, point.column)).getOffset();
    const iter = iterAtOffset(src, this.projection.screenOffsetToBuffer(viewOff));
    return new Point(iter.getLine(), iter.getLineOffset());
  }

  /** Translate a DOCUMENT caret to SCREEN coordinates (a position inside a fold → placeholder). */
  screenPointFromDocument(point: Point): Point {
    const src = this.soleSource();
    if (!src) return point;
    const srcOff = asIter(src.getIterAtLineOffset(point.row, point.column)).getOffset();
    const iter = iterAtOffset(this.buffer, this.projection.bufferOffsetToScreen(srcOff));
    return new Point(iter.getLine(), iter.getLineOffset());
  }

  /** Text of document line `row` (no newline) — for LSP column encoding of document ranges. */
  documentLineText(row: number): string {
    const src = this.soleSource();
    return src ? lineText(src, row) : '';
  }

  /** The live `[start, end)` placeholder offsets of `fold` in the view buffer. A removed
   *  (unfolded / subsumed) handle has no placeholder in the buffer anymore → a zero-width
   *  range (matching the old impl's collapsed marks), so a caller snapping the cursor out of
   *  a placeholder doesn't loop on a stale range while `unfold`'s splice is still in flight. */
  foldPlaceholderRange(fold: Fold): [number, number] {
    const viewStart = this.projection.bufferOffsetToScreen(fold.start);
    if (!this.isFoldAlive(fold)) return [viewStart, viewStart];
    return [viewStart, viewStart + cpLength(fold.placeholder)];
  }

  /** The document text a fold currently collapses (for search-reveal matching). */
  foldDocumentText(fold: Fold): string {
    const src = this.soleSource();
    return src ? src.getText(iterAtOffset(src, fold.start), iterAtOffset(src, fold.end), true) : '';
  }

  /** The DOCUMENT row span `[startRow, endRow]` a fold covers (its buffer offsets → source rows;
   *  `buffer == document` for the single-file fold case). The vim layer treats `[startRow, endRow]`
   *  as one line, so j/k skip a closed fold. */
  foldDocumentRowSpan(fold: Fold): [number, number] {
    const src = this.soleSource();
    if (!src) return [0, 0];
    return [iterAtOffset(src, fold.start).getLine(), iterAtOffset(src, fold.end).getLine()];
  }

  /** Whether a fold handle is still live (not subsumed by an enclosing fold / deleted). */
  isFoldAlive(fold: Fold): boolean {
    return this.projection.foldSpans().includes(fold);
  }

  private soleSource(): SourceBuffer | null {
    const key = this.projection.soleDocumentKey;
    return key ? this.sources.get(key) ?? null : null;
  }

  /** Run `fn` (which mutates source `key`) with that source's reverse-sync suppressed, so the
   *  write-through doesn't echo back into the view (which GTK already updates). */
  private suppressing(key: string, fn: () => void): void {
    this.sourceSuppress.add(key);
    try {
      fn();
    } finally {
      this.sourceSuppress.delete(key);
    }
  }

  // --- cross-source undo (the UndoTarget the multibuffer's EditorModel drives) ------------

  /** Open a transaction: writes-through during it coalesce into one undo step per source.
   *  RE-ENTRANT (a depth counter, like GtkSource's native user actions): only the OUTERMOST
   *  begin/end pair bounds the transaction. This matters because `EditorModel.transact` is not
   *  itself re-entrant — `replaceAll` nests an outer `transact` (the whole scan) around each
   *  `setTextInBufferRange`'s inner one, and without depth-tracking each inner close would flush
   *  its file as a separate step (so one undo would revert only the last file, not all). */
  beginUserAction(): void {
    if (this.actionDepth++ === 0) this.currentTxn = new Set();
  }

  /** Close the transaction: at the outermost level, end each touched source's native undo group
   *  + push the (multi-file) step. Inner closes just decrement the depth. */
  endUserAction(): void {
    if (this.actionDepth === 0 || --this.actionDepth > 0) return;
    for (const key of this.openActions) (this.sources.get(key))?.endUserAction();
    this.openActions.clear();
    if (this.currentTxn && this.currentTxn.size) {
      this.undoStack.push([...this.currentTxn]);
      this.redoStack.length = 0; // a fresh edit invalidates the redo timeline
    }
    this.currentTxn = null;
  }

  /** Record that the open user action edited source `key` (opening its native undo group on
   *  first touch). Outside a user action, the edit is its own one-source transaction. */
  private noteSourceEdit(key: string): void {
    if (this.currentTxn) {
      if (!this.openActions.has(key)) {
        (this.sources.get(key))?.beginUserAction();
        this.openActions.add(key);
      }
      this.currentTxn.add(key);
    } else {
      this.undoStack.push([key]);
      this.redoStack.length = 0;
    }
  }

  // Set while replaying source undo/redo: a COMPUTED surface (a diff) re-derives the whole view
  // ONCE, synchronously, in `afterReplay` (the sources are mutated by then) — so the reverse-sync
  // handlers skip their per-edit work, and the view updates within the undo/redo command rather
  // than on a later microtask the paint might miss. (A search multibuffer has no resync handler,
  // so its reverse-sync mirror still runs.)
  private replaying = false;

  /** Undo the last transaction: replay each touched source's native undo (reverse order). The
   *  sources' change signals reverse-sync the result into the view (and the files' own views). */
  undo(): void {
    const txn = this.undoStack.pop();
    if (!txn) return;
    this.replaying = true;
    try {
      for (let i = txn.length - 1; i >= 0; i--) (this.sources.get(txn[i]))?.undo();
    } finally {
      this.replaying = false;
    }
    this.redoStack.push(txn);
    this.afterReplay();
  }

  redo(): void {
    const txn = this.redoStack.pop();
    if (!txn) return;
    this.replaying = true;
    try {
      for (const key of txn) (this.sources.get(key))?.redo();
    } finally {
      this.replaying = false;
    }
    this.undoStack.push(txn);
    this.afterReplay();
  }

  /** After an undo/redo settles the sources: a computed surface re-derives the view synchronously. */
  private afterReplay(): void {
    if (this.resyncHandler) this.resyncHandler();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private applyToView(mutate: (buffer: any) => void): void {
    this.viewSuppress = true;
    try {
      mutate(this.buffer);
    } finally {
      this.viewSuppress = false;
    }
  }

  // A non-identity source change settled: catch the projection up to the mutated sources. Two
  // strengths, both deferred to a microtask so the source's own signal handlers all run first
  // (the source mutates AFTER its 'insert-text' / 'delete-range'):
  //   - REMAP (coord map only): the view was already mutated incrementally to match (the
  //     reverse-sync handler mirrored the exact edit), so only the coordinate map must catch up.
  //   - RESYNC (re-flow the view): the edit couldn't be mirrored cleanly — e.g. a new-side
  //     row-count change with phantom (old-side) rows interleaved in the view, so the deleted
  //     source rows aren't a contiguous view range (a diff undo). Re-flow via `retarget`: a
  //     minimal line-diff splice, NOT a whole-buffer `setText` — so no flash, cursor preserved.
  // A resync requested in the same tick wins (it subsumes a remap).
  private syncScheduled = false;
  private needsResync = false;
  private scheduleRemap(): void { this.scheduleSync(false); }
  private scheduleRebuild(): void { this.scheduleSync(true); }
  private scheduleSync(resync: boolean): void {
    if (this.disposed) return;
    if (resync) this.needsResync = true;
    if (this.syncScheduled) return;
    this.syncScheduled = true;
    // setTimeout (macrotask), NOT queueMicrotask — see docs/index.md "node-gtk event loop". It runs
    // on the next loop turn (GLib loop and headless runner alike), by when the source has mutated
    // (its default insert/delete handler ran), so re-reading source text is valid.
    setTimeout(() => {
      this.syncScheduled = false;
      const resync = this.needsResync;
      this.needsResync = false;
      if (this.disposed) return;
      // REMAP just swaps the coordinate map (the view was already mirrored). RESYNC re-flows the
      // view: when the owner is a COMPUTED surface (a diff), `adjustItems` can't maintain its
      // segment structure through a row-count change that crosses segment boundaries (an undo
      // over fragmented new-side/phantom segments), so delegate to the owner to re-derive the
      // items from scratch; otherwise (search) retarget the window-adjusted items.
      if (!resync) this.projection = CoordinatesMap.build(this.items, (seg) => this.sourceLines(seg));
      else if (this.resyncHandler) this.resyncHandler();
      else this.retarget(this.items);
      // The map is now current — let the owner reconcile projection-dependent chrome (the search
      // results' header/gap bands), which it skipped on the mid-undo 'changed' (stale map then).
      this.reflowHandler?.();
    });
  }

  /** True while a deferred remap/rebuild is queued — so a 'changed' observer can skip work that
   *  reads the coordinate map (it's stale until the rebuild) and do it in the reflow instead. */
  isSyncPending(): boolean {
    return this.syncScheduled;
  }

  // Optional owner hook: re-derive the item list + re-flow the view (a diff's re-diff). Set by a
  // surface whose structure is computed (not maintainable by `adjustItems`) — see scheduleSync.
  private resyncHandler: (() => void) | null = null;
  setResyncHandler(fn: () => void): void {
    this.resyncHandler = fn;
  }

  // Optional owner hook fired AFTER a deferred remap/rebuild settles the coordinate map — for a
  // surface that reconciles projection-dependent chrome (the search results' bands) and must do so
  // against the fresh map, not the stale one a mid-undo 'changed' exposes.
  private reflowHandler: (() => void) | null = null;
  setReflowHandler(fn: () => void): void {
    this.reflowHandler = fn;
  }

  /** Rebuild the projection from the current source state + re-materialize. Used when the
   *  segment structure changes (excerpts open/close, or a non-identity source edit). */
  rebuild(items: Item[] = this.items): void {
    this.items = items;
    this.projection = CoordinatesMap.build(items, (seg) => this.sourceLines(seg));
    this.materialize();
  }

  /**
   * Re-target the view to a NEW item list with MINIMAL churn — the engine for a re-diff after
   * the new side was edited (the diff structure changes: phantom/removed rows appear or
   * disappear, runs split/merge). Unlike `rebuild` (which `setText`s the whole buffer, clearing
   * every highlight tag → a flash, and resetting the caret), this builds the new map, line-diffs
   * its text against the CURRENT view text, and applies only the changed lines. So rows that
   * didn't move keep their caret position, syntax tags, and decorations; only the genuinely
   * changed rows (usually just the re-flowed phantom rows) are spliced. Block / phantom rows are
   * re-locked read-only afterwards (they shifted).
   */
  retarget(items: Item[]): void {
    const next = CoordinatesMap.build(items, (seg) => this.sourceLines(seg));
    this.viewSuppress = true;
    try {
      this.spliceTo(next.screenText);
      this.items = items;
      this.projection = next;
      this.relockReadonly();
      this.buffer.setModified(false);
    } finally {
      this.viewSuppress = false;
    }
  }

  /** Splice the view buffer to `target` by applying only its line-level diff against the current
   *  text — leaving unchanged lines (their tags + the caret) in place. */
  private spliceTo(target: string): void {
    const buffer = this.buffer;
    const current = buffer.getText(buffer.getStartIter(), buffer.getEndIter(), true) as string;
    if (current === target) return;
    const ops = diffLines(current.split('\n'), target.split('\n'));
    const b = target.split('\n');
    let viewRow = 0; // row in the (mutating) buffer
    let bi = 0; // index into the target lines
    for (const op of ops) {
      if (op === 'eq') {
        viewRow++;
        bi++;
      } else if (op === 'del') {
        this.deleteViewLine(viewRow); // line removed; the next line shifts into viewRow
      } else {
        this.insertViewLine(viewRow, b[bi]);
        viewRow++;
        bi++;
      }
    }
  }

  /** Delete the whole of view line `row` (its text + the newline that joins it to its
   *  neighbour). The final line has no trailing newline, so swallow the PRECEDING one instead. */
  private deleteViewLine(row: number): void {
    const buffer = this.buffer;
    const lastLine = buffer.getLineCount() - 1;
    let start = asIter(buffer.getIterAtLine(row));
    let end: any;
    if (row < lastLine) {
      end = asIter(buffer.getIterAtLine(row + 1));
    } else {
      end = buffer.getEndIter();
      if (row > 0) {
        start = asIter(buffer.getIterAtLine(row));
        start.backwardChar(); // consume the '\n' before the last line, leaving no empty row
      }
    }
    buffer.delete(start, end);
  }

  /** Insert `text` as a new view line at `row` (before the line currently there, or as a new
   *  final line when `row` is past the end). */
  private insertViewLine(row: number, text: string): void {
    const buffer = this.buffer;
    if (row < buffer.getLineCount()) {
      buffer.insert(asIter(buffer.getIterAtLine(row)), text + '\n', -1);
    } else {
      buffer.insert(buffer.getEndIter(), '\n' + text, -1); // append past the (unterminated) last line
    }
  }

  /** Clear + reapply the read-only tag across the buffer (block/phantom rows moved on retarget). */
  private relockReadonly(): void {
    const buffer = this.buffer as any;
    const tag = buffer.getTagTable().lookup(READONLY_TAG);
    buffer.removeTag(tag, buffer.getStartIter(), buffer.getEndIter());
    this.applyReadonlyTags();
  }

  /** Ignore source-buffer change signals until `resume()` — for a bulk replace the owner
   *  drives explicitly (Document.setText emits whole-buffer delete+insert it doesn't want
   *  mirrored edit-by-edit; it `suspend()`s, replaces, then `rebuild()`s + `resume()`s). */
  suspend(): void {
    for (const key of this.sources.keys()) this.sourceSuppress.add(key);
  }
  resume(): void {
    for (const key of this.sources.keys()) this.sourceSuppress.delete(key);
  }

  // --- lifecycle -------------------------------------------------------------

  private connect(target: any, event: string, cb: (...args: any[]) => any): void {
    target.on(event, cb);
    this.connections.push({ target, event, cb });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { target, event, cb } of this.connections) {
      try {
        target.off(event, cb);
      } catch {
        /* target already finalized */
      }
    }
    this.connections.length = 0;
  }
}
