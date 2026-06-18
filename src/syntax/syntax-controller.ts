/*
 * SyntaxController — drives tree-sitter highlighting and code folding for one
 * GtkSource.View/Buffer pair, replacing GtkSourceView's `.lang` engine for the
 * languages we have a grammar for.
 *
 * Highlighting: parse on (debounced) change, run the grammar's highlights query,
 * apply our own TextTags by range. Tag colors come from the active GtkSource
 * style scheme so they follow the Adwaita light/dark theme.
 *
 * Folding: foldable ranges come from the same parse. A clickable chevron is
 * drawn by a custom GutterRenderer subclass, and a range collapses by applying a
 * TextTag with `invisible = true` over its body lines. Folded state is derived
 * from the live tag (iter.hasTag), so folds move with edits instead of resetting.
 *
 * Folding is driven by the public `toggleFoldAtCursor`/`setFoldAtCursor`/
 * `foldAll`/`unfoldAll` methods; the editor wires them to `fold:*` commands that
 * the vim keymap's `z`-prefix (za/zo/zc/zR/zM) dispatches.
 */
import { Gtk, GLib, Pango, type SourceBuffer, type SourceView } from '../gi.ts';
import { type Grammar, createParser, getGrammar, langIdForPath } from './grammar.ts';
import { theme } from '../theme/theme.ts';
import { findBracketPair } from './bracketMatch.ts';
import { indentLevelAt, enclosingTypeMatches, enclosingNodeRange, type NodeRowRange } from './indent.ts';
import { computeFoldRanges } from './folds.ts';
import { tagNamesAt, type TagName } from './tags.ts';
import { isFunctionNodeType, isClassNodeType, STRING_COMMENT_RE, RUN_FOLD_RE } from './nodeTypes.ts';
import { collectCaptures, extentOf, type RawCapture, type VisibleRange } from './injection.ts';
import { HighlightTags } from './highlightTags.ts';
import { FoldRenderer, LineNumberRenderer } from './gutterRenderers.ts';
/** The view↔model projection a SyntaxController folds through (the editor's Document). */
export interface FoldHost {
  foldViewRange(buffer: SourceBuffer, viewStart: number, viewEnd: number, placeholder: string): any;
  unfoldView(buffer: SourceBuffer, fold: any): void;
  foldPlaceholderRange(buffer: SourceBuffer, fold: any): [number, number];
  modelLineForViewLine(buffer: SourceBuffer, viewLine: number): number;
  /** False once an enclosing fold has subsumed this one (its marks are gone). */
  isFoldAlive(fold: any): boolean;
  /** The model text a fold currently collapses (for matching during search). */
  foldModelText(buffer: SourceBuffer, fold: any): string;
}

const HIGHLIGHT_DEBOUNCE_MS = 60;
// Repaint after scrolling settles — snappy, and cheap (no reparse, just a
// re-query over the new visible range).
const VIEWPORT_DEBOUNCE_MS = 30;
// Highlight this many lines above/below the viewport, so scrolling within the
// band shows highlighted text immediately while a repaint catches up.
const VIEWPORT_MARGIN_LINES = 80;

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
  // Provided folds only (whole-collapse): collapse the *whole* [startLine..endLine]
  // run (no header line kept) into `placeholder`. `origStart`/`origEnd` are the run's
  // lines in the unfolded buffer, used to recompute the current lines as other runs
  // collapse (the read-only buffer has no reparse to rediscover them).
  whole?: boolean;
  placeholder?: string;
  origStart?: number;
  origEnd?: number;
}

/** A fold range supplied by an external provider (a diff view's unchanged runs)
 *  rather than discovered from the parse — in unfolded-buffer line coords. */
export interface ProvidedFold {
  startLine: number;
  endLine: number;
  /** Collapse the whole [start..end] run with no visible header line (vs keeping the
   *  header and hiding the body). */
  whole?: boolean;
  /** The collapsed marker text (defaults to a line count). */
  placeholder?: string;
  /** Start collapsed. */
  folded?: boolean;
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

  private grammar: Grammar | null = null;
  private parser: any = null;
  private tree: any = null; // last parse tree, kept for incremental reparsing
  // One parser per injected guest grammar (Markdown code fences / inline spans),
  // created lazily and reused across refreshes; their trees are transient.
  private readonly injectionParsers = new Map<Grammar, any>();

  // The syntax-highlight tag vocabulary (color + decoration tags) built from the
  // theme; owns capture→tag resolution and the paint sweep (see highlightTags.ts).
  private readonly highlight: HighlightTags;
  private readonly invisibleTag: any;
  // Styles each collapsed-fold placeholder ([...]) — muted + non-editable.
  private readonly foldPlaceholderTag: any;
  // Like foldPlaceholderTag but for whole-collapse (provided) folds: adds a full-width
  // band. The band color comes from the diff-fold theme key (the only provider today).
  private readonly bandedPlaceholderTag: any;
  // The projection folds collapse through (editor's Document; null for diff panes).
  private foldHost: FoldHost | null = null;
  // Active fold handles, one per collapsed region (bodies live only in the model).
  private readonly activeFolds: any[] = [];
  // Notified after any fold open/close so the editor re-places fold-dependent
  // decorations (diagnostics squiggles, inlay hints) at the shifted view lines.
  private readonly foldsChangedHandlers: Array<() => void> = [];
  // Highlights the bracket under the cursor and its match; cursor-driven, managed
  // separately from the parse-driven highlight tags (not in `allTags`).
  private readonly bracketMatchTag: any;

  // The fold-aware line-number gutter renderer (null when line numbers are off),
  // and the digit width its size is currently primed for. GtkSourceGutterRendererText
  // sizes from its set text, so we prime it to the widest number and re-prime when
  // the line count crosses a digit boundary (see primeLineNumbers).
  private lineNumberRenderer: any = null;
  private lineNumberPrimedDigits = 0;
  // Cached line-number digit width. The gutter renderer reads this once per visible
  // line per paint, so it must not call getLineCount() (an FFI) each time; it's
  // refreshed from primeLineNumbers (on every buffer edit) and lazily on first read.
  private cachedLineDigits = 0;
  // The gutter is installed lazily after the first paint (see the constructor note);
  // these track the deferred state.
  private wantLineNumbers = false;
  private gutterInstalled = false;
  private gutterReserved = false;

  // Whether the current buffer contains any astral (surrogate-pair) char, so the
  // highlight path only converts tree-sitter's UTF-16 columns to codepoints when
  // it must; the per-line text cache (cleared each refresh) backs that conversion.
  private hasAstral = false;
  private readonly lineTextCache = new Map<number, string>();
  readonly foldsByHeaderLine = new Map<number, FoldRegion>();

  private debounceId = 0;
  private viewportDebounceId = 0;
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
  // Cached buffer text from the last parse, reused by viewport repaints on scroll
  // (no edit → no reparse, just a re-query + re-paint over the new visible range).
  private cachedText = '';
  // Set by a fold toggle so the next refresh reparses from scratch (not incrementally
  // from the fold's large structural edit, which leaves drifted node positions).
  private fullReparseNext = false;
  // The line span our highlight tags currently cover, cleared before the next
  // paint; null = "unknown, clear the whole buffer".
  private paintedExtent: { fromLine: number; toLine: number } | null = null;
  // Whether folding is active at all (chevron gutter + the fold projection). When
  // off (e.g. peek views) there is no folding of any method.
  private readonly foldingEnabled: boolean;
  // Externally-provided fold ranges (`setProvidedFolds`), e.g. a diff view's
  // unchanged runs — in unfolded-buffer line coords, so their current lines can be
  // recomputed analytically as other runs collapse (the buffer is read-only, with no
  // reparse to rediscover folds). Null = discover foldable regions from the parse
  // instead; non-null (even empty) = use the provided set and suppress discovery.
  private providedFolds: FoldRegion[] | null = null;
  // Lockstep sibling: a callback to toggle the same provided-fold index elsewhere
  // (the side-by-side diff keeps its two panes row-aligned this way).
  private foldMirror: ((index: number) => void) | null = null;
  private mirroring = false;

  constructor(
    view: SourceView,
    buffer: SourceBuffer,
    options: { lineNumbers?: boolean; folding?: boolean; folds?: FoldHost } = {},
  ) {
    this.view = view;
    this.buffer = buffer;
    this.foldingEnabled = options.folding !== false;

    const table = (buffer as any).getTagTable();
    const mk = (props: Record<string, unknown>) => { const t = new Gtk.TextTag(props); table.add(t); return t; };

    // Build the syntax-highlight tags FIRST: tag priority follows creation order,
    // so the bracket-match / fold-placeholder tags created below layer on top.
    this.highlight = new HighlightTags(table);

    // The tag that performs the actual hiding when a range is folded.
    this.invisibleTag = new Gtk.TextTag({ name: FOLD_HIDDEN_TAG_NAME, invisible: true });
    (buffer as any).getTagTable().add(this.invisibleTag);
    this.foldPlaceholderTag = new Gtk.TextTag({ name: 'ts:fold-placeholder', editable: false, foreground: theme.ui.textMuted } as any);
    (buffer as any).getTagTable().add(this.foldPlaceholderTag);
    // Whole-collapse placeholder: a full-width band (paragraph background) behind the
    // collapsed-run marker, so it reads as its own row (the diff's `⋯ N lines` line).
    this.bandedPlaceholderTag = new Gtk.TextTag({
      name: 'ts:banded-fold-placeholder',
      editable: false,
      foreground: theme.ui.textMuted,
      paragraphBackground: theme.ui.diffFoldBg,
    } as any);
    (buffer as any).getTagTable().add(this.bandedPlaceholderTag);

    // Bracket-match highlight (subtle box-like background + bold).
    this.bracketMatchTag = mk({
      name: 'bracket-match',
      background: theme.ui.selectedBg ?? theme.ui.popoverBg,
      weight: Pango.Weight.BOLD,
    });

    // Gutter renderers are NOT inserted here: a gutter forces GtkTextView to validate
    // every line on first allocate (so it can position the gutter cells), and during
    // that pass each renderer's queryData is called once per buffer line — for a large
    // file that's thousands of node-gtk vfunc crossings before the first frame (a 1-3s
    // freeze on open). Instead we install the gutter after the first paint, once the
    // view's line metrics are validated, so it only ever queries the visible lines.
    this.wantLineNumbers = !!options.lineNumbers;
    if (this.foldingEnabled) this.foldHost = options.folds ?? null;

    // Feed edits into the current tree for incremental reparsing. insert-text /
    // delete-range run before the buffer is modified (the default handlers are
    // RUN_LAST), so the iters still reflect the pre-edit state. 'changed' (which
    // schedules the reparse) fires after, so the edit is recorded first.
    this.connect(buffer, 'insert-text', (location: any, text: string) => this.onInsert(location, text));
    this.connect(buffer, 'delete-range', (start: any, end: any) => this.onDelete(start, end));
    this.connect(buffer, 'changed', () => {
      this.primeLineNumbers(); // keep the gutter wide enough as the line count grows
      this.scheduleRefresh();
    });

    // Re-highlight the newly-revealed lines as the view scrolls. The vadjustment
    // is set by the enclosing ScrolledWindow after construction, so connect when
    // it appears (notify::vadjustment) as well as now if it's already there.
    const connectScroll = () => {
      const vadj = (view as any).getVadjustment?.();
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
    if (this.debounceId) { GLib.sourceRemove(this.debounceId); this.debounceId = 0; }
    if (this.viewportDebounceId) { GLib.sourceRemove(this.viewportDebounceId); this.viewportDebounceId = 0; }
    for (const { target, event, cb } of this.connections) {
      try { target.off(event, cb); } catch { /* target already finalized — nothing to detach */ }
    }
    this.connections.length = 0;
    this.resetTree(); // delete the parse tree + injection parsers (frees their wasm allocations)
  }

  /**
   * Whether `(row, column)` is inside a string, comment, or regex — used to skip
   * brackets that aren't real code. Walks up the tree from the position; false
   * when there's no parse tree.
   */
  isInStringOrComment(row: number, column: number): boolean {
    if (!this.grammar || !this.tree) return false;
    return enclosingTypeMatches(this.tree.rootNode, row, column, STRING_COMMENT_RE);
  }

  /** Highlight the bracket under (or just before) the cursor and its match. */
  private updateBracketMatch(): void {
    if (this.disposed) return;
    const buffer = this.buffer as any;
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

  // --- incremental-parse edit tracking ---------------------------------------

  private onInsert(location: any, text: string): void {
    if (!this.tree) return;
    const startIndex = location.getOffset();
    const startRow = location.getLine();
    const startCol = location.getLineOffset();
    const newlines = text.split('\n').length - 1;
    const lastNl = text.lastIndexOf('\n');
    this.tree.edit({
      startIndex,
      oldEndIndex: startIndex,
      newEndIndex: startIndex + text.length,
      startPosition: { row: startRow, column: startCol },
      oldEndPosition: { row: startRow, column: startCol },
      newEndPosition: {
        row: startRow + newlines,
        column: newlines === 0 ? startCol + text.length : text.length - lastNl - 1,
      },
    });
  }

  private onDelete(start: any, end: any): void {
    if (!this.tree) return;
    const startIndex = start.getOffset();
    this.tree.edit({
      startIndex,
      oldEndIndex: end.getOffset(),
      newEndIndex: startIndex,
      startPosition: { row: start.getLine(), column: start.getLineOffset() },
      oldEndPosition: { row: end.getLine(), column: end.getLineOffset() },
      newEndPosition: { row: start.getLine(), column: start.getLineOffset() },
    });
  }

  private resetTree(): void {
    if (this.tree) {
      this.tree.delete();
      this.tree = null;
    }
    // New document: forget the painted span so the next paint clears the whole
    // buffer (the previous file's tags), not a stale line range.
    this.paintedExtent = null;
    // Drop guest parsers from the previous document's injections.
    for (const parser of this.injectionParsers.values()) parser.delete();
    this.injectionParsers.clear();
  }

  /**
   * Select the grammar for a file. Returns true if tree-sitter handles it (the
   * caller should then leave the `.lang` engine off); false if unsupported (the
   * caller should fall back to GtkSourceView's own highlighting).
   *
   * Synchronous: grammars are preloaded before the main loop (see
   * grammar.preloadGrammars), so this only does a cache lookup.
   */
  setLanguageForPath(path: string): boolean {
    const langId = langIdForPath(path);
    const grammar = langId ? getGrammar(langId) : null;

    // New document content: drop any prior tree so the next parse is full, not
    // an incremental reparse against the previous file.
    this.resetTree();
    // Reserve the gutter width now (content is loaded, line count known) so the deferred
    // gutter install doesn't shift the text. Both the grammar and no-grammar paths need it.
    this.reserveGutterSpace();

    if (!grammar) {
      this.grammar = null;
      this.parser = null;
      this.clearHighlight();
      this.foldsByHeaderLine.clear();
      // No parse/paint to ride on, but the gutter (line numbers) must still appear — defer
      // it the same way so it only queries the visible lines.
      this.scheduleGutterInstall();
      this.view.queueDraw();
      return false;
    }

    this.grammar = grammar;
    this.parser = createParser(grammar);
    this.buffer.setHighlightSyntax(false); // we own highlighting now
    this.restyle();
    this.refresh();
    this.scheduleGutterInstall();
    return true;
  }

  /** Diagnostic: capture-name counts from the current parse tree (for tests). */
  captureCounts(): Record<string, number> {
    // null-proto map: capture names like "constructor" would otherwise collide
    // with Object.prototype keys.
    const counts: Record<string, number> = Object.create(null);
    if (!this.grammar || !this.tree) return counts;
    for (const cap of this.grammar.query.captures(this.tree.rootNode)) {
      counts[cap.name] = (counts[cap.name] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Re-apply token colors from the theme palette. Colors are fixed (not
   * scheme-derived), so this is independent of the Adwaita light/dark chrome;
   * kept as a method because the window calls it when the system scheme changes.
   */
  restyle(): void {
    this.highlight.restyle();
  }

  // --- highlighting + fold discovery -----------------------------------------

  private scheduleRefresh(): void {
    if (this.disposed || !this.grammar) return;
    if (this.debounceId) GLib.sourceRemove(this.debounceId);
    this.debounceId = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, HIGHLIGHT_DEBOUNCE_MS, () => {
      this.debounceId = 0;
      this.refresh();
      return false;
    });
  }

  /** On edit: reparse incrementally, then re-highlight the viewport + recompute folds. */
  private refresh(): void {
    if (this.disposed || !this.grammar || !this.parser) return;
    const buffer = this.buffer as any;
    // include_hidden_chars = true so folded (invisible) text still reaches the
    // parser. Pass the prior (edited) tree for an incremental reparse, then
    // delete the old one to free its wasm allocation. Cache the text so a scroll
    // repaint can re-query without re-reading the whole buffer.
    this.cachedText = buffer.getText(buffer.getStartIter(), buffer.getEndIter(), true);
    // web-tree-sitter reports UTF-16 columns; getIterAtLineOffset wants codepoints.
    // They only diverge on astral (surrogate-pair) chars — detect once so the
    // common, BMP-only file pays nothing in iterAt.
    this.hasAstral = /[\ud800-\udbff]/.test(this.cachedText);
    // After a fold, reparse from scratch — the incremental tree (edited by the fold's
    // big delete+insert) yields drifted node positions; otherwise reparse incrementally.
    const prior = this.fullReparseNext ? undefined : (this.tree ?? undefined);
    this.fullReparseNext = false;
    const tree = this.parser.parse(this.cachedText, prior);
    if (!tree) return;
    if (this.tree && this.tree !== tree) this.tree.delete();
    this.tree = tree;

    // Paint synchronously so the text is highlighted on its first frame (no color
    // flicker). When the view isn't laid out yet (initial load, height 0), visibleRange
    // returns null and this covers the whole buffer; once laid out it's viewport-bounded.
    this.repaint();

    // Recompute fold regions; derive folded state from the live invisible tag so
    // it tracks edits (tags move with the text).
    this.foldsByHeaderLine.clear();
    // Provided folds suppress tree-sitter fold discovery — re-key the supplied ranges
    // to their current lines instead of rediscovering from the parse.
    if (this.providedFolds) this.rebuildProvidedFoldMap();
    else if (this.foldingEnabled) this.walkFolds(tree.rootNode);
    (this.view as any).queueDraw();
  }

  /**
   * Re-highlight the visible range (base grammar + injected layers) from the
   * current tree — NO reparse. Used after an edit and on scroll. Captures are
   * limited to the viewport (± a margin) when the view is realized, so large
   * files only pay for what's on screen; off-screen, the whole buffer is done
   * (small files / headless). Clears the previously-painted line span first so a
   * scroll can't leave stale tags behind.
   */
  private repaint(): void {
    if (!this.grammar || !this.tree) return;
    this.lineTextCache.clear();
    const range = this.visibleRange();
    const captures: RawCapture[] = [];
    collectCaptures(this.grammar, this.tree.rootNode, this.cachedText, captures, 0, range, (g) => this.injectionParser(g));
    this.clearPainted();
    this.highlight.paint(this.buffer, captures, (row, col) => this.iterAt(row, col));
    this.paintedExtent = extentOf(captures);
  }

  /** Install the gutter once the view is sized (its line metrics validated). Deferred off
   *  the first paint so the gutter only queries the visible lines, not every line in the
   *  buffer (each query is a node-gtk vfunc — thousands of them is the open-file freeze).
   *  Headless / already-sized: install now. */
  private scheduleGutterInstall(): void {
    if (this.gutterInstalled) return;
    const view = this.view as any;
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
    // Gutter width = the line-number text width + the fold chevron width + a small fixed
    // GtkSourceGutter padding (measured empirically: xpad barely affects the allocated
    // width). Reserving exactly this keeps the text column fixed when the gutter installs.
    const m4 = measure('0'.repeat(this.lineNumberWidth()));
    const mF = this.foldingEnabled ? measure('▾') : 0;
    this.reservedPx = m4 + mF + GUTTER_PADDING_PX;
    view.setLeftMargin(this.reservedPx);
  }
  private reservedPx = 0;

  /**
   * Insert the line-number + fold gutter renderers. Deferred until after the first paint
   * (when the view's line metrics are validated) so the gutter only queries the visible
   * lines, not every line in the buffer — see the constructor note. Idempotent.
   */
  private installGutter(): void {
    if (this.gutterInstalled || this.disposed) return;
    this.gutterInstalled = true;
    // Drop the reserved left margin: the gutter now occupies that space, so swapping them
    // in the same layout pass keeps the text column fixed (no shift).
    if (this.gutterReserved) (this.view as any).setLeftMargin(0);
    const gutter = (this.view as any).getGutter(Gtk.TextWindowType.LEFT);
    // Custom, fold-aware line numbers (GtkSourceView's built-in gutter renders a number
    // for every folded line at the collapsed y — a mashup). Leftmost, then the chevron.
    if (this.wantLineNumbers) {
      const lineNumbers = new LineNumberRenderer();
      (lineNumbers as any).controller = this;
      lineNumbers.setXpad(3);
      gutter.insert(lineNumbers, 0);
      this.lineNumberRenderer = lineNumbers;
      this.primeLineNumbers();
    }
    if (this.foldingEnabled) {
      const renderer = new FoldRenderer();
      (renderer as any).controller = this;
      renderer.setXpad(4);
      gutter.insert(renderer, this.wantLineNumbers ? 1 : 0);
    }
  }

  /** Schedule a viewport-only repaint after scrolling settles (no reparse). */
  private scheduleViewportRepaint(): void {
    if (this.disposed || !this.grammar) return;
    if (this.viewportDebounceId) GLib.sourceRemove(this.viewportDebounceId);
    this.viewportDebounceId = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, VIEWPORT_DEBOUNCE_MS, () => {
      this.viewportDebounceId = 0;
      // Skip the tree-sitter re-query + re-tag when the visible rows are already inside
      // the painted band (a small scroll within the ±margin). Repainting an already-
      // highlighted region is the main scroll-stop hitch; the highlight tags are still
      // applied over [fromLine, toLine], so the visible text stays highlighted.
      if (!this.visibleWithinPainted()) {
        this.repaint();
        (this.view as any).queueDraw();
      }
      return false;
    });
  }

  /** Whether the actual visible rows (no margin) sit within the currently-painted line
   *  span — then a scroll repaint is redundant. False when unknown (always repaint). */
  private visibleWithinPainted(): boolean {
    if (!this.paintedExtent) return false;
    const view = this.view as any;
    if (!view.getRealized()) return false;
    const rect = view.getVisibleRect();
    if (!rect || !rect.height) return false;
    const lineAtY = (y: number): number => {
      const r = view.getLineAtY(y);
      return asIter(Array.isArray(r) ? r[0] : r).getLine();
    };
    const top = lineAtY(rect.y);
    const bottom = lineAtY(rect.y + rect.height);
    return top >= this.paintedExtent.fromLine && bottom <= this.paintedExtent.toLine;
  }

  /** The visible buffer range (± a margin), or null (whole buffer) when the view
   *  isn't realized/laid out yet (initial load, headless). */
  private visibleRange(): VisibleRange | null {
    const view = this.view as any;
    if (!view.getRealized()) return null;
    const rect = view.getVisibleRect();
    if (!rect || !rect.height) return null;
    const buffer = this.buffer as any;
    const lineAtY = (y: number): number => {
      const r = view.getLineAtY(y);
      return asIter(Array.isArray(r) ? r[0] : r).getLine();
    };
    const last = buffer.getLineCount() - 1;
    const top = Math.max(0, lineAtY(rect.y) - VIEWPORT_MARGIN_LINES);
    const bottom = Math.min(last, lineAtY(rect.y + rect.height) + VIEWPORT_MARGIN_LINES);
    const startIter = asIter(buffer.getIterAtLine(top));
    const endIter = bottom >= last ? buffer.getEndIter() : asIter(buffer.getIterAtLine(bottom + 1));
    return {
      startPoint: { row: top, column: 0 },
      endPoint: { row: endIter.getLine(), column: endIter.getLineOffset() },
      startIndex: startIter.getOffset(),
      endIndex: endIter.getOffset(),
    };
  }

  /** Remove all highlight tags over the previously-painted line span (whole
   *  buffer when unknown). Line-based so it's immune to UTF-16/codepoint skew. */
  private clearPainted(): void {
    const buffer = this.buffer as any;
    let from: any, to: any;
    if (this.paintedExtent === null) {
      from = buffer.getStartIter();
      to = buffer.getEndIter();
    } else {
      const last = buffer.getLineCount() - 1;
      from = asIter(buffer.getIterAtLine(Math.max(0, Math.min(this.paintedExtent.fromLine, last))));
      to = this.paintedExtent.toLine >= last
        ? buffer.getEndIter()
        : asIter(buffer.getIterAtLine(this.paintedExtent.toLine + 1));
    }
    this.highlight.clear(buffer, from, to);
  }

  /** The syntactic indent level for `row` (enclosing fold-block depth), or null
   *  when there's no parse tree — the editor's "real" indent source for `=` /
   *  paste-reindent (falls back to copy-previous otherwise). */
  indentLevelForRow(row: number): number | null {
    if (!this.grammar || !this.tree) return null;
    return indentLevelAt(this.tree.rootNode, row, this.grammar.foldTypes);
  }

  /** A parser for an injected guest grammar, created on first use and reused. */
  private injectionParser(grammar: Grammar): any {
    let parser = this.injectionParsers.get(grammar);
    if (!parser) {
      parser = createParser(grammar);
      this.injectionParsers.set(grammar, parser);
    }
    return parser;
  }

  private walkFolds(root: any): void {
    const grammar = this.grammar!;
    const buffer = this.buffer as any;
    // Expanded foldable regions from the parse (their bodies are present in the view).
    for (const { startRow, endRow, joinFooter } of computeFoldRanges(root, grammar.foldsQuery, grammar.foldTypes, RUN_FOLD_RE)) {
      this.foldsByHeaderLine.set(startRow, { startLine: startRow, endLine: endRow, folded: false, joinFooter });
    }
    // Collapsed folds: their bodies are physically gone, so the parse can't see them —
    // add each by its placeholder line and (re)apply the placeholder style.
    if (this.foldHost) {
      this.pruneDeadFolds();
      for (const handle of this.activeFolds) {
        const [ps, pe] = this.foldHost.foldPlaceholderRange(this.buffer, handle);
        const line = asIter(buffer.getIterAtOffset(ps)).getLine();
        // Don't clobber a foldable region that shares this line (e.g. `} function f2() {`
        // joined onto a collapsed line) — that region must stay reachable by `zc`. This
        // fold is still in `activeFolds`, so its marker stays navigable + unfoldable.
        if (!this.foldsByHeaderLine.has(line)) {
          this.foldsByHeaderLine.set(line, { startLine: line, endLine: line, folded: true, handle });
        }
        buffer.applyTag(this.foldPlaceholderTag, asIter(buffer.getIterAtOffset(ps)), asIter(buffer.getIterAtOffset(pe)));
      }
    }
  }

  private clearHighlight(): void {
    const buffer = this.buffer as any;
    const start = buffer.getStartIter();
    const end = buffer.getEndIter();
    this.highlight.clear(buffer, start, end);
    buffer.removeTag(this.invisibleTag, start, end);
  }

  private iterAt(line: number, col: number): any {
    // tree-sitter columns are UTF-16 code units; getIterAtLineOffset wants
    // codepoints. They match unless the line holds astral chars (see hasAstral).
    const column = this.hasAstral ? this.toCodepointColumn(line, col) : col;
    return asIter((this.buffer as any).getIterAtLineOffset(line, column));
  }

  /** UTF-16 column on `line` → codepoint column (surrogate pairs count as one). */
  private toCodepointColumn(line: number, utf16Col: number): number {
    if (utf16Col <= 0) return utf16Col;
    let text = this.lineTextCache.get(line);
    if (text === undefined) {
      const start = asIter((this.buffer as any).getIterAtLine(line));
      const end = start.copy();
      if (!end.endsLine()) end.forwardToLineEnd();
      text = (this.buffer as any).getText(start, end, true) as string;
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

  /** Toggle `region`. Returns the view range revealed by an expand when the caret was
   *  directly on the marker (so the caller can highlight it), else null. */
  private toggleFold(region: FoldRegion): RevealedRange | null {
    const buffer = this.buffer as any;
    const cursorOff = asIter(buffer.getIterAtMark(buffer.getInsert())).getOffset();
    let revealed: RevealedRange | null = null;
    if (region.folded && region.handle) {
      // Expand: restore the body text from the model. If the caret was on the marker,
      // report the restored range so the caller highlights it.
      const [ps, pe] = this.foldHost!.foldPlaceholderRange(this.buffer, region.handle);
      const onMarker = cursorOff >= ps && cursorOff <= pe;
      const sm = buffer.createMark(null, asIter(buffer.getIterAtOffset(ps)), true);
      const em = buffer.createMark(null, asIter(buffer.getIterAtOffset(pe)), false);
      this.foldHost!.unfoldView(this.buffer, region.handle);
      if (onMarker) revealed = [this.pointAtOffset(this.markOffset(sm)), this.pointAtOffset(this.markOffset(em))];
      buffer.deleteMark(sm);
      buffer.deleteMark(em);
      const i = this.activeFolds.indexOf(region.handle);
      if (i >= 0) this.activeFolds.splice(i, 1);
      region.folded = false;
      region.handle = undefined;
    } else if (!region.folded && this.foldHost) {
      // Collapse: physically replace the body with a placeholder in the VIEW buffer —
      // the model keeps the full text. Only move the caret if it was *inside* the
      // removed body (closing a fold shouldn't jump the cursor otherwise).
      let viewStart: number;
      let viewEnd: number;
      let placeholder: string;
      if (region.whole) {
        // Whole-collapse: fold the whole [startLine..endLine] run into the placeholder
        // (no header line kept) — the newline after the run stays, so it reads as one
        // line (the diff's `⋯ N unchanged lines` marker).
        viewStart = this.lineStartIter(region.startLine).getOffset();
        viewEnd = this.lineEndIter(region.endLine).getOffset();
        placeholder = region.placeholder ?? `[${region.endLine - region.startLine + 1}]`;
      } else {
        const join = region.joinFooter !== false;
        viewStart = this.lineEndIter(region.startLine).getOffset();
        // join: collapse through the footer's `}` (single line). keep-footer: collapse to
        // the newline ending the last body line, so `}`/`} else …` stays on its own line.
        viewEnd = join
          ? this.footerContentStart(region.endLine).getOffset()
          : this.lineEndIter(region.endLine - 1).getOffset();
        const lines = join ? region.endLine - region.startLine + 1 : region.endLine - region.startLine - 1;
        placeholder = `[${lines}]`; // lines folded
      }
      const cursorInside = cursorOff > viewStart && cursorOff < viewEnd;
      const handle = this.foldHost.foldViewRange(this.buffer, viewStart, viewEnd, placeholder);
      // foldViewRange may have subsumed folds nested in this range — drop their handles.
      this.pruneDeadFolds();
      if (handle) {
        this.activeFolds.push(handle);
        region.folded = true;
        region.handle = handle;
        const [ps, pe] = this.foldHost.foldPlaceholderRange(this.buffer, handle);
        const tag = region.whole ? this.bandedPlaceholderTag : this.foldPlaceholderTag;
        buffer.applyTag(tag, asIter(buffer.getIterAtOffset(ps)), asIter(buffer.getIterAtOffset(pe)));
        if (cursorInside) buffer.placeCursor(asIter(buffer.getIterAtOffset(ps)));
      }
    }
    // The collapse/expand edited the view buffer by a large structural delete+insert.
    // An INCREMENTAL reparse from that (which the buffer 'changed' handler just
    // scheduled, seeded by the fold's tree.edit) is unreliable — node positions below
    // the fold drift, so highlight captures land on the wrong rows and a later scroll
    // repaint paints unhighlighted regions until a real edit heals them. Mark the next
    // reparse FULL; the already-scheduled (debounced) refresh then does one clean parse
    // — so foldAll's many toggles still cost a single full parse, not one each.
    this.fullReparseNext = true;
    // With provided folds there's no parse-driven rebuild, so re-key the fold map to
    // the shifted lines now (and mirror the toggle to the lockstep sibling pane).
    if (this.providedFolds) {
      this.rebuildProvidedFoldMap();
      if (this.foldMirror && !this.mirroring) {
        const idx = this.providedFolds.indexOf(region);
        if (idx >= 0) this.foldMirror(idx);
      }
    }
    (this.view as any).queueDraw();
    this.emitFoldsChanged();
    return revealed;
  }

  // --- provided folds (external fold ranges) ---------------------------------

  /**
   * Fold an externally-supplied set of ranges (in unfolded-buffer line coords)
   * instead of discovering foldable regions from the parse, and suppress that
   * discovery. A range can collapse *whole* (no header line kept) into a custom
   * placeholder; ranges flagged `folded` start collapsed. Used by the diff views
   * to fold unchanged runs. Call once, after the text is set; requires folding
   * enabled + a fold host (the Document).
   */
  setProvidedFolds(folds: readonly ProvidedFold[]): void {
    if (!this.foldingEnabled || !this.foldHost) return;
    this.providedFolds = folds.map((f) => ({
      startLine: f.startLine,
      endLine: f.endLine,
      origStart: f.startLine,
      origEnd: f.endLine,
      folded: false,
      whole: f.whole ?? false,
      placeholder: f.placeholder,
    }));
    // Collapse the start-folded ranges bottom-up, so an earlier run's lines stay
    // valid while a later one folds.
    const startFolded = this.providedFolds.filter((_, i) => folds[i].folded);
    for (const region of startFolded.sort((a, b) => b.origStart! - a.origStart!)) {
      this.toggleFold(region);
    }
    this.rebuildProvidedFoldMap();
  }

  /** Lockstep sibling: called with a provided-fold index whenever one toggles here,
   *  so the owner can toggle the same index elsewhere (the side-by-side panes). */
  setFoldMirror(cb: (index: number) => void): void {
    this.foldMirror = cb;
  }

  /** Toggle provided fold `index` without re-firing the mirror (the sibling calls this). */
  toggleProvidedFold(index: number): void {
    const region = this.providedFolds?.[index];
    if (!region) return;
    this.mirroring = true;
    try {
      this.toggleFold(region);
    } finally {
      this.mirroring = false;
    }
  }

  // Re-key foldsByHeaderLine to each provided run's *current* start line. The buffer
  // is read-only, so the only line shifts come from other folds: a folded run of L
  // body lines occupies 1 line, removing L-1 — i.e. (origEnd-origStart) — lines from
  // everything below it. Recompute analytically (no marks needed).
  private rebuildProvidedFoldMap(): void {
    if (!this.providedFolds) return;
    this.foldsByHeaderLine.clear();
    const buffer = this.buffer as any;
    for (const region of this.providedFolds) {
      let removedAbove = 0;
      for (const other of this.providedFolds) {
        if (other !== region && other.folded && other.origStart! < region.origStart!) {
          removedAbove += other.origEnd! - other.origStart!;
        }
      }
      region.startLine = region.origStart! - removedAbove;
      region.endLine = region.folded ? region.startLine : region.origEnd! - removedAbove;
      this.foldsByHeaderLine.set(region.startLine, region);
      // Keep the placeholder styled (a repaint may have cleared its run).
      if (region.folded && region.handle) {
        const [ps, pe] = this.foldHost!.foldPlaceholderRange(this.buffer, region.handle);
        buffer.applyTag(this.bandedPlaceholderTag, asIter(buffer.getIterAtOffset(ps)), asIter(buffer.getIterAtOffset(pe)));
      }
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
    return asIter((this.buffer as any).getIterAtMark(mark)).getOffset();
  }

  private pointAtOffset(offset: number): [number, number] {
    const iter = asIter((this.buffer as any).getIterAtOffset(offset));
    return [iter.getLine(), iter.getLineOffset()];
  }

  /** End-of-line iter for a buffer line (the position of its trailing newline). */
  private lineStartIter(line: number): any {
    return asIter((this.buffer as any).getIterAtLine(line));
  }

  private lineEndIter(line: number): any {
    const iter = asIter((this.buffer as any).getIterAtLine(line));
    if (!iter.endsLine()) iter.forwardToLineEnd();
    return iter;
  }

  /** Iter at the footer line's first non-whitespace glyph (its `}`), so a fold hides
   *  the leading indentation and the `}` joins the header flush. */
  private footerContentStart(line: number): any {
    const iter = asIter((this.buffer as any).getIterAtLine(line));
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

  /** Every foldable region's inclusive line span (header → close), for the vim
   *  fold motions and the `iz`/`az` text object. */
  foldRegions(): Array<{ startRow: number; endRow: number }> {
    return [...this.foldsByHeaderLine.values()].map((r) => ({ startRow: r.startLine, endRow: r.endLine }));
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
    return this.nodeRangeAt(row, column, isFunctionNodeType);
  }

  /** The class/interface/enum enclosing `(row, column)`, for the `ic`/`ac` text object. */
  classRangeAt(row: number, column: number): NodeRowRange | null {
    return this.nodeRangeAt(row, column, isClassNodeType);
  }

  /** The JSX/HTML tag-name ranges (opening + closing, or one self-closing) of the
   *  element at `(row, column)`, for `tag:rename`. Null when off a tag / no tree. */
  tagNamesAt(row: number, column: number): TagName[] | null {
    return this.tree ? tagNamesAt(this.tree.rootNode, row, column) : null;
  }

  /** Outer (whole node) + inner (its `body` field's statements) line spans for the
   *  nearest enclosing node whose type satisfies `matches`. */
  private nodeRangeAt(row: number, column: number, matches: (type: string) => boolean): NodeRowRange | null {
    return this.tree ? enclosingNodeRange(this.tree.rootNode, row, column, matches) : null;
  }

  /** Digit width to pad line numbers to, so the gutter doesn't jitter while scrolling.
   *  Returns a cached value (the renderer calls this per visible line per frame); the
   *  cache is refreshed by primeLineNumbers on edits, and lazily on first read. */
  lineNumberWidth(): number {
    return this.cachedLineDigits || (this.cachedLineDigits = String((this.buffer as any).getLineCount()).length);
  }

  /**
   * Size the line-number gutter to the widest number. GtkSourceGutterRendererText
   * measures its width from the *currently set* text, and at the gutter's measure
   * pass no per-line text is set yet — so without this the column collapses to the
   * padding and no numbers show. Setting representative text + queue_resize fixes
   * the allocation; re-run only when the digit count changes (cheap no-op otherwise).
   */
  private primeLineNumbers(): void {
    // Compute the fresh width (one getLineCount per edit) and keep the per-frame cache
    // current, even before the renderer exists, so the renderer's first read is right.
    const digits = String((this.buffer as any).getLineCount()).length;
    this.cachedLineDigits = digits;
    if (!this.lineNumberRenderer) return;
    if (digits === this.lineNumberPrimedDigits) return;
    this.lineNumberPrimedDigits = digits;
    this.lineNumberRenderer.setText('0'.repeat(digits), -1);
    this.lineNumberRenderer.queueResize();
  }

  /** A folded FoldRegion for an active handle (reuse the map's tracked object when it
   *  matches, so toggleFold mutates/removes the same one). */
  private regionForHandle(handle: any, pStart: number | undefined): FoldRegion {
    const p = pStart ?? this.foldHost!.foldPlaceholderRange(this.buffer, handle)[0];
    const line = asIter((this.buffer as any).getIterAtOffset(p)).getLine();
    const existing = this.foldsByHeaderLine.get(line);
    if (existing && existing.handle === handle) return existing;
    return { startLine: line, endLine: line, folded: true, handle };
  }

  private regionAtCursor(): FoldRegion | null {
    const buffer = this.buffer as any;
    const cursor = asIter(buffer.getIterAtMark(buffer.getInsert()));
    const off = cursor.getOffset();
    const line = cursor.getLine();
    // 1. A collapsed placeholder the caret is on or nearest to — iterate the active
    //    handles (not the per-line map) so several folds on one line each get their
    //    own `za`/`zo`, offset-precise.
    let nearest: any = null;
    let nearestDist = Infinity;
    if (this.foldHost) {
      for (const handle of this.activeFolds) {
        const [p, e] = this.foldHost.foldPlaceholderRange(this.buffer, handle);
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

  setFoldAtCursor(folded: boolean): RevealedRange | null {
    const region = this.regionAtCursor();
    return region && region.folded !== folded ? this.toggleFold(region) : null;
  }

  toggleFoldAtCursor(): RevealedRange | null {
    const region = this.regionAtCursor();
    return region ? this.toggleFold(region) : null;
  }

  foldAll(): void {
    // Bottom-up so collapsing one region doesn't shift the line numbers of those above.
    const regions = [...this.foldsByHeaderLine.values()].filter((r) => !r.folded).sort((a, b) => b.startLine - a.startLine);
    for (const region of regions) this.toggleFold(region);
  }

  unfoldAll(): void {
    for (const handle of [...this.activeFolds]) this.foldHost?.unfoldView(this.buffer, handle);
    this.activeFolds.length = 0;
    for (const region of this.foldsByHeaderLine.values()) { region.folded = false; region.handle = undefined; }
    (this.view as any).queueDraw();
    this.emitFoldsChanged();
  }

  /** Drop fold handles an enclosing fold has subsumed (their marks are gone), so the
   *  read paths never query a dead handle. */
  private pruneDeadFolds(): void {
    if (!this.foldHost) return;
    for (let i = this.activeFolds.length - 1; i >= 0; i--) {
      if (!this.foldHost.isFoldAlive(this.activeFolds[i])) this.activeFolds.splice(i, 1);
    }
  }

  /** Reveal every collapsed fold whose model content satisfies `test` (search reveals
   *  folds that contain a match, leaving the rest folded — not a blanket unfold-all). */
  revealFoldsMatching(test: (text: string) => boolean): void {
    if (!this.foldHost) return;
    for (const handle of [...this.activeFolds]) {
      if (!this.foldHost.isFoldAlive(handle)) continue;
      if (test(this.foldHost.foldModelText(this.buffer, handle))) {
        this.unfoldAtViewOffset(this.foldHost.foldPlaceholderRange(this.buffer, handle)[0]);
      }
    }
  }

  /** View-offset [start,end) ranges of every collapsed-fold placeholder (atomic to
   *  the cursor + non-editable). */
  placeholderRanges(): Array<[number, number]> {
    if (!this.foldHost) return [];
    this.pruneDeadFolds();
    return this.activeFolds.map((h) => this.foldHost!.foldPlaceholderRange(this.buffer, h));
  }

  /** Unfold the fold whose placeholder contains view `offset` (editing/searching a
   *  fold reveals it); returns whether one was opened. */
  unfoldAtViewOffset(offset: number): boolean {
    if (!this.foldHost) return false;
    for (const handle of [...this.activeFolds]) {
      const [p, e] = this.foldHost.foldPlaceholderRange(this.buffer, handle);
      if (offset >= p && offset < e) { this.toggleFold(this.regionForHandle(handle, p)); return true; }
    }
    return false;
  }

  /** The model (file) line shown at view line `viewLine` — the gutter renders this. */
  modelLineFor(viewLine: number): number {
    return this.foldHost ? this.foldHost.modelLineForViewLine(this.buffer, viewLine) : viewLine;
  }
}
