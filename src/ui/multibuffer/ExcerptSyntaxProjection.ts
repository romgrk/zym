/*
 * ExcerptSyntaxProjection — the multibuffer's `SyntaxProjection`. It tells the per-view
 * painter (`SyntaxController`), for a visible view-row range, which source `DocumentSyntax`
 * to query and where each source row lands, and styles the filename-header / `⋯` gap rows.
 * The painter owns the buffer + its `HighlightTags` and does the actual painting, so there's
 * ONE highlighter on the buffer (no tag collision) and every excerpt is highlighted by its
 * own grammar — the keystone Phase 0 unlocked (one parse per Document, many projections).
 *
 * Coordinates come from the unified `CoordinatesMap` (the same substrate the single-file
 * editor uses): `segmentRunsInScreenRange` gives the source slices to paint, `blockRows` the
 * header / gap rows to style.
 */
import { Gtk, Pango } from '../../gi.ts';
import { theme } from '../../theme/theme.ts';
import type { DocumentSyntax } from '../../syntax/DocumentSyntax.ts';
import type { SyntaxProjection, SyntaxSlice } from '../../syntax/SyntaxProjection.ts';
import type { CoordinatesMap } from '../TextEditor/CoordinatesMap.ts';

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);

/** One excerpt source for the projection: its parse plus, optionally, a thunk that selects the
 *  grammar + parses it on demand (deferred) — used by the lazy-by-viewport path. Omit
 *  `ensureParsed` for an always-parsed source. */
export interface ProjectionSource {
  syntax: DocumentSyntax;
  ensureParsed?: () => void;
}

export class ExcerptSyntaxProjection implements SyntaxProjection {
  private headerTag: any = null;
  private gapTag: any = null;
  // A GETTER, not a captured instance: a re-diff (`Screen.rebuild`) swaps in a NEW
  // CoordinatesMap, so the painter must read the live one each paint or it highlights with
  // stale coordinates (shifted highlighting after an edit).
  private readonly getProjection: () => CoordinatesMap;
  private readonly sources: Map<string, ProjectionSource>;
  // Keys whose `ensureParsed` has fired (lazy-by-viewport): each source parses at most once.
  private readonly parsedKeys = new Set<string>();

  // Note: explicit field assignment (not constructor parameter properties) — Node runs .ts
  // in strip-only mode, which rejects parameter properties at runtime.
  constructor(getProjection: () => CoordinatesMap, sources: Map<string, ProjectionSource>) {
    this.getProjection = getProjection;
    this.sources = sources;
  }

  hasContent(): boolean {
    for (const source of this.sources.values()) if (source.syntax.hasTree) return true;
    return false;
  }

  paintSlices(viewFrom: number, viewTo: number): SyntaxSlice[] {
    const slices: SyntaxSlice[] = [];
    for (const run of this.getProjection().segmentRunsInScreenRange(viewFrom, viewTo)) {
      const source = this.sources.get(run.documentKey);
      if (!source) continue;
      slices.push({
        syntax: source.syntax,
        fromRow: run.fromDocumentRow,
        toRow: run.toDocumentRow,
        sourceStart: run.fromDocumentRow,
        viewStart: run.screenStart,
      });
    }
    return slices;
  }

  onDidReparse(callback: () => void): () => void {
    const syntaxes = new Set([...this.sources.values()].map((s) => s.syntax));
    const unsubs = [...syntaxes].map((syntax) => syntax.onDidReparse(callback));
    return () => { for (const unsub of unsubs) unsub(); };
  }

  /** Lazy syntax: parse (once) each source whose excerpt overlaps view rows `[viewFrom, viewTo]`.
   *  The source's deferred parse then repaints this projection via `onDidReparse`. */
  ensureParsedForRange(viewFrom: number, viewTo: number): void {
    for (const run of this.getProjection().segmentRunsInScreenRange(viewFrom, viewTo)) {
      if (this.parsedKeys.has(run.documentKey)) continue;
      const source = this.sources.get(run.documentKey);
      if (!source) continue;
      this.parsedKeys.add(run.documentKey);
      source.ensureParsed?.();
    }
  }

  /** Style the header / gap rows (created lazily on `buffer`'s tag table — distinct names
   *  from the painter's highlight tags, so no collision). */
  decorate(buffer: any): void {
    if (!this.headerTag) this.buildTags(buffer);
    for (const { screenRow, kind } of this.getProjection().blockRows()) {
      if (kind === 'header') this.applyRow(buffer, this.headerTag, screenRow);
      else if (kind === 'gap') this.applyRow(buffer, this.gapTag, screenRow);
    }
  }

  private buildTags(buffer: any): void {
    const table = buffer.getTagTable();
    const mk = (props: Record<string, unknown>) => { const t = new Gtk.TextTag(props); table.add(t); return t; };
    this.headerTag = mk({
      name: 'mb:header',
      editable: false,
      weight: Pango.Weight.BOLD,
      foreground: theme.ui.text.muted,
      paragraphBackground: theme.ui.surface.selected,
    });
    this.gapTag = mk({ name: 'mb:gap', editable: false, foreground: theme.ui.text.muted });
  }

  /** Apply `tag` across view row `screenRow`, including its trailing newline so the paragraph
   *  background spans the full row. */
  private applyRow(buffer: any, tag: any, screenRow: number): void {
    const start = asIter(buffer.getIterAtLine(screenRow));
    const next = asIter(buffer.getIterAtLine(screenRow + 1));
    const end = next.getLine() === screenRow ? this.endOfLine(buffer, screenRow) : next;
    buffer.applyTag(tag, start, end);
  }

  private endOfLine(buffer: any, line: number): any {
    const iter = asIter(buffer.getIterAtLine(line));
    if (!iter.endsLine()) iter.forwardToLineEnd();
    return iter;
  }
}
