/*
 * DocumentSyntax — the per-`Document` tree-sitter layer (Phase 0 of the multibuffer
 * split; see tasks/code-editing/multibuffer.md).
 *
 * It owns the parse: the tree-sitter `Tree`, the injection parsers, incremental
 * reparse on edits, fold-region *discovery*, and the tree queries (enclosing
 * function/class node, tag names, indent level, in-string/comment) — all in pure
 * **model** coordinates. One instance is shared by every view of a document, so a
 * file open in N views (split / live peek) parses ONCE, not N times.
 *
 * It does NOT paint: highlight tags, the gutter, and per-view fold *state* live in
 * the per-view `SyntaxController` (the painter), which pulls model-coordinate
 * captures from here and translates them into its own view's coordinates.
 *
 * The buffer it parses is whatever it's handed: in the app that's the Document's
 * headless **model** buffer; the bare-buffer tests / diff panes hand it a view
 * buffer instead, where model == view and the painter's translation is identity.
 */
import { type Grammar, createParser, getGrammar, langIdForPath } from './grammar.ts';
import type { SourceBuffer } from '../gi.ts';
import { collectCaptures, type RawCapture, type VisibleRange } from './injection.ts';
import { computeFoldRanges, type FoldRange } from './folds.ts';
import { indentLevelAt, enclosingTypeMatches, enclosingNodeRange, type NodeRowRange } from './indent.ts';
import { tagNamesAt, type TagName } from './tags.ts';
import { isFunctionNodeType, isClassNodeType, STRING_COMMENT_RE, RUN_FOLD_RE } from './nodeTypes.ts';

// Reparse this long after the last edit. One debounce per document (was per view).
const HIGHLIGHT_DEBOUNCE_MS = 60;

// node-gtk returns `[inRange, iter]` for get_iter_at_* but a bare iter for
// get_start/end_iter — normalize to an iter.
function asIter(r: any): any {
  return Array.isArray(r) ? r[r.length - 1] : r;
}

export class DocumentSyntax {
  private readonly source: SourceBuffer;

  private grammar: Grammar | null = null;
  private parser: any = null;
  private tree: any = null; // last parse tree, kept for incremental reparsing
  // One parser per injected guest grammar (Markdown code fences / inline spans),
  // created lazily and reused; their trees are transient (parsed + freed per sweep).
  private readonly injectionParsers = new Map<Grammar, any>();

  // Cached source text from the last parse, reused by the painters' viewport
  // repaints (no edit → no reparse, just re-query over the new visible range).
  private cachedText = '';
  // Whether the source holds any astral (surrogate-pair) char, so the painters only
  // convert tree-sitter's UTF-16 columns to codepoints when they must.
  private _hasAstral = false;

  private debounceId: NodeJS.Timeout | null = null;
  // Whether the source changed since the last parse — so setLanguageForPath reparses a
  // reloaded file synchronously (old grammar, but new content), yet still skips the parse
  // for a clean second view attaching to an already-parsed document.
  private dirty = false;
  // Set by a painter after a fold edit when this parses its own view buffer (private
  // instance): the next reparse must be full, since an incremental reparse from the fold's
  // big delete+insert drifts node positions. No-op for a model parse (folds never touch it).
  private fullReparseNext = false;
  private disposed = false;
  // Fired after every reparse so each painter repaints its viewport + rebuilds its
  // fold map. The set returns a disposer (painters must unsubscribe in dispose()).
  private readonly reparseHandlers = new Set<() => void>();
  // Signal connections we own on the source buffer, so dispose() can detach them.
  private readonly connections: Array<{ target: any; event: string; cb: (...args: any[]) => any }> = [];

  constructor(source: SourceBuffer) {
    this.source = source;
    // Feed edits into the current tree for incremental reparsing. insert-text /
    // delete-range run before the buffer is modified (default handlers are RUN_LAST),
    // so the iters still reflect the pre-edit state; 'changed' fires after, so the
    // edit is recorded before the reparse is scheduled.
    this.connect(source, 'insert-text', (location: any, text: string) => this.onInsert(location, text));
    this.connect(source, 'delete-range', (start: any, end: any) => this.onDelete(start, end));
    this.connect(source, 'changed', () => { this.dirty = true; this.scheduleReparse(); });
  }

  /** The buffer this parses — the painter compares it to its view buffer to decide
   *  whether captures need model→view translation (false when source === view). */
  get sourceBuffer(): SourceBuffer { return this.source; }

  /** Whether there is a live parse to read captures / queries from. */
  get hasTree(): boolean { return !!this.grammar && !!this.tree; }

  /** Whether the source holds astral chars (drives the painters' column conversion). */
  get hasAstral(): boolean { return this._hasAstral; }

  private connect(target: any, event: string, cb: (...args: any[]) => any): void {
    target.on(event, cb);
    this.connections.push({ target, event, cb });
  }

  /** Subscribe to reparses; returns a disposer. Each painter repaints its viewport
   *  and rebuilds its fold map when this fires. */
  onDidReparse(handler: () => void): () => void {
    this.reparseHandlers.add(handler);
    return () => this.reparseHandlers.delete(handler);
  }

  private emitReparse(): void {
    for (const handler of [...this.reparseHandlers]) handler();
  }

  /**
   * Select the grammar for a file and parse the source. Returns true if tree-sitter
   * handles it (false → caller falls back to the `.lang` engine). Idempotent for a
   * second view of the same document: when the grammar is unchanged and a tree
   * already exists, it keeps that tree (no redundant parse) — the keystone of the
   * shared-parse design.
   *
   * Synchronous: grammars are preloaded before the main loop, so this only does a
   * cache lookup + one parse.
   */
  setLanguageForPath(path: string): boolean {
    const langId = langIdForPath(path);
    const grammar = langId ? getGrammar(langId) : null;
    if (!grammar) {
      this.disableHighlighting();
      return false;
    }
    // Already parsed by a sibling view AND unchanged since → reuse the tree. A reload keeps
    // the grammar but replaces the content (dirty), so it falls through to a fresh parse.
    if (grammar === this.grammar && this.tree && !this.dirty) return true;
    this.resetTree();
    this.grammar = grammar;
    this.parser = createParser(grammar);
    // Silent: the painter that selected the language repaints its own view explicitly;
    // sibling views (already painted) must not be force-repainted by a language set.
    this.reparse({ full: true, silent: true });
    return true;
  }

  /** Drop tree-sitter parsing (unsupported language, or a pathological long-line file the
   *  editor degrades). Leaves the grammar null so edits cost nothing. */
  disableHighlighting(): void {
    this.resetTree();
    this.grammar = null;
    this.parser = null;
  }

  private resetTree(): void {
    if (this.debounceId) { clearTimeout(this.debounceId); this.debounceId = null; }
    if (this.tree) { this.tree.delete(); this.tree = null; }
    for (const parser of this.injectionParsers.values()) parser.delete();
    this.injectionParsers.clear();
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

  /** Force the next reparse to be from-scratch (a painter calls this after a fold edit to
   *  a private over-the-view-buffer parse). No-op when this parses the model. */
  requestFullReparse(): void {
    this.fullReparseNext = true;
  }

  private scheduleReparse(): void {
    if (this.disposed || !this.grammar) return;
    if (this.debounceId) clearTimeout(this.debounceId);
    this.debounceId = setTimeout(() => {
      this.debounceId = null;
      const full = this.fullReparseNext;
      this.fullReparseNext = false;
      this.reparse({ full });
    }, HIGHLIGHT_DEBOUNCE_MS);
  }

  /** Reparse the source (incrementally from the edited tree, unless `full`) and notify
   *  the painters. Folds never touch the model, so the model tree is always valid — no
   *  reparse-from-scratch-after-fold dance is needed (that was a view-buffer-parse wart). */
  private reparse(opts: { full?: boolean; silent?: boolean } = {}): void {
    if (this.disposed || !this.grammar || !this.parser) return;
    const buffer = this.source as any;
    this.cachedText = buffer.getText(buffer.getStartIter(), buffer.getEndIter(), true);
    // web-tree-sitter reports UTF-16 columns; iterAtLineOffset wants codepoints. They
    // only diverge on astral chars — detect once so the common BMP file pays nothing.
    this._hasAstral = /[\ud800-\udbff]/.test(this.cachedText);
    const prior = opts.full ? undefined : (this.tree ?? undefined);
    const tree = this.parser.parse(this.cachedText, prior);
    if (!tree) return;
    if (this.tree && this.tree !== tree) this.tree.delete();
    this.tree = tree;
    this.dirty = false; // the tree now reflects the current source text
    if (!opts.silent) this.emitReparse();
  }

  // --- capture + fold queries (model coordinates) ----------------------------

  /**
   * Gather highlight captures over model lines `[fromLine, toLine]` (inclusive), or
   * the whole buffer when either bound is null. Captures are in MODEL coordinates;
   * the painter translates them into its view. Includes injected guest layers.
   */
  captures(fromLine: number | null, toLine: number | null): RawCapture[] {
    if (!this.grammar || !this.tree) return [];
    const range = fromLine === null || toLine === null ? null : this.lineRange(fromLine, toLine);
    const out: RawCapture[] = [];
    collectCaptures(this.grammar, this.tree.rootNode, this.cachedText, out, 0, range, (g) => this.injectionParser(g));
    return out;
  }

  /** The foldable regions discovered from the parse, in MODEL line coords. Empty when
   *  there's no parse (the painter overlays its own collapsed-fold placeholders). */
  foldRanges(): FoldRange[] {
    if (!this.grammar || !this.tree) return [];
    return computeFoldRanges(this.tree.rootNode, this.grammar.foldsQuery, this.grammar.foldTypes, RUN_FOLD_RE);
  }

  /** A `VisibleRange` spanning model lines `[from, to]` (clamped), for `collectCaptures`. */
  private lineRange(from: number, to: number): VisibleRange {
    const buffer = this.source as any;
    const last = buffer.getLineCount() - 1;
    const f = Math.max(0, Math.min(from, last));
    const t = Math.max(f, Math.min(to, last));
    const startIter = asIter(buffer.getIterAtLine(f));
    const endIter = t >= last ? buffer.getEndIter() : asIter(buffer.getIterAtLine(t + 1));
    return {
      startPoint: { row: f, column: 0 },
      endPoint: { row: endIter.getLine(), column: endIter.getLineOffset() },
      startIndex: startIter.getOffset(),
      endIndex: endIter.getOffset(),
    };
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

  // --- tree queries (model coordinates) --------------------------------------

  /** Whether model `(row, column)` is inside a string, comment, or regex. */
  isInStringOrComment(row: number, column: number): boolean {
    if (!this.grammar || !this.tree) return false;
    return enclosingTypeMatches(this.tree.rootNode, row, column, STRING_COMMENT_RE);
  }

  /** Syntactic indent level for model `row` (enclosing fold-block depth), or null. */
  indentLevelForRow(row: number): number | null {
    if (!this.grammar || !this.tree) return null;
    return indentLevelAt(this.tree.rootNode, row, this.grammar.foldTypes);
  }

  /** Function/method enclosing model `(row, column)` (outer + inner spans), or null. */
  functionRangeAt(row: number, column: number): NodeRowRange | null {
    return this.nodeRangeAt(row, column, isFunctionNodeType);
  }

  /** Class/interface/enum enclosing model `(row, column)`, or null. */
  classRangeAt(row: number, column: number): NodeRowRange | null {
    return this.nodeRangeAt(row, column, isClassNodeType);
  }

  /** JSX/HTML tag-name ranges of the element at model `(row, column)`, or null. */
  tagNamesAt(row: number, column: number): TagName[] | null {
    return this.tree ? tagNamesAt(this.tree.rootNode, row, column) : null;
  }

  private nodeRangeAt(row: number, column: number, matches: (type: string) => boolean): NodeRowRange | null {
    return this.tree ? enclosingNodeRange(this.tree.rootNode, row, column, matches) : null;
  }

  /** Diagnostic: capture-name counts from the current tree (for tests). */
  captureCounts(): Record<string, number> {
    // null-proto map: a capture named "constructor" would collide with Object.prototype.
    const counts: Record<string, number> = Object.create(null);
    if (!this.grammar || !this.tree) return counts;
    for (const cap of this.grammar.query.captures(this.tree.rootNode)) {
      counts[cap.name] = (counts[cap.name] ?? 0) + 1;
    }
    return counts;
  }

  /** Tear down: stop the debounce, detach the source signals, free the tree + injection
   *  parsers (their wasm allocations). Idempotent. The owning Document calls this when its
   *  last view goes; a painter that created a private instance disposes it directly. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.debounceId) { clearTimeout(this.debounceId); this.debounceId = null; }
    for (const { target, event, cb } of this.connections) {
      try { target.off(event, cb); } catch { /* target already finalized */ }
    }
    this.connections.length = 0;
    this.reparseHandlers.clear();
    this.resetTree();
  }
}
