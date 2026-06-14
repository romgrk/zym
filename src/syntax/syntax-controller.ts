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
 * `z`-prefixed fold commands (za/zo/zc/zR/zM) are handled here and fed in from a
 * key controller the window installs ahead of VimIMContext; see handleFoldKey.
 */
import { Gdk, Gtk, GLib, GtkSource, registerClass, type SourceBuffer, type SourceView } from '../gi.ts';
import { type Grammar, createParser, getGrammar, langIdForPath } from './grammar.ts';

const HIGHLIGHT_DEBOUNCE_MS = 60;

// Capture name → candidate GtkSource style ids (first that resolves wins), plus
// Capture name → foreground color, using the VS Code "Dark+" palette directly
// rather than the GtkSource style scheme, so highlighting looks like VS Code
// regardless of the Adwaita light/dark chrome.
//
// KEY ORDER MATTERS: tags are created in this order and GtkTextTag priority
// follows creation order (later = higher). Overlapping captures resolve by
// priority, so more-specific categories come last: escape > string, and
// function/type > property (so method calls and constructors win over the bare
// property/identifier capture).
const COLORS: Record<string, string> = {
  comment: '#6A9955',
  string: '#CE9178',
  number: '#B5CEA8',
  boolean: '#569CD6',
  constant: '#569CD6',
  keyword: '#569CD6',          // declaration/storage keywords (blue)
  'keyword.control': '#C586C0', // control-flow + import/export (purple)
  property: '#9CDCFE',
  type: '#4EC9B0',
  function: '#DCDCAA',
  escape: '#D7BA7D',
};

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

export class SyntaxController {
  private readonly buffer: SourceBuffer;
  private readonly view: SourceView;

  private grammar: Grammar | null = null;
  private parser: any = null;
  private tree: any = null; // last parse tree, kept for incremental reparsing

  private readonly tags = new Map<string, any>();
  private readonly invisibleTag: any;
  readonly foldsByHeaderLine = new Map<number, FoldRegion>();

  private debounceId = 0;
  private pendingZ = false;

  constructor(view: SourceView, buffer: SourceBuffer) {
    this.view = view;
    this.buffer = buffer;

    // One highlight tag per capture, colored from the VS Code palette. Created
    // in COLORS order so GtkTextTag priority resolves overlaps (see COLORS).
    for (const [name, color] of Object.entries(COLORS)) {
      const tag = new Gtk.TextTag({ name: `ts:${name}`, foreground: color });
      (buffer as any).getTagTable().add(tag);
      this.tags.set(name, tag);
    }

    // The tag that performs the actual hiding when a range is folded.
    this.invisibleTag = new Gtk.TextTag({ name: 'ts:fold-hidden', invisible: true });
    (buffer as any).getTagTable().add(this.invisibleTag);

    // The fold-chevron gutter renderer. Safe to instantiate: SyntaxController is
    // built inside the application's activate handler (via EditorWindow), so the
    // app is already running (vfunc subclasses crash if instantiated earlier).
    const renderer = new FoldRenderer();
    (renderer as any).controller = this;
    renderer.setXpad(4);
    (view as any).getGutter(Gtk.TextWindowType.LEFT).insert(renderer, 0);

    // Feed edits into the current tree for incremental reparsing. insert-text /
    // delete-range run before the buffer is modified (the default handlers are
    // RUN_LAST), so the iters still reflect the pre-edit state. 'changed' (which
    // schedules the reparse) fires after, so the edit is recorded first.
    (buffer as any).on('insert-text', (location: any, text: string) => this.onInsert(location, text));
    (buffer as any).on('delete-range', (start: any, end: any) => this.onDelete(start, end));
    (buffer as any).on('changed', () => this.scheduleRefresh());
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
    const counts: Record<string, number> = {};
    if (!this.grammar || !this.tree) return counts;
    for (const cap of this.grammar.query.captures(this.tree.rootNode)) {
      counts[cap.name] = (counts[cap.name] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Re-apply the VS Code token colors. Colors are fixed (not scheme-derived),
   * so this is independent of the Adwaita light/dark chrome; kept as a method
   * because the window calls it when the system scheme changes.
   */
  restyle(): void {
    for (const [name, color] of Object.entries(COLORS)) {
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
    const tree = this.parser.parse(text, this.tree ?? undefined);
    if (!tree) return;
    if (this.tree && this.tree !== tree) this.tree.delete();
    this.tree = tree;
    const root = tree.rootNode;

    // Highlighting: clear our tags, re-apply from the query. (Other tags — the
    // invisible fold tag — are untouched, so folds persist.)
    for (const tag of this.tags.values()) buffer.removeTag(tag, start, end);
    for (const cap of this.grammar.query.captures(root)) {
      const tag = this.tags.get(cap.name);
      if (!tag) continue;
      const n = cap.node;
      buffer.applyTag(
        tag,
        this.iterAt(n.startPosition.row, n.startPosition.column),
        this.iterAt(n.endPosition.row, n.endPosition.column),
      );
    }

    // Recompute fold regions; derive folded state from the live invisible tag so
    // it tracks edits (tags move with the text).
    this.foldsByHeaderLine.clear();
    this.walkFolds(root);
    (this.view as any).queueDraw();
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

  private iterAt(line: number, col: number): any {
    // tree-sitter columns are code-unit offsets; GtkTextBuffer wants character
    // offsets. Equal for ASCII; a fuller impl maps through byte/char offsets.
    return asIter((this.buffer as any).getIterAtLineOffset(line, col));
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

  private setFoldAtCursor(folded: boolean): void {
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

  /**
   * Handle a key for the `z`-prefixed fold commands. Called from a key
   * controller installed ahead of VimIMContext; `isNormalMode` should be true
   * only outside insert mode (VimIMContext sets the view to overwrite mode in
   * normal/visual mode). Returns true if the key was consumed.
   */
  handleFoldKey(keyval: number, isNormalMode: boolean): boolean {
    if (!isNormalMode) {
      this.pendingZ = false;
      return false;
    }
    if (this.pendingZ) {
      this.pendingZ = false;
      switch (keyval) {
        case Gdk.KEY_a: this.toggleFoldAtCursor(); return true;
        case Gdk.KEY_o: this.setFoldAtCursor(false); return true;
        case Gdk.KEY_c: this.setFoldAtCursor(true); return true;
        case Gdk.KEY_R: this.unfoldAll(); return true;
        case Gdk.KEY_M: this.foldAll(); return true;
        default: return false; // not a fold command; the leading `z` was consumed
      }
    }
    if (keyval === Gdk.KEY_z) {
      this.pendingZ = true;
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fold-chevron gutter renderer. Reads its owning SyntaxController off the
// instance (`this.controller`, set right after construction) — verified that
// node-gtk preserves instance props as `this` inside vfunc callbacks.
// ---------------------------------------------------------------------------

class FoldRenderer extends GtkSource.GutterRendererText {
  // Set the glyph for this line: ▸ folded, ▾ foldable-open, else blank.
  queryData(_lines: any, line: number) {
    const region = (this as any).controller?.foldsByHeaderLine.get(line);
    this.setMarkup(region ? (region.folded ? '▸' : '▾') : ' ', -1);
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
