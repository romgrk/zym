/*
 * SyntaxController — the per-view syntax *painter*. It paints tree-sitter highlighting
 * and drives code folding for one GtkSource.View/Buffer pair, replacing GtkSourceView's
 * `.lang` engine for the languages we have a grammar for.
 *
 * The parse itself lives in a shared `DocumentSyntax` (per Document, model coords —
 * Phase 0 of the multibuffer split). This painter pulls model-coordinate captures and
 * fold-region discovery from it, translates them into *this* view's coordinates (identity
 * while the view has no collapsed folds), and applies its own TextTags by range. Tag
 * colors come from the theme palette. It subscribes to `DocumentSyntax.onDidReparse` to
 * repaint its viewport after a (debounced) reparse.
 *
 * Folding: foldable ranges are discovered on the model (by DocumentSyntax) and mapped to
 * this view; a range collapses by physically replacing its body with a `[N]` placeholder
 * in the VIEW buffer (the model keeps the full text — the projection lives in the
 * Document). Folds are per-view state, owned here. Since folds never touch the model, the
 * model parse stays valid through a fold — no reparse-after-fold dance.
 *
 * Folding is driven by the public `toggleFoldAtCursor`/`setFoldAtCursor`/
 * `foldAll`/`unfoldAll` methods; the editor wires them to `fold:*` commands that
 * the vim keymap's `z`-prefix (za/zo/zc/zr/zm) dispatches.
 */
import Pango from 'gi:Pango-1.0';
import Gtk from 'gi:Gtk-4.0';
import type GtkSource from 'gi:GtkSource-5';
type SourceBuffer = InstanceType<typeof GtkSource.Buffer>;
type SourceView = InstanceType<typeof GtkSource.View>;
import { Point } from '../text/Point.ts';
import { theme } from '../theme/theme.ts';
import { findBracketPair } from './bracketMatch.ts';
import { type NodeRowRange } from './indent.ts';
import { type TagName } from './tags.ts';
import { type Crumb } from './breadcrumb.ts';
import { DocumentSyntax } from './DocumentSyntax.ts';
import type { SyntaxProjection, SyntaxSlice } from './SyntaxProjection.ts';
import { rangeGaps, mergeRange, type LineRange } from './paintRegions.ts';
import { HighlightTags } from './highlightTags.ts';
import { GutterRenderer } from './gutterRenderers.ts';
/** The screen↔document projection a SyntaxController folds through (the editor's Document).
 *  The painter parses the *document* (via a shared `DocumentSyntax`) and translates captures
 *  + tree-query results through these, so the line/point translators are now part of the
 *  contract (each returns identity while a view has no collapsed folds). */
/**
 * The per-view buffer↔screen projection that SyntaxController — and, via TextEditor's
 * FoldAccess adapter, the cursor model — consumes: fold operations plus document↔screen
 * coordinate translation, all in ONE view's own coordinates. There is no buffer parameter:
 * the caller holds the projection for its view. Satisfied by `Screen` (a single file through
 * `Document.createView`, or a multibuffer surface). The fold handle is opaque (`any`) to
 * consumers — they only store it and hand it back.
 */
export interface ScreenProjection {
  fold(screenStart: number, screenEnd: number, placeholder: string): any;
  unfold(fold: any): void;
  foldPlaceholderRange(fold: any): [number, number];
  /** The document text a fold currently collapses (for matching during search). */
  foldDocumentText(fold: any): string;
  /** The DOCUMENT row span `[startRow, endRow]` a fold covers (for buffer-space fold motions). */
  foldDocumentRowSpan(fold: any): [number, number];
  /** False once an enclosing fold has subsumed this one (its marks are gone). */
  isFoldAlive(fold: any): boolean;
  documentPointFromScreen(point: Point): Point;
  screenPointFromDocument(point: Point): Point;
  documentLineForScreenLine(screenLine: number): number;
  screenLineForDocumentLine(documentLine: number): number;
  documentLineText(row: number): string;
}

// Paint newly-revealed lines this often *during* a scroll (a throttle, not a trailing
// debounce — so a held ctrl-d/ctrl-u keeps up instead of leaving white text until it
// stops). One frame; the gap painted per tick is bounded by the visible range, and
// already-painted lines are skipped, so this stays cheap.
const VIEWPORT_THROTTLE_MS = 16;
// Highlight this many lines above/below the viewport, so scrolling within the
// band shows highlighted text immediately while a repaint catches up.
const VIEWPORT_MARGIN_LINES = 80;
// On the very first paint the view is realized but not yet size-allocated, so the
// viewport geometry is unknown (visibleRange is null). Rather than highlight the WHOLE
// buffer then — O(file): on a dense 3k-line file that's ~840ms of frozen open, ~1.5s at
// 8k — paint just this many lines from the top (the initial viewport is the file's head).
// Generous enough to cover any real monitor's text area, so there's no first-frame flicker;
// a taller viewport (or any scroll) is covered by the normal viewport repaints. Makes open
// O(viewport) — roughly constant regardless of file size.
const INITIAL_PAINT_LINES = 250;

// Chars scanned each side of the cursor for the matching bracket — bounds the
// cost on huge buffers (a far-away or unmatched bracket simply isn't highlighted).
const BRACKET_SCAN_WINDOW = 5_000;

// GtkSourceGutter's fixed internal padding around the line-number + fold renderers, in px
// (their xpad barely affects the allocated width). Used to reserve the gutter's space up
// front so the deferred gutter install doesn't shift the text. Measured empirically.
const GUTTER_PADDING_PX = 5;

interface FoldRegion {
  startLine: number; // header line (stays visible; gets the inline [...] anchor)
  endLine: number;   // footer line (only meaningful while expanded)
  folded: boolean;   // whether the body is currently collapsed in this view
  handle?: any;      // the Document fold handle while collapsed
  joinFooter?: boolean; // collapse the footer onto the header line (single-line fold)
}

// A view range [[row,col],[row,col]] revealed by opening a fold the caret was on —
// the editor selects it so the just-unfolded text reads "as the cursor".
export type RevealedRange = [[number, number], [number, number]];

// node-gtk returns `[inRange, iter]` for the get_iter_at_* family but a bare
// iter for get_start/end_iter. Normalize to an iter.
function asIter(r: any): any {
  return Array.isArray(r) ? r[r.length - 1] : r;
}

// The shared `invisible` tag that performs folding. Other gutter renderers (git
// change bars, diagnostics) look it up by name to skip hidden lines so their
// glyphs don't pile up at the collapsed fold position.
export const FOLD_HIDDEN_TAG_NAME = 'ts:fold-hidden';

/** Whether buffer `line` is hidden inside a fold (any gutter renderer can call this). */
export function isLineFolded(buffer: any, line: number): boolean {
  const tag = buffer.getTagTable().lookup(FOLD_HIDDEN_TAG_NAME);
  return tag ? asIter(buffer.getIterAtLine(line)).hasTag(tag) : false;
}

/** A UTF-16 low surrogate (the second half of a non-BMP codepoint pair). */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export class SyntaxController {
  private readonly buffer: SourceBuffer;
  private readonly view: SourceView;

  // The shared per-Document parse (model coords). The painter pulls captures + fold
  // discovery + tree queries from here and translates them into this view. When no shared
  // instance is supplied (bare-buffer tests, diff panes), it owns a private one over its
  // own view buffer — then source == view, so the translation below is identity.
  private readonly docSyntax: DocumentSyntax;
  private readonly ownsDocSyntax: boolean;
  private reparseUnsub: (() => void) | undefined;
  // A multi-source projection (multibuffer): when set, the painter sources captures from
  // many Documents stitched into this buffer instead of its single docSyntax + fold map.
  private readonly projection: SyntaxProjection | null;

  // The syntax-highlight tag vocabulary (color + decoration tags) built from the
  // theme; owns capture→tag resolution and the paint sweep (see highlightTags.ts).
  private readonly highlight: HighlightTags;
  private readonly invisibleTag: any;
  // Styles each collapsed-fold placeholder ([...]) — muted + non-editable.
  private readonly foldPlaceholderTag: any;
  // The projection folds collapse through (editor's Document; null for diff panes).
  private screen: ScreenProjection | null = null;
  // Active fold handles, one per collapsed region (bodies live only in the model).
  private readonly activeFolds: any[] = [];
  // Folds the user wants closed, keyed by MODEL start row (stable across folding — folds
  // never touch the model). Only the OUTERMOST closed fold of a nest is physically collapsed
  // (an inner fold inside a placeholder has no view text), so a child's closed state lives
  // only here. Re-applied on expand so opening a parent re-collapses its closed children —
  // Vim's `zm`/`zc` nested-fold behavior. Cleared by `unfoldAll`. Code (shared-model) folds
  // only; provided/diff folds are flat and don't use it.
  private readonly desiredClosed = new Set<number>();
  // Notified after any fold open/close so the editor re-places fold-dependent
  // decorations (diagnostics squiggles, inlay hints) at the shifted view lines.
  private readonly foldsChangedHandlers: Array<() => void> = [];
  // Highlights the bracket under the cursor and its match; cursor-driven, managed
  // separately from the parse-driven highlight tags (not in `allTags`).
  private readonly bracketMatchTag: any;

  // The single composite gutter renderer (number + chevron + git + diag), null
  // until installed / when no gutter is wanted, and the digit width its size is
  // currently primed for. GtkSourceGutterRendererText sizes from its set text, so
  // we prime it to the widest line and re-prime when the digit count changes
  // (see primeGutter).
  private gutterRenderer: any = null;
  private lineNumberPrimedDigits = -1;
  // Git change bar / diagnostic glyph cells, fed by GitGutter / DiagnosticsView via
  // setGitCell / setDiagCell (they no longer own renderers). null = no such column;
  // a function returns the per-line markup fragment (or '' for a blank, padded cell).
  private gitCell: ((screenLine: number) => string) | null = null;
  private diagCell: ((screenLine: number) => string) | null = null;
  // Cached line-number digit width. The gutter renderer reads this once per visible
  // line per paint, so it must not call getLineCount() (an FFI) each time; it's
  // refreshed from primeGutter (on every buffer edit) and lazily on first read.
  private cachedLineDigits = 0;
  // The gutter is installed lazily after the first paint (see the constructor note);
  // these track the deferred state.
  private wantLineNumbers = false;
  private gutterInstalled = false;
  private gutterReserved = false;

  // Per-line text cache (this VIEW buffer) backing the UTF-16→codepoint column conversion
  // on the identity (no-fold) paint path; cleared on each repaint. astral-ness itself is
  // tracked by the shared DocumentSyntax (`docSyntax.hasAstral`).
  private readonly lineTextCache = new Map<number, string>();
  readonly foldsByHeaderLine = new Map<number, FoldRegion>();

  private viewportThrottleId: NodeJS.Timeout | null = null;
  // The vadjustment our scroll-repaint handler is bound to. The ScrolledWindow swaps
  // the view's adjustment when it's parented, so we rebind when it changes (a plain
  // "already connected" guard would pin us to the throwaway default → scroll never
  // repaints → folds reveal unpainted regions on scroll).
  private scrollAdj: any = null;
  // True once dispose() has run: stops deferred work (debounced refreshes, the
  // cursor-position bracket match) from touching a buffer/view that GTK is
  // finalizing or a tree-sitter tree that's been freed — a stale handler reading
  // a freed tree is a wasm "memory access out of bounds" crash.
  private disposed = false;
  // The signal connections we own, so dispose() can detach them. node-gtk's
  // `off(event, cb)` needs the exact callback reference, so we keep them.
  private readonly connections: Array<{ target: any; event: string; cb: (...args: any[]) => any }> = [];
  // The line ranges whose token highlighting is currently applied and valid — a PERSISTENT
  // cache that grows as the view scrolls (we never clear it on scroll: the text didn't
  // change, so the tags stay correct). Sorted, non-overlapping, inclusive `[from, to]`.
  // A scroll only paints the parts of the new visible range not already in here; an edit
  // (or fold / new document) resets it, since a reparse can change tokens anywhere.
  private paintedRanges: LineRange[] = [];
  // Whether folding is active at all (chevron gutter + the fold projection). When
  // off (e.g. peek views) there is no folding of any method.
  private readonly foldingEnabled: boolean;
  constructor(
    view: SourceView,
    buffer: SourceBuffer,
    options: {
      lineNumbers?: boolean;
      folding?: boolean;
      screen?: ScreenProjection;
      documentSyntax?: DocumentSyntax;
      projection?: SyntaxProjection;
    } = {},
  ) {
    this.view = view;
    this.buffer = buffer;
    this.foldingEnabled = options.folding !== false;

    const table = buffer.getTagTable();
    const mk = (props: Record<string, unknown>) => { const t = new Gtk.TextTag(props); table.add(t); return t; };

    // Build the syntax-highlight tags FIRST: tag priority follows creation order,
    // so the bracket-match / fold-placeholder tags created below layer on top.
    this.highlight = new HighlightTags(table);

    // The tag that performs the actual hiding when a range is folded.
    this.invisibleTag = new Gtk.TextTag({ name: FOLD_HIDDEN_TAG_NAME, invisible: true });
    buffer.getTagTable().add(this.invisibleTag);
    this.foldPlaceholderTag = new Gtk.TextTag({ name: 'ts:fold-placeholder', editable: false, foreground: theme.ui.text.muted });
    buffer.getTagTable().add(this.foldPlaceholderTag);

    // Bracket-match highlight (subtle box-like background + bold).
    this.bracketMatchTag = mk({
      name: 'bracket-match',
      background: theme.ui.surface.selected,
      weight: Pango.Weight.BOLD,
    });

    // Gutter renderers are NOT inserted here: a gutter forces GtkTextView to validate
    // every line on first allocate (so it can position the gutter cells), and during
    // that pass each renderer's queryData is called once per buffer line — for a large
    // file that's thousands of node-gtk vfunc crossings before the first frame (a 1-3s
    // freeze on open). Instead we install the gutter after the first paint, once the
    // view's line metrics are validated, so it only ever queries the visible lines.
    this.wantLineNumbers = !!options.lineNumbers;
    if (this.foldingEnabled) this.screen = options.screen ?? null;

    // The shared parse runs on the model; this painter owns only its view. Use the
    // supplied DocumentSyntax (one parse for all of a document's views) or, with none,
    // a private one over this view's own buffer (source == view → identity translation).
    this.docSyntax = options.documentSyntax ?? new DocumentSyntax(buffer);
    this.ownsDocSyntax = !options.documentSyntax;
    // A projection (multibuffer) stitches many Documents' parses into this buffer; without
    // one, the painter paints its single docSyntax through the fold map (the common case).
    this.projection = options.projection ?? null;
    // Repaint this view after every (debounced) reparse — of the projection's sources in
    // multibuffer mode, else of this view's own document parse.
    this.reparseUnsub = (this.projection ?? this.docSyntax).onDidReparse(() => this.onReparse());

    // Keep the gutter wide enough as the line count grows. The reparse is driven off the
    // model by DocumentSyntax (not from here) — we only react to it via onReparse.
    this.connect(buffer, 'changed', () => this.primeGutter());

    // Re-highlight the newly-revealed lines as the view scrolls. The vadjustment
    // is set by the enclosing ScrolledWindow after construction, so connect when
    // it appears (notify::vadjustment) as well as now if it's already there.
    const connectScroll = () => {
      const vadj = view.getVadjustment?.();
      if (vadj && vadj !== this.scrollAdj) {
        this.scrollAdj = vadj;
        this.connect(vadj, 'value-changed', () => this.scheduleViewportRepaint());
      }
    };
    this.connect(view, 'notify::vadjustment', connectScroll);
    connectScroll();

    // Re-highlight the matching bracket whenever the cursor moves (text-based, so
    // it works regardless of grammar).
    this.connect(buffer, 'notify::cursor-position', () => this.updateBracketMatch());
  }

  /** Connect a signal handler and remember it so dispose() can detach it. */
  private connect(target: any, event: string, cb: (...args: any[]) => any): void {
    target.on(event, cb);
    this.connections.push({ target, event, cb });
  }

  /**
   * Tear down: stop all deferred work and free tree-sitter resources. Called when
   * the owning editor view is destroyed. Without this, the buffer/view signal
   * handlers stay connected and the debounce timers stay scheduled after the view
   * is gone; a stale cursor-position handler then reads a freed tree (a wasm
   * "memory access out of bounds" crash). Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.viewportThrottleId) { clearTimeout(this.viewportThrottleId); this.viewportThrottleId = null; }
    this.reparseUnsub?.(); // stop reacting to reparses (else a shared DocumentSyntax pins us)
    this.reparseUnsub = undefined;
    for (const { target, event, cb } of this.connections) {
      try { target.off(event, cb); } catch { /* target already finalized — nothing to detach */ }
    }
    this.connections.length = 0;
    // Remove the composite renderer and drop its back-reference to us + the git/diag cell
    // closures (which capture GitGutter / DiagnosticsView), so a detached-but-retained view
    // doesn't pin this controller and its providers (tab-close detaches, never destroys).
    if (this.gutterRenderer) {
      try { (this.view as any).getGutter(Gtk.TextWindowType.LEFT).remove(this.gutterRenderer); } catch { /* gutter already gone */ }
      this.gutterRenderer.controller = null;
      this.gutterRenderer = null;
    }
    this.gitCell = null;
    this.diagCell = null;
    // Free a PRIVATE DocumentSyntax (its tree + injection parsers); a shared one is owned
    // and disposed by the Document when its last view goes.
    if (this.ownsDocSyntax) this.docSyntax.dispose();
  }

  /**
   * Whether `(row, column)` is inside a string, comment, or regex — used to skip
   * brackets that aren't real code. Walks up the tree from the position; false
   * when there's no parse tree.
   */
  isInStringOrComment(row: number, column: number): boolean {
    const [docRow, docCol] = this.documentPos(row, column);
    return this.docSyntax.isInStringOrComment(docRow, docCol);
  }

  /** Highlight the bracket under (or just before) the cursor and its match. */
  private updateBracketMatch(): void {
    if (this.disposed) return;
    const buffer = this.buffer;
    buffer.removeTag(this.bracketMatchTag, buffer.getStartIter(), buffer.getEndIter());
    const cursor = asIter(buffer.getIterAtMark(buffer.getInsert())).getOffset();
    const len = buffer.getCharCount();
    const from = Math.max(0, cursor - BRACKET_SCAN_WINDOW);
    const to = Math.min(len, cursor + BRACKET_SCAN_WINDOW);
    const text = buffer.getText(asIter(buffer.getIterAtOffset(from)), asIter(buffer.getIterAtOffset(to)), true);
    const pair = findBracketPair(text, cursor - from);
    if (!pair) return;
    const cells = pair.map((p) => ({
      a: asIter(buffer.getIterAtOffset(from + p)),
      b: asIter(buffer.getIterAtOffset(from + p + 1)),
    }));
    // Ignore brackets inside strings/comments/regex (e.g. a `)` in a string literal):
    // they'd throw off matching and shouldn't light up.
    if (cells.some(({ a }) => this.isInStringOrComment(a.getLine(), a.getLineOffset()))) return;
    for (const { a, b } of cells) buffer.applyTag(this.bracketMatchTag, a, b);
  }

  /**
   * Select the grammar for this file's content via the shared parse, then paint this
   * view. Returns true if tree-sitter handles it (caller leaves the `.lang` engine off);
   * false if unsupported. For a second view of an already-parsed document the parse is
   * reused (DocumentSyntax is idempotent) and this just paints the new view.
   *
   * Synchronous: grammars are preloaded before the main loop, so this only does a cache
   * lookup + (at most) one parse.
   */
  setLanguageForPath(path: string): boolean {
    // Reserve the gutter width now (content is loaded, line count known) so the deferred
    // gutter install doesn't shift the text.
    this.reserveGutterSpace();
    this.buffer.setHighlightSyntax(false); // we own highlighting now
    const handled = this.docSyntax.setLanguageForPath(path);
    if (!handled) {
      this.clearHighlight();
      this.foldsByHeaderLine.clear();
      this.scheduleGutterInstall();
      this.view.queueDraw();
      return false;
    }
    this.restyle();
    this.repaint(); // paint this view from the (shared) tree — silent for siblings
    this.rebuildFoldMap();
    this.scheduleGutterInstall();
    this.view.queueDraw();
    return true;
  }

  /** Drop tree-sitter highlighting — for an unsupported language, or a caller (TextEditor)
   *  bailing out on a pathological long-line file so it opens instead of hanging. Clears
   *  this view's highlight tags but keeps the deferred line-number gutter; the shared parse
   *  is dropped (long-line mode is a property of the whole document). */
  disableHighlighting(): void {
    this.docSyntax.disableHighlighting();
    this.paintedRanges = [];
    this.reserveGutterSpace();
    this.clearHighlight();
    this.foldsByHeaderLine.clear();
    this.scheduleGutterInstall();
    this.view.queueDraw();
  }

  /** Diagnostic: capture-name counts from the current parse tree (for tests). */
  captureCounts(): Record<string, number> {
    return this.docSyntax.captureCounts();
  }

  /**
   * Re-apply token colors from the theme palette. Colors are fixed (not
   * scheme-derived), so this is independent of the Adwaita light/dark chrome;
   * kept as a method because the window calls it when the system scheme changes.
   */
  restyle(): void {
    this.highlight.restyle();
  }

  // --- highlighting (paint shared model-coord captures into this view) -------

  /** React to a (debounced) reparse on the shared model: re-translate + repaint this
   *  view's viewport and rebuild its fold map (a structural edit can add/remove
   *  discovered fold regions). */
  private onReparse(): void {
    if (this.disposed) return;
    this.repaint();
    this.rebuildFoldMap();
    this.view.queueDraw();
  }

  /**
   * Re-highlight after a reparse (edit / new content) or a fold toggle. A reparse can
   * change tokens anywhere, so this drops ALL of our highlight tags and repaints the
   * viewport fresh, then RESETS the persistent cache (`paintedRanges`) to that viewport —
   * scrolling re-accumulates the rest. Bounded to the viewport (± a margin) when realized,
   * so large files only pay for what's on screen; off-screen the whole buffer is done
   * (small files / headless).
   */
  private repaint(): void {
    if (!this.hasContent()) return;
    this.lineTextCache.clear();
    const buffer = this.buffer;
    // Clear only OUR highlight tags (the fold placeholder tags are separate, untouched).
    this.highlight.clear(buffer, buffer.getStartIter(), buffer.getEndIter());
    const range = this.visibleRange() ?? this.initialPaintRange();
    if (range) {
      this.paintViewLines(range[0], range[1]);
      this.paintedRanges = [range];
    } else {
      this.paintViewLines(null, null); // whole buffer (headless / pre-layout)
      this.paintedRanges = [[0, buffer.getLineCount() - 1]];
    }
    this.projection?.decorate(buffer); // style filename headers / gaps (multibuffer)
  }

  /** Whether there's anything to paint: the projection's sources (multibuffer) or this
   *  view's own document parse. */
  private hasContent(): boolean {
    return this.projection ? this.projection.hasContent() : this.docSyntax.hasTree;
  }

  /** Trigger a full (re)paint now. The single-source path paints on setLanguageForPath /
   *  reparse; a projection (multibuffer) view calls this once its content + sources are in
   *  place, since it has no language-set step. */
  paint(): void {
    this.onReparse();
  }

  /** Paint token highlighting over VIEW lines `[vFrom, vTo]` (null,null = whole buffer).
   *  In multibuffer mode it pulls each overlapping source's captures and paints them at the
   *  excerpt's view rows; otherwise it pulls the single document parse and translates
   *  through the fold map (identity while the view has no collapsed folds). Additive — never
   *  clears — so it doesn't disturb already-painted neighbours. */
  private paintViewLines(vFrom: number | null, vTo: number | null): void {
    if (!this.hasContent()) return;
    if (this.projection) {
      const from = vFrom ?? 0;
      const to = vTo ?? this.buffer.getLineCount() - 1;
      for (const slice of this.projection.paintSlices(from, to)) {
        const captures = slice.syntax.captures(slice.fromRow, slice.toRow);
        this.highlight.paint(this.buffer, captures, (row, col) => this.sliceIter(slice, row, col));
      }
      return;
    }
    const [mFrom, mTo] = vFrom === null || vTo === null ? [null, null] : this.documentLineRange(vFrom, vTo);
    const captures = this.docSyntax.captures(mFrom, mTo);
    // CLAMP each capture position to the painted document range `[mFrom, mTo]`. A capture can
    // be much wider than the range — the whole `(arrow_function) @function` body, a multi-line
    // string/comment — and the run sweep paints its full extent. Without clamping, that broad
    // color bleeds onto lines below/above the range that haven't been painted with their own
    // token tags yet, and since the scroll repaint is ADDITIVE (never clears) the stray tag
    // survives until a full `repaint()` (an edit/fold) clears the buffer — the "arrow-function
    // body is all yellow until you type in it" bug. Mirror of `sliceIter`'s clamp for the
    // multibuffer path (the comment-colored-constructor bug); identity when range is null.
    const iterAt = mFrom === null || mTo === null
      ? (row: number, col: number) => this.screenIterForDocument(row, col)
      : (row: number, col: number) => {
          if (row < mFrom) return this.screenIterForDocument(mFrom, 0);
          if (row > mTo) return this.lineEndIter(this.screenRow(mTo));
          return this.screenIterForDocument(row, col);
        };
    this.highlight.paint(this.buffer, captures, iterAt);
  }

  /** A VIEW-buffer iter for a source `(row, col)` capture inside a projection `slice` (a
   *  linear excerpt mapping). Astral columns convert against the view line, which is a
   *  verbatim copy of the source row.
   *
   *  CLAMPED to the slice's `[fromRow, toRow]` span: a capture can extend beyond the excerpt
   *  (e.g. a block/doc comment that spans rows the excerpt only shows part of), and since the
   *  view buffer stitches non-adjacent excerpts contiguously, applying such a tag from its
   *  raw mapped start to end would BLEED across the buffer into other excerpts (the
   *  comment-colored constructor bug). Clamping a position before the slice to its first row
   *  (col 0) and one after to its last row's end keeps every tag inside its own excerpt. */
  private sliceIter(slice: SyntaxSlice, sourceRow: number, sourceCol: number): any {
    if (sourceRow < slice.fromRow) return asIter(this.buffer.getIterAtLineOffset(slice.viewStart, 0));
    if (sourceRow > slice.toRow) return this.lineEndIter(slice.viewStart + (slice.toRow - slice.sourceStart));
    const screenRow = slice.viewStart + (sourceRow - slice.sourceStart);
    const col = slice.syntax.hasAstral ? this.toCodepointColumn(screenRow, sourceCol) : sourceCol;
    return asIter(this.buffer.getIterAtLineOffset(screenRow, col));
  }

  /** On scroll (no reparse): paint just the parts of the visible range not already in the
   *  persistent cache, then record it. Never clears — existing tags stay valid because the
   *  text didn't change — so scroll-down-then-up costs nothing, and a held ctrl-d/u keeps up. */
  private paintNewlyVisible(): void {
    if (!this.hasContent()) return;
    const range = this.visibleRange();
    if (!range) return; // unrealized / headless — only the reparse path (whole buffer) runs there
    const [top, bottom] = range;
    const gaps = rangeGaps(this.paintedRanges, top, bottom);
    if (gaps.length === 0) return; // visible rows already highlighted — nothing to do
    this.lineTextCache.clear();
    for (const [a, b] of gaps) this.paintViewLines(a, b);
    this.paintedRanges = mergeRange(this.paintedRanges, top, bottom);
    this.view.queueDraw();
  }

  /** Install the gutter once the view is sized (its line metrics validated). Deferred off
   *  the first paint so the gutter only queries the visible lines, not every line in the
   *  buffer (each query is a node-gtk vfunc — thousands of them is the open-file freeze).
   *  Headless / already-sized: install now. */
  private scheduleGutterInstall(): void {
    if (this.gutterInstalled) return;
    const view = this.view;
    if (!view.getRealized() || view.getHeight() > 0) { this.installGutter(); return; }
    let frames = 0;
    const tick = (): boolean => {
      if (this.disposed || this.gutterInstalled) return false;
      if (view.getHeight() > 0) { this.installGutter(); return false; }
      return ++frames < 120;
    };
    view.addTickCallback(tick);
  }

  /**
   * Set a left margin equal to the eventual gutter width, so the deferred gutter install
   * replaces the blank margin in place (the line numbers fade in without the text jumping
   * right). Measured from the view's monospace font: line-number digits + the fold chevron,
   * plus each renderer's xpad. Runs once, before the first paint; `installGutter` clears it.
   */
  private reserveGutterSpace(): void {
    if (this.gutterReserved || this.gutterInstalled || !this.wantLineNumbers) return;
    this.gutterReserved = true;
    const view = this.view as any;
    const measure = (s: string): number => {
      const layout = view.createPangoLayout(s);
      const size = layout.getPixelSize();
      return Array.isArray(size) ? size[0] : (size?.width ?? 0);
    };
    // Gutter width = line-number text + (space + fold chevron) + the git / diagnostic
    // cells (one monospace char each, when present) + a small fixed GtkSourceGutter
    // padding (measured empirically: xpad barely affects the allocated width). Reserving
    // exactly this keeps the text column fixed when the composite gutter installs.
    const m4 = measure('0'.repeat(this.lineNumberWidth()));
    const mFold = this.foldingEnabled ? measure(' ▾') : 0;
    const extraCols = (this.gitCell ? 1 : 0) + (this.diagCell ? 1 : 0);
    const mExtra = extraCols ? measure('0'.repeat(extraCols)) : 0;
    this.reservedPx = m4 + mFold + mExtra + GUTTER_PADDING_PX;
    view.setLeftMargin(this.reservedPx);
  }
  private reservedPx = 0;

  /**
   * Insert the single composite gutter renderer (line number + chevron + git + diag).
   * Deferred until after the first paint (when the view's line metrics are validated) so
   * the gutter only queries the visible lines, not every line in the buffer — see the
   * constructor note. Idempotent. Skipped entirely when neither numbers nor folding are
   * wanted (compact / peek views); git + diag cells are only fed in full file mode, which
   * always wants both, so the renderer always exists when they register.
   */
  private installGutter(): void {
    if (this.gutterInstalled || this.disposed) return;
    if (!this.wantLineNumbers && !this.foldingEnabled) return;
    this.gutterInstalled = true;
    // Drop the reserved left margin: the gutter now occupies that space, so swapping them
    // in the same layout pass keeps the text column fixed (no shift).
    if (this.gutterReserved) this.view.setLeftMargin(0);
    const gutter = (this.view as any).getGutter(Gtk.TextWindowType.LEFT);
    // ONE renderer composes the whole gutter (custom + fold-aware: GtkSourceView's
    // built-in line numbers render a number for every folded line at the collapsed y —
    // a mashup — and four separate renderers each build a PangoLayout per line; this
    // builds one). Display-only: the chevron shows but doesn't take clicks (keyboard folds).
    const renderer = new GutterRenderer();
    (renderer as any).controller = this;
    renderer.setXpad(3);
    gutter.insert(renderer, 0);
    this.gutterRenderer = renderer;
    this.primeGutter();
  }

  // --- Composite gutter cells (GutterCellSink) -------------------------------
  // GitGutter / DiagnosticsView feed their per-line markup here instead of inserting
  // their own renderers; the one composite renderer reads it back via gitCellFor /
  // diagCellFor. Setting a cell re-primes the width (the column appeared / vanished)
  // and redraws.

  /** @internal The git change-bar column is active (read by the renderer for width). */
  get hasGitColumn(): boolean { return this.gitCell !== null; }
  /** @internal The diagnostic-glyph column is active. */
  get hasDiagColumn(): boolean { return this.diagCell !== null; }

  setGitCell(cell: ((screenLine: number) => string) | null): void {
    this.gitCell = cell;
    if (this.disposed) return; // GitGutter.dispose may run after ours — don't touch the buffer
    this.lineNumberPrimedDigits = -1; // force re-prime (column width changed)
    this.primeGutter();
    this.redrawGutter();
  }

  setDiagCell(cell: ((screenLine: number) => string) | null): void {
    this.diagCell = cell;
    if (this.disposed) return;
    this.lineNumberPrimedDigits = -1;
    this.primeGutter();
    this.redrawGutter();
  }

  /** Markup fragment for the git bar / diagnostic glyph on `screenLine` ('' = blank). */
  gitCellFor(screenLine: number): string { return this.gitCell ? this.gitCell(screenLine) : ''; }
  diagCellFor(screenLine: number): string { return this.diagCell ? this.diagCell(screenLine) : ''; }

  /** Repaint the gutter (a git/diagnostic recompute changed a cell). No-op pre-install. */
  redrawGutter(): void { this.gutterRenderer?.queueDraw(); }

  /** Paint newly-revealed lines while scrolling. A THROTTLE (one pass per frame), not a
   *  trailing debounce — so a held ctrl-d/ctrl-u stays highlighted as it goes instead of
   *  showing white until it stops. `paintNewlyVisible` skips already-painted lines, so a
   *  pass that reveals nothing new is nearly free. */
  private scheduleViewportRepaint(): void {
    if (this.disposed || !this.hasContent()) return;
    if (this.viewportThrottleId) return; // a pass is already pending this interval
    this.viewportThrottleId = setTimeout(() => {
      this.viewportThrottleId = null;
      this.paintNewlyVisible();
    }, VIEWPORT_THROTTLE_MS);
  }

  /** The visible buffer range as VIEW lines `[top, bottom]` (± a margin), or null (whole
   *  buffer) when the view isn't realized/laid out yet (initial load, headless). */
  private visibleRange(): [number, number] | null {
    const view = this.view;
    if (!view.getRealized()) return null;
    const rect = view.getVisibleRect();
    if (!rect || !rect.height) return null;
    const buffer = this.buffer;
    const lineAtY = (y: number): number => {
      const r = view.getLineAtY(y);
      return asIter(Array.isArray(r) ? r[0] : r).getLine();
    };
    const last = buffer.getLineCount() - 1;
    const top = Math.max(0, lineAtY(rect.y) - VIEWPORT_MARGIN_LINES);
    const bottom = Math.min(last, lineAtY(rect.y + rect.height) + VIEWPORT_MARGIN_LINES);
    return [top, bottom];
  }

  /** Fallback range when `visibleRange` is null. A *realized but not-yet-sized* view (the
   *  first paint on open) bounds to the top INITIAL_PAINT_LINES — the initial viewport is
   *  the file's head — so open is O(viewport) not O(file). A genuinely unrealized view
   *  (headless / tests) returns null so the whole buffer is still painted. */
  private initialPaintRange(): [number, number] | null {
    if (!this.view.getRealized()) return null;
    const last = this.buffer.getLineCount() - 1;
    return [0, Math.min(INITIAL_PAINT_LINES, last)];
  }

  /** The syntactic indent level for VIEW `row` (enclosing fold-block depth), or null when
   *  there's no parse tree — the editor's "real" indent source for `=` / paste-reindent. */
  indentLevelForRow(row: number): number | null {
    return this.docSyntax.indentLevelForRow(this.documentRow(row));
  }

  // --- document↔screen translation -------------------------------------------
  // Captures + tree queries come back from the shared parse in DOCUMENT coordinates. They
  // only differ from this view's screen coordinates when (a) the parse runs on a separate
  // document buffer (a shared DocumentSyntax — `translate`) AND (b) this view has collapsed
  // folds. Both false → every translator is identity (the common path costs nothing).

  /** Whether captures need document→screen translation: true when the shared parse runs on a
   *  buffer other than this view's (i.e. the Document's model buffer), false for a private parse. */
  private get translate(): boolean {
    return this.docSyntax.sourceBuffer !== this.buffer;
  }

  /** Whether this view currently collapses any document range (folds shift screen lines/cols). */
  private get screenFolded(): boolean {
    return this.translate && !!this.screen && this.activeFolds.length > 0;
  }

  private documentRow(screenRow: number): number {
    return this.screenFolded ? this.screen!.documentLineForScreenLine(screenRow) : screenRow;
  }
  private screenRow(documentRow: number): number {
    return this.screenFolded ? this.screen!.screenLineForDocumentLine(documentRow) : documentRow;
  }
  private documentPos(screenRow: number, screenCol: number): [number, number] {
    if (!this.screenFolded) return [screenRow, screenCol];
    const p = this.screen!.documentPointFromScreen(new Point(screenRow, screenCol));
    return [p.row, p.column];
  }
  private documentLineRange(screenFrom: number, screenTo: number): [number, number] {
    return [this.documentRow(screenFrom), this.documentRow(screenTo)];
  }

  /** A view-buffer iter for a DOCUMENT `(row, col)` capture position. Identity (direct iter,
   *  screen text == document text) unless this view has collapsed folds, in which case it walks
   *  the Document's projection; a position inside a fold maps to its placeholder (then the
   *  zero-width range applyTag no-ops). */
  private screenIterForDocument(documentRow: number, documentCol: number): any {
    if (this.screenFolded) {
      const col = this.docSyntax.hasAstral ? this.documentCodepointCol(documentRow, documentCol) : documentCol;
      const vp = this.screen!.screenPointFromDocument(new Point(documentRow, col));
      return asIter(this.buffer.getIterAtLineOffset(vp.row, vp.column));
    }
    // screen line == document line, screen text == document text → resolve directly on the view buffer.
    const col = this.docSyntax.hasAstral ? this.toCodepointColumn(documentRow, documentCol) : documentCol;
    return asIter(this.buffer.getIterAtLineOffset(documentRow, col));
  }

  /** Rebuild `foldsByHeaderLine` from the shared parse's discovered fold ranges (MODEL
   *  coords → this view's lines), plus this view's collapsed-fold placeholders. Collapsed
   *  folds are added FIRST and own their view line: a discovered range maps to the same
   *  (folded) line, so it must not override the collapsed state (the model still contains
   *  the body, so the fold IS rediscovered — unlike the old view-buffer parse). */
  private rebuildFoldMap(): void {
    if (!this.foldingEnabled) return;
    const buffer = this.buffer;
    this.foldsByHeaderLine.clear();
    // Collapsed folds first: their placeholder occupies a view line; key by it.
    if (this.screen) {
      this.pruneDeadFolds();
      for (const handle of this.activeFolds) {
        const [ps, pe] = this.screen.foldPlaceholderRange(handle);
        const line = asIter(buffer.getIterAtOffset(ps)).getLine();
        if (!this.foldsByHeaderLine.has(line)) {
          this.foldsByHeaderLine.set(line, { startLine: line, endLine: line, folded: true, handle });
        }
        buffer.applyTag(this.foldPlaceholderTag, asIter(buffer.getIterAtOffset(ps)), asIter(buffer.getIterAtOffset(pe)));
      }
    }
    // Expanded discovered foldable regions (model coords → this view's lines).
    for (const { startRow, endRow, joinFooter } of this.docSyntax.foldRanges()) {
      const vStart = this.screenRow(startRow);
      if (this.foldsByHeaderLine.has(vStart)) continue; // a collapsed fold already owns this line
      this.foldsByHeaderLine.set(vStart, { startLine: vStart, endLine: this.screenRow(endRow), folded: false, joinFooter });
    }
  }

  private clearHighlight(): void {
    const buffer = this.buffer;
    const start = buffer.getStartIter();
    const end = buffer.getEndIter();
    this.highlight.clear(buffer, start, end);
    buffer.removeTag(this.invisibleTag, start, end);
  }

  /** UTF-16 column on MODEL `row` → codepoint column, for the folded translation path
   *  (which feeds codepoint columns into the Document projection). Reads the model line
   *  text through the fold host. Only reached on astral + folded; uncached (rare). */
  private documentCodepointCol(documentRow: number, utf16Col: number): number {
    if (utf16Col <= 0 || !this.screen) return utf16Col;
    const text = this.screen.documentLineText(documentRow);
    let cp = 0;
    for (let i = 0; i < utf16Col && i < text.length; cp++) {
      const code = text.charCodeAt(i);
      i += code >= 0xd800 && code <= 0xdbff && isLowSurrogate(text.charCodeAt(i + 1)) ? 2 : 1;
    }
    return cp;
  }

  /** UTF-16 column on this VIEW buffer's `line` → codepoint column (surrogate pairs count
   *  as one) — the identity (no-fold) paint path. */
  private toCodepointColumn(line: number, utf16Col: number): number {
    if (utf16Col <= 0) return utf16Col;
    let text = this.lineTextCache.get(line);
    if (text === undefined) {
      const start = asIter(this.buffer.getIterAtLine(line));
      const end = start.copy();
      if (!end.endsLine()) end.forwardToLineEnd();
      text = this.buffer.getText(start, end, true) as string;
      this.lineTextCache.set(line, text);
    }
    let cp = 0;
    for (let i = 0; i < utf16Col && i < text.length; cp++) {
      const code = text.charCodeAt(i);
      i += code >= 0xd800 && code <= 0xdbff && isLowSurrogate(text.charCodeAt(i + 1)) ? 2 : 1;
    }
    return cp;
  }

  // --- folding operations ----------------------------------------------------

  /** Toggle `region`. Returns the view range an expand revealed (the restored body), so a
   *  fold-open command can drop the caret on its first non-blank character; null on collapse. */
  private toggleFold(region: FoldRegion): RevealedRange | null {
    const buffer = this.buffer;
    const cursorOff = asIter(buffer.getIterAtMark(buffer.getInsert())).getOffset();
    // Track this code fold's desired open/closed state by its MODEL start row. Captured
    // before the expand splices the body back.
    const codeFold = !!this.screen;
    const modelStart = codeFold ? this.documentRow(region.startLine) : -1;
    let revealed: RevealedRange | null = null;
    if (region.folded && region.handle) {
      // Expand: restore the body text from the model and report the restored range so a
      // fold-open command can place the caret at its first non-blank char.
      const [ps, pe] = this.screen!.foldPlaceholderRange(region.handle);
      const sm = buffer.createMark(null, asIter(buffer.getIterAtOffset(ps)), true);
      const em = buffer.createMark(null, asIter(buffer.getIterAtOffset(pe)), false);
      this.screen!.unfold(region.handle);
      revealed = [this.pointAtOffset(this.markOffset(sm)), this.pointAtOffset(this.markOffset(em))];
      buffer.deleteMark(sm);
      buffer.deleteMark(em);
      const i = this.activeFolds.indexOf(region.handle);
      if (i >= 0) this.activeFolds.splice(i, 1);
      region.folded = false;
      region.handle = undefined;
      if (codeFold) {
        this.desiredClosed.delete(modelStart);
        // Re-collapse any children the user left closed, now that their text is back.
        this.reapplyDesiredChildFolds(modelStart);
      }
    } else if (!region.folded && this.screen) {
      // Collapse: physically replace the body with a placeholder in the VIEW buffer —
      // the model keeps the full text. Only move the caret if it was *inside* the
      // removed body (closing a fold shouldn't jump the cursor otherwise).
      const join = region.joinFooter !== false;
      const viewStart = this.lineEndIter(region.startLine).getOffset();
      // join: collapse through the footer's `}` (single line). keep-footer: collapse to
      // the newline ending the last body line, so `}`/`} else …` stays on its own line.
      const viewEnd = join
        ? this.footerContentStart(region.endLine).getOffset()
        : this.lineEndIter(region.endLine - 1).getOffset();
      const lines = join ? region.endLine - region.startLine + 1 : region.endLine - region.startLine - 1;
      const placeholder = `[${lines}]`; // lines folded
      const cursorInside = cursorOff > viewStart && cursorOff < viewEnd;
      const handle = this.screen.fold(viewStart, viewEnd, placeholder);
      // foldScreenRange may have subsumed folds nested in this range — drop their handles.
      this.pruneDeadFolds();
      if (handle) {
        this.activeFolds.push(handle);
        region.folded = true;
        region.handle = handle;
        if (codeFold) this.desiredClosed.add(modelStart);
        const [ps, pe] = this.screen.foldPlaceholderRange(handle);
        buffer.applyTag(this.foldPlaceholderTag, asIter(buffer.getIterAtOffset(ps)), asIter(buffer.getIterAtOffset(pe)));
        if (cursorInside) {
          // Vim leaves the caret on the fold's first line: land it on the last real char
          // before the `[N]` marker (the header's `{`), not on the atomic placeholder.
          const lineStart = this.lineStartIter(asIter(buffer.getIterAtOffset(ps)).getLine()).getOffset();
          const landing = Math.max(lineStart, ps - 1);
          buffer.placeCursor(asIter(buffer.getIterAtOffset(landing)));
        }
      }
    }
    // Folds never touch the MODEL, so the shared parse tree stays valid — no reparse is
    // needed for a fold. When the parse runs on this view's OWN buffer (a private
    // DocumentSyntax — diff panes), the fold edit DID change that buffer; ask it to reparse
    // fully next (an incremental reparse from the fold's big delete+insert drifts node
    // positions). foldAll's many toggles then still cost a single full parse, not one each.
    if (!this.translate) this.docSyntax.requestFullReparse();
    // foldAll batches many toggles: it does the (expensive) re-key + repaint + emit ONCE at
    // the end instead of per fold — so skip them here while batching.
    if (this.foldBatch) return revealed;
    // Re-key the fold map to the shifted view lines now.
    this.rebuildFoldMap();
    // Shared model parse: the tree is still valid, so re-translate the captures onto the
    // shifted view lines immediately (no reparse will fire to do it). A private parse
    // repaints when its (full) reparse lands via onReparse.
    if (this.translate) this.repaint();
    this.view.queueDraw();
    this.emitFoldsChanged();
    return revealed;
  }

  // True while foldAll collapses many regions: toggleFold then skips its per-fold re-key /
  // repaint / emit, which foldAll does once at the end (O(folds) instead of O(folds²)).
  private foldBatch = false;

  /** After a code fold at MODEL row `modelStart` expands, re-collapse the folds inside it the
   *  user left closed (their model start row is in `desiredClosed`) — Vim's nested-fold
   *  behavior: opening a parent reveals its closed children rather than expanding everything.
   *  Outermost-first, skipping a child subsumed by an already-recollapsed one (its own
   *  children stay in `desiredClosed`, re-applied when it later opens). Batched so the
   *  enclosing `toggleFold` does the one re-key/repaint. */
  private reapplyDesiredChildFolds(modelStart: number): void {
    if (this.desiredClosed.size === 0 || !this.screen) return;
    const ranges = this.docSyntax.foldRanges();
    const parent = ranges.find((r) => r.startRow === modelStart);
    if (!parent) return;
    const children = ranges
      .filter((r) => r.startRow > parent.startRow && r.endRow <= parent.endRow && this.desiredClosed.has(r.startRow))
      .sort((a, b) => a.startRow - b.startRow || b.endRow - a.endRow);
    if (children.length === 0) return;
    const collapsed: Array<{ s: number; e: number }> = [];
    const wasBatch = this.foldBatch;
    this.foldBatch = true;
    try {
      for (const r of children) {
        if (collapsed.some((c) => r.startRow >= c.s && r.endRow <= c.e)) continue; // nested → subsumed
        const child: FoldRegion = {
          startLine: this.screenRow(r.startRow),
          endLine: this.screenRow(r.endRow),
          folded: false,
          joinFooter: r.joinFooter,
        };
        if (child.endLine <= child.startLine) continue;
        this.toggleFold(child);
        collapsed.push({ s: r.startRow, e: r.endRow });
      }
    } finally {
      this.foldBatch = wasBatch;
    }
  }

  /** Subscribe to fold open/close — the editor re-renders fold-dependent decorations. */
  onFoldsChanged(handler: () => void): void {
    this.foldsChangedHandlers.push(handler);
  }
  private emitFoldsChanged(): void {
    for (const handler of this.foldsChangedHandlers) handler();
  }

  private markOffset(mark: any): number {
    return asIter(this.buffer.getIterAtMark(mark)).getOffset();
  }

  private pointAtOffset(offset: number): [number, number] {
    const iter = asIter(this.buffer.getIterAtOffset(offset));
    return [iter.getLine(), iter.getLineOffset()];
  }

  /** End-of-line iter for a buffer line (the position of its trailing newline). */
  private lineStartIter(line: number): any {
    return asIter(this.buffer.getIterAtLine(line));
  }

  private lineEndIter(line: number): any {
    const iter = asIter(this.buffer.getIterAtLine(line));
    if (!iter.endsLine()) iter.forwardToLineEnd();
    return iter;
  }

  /** Iter at the footer line's first non-whitespace glyph (its `}`), so a fold hides
   *  the leading indentation and the `}` joins the header flush. */
  private footerContentStart(line: number): any {
    const iter = asIter(this.buffer.getIterAtLine(line));
    // getChar() returns the character as a STRING, not a codepoint number — comparing
    // it to 0x20/0x09 was always false, so indentation before `}` was never skipped
    // (it only looked right when `}` sat at column 0).
    while (!iter.endsLine() && (iter.getChar() === ' ' || iter.getChar() === '\t')) iter.forwardChar();
    return iter;
  }

  /** Toggle a fold by its header line (used by the gutter renderer's click). */
  toggleHeaderLine(line: number): void {
    const region = this.foldsByHeaderLine.get(line);
    if (region) this.toggleFold(region);
  }

  /**
   * Whether `line` sits inside a *folded* region's hidden body (the lines between
   * the header and the footer). Used by the line-number gutter to skip hidden
   * lines. Cheap region check — no iter ops.
   */
  isLineHidden(_line: number): boolean {
    return false; // folds physically collapse the view — no view lines are hidden
  }

  /** Reveal `row` if it sits inside a collapsed fold (unfold every fold hiding it). */
  unfoldRow(_row: number): void {
    // Bodies are collapsed out of the view, so there are no hidden view rows to reveal.
  }

  /** Every foldable region's inclusive line span (header → close) in DOCUMENT (buffer) rows —
   *  for the vim fold motions (`zj`/`zk`/`[z`/`]z`) and the `iz`/`az` text object, which speak
   *  `buffer`. Driven from the parse (document coords), independent of the rendered fold state. */
  foldRegions(): Array<{ startRow: number; endRow: number }> {
    return this.docSyntax.foldRanges().map((r) => ({ startRow: r.startRow, endRow: r.endRow }));
  }

  /**
   * The function/method enclosing `(row, column)`, as outer (whole definition)
   * and inner (body statements) line spans — for the vim `if`/`af` text object.
   * Walks the tree-sitter tree up from the cursor to the nearest function-like
   * node; the inner span is its `body` field's named children (delimiter-agnostic,
   * so it works for both brace and indentation languages). Null when off a
   * function or with no parse tree.
   */
  functionRangeAt(row: number, column: number): NodeRowRange | null {
    // (row, column) are BUFFER (document) coords — the vim layer's space — so query + return
    // document rows directly (no screen round-trip). Identity vs. the old path with no fold active.
    return this.docSyntax.functionRangeAt(row, column);
  }

  /** The class/interface/enum enclosing buffer `(row, column)`, for the `ic`/`ac` text object. */
  classRangeAt(row: number, column: number): NodeRowRange | null {
    return this.docSyntax.classRangeAt(row, column);
  }

  /** Structural scopes (class/function/…) enclosing view `(row, column)`, outermost first,
   *  for the editor info-bar breadcrumb. Names only — no view-range round-trip needed. */
  breadcrumbAt(row: number, column: number): Crumb[] {
    const [docRow, docCol] = this.documentPos(row, column);
    return this.docSyntax.breadcrumbAt(docRow, docCol);
  }

  /** The JSX/HTML tag-name ranges (opening + closing, or one self-closing) of the
   *  element at `(row, column)`, for `tag:rename`. Null when off a tag / no tree. */
  tagNamesAt(row: number, column: number): TagName[] | null {
    const [docRow, docCol] = this.documentPos(row, column);
    const tags = this.docSyntax.tagNamesAt(docRow, docCol);
    if (!tags || !this.screenFolded) return tags; // document coords == screen coords
    return tags.map((t) => {
      const s = this.screen!.screenPointFromDocument(new Point(t.startRow, t.startColumn));
      const e = this.screen!.screenPointFromDocument(new Point(t.endRow, t.endColumn));
      return { ...t, startRow: s.row, startColumn: s.column, endRow: e.row, endColumn: e.column };
    });
  }

  /** Digit width to pad line numbers to, so the gutter doesn't jitter while scrolling.
   *  Returns a cached value (the renderer calls this per visible line per frame); the
   *  cache is refreshed by primeGutter on edits, and lazily on first read. */
  lineNumberWidth(): number {
    return this.cachedLineDigits || (this.cachedLineDigits = String(this.buffer.getLineCount()).length);
  }

  /**
   * Size the composite gutter to its widest line. GtkSourceGutterRendererText measures
   * its width from the *currently set* text, and at the gutter's measure pass no per-line
   * text is set yet — so without this the column collapses to the padding and nothing
   * shows. Set representative text (widest number + the chevron / git / diag cells) +
   * queue_resize; re-run only when the digit count changes (cheap no-op otherwise).
   */
  private primeGutter(): void {
    // Compute the fresh width (one getLineCount per edit) and keep the per-frame cache
    // current, even before the renderer exists, so the renderer's first read is right.
    const digits = String(this.buffer.getLineCount()).length;
    this.cachedLineDigits = digits;
    if (!this.gutterRenderer) return;
    if (digits === this.lineNumberPrimedDigits) return;
    this.lineNumberPrimedDigits = digits;
    // Representative widest content: number + (space+chevron) + git cell + diag cell. The
    // extra cells are one monospace char each (the bar/glyph aren't wider than a digit).
    const extra = (this.foldingEnabled ? 2 : 0) + (this.gitCell ? 1 : 0) + (this.diagCell ? 1 : 0);
    this.gutterRenderer.setText('0'.repeat((this.wantLineNumbers ? digits : 0) + extra), -1);
    this.gutterRenderer.queueResize();
  }

  /** A folded FoldRegion for an active handle (reuse the map's tracked object when it
   *  matches, so toggleFold mutates/removes the same one). */
  private regionForHandle(handle: any, pStart: number | undefined): FoldRegion {
    const p = pStart ?? this.screen!.foldPlaceholderRange(handle)[0];
    const line = asIter(this.buffer.getIterAtOffset(p)).getLine();
    const existing = this.foldsByHeaderLine.get(line);
    if (existing && existing.handle === handle) return existing;
    return { startLine: line, endLine: line, folded: true, handle };
  }

  private regionAtCursor(): FoldRegion | null {
    const buffer = this.buffer;
    const cursor = asIter(buffer.getIterAtMark(buffer.getInsert()));
    const off = cursor.getOffset();
    const line = cursor.getLine();
    // 1. A collapsed placeholder the caret is on or nearest to — iterate the active
    //    handles (not the per-line map) so several folds on one line each get their
    //    own `za`/`zo`, offset-precise.
    let nearest: any = null;
    let nearestDist = Infinity;
    if (this.screen) {
      for (const handle of this.activeFolds) {
        const [p, e] = this.screen.foldPlaceholderRange(handle);
        if (off >= p && off <= e) return this.regionForHandle(handle, p); // on/at the marker
        if (asIter(buffer.getIterAtOffset(p)).getLine() === line) {
          const d = Math.min(Math.abs(off - p), Math.abs(off - e));
          if (d < nearestDist) { nearestDist = d; nearest = handle; }
        }
      }
    }
    if (nearest) return this.regionForHandle(nearest, undefined);
    // 2. Otherwise the innermost expanded foldable region containing the caret line.
    let best: FoldRegion | null = null;
    for (const region of this.foldsByHeaderLine.values()) {
      if (region.folded) continue;
      if (line >= region.startLine && line <= region.endLine) {
        if (!best || region.startLine > best.startLine) best = region; // innermost
      }
    }
    return best;
  }

  /** The innermost EXPANDED foldable region that strictly contains view `line` (its body,
   *  not its header) — i.e. the parent fold of whatever sits on `line`. Used by `zc` on an
   *  already-closed fold to close the next level out. */
  private enclosingExpandedRegion(line: number): FoldRegion | null {
    let best: FoldRegion | null = null;
    for (const region of this.foldsByHeaderLine.values()) {
      if (region.folded) continue;
      if (region.startLine < line && line <= region.endLine) {
        if (!best || region.startLine > best.startLine) best = region; // innermost
      }
    }
    return best;
  }

  /**
   * Open any fold(s) hiding `line` so a cursor that moved into a folded body (via
   * `w`, `/`, `G`, a click, …) becomes visible again — Vim's `foldopen` behavior.
   * A line can be buried under nested folds, so unfold outermost-first until it's
   * exposed. Returns whether anything was opened. No-op when `line` is visible
   * (so resting on a fold *header* never auto-opens it).
   */
  revealLine(_line: number): boolean {
    return false; // no hidden view rows; a folded body simply isn't in the view
  }

  /**
   * The DOCUMENT row span `[startRow, endRow]` of the collapsed fold containing document `row`
   * (header through footer), or null when `row` isn't inside a closed fold. The vim layer now
   * speaks `buffer` (== document for a single file), so its fold motions treat this span as one
   * line — j/k skip a closed fold instead of stepping through its hidden rows.
   */
  documentFoldRangeAtRow(row: number): { startRow: number; endRow: number } | null {
    if (!this.screen) return null;
    for (const handle of this.activeFolds) {
      const [s, e] = this.screen.foldDocumentRowSpan(handle);
      if (row >= s && row <= e) return { startRow: s, endRow: e };
    }
    return null;
  }

  /** Reveal the collapsed fold whose hidden body contains document `row` (vim `foldopen`, when a
   *  motion lands the cursor inside a fold). No-op on a visible row or a fold header. */
  unfoldDocumentRow(row: number): void {
    if (!this.screen) return;
    for (const handle of this.activeFolds) {
      const [s, e] = this.screen.foldDocumentRowSpan(handle);
      if (row > s && row <= e) {
        this.toggleFold(this.regionForHandle(handle, undefined));
        return;
      }
    }
  }

  setFoldAtCursor(folded: boolean): RevealedRange | null {
    const region = this.regionAtCursor();
    if (region && region.folded !== folded) return this.toggleFold(region);
    // `zc` on an already-closed fold closes the enclosing (parent) fold — Vim closes folds
    // outward level by level on repeated `zc`.
    if (folded && region?.folded) {
      const parent = this.enclosingExpandedRegion(region.startLine);
      if (parent) return this.toggleFold(parent);
    }
    return null;
  }

  toggleFoldAtCursor(): RevealedRange | null {
    const region = this.regionAtCursor();
    return region ? this.toggleFold(region) : null;
  }

  foldAll(): void {
    // Drive from MODEL fold ranges (stable as folds collapse, unlike view-line snapshots).
    // Outermost-first; skip a range nested in an already-folded one (it's subsumed); and
    // translate each range to its CURRENT view lines right before folding — so an earlier
    // sibling / inner fold that shifted the view is accounted for (fixing the stale-line bug
    // where the outer fold ate past its footer). Batch the re-key/repaint to once.
    const ranges = this.docSyntax
      .foldRanges()
      .slice()
      .sort((a, b) => a.startRow - b.startRow || b.endRow - a.endRow);
    // Mark EVERY foldable range closed — not just the outermost we physically collapse here —
    // so opening a parent re-collapses its (closed) children: `zm` closes all levels.
    for (const r of ranges) this.desiredClosed.add(r.startRow);
    const collapsed: Array<{ s: number; e: number }> = [];
    this.foldBatch = true;
    try {
      for (const r of ranges) {
        if (collapsed.some((c) => r.startRow >= c.s && r.endRow <= c.e)) continue; // nested → subsumed
        const region: FoldRegion = {
          startLine: this.screenRow(r.startRow),
          endLine: this.screenRow(r.endRow),
          folded: false,
          joinFooter: r.joinFooter,
        };
        if (region.endLine <= region.startLine) continue;
        this.toggleFold(region);
        collapsed.push({ s: r.startRow, e: r.endRow });
      }
    } finally {
      this.foldBatch = false;
    }
    this.rebuildFoldMap();
    if (this.translate) this.repaint();
    this.view.queueDraw();
    this.emitFoldsChanged();
  }

  unfoldAll(): void {
    this.desiredClosed.clear(); // `zr` opens every level and forgets all closed state.
    if (this.activeFolds.length === 0) return;
    for (const handle of [...this.activeFolds]) this.screen?.unfold(handle);
    this.activeFolds.length = 0;
    for (const region of this.foldsByHeaderLine.values()) { region.folded = false; region.handle = undefined; }
    // Re-key to the now-expanded view lines, and REPAINT: restoring a fold's body splices it
    // back between the header `{` and footer `}` (both punctuation-tagged), so GtkTextBuffer's
    // insert makes the body inherit that tag — a single unfold's repaint clears it, but
    // unfoldAll must do the same or the restored text shows in the delimiter color.
    this.rebuildFoldMap();
    if (this.translate) this.repaint();
    this.view.queueDraw();
    this.emitFoldsChanged();
  }

  /** Vim `zO`/`zC` — recursively open/close the fold *subtree* at the cursor: the fold the
   *  cursor is on/in plus every fold nested inside it (unlike `zo`/`zc`, which act one level
   *  at a time). Scoped `foldAll`/`unfoldAll`: drive from the MODEL fold ranges contained by
   *  the cursor's fold, translating each to its CURRENT view lines just before toggling. */
  setFoldAtCursorRecursive(folded: boolean): RevealedRange | null {
    const region = this.regionAtCursor();
    if (!region || !this.screen) return null;
    const ranges = this.docSyntax.foldRanges();
    const parent = ranges.find((r) => r.startRow === this.documentRow(region.startLine));
    // Cursor isn't on a known foldable header (placeholder line off-by-one, etc.) — fall back
    // to the single-level behavior so the key still does something sensible.
    if (!parent) return this.setFoldAtCursor(folded);
    const subtree = ranges
      .filter((r) => r.startRow >= parent.startRow && r.endRow <= parent.endRow)
      .sort((a, b) => a.startRow - b.startRow || b.endRow - a.endRow);

    let revealed: RevealedRange | null = null;
    this.foldBatch = true;
    try {
      if (folded) {
        // zC: record every level closed (so reopening the parent re-collapses children), then
        // physically collapse outermost-first — a nested range is subsumed by its parent.
        for (const r of subtree) this.desiredClosed.add(r.startRow);
        const collapsed: Array<{ s: number; e: number }> = [];
        for (const r of subtree) {
          if (collapsed.some((c) => r.startRow >= c.s && r.endRow <= c.e)) continue; // nested → subsumed
          const reg: FoldRegion = {
            startLine: this.screenRow(r.startRow),
            endLine: this.screenRow(r.endRow),
            folded: false,
            joinFooter: r.joinFooter,
          };
          if (reg.endLine <= reg.startLine) continue; // already collapsed (endRow maps onto header)
          this.toggleFold(reg);
          collapsed.push({ s: r.startRow, e: r.endRow });
        }
      } else {
        // zO: forget the subtree's closed state FIRST (so expanding the parent doesn't
        // re-collapse children), then unfold every still-alive fold inside it. Expanding a
        // parent restores its subsumed children's text, so a snapshot pass is enough.
        for (const r of subtree) this.desiredClosed.delete(r.startRow);
        for (const handle of [...this.activeFolds]) {
          if (!this.screen.isFoldAlive(handle)) continue;
          const [s] = this.screen.foldDocumentRowSpan(handle);
          if (s < parent.startRow || s > parent.endRow) continue;
          const r = this.toggleFold(this.regionForHandle(handle, undefined));
          if (r && !revealed) revealed = r;
        }
      }
    } finally {
      this.foldBatch = false;
    }
    this.rebuildFoldMap();
    if (this.translate) this.repaint();
    this.view.queueDraw();
    this.emitFoldsChanged();
    return revealed;
  }

  /** Drop fold handles an enclosing fold has subsumed (their marks are gone), so the
   *  read paths never query a dead handle. */
  private pruneDeadFolds(): void {
    if (!this.screen) return;
    for (let i = this.activeFolds.length - 1; i >= 0; i--) {
      if (!this.screen.isFoldAlive(this.activeFolds[i])) this.activeFolds.splice(i, 1);
    }
  }

  /** Reveal every collapsed fold whose model content satisfies `test` (search reveals
   *  folds that contain a match, leaving the rest folded — not a blanket unfold-all). */
  revealFoldsMatching(test: (text: string) => boolean): void {
    if (!this.screen) return;
    for (const handle of [...this.activeFolds]) {
      if (!this.screen.isFoldAlive(handle)) continue;
      if (test(this.screen.foldDocumentText(handle))) {
        this.unfoldAtViewOffset(this.screen.foldPlaceholderRange(handle)[0]);
      }
    }
  }

  /** View-offset [start,end) ranges of every collapsed-fold placeholder (atomic to
   *  the cursor + non-editable). */
  placeholderRanges(): Array<[number, number]> {
    if (!this.screen) return [];
    this.pruneDeadFolds();
    return this.activeFolds.map((h) => this.screen!.foldPlaceholderRange(h));
  }

  /** Unfold the fold whose placeholder contains view `offset` (editing/searching a
   *  fold reveals it); returns whether one was opened. */
  unfoldAtViewOffset(offset: number): boolean {
    if (!this.screen) return false;
    for (const handle of [...this.activeFolds]) {
      const [p, e] = this.screen.foldPlaceholderRange(handle);
      if (offset >= p && offset < e) { this.toggleFold(this.regionForHandle(handle, p)); return true; }
    }
    return false;
  }

  /** The model (file) line shown at view line `screenLine` — the gutter renders this. */
  modelLineFor(screenLine: number): number {
    return this.screen ? this.screen.documentLineForScreenLine(screenLine) : screenLine;
  }
}
