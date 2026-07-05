/*
 * SearchResultsView — ONE editor stitching excerpts from many files, each with a filename
 * header, each highlighted by its own grammar (docs/text-editor/multibuffer.md). It IS a
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
 *     any open tab live and saving via the Document. The `Screen` routes each edit to
 *     its source (in-place; a row-count change re-segments analytically) and coordinates undo
 *     across the touched files as one step. Block (header/gap) rows reject edits; in NORMAL
 *     mode Enter still jumps to the file, in INSERT mode it's a newline.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import Gdk from 'gi:Gdk-4.0';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
type SourceBuffer = InstanceType<typeof GtkSource.Buffer>;
import { TextEditor } from './TextEditor/TextEditor.ts';
import { Document } from './TextEditor/Document.ts';
import { DocumentRegistry } from './TextEditor/DocumentRegistry.ts';
import { DocumentSyntax } from '../syntax/DocumentSyntax.ts';
import { CoordinatesMap, type Item } from './TextEditor/CoordinatesMap.ts';
import { Screen } from './TextEditor/Screen.ts';
import { excerptsToItems, type Excerpt, type Segment, type MatchRange } from './multibuffer/MultiBufferModel.ts';
import { enclosingSection } from './multibuffer/diffMultiBuffer.ts';
import { ExcerptSyntaxProjection } from './multibuffer/ExcerptSyntaxProjection.ts';
import { MultiBufferDocument } from './multibuffer/MultiBufferDocument.ts';
import { SourceLineNumberGutter } from './SourceLineNumberGutter.ts';
import { buildHeaderWidget, buildGapWidget } from './HeaderBands.ts';
import { Range } from '../text/Range.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import { prof } from '../util/profile.ts';
import type { BlockDecorationSpec, BlockDecorationSet } from './TextEditor/BlockDecorationSet.ts';

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
  /** Select the grammar + parse this source (deferred); run by the projection when the excerpt
   *  nears the viewport (lazy syntax). */
  parse: () => void;
}

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);

// A matched file is skipped from the results when it's too big to read or has a line too long to
// render: a minified bundle / source map can carry a million-character line that stalls
// GtkSourceView (text layout + tree-sitter) for seconds. Project search isn't a useful editing
// surface for those anyway.
const MAX_SOURCE_BYTES = 2 * 1024 * 1024; // skip files larger than this (checked before reading)
const MAX_SOURCE_LINE = 10_000; // skip files with any line longer than this

export class SearchResultsView {
  readonly root: InstanceType<typeof Gtk.Widget>;
  readonly editor: TextEditor;
  private readonly sources = new Map<string, SourceEntry>();
  private readonly screen: Screen;
  private readonly onActivate?: (location: { path: string; row: number }) => void;
  private readonly editable: boolean;
  private readonly registry?: DocumentRegistry;
  private readonly gutter: SourceLineNumberGutter;
  // Filename-header + gap widget bands (not buffer rows), declared as SOURCE-anchored block
  // decorations — the editor projects + reconciles them; their positions then ride the anchor marks.
  private bands!: BlockDecorationSet;
  // Per-excerpt collapse: the full excerpts (re-derived on toggle), the raw inputs (for re-
  // highlighting), and the set of collapsed excerpt indices. A collapsed excerpt shows only its
  // first source row (always anchorable — no block rows, no view-fold; the painter stays fold-naive).
  private excerpts: Excerpt[] = [];
  private excerptInputs: ExcerptInput[] = [];
  // Root for relativizing header labels + the syntax painter, kept so `setExcerpts` can grow the
  // surface (register new sources, rebuild labels) as a streaming search delivers more files.
  private readonly cwd?: string;
  private painter!: ExcerptSyntaxProjection;
  private readonly collapsed = new Set<number>();
  // How many excerpts have had their match highlights applied — so a streaming grow re-highlights
  // only the newly-appended excerpts (the existing ones' tags ride the append untouched).
  private highlightedCount = 0;
  private lastLineCount = 0; // view buffer line count, to detect row-count-changing edits
  private readonly disposables = new CompositeDisposable();
  private disposed = false;

  /** The LIVE coordinate map (re-segmentation swaps the underlying projection, so always read
   *  it through the Screen rather than caching it). */
  private get projection(): CoordinatesMap {
    return this.screen.view;
  }

  constructor(options: SearchResultsOptions) {
    this.onActivate = options.onActivate;
    this.editable = !!options.editable;
    this.registry = options.documents;
    this.cwd = options.cwd;
    if (this.editable && !this.registry) {
      throw new Error('SearchResultsView: editable mode requires a DocumentRegistry');
    }

    // Resolve each unique source once (live Document when editable, else a disk snapshot), then
    // back the editor with a Screen over those source buffers — the SAME substrate the
    // single-file editor uses. The painter highlights each excerpt from its source's own parse
    // via the ExcerptSyntaxProjection over the PV's (live) coordinate map.
    this.excerpts = prof(`construct.buildExcerpts(${options.excerpts.length})`, () => this.buildExcerpts(options.excerpts, options.cwd));
    this.excerptInputs = options.excerpts;
    const sourceBuffers = new Map([...this.sources].map(([key, entry]) => [key, entry.buffer] as const));
    // Headers + gaps are widget bands (not buffer rows), so the item list carries only real source
    // segments. A collapsed excerpt contributes just its first row (see `currentItems`).
    this.screen = prof('construct.Screen', () => new Screen(this.currentItems(), sourceBuffers));
    // Lazy syntax: hand the projection each source's parse thunk (deferred). TextEditor parses
    // the sources whose excerpts near the viewport — not all matched files up front.
    const syntaxMap = new Map(
      [...this.sources].map(([key, entry]) => [key, { syntax: entry.syntax, ensureParsed: entry.parse }] as const),
    );
    const painter = new ExcerptSyntaxProjection(() => this.screen.view, syntaxMap);
    this.painter = painter;

    // One editor, natively backed by the multi-source projection (the `MultiBufferDocument` supplies
    // the view buffer, the per-excerpt painter, and undo coordinating the touched sources). The
    // editor owns + disposes it.
    this.editor = prof('construct.TextEditor', () => new TextEditor({ source: new MultiBufferDocument(this.screen, painter) }));
    if (!this.editable) this.editor.model.setReadOnly(true);
    this.bands = this.editor.blockDecorations();
    // Scope the per-excerpt collapse keymap (`z a`/`z M`/`z R`) to this surface — more specific than
    // vim's `.TextEditor`, so it wins while other `z` motions fall through.
    this.editor.sourceView.addCssClass('search-results');
    this.root = this.editor.root;

    if (this.editable) {
      // Vim operators bypass the native editable tag, so gate them on the live map: only a
      // wholly-editable, single-source view range accepts an edit (block / spanning ranges
      // reject). The materialize layer already read-only-tags block rows for interactive input.
      this.editor.model.setEditableCheck((s, e) => this.screen.view.isScreenRangeEditable(s, e));
    }
    this.installNavigation();
    // Per-excerpt source line numbers: a left gutter that asks the live projection for the
    // source row behind each view row (blank on header/gap/blank). Sized to the widest source.
    let maxLine = 1;
    for (const entry of this.sources.values()) maxLine = Math.max(maxLine, entry.lines.length);
    this.gutter = new SourceLineNumberGutter(
      this.editor.sourceView,
      () => this.screen.view,
      maxLine,
      (line) => this.editor.inlineBlocks.placementAtLine(line),
    );
    prof('construct.highlightMatches', () => this.highlightMatches(this.excerptInputs, { clear: true }));
    prof('construct.installBands', () => this.installBands());
    if (this.editable) {
      // The HEADER/GAP bands need no per-edit handling: declared as source anchors (installBands),
      // their positions ride the BlockDecorations marks through every edit/undo/splice, and the
      // band SET only changes on collapse (which re-runs installBands). The only remaining per-edit
      // concern is the stitched SYNTAX highlighting — the painter needs a nudge after a row-count
      // reflow. Repaint on a row-count change (write-through; the projection is fresh then), and
      // again after a deferred reverse-sync remap settles (its 'changed' fires on a stale map).
      this.lastLineCount = this.editor.sourceView.getBuffer().getLineCount();
      this.editor.model.onDidChangeText(() => {
        if (this.screen.isSyncPending()) return; // stale map — the reflow handler repaints
        const n = this.editor.sourceView.getBuffer().getLineCount();
        if (n === this.lastLineCount) return;
        this.lastLineCount = n;
        this.editor.repaintSyntax();
      });
      this.screen.setReflowHandler(() => {
        this.lastLineCount = this.editor.sourceView.getBuffer().getLineCount();
        this.editor.repaintSyntax();
      });
    }
    // Materializing the buffer (setText) leaves the caret at the END; start at the top.
    this.editor.model.setCursorBufferPosition({ row: 0, column: 0 });
  }

  /** Declare the filename-header widget above each excerpt's first source row, and a gap band
   *  below the last row of each non-final segment (separating non-adjacent regions of one file),
   *  labelled diff-style with the next region's enclosing section (fallback `⋯`).
   *  Both are SOURCE-anchored block decorations (the editor projects them to view rows + reconciles
   *  in place); their positions then ride their anchor marks across edits. Only the band SET changes
   *  here — on construct and on collapse/expand (the chevron + which gaps exist). */
  private installBands(): void {
    const specs: BlockDecorationSpec[] = [];
    this.excerpts.forEach((excerpt, ei) => {
      const first = excerpt.segments[0];
      if (!first) return;
      const collapsed = this.collapsed.has(ei);
      // A `▸` chevron marks a collapsed file; an expanded one keeps the plain filename.
      const label = collapsed ? `▸ ${excerpt.header}` : excerpt.header;
      const headerScope = new CompositeDisposable();
      specs.push({
        id: `header:${ei}`,
        key: label,
        anchor: { documentKey: first.documentKey, row: first.startRow },
        placement: 'above',
        build: () => buildHeaderWidget(headerScope, label, first.documentKey, () => this.onActivate?.({ path: first.documentKey, row: first.startRow })),
        dispose: () => headerScope.dispose(),
      });
      // Gaps only when expanded (a collapsed excerpt is a single row — no gaps). Anchor the gap
      // ABOVE the NEXT segment's first row (a start-anchor), not below the previous segment's last
      // row: `o` on that last line inserts after a left-gravity start-of-line mark, so a below-anchor
      // wouldn't ride the growth and the opened line would land below the gap. The next segment's
      // first row is stable content its mark tracks, keeping the gap between the two regions.
      // The gap reads like the diff's fold markers: the enclosing section of the region below it
      // (git's function-context heuristic — same text DiffView shows, minus the `@@ -old +new @@`
      // range, which the source line-number gutter here would just restate), or a bare `⋯`.
      if (!collapsed) {
        const lines = this.sources.get(first.documentKey)?.lines ?? [];
        for (let i = 1; i < excerpt.segments.length; i++) {
          const seg = excerpt.segments[i];
          const gapLabel = enclosingSection(lines, seg.startRow) || '⋯';
          specs.push({
            id: `gap:${ei}:${i}`,
            key: gapLabel,
            anchor: { documentKey: seg.documentKey, row: seg.startRow },
            placement: 'above',
            build: () => buildGapWidget(new CompositeDisposable(), gapLabel), // no onActivate → no controller to sever
          });
        }
      }
    });
    this.bands.set(specs);
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

  /** Replace the shown excerpts — used by a streaming search to grow the surface as more files
   *  arrive. Registers any newly-resolved sources with the projection + syntax painter, then
   *  re-flows in place (the minimal-churn splice keeps the caret, syntax, and decorations of
   *  unchanged rows; new files append at the bottom). */
  setExcerpts(inputs: ExcerptInput[]): void {
    if (this.disposed) return;
    const highlightFrom = this.highlightedCount;
    this.excerpts = prof(`setExcerpts.buildExcerpts(${inputs.length})`, () => this.buildExcerpts(inputs, this.cwd));
    this.excerptInputs = inputs;
    // buildExcerpts resolved any new files into `sources`; hand each to the live screen + painter
    // so the projection can resolve their lines and highlight them (both adds are idempotent).
    for (const [key, entry] of this.sources) {
      this.screen.addSource(key, entry.buffer);
      this.painter.addSource(key, { syntax: entry.syntax, ensureParsed: entry.parse });
    }
    // Append the new rows (O(new)) instead of a full re-flow (O(rows²)) — this is the streaming
    // grow path. A non-append change (shouldn't happen here) re-flows fully and re-highlights all.
    const appended = prof(`setExcerpts.append(${this.excerpts.length})`, () => this.screen.appendItems(this.currentItems()));
    prof('setExcerpts.repaintSyntax', () => this.editor.repaintSyntax());
    prof('setExcerpts.installBands', () => this.installBands());
    prof('setExcerpts.highlight', () =>
      this.highlightMatches(this.excerptInputs, appended ? { from: highlightFrom } : { clear: true }),
    );
  }

  /** Re-derive the items for the new collapse state and re-flow the view (minimal-churn splice),
   *  re-placing the bands, re-painting, re-highlighting matches, and following the caret to its
   *  source row (or the file's surviving first row if its row was collapsed away). */
  private rebuild(): void {
    if (this.disposed) return;
    const caret = this.editor.model.getCursorBufferPosition();
    const anchor = this.projection.screenToDocument(caret.row, caret.column);
    prof(`rebuild.retarget(${this.excerpts.length})`, () => this.screen.retarget(this.currentItems()));
    prof('rebuild.repaintSyntax', () => this.editor.repaintSyntax());
    prof('rebuild.installBands', () => this.installBands());
    prof('rebuild.highlightMatches', () => this.highlightMatches(this.excerptInputs, { clear: true }));
    if (anchor.kind === 'document') {
      const pos =
        this.projection.documentToScreen(anchor.documentKey, anchor.row, anchor.column) ??
        this.firstVisibleViewPosition(anchor.documentKey);
      if (pos) this.editor.model.setCursorBufferPosition(pos);
    }
  }

  /** Which excerpt (index) the cursor sits in — the excerpt whose segments contain the cursor's
   *  source position; null on a row that maps to no source. */
  private excerptAtCursor(): number | null {
    const buffer = this.editor.sourceView.getBuffer();
    const row = asIter(buffer.getIterAtMark(buffer.getInsert())).getLine();
    const src = this.projection.screenToDocument(row, 0);
    if (src.kind !== 'document') return null;
    for (let i = 0; i < this.excerpts.length; i++) {
      for (const seg of this.excerpts[i].segments) {
        if (seg.documentKey === src.documentKey && src.row >= seg.startRow && src.row <= seg.endRow) return i;
      }
    }
    return null;
  }

  /** The view position of a source's first still-shown row (for caret recovery after a collapse). */
  private firstVisibleViewPosition(documentKey: string): { row: number; column: number } | null {
    for (const excerpt of this.excerpts) {
      const first = excerpt.segments[0];
      if (first?.documentKey !== documentKey) continue;
      const pos = this.projection.documentToScreen(documentKey, first.startRow, 0);
      if (pos) return pos;
    }
    return null;
  }

  /** Paint the search hits: map each match's SOURCE (row, col) span to view coords through the
   *  projection and decorate it on the shared `search` layer (the same highlight `/`-search
   *  uses). Tags anchor to buffer positions, so they track in-place edits; a re-materialize
   *  (reverse-sync) would drop them — fine for a browse/edit surface. */
  private highlightMatches(excerpts: ExcerptInput[], opts: { clear?: boolean; from?: number } = {}): void {
    const layer = this.editor.decorations.layer('search');
    if (opts.clear) layer.clear(); // full re-highlight (collapse): drop existing spans first
    const projection = this.screen.view;
    // A streaming grow highlights only the newly-appended excerpts (`from`); the existing ones'
    // tags survived the append. A full pass starts at 0.
    for (let i = opts.from ?? 0; i < excerpts.length; i++) {
      for (const m of excerpts[i].matches ?? []) {
        const start = projection.documentToScreen(excerpts[i].path, m.row, m.startCol);
        const end = projection.documentToScreen(excerpts[i].path, m.row, m.endCol);
        if (!start || !end) continue; // match row not projected (shouldn't happen — regions wrap matches)
        layer.decorate(new Range(start, end), 'highlight');
      }
    }
    this.highlightedCount = excerpts.length;
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
          documentKey: input.path,
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
    // Skip an oversized file without reading it (a giant generated/vendor blob would stall the
    // build and never render usefully).
    try {
      if (Fs.statSync(path).size > MAX_SOURCE_BYTES) return null;
    } catch {
      return null; // unreadable / gone
    }
    const entry = this.editable ? this.acquireLiveSource(path) : this.readSnapshotSource(path);
    if (!entry) return null;
    // A pathologically long line (minified JS / source map) hangs GtkSourceView — drop the file,
    // releasing the live Document ref the editable path took.
    if (entry.lines.some((line) => line.length > MAX_SOURCE_LINE)) {
      if (entry.document) this.registry!.release(entry.document);
      return null;
    }
    this.sources.set(path, entry);
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
    // Select the grammar + parse so the painter has captures — but DEFERRED, on demand when the
    // excerpt nears the viewport (TextEditor's lazy-syntax driver), so a search across many files
    // doesn't parse them all up front. A tab already showing this file parsed it already;
    // `setLanguageForPath` is idempotent (reuses the existing parse).
    return {
      buffer: document.modelBuffer,
      syntax: document.syntax, // owned by the Document; not disposed here
      lines: document.getText().split('\n'),
      document,
      parse: () => document.syntax.setLanguageForPath(path, { deferParse: true }),
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
    // Parse is DEFERRED until the excerpt nears the viewport (TextEditor's lazy-syntax driver) —
    // a search across many files shouldn't parse every match up front.
    return {
      buffer,
      syntax,
      lines: text.split('\n'),
      parse: () => syntax.setLanguageForPath(path, { deferParse: true }),
    };
  }

  /** Enter (on the focused view) + double-click activate the row under the cursor/pointer.
   *  Capture phase so Enter jumps before the vim layer treats it as a motion. In editable mode
   *  Enter only jumps in NORMAL mode (when the view isn't accepting text input) — in INSERT
   *  mode it stays a newline — and double-click keeps its word-select behaviour. */
  private installNavigation(): void {
    const view = this.editor.sourceView;
    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number) => {
      if (keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) return false;
      if (this.editable && view.getEditable()) return false; // insert mode: Enter is a newline
      this.activateRow(this.cursorRow());
      return true;
    });
    // Track + sever on dispose: this closure captures `this`, and node-gtk roots a connected
    // handler's closure, so leaving the controller on the (detached) view pins the whole
    // SearchResultsView graph — editor, acquired Documents, buffers, highlight tags — forever.
    // The search results view is rebuilt per query, so that residue grows unbounded.
    // See docs/lifecycle-and-disposal.md rule 9 and romgrk/node-gtk#455.
    this.disposables.addController(view, keys);

    if (this.editable) return; // word-select stays double-clickable while editing
    const click = new Gtk.GestureClick();
    click.on('pressed', (nPress: number, x: number, y: number) => {
      if (nPress < 2) return; // double-click only
      const by = view.windowToBufferCoords(Gtk.TextWindowType.TEXT, x, y);
      const yBuf = Array.isArray(by) ? by[by.length - 1] : y;
      const r = view.getLineAtY(yBuf);
      this.activateRow(asIter(Array.isArray(r) ? r[0] : r).getLine());
    });
    this.disposables.addController(view, click); // severed in dispose (see the key controller above)
  }

  private cursorRow(): number {
    const buffer = this.editor.sourceView.getBuffer();
    return asIter(buffer.getIterAtMark(buffer.getInsert())).getLine();
  }

  private activateRow(viewRow: number): void {
    const target = this.projection.screenToDocument(viewRow, 0);
    if (target.kind === 'document') this.onActivate?.({ path: target.documentKey, row: target.row });
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
    // Sever the navigation controllers FIRST, while the source view still exists: their
    // closures capture `this`, and node-gtk roots connected-handler closures, so leaving them
    // on would pin this whole view (editor + acquired Documents + buffers + tags) — the
    // dominant project-search leak. See installNavigation + romgrk/node-gtk#455.
    this.disposables.dispose();
    this.bands.clear();
    this.gutter.dispose();
    // The editor owns the Screen (via its MultiBufferDocument); disposing the editor
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
