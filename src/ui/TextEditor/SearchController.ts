/*
 * SearchController — the search/replace engine behind the `SearchBar` widget and
 * the vim `/` `?` `n` `N` bindings.
 *
 * It is GTK-widget-free: it drives a buffer through `EditorModel` (regex scan,
 * cursor moves) and paints matches through the shared `DecorationController`
 * (`highlight` on every match, `highlight-strong` on the current one), so it is
 * unit-testable on a headless buffer. The `SearchBar` owns the UI and forwards
 * the query, the options, and navigation here.
 *
 * Lifecycle: `start()` remembers the cursor so `cancel()` can return to it;
 * `setQuery`/`setOptions` re-search incrementally and preview the nearest match;
 * `next`/`previous` step (respecting the search direction); `confirm()` keeps the
 * cursor and highlights so `n`/`N` keep working after the bar closes; `cancel()`
 * restores the origin and clears the highlights.
 */
import { Point } from '../../text/Point.ts';
import type { Range } from '../../text/Range.ts';
import type { EditorModel } from './EditorModel.ts';
import type { DecorationController } from './DecorationController.ts';

/**
 * Case handling: `sensitive` always matches case, `insensitive` never does, and
 * `smart` (vim's smartcase) is insensitive unless the query contains an uppercase
 * letter, in which case it becomes sensitive.
 */
export type CaseMode = 'smart' | 'sensitive' | 'insensitive';

export interface SearchOptions {
  caseMode: CaseMode;
  useRegex: boolean;
}

export interface SearchState {
  query: string;
  /** Total match count. */
  count: number;
  /** 1-based index of the current match, or 0 when there is none. */
  current: number;
  /** The pattern failed to compile (regex mode). */
  invalid: boolean;
}

const LAYER = 'search';

export class SearchController {
  readonly options: SearchOptions = { caseMode: 'smart', useRegex: false };

  private readonly editor: EditorModel;
  private readonly decorations: DecorationController;

  private query = '';
  private matches: Range[] = [];
  private index = -1; // into `matches`, or -1
  private origin: Point | null = null;
  private reverse = false;
  private invalid = false;
  // Wrap the (escaped) query in word boundaries — set by the vim `*`/`#`
  // word search, cleared by any bar-driven query.
  private wholeWord = false;

  // Notified with the active search regex whenever a search runs, so the host can
  // publish it to the vim layer (globalState.lastSearchPattern) for `gn`/`gN`.
  private onPattern?: (regex: RegExp) => void;

  constructor(editor: EditorModel, decorations: DecorationController) {
    this.editor = editor;
    this.decorations = decorations;
  }

  /** Register a listener for the active search pattern (the vim `gn` bridge). */
  setPatternListener(fn: (regex: RegExp) => void): void {
    this.onPattern = fn;
  }

  /** Begin a search session: remember the cursor and the direction. */
  start(reverse = false): void {
    this.origin = this.editor.getCursorBufferPosition();
    this.reverse = reverse;
  }

  /** Whether a search is active (has matches to step through with n/N). */
  get hasActiveSearch(): boolean {
    return this.query.length > 0;
  }

  setQuery(query: string): SearchState {
    this.query = query;
    this.wholeWord = false;
    this.research(true);
    return this.state;
  }

  /**
   * vim `*` / `#`: search for `word` with word boundaries, stepping once in the
   * search direction (`*` forward, `#` backward) and arming `n`/`N` to continue.
   * `word` is a literal — it's escaped (and `\b`-wrapped) when the regex is built.
   */
  searchWord(word: string, reverse: boolean, wholeWord = true): SearchState {
    this.start(reverse);
    this.query = word;
    this.wholeWord = wholeWord; // `*`/`#` match whole words; `g*`/`g#` match substrings too
    this.options.useRegex = false; // `word` is literal; whole-word wrapping is separate
    return this.next(); // step in the search direction, off the word under the cursor
  }

  setOptions(options: Partial<SearchOptions>): SearchState {
    Object.assign(this.options, options);
    this.research(true);
    return this.state;
  }

  /**
   * Step to the next match in the search direction (`/`→down, `?`→up), relative
   * to the *current cursor* — so `n` works correctly even after the cursor has
   * moved away from the previous match.
   */
  next(): SearchState {
    return this.stepFromCursor(!this.reverse);
  }

  /** Step to the previous match (opposite the search direction), cursor-relative. */
  previous(): SearchState {
    return this.stepFromCursor(this.reverse);
  }

  /** Keep the cursor at the current match and the highlights (close-confirm). */
  confirm(): void {
    /* matches + highlights persist so n/N keep working */
  }

  /** Return to where the search started and clear highlights (close-cancel). */
  cancel(): void {
    if (this.origin) this.editor.setCursorBufferPosition(this.origin);
    this.clear();
  }

  /** Move the cursor back to the search origin while keeping matches/highlights.
   *  Used by search-as-motion: the operator re-derives its range from the origin,
   *  yet the search stays active so `n`/`N` keep working afterwards. */
  restoreOrigin(): void {
    if (this.origin) this.editor.setCursorBufferPosition(this.origin);
  }

  /** The currently-seated match (what `/`/`?` would land on), or null. */
  get currentMatch(): Range | null {
    return this.index >= 0 ? (this.matches[this.index] ?? null) : null;
  }

  /** Drop matches + highlights (e.g. `:noh` or a fresh, empty query). */
  clear(): void {
    this.matches = [];
    this.index = -1;
    this.decorations.layer(LAYER).clear();
  }

  /** Replace the current match, then advance to the next one. */
  replaceCurrent(replacement: string): SearchState {
    this.scanMatches();
    const range = this.matches[this.index];
    if (range) {
      this.editor.setTextInBufferRange(range, this.expand(this.editor.getTextInBufferRange(range), replacement));
      this.scanMatches(); // `index` now points at the following match
      this.index = this.matches.length > 0 ? Math.min(this.index, this.matches.length - 1) : -1;
      this.highlight();
      this.moveToCurrent();
    }
    return this.state;
  }

  /** Replace every match in one undo step; returns the number replaced. */
  replaceAll(replacement: string): number {
    const regex = this.buildRegex();
    if (!regex) return 0;
    let count = 0;
    this.editor.scan(regex, ({ matchText, replace }) => {
      replace(this.expand(matchText, replacement));
      count++;
    });
    this.scanMatches();
    this.index = this.matches.length > 0 ? 0 : -1;
    this.highlight();
    return count;
  }

  get state(): SearchState {
    return {
      query: this.query,
      count: this.matches.length,
      current: this.index < 0 ? 0 : this.index + 1,
      invalid: this.invalid,
    };
  }

  // --- internals -------------------------------------------------------------

  /** Re-scan + seat the nearest-to-origin match (incremental preview path). */
  private research(reseat: boolean): void {
    this.scanMatches();
    if (this.matches.length === 0) {
      this.index = -1;
      this.highlight();
      return;
    }
    if (reseat) {
      this.index = this.nearestIndex(this.origin ?? this.editor.getCursorBufferPosition());
    } else if (this.index < 0 || this.index >= this.matches.length) {
      this.index = 0;
    }
    this.highlight();
    this.moveToCurrent();
  }

  /** Re-scan, then seat the match `forward`/back of the *current cursor* (n/N). */
  private stepFromCursor(forward: boolean): SearchState {
    this.scanMatches();
    if (this.matches.length === 0) {
      this.index = -1;
      this.highlight();
      return this.state;
    }
    const cursor = this.editor.getCursorBufferPosition();
    this.index = forward ? this.firstMatchAfter(cursor) : this.lastMatchBefore(cursor);
    this.highlight();
    this.moveToCurrent();
    return this.state;
  }

  private scanMatches(): void {
    const regex = this.buildRegex();
    this.matches = [];
    if (regex) {
      this.onPattern?.(regex); // publish the live pattern for the vim `gn` text objects
      this.editor.scan(regex, ({ range }) => this.matches.push(range));
    }
  }

  /** First match strictly after `point`, wrapping to the first. */
  private firstMatchAfter(point: Point): number {
    for (let i = 0; i < this.matches.length; i++) {
      if (this.matches[i].start.isGreaterThan(point)) return i;
    }
    return 0;
  }

  /** Last match strictly before `point`, wrapping to the last. */
  private lastMatchBefore(point: Point): number {
    for (let i = this.matches.length - 1; i >= 0; i--) {
      if (this.matches[i].start.isLessThan(point)) return i;
    }
    return this.matches.length - 1;
  }

  /** The match to seat on from `point`: first at/after it (`/`) or last at/before (`?`). */
  private nearestIndex(point: Point): number {
    if (this.reverse) {
      for (let i = this.matches.length - 1; i >= 0; i--) {
        if (this.matches[i].start.isLessThanOrEqual(point)) return i;
      }
      return this.matches.length - 1; // wrap to last
    }
    for (let i = 0; i < this.matches.length; i++) {
      if (this.matches[i].start.isGreaterThanOrEqual(point)) return i;
    }
    return 0; // wrap to first
  }

  /** Paint all matches (`highlight`) with the current one strong. */
  private highlight(): void {
    const layer = this.decorations.layer(LAYER);
    layer.clear();
    for (let i = 0; i < this.matches.length; i++) {
      layer.decorate(this.matches[i], i === this.index ? 'highlight-strong' : 'highlight');
    }
  }

  /** Move the cursor to the current match (and scroll it onscreen). */
  private moveToCurrent(): void {
    const current = this.matches[this.index];
    if (current) {
      this.editor.setCursorBufferPosition(current.start);
      this.editor.scrollToBufferPosition(current.start);
    }
  }

  /** Whether the current query matches case-insensitively (resolves smartcase). */
  private get insensitive(): boolean {
    switch (this.options.caseMode) {
      case 'sensitive':
        return false;
      case 'insensitive':
        return true;
      case 'smart':
        return !/[A-Z]/.test(this.query); // smartcase: any uppercase ⇒ sensitive
    }
  }

  private buildRegex(): RegExp | null {
    this.invalid = false;
    if (this.query.length === 0) return null;
    let source = this.options.useRegex ? this.query : escapeRegExp(this.query);
    if (this.wholeWord) source = `\\b${source}\\b`;
    const flags = 'g' + (this.insensitive ? 'i' : '');
    try {
      return new RegExp(source, flags);
    } catch {
      this.invalid = true;
      return null;
    }
  }

  /** Compute the replacement text for one match (regex backrefs in regex mode). */
  private expand(matchText: string, replacement: string): string {
    if (!this.options.useRegex) return replacement;
    const flags = this.insensitive ? 'i' : '';
    try {
      return matchText.replace(new RegExp(this.query, flags), replacement);
    } catch {
      return replacement;
    }
  }
}

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
