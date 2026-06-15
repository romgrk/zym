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
import { Gtk, GLib, GtkSource, registerClass, type SourceBuffer, type SourceView } from '../gi.ts';
import { type Grammar, createParser, getGrammar, langIdForPath } from './grammar.ts';
import { theme } from '../theme/theme.ts';

const HIGHLIGHT_DEBOUNCE_MS = 60;

// Line-number gutter color (muted), matching how syntax colors are themed.
const LINE_NUMBER_COLOR = theme.ui.lineNumber ?? theme.ui.textMuted ?? theme.ui.fg ?? '#888888';


interface FoldRegion {
  startLine: number; // line the block opens on (stays visible)
  endLine: number;   // line the block closes on (stays visible)
  folded: boolean;   // derived from the invisible tag on each refresh
}

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

  private readonly tags = new Map<string, any>();
  // Memoized capture-name → tag (or null) lookups, including longest-prefix
  // fallback; see resolveTag. Capture names are a small fixed set, so this
  // amortizes the per-capture string work on every refresh.
  private readonly tagCache = new Map<string, any>();
  private readonly invisibleTag: any;

  // The fold-aware line-number gutter renderer (null when line numbers are off),
  // and the digit width its size is currently primed for. GtkSourceGutterRendererText
  // sizes from its set text, so we prime it to the widest number and re-prime when
  // the line count crosses a digit boundary (see primeLineNumbers).
  private lineNumberRenderer: any = null;
  private lineNumberPrimedDigits = 0;

  // Whether the current buffer contains any astral (surrogate-pair) char, so the
  // highlight path only converts tree-sitter's UTF-16 columns to codepoints when
  // it must; the per-line text cache (cleared each refresh) backs that conversion.
  private hasAstral = false;
  private readonly lineTextCache = new Map<number, string>();
  readonly foldsByHeaderLine = new Map<number, FoldRegion>();

  private debounceId = 0;

  constructor(view: SourceView, buffer: SourceBuffer, options: { lineNumbers?: boolean } = {}) {
    this.view = view;
    this.buffer = buffer;

    // One highlight tag per capture, colored from the theme palette. Created in
    // theme.syntax order so GtkTextTag priority resolves overlaps (see Theme).
    for (const [name, color] of Object.entries(theme.syntax)) {
      const tag = new Gtk.TextTag({ name: `ts:${name}`, foreground: color });
      (buffer as any).getTagTable().add(tag);
      this.tags.set(name, tag);
    }

    // The tag that performs the actual hiding when a range is folded.
    this.invisibleTag = new Gtk.TextTag({ name: FOLD_HIDDEN_TAG_NAME, invisible: true });
    (buffer as any).getTagTable().add(this.invisibleTag);

    // Gutter renderers (safe to instantiate: SyntaxController is built inside the
    // application's activate handler, so vfunc subclasses don't crash). Order:
    // line numbers (leftmost), then the fold chevron next to the text.
    const gutter = (view as any).getGutter(Gtk.TextWindowType.LEFT);
    // Custom, fold-aware line numbers. GtkSourceView's built-in line-number gutter
    // renders a number for every invisible (folded) line at the collapsed y — a
    // mashup, and slow. Ours draws nothing for hidden lines.
    if (options.lineNumbers) {
      const lineNumbers = new LineNumberRenderer();
      (lineNumbers as any).controller = this;
      lineNumbers.setXpad(3);
      gutter.insert(lineNumbers, 0);
      this.lineNumberRenderer = lineNumbers;
      this.primeLineNumbers();
    }
    const renderer = new FoldRenderer();
    (renderer as any).controller = this;
    renderer.setXpad(4);
    gutter.insert(renderer, options.lineNumbers ? 1 : 0);

    // Feed edits into the current tree for incremental reparsing. insert-text /
    // delete-range run before the buffer is modified (the default handlers are
    // RUN_LAST), so the iters still reflect the pre-edit state. 'changed' (which
    // schedules the reparse) fires after, so the edit is recorded first.
    (buffer as any).on('insert-text', (location: any, text: string) => this.onInsert(location, text));
    (buffer as any).on('delete-range', (start: any, end: any) => this.onDelete(start, end));
    (buffer as any).on('changed', () => {
      this.primeLineNumbers(); // keep the gutter wide enough as the line count grows
      this.scheduleRefresh();
    });
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

    if (!grammar) {
      this.grammar = null;
      this.parser = null;
      this.clearHighlight();
      this.foldsByHeaderLine.clear();
      (this.view as any).queueDraw();
      return false;
    }

    this.grammar = grammar;
    this.parser = createParser(grammar);
    (this.buffer as any).setHighlightSyntax(false); // we own highlighting now
    this.restyle();
    this.refresh();
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
    for (const [name, color] of Object.entries(theme.syntax)) {
      this.tags.get(name).foreground = color;
    }
  }

  // --- highlighting + fold discovery -----------------------------------------

  private scheduleRefresh(): void {
    if (!this.grammar) return;
    if (this.debounceId) GLib.sourceRemove(this.debounceId);
    this.debounceId = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, HIGHLIGHT_DEBOUNCE_MS, () => {
      this.debounceId = 0;
      this.refresh();
      return false;
    });
  }

  private refresh(): void {
    if (!this.grammar || !this.parser) return;
    const buffer = this.buffer as any;
    const start = buffer.getStartIter();
    const end = buffer.getEndIter();

    // include_hidden_chars = true so folded (invisible) text still reaches the
    // parser. Pass the prior (edited) tree for an incremental reparse, then
    // delete the old one to free its wasm allocation.
    const text = buffer.getText(start, end, true);
    // web-tree-sitter reports UTF-16 columns; getIterAtLineOffset wants codepoints.
    // They only diverge on astral (surrogate-pair) chars — detect once so the
    // common, BMP-only file pays nothing in iterAt.
    this.hasAstral = /[\ud800-\udbff]/.test(text);
    this.lineTextCache.clear();
    const tree = this.parser.parse(text, this.tree ?? undefined);
    if (!tree) return;
    if (this.tree && this.tree !== tree) this.tree.delete();
    this.tree = tree;
    const root = tree.rootNode;

    // Highlighting: clear our tags, then re-apply by resolving capture overlaps.
    // (Other tags — the invisible fold tag — are untouched, so folds persist.)
    for (const tag of this.tags.values()) buffer.removeTag(tag, start, end);
    this.applyCaptures(root);

    // Recompute fold regions; derive folded state from the live invisible tag so
    // it tracks edits (tags move with the text).
    this.foldsByHeaderLine.clear();
    this.walkFolds(root);
    (this.view as any).queueDraw();
  }

  /**
   * Apply highlight tags for one parse, resolving overlapping captures the way
   * tree-sitter highlighters do: at any character the *innermost* (narrowest)
   * capture wins, with ties broken in favor of the later query pattern. The
   * grammar queries lean on this — a broad `(arrow_function) @function` capture
   * spans the whole `() => {}`, and is meant to show through only where no
   * narrower capture (a bracket, an operator, an identifier) covers the text.
   *
   * GtkTextTag priority can't express this: a tag's priority is global, but the
   * same `@function` tag is used for both the broad arrow-function span and a
   * narrow call-name span. So instead of leaning on priority we flatten the
   * captures into non-overlapping runs here and apply each run's winning tag
   * over exactly its range. Unstyled captures (no theme color → null tag) still
   * take part: a narrower unstyled identifier suppresses a broader styled span,
   * leaving the default foreground rather than bleeding the outer color.
   */
  private applyCaptures(root: any): void {
    const buffer = this.buffer as any;

    // Each capture as a flat interval over UTF-16 offsets, carrying the (row,col)
    // of both endpoints (so we can build iters without an offset→position scan)
    // and the resolved tag (possibly null) plus its order in the capture stream.
    interface Cap {
      start: number; end: number;
      sRow: number; sCol: number; eRow: number; eCol: number;
      tag: any; idx: number;
    }
    const caps: Cap[] = [];
    const posAt = new Map<number, { row: number; col: number }>();
    const startsAt = new Map<number, Cap[]>();
    const endsAt = new Map<number, Cap[]>();
    let idx = 0;
    for (const cap of this.grammar!.query.captures(root)) {
      const n = cap.node;
      const c: Cap = {
        start: n.startIndex, end: n.endIndex,
        sRow: n.startPosition.row, sCol: n.startPosition.column,
        eRow: n.endPosition.row, eCol: n.endPosition.column,
        tag: this.resolveTag(cap.name), idx: idx++,
      };
      if (c.start === c.end) continue; // zero-width capture paints nothing
      caps.push(c);
      if (!posAt.has(c.start)) posAt.set(c.start, { row: c.sRow, col: c.sCol });
      if (!posAt.has(c.end)) posAt.set(c.end, { row: c.eRow, col: c.eCol });
      (startsAt.get(c.start) ?? startsAt.set(c.start, []).get(c.start)!).push(c);
      (endsAt.get(c.end) ?? endsAt.set(c.end, []).get(c.end)!).push(c);
    }
    if (caps.length === 0) return;

    // Sweep the boundary offsets left to right, tracking which captures are open.
    // Over each elementary interval the winner is the narrowest open capture
    // (ties: later idx). Merge consecutive intervals with the same winning tag
    // into one run to keep applyTag calls down.
    const points = [...posAt.keys()].sort((a, b) => a - b);
    const active = new Set<Cap>();
    let runTag: any = null;
    let runStart = -1;
    const flush = (endOffset: number) => {
      if (runTag && runStart >= 0) {
        const a = posAt.get(runStart)!;
        const b = posAt.get(endOffset)!;
        buffer.applyTag(runTag, this.iterAt(a.row, a.col), this.iterAt(b.row, b.col));
      }
      runTag = null;
      runStart = -1;
    };
    for (let i = 0; i < points.length - 1; i++) {
      const p = points[i];
      for (const c of endsAt.get(p) ?? []) active.delete(c);
      for (const c of startsAt.get(p) ?? []) active.add(c);
      let win: Cap | null = null;
      for (const c of active) {
        if (!win) { win = c; continue; }
        const cs = c.end - c.start;
        const ws = win.end - win.start;
        if (cs < ws || (cs === ws && c.idx > win.idx)) win = c;
      }
      const tag = win ? win.tag : null;
      if (tag !== runTag) {
        flush(p);
        runTag = tag;
        runStart = tag ? p : -1;
      }
    }
    flush(points[points.length - 1]);
  }

  private walkFolds(node: any): void {
    if (this.grammar!.foldTypes.has(node.type)) {
      const startLine = node.startPosition.row;
      const endLine = node.endPosition.row;
      if (endLine - startLine >= 2 && !this.foldsByHeaderLine.has(startLine)) {
        const folded = asIter((this.buffer as any).getIterAtLine(startLine + 1)).hasTag(this.invisibleTag);
        this.foldsByHeaderLine.set(startLine, { startLine, endLine, folded });
      }
    }
    for (const child of node.namedChildren) if (child) this.walkFolds(child);
  }

  private clearHighlight(): void {
    const buffer = this.buffer as any;
    const start = buffer.getStartIter();
    const end = buffer.getEndIter();
    for (const tag of this.tags.values()) buffer.removeTag(tag, start, end);
    buffer.removeTag(this.invisibleTag, start, end);
  }

  /**
   * Map a tree-sitter capture name to its TextTag, following the standard
   * highlight-group fallback: an unknown dotted name drops its last segment and
   * retries (e.g. `function.method` → `function`, `type.builtin` → `type`).
   * Returns null — and caches it — when no prefix has a configured color, so
   * captures like `@variable`/`@operator` simply stay the default foreground.
   */
  private resolveTag(name: string): any {
    const cached = this.tagCache.get(name);
    if (cached !== undefined) return cached;
    let key: string | undefined = name;
    while (key) {
      const tag = this.tags.get(key);
      if (tag) { this.tagCache.set(name, tag); return tag; }
      const dot = key.lastIndexOf('.');
      key = dot === -1 ? undefined : key.slice(0, dot);
    }
    this.tagCache.set(name, null);
    return null;
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

  private toggleFold(region: FoldRegion): void {
    const buffer = this.buffer as any;
    const bodyStart = asIter(buffer.getIterAtLine(region.startLine + 1));
    const bodyEnd = asIter(buffer.getIterAtLine(region.endLine));

    if (region.folded) {
      buffer.removeTag(this.invisibleTag, bodyStart, bodyEnd);
      region.folded = false;
    } else {
      buffer.applyTag(this.invisibleTag, bodyStart, bodyEnd);
      region.folded = true;
      // Keep the cursor out of the hidden range (GtkTextView's invisible caveat).
      const cursor = asIter(buffer.getIterAtMark(buffer.getInsert()));
      if (cursor.getLine() > region.startLine && cursor.getLine() < region.endLine) {
        buffer.placeCursor(asIter(buffer.getIterAtLine(region.startLine)));
      }
    }
    (this.view as any).queueDraw();
  }

  /** Toggle a fold by its header line (used by the gutter renderer's click). */
  toggleHeaderLine(line: number): void {
    const region = this.foldsByHeaderLine.get(line);
    if (region) this.toggleFold(region);
  }

  /**
   * Whether `line` sits inside a *folded* region's hidden body (used by the
   * line-number gutter to skip hidden lines). Cheap region check — no iter ops.
   */
  isLineHidden(line: number): boolean {
    for (const region of this.foldsByHeaderLine.values()) {
      if (region.folded && line > region.startLine && line < region.endLine) return true;
    }
    return false;
  }

  /** Reveal `row` if it sits inside a collapsed fold (unfold every fold hiding it). */
  unfoldRow(row: number): void {
    for (const region of this.foldsByHeaderLine.values()) {
      if (region.folded && row > region.startLine && row < region.endLine) this.toggleFold(region);
    }
  }

  /** Digit width to pad line numbers to, so the gutter doesn't jitter while scrolling. */
  lineNumberWidth(): number {
    return String((this.buffer as any).getLineCount()).length;
  }

  /**
   * Size the line-number gutter to the widest number. GtkSourceGutterRendererText
   * measures its width from the *currently set* text, and at the gutter's measure
   * pass no per-line text is set yet — so without this the column collapses to the
   * padding and no numbers show. Setting representative text + queue_resize fixes
   * the allocation; re-run only when the digit count changes (cheap no-op otherwise).
   */
  private primeLineNumbers(): void {
    if (!this.lineNumberRenderer) return;
    const digits = this.lineNumberWidth();
    if (digits === this.lineNumberPrimedDigits) return;
    this.lineNumberPrimedDigits = digits;
    this.lineNumberRenderer.setText('0'.repeat(digits), -1);
    this.lineNumberRenderer.queueResize();
  }

  private regionAtCursor(): FoldRegion | null {
    const line = asIter((this.buffer as any).getIterAtMark((this.buffer as any).getInsert())).getLine();
    let best: FoldRegion | null = null;
    for (const region of this.foldsByHeaderLine.values()) {
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
  revealLine(line: number): boolean {
    let changed = false;
    // Each pass exposes one more level; bounded by the fold count.
    for (let guard = this.foldsByHeaderLine.size; guard >= 0 && this.isLineHidden(line); guard--) {
      let outer: FoldRegion | null = null;
      for (const region of this.foldsByHeaderLine.values()) {
        if (region.folded && line > region.startLine && line < region.endLine) {
          if (!outer || region.startLine < outer.startLine) outer = region;
        }
      }
      if (!outer) break;
      this.toggleFold(outer);
      changed = true;
    }
    return changed;
  }

  setFoldAtCursor(folded: boolean): void {
    const region = this.regionAtCursor();
    if (region && region.folded !== folded) this.toggleFold(region);
  }

  toggleFoldAtCursor(): void {
    const region = this.regionAtCursor();
    if (region) this.toggleFold(region);
  }

  foldAll(): void {
    for (const region of this.foldsByHeaderLine.values()) if (!region.folded) this.toggleFold(region);
  }

  unfoldAll(): void {
    const buffer = this.buffer as any;
    buffer.removeTag(this.invisibleTag, buffer.getStartIter(), buffer.getEndIter());
    for (const region of this.foldsByHeaderLine.values()) region.folded = false;
    (this.view as any).queueDraw();
  }
}

// ---------------------------------------------------------------------------
// Fold-chevron gutter renderer. Reads its owning SyntaxController off the
// instance (`this.controller`, set right after construction) — verified that
// node-gtk preserves instance props as `this` inside vfunc callbacks.
// ---------------------------------------------------------------------------

class FoldRenderer extends GtkSource.GutterRendererText {
  // Set the glyph for this line: ▸ folded, ▾ foldable-open, else blank. A nested
  // header hidden inside an outer fold draws blank (so it doesn't pile up).
  queryData(_lines: any, line: number) {
    const controller = (this as any).controller as SyntaxController | undefined;
    const region = controller?.foldsByHeaderLine.get(line);
    const glyph = region && !controller!.isLineHidden(line) ? (region.folded ? '▸' : '▾') : ' ';
    this.setMarkup(glyph, -1);
  }

  // Only fold-header lines respond to clicks.
  queryActivatable(iter: any, _area: any) {
    return Boolean((this as any).controller?.foldsByHeaderLine.has(iter.getLine()));
  }

  // Click: toggle the fold on this line.
  // @ts-expect-error - overriding the activate vfunc; the base class also
  // exposes a no-arg activate() action method, so the signatures don't unify.
  activate(iter: any, _area: any, _button: number, _state: any, _nPresses: number) {
    (this as any).controller?.toggleHeaderLine(iter.getLine());
  }
}
registerClass(FoldRenderer);

// ---------------------------------------------------------------------------
// Fold-aware line-number gutter renderer. Draws the 1-based line number for
// visible lines and NOTHING for lines hidden inside a fold — so folded line
// numbers don't pile up at the collapsed position (the built-in gutter's bug).
// ---------------------------------------------------------------------------

class LineNumberRenderer extends GtkSource.GutterRendererText {
  queryData(_lines: any, line: number) {
    const controller = (this as any).controller as SyntaxController | undefined;
    const width = controller ? controller.lineNumberWidth() : 1;
    // Always emit fixed-width content so the gutter column keeps a stable width
    // (empty text collapses it to zero → no numbers show). Hidden (folded) lines
    // render as blanks of the same width, so they don't pile up.
    if (!controller || controller.isLineHidden(line)) {
      this.setText(' '.repeat(width), -1);
      return;
    }
    const num = String(line + 1).padStart(width, ' ');
    this.setMarkup(`<span foreground="${LINE_NUMBER_COLOR}">${num}</span>`, -1);
  }
}
registerClass(LineNumberRenderer);
