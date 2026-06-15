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
import { Gdk, GLib, Gtk } from '../../gi.ts';
import { Point } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';
import type { EditorModel } from './EditorModel.ts';
import { fuzzyMatch } from '../fuzzyMatch.ts';
import { CompletionPopup } from './CompletionPopup.ts';
import type { CompletionContext, CompletionItem, CompletionSource, CompletionTrigger, RankedCompletion } from './CompletionSource.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

const DEBOUNCE_MS = 60;
const MIN_PREFIX = 1; // word chars typed before auto-opening
const MAX_ITEMS = 10; // also the popup's no-scroll capacity

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

  private replaceRange: Range | null = null;
  private requestSeq = 0; // drops stale async source responses
  private debounceId = 0;
  private suppressQuery = false; // ignore the buffer change from our own edits
  // Tab writes the selected candidate into the buffer as a live preview (the
  // popup stays open); `previewRange` is the buffer span it occupies so the next
  // cycle replaces it, and `previewActive` is set once a preview has been written.
  private previewRange: Range | null = null;
  private previewActive = false;

  constructor(editor: EditorModel, host: Overlay, isInsertMode: () => boolean) {
    this.editor = editor;
    this.isInsertMode = isInsertMode;
    this.popup = new CompletionPopup(host);
    editor.onDidChangeText(() => this.onBufferChanged());
    this.installKeys();
  }

  /** Register a candidate source (placeholder, buffer words, LSP, Copilot, …). */
  addSource(source: CompletionSource): void {
    this.sources.push(source);
  }

  /** Close the popup and cancel any pending query. */
  dismiss(): void {
    if (this.debounceId) {
      GLib.sourceRemove(this.debounceId);
      this.debounceId = 0;
    }
    this.requestSeq++; // invalidate in-flight queries
    this.previewActive = false;
    this.previewRange = null;
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
    if (this.debounceId) GLib.sourceRemove(this.debounceId);
    this.debounceId = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
      this.debounceId = 0;
      this.query(trigger, triggerCharacter);
      return false;
    });
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
    this.replaceRange = context.replaceRange;
    // A fresh result set: no preview written yet; the next Tab fills from the
    // original word range.
    this.previewRange = context.replaceRange;
    this.previewActive = false;
    this.popup.showAt(ranked, rect.x, rect.y + rect.height);
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
        if (item.label === prefix) return null; // already fully typed
        const text = item.filterText ?? item.label;
        const match = prefix === '' ? { score: 0, positions: [] } : fuzzyMatch(prefix, text, { maxTypos: 1 });
        if (!match) return null;
        // Highlight positions must index into the displayed `label`. They already
        // do when matching `label` directly; if a source matched a distinct
        // `filterText`, re-derive positions against the label (best effort).
        const positions =
          text === item.label
            ? match.positions
            : (prefix === '' ? [] : (fuzzyMatch(prefix, item.label)?.positions ?? []));
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
   * Tab / Shift-Tab. The first press writes the current selection into the
   * buffer as a live preview (popup stays open); further presses move the
   * selection by `delta` (wrapping) and re-fill, cycling through the candidates.
   */
  private cycle(delta: number): void {
    if (!this.popup.isOpen) return;
    if (this.previewActive) this.popup.move(delta);
    this.fillSelected();
  }

  /** Arrow / Ctrl-N/P: move the selection, keeping a live preview in sync. */
  private navigate(delta: number): void {
    if (!this.popup.isOpen) return;
    this.popup.move(delta);
    if (this.previewActive) this.fillSelected();
  }

  /** Write the selected candidate into `previewRange` and track its new span. */
  private fillSelected(): void {
    const item = this.popup.getSelected();
    const range = this.previewRange;
    if (!item || !range) return;
    // Guard the edit so its synchronous buffer-change event doesn't re-query
    // (see `onBufferChanged`/`suppressQuery`); the popup stays as-is.
    this.suppressQuery = true;
    try {
      const inserted = this.editor.setTextInBufferRange(range, item.insertText ?? item.label);
      this.editor.setCursorBufferPosition(inserted.end);
      this.previewRange = inserted;
      this.previewActive = true;
    } finally {
      this.suppressQuery = false;
    }
  }

  /** Enter: commit. A live preview is already in the buffer, so just close;
   *  otherwise insert the selected item (e.g. selected via arrows, never Tab'd). */
  private accept(): void {
    if (this.previewActive) {
      this.dismiss();
      return;
    }
    const item = this.popup.getSelected();
    const range = this.replaceRange;
    this.dismiss();
    if (item && range) {
      this.suppressQuery = true;
      try {
        const inserted = this.editor.setTextInBufferRange(range, item.insertText ?? item.label);
        this.editor.setCursorBufferPosition(inserted.end);
      } finally {
        this.suppressQuery = false;
      }
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
          this.navigate(1);
          return true;
        case Gdk.KEY_Up:
          this.navigate(-1);
          return true;
        case Gdk.KEY_Return:
        case Gdk.KEY_KP_Enter:
          this.accept();
          return true;
        default:
          if (ctrl && keyval === Gdk.KEY_n) {
            this.navigate(1);
            return true;
          }
          if (ctrl && keyval === Gdk.KEY_p) {
            this.navigate(-1);
            return true;
          }
          if (ctrl && keyval === Gdk.KEY_e) {
            this.dismiss();
            return true;
          }
          return false; // typing flows through → onBufferChanged re-queries
      }
    });
    this.editor.view.addController(keys);
  }
}
