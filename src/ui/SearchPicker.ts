/*
 * Search picker — full-text project search with ripgrep, in a quick-jump picker.
 * Unlike the file picker (which fuzzy-matches paths locally), this is a "remote
 * search" picker: each keystroke re-runs the shared streaming `searchProject`
 * backend (`localFilter: false`, so ripgrep does the matching), and matches are
 * appended to the list as they arrive. The entry row carries case / whole-word /
 * regex option chips (the same `ProjectSearchOptions` the full ProjectSearchView
 * uses); flipping one re-runs the search. Each row is one matching line; choosing
 * it opens the file at that line/column.
 */
import Gtk from 'gi:Gtk-4.0';
import { addStyles } from '../styles.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import { escapeMarkup, HIGHLIGHT_COLOR, type PickerHandle, type PickerItem } from './Picker.ts';
import { openLocationPicker } from './LocationPicker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { searchProject, type ProjectSearchOptions, type RgMatch } from './multibuffer/projectSearch.ts';
import type { ProcHandle } from '../process/runner.ts';
import { Icons } from './icons.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

/** Navigate to a chosen result: absolute path + 0-based `[row, column]` cursor. */
export type SearchTarget = (path: string, cursor: [number, number]) => void;

const MAX_LINE_LENGTH = 500; // crop very long matching lines for display

addStyles(`
  .SearchPickerChips button { min-width: 0; min-height: 0; padding: 2px 8px; }
`);

// A picker item carrying the location to jump to and the match span to accent.
interface SearchItem extends PickerItem {
  /** Absolute path of the matching file. */
  file: string;
  /** 0-based `[row, column]` of the match, for `restoreCursor`. */
  cursor: [number, number];
  /** Char span `[matchStart, matchEnd)` into `text` (post-trim) to highlight. */
  matchStart: number;
  matchEnd: number;
  /** Right-aligned, muted `path:line` location shown after the matched line. */
  detailText: string;
}

/** Map a streamed match to a display item: trim leading indentation (code is usually
 *  indented), shift the highlight span to match, and crop very long lines. */
function toItem(m: RgMatch): SearchItem {
  const span = m.spans[0];
  const startCol = span ? span.startCol : 0;
  const endCol = span ? span.endCol : startCol;
  const leading = m.lineText.length - m.lineText.trimStart().length;
  let display = m.lineText.slice(leading);
  let matchStart = Math.max(0, startCol - leading);
  let matchEnd = Math.max(matchStart, endCol - leading);
  if (display.length > MAX_LINE_LENGTH) {
    display = display.slice(0, MAX_LINE_LENGTH) + '…';
    matchStart = Math.min(matchStart, MAX_LINE_LENGTH);
    matchEnd = Math.min(matchEnd, MAX_LINE_LENGTH);
  }
  return {
    value: m.file,
    text: display,
    file: m.file,
    cursor: [m.row, startCol], // jump to the untrimmed match column
    matchStart,
    matchEnd,
    detailText: `${m.relPath}:${m.row + 1}`,
  };
}

/** A flat option chip: a small toggle that never takes focus (so clicking it keeps
 *  the caret in the entry and the picker open). */
function buildChip(label: string, tooltip: string): InstanceType<typeof Gtk.ToggleButton> {
  const button = new Gtk.ToggleButton({ label });
  button.setTooltipText(tooltip);
  button.addCssClass('flat');
  button.setCanFocus(false);
  return button;
}

export function openSearchPicker(host: Overlay, cwd: string, onSelect: SearchTarget): void {
  const subs = new CompositeDisposable();
  const caseToggle = buildChip('Aa', 'Match case');
  const wordToggle = buildChip('W', 'Match whole word');
  const regexToggle = buildChip('.*', 'Use regular expression');
  const chips = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4 });
  chips.addCssClass('SearchPickerChips');
  for (const chip of [caseToggle, wordToggle, regexToggle]) chips.append(chip);

  const options = (): ProjectSearchOptions => ({
    caseSensitive: caseToggle.getActive(),
    wholeWord: wordToggle.getActive(),
    regex: regexToggle.getActive(),
  });

  let handle: PickerHandle | null = null;
  let search: ProcHandle | null = null;
  // Flipping a flag re-runs the search for the same query.
  for (const chip of [caseToggle, wordToggle, regexToggle]) {
    subs.connect(chip, 'toggled', () => handle?.refetch());
  }

  handle = openLocationPicker({
    host,
    placeholder: 'Search in project…',
    promptIcon: Icons.search, // doubles as the home for the fetch spinner
    localFilter: false, // ripgrep filters server-side; show its results in order
    headerAccessory: chips,
    onClose: () => {
      search?.cancel();
      subs.dispose();
    },
    // Render the matched line with the matched span accented, and the `path:line`
    // location as a muted right-aligned detail.
    renderRow: (item) => {
      const it = item as SearchItem;
      const t = it.text;
      const main =
        escapeMarkup(t.slice(0, it.matchStart)) +
        `<span foreground="${HIGHLIGHT_COLOR}" weight="bold">` +
        escapeMarkup(t.slice(it.matchStart, it.matchEnd)) +
        '</span>' +
        escapeMarkup(t.slice(it.matchEnd));
      return renderRowSingleLine({ main, detail: `<span size="smaller">${escapeMarkup(it.detailText)}</span>` });
    },
    fetch: (query, sink) => {
      search?.cancel(); // stop the in-flight rg before starting a new query/flag run
      const q = query.trim();
      if (q === '') {
        sink.replace([]); // nothing to search for yet
        return;
      }
      search = searchProject(cwd, q, options(), {
        onMatches: (batch) => sink.append(batch.map(toItem)),
        onDone: () => sink.done(),
        onError: (message) => sink.error(message),
      });
    },
    locate: (item) => {
      const it = item as SearchItem;
      // Highlight the matched span in the preview: the match length (preserved
      // across the display trim) from the match's start column.
      const length = it.matchEnd - it.matchStart;
      return { path: it.file, line: it.cursor[0], column: it.cursor[1], endColumn: it.cursor[1] + length };
    },
    onJump: (loc) => onSelect(loc.path, [loc.line, loc.column]),
  });
}
