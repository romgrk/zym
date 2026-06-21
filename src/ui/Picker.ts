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
import { Gtk, Pango } from '../gi.ts';
import { zym } from '../zym.ts';
import { addStyles } from '../styles.ts';
import { iconLabel } from './icons.ts';
import { fuzzyMatch } from './fuzzyMatch.ts';
import { theme } from '../theme/theme.ts';
import { frecency } from '../util/Frecency.ts';
import { enableReadline } from './readline.ts';
import { escapeMarkup } from './proseMarkup.ts';


const PICKER_WIDTH = 640;
const PICKER_MAX_HEIGHT = 360;
const MAX_RESULTS = 200;
// Side-preview layout (opt-in via `options.preview`): the card splits into a
// fixed-width result list on the left and a preview pane on the right. The list
// is kept at least as wide as the preview (≥ 50% of the card).
const PREVIEW_LIST_WIDTH = 520; // result-list column width when a preview is shown
const PREVIEW_PANE_WIDTH = 480; // default preview-pane width
const PREVIEW_DELAY_MS = 60; // debounce before refreshing the preview as the selection moves
// Auto search-debounce: a dataset larger than this re-ranks on a delay (coalesce
// keystrokes when fuzzy-ranking is costly); anything smaller filters instantly.
const LARGE_DATASET = 2000;
const LARGE_DATASET_DELAY_MS = 150; // GtkSearchEntry's own default
// Debounce before re-running a `fetch` source (a remote/`gh` call is costly, so
// coalesce keystrokes); local fuzzy filtering still runs instantly in between.
const FETCH_DELAY_MS = 200;
// Leading prompt slot (px): a fixed-width icon/spinner before the entry text,
// shown for `fetch` pickers (spun while fetching) and any `promptIcon` picker.
// The slot reserves its space even when empty so the spinner never shifts layout.
const PROMPT_INSET = 11; // gap from the entry's left edge to the slot
const PROMPT_SLOT = 16; // the icon/spinner square
const PROMPT_GAP = 5; // gap from the slot to the entry text
// Color of the matched characters. Sourced from the theme's accent foreground
// (Zed's `text.accent`). Baked into Pango markup at row-build time, so it can't
// be a CSS variable (and Pango can't gradient-fill text, so it's a solid color).
export const HIGHLIGHT_COLOR = theme.ui.text.accent;

type Overlay = InstanceType<typeof Gtk.Overlay>;

// libadwaita's `.card` fill (`var(--card-bg-color)`) is semi-transparent — meant to
// sit on a window, not float over editor content. Override it with the opaque
// popover background so the editor doesn't show through.
addStyles(/* css */`
  /* The picker card is monospace; the opt-in .prose-entry overrides to the UI font. */
  #Picker {
    font: var(--t-font-monospace);
    padding: 0;
    border: 1px solid var(--border-color);
    border-radius: var(--popover-radius);
    background-color: var(--window-bg-color);
    box-shadow: 0px 10px 33px 28px var(--t-ui-shadow);
  }
  #PickerEntry.prose-entry,
  #PickerEntry.prose-entry > text { font-family: var(--t-font-ui-family); }
  #PickerEntry {
    padding: 0.5em 0.5em;
    border-radius: var(--popover-radius);
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
  /* Leading prompt slot (icon/spinner) overlaid on the entry's left inset; the
     entry text is pushed right to clear it (reserved even when the slot is
     empty, so toggling the spinner never shifts the text). */
  #PickerPrompt {
    margin-left: ${PROMPT_INSET}px;
  }
  #PickerEntry.has-prompt {
    padding-left: 0;
  }
  #PickerEntry.has-prompt > text {
    padding-left: ${PROMPT_INSET + PROMPT_SLOT + PROMPT_GAP}px;
  }
  #PickerList {
    border-radius: var(--popover-radius);
  }
  /* Drop Adwaita's built-in row padding so only the label's inset applies. */
  #PickerList row {
    padding: 0;
  }
  #PickerRow {
    padding: 0.5em 1em;
  }
  /* When a leading prompt slot is present (a promptIcon / fetch spinner), the
     entry text is inset to clear it. Inset the match rows by the same amount so a
     row's text lines up under the typed query rather than under the icon. */
  #Picker.has-prompt #PickerRow {
    padding-left: ${PROMPT_INSET + PROMPT_SLOT + PROMPT_GAP}px;
  }
  /* Two-column rows (e.g. the file picker): filename on the left, its directory
     right-aligned and muted. Highlights still show through the dimming. */
  #PickerRow > .picker-detail {
    margin-left: 1em;
    opacity: 0.5;
  }
  #PickerEmpty {
    padding: 0.5em 1em;
    opacity: 0.55;
  }
  /* An error from an async source (a failed fetch, or an explicit setError):
     shown in place of the matches, tinted with the theme's error color. */
  #PickerError {
    padding: 0.5em 1em;
    color: var(--t-ui-status-error);
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
  /** When supplied, the action row is hidden if this returns false. */
  visible?: (query: string) => boolean;
}

/**
 * A candidate richer than a bare string. Plain strings are still accepted and
 * normalised to `{ value, text }`; objects let a caller separate the value
 * returned on selection from the text matched against, boost matches in a
 * sub-range (e.g. a filename), and split the display into two columns.
 */
export interface PickerItem {
  /** Passed to `onSelect` when this item is chosen. */
  value: string;
  /** Text matched against the query; highlight positions index into this. */
  text: string;
  /**
   * Char offset in `text` from which matches score higher. The file picker
   * points this at the filename so filename matches outrank directory matches.
   */
  boostFrom?: number;
  /** Optional two-column display (main left, detail right-aligned and muted). */
  display?: PickerItemDisplay;
}

export interface PickerItemDisplay {
  /** Substring range `[start, end)` of `text` shown on the left, highlighted. */
  main: [number, number];
  /** Substring range `[start, end)` shown right-aligned and muted, highlighted. */
  detail: [number, number];
}

export interface PickerOptions {
  host: Overlay;
  placeholder?: string;
  items?: Array<string | PickerItem>;
  /** Initial entry text (e.g. seed an action prompt with the editor selection). */
  query?: string;
  /** Invoked with the chosen item's `value` (and the full item, for callers that
   *  attach extra data to their items). Normally returns nothing and the picker
   *  closes; return a string to instead **navigate in place** — the entry text is
   *  replaced with it and the list re-queried, keeping the picker open (used by the
   *  file opener to descend into a chosen folder). */
  onSelect: (value: string, item: PickerItem) => void | string;
  action?: PickerAction;
  /**
   * Show the `action` row only when the query matches no items (rather than
   * always, alongside matches). Used by the resume picker, which offers "start a
   * new agent with this prompt" as a fallback when nothing matches.
   */
  actionWhenEmpty?: boolean;
  /** Render the search entry in a proportional (sans) font instead of the card's
   *  monospace — for pickers whose query is prose rather than a path/identifier. */
  proseEntry?: boolean;
  /**
   * Async candidate source. Called (debounced by `searchDelay`) whenever the
   * query changes — and once on open — to fetch candidates for the current query
   * (e.g. a `gh`/server search); the results replace the candidate pool. By
   * default this is a "remote search + local refine" picker: local fuzzy
   * filtering still runs on every keystroke over whatever pool is loaded, so
   * typing stays responsive while fresh matches stream in. Set `localFilter:
   * false` when the source already filters server-side and local fzy would fight
   * it (e.g. `gh` search). The `onResult` callback is ignored if the picker has
   * closed or a newer query superseded this call.
   *
   * Report a failure via the `onError` callback (or by throwing synchronously):
   * the picker drops its loading state and shows the message in place of the
   * matches. Like `onResult`, a stale/closed `onError` call is ignored.
   */
  fetch?: (
    query: string,
    onResult: (items: Array<string | PickerItem>) => void,
    onError: (message: string) => void,
  ) => void;
  /**
   * Whether to fuzzy-filter the pool locally as the user types (default true).
   * Set false for a `fetch` source that filters server-side — the list then shows
   * exactly what `fetch` returns, in order, refreshed (debounced) on each query
   * change rather than refined locally in between.
   */
  localFilter?: boolean;
  /**
   * A Nerd Font glyph shown in a leading prompt slot before the entry text (e.g.
   * a GitHub mark for the PR picker). For a `fetch` picker the slot doubles as
   * the loading spinner's home, and the slot is reserved (so the spinner can
   * appear without shifting layout) even when no `promptIcon` is given.
   */
  promptIcon?: string;
  /**
   * Start in a loading state: spin the prompt slot and show a "Loading…" row
   * until content arrives. For a picker that opens immediately and fills in via
   * the handle's `setItems` (which clears loading) — e.g. a one-shot async fetch.
   * `setLoading` on the handle toggles it explicitly.
   */
  loading?: boolean;
  /**
   * Open straight into an error state, showing this message in place of the
   * matches. Lets a caller surface a precondition failure inside the picker
   * itself (e.g. "Not a git repository") instead of bailing with a separate
   * notification. Cleared by `setItems`/a fresh `fetch`, or `setError(null)`.
   */
  error?: string;
  /**
   * Debounce (ms) before a typed query triggers the costly step — re-filtering a
   * local list, or re-running a `fetch` source. Defaults automatically: a
   * `fetch` picker debounces by `FETCH_DELAY_MS`; otherwise it's chosen from the
   * dataset size — instant (`0`) for small lists, a modest debounce for large
   * ones. Set explicitly to override — e.g. `0` to force an always-responsive
   * picker regardless of size. (With `fetch`, local fuzzy filtering is always
   * instant; this only debounces the remote call.)
   */
  searchDelay?: number;
  /**
   * Override the markup of a (non-`display`) row, given the item and its
   * matched-char positions (into `item.text`). Return either a single markup
   * string (the row's only label) or `{ main, detail }` to add a right-aligned,
   * muted detail column. Lets a caller restyle the row — e.g. the command picker
   * mutes a command's `prefix:`, inserts a space, and right-aligns its
   * description. Positions still drive the match highlight.
   */
  formatMain?: (item: PickerItem, positions: number[]) => string | FormattedRow;
  /**
   * Enable frecency ("frequency × recency") ordering under this namespace (e.g.
   * `"file"`). When set, chosen items are recorded on selection, and a modest
   * bonus floats frequently/recently chosen ones up — both in the no-query list
   * and once a query is typed. Off by default; not every picker wants it (the
   * command palette, for one, prefers stable alphabetical ordering).
   */
  frecency?: string;
  /**
   * Lower-level escape hatch: a ranking bonus added to an item's fuzzy score and
   * used to order the no-query list. `frecency` is the usual way to get this;
   * supply `weight` directly only for a custom signal. Takes precedence over
   * `frecency`'s ordering bonus when both are set. Keep it modest (~0–1.5).
   */
  weight?: (item: PickerItem) => number;
  /**
   * Opt-in side preview: when set, the card widens into a horizontal split with
   * the result list on the left and `preview.widget` on the right. The picker
   * stays content-agnostic — it just hosts the widget and calls `preview.update`
   * (debounced) with the selected item, or `null` when nothing's selected,
   * whenever the selection changes. `LocationPicker` uses this to show the
   * selected location's source.
   */
  preview?: PickerPreview;
  /**
   * Suppress the `has-prompt` class on the card (and thus the row indent that
   * aligns row text with the icon-offset entry text). Use when a `promptIcon` is
   * present for the entry but the rows render their own icons via `formatMain` and
   * should keep the standard row padding instead.
   */
  disableIconPadding?: boolean;
}

/** A side-preview pane plus the hook that refreshes it as the selection moves. */
export interface PickerPreview {
  /** Widget shown in the right-hand pane (built and owned by the caller). */
  widget: InstanceType<typeof Gtk.Widget>;
  /** Refresh the pane for the selected item (or clear it when `null`). */
  update: (item: PickerItem | null) => void;
  /** Preview-pane width in px (default `PREVIEW_PANE_WIDTH`). */
  width?: number;
}

/** Markup for a row's main label plus an optional right-aligned detail. */
export interface FormattedRow {
  main: string;
  detail?: string;
  /**
   * Whether the detail is dimmed (the muted `.picker-detail` look). Default true;
   * set false when the caller controls emphasis in the markup itself (e.g. the
   * command palette's bold keybinding column).
   */
  detailMuted?: boolean;
  /**
   * Dim the whole row (e.g. a command the palette shows but that isn't currently
   * applicable). Visual only — the row stays selectable; the caller's `onSelect`
   * decides what choosing it does.
   */
  dim?: boolean;
  /**
   * Make the detail the column that crops, not the main. By default the main label
   * shrinks/ellipsizes and the detail keeps its natural width — right for a short
   * detail (a timestamp, an author). Set this when the detail is a long file path
   * that should yield to the main content (a match line / symbol name): the detail
   * is then width-capped and ellipsized from the *start* (keeping the filename:line
   * tail visible), while the main keeps priority on the row's width.
   */
  cropDetail?: boolean;
}

export interface PickerHandle {
  /** Replace the candidate list (e.g. once an async scan completes). Clears the
   *  loading state. */
  setItems(items: Array<string | PickerItem>): void;
  /** Toggle the loading state (spinner + "Loading…" row) explicitly. */
  setLoading(loading: boolean): void;
  /** Show an error message in place of the matches (e.g. an async load failed),
   *  or clear it by passing `null`. Also clears the loading state. */
  setError(message: string | null): void;
  close(): void;
}

function normalizeItem(item: string | PickerItem): PickerItem {
  return typeof item === 'string' ? { value: item, text: item } : item;
}

// List navigation goes through the app's command/keymap system rather than a
// private key controller: each picker registers `core:*` commands on its panel
// (see `openPicker`), and this once-registered keymap binds the keystrokes to
// them, scoped to `#Picker`. The KeymapManager's capture-phase controller on the
// window sees these before the focused entry, so Down/Up/Tab/Escape drive the
// list instead of moving the entry cursor or walking the focus chain. alt-j/alt-k
// mirror Down/Up for home-row navigation while typing; Tab / shift-tab cycle like
// Down / Up. Enter stays on the entry's `activate` signal (see `openPicker`).
let pickerKeymapRegistered = false;
function registerPickerKeymapOnce(): void {
  if (pickerKeymapRegistered) return;
  pickerKeymapRegistered = true;
  zym.keymaps.add('picker', {
    '#Picker': {
      down: 'core:down',
      KP_Down: 'core:down',
      tab: 'core:down',
      'alt-j': 'core:down',
      up: 'core:up',
      KP_Up: 'core:up',
      'shift-tab': 'core:up',
      'alt-k': 'core:up',
      escape: 'core:cancel',
    },
  });
}

export function openPicker(options: PickerOptions): PickerHandle {
  const { host, frecency: frecencyNs } = options;

  // Effective ranking bonus: an explicit `weight` wins; otherwise derive one
  // from the frecency store when a namespace is configured.
  const weight =
    options.weight ??
    (frecencyNs ? (item: PickerItem) => frecency.boost(frecencyNs, item.value) : undefined);

  const entry = new Gtk.SearchEntry({
    placeholderText: options.placeholder ?? 'Search…',
  });
  entry.setHexpand(true);
  entry.setName('PickerEntry');
  entry.addCssClass('has-text-input'); // release the `space` leader so it types
  if (options.proseEntry) entry.addCssClass('prose-entry');
  // Emacs/readline editing chords (ctrl-a/e, alt-f/b, ctrl-w/u/k, …) on the entry.
  const readlineSub = enableReadline(entry);

  // Leading prompt slot: a fixed-width icon/spinner overlaid on the entry's left
  // inset. Present for `fetch` (async) pickers — which spin it while fetching —
  // any picker with a `promptIcon`, and any picker that starts in a `loading`
  // state. The icon and spinner share one slot and toggle (only one shows at a
  // time); the slot reserves its width regardless, so the spinner appearing never
  // shifts the entry text.
  let entryHost: InstanceType<typeof Gtk.Widget> = entry;
  let promptSpinner: InstanceType<typeof Gtk.Spinner> | null = null;
  let promptGlyph: InstanceType<typeof Gtk.Label> | null = null;
  if (options.fetch || options.promptIcon || options.loading) {
    entry.addCssClass('has-prompt');
    const slot = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    slot.setName('PickerPrompt');
    slot.setHalign(Gtk.Align.START);
    slot.setValign(Gtk.Align.CENTER);
    slot.setSizeRequest(PROMPT_SLOT, PROMPT_SLOT);
    if (options.promptIcon) {
      promptGlyph = iconLabel(options.promptIcon);
      promptGlyph.setHexpand(true);
      promptGlyph.setOpacity(0.7); // muted, like a search-entry's icon
      slot.append(promptGlyph);
    }
    promptSpinner = new Gtk.Spinner();
    promptSpinner.setHexpand(true);
    promptSpinner.setVisible(false);
    slot.append(promptSpinner);
    const overlay = new Gtk.Overlay();
    overlay.setChild(entry);
    overlay.addOverlay(slot);
    entryHost = overlay;
  }
  // Whether async content is still loading: spins the prompt slot (hiding the
  // static glyph) and shows a "Loading…" placeholder row instead of "No entries".
  let isLoading = false;
  const setLoading = (loading: boolean) => {
    isLoading = loading;
    if (!promptSpinner) return;
    promptSpinner.setVisible(loading);
    if (loading) promptSpinner.start();
    else promptSpinner.stop();
    promptGlyph?.setVisible(!loading);
  };
  setLoading(Boolean(options.loading));

  // An error from an async source (failed fetch / explicit setError), or seeded
  // via `options.error` to open straight into a failure state (e.g. "Not a git
  // repository"). When set it replaces the matches with a tinted message row;
  // cleared whenever a fresh fetch or `setItems` brings in new content.
  let error: string | null = options.error ?? null;
  const setError = (message: string | null) => {
    error = message;
    if (message !== null) setLoading(false); // an error supersedes loading
  };

  const listBox = new Gtk.ListBox();
  listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);

  const scrolled = new Gtk.ScrolledWindow();
  scrolled.setChild(listBox);
  scrolled.setPropagateNaturalHeight(true);
  scrolled.setMaxContentHeight(PICKER_MAX_HEIGHT);
  // Never scroll horizontally: rows ellipsize to the card's fixed width instead
  // of widening it / exposing a horizontal scrollbar for long labels.
  scrolled.setPolicy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
  scrolled.setName('PickerList');

  // A floating, opaque "card" placed at the top-centre of the overlay.
  const panel = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
  panel.setName('Picker');
  panel.setHalign(Gtk.Align.CENTER);
  panel.setValign(Gtk.Align.START);
  panel.setMarginTop(48);
  // Mirror the entry's `has-prompt` onto the card so the rows inset to align with
  // the (icon-offset) entry text — see the `#Picker.has-prompt #PickerRow` rule.
  // Skipped when `disableIconPadding` is set: the caller renders its own per-row
  // icons via `formatMain` and wants standard row padding, not the extra indent.
  if (entry.hasCssClass('has-prompt') && !options.disableIconPadding) panel.addCssClass('has-prompt');
  panel.append(entryHost);
  if (options.preview) {
    // Horizontal split: the result list keeps a fixed width, the preview pane
    // takes the rest. Both are bounded to the list's max height so the card has a
    // stable size regardless of how many results (or how long the preview) are.
    const previewWidth = options.preview.width ?? PREVIEW_PANE_WIDTH;
    // Keep the result list at least as wide as the preview (≥ 50% of the card).
    const listWidth = Math.max(PREVIEW_LIST_WIDTH, previewWidth);
    panel.setSizeRequest(listWidth + previewWidth, -1);
    scrolled.setSizeRequest(listWidth, -1);
    options.preview.widget.setSizeRequest(previewWidth, PICKER_MAX_HEIGHT);
    const body = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });
    body.append(scrolled);
    body.append(options.preview.widget);
    panel.append(body);
  } else {
    panel.setSizeRequest(PICKER_WIDTH, -1);
    panel.append(scrolled);
  }
  panel.overflow = Gtk.Overflow.HIDDEN;

  let items = (options.items ?? []).map(normalizeItem);

  // Set the entry's debounce: an explicit `searchDelay` wins; otherwise a `fetch`
  // source debounces the remote call, and a plain local picker picks from the
  // dataset size (instant for small lists, debounced for large ones). Re-run when
  // `setItems` swaps the dataset (e.g. an async scan resolves).
  const applySearchDelay = () => {
    const auto = options.fetch
      ? FETCH_DELAY_MS
      : items.length > LARGE_DATASET
        ? LARGE_DATASET_DELAY_MS
        : 0;
    entry.setSearchDelay(options.searchDelay ?? auto);
  };
  applySearchDelay();

  // The currently displayed matches, parallel to the leading rows in the list
  // box, so a row can be mapped back to its item by index.
  let results: PickerItem[] = [];
  // Pool of match-row containers, always the leading rows of the list box (so
  // `row.getIndex()` maps straight into `results`). Rebuilds reuse these — only
  // each row's *child* widget is swapped — so narrowing the query doesn't churn
  // the whole list; surplus rows beyond the new match count are removed.
  const matchRows: Array<InstanceType<typeof Gtk.ListBoxRow>> = [];
  // The trailing action row, when an action is configured and the entry is
  // non-empty; checked in `choose` to run the action instead of selecting.
  let actionRow: InstanceType<typeof Gtk.ListBoxRow> | null = null;
  // The trailing non-interactive message row (loading / empty / error), if shown.
  let messageRow: InstanceType<typeof Gtk.ListBoxRow> | null = null;
  let closed = false;
  // The picker's `core:*` command bundle, registered on the panel below and torn
  // down here so a dismissed picker leaves no dangling commands.
  let commandsSub: { dispose(): void } | null = null;
  // Pending side-preview refresh (debounced as the selection moves); cleared on close.
  let previewTimer: NodeJS.Timeout | null = null;

  // Remember whatever held focus before the picker grabbed it, so that
  // dismissing without a selection returns focus there (e.g. back to the editor)
  // instead of leaving it stranded on the now-removed overlay.
  const previousFocus = host.getRoot()?.getFocus() ?? null;

  const close = (restoreFocus = true) => {
    if (closed) return;
    closed = true;
    commandsSub?.dispose();
    readlineSub.dispose();
    promptSpinner?.stop();
    if (previewTimer) clearTimeout(previewTimer);
    host.removeOverlay(panel);
    if (restoreFocus) previousFocus?.grabFocus();
  };

  // Refresh the side preview for the currently selected match (debounced, so
  // holding Down doesn't rebuild the preview for every row flown past). Action and
  // message rows have no item, so the preview clears for them.
  const refreshPreview = () => {
    if (!options.preview) return;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewTimer = null;
      const row = listBox.getSelectedRow();
      const index = row ? row.getIndex() : -1;
      const item = index >= 0 && index < results.length ? results[index] : null;
      options.preview!.update(item);
    }, PREVIEW_DELAY_MS);
  };

  // Scroll the list so the selected row is fully visible. The card never takes
  // focus (the entry keeps it), so GtkListBox won't auto-scroll on selection —
  // we nudge the adjustment ourselves. Mirrors CompletionPopup's approach.
  const scrollSelectedIntoView = () => {
    const row = listBox.getSelectedRow();
    const adjustment = scrolled.getVadjustment();
    if (!row || !adjustment) return;
    let rect: any;
    try {
      const result: any = (row as any).computeBounds(listBox);
      rect = Array.isArray(result) ? result[1] : result;
    } catch {
      return;
    }
    if (!rect) return;
    const top = rect.getY();
    const bottom = top + rect.getHeight();
    const viewTop = adjustment.getValue();
    const viewBottom = viewTop + adjustment.getPageSize();
    if (top < viewTop) adjustment.setValue(top);
    else if (bottom > viewBottom) adjustment.setValue(bottom - adjustment.getPageSize());
  };

  // Reconcile the pooled match rows to `ranked`: reuse existing rows (swap only
  // their child widget), append new ones as the list grows, and remove the
  // surplus when it shrinks. Hovering a row selects it (so mouse and keyboard
  // selection agree); the hover handler is wired once when a row is created.
  const syncMatchRows = (ranked: RankedItem[]) => {
    for (let i = 0; i < ranked.length; i++) {
      const child = renderRow(ranked[i].item, ranked[i].positions, options.formatMain);
      if (i < matchRows.length) {
        matchRows[i].setChild(child);
      } else {
        const row = new Gtk.ListBoxRow();
        row.setChild(child);
        const hover = new Gtk.EventControllerMotion();
        hover.on('enter', () => listBox.selectRow(row));
        row.addController(hover);
        listBox.append(row);
        matchRows.push(row);
      }
    }
    while (matchRows.length > ranked.length) {
      const row = matchRows.pop();
      if (row) listBox.remove(row);
    }
  };

  // Append a non-interactive trailing message row (loading / empty / error).
  const showMessage = (text: string, name: string) => {
    const label = new Gtk.Label({ xalign: 0 });
    label.setText(text);
    label.setName(name);
    messageRow = new Gtk.ListBoxRow();
    messageRow.setChild(label);
    messageRow.setActivatable(false);
    messageRow.setSelectable(false);
    listBox.append(messageRow);
  };

  const rebuild = () => {
    // Drop the transient trailing rows; the match rows are reused in place.
    if (actionRow) {
      listBox.remove(actionRow);
      actionRow = null;
    }
    if (messageRow) {
      listBox.remove(messageRow);
      messageRow = null;
    }

    // An async error replaces the whole list with a single non-interactive
    // message row; reset the navigable state so move/choose have nothing to act on.
    if (error !== null) {
      results = [];
      syncMatchRows([]);
      showMessage(error, 'PickerError');
      return;
    }

    const query = entry.getText();
    // Local fuzzy filter, unless the caller filters server-side (`localFilter:
    // false`) — then show the fetched pool as-is, in order, with no highlights.
    const ranked = (
      options.localFilter === false
        ? items.map((item) => ({ item, positions: [] as number[] }))
        : rank(query, items, weight)
    ).slice(0, MAX_RESULTS);
    results = ranked.map((match) => match.item);
    syncMatchRows(ranked);

    // The prompt-driven action sits after the matches; it appears only when the
    // user has typed something for it to act on — and, when `actionWhenEmpty`,
    // only if nothing matched (so it reads as a "nothing found, do this instead").
    if (options.action && query.length > 0 && (!options.actionWhenEmpty || results.length === 0) && (options.action.visible === undefined || options.action.visible(query))) {
      const label = new Gtk.Label({ xalign: 0 });
      label.setText(options.action.label(query));
      label.setName('PickerAction');
      actionRow = new Gtk.ListBoxRow();
      actionRow.setChild(label);
      actionRow.addCssClass('action-row');
      const hover = new Gtk.EventControllerMotion();
      const row = actionRow;
      hover.on('enter', () => listBox.selectRow(row));
      actionRow.addController(hover);
      listBox.append(actionRow);
    }

    if (results.length === 0 && !actionRow) {
      // No rows to select — show a non-interactive message row instead so the
      // card doesn't collapse to just the entry.
      showMessage(isLoading ? 'Loading…' : items.length === 0 ? 'No entries' : 'No matches', 'PickerEmpty');
      return;
    }
    const first = listBox.getRowAtIndex(0);
    if (first) listBox.selectRow(first);
    scrollSelectedIntoView();
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
    const next = options.onSelect(item.value, item);
    // A returned query navigates in place (e.g. descending into a chosen folder):
    // replace the entry text and re-list, keeping the picker open instead of
    // selecting. A `fetch` source is re-run at once so the new directory's
    // contents appear immediately rather than after the search debounce.
    if (typeof next === 'string') {
      entry.setText(next);
      entry.setPosition(-1);
      if (options.fetch) runFetch();
      return;
    }
    if (frecencyNs) frecency.record(frecencyNs, item.value);
    close(false);
  };

  // A `fetch` source re-queries its candidate pool (debounced) as the query
  // changes; a generation counter drops a stale response if a newer query (or a
  // close) superseded it. When refining locally, fuzzy filtering also runs
  // instantly in between (wired to the immediate `changed` signal below).
  let fetchGeneration = 0;
  const runFetch = () => {
    if (!options.fetch) return;
    const generation = ++fetchGeneration;
    setError(null); // a fresh attempt clears a previous failure
    setLoading(true);
    // A stale/closed response (result or error) is dropped; only the latest
    // query's outcome updates the picker.
    const isCurrent = () => !closed && generation === fetchGeneration;
    const fail = (message: string) => {
      if (!isCurrent()) return;
      setError(message);
      rebuild();
    };
    try {
      options.fetch(
        entry.getText(),
        (next) => {
          if (!isCurrent()) return;
          setLoading(false);
          items = next.map(normalizeItem);
          rebuild();
        },
        fail,
      );
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  };

  const move = (delta: number) => {
    // Navigable rows are the matches followed by the optional action row.
    const count = results.length + (actionRow ? 1 : 0);
    if (count === 0) return;
    const selected = listBox.getSelectedRow();
    const current = selected ? selected.getIndex() : -1;
    const next = (current + delta + count) % count;
    const row = listBox.getRowAtIndex(next);
    if (row) {
      listBox.selectRow(row);
      scrollSelectedIntoView();
    }
  };

  if (options.fetch) {
    // Remote-search picker: re-fetch on the debounced signal. When also refining
    // locally, filter the current pool instantly on each keystroke (the immediate
    // `changed` signal); a server-filtered picker skips that and just waits for
    // the fetch.
    if (options.localFilter !== false) entry.on('changed', rebuild);
    entry.on('search-changed', runFetch);
  } else {
    entry.on('search-changed', rebuild);
  }
  entry.on('activate', () => choose(null));
  listBox.on('row-activated', (row) => choose(row));
  // Drive the side preview off selection changes (keyboard move + hover both go
  // through `selectRow`, so this single hook covers them).
  if (options.preview) listBox.on('row-selected', refreshPreview);

  // Drive list navigation through the command/keymap system: register the
  // picker's `core:*` commands on the panel (named `#Picker`, so the keymap from
  // `registerPickerKeymapOnce` resolves Down/Up/Tab/Escape/alt-j/alt-k to them).
  // The KeymapManager's capture-phase controller runs ahead of the focused entry,
  // so these keys move the selection rather than the entry's cursor.
  registerPickerKeymapOnce();
  commandsSub = zym.commands.add(panel, {
    'core:down': () => move(1),
    'core:up': () => move(-1),
    'core:cancel': () => close(),
  });

  // Dismiss when focus moves to another widget in the app (click elsewhere, tab
  // away): close and hand focus back to wherever it came from. `leave` fires only
  // when focus exits the panel *and* its descendants, so moving between the entry
  // and the list rows doesn't trigger it; the entry is focused below, so the first
  // event is an `enter`, never a spurious `leave`. `close()` restores
  // `previousFocus` by default and is idempotent (the focus restore can re-enter).
  //
  // A `leave` also fires when the whole window is deactivated (alt-tabbing to
  // another app), but that must NOT close the picker — it should still be there on
  // return. So defer a tick (let the focus/active state settle) and close only if
  // the window is still active: i.e. focus genuinely moved to another in-app widget
  // rather than the app losing focus entirely (where the focus stays on the entry).
  const focus = new Gtk.EventControllerFocus();
  focus.on('leave', () => {
    setTimeout(() => {
      if (closed) return;
      const root = panel.getRoot() as any;
      const windowActive = root?.isActive?.() ?? true;
      const focused = root?.getFocus?.() ?? null;
      const focusWithin = !!focused && (focused === panel || focused.isAncestor(panel));
      if (windowActive && !focusWithin) close();
    }, 0);
  });
  panel.addController(focus);

  host.addOverlay(panel);
  if (options.query) {
    entry.setText(options.query); // prefill (e.g. a seeded prompt / a full path)
    entry.setPosition(-1); // cursor at the end, ready to keep typing
  }
  rebuild();
  runFetch(); // populate a `fetch` source for the initial (possibly empty) query
  entry.grabFocus();

  return {
    setItems(next: Array<string | PickerItem>) {
      items = next.map(normalizeItem);
      setError(null); // content arrived — clear any prior failure
      setLoading(false); // content arrived
      applySearchDelay(); // dataset size may have crossed the auto threshold
      if (!closed) rebuild();
    },
    setLoading(loading: boolean) {
      setLoading(loading);
      if (!closed) rebuild(); // refresh the placeholder row's text
    },
    setError(message: string | null) {
      setError(message);
      if (!closed) rebuild();
    },
    close,
  };
}

export interface RankedItem {
  item: PickerItem;
  positions: number[];
}

export function rank(
  query: string,
  items: PickerItem[],
  weight?: (item: PickerItem) => number,
): RankedItem[] {
  // No query: keep insertion order, but float weighted (frecent) items up.
  if (query.length === 0) {
    const ranked = items.map((item) => ({ item, positions: [] as number[] }));
    if (weight) ranked.sort((a, b) => weight(b.item) - weight(a.item));
    return ranked;
  }
  const scored: Array<RankedItem & { score: number }> = [];
  for (const item of items) {
    const match = fuzzyMatch(query, item.text, { boostFrom: item.boostFrom, maxTypos: 1 });
    if (match) {
      const score = match.score + (weight ? weight(item) : 0);
      scored.push({ item, positions: match.positions, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Build a row's widget for `item`, highlighting the matched `positions`. A plain
 * item renders as a single highlighted label; a two-column item (e.g. a file)
 * renders its `main` segment on the left and its `detail` segment right-aligned
 * and muted, with highlights mapped into each segment.
 */
function renderRow(
  item: PickerItem,
  positions: number[],
  formatMain?: (item: PickerItem, positions: number[]) => string | FormattedRow,
): InstanceType<typeof Gtk.Widget> {
  if (!item.display) {
    const formatted = formatMain?.(item, positions);
    const mainMarkup =
      (typeof formatted === 'string' ? formatted : formatted?.main) ??
      highlightMarkup(item.text, positions);
    const detailMarkup = typeof formatted === 'object' ? formatted.detail : undefined;

    const dim = typeof formatted === 'object' && formatted.dim === true;

    if (!detailMarkup) {
      const label = new Gtk.Label({ xalign: 0, useMarkup: true });
      label.setMarkup(mainMarkup);
      label.setName('PickerRow');
      // Crop a long label to the card width rather than widening the row.
      label.setHexpand(true);
      label.setEllipsize(Pango.EllipsizeMode.END);
      if (dim) label.setOpacity(0.4);
      return label;
    }

    // Main label on the left, a right-aligned muted detail on the right (reusing
    // the two-column `.picker-detail` styling). The main label expands and
    // ellipsizes so a long label crops to the picker width rather than pushing
    // the detail (e.g. a "5m ago" timestamp) off the edge; the detail keeps its
    // natural width so it always shows in full.
    const cropDetail = typeof formatted === 'object' && formatted.cropDetail === true;

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });
    box.setName('PickerRow');
    const main = new Gtk.Label({ xalign: 0, useMarkup: true });
    main.setMarkup(mainMarkup);
    main.setHexpand(true);
    main.setEllipsize(Pango.EllipsizeMode.END);
    box.append(main);
    const detail = new Gtk.Label({ xalign: 1, useMarkup: true });
    detail.setMarkup(detailMarkup);
    if (cropDetail) {
      // Let the detail shrink so it — not the main — yields when the row is tight:
      // ellipsizing from the start keeps the path's `filename:line` tail visible.
      // (Without an ellipsize the detail can't shrink, so the deficit fell entirely
      // on the main, cropping the match line — exactly backwards.)
      detail.setEllipsize(Pango.EllipsizeMode.START);
    }
    // Dimmed by default; an un-muted detail keeps the spacing but not the opacity
    // (the caller's markup sets its own emphasis).
    if (typeof formatted === 'object' && formatted.detailMuted === false) detail.setMarginStart(16);
    else detail.addCssClass('picker-detail');
    box.append(detail);
    if (dim) box.setOpacity(0.4);
    return box;
  }

  const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });
  box.setName('PickerRow');

  // Main segment (e.g. filename) expands and ellipsizes so a long value crops to
  // the card width rather than pushing the detail off the edge; the detail keeps
  // its natural width and so always shows in full.
  const [ms, me] = item.display.main;
  const main = new Gtk.Label({ xalign: 0, useMarkup: true });
  main.setMarkup(highlightSegment(item.text, ms, me, positions));
  main.setHexpand(true);
  main.setEllipsize(Pango.EllipsizeMode.END);
  box.append(main);

  const [ds, de] = item.display.detail;
  if (de > ds) {
    const detail = new Gtk.Label({ xalign: 1, useMarkup: true });
    detail.setMarkup(highlightSegment(item.text, ds, de, positions));
    detail.setEllipsize(Pango.EllipsizeMode.END);
    detail.addCssClass('picker-detail');
    box.append(detail);
  }
  return box;
}

/** Highlight the `[start, end)` slice of `text`, with positions in `text` coords. */
export function highlightSegment(text: string, start: number, end: number, positions: number[]): string {
  const local = positions.filter((p) => p >= start && p < end).map((p) => p - start);
  return highlightMarkup(text.slice(start, end), local);
}

/** Render `text` as Pango markup with the matched characters highlighted red. */
export function highlightMarkup(text: string, positions: number[]): string {
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

// `escapeMarkup` (Pango metachar escaping) lives in proseMarkup; re-exported here for the
// callers that import it alongside the picker markup helpers.
export { escapeMarkup };
