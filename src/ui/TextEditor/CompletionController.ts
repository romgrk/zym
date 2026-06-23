/*
 * CompletionController — the autocompletion framework's coordinator: it owns the
 * sources, decides when to open completion, queries the sources, ranks/merges the
 * results, and drives the `CompletionPopup` plus the accept/navigate/dismiss
 * keys. Sources (placeholder for now; buffer-words/LSP/Copilot later) plug in via
 * `addSource`.
 *
 * Triggering (insert mode only): typing a word re-queries on the buffer-change
 * event (debounced); a trigger character opens immediately; Ctrl+Space forces it.
 * The popup is keyboard-driven through a capture key controller on the view — in
 * insert mode vim passes Down/Up/Enter/Tab through, so this consumes them only
 * while the popup is open (Tab still indents otherwise). Tab fills the selected
 * candidate into the buffer as a live preview and keeps the popup open; further
 * Tab/Shift-Tab cycle the candidates (re-filling), Enter commits, Esc is left to
 * vim (it exits insert mode); the host dismisses on any leave-insert.
 */
import { Gdk, Gtk, type SourceView } from '../../gi.ts';
import { CompositeDisposable } from '../../util/eventKit.ts';
import { Point } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';
import type { EditorModel } from './EditorModel.ts';
import { fuzzyMatch } from '../fuzzyMatch.ts';
import { CompletionPopup } from './CompletionPopup.ts';
import type { CompletionContext, CompletionItem, CompletionSource, CompletionTrigger, RankedCompletion } from './CompletionSource.ts';


const DEBOUNCE_MS = 60;
const MIN_PREFIX = 1; // word chars typed before auto-opening
const MAX_ITEMS = 50; // popup scrolls past its visible height

/** Whether a source's result is a promise (async source) vs a plain array. */
function isThenable(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown })?.then === 'function';
}

/** Stamp each item with the producing source's name (a debug tag in the popup). */
function tagSource(items: CompletionItem[], name: string): CompletionItem[] {
  for (const item of items) item.source = name;
  return items;
}

export class CompletionController {
  private readonly editor: EditorModel;
  private readonly isInsertMode: () => boolean;
  private readonly popup: CompletionPopup;
  private readonly sources: CompletionSource[] = [];
  private readonly disposables = new CompositeDisposable();

  private requestSeq = 0; // drops stale async source responses
  private debounceId: NodeJS.Timeout | null = null;
  private suppressQuery = false; // ignore the buffer change from our own edits
  // Tab/arrows cycle a list whose selection runs from -1 (nothing selected, the
  // original typed text) through the candidates and loops back to -1. The selected
  // candidate is written into the buffer as a live preview (popup stays open).
  //
  // Edits are reconstructed against a fixed *base region* of the original document
  // — `baseRange` and its original text `baseText` — so each candidate's own
  // `replaceRange` (LSP textEdit) is honored: filling rebuilds the region from
  // `baseText` with that item's edit applied. `previewRange` is the base region's
  // current buffer span; `prefixStartCol` is where the heuristic typed prefix
  // begins (used for items without their own range).
  private previewRange: Range | null = null;
  private baseRange: Range | null = null;
  private baseText = '';
  private prefixStartCol = 0;
  // Items whose lazy `resolve()` has already been requested (resolve at most once).
  private readonly resolved = new WeakSet<CompletionItem>();

  constructor(
    editor: EditorModel,
    view: SourceView,
    isInsertMode: () => boolean,
    highlightCode?: (code: string, lang: string | undefined) => string | null,
  ) {
    this.editor = editor;
    this.isInsertMode = isInsertMode;
    this.popup = new CompletionPopup(editor, view, highlightCode);
    editor.onDidChangeText(() => this.onBufferChanged());
    this.installKeys();
  }

  /** Tear down the popup (unparents its popover from the view). */
  dispose(): void {
    if (this.debounceId) clearTimeout(this.debounceId);
    this.disposables.dispose(); // sever the capture-phase key controller on the editor view
    this.popup.dispose();
  }

  /** Register a candidate source (placeholder, buffer words, LSP, Copilot, …). */
  addSource(source: CompletionSource): void {
    this.sources.push(source);
  }

  /** Close the popup and cancel any pending query. */
  dismiss(): void {
    if (this.debounceId) {
      clearTimeout(this.debounceId);
      this.debounceId = null;
    }
    this.requestSeq++; // invalidate in-flight queries
    this.previewRange = null;
    this.baseRange = null;
    this.popup.hide();
  }

  /** Explicitly open completion at the cursor (Ctrl+Space). */
  trigger(): void {
    if (this.isInsertMode()) this.scheduleQuery('manual');
  }

  private onBufferChanged(): void {
    // Accepting an item edits the buffer; don't let that edit re-open the popup
    // over the word we just completed.
    if (this.suppressQuery) return;
    if (!this.isInsertMode()) {
      this.dismiss();
      return;
    }
    // A source's trigger character (e.g. `.` for LSP) opens completion even with
    // no word prefix yet (member access); otherwise it's plain word typing.
    const triggerChar = this.triggerCharBeforeCursor();
    this.scheduleQuery(triggerChar ? 'character' : 'auto', triggerChar ?? undefined);
  }

  /** Trigger characters any registered source wants completion opened on. */
  private triggerCharacters(): Set<string> {
    const set = new Set<string>();
    for (const source of this.sources) for (const ch of source.triggerCharacters ?? []) set.add(ch);
    return set;
  }

  /** The character just before the cursor, if it's a source trigger character. */
  private triggerCharBeforeCursor(): string | null {
    const chars = this.triggerCharacters();
    if (chars.size === 0) return null;
    const cursor = this.editor.getCursorBufferPosition();
    if (cursor.column === 0) return null;
    // Columns are codepoints; index the line as codepoints, not UTF-16 units.
    const ch = [...this.editor.lineTextForBufferRow(cursor.row)][cursor.column - 1];
    return ch && chars.has(ch) ? ch : null;
  }

  private scheduleQuery(trigger: CompletionTrigger, triggerCharacter?: string): void {
    if (this.debounceId) clearTimeout(this.debounceId);
    this.debounceId = setTimeout(() => {
      this.debounceId = null;
      this.query(trigger, triggerCharacter);
    }, DEBOUNCE_MS);
  }

  private query(trigger: CompletionTrigger, triggerCharacter?: string): void {
    const context = this.buildContext(trigger, triggerCharacter);
    if (trigger === 'auto' && context.prefix.length < MIN_PREFIX) {
      this.popup.hide();
      return;
    }
    const results = this.sources.map((source) => {
      try {
        const result = source.complete(context);
        return isThenable(result)
          ? result.then((items) => tagSource(items, source.name))
          : tagSource(result, source.name);
      } catch {
        return [];
      }
    });
    // Sync sources (buffer words, placeholder) present immediately — awaiting even
    // an already-resolved promise costs a microtask, which under node-gtk's GLib
    // loop is sluggish. Only async sources (LSP, Copilot) take the awaited path.
    if (!results.some(isThenable)) {
      this.present((results as CompletionItem[][]).flat(), context);
      return;
    }
    const seq = ++this.requestSeq;
    void Promise.all(results.map((r) => Promise.resolve(r).catch(() => [] as CompletionItem[]))).then((lists) => {
      if (seq === this.requestSeq) this.present(lists.flat(), context);
    });
  }

  private present(raw: CompletionItem[], context: CompletionContext): void {
    const ranked = this.rank(raw, context.prefix);
    // Anchor at the start of the word being completed, not the cursor, so the
    // candidate labels line up under the text they're replacing.
    const rect = ranked.length > 0 ? this.editor.pixelRectForBufferPosition(context.replaceRange.start) : null;
    if (!rect) {
      this.popup.hide();
      return;
    }
    // A fresh result set: nothing selected (-1). Establish the base region — the
    // heuristic typed-prefix range, widened on the left to cover any item's own
    // `replaceRange` (e.g. a member completion whose textEdit spans the `.`). Each
    // fill rebuilds this region from `baseText`, so it loops back to the original.
    const { start: prefixStart, end } = context.replaceRange;
    let startCol = prefixStart.column;
    for (const { item } of ranked) {
      const r = item.replaceRange;
      if (r && r.start.row === prefixStart.row && r.start.column < startCol) startCol = r.start.column;
    }
    this.prefixStartCol = prefixStart.column;
    this.baseRange = new Range(new Point(prefixStart.row, startCol), end);
    this.baseText = this.editor.getTextInBufferRange(this.baseRange);
    this.previewRange = this.baseRange;
    this.popup.showAt(ranked, context.replaceRange.start);
  }

  /** The word being typed before the cursor and the range it occupies. */
  private buildContext(trigger: CompletionTrigger, triggerCharacter?: string): CompletionContext {
    const cursor = this.editor.getCursorBufferPosition();
    const line = this.editor.lineTextForBufferRow(cursor.row);
    // Codepoint-aware: columns are codepoints, JS string indices are UTF-16.
    const codepoints = [...line];
    let start = cursor.column;
    while (start > 0 && /\w/.test(codepoints[start - 1])) start--;
    const prefix = codepoints.slice(start, cursor.column).join('');
    const replaceRange = new Range(new Point(cursor.row, start), cursor);
    return { prefix, cursor, replaceRange, line, trigger, triggerCharacter };
  }

  /**
   * Fuzzy-filter against the prefix (reusing the picker's fzy scorer, so a
   * subsequence — and a single typo — still matches), then rank and cap to the
   * popup. Source priority dominates: a higher-priority source (e.g. LSP) ranks
   * entirely above a lower one (buffer words), regardless of score. Within a
   * source, fzy's word-start/consecutive bonuses keep prefix matches on top and
   * `sortText` (e.g. buffer-word frequency) breaks ties. An empty prefix keeps
   * everything, ordered by source then `sortText`/label.
   */
  private rank(items: CompletionItem[], prefix: string): RankedCompletion[] {
    const priorities = new Map(this.sources.map((source) => [source.name, source.priority ?? 0]));
    const priorityOf = (name: string | undefined) => (name === undefined ? 0 : priorities.get(name) ?? 0);
    return items
      .map((item) => {
        const text = item.filterText ?? item.label;
        // Completion stays case-insensitive (smartcase is the picker's behavior).
        const match =
          prefix === '' ? { score: 0, positions: [] } : fuzzyMatch(prefix, text, { maxTypos: 1, smartcase: false });
        if (!match) return null;
        // Highlight positions must index into the displayed `label`. They already
        // do when matching `label` directly; if a source matched a distinct
        // `filterText`, re-derive positions against the label (best effort).
        const positions =
          text === item.label
            ? match.positions
            : (prefix === '' ? [] : (fuzzyMatch(prefix, item.label, { smartcase: false })?.positions ?? []));
        return { item, score: match.score, positions };
      })
      .filter((entry): entry is { item: CompletionItem; score: number; positions: number[] } => entry !== null)
      .sort((a, b) => {
        const pa = priorityOf(a.item.source);
        const pb = priorityOf(b.item.source);
        if (pa !== pb) return pb - pa; // higher-priority source first
        if (a.score !== b.score) return b.score - a.score; // then higher score
        const ak = a.item.sortText ?? a.item.label;
        const bk = b.item.sortText ?? b.item.label;
        return ak < bk ? -1 : ak > bk ? 1 : 0;
      })
      .slice(0, MAX_ITEMS)
      .map(({ item, positions }) => ({ item, positions }));
  }

  /**
   * Tab / Shift-Tab / arrows. Cycle the selection over the n+1 states
   * [-1, 0 … n-1]: -1 is "nothing selected" (the original typed text), and the
   * end loops back to -1. The selected candidate is written into the buffer as a
   * live preview; -1 restores the typed text.
   */
  private cycle(delta: number): void {
    if (!this.popup.isOpen) return;
    const n = this.popup.length;
    if (n === 0) return;
    const states = n + 1;
    const cur = this.popup.getSelectedIndex(); // -1 … n-1
    const next = (((cur + 1 + delta) % states) + states) % states - 1;
    this.popup.select(next);
    this.applyPreview(next < 0 ? null : this.popup.getSelected());
    if (next >= 0) this.resolveSelectedDoc();
  }

  /** Lazily fetch the selected item's documentation (LSP resolve) and, if it's
   *  still selected when the request returns, refresh the doc pane. */
  private resolveSelectedDoc(): void {
    const item = this.popup.getSelected();
    if (!item || !item.resolve || this.resolved.has(item)) return;
    // Resolve to fill the doc pane and/or the auto-import edits (additionalEdits).
    if (item.documentation !== undefined && item.additionalEdits !== undefined) return;
    this.resolved.add(item);
    void item
      .resolve()
      .then((full) => {
        if (full.documentation) item.documentation = full.documentation;
        if (full.detail && !item.detail) item.detail = full.detail;
        if (full.additionalEdits && !item.additionalEdits) item.additionalEdits = full.additionalEdits;
        if (item.documentation && this.popup.getSelected() === item) this.popup.refreshDoc();
      })
      .catch(() => {});
  }

  /**
   * Rebuild the base region's text for `item` (null = the original typed text),
   * applying the item's own `replaceRange` against `baseText` so a server textEdit
   * is honored. Returns the region's new text and the resulting cursor column.
   */
  private previewFor(item: CompletionItem | null): { text: string; cursorColumn: number } {
    const base = this.baseRange!;
    const baseCps = [...this.baseText];
    if (!item) {
      return { text: this.baseText, cursorColumn: base.start.column + baseCps.length };
    }
    const newText = item.insertText ?? item.label;
    const clamp = (n: number) => Math.min(Math.max(n, 0), baseCps.length);
    const r = item.replaceRange;
    // Codepoint offsets into the base region the item's edit replaces. With a
    // server range, use it; otherwise replace just the heuristic typed prefix.
    const headLen =
      r && r.start.row === base.start.row && r.end.row === base.start.row
        ? clamp(r.start.column - base.start.column)
        : clamp(this.prefixStartCol - base.start.column);
    const tailStart =
      r && r.start.row === base.start.row && r.end.row === base.start.row
        ? clamp(r.end.column - base.start.column)
        : baseCps.length;
    const text = baseCps.slice(0, headLen).join('') + newText + baseCps.slice(tailStart).join('');
    return { text, cursorColumn: base.start.column + headLen + [...newText].length };
  }

  /** Replace the base region with `item`'s preview (null restores the typed text). */
  private applyPreview(item: CompletionItem | null): void {
    const base = this.baseRange;
    if (!base || !this.previewRange) return;
    const { text, cursorColumn } = this.previewFor(item);
    // Guard the edit so its synchronous buffer-change event doesn't re-query
    // (see `onBufferChanged`/`suppressQuery`); the popup stays as-is.
    this.suppressQuery = true;
    try {
      this.previewRange = this.editor.setTextInBufferRange(this.previewRange, text);
      this.editor.setCursorBufferPosition(new Point(base.start.row, cursorColumn));
    } finally {
      this.suppressQuery = false;
    }
  }

  /** Enter with a candidate selected: the preview is already in the buffer, so
   *  just close — then apply the item's extra edits (e.g. an auto-import line).
   *  If those haven't been resolved yet (fast accept), resolve and apply async. */
  private accept(): void {
    const item = this.popup.getSelected();
    this.dismiss();
    if (!item) return;
    if (item.additionalEdits) {
      this.applyAdditionalEdits(item.additionalEdits);
    } else if (item.resolve && !this.resolved.has(item)) {
      this.resolved.add(item);
      void item
        .resolve()
        .then((full) => full.additionalEdits && this.applyAdditionalEdits(full.additionalEdits))
        .catch(() => {});
    }
  }

  // Apply an accepted item's extra edits (LSP additionalTextEdits, e.g. an import
  // line). They sit above/around the inserted text in pre-accept coordinates, so
  // apply last-first; guarded so the edit doesn't re-open the popup.
  private applyAdditionalEdits(edits: { range: Range; newText: string }[]): void {
    const sorted = [...edits].sort((a, b) => b.range.start.compare(a.range.start));
    this.suppressQuery = true;
    try {
      for (const { range, newText } of sorted) this.editor.setTextInBufferRange(range, newText);
    } finally {
      this.suppressQuery = false;
    }
  }

  private installKeys(): void {
    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number, _keycode: number, state: number) => {
      const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
      const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
      if (!this.popup.isOpen) {
        if (ctrl && keyval === Gdk.KEY_space) {
          this.trigger();
          return true;
        }
        return false;
      }
      switch (keyval) {
        case Gdk.KEY_Tab:
          this.cycle(shift ? -1 : 1);
          return true;
        case Gdk.KEY_ISO_Left_Tab: // Shift-Tab on most layouts
          this.cycle(-1);
          return true;
        case Gdk.KEY_Down:
          this.cycle(1);
          return true;
        case Gdk.KEY_Up:
          this.cycle(-1);
          return true;
        case Gdk.KEY_Return:
        case Gdk.KEY_KP_Enter:
          // Commit a selected candidate; with nothing selected, let Enter
          // through (its normal insert-mode newline) but close the popup.
          if (this.popup.getSelectedIndex() >= 0) {
            this.accept();
            return true;
          }
          this.dismiss();
          return false;
        default:
          if (ctrl && keyval === Gdk.KEY_n) {
            this.cycle(1);
            return true;
          }
          if (ctrl && keyval === Gdk.KEY_p) {
            this.cycle(-1);
            return true;
          }
          if (ctrl && keyval === Gdk.KEY_e) {
            this.dismiss();
            return true;
          }
          return false; // typing flows through → onBufferChanged re-queries
      }
    });
    this.disposables.addController(this.editor.view, keys);
  }
}
