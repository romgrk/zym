/*
 * FuzzyPicker — a generic "quick open" overlay: a search entry over a
 * fuzzy-filtered, rank-sorted list with the matched characters highlighted.
 * Type to narrow, Up/Down (or Tab) to move, Enter to choose, Escape to dismiss.
 *
 * It renders as a floating card inside a Gtk.Overlay (supplied by the caller as
 * `host`) rather than a separate window, so it sits over the editor unobtrusively
 * and dismisses when it loses focus. It knows nothing about files; callers supply
 * the candidate strings and an `onSelect` callback. Items may arrive
 * asynchronously via the returned handle's `setItems`.
 */
import { Gdk, Gtk } from './gi.ts';

const PICKER_WIDTH = 640;
const PICKER_MAX_HEIGHT = 360;
const MAX_RESULTS = 200;
const HIGHLIGHT_COLOR = '#e01b24'; // Adwaita red

type Overlay = InstanceType<typeof Gtk.Overlay>;

// libadwaita's `.card` fill (`@card_bg_color`) is semi-transparent — meant to
// sit on a window, not float over editor content. Override it with the opaque
// popover background so the editor doesn't show through. Installed once.
let stylesInstalled = false;
function ensureStyles(): void {
  if (stylesInstalled) return;
  const display = Gdk.Display.getDefault();
  if (!display) return;
  const provider = new Gtk.CssProvider();
  provider.loadFromString('.quilx-picker-card { background-color: @popover_bg_color; }');
  Gtk.StyleContext.addProviderForDisplay(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
  stylesInstalled = true;
}

export interface FuzzyPickerOptions {
  host: Overlay;
  placeholder?: string;
  items?: string[];
  onSelect: (item: string) => void;
}

export interface FuzzyPickerHandle {
  /** Replace the candidate list (e.g. once an async scan completes). */
  setItems(items: string[]): void;
  close(): void;
}

export function openFuzzyPicker(options: FuzzyPickerOptions): FuzzyPickerHandle {
  const { host } = options;

  const entry = new Gtk.SearchEntry({ placeholderText: options.placeholder ?? 'Search…' });
  entry.setHexpand(true);
  entry.setMarginTop(8);
  entry.setMarginStart(8);
  entry.setMarginEnd(8);

  const listBox = new Gtk.ListBox();
  listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);

  const scrolled = new Gtk.ScrolledWindow();
  scrolled.setChild(listBox);
  scrolled.setPropagateNaturalHeight(true);
  scrolled.setMaxContentHeight(PICKER_MAX_HEIGHT);
  scrolled.setMarginStart(8);
  scrolled.setMarginEnd(8);
  scrolled.setMarginBottom(8);

  // A floating, opaque "card" placed at the top-centre of the overlay.
  ensureStyles();
  const panel = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
  panel.addCssClass('card');
  panel.addCssClass('quilx-picker-card');
  panel.setHalign(Gtk.Align.CENTER);
  panel.setValign(Gtk.Align.START);
  panel.setMarginTop(12);
  panel.setSizeRequest(PICKER_WIDTH, -1);
  panel.append(entry);
  panel.append(scrolled);

  let items = options.items ?? [];
  // The currently displayed matches, parallel to the rows in the list box, so a
  // row can be mapped back to its item by index.
  let results: string[] = [];
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    host.removeOverlay(panel);
  };

  const rebuild = () => {
    let child = listBox.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      listBox.remove(child);
      child = next;
    }
    const ranked = rank(entry.getText(), items).slice(0, MAX_RESULTS);
    results = ranked.map((match) => match.item);
    for (const match of ranked) {
      const label = new Gtk.Label({ xalign: 0, useMarkup: true });
      label.setMarkup(highlightMarkup(match.item, match.positions));
      label.setMarginTop(2);
      label.setMarginBottom(2);
      label.setMarginStart(6);
      label.setMarginEnd(6);
      const row = new Gtk.ListBoxRow();
      row.setChild(label);
      listBox.append(row);
    }
    const first = listBox.getRowAtIndex(0);
    if (first) listBox.selectRow(first);
  };

  const choose = (row: InstanceType<typeof Gtk.ListBoxRow> | null) => {
    const target = row ?? listBox.getSelectedRow();
    if (!target) return;
    const item = results[target.getIndex()];
    if (item === undefined) return;
    close();
    options.onSelect(item);
  };

  const move = (delta: number) => {
    if (results.length === 0) return;
    const selected = listBox.getSelectedRow();
    const current = selected ? selected.getIndex() : -1;
    const next = (current + delta + results.length) % results.length;
    const row = listBox.getRowAtIndex(next);
    if (row) listBox.selectRow(row);
  };

  entry.on('search-changed', rebuild);
  entry.on('activate', () => choose(null));
  listBox.on('row-activated', (row) => choose(row));

  // Drive list navigation from a capture-phase controller so Up/Down/Tab move
  // the selection instead of the entry's cursor or the focus chain.
  const keys = new Gtk.EventControllerKey();
  keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
  keys.on('key-pressed', (keyval: number) => {
    switch (keyval) {
      case Gdk.KEY_Escape:
        close();
        return true;
      case Gdk.KEY_Down:
      case Gdk.KEY_KP_Down:
      case Gdk.KEY_Tab:
        move(1);
        return true;
      case Gdk.KEY_Up:
      case Gdk.KEY_KP_Up:
      case Gdk.KEY_ISO_Left_Tab:
        move(-1);
        return true;
      default:
        return false;
    }
  });
  panel.addController(keys);

  // Dismiss when focus leaves the card (e.g. clicking back into the editor).
  const focus = new Gtk.EventControllerFocus();
  focus.on('leave', () => close());
  panel.addController(focus);

  host.addOverlay(panel);
  rebuild();
  entry.grabFocus();

  return {
    setItems(next: string[]) {
      items = next;
      if (!closed) rebuild();
    },
    close,
  };
}

export interface FuzzyMatch {
  /** Higher is a better match. */
  score: number;
  /** Indices in the text that the query matched, in order. */
  positions: number[];
}

/**
 * Score `text` against `query` as a fuzzy (subsequence) match, recording which
 * characters matched. Returns `null` when `query` is not a subsequence of
 * `text`. An empty query matches everything with a neutral score.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, positions: [] };
  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();

  const positions: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of needle) {
    let pos = -1;
    for (let j = from; j < haystack.length; j++) {
      if (haystack[j] === ch) { pos = j; break; }
    }
    if (pos === -1) return null;

    if (pos === previous + 1) score += 8;                  // consecutive run
    if (pos === 0 || isBoundary(text, pos)) score += 12;   // word / path boundary
    score -= pos - from;                                   // penalise skipped chars
    positions.push(pos);
    previous = pos;
    from = pos + 1;
  }
  return { score: score - text.length * 0.05, positions }; // prefer shorter, denser hits
}

function isBoundary(text: string, pos: number): boolean {
  const before = text[pos - 1];
  if (before === '/' || before === '\\' || before === '_' ||
      before === '-' || before === '.' || before === ' ') {
    return true;
  }
  // camelCase boundary: a lowercase/digit followed by an uppercase letter.
  return /[a-z0-9]/.test(before) && /[A-Z]/.test(text[pos]);
}

interface RankedItem {
  item: string;
  positions: number[];
}

function rank(query: string, items: string[]): RankedItem[] {
  if (query.length === 0) return items.map((item) => ({ item, positions: [] }));
  const scored: Array<RankedItem & { score: number }> = [];
  for (const item of items) {
    const match = fuzzyMatch(query, item);
    if (match) scored.push({ item, positions: match.positions, score: match.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Render `text` as Pango markup with the matched characters highlighted red. */
function highlightMarkup(text: string, positions: number[]): string {
  const matched = new Set(positions);
  let out = '';
  let highlit = false;
  for (let i = 0; i < text.length; i++) {
    const isMatch = matched.has(i);
    if (isMatch && !highlit) { out += `<span foreground="${HIGHLIGHT_COLOR}" weight="bold">`; highlit = true; }
    else if (!isMatch && highlit) { out += '</span>'; highlit = false; }
    out += escapeMarkup(text[i]);
  }
  if (highlit) out += '</span>';
  return out;
}

function escapeMarkup(ch: string): string {
  if (ch === '&') return '&amp;';
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  return ch;
}
