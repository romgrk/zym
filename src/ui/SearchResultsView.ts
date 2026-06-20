/*
 * SearchResultsView — ONE editor stitching excerpts from many files, each with a filename
 * header, each highlighted by its own grammar (tasks/code-editing/multibuffer.md). It IS a
 * `TextEditor` (buffer mode) so it gets vim navigation, search, selection, and decorations for
 * free; the per-file highlighting comes from an `ExcerptSyntaxProjection` the editor's painter
 * renders through (one painter on the buffer — no second highlighter, no parsing the
 * concatenation as one language).
 *
 * Two modes:
 *   - READ-ONLY (default, project-search browse): each unique source is a bare
 *     `GtkSource.Buffer` read from disk once + its own `DocumentSyntax`. Enter / double-click
 *     jump to the file.
 *   - EDITABLE (project search → edit-in-place / replace-all, G6): each source is a LIVE
 *     `Document` from the registry, so an edit writes through to the file's model — updating
 *     any open tab live and saving via the Document. The `ProjectionView` routes each edit to
 *     its source (in-place; a row-count change re-segments analytically) and coordinates undo
 *     across the touched files as one step. Block (header/gap) rows reject edits; in NORMAL
 *     mode Enter still jumps to the file, in INSERT mode it's a newline.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { Gdk, Gtk, GtkSource, type SourceBuffer } from '../gi.ts';
import { TextEditor } from './TextEditor/TextEditor.ts';
import { Document } from './TextEditor/Document.ts';
import { DocumentRegistry } from './TextEditor/DocumentRegistry.ts';
import { DocumentSyntax } from '../syntax/DocumentSyntax.ts';
import { ViewProjection, type Item } from './TextEditor/ViewProjection.ts';
import { ProjectionView } from './TextEditor/ProjectionView.ts';
import { excerptsToItems, type Excerpt, type Segment, type MatchRange } from './multibuffer/MultiBufferModel.ts';
import { ExcerptSyntaxProjection } from './multibuffer/ExcerptSyntaxProjection.ts';
import { MultiBufferDocument } from './multibuffer/MultiBufferDocument.ts';
import { SourceLineNumberGutter } from './SourceLineNumberGutter.ts';
import { buildHeaderWidget, buildGapWidget } from './HeaderBands.ts';
import { Range } from '../text/Range.ts';
import type { BlockBandSpec, BlockBandSet } from './TextEditor/BlockDecorations.ts';

/** One file's contribution: the regions (source model row spans) to show. */
export interface ExcerptInput {
  path: string;
  /** Header label; defaults to a path relative to `cwd` (or the basename). */
  label?: string;
  regions: Array<{ startRow: number; endRow: number }>;
  /** Spans to highlight (e.g. the search hits), in SOURCE (row, codepoint-column) coords. */
  matches?: MatchRange[];
}

export interface SearchResultsOptions {
  excerpts: ExcerptInput[];
  /** Root for relativizing header labels. */
  cwd?: string;
  /** Fired when the user activates a row (Enter / double-click) over real source. */
  onActivate?: (location: { path: string; row: number }) => void;
  /** Edit-in-place: back each source with a LIVE `Document` (write-through to the file +
   *  cross-source undo + save) instead of a read-only disk snapshot. Requires `documents`. */
  editable?: boolean;
  /** The app's document registry — required when `editable` (sources are shared Documents). */
  documents?: DocumentRegistry;
}

interface SourceEntry {
  buffer: SourceBuffer;
  syntax: DocumentSyntax;
  lines: string[];
  /** Editable mode: the live Document backing this source (released on dispose). */
  document?: Document;
}

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);

export class SearchResultsView {
  readonly root: InstanceType<typeof Gtk.Widget>;
  readonly editor: TextEditor;
  private readonly sources = new Map<string, SourceEntry>();
  private readonly projectionView: ProjectionView;
  private readonly onActivate?: (location: { path: string; row: number }) => void;
  private readonly editable: boolean;
  private readonly registry?: DocumentRegistry;
  private readonly gutter: SourceLineNumberGutter;
  // Filename-header + `⋯` gap widget bands (not buffer rows), reconciled via the shared BlockBandSet.
  private bands!: BlockBandSet;
  // Per-excerpt collapse: the full excerpts (re-derived on toggle), the raw inputs (for re-
  // highlighting), and the set of collapsed excerpt indices. A collapsed excerpt shows only its
  // first source row (always anchorable — no block rows, no view-fold; the painter stays fold-naive).
  private excerpts: Excerpt[] = [];
  private excerptInputs: ExcerptInput[] = [];
  private readonly collapsed = new Set<number>();
  private lastLineCount = 0; // view buffer line count, to detect row-count-changing edits
  private disposed = false;

  /** The LIVE coordinate map (re-segmentation swaps the underlying projection, so always read
   *  it through the ProjectionView rather than caching it). */
  private get projection(): ViewProjection {
    return this.projectionView.view;
  }

  constructor(options: SearchResultsOptions) {
    this.onActivate = options.onActivate;
    this.editable = !!options.editable;
    this.registry = options.documents;
    if (this.editable && !this.registry) {
      throw new Error('SearchResultsView: editable mode requires a DocumentRegistry');
    }

    // Resolve each unique source once (live Document when editable, else a disk snapshot), then
    // back the editor with a ProjectionView over those source buffers — the SAME substrate the
    // single-file editor uses. The painter highlights each excerpt from its source's own parse
    // via the ExcerptSyntaxProjection over the PV's (live) coordinate map.
    this.excerpts = this.buildExcerpts(options.excerpts, options.cwd);
    this.excerptInputs = options.excerpts;
    const sourceBuffers = new Map([...this.sources].map(([key, entry]) => [key, entry.buffer] as const));
    // Headers + gaps are widget bands (not buffer rows), so the item list carries only real source
    // segments. A collapsed excerpt contributes just its first row (see `currentItems`).
    this.projectionView = new ProjectionView(this.currentItems(), sourceBuffers);
    const syntaxMap = new Map([...this.sources].map(([key, entry]) => [key, entry.syntax] as const));
    const painter = new ExcerptSyntaxProjection(() => this.projectionView.view, syntaxMap);

    // One editor, natively backed by the multi-source projection (the `MultiBufferDocument` supplies
    // the view buffer, the per-excerpt painter, and undo coordinating the touched sources). The
    // editor owns + disposes it.
    this.editor = new TextEditor({ source: new MultiBufferDocument(this.projectionView, painter) });
    if (!this.editable) this.editor.model.setReadOnly(true);
    this.bands = this.editor.inlineBlocks.bands();
    // Scope the per-excerpt collapse keymap (`z a`/`z M`/`z R`) to this surface — more specific than
    // vim's `#TextEditor`, so it wins while other `z` motions fall through.
    (this.editor.sourceView as any).addCssClass('search-results');
    this.root = this.editor.root;

    if (this.editable) {
      // Vim operators bypass the native editable tag, so gate them on the live map: only a
      // wholly-editable, single-source view range accepts an edit (block / spanning ranges
      // reject). The materialize layer already read-only-tags block rows for interactive input.
      this.editor.model.setEditableCheck((s, e) => this.projectionView.view.isViewRangeEditable(s, e));
    }
    this.installNavigation();
    // Per-excerpt source line numbers: a left gutter that asks the live projection for the
    // source row behind each view row (blank on header/gap/blank). Sized to the widest source.
    let maxLine = 1;
    for (const entry of this.sources.values()) maxLine = Math.max(maxLine, entry.lines.length);
    this.gutter = new SourceLineNumberGutter(
      this.editor.sourceView,
      () => this.projectionView.view,
      maxLine,
      (line) => this.editor.inlineBlocks.placementAtLine(line),
    );
    this.highlightMatches(this.excerptInputs);
    this.installBands();
    if (this.editable) {
      // A row-count-changing edit (Enter / `o` / `dd`) re-segments the projection, so the view↔
      // source mapping shifts under the painter and the band anchors land on new rows. Repaint the
      // stitched highlighting and re-place the header/gap bands so both follow the reflow. (A within-
      // line edit needs neither — BlockDecorations re-reserves bands itself, and the painter
      // repaints the reparsed source range.)
      this.lastLineCount = (this.editor.sourceView as any).getBuffer().getLineCount();
      this.editor.model.onDidChangeText(() => {
        // A reverse-sync edit (undo / another view) defers its remap, so the projection is stale
        // here — reconciling bands now would anchor headers off the old map. Skip; the post-rebuild
        // reflow handler below does it against the fresh map. A write-through edit re-segments
        // synchronously (no pending sync), so this runs immediately as before.
        if (this.projectionView.isSyncPending()) return;
        const n = (this.editor.sourceView as any).getBuffer().getLineCount();
        if (n === this.lastLineCount) return;
        this.lastLineCount = n;
        this.editor.repaintSyntax();
        this.installBands();
      });
      // After a deferred remap settles the projection (undo / cross-view edit), reconcile the bands
      // against the now-current map (the 'changed' above skipped it while the sync was pending).
      this.projectionView.setReflowHandler(() => {
        this.lastLineCount = (this.editor.sourceView as any).getBuffer().getLineCount();
        this.editor.repaintSyntax();
        this.installBands();
      });
    }
    // Materializing the buffer (setText) leaves the caret at the END; start at the top.
    this.editor.model.setCursorBufferPosition({ row: 0, column: 0 });
  }

  /** Place the filename-header widget above each excerpt's first row, and a `⋯` gap band below the
   *  last row of each non-final segment (separating non-adjacent regions of one file). Both are
   *  widget bands (BlockDecorations), not navigable/copyable buffer rows; their anchor marks track
   *  edits that shift the row. Reconciled in place via the shared BlockBandSet (re-derivable for
   *  per-excerpt collapse). */
  private installBands(): void {
    const projection = this.projectionView.view;
    const specs: BlockBandSpec[] = [];
    this.excerpts.forEach((excerpt, ei) => {
      const first = excerpt.segments[0];
      if (!first) return;
      const headerRow = projection.viewRowForSource(first.sourceKey, first.startRow);
      const collapsed = this.collapsed.has(ei);
      if (headerRow !== null) {
        // A `▸` chevron marks a collapsed file; an expanded one keeps the plain filename.
        const label = collapsed ? `▸ ${excerpt.header}` : excerpt.header;
        specs.push({
          id: `header:${ei}`,
          key: label,
          line: headerRow,
          placement: 'above',
          build: () => buildHeaderWidget(label, first.sourceKey, () => this.onActivate?.({ path: first.sourceKey, row: first.startRow })),
        });
      }
      // Gaps only when expanded (a collapsed excerpt is a single row — no gaps).
      if (!collapsed) {
        for (let i = 1; i < excerpt.segments.length; i++) {
          const prev = excerpt.segments[i - 1];
          const gapRow = projection.viewRowForSource(prev.sourceKey, prev.endRow);
          if (gapRow === null) continue;
          specs.push({ id: `gap:${ei}:${i}`, key: '⋯', line: gapRow, placement: 'below', build: () => buildGapWidget('⋯') });
        }
      }
    });
    this.bands.reconcile(specs);
  }

  // --- per-excerpt collapse --------------------------------------------------

  /** The projection items for the current collapse state: a collapsed excerpt contributes only its
   *  first source row (always anchorable for the header band — no block rows, no view-fold). */
  private currentItems(): Item[] {
    const shown = this.excerpts.map((excerpt, ei) => {
      if (!this.collapsed.has(ei)) return excerpt;
      const first = excerpt.segments[0];
      return { header: excerpt.header, segments: [{ ...first, endRow: first.startRow }] };
    });
    return excerptsToItems(shown, { headers: 'widget' });
  }

  /** Collapse / expand the excerpt (file) under the cursor. */
  toggleCollapseAtCursor(): void {
    const ei = this.excerptAtCursor();
    if (ei === null) return;
    if (this.collapsed.has(ei)) this.collapsed.delete(ei);
    else this.collapsed.add(ei);
    this.rebuild();
  }

  /** Collapse every excerpt to its first row. */
  collapseAll(): void {
    this.excerpts.forEach((_, ei) => this.collapsed.add(ei));
    this.rebuild();
  }

  /** Expand every excerpt back to its full regions. */
  expandAll(): void {
    this.collapsed.clear();
    this.rebuild();
  }

  /** Re-derive the items for the new collapse state and re-flow the view (minimal-churn splice),
   *  re-placing the bands, re-painting, re-highlighting matches, and following the caret to its
   *  source row (or the file's surviving first row if its row was collapsed away). */
  private rebuild(): void {
    if (this.disposed) return;
    const caret = this.editor.model.getCursorBufferPosition();
    const anchor = this.projection.viewToSource(caret.row, caret.column);
    this.projectionView.retarget(this.currentItems());
    this.editor.repaintSyntax();
    this.installBands();
    this.highlightMatches(this.excerptInputs);
    if (anchor.kind === 'source') {
      const pos =
        this.projection.sourceToView(anchor.sourceKey, anchor.row, anchor.column) ??
        this.firstVisibleViewPosition(anchor.sourceKey);
      if (pos) this.editor.model.setCursorBufferPosition(pos);
    }
  }

  /** Which excerpt (index) the cursor sits in — the excerpt whose segments contain the cursor's
   *  source position; null on a row that maps to no source. */
  private excerptAtCursor(): number | null {
    const buffer = (this.editor.sourceView as any).getBuffer();
    const row = asIter(buffer.getIterAtMark(buffer.getInsert())).getLine();
    const src = this.projection.viewToSource(row, 0);
    if (src.kind !== 'source') return null;
    for (let i = 0; i < this.excerpts.length; i++) {
      for (const seg of this.excerpts[i].segments) {
        if (seg.sourceKey === src.sourceKey && src.row >= seg.startRow && src.row <= seg.endRow) return i;
      }
    }
    return null;
  }

  /** The view position of a source's first still-shown row (for caret recovery after a collapse). */
  private firstVisibleViewPosition(sourceKey: string): { row: number; column: number } | null {
    for (const excerpt of this.excerpts) {
      const first = excerpt.segments[0];
      if (first?.sourceKey !== sourceKey) continue;
      const pos = this.projection.sourceToView(sourceKey, first.startRow, 0);
      if (pos) return pos;
    }
    return null;
  }

  /** Paint the search hits: map each match's SOURCE (row, col) span to view coords through the
   *  projection and decorate it on the shared `search` layer (the same highlight `/`-search
   *  uses). Tags anchor to buffer positions, so they track in-place edits; a re-materialize
   *  (reverse-sync) would drop them — fine for a browse/edit surface. */
  private highlightMatches(excerpts: ExcerptInput[]): void {
    const layer = this.editor.decorations.layer('search');
    const projection = this.projectionView.view;
    for (const excerpt of excerpts) {
      for (const m of excerpt.matches ?? []) {
        const start = projection.sourceToView(excerpt.path, m.row, m.startCol);
        const end = projection.sourceToView(excerpt.path, m.row, m.endCol);
        if (!start || !end) continue; // match row not projected (shouldn't happen — regions wrap matches)
        layer.decorate(new Range(start, end), 'highlight');
      }
    }
  }

  /** Resolve sources + parse them, and turn region inputs into Excerpts. Files that can't be
   *  read are skipped; regions are clamped to the file's line count. Editable excerpts are
   *  `editable` real segments (write-through); read-only ones are not. */
  private buildExcerpts(inputs: ExcerptInput[], cwd?: string): Excerpt[] {
    const excerpts: Excerpt[] = [];
    for (const input of inputs) {
      const entry = this.ensureSource(input.path);
      if (!entry) continue;
      const lastRow = Math.max(0, entry.lines.length - 1);
      const segments: Segment[] = input.regions
        .map((r): Segment => ({
          sourceKey: input.path,
          startRow: Math.max(0, Math.min(r.startRow, lastRow)),
          endRow: Math.max(0, Math.min(r.endRow, lastRow)),
          editable: this.editable,
          kind: 'real',
        }))
        .filter((s) => s.endRow >= s.startRow);
      if (segments.length === 0) continue;
      const label = input.label ?? (cwd ? Path.relative(cwd, input.path) : Path.basename(input.path));
      excerpts.push({ header: label, segments });
    }
    return excerpts;
  }

  /** Resolve a source once: a live Document (editable) or a disk-snapshot buffer (read-only).
   *  Returns null if unreadable. */
  private ensureSource(path: string): SourceEntry | null {
    const existing = this.sources.get(path);
    if (existing) return existing;
    const entry = this.editable ? this.acquireLiveSource(path) : this.readSnapshotSource(path);
    if (entry) this.sources.set(path, entry);
    return entry;
  }

  /** Editable: take a ref on the shared Document (loading it if this is its first view), and
   *  use its model buffer as the source + its own parse for highlighting (no double parse). */
  private acquireLiveSource(path: string): SourceEntry | null {
    const { document } = this.registry!.acquire(path);
    if (!document.isLoaded) document.loadFile(path);
    if (!document.isLoaded) {
      // The file couldn't be read (deleted / unreadable) — don't hold a phantom ref.
      this.registry!.release(document);
      return null;
    }
    // Select the grammar + parse so the painter has captures. A tab already showing this file
    // had its SyntaxController do this; a file opened only by the search did not — without it,
    // only the already-open file got highlighted. Idempotent (reuses an existing parse).
    document.syntax.setLanguageForPath(path);
    return {
      buffer: document.modelBuffer,
      syntax: document.syntax, // owned by the Document; not disposed here
      lines: document.getText().split('\n'),
      document,
    };
  }

  /** Read-only: read + parse the file once into a bare buffer this view owns. */
  private readSnapshotSource(path: string): SourceEntry | null {
    let text: string;
    try {
      text = Fs.readFileSync(path, 'utf8');
    } catch (error) {
      console.warn(`[multibuffer] could not read ${path}: ${(error as Error).message}`);
      return null;
    }
    const buffer = new GtkSource.Buffer();
    buffer.setText(text, -1);
    const syntax = new DocumentSyntax(buffer);
    syntax.setLanguageForPath(path); // synchronous parse (grammars are preloaded)
    return { buffer, syntax, lines: text.split('\n') };
  }

  /** Enter (on the focused view) + double-click activate the row under the cursor/pointer.
   *  Capture phase so Enter jumps before the vim layer treats it as a motion. In editable mode
   *  Enter only jumps in NORMAL mode (when the view isn't accepting text input) — in INSERT
   *  mode it stays a newline — and double-click keeps its word-select behaviour. */
  private installNavigation(): void {
    const view = this.editor.sourceView as any;
    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number) => {
      if (keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) return false;
      if (this.editable && view.getEditable()) return false; // insert mode: Enter is a newline
      this.activateRow(this.cursorRow());
      return true;
    });
    view.addController(keys);

    if (this.editable) return; // word-select stays double-clickable while editing
    const click = new Gtk.GestureClick();
    click.on('pressed', (nPress: number, x: number, y: number) => {
      if (nPress < 2) return; // double-click only
      const by = view.windowToBufferCoords(Gtk.TextWindowType.TEXT, x, y);
      const yBuf = Array.isArray(by) ? by[by.length - 1] : y;
      const r = view.getLineAtY(yBuf);
      this.activateRow(asIter(Array.isArray(r) ? r[0] : r).getLine());
    });
    view.addController(click);
  }

  private cursorRow(): number {
    const buffer = (this.editor.sourceView as any).getBuffer();
    return asIter(buffer.getIterAtMark(buffer.getInsert())).getLine();
  }

  private activateRow(viewRow: number): void {
    const target = this.projection.viewToSource(viewRow, 0);
    if (target.kind === 'source') this.onActivate?.({ path: target.sourceKey, row: target.row });
  }

  /** Whether any edited source has unsaved changes (editable mode). */
  isModified(): boolean {
    for (const entry of this.sources.values()) if (entry.document?.isModified()) return true;
    return false;
  }

  /** Save every edited source back to its file (editable mode; no-op read-only). */
  save(): void {
    for (const entry of this.sources.values()) if (entry.document?.isModified()) entry.document.save();
  }

  focus(): void {
    this.editor.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bands.clear();
    this.gutter.dispose();
    // The editor owns the ProjectionView (via its MultiBufferDocument); disposing the editor
    // detaches the PV's source-buffer signal handlers, before the sources are released below.
    this.editor.dispose();
    for (const entry of this.sources.values()) {
      // Editable: drop the shared ref. A file ALSO open in a tab survives (the tab holds a ref
      // and shows the unsaved edit); a file edited ONLY here is disposed with the rest — so
      // unsaved multibuffer-only edits are discarded on close, like an unsaved scratch buffer.
      // FOLLOW-UP: a close-confirmation / unsaved-snapshot for multibuffer-only edits (G11).
      if (entry.document) this.registry!.release(entry.document);
      else entry.syntax.dispose(); // read-only: this view owns the snapshot's parse
    }
    this.sources.clear();
  }
}
