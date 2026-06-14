/*
 * Picker — a generic "quick open" overlay: a search entry over a
 * fuzzy-filtered, rank-sorted list with the matched characters highlighted.
 * Type to narrow, Up/Down (or Tab) to move, Enter to choose, Escape to dismiss.
 *
 * It renders as a floating card inside a Gtk.Overlay (supplied by the caller as
 * `host`) rather than a separate window, so it sits over the editor unobtrusively
 * and dismisses when it loses focus. It knows nothing about files; callers supply
 * the candidate strings and an `onSelect` callback. Items may arrive
 * asynchronously via the returned handle's `setItems`.
 */
import { Gdk, Gtk } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { monospaceFontCss } from '../fonts.ts';

const MONOSPACE = monospaceFontCss();

const PICKER_WIDTH = 640;
const PICKER_MAX_HEIGHT = 360;
const MAX_RESULTS = 200;
const HIGHLIGHT_COLOR = '#e01b24'; // Adwaita red

type Overlay = InstanceType<typeof Gtk.Overlay>;

// libadwaita's `.card` fill (`@card_bg_color`) is semi-transparent — meant to
// sit on a window, not float over editor content. Override it with the opaque
// popover background so the editor doesn't show through.
addStyles(`
  #Picker {
    padding: 0;
    border: 1px solid var(--border-color);
    border-radius: var(--window-radius);
    background-color: var(--window-bg-color);
    box-shadow: 0px 10px 33px 28px rgba(0,0,0,0.15);
    ${MONOSPACE.declarations}
  }
  #PickerEntry {
    padding: 0.5em 0.5em;
    border-radius: var(--window-radius);
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
  }
  /* Collapse the leading search icon (it has no .left class — it's just the
     first image child) so the entry text starts at the entry's 1em padding,
     matching the row text inset below. */
  #PickerEntry > image:first-child {
    -gtk-icon-size: 0;
    min-width: 0;
    min-height: 0;
    padding: 0;
    margin: 0;
  }
  #PickerEntry > text {
    margin: 0;
    padding: 0;
  }
  #PickerList {
    border-radius: var(--window-radius);
  }
  /* Drop Adwaita's built-in row padding so only the label's inset applies. */
  #PickerList row {
    padding: 0;
  }
  #PickerRow {
    padding: 0.5em 1em;
  }
  #PickerEmpty {
    padding: 0.5em 1em;
    opacity: 0.55;
  }
  /* The action row uses the current prompt; set it apart from the matches with a
     separator and the accent color. */
  #PickerAction {
    padding: 0.5em 1em;
    color: var(--accent-color);
  }
  #PickerList row.action-row {
    border-top: 1px solid var(--border-color);
  }
`);

/**
 * An action driven by the current prompt rather than by a listed item. When
 * supplied, a distinct row is shown (whenever the entry is non-empty) labelled
 * by `label(query)`; choosing it invokes `run(query)` with the entry's text.
 * Used e.g. by the agent picker to start a new agent from the typed prompt.
 */
export interface PickerAction {
  /** The action row's text for the current query (e.g. `Start agent: …`). */
  label: (query: string) => string;
  /** Run the action with the current query; the picker closes first. */
  run: (query: string) => void;
}

export interface PickerOptions {
  host: Overlay;
  placeholder?: string;
  items?: string[];
  onSelect: (item: string) => void;
  action?: PickerAction;
}

export interface PickerHandle {
  /** Replace the candidate list (e.g. once an async scan completes). */
  setItems(items: string[]): void;
  close(): void;
}

export function openPicker(options: PickerOptions): PickerHandle {
  const { host } = options;

  const entry = new Gtk.SearchEntry({
    placeholderText: options.placeholder ?? 'Search…',
  });
  entry.setHexpand(true);
  entry.setName('PickerEntry');
  entry.addCssClass('has-text-input'); // release the `space` leader so it types

  const listBox = new Gtk.ListBox();
  listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);

  const scrolled = new Gtk.ScrolledWindow();
  scrolled.setChild(listBox);
  scrolled.setPropagateNaturalHeight(true);
  scrolled.setMaxContentHeight(PICKER_MAX_HEIGHT);
  scrolled.setName('PickerList');

  // A floating, opaque "card" placed at the top-centre of the overlay.
  const panel = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
  panel.setName('Picker');
  panel.setHalign(Gtk.Align.CENTER);
  panel.setValign(Gtk.Align.START);
  panel.setMarginTop(48);
  panel.setSizeRequest(PICKER_WIDTH, -1);
  panel.append(entry);
  panel.append(scrolled);
  panel.overflow = Gtk.Overflow.HIDDEN;

  let items = options.items ?? [];
  // The currently displayed matches, parallel to the leading rows in the list
  // box, so a row can be mapped back to its item by index.
  let results: string[] = [];
  // The trailing action row, when an action is configured and the entry is
  // non-empty; checked in `choose` to run the action instead of selecting.
  let actionRow: InstanceType<typeof Gtk.ListBoxRow> | null = null;
  let closed = false;

  // Remember whatever held focus before the picker grabbed it, so that
  // dismissing without a selection returns focus there (e.g. back to the editor)
  // instead of leaving it stranded on the now-removed overlay.
  const previousFocus = host.getRoot()?.getFocus() ?? null;

  const close = (restoreFocus = true) => {
    if (closed) return;
    closed = true;
    host.removeOverlay(panel);
    if (restoreFocus) previousFocus?.grabFocus();
  };

  const rebuild = () => {
    let child = listBox.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      listBox.remove(child);
      child = next;
    }
    const query = entry.getText();
    const ranked = rank(query, items).slice(0, MAX_RESULTS);
    results = ranked.map((match) => match.item);
    for (const match of ranked) {
      const label = new Gtk.Label({ xalign: 0, useMarkup: true });
      label.setMarkup(highlightMarkup(match.item, match.positions));
      label.setName('PickerRow');
      const row = new Gtk.ListBoxRow();
      row.setChild(label);
      listBox.append(row);
    }

    // The prompt-driven action sits after the matches; it appears only when the
    // user has typed something for it to act on.
    actionRow = null;
    if (options.action && query.length > 0) {
      const label = new Gtk.Label({ xalign: 0 });
      label.setText(options.action.label(query));
      label.setName('PickerAction');
      actionRow = new Gtk.ListBoxRow();
      actionRow.setChild(label);
      actionRow.addCssClass('action-row');
      listBox.append(actionRow);
    }

    if (results.length === 0 && !actionRow) {
      // No rows to select — show a non-interactive message row instead so the
      // card doesn't collapse to just the entry.
      const label = new Gtk.Label({ xalign: 0 });
      label.setText(items.length === 0 ? 'No entries' : 'No matches');
      label.setName('PickerEmpty');
      const row = new Gtk.ListBoxRow();
      row.setChild(label);
      row.setActivatable(false);
      row.setSelectable(false);
      listBox.append(row);
      return;
    }
    const first = listBox.getRowAtIndex(0);
    if (first) listBox.selectRow(first);
  };

  const choose = (row: InstanceType<typeof Gtk.ListBoxRow> | null) => {
    const target = row ?? listBox.getSelectedRow();
    if (!target) return;
    if (target === actionRow) {
      const query = entry.getText();
      close(false);
      options.action?.run(query);
      return;
    }
    const item = results[target.getIndex()];
    if (item === undefined) return;
    close(false);
    options.onSelect(item);
  };

  const move = (delta: number) => {
    // Navigable rows are the matches followed by the optional action row.
    const count = results.length + (actionRow ? 1 : 0);
    if (count === 0) return;
    const selected = listBox.getSelectedRow();
    const current = selected ? selected.getIndex() : -1;
    const next = (current + delta + count) % count;
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
  // focus.on('leave', () => close());
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
      if (haystack[j] === ch) {
        pos = j;
        break;
      }
    }
    if (pos === -1) return null;

    if (pos === previous + 1) score += 8; // consecutive run
    if (pos === 0 || isBoundary(text, pos)) score += 12; // word / path boundary
    score -= pos - from; // penalise skipped chars
    positions.push(pos);
    previous = pos;
    from = pos + 1;
  }
  return { score: score - text.length * 0.05, positions }; // prefer shorter, denser hits
}

function isBoundary(text: string, pos: number): boolean {
  const before = text[pos - 1];
  if (
    before === '/' ||
    before === '\\' ||
    before === '_' ||
    before === '-' ||
    before === '.' ||
    before === ' '
  ) {
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
    if (isMatch && !highlit) {
      out += `<span foreground="${HIGHLIGHT_COLOR}" weight="bold">`;
      highlit = true;
    } else if (!isMatch && highlit) {
      out += '</span>';
      highlit = false;
    }
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
