/*
 * FuzzyPicker — a generic modal "quick open" overlay: a search entry over a
 * fuzzy-filtered, rank-sorted list. Type to narrow, Up/Down (or Tab) to move,
 * Enter to choose, Escape to dismiss.
 *
 * It knows nothing about files; callers supply the candidate strings and an
 * `onSelect` callback. The file picker (see file-picker.ts) is the first user.
 */
import { Gdk, Gtk, type ApplicationWindow } from './gi.ts';

const PICKER_WIDTH = 640;
const PICKER_HEIGHT = 420;
const MAX_RESULTS = 200;

export interface FuzzyPickerOptions {
  parent: ApplicationWindow;
  title?: string;
  placeholder?: string;
  items: string[];
  onSelect: (item: string) => void;
}

export function openFuzzyPicker(options: FuzzyPickerOptions): void {
  const window = new Gtk.Window();
  window.setTitle(options.title ?? 'Pick');
  window.setModal(true);
  window.setTransientFor(options.parent);
  window.setDefaultSize(PICKER_WIDTH, PICKER_HEIGHT);

  const entry = new Gtk.SearchEntry({ placeholderText: options.placeholder ?? 'Search…' });
  entry.setHexpand(true);

  const listBox = new Gtk.ListBox();
  listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);

  const scrolled = new Gtk.ScrolledWindow();
  scrolled.setChild(listBox);
  scrolled.setVexpand(true);

  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
  box.setMarginTop(6);
  box.setMarginBottom(6);
  box.setMarginStart(6);
  box.setMarginEnd(6);
  box.append(entry);
  box.append(scrolled);
  window.setChild(box);

  // The currently displayed matches, parallel to the rows in the list box, so a
  // row can be mapped back to its item by index.
  let results: string[] = [];

  const rebuild = () => {
    let child = listBox.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      listBox.remove(child);
      child = next;
    }
    results = rank(entry.getText(), options.items).slice(0, MAX_RESULTS);
    for (const item of results) {
      const label = new Gtk.Label({ label: item, xalign: 0 });
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
    window.close();
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
        window.close();
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
  window.addController(keys);

  rebuild();
  window.present();
  entry.grabFocus();
}

/**
 * Score `text` against `query` as a fuzzy (subsequence) match. Returns a score
 * where higher is better, or `null` when `query` is not a subsequence of `text`.
 * An empty query matches everything with a neutral score.
 */
export function fuzzyMatch(query: string, text: string): number | null {
  if (query.length === 0) return 0;
  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();

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
    previous = pos;
    from = pos + 1;
  }
  return score - text.length * 0.05;                       // prefer shorter, denser hits
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

function rank(query: string, items: string[]): string[] {
  if (query.length === 0) return items;
  const scored: Array<{ item: string; score: number }> = [];
  for (const item of items) {
    const score = fuzzyMatch(query, item);
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.item);
}
