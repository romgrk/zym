/*
 * SearchBar — the search/replace widget: a compact bar tucked flush into the
 * editor's top-right corner (only its inner, bottom-left corner is rounded),
 * driving a `SearchController`.
 *
 * Layout is one row: the search and replace entries sit as a linked pair (the
 * match count inset at the right end of the search field), with the option
 * toggles beside them.
 *
 * Opened by vim `/` (forward) / `?` (backward). Typing searches incrementally and
 * previews the nearest match; Esc cancels back to where the search started;
 * clicking back into the editor (focus leaves the bar) confirms and leaves the
 * highlights up so `n`/`N` keep working. Keys:
 *   - in search: Enter / Shift+Enter step next / previous
 *   - in replace: Enter replaces the current match, Ctrl+Enter replaces all
 *   - Alt+S cycles the case mode, Alt+R toggles regex (shown in the tooltips)
 */
import Gdk from 'gi:Gdk-4.0';
import Gtk from 'gi:Gtk-4.0';
import type GtkSource from 'gi:GtkSource-5';
type SourceView = InstanceType<typeof GtkSource.View>;
import { zym } from '../../zym.ts';
import { CompositeDisposable } from '../../util/eventKit.ts';
import { addStyles } from '../../styles.ts';
import { theme } from '../../theme/theme.ts';
import { regexSpans, replacementSpans, applySpans } from './regexHighlight.ts';
import type { Point } from '../../text/Point.ts';
import type { CaseMode, SearchController, SearchState } from './SearchController.ts';

/** Callbacks for search-as-motion (`d/foo`): the typed query previews live, and
 *  on confirm the seated match's start is handed back (null = no match / cancel)
 *  with the cursor restored to the origin so the operator derives its range. */
interface MotionSearch {
  onConfirm(matchStart: Point | null): void;
  onCancel(): void;
}

type Overlay = InstanceType<typeof Gtk.Overlay>;

// Floating "elevated surface": use the theme's popover background so it reads as
// a panel over the editor, not part of it.
const POPOVER_BG = theme.ui.surface.popover;

const ENTRY_WIDTH_CHARS = 28; // preferred (natural) width per input — its max-width-chars
const MIN_ENTRY_CHARS = 6; // min width-chars: lets both inputs shrink so the bar fits a narrow editor
// Right-side room reserved inside the search field for the inset count so the
// query text never slides under it (fits the longest label, "Bad pattern", at the
// small font). Kept in sync with the `.search-input` padding-right below.
const COUNT_RESERVE = '6.5em';

// Search history is global (shared across editors/tabs, like vim's), most-recent
// first, deduped, and capped. Recalled in the bar with Ctrl+P / Ctrl+N.
const SEARCH_HISTORY: string[] = [];
const SEARCH_HISTORY_MAX = 100;
function recordSearchHistory(query: string): void {
  if (!query) return;
  const existing = SEARCH_HISTORY.indexOf(query);
  if (existing !== -1) SEARCH_HISTORY.splice(existing, 1);
  SEARCH_HISTORY.unshift(query);
  if (SEARCH_HISTORY.length > SEARCH_HISTORY_MAX) SEARCH_HISTORY.length = SEARCH_HISTORY_MAX;
}

addStyles(`
  .SearchBar {
    background-color: ${POPOVER_BG};
    /* Tucked into the editor's top-right corner: the top + right edges meet the
       editor flush (no border or radius there), while the interior bottom + left
       edges are bordered and the inner (bottom-left) corner is rounded. The shadow
       is aimed down + left, away from the flush edges, so it doesn't bleed past the
       corner onto the surrounding chrome. */
    border: 1px solid var(--border-color);
    border-width: 0 0 1px 1px;
    border-radius: 0 0 0 var(--popover-radius);
    box-shadow: -6px 8px 16px -6px var(--t-ui-shadow);
    padding: 4px;
  }
  .SearchBar entry { min-height: 0; }
  /* The search/replace inputs match the editor's monospace font. */
  .SearchBar entry > text { font: var(--t-font-monospace); }
  /* The match count is inset at the right end of the search field as small,
     dimmed text; the field reserves room on the right so the query never slides
     under it. */
  .SearchBar .search-count { opacity: 0.6; font: var(--t-font-monospace-small); margin-right: 8px; }
  .SearchBar .search-input { padding-right: ${COUNT_RESERVE}; }
  /* No matches: warn in the theme's warning color (full opacity) so an empty
     search reads as a deliberate signal rather than muted chrome — on the inset
     count and, like Adwaita's own .warning entry style, on the search field's
     border + focus outline (Adwaita draws the outline from --accent-color). We
     drive both from our warning token instead of libadwaita's so they match. */
  .SearchBar .search-count.no-results { color: var(--t-ui-status-warning); opacity: 1; }
  .SearchBar entry.no-results {
    box-shadow: inset 0 0 0 1px var(--t-ui-status-warning);
    --accent-color: var(--t-ui-status-warning);
  }
  /* Bad regex: tint the entry text. */
  .SearchBar entry.invalid > text { color: var(--t-ui-status-error); }
  /* Monospace glyphs so the case button's Aa / AA / aa share an advance width —
     otherwise cycling the case mode reflows the (right-pinned) bar. */
  .SearchBar button.toggle { min-width: 0; padding: 2px 6px; font-family: var(--t-font-monospace-family); }
  /* Linked search+replace inputs: square the touching corners and merge the
     shared border so the two entries read as one control. (The search field is
     wrapped in an overlay for the inset count, so target it by class.) */
  .SearchBar .input-group .search-input {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  .SearchBar .input-group > entry:last-child {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    margin-left: -1px;
  }
`);

/** Short button glyph + human label per case mode. */
const CASE: Record<CaseMode, { glyph: string; label: string }> = {
  smart: { glyph: 'Aa', label: 'smart-case' },
  sensitive: { glyph: 'AA', label: 'case-sensitive' },
  insensitive: { glyph: 'aa', label: 'case-insensitive' },
};
const CASE_ORDER: CaseMode[] = ['smart', 'sensitive', 'insensitive'];

export class SearchBar {
  private readonly host: Overlay;
  private readonly controller: SearchController;
  // SearchBar is built per editor and dropped with it; its panel controllers +
  // widget handlers all funnel here so TextEditor.dispose() can sever them (rule 9).
  private readonly disposables = new CompositeDisposable();
  private readonly view: SourceView;

  private readonly panel: InstanceType<typeof Gtk.Box>;
  private readonly inputGroup: InstanceType<typeof Gtk.Box>;
  private readonly searchEntry: InstanceType<typeof Gtk.Entry>;
  private readonly replaceEntry: InstanceType<typeof Gtk.Entry>;
  private readonly countLabel: InstanceType<typeof Gtk.Label>;
  private readonly caseButton: InstanceType<typeof Gtk.Button>;
  private readonly regexToggle: InstanceType<typeof Gtk.ToggleButton>;

  private shown = false;

  // History navigation: `historyIndex` is -1 while showing live (typed) text, or
  // an index into SEARCH_HISTORY while recalling; `historyStash` holds the typed
  // text so stepping back past the newest entry restores it. `applyingHistory`
  // guards the `changed` handler from resetting the index during a recall.
  private historyIndex = -1;
  private historyStash = '';
  private applyingHistory = false;
  // Guards the `changed` handler while we set the entry text programmatically to
  // mirror an already-run search (vim `*`/`#`), so we don't re-search and clobber
  // its result (e.g. drop the whole-word constraint).
  private suppressChange = false;

  constructor(host: Overlay, controller: SearchController, view: SourceView) {
    this.host = host;
    this.controller = controller;
    this.view = view;

    this.searchEntry = this.makeEntry('Search');
    this.searchEntry.addCssClass('search-input'); // carries the inset count + warning outline
    this.disposables.connect(this.searchEntry, 'changed', () => {
      if (this.suppressChange) return; // programmatic mirror of an external search — don't re-run it
      if (!this.applyingHistory) this.historyIndex = -1; // manual edit leaves history recall
      this.render(this.controller.setQuery(this.searchEntry.getText()));
      this.refreshHighlight();
    });
    this.replaceEntry = this.makeEntry('Replace');
    this.disposables.connect(this.replaceEntry, 'changed', () => this.refreshHighlight());

    // Inset at the right end of the search field via an overlay. Pinned to the
    // right edge, vertically centered, and click-through so it never steals a
    // click meant for the entry beneath it.
    this.countLabel = new Gtk.Label({ label: '', xalign: 1 });
    this.countLabel.addCssClass('search-count');
    this.countLabel.setHalign(Gtk.Align.END);
    this.countLabel.setValign(Gtk.Align.CENTER);
    this.countLabel.setCanTarget(false);
    this.caseButton = this.makeCaseButton();
    this.regexToggle = this.toggle('.*', () => this.regexTooltip(), (active) => {
      this.render(this.controller.setOptions({ useRegex: active }));
      this.refreshHighlight();
    });

    // The search field carries the inset count via an overlay; it and the replace
    // entry (both always shown) sit in a linked group so they touch with no
    // border-radius on the shared edge.
    const searchField = new Gtk.Overlay();
    searchField.setChild(this.searchEntry);
    searchField.addOverlay(this.countLabel);
    this.inputGroup = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });
    this.inputGroup.addCssClass('input-group');
    this.inputGroup.append(searchField);
    this.inputGroup.append(this.replaceEntry);

    // The option toggles, joined as one linked segmented control (spacing 0 so
    // their shared borders merge).
    const options = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });
    options.addCssClass('linked');
    options.append(this.caseButton);
    options.append(this.regexToggle);

    // One horizontal row: the input group, then the linked option toggles, with a
    // small gap between the two (the count lives inside the search field).
    this.panel = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    this.panel.addCssClass('SearchBar');
    // Pinned flush to the editor's top-right corner (no margins).
    this.panel.setHalign(Gtk.Align.END);
    this.panel.setValign(Gtk.Align.START);
    this.panel.overflow = Gtk.Overflow.HIDDEN;
    this.panel.append(this.inputGroup);
    this.panel.append(options);
    this.panel.setVisible(false);

    this.installKeys();
    this.installFocusOut();
    this.host.addOverlay(this.panel);
    this.installAdaptiveWidth();
    this.refreshCaseButton();
  }

  /** Keep the bar inside the editor's width. GtkOverlay would otherwise allocate
   *  the panel its full natural width and, pinned right, push its left edge off the
   *  left of a narrow editor (clipping the search field). We cap the panel to the
   *  available width — the inputs then shrink (min → preferred width-chars) — and
   *  keep it flush to the top-right corner. */
  private installAdaptiveWidth(): void {
    this.disposables.connect(this.host, 'get-child-position', (widget: unknown, alloc: InstanceType<typeof Gdk.Rectangle>) => {
      if (widget !== this.panel) return false; // other overlay children keep the default
      const avail = this.host.getWidth();
      if (alloc.width > avail) alloc.width = avail;
      alloc.x = avail - alloc.width; // flush right
      alloc.y = 0; // flush top
      return true;
    });
  }

  // Set while the bar is serving a vim search-motion (`d/foo`) rather than a
  // plain `/` search; routes Enter/Esc/close to the operator instead of n/N.
  private motion: MotionSearch | null = null;

  /** Open the bar as a vim search-motion target: preview live, then on Enter hand
   *  the seated match back to `onConfirm` (Esc → `onCancel`). */
  openMotion(reverse: boolean, search: MotionSearch): void {
    this.motion = search;
    this.open(reverse);
  }

  /** Open the bar (focused) for a forward (`/`) or backward (`?`) search. */
  open(reverse = false): void {
    this.controller.start(reverse);
    this.historyIndex = -1;
    this.shown = true;
    this.panel.setVisible(true);
    this.searchEntry.grabFocus();
    // Sync the entry to the shared "/" register (last confirmed search across
    // all editors) so every editor opens with the same term, like vim.
    if (SEARCH_HISTORY.length > 0) {
      this.suppressChange = true;
      this.searchEntry.setText(SEARCH_HISTORY[0]);
      this.suppressChange = false;
    }
    this.searchEntry.selectRegion(0, -1); // select query so typing replaces it
    this.render(this.controller.setQuery(this.searchEntry.getText()));
    this.refreshHighlight();
  }

  /** Mirror an externally-run search (vim `*`/`#`) into the bar without opening it:
   *  set the entry to `query` so the widget holds the active term like vim's `/`
   *  register (recall it with `/` then Ctrl+P), and record it in the history. The
   *  controller has already run the search — this does not re-search. */
  reflectQuery(query: string): void {
    this.suppressChange = true;
    this.searchEntry.setText(query);
    this.suppressChange = false;
    this.historyIndex = -1;
    this.render(this.controller.state);
    this.refreshHighlight();
    recordSearchHistory(query);
  }

  /** Color regex/replacement syntax in the inputs while in regex mode (else plain). */
  private refreshHighlight(): void {
    const on = this.controller.options.useRegex;
    applySpans(this.searchEntry, this.searchEntry.getText(), on ? regexSpans(this.searchEntry.getText()) : []);
    applySpans(this.replaceEntry, this.replaceEntry.getText(), on ? replacementSpans(this.replaceEntry.getText()) : []);
  }

  private close(cancel: boolean): void {
    if (!this.shown) return;
    this.shown = false;
    if (!cancel) recordSearchHistory(this.searchEntry.getText()); // commit the executed query
    const motion = this.motion;
    this.motion = null;
    this.panel.setVisible(false);
    this.view.grabFocus();
    if (motion) {
      if (cancel) {
        this.controller.cancel(); // restore origin + clear highlights
        motion.onCancel();
      } else {
        // Keep the search active (so n/N work) but return the cursor to the
        // origin; the operator re-derives its range from there.
        const match = this.controller.currentMatch;
        this.controller.restoreOrigin();
        motion.onConfirm(match ? match.start : null);
      }
      return;
    }
    if (cancel) this.controller.cancel();
    else this.controller.confirm();
  }

  /** Whether the bar is currently open (so the editor can keep its active caret). */
  get isOpen(): boolean {
    return this.shown;
  }

  /** Step through the search history: `delta` +1 recalls older, -1 newer. Index
   *  -1 is the live (typed) text, stashed when first stepping back into history. */
  private recallHistory(delta: number): void {
    if (SEARCH_HISTORY.length === 0) return;
    const next = this.historyIndex + delta;
    if (next < -1 || next >= SEARCH_HISTORY.length) return; // clamp at live text / oldest
    if (this.historyIndex === -1) this.historyStash = this.searchEntry.getText();
    this.historyIndex = next;
    const text = next === -1 ? this.historyStash : SEARCH_HISTORY[next];
    this.applyingHistory = true;
    this.searchEntry.setText(text);
    this.searchEntry.setPosition(-1); // caret to end
    this.applyingHistory = false;
  }

  // --- widgets ---------------------------------------------------------------

  private makeEntry(placeholder: string): InstanceType<typeof Gtk.Entry> {
    const entry = new Gtk.Entry({ placeholderText: placeholder });
    entry.addCssClass('has-text-input'); // release the space leader so it types
    // width-chars is the MIN, max-width-chars the natural/preferred: both inputs sit
    // at the preferred width when there's room and shrink together (down to the min)
    // when the editor is too narrow — see installAdaptiveWidth().
    entry.setWidthChars(MIN_ENTRY_CHARS);
    entry.setMaxWidthChars(ENTRY_WIDTH_CHARS);
    return entry;
  }

  private makeCaseButton(): InstanceType<typeof Gtk.Button> {
    const button = new Gtk.Button();
    button.addCssClass('toggle');
    button.addCssClass('raised'); // raised + linked → one segmented control
    button.setCanFocus(false); // keep focus in the entry
    this.disposables.connect(button, 'clicked', () => this.cycleCase());
    return button;
  }

  private cycleCase(): void {
    const next = CASE_ORDER[(CASE_ORDER.indexOf(this.controller.options.caseMode) + 1) % CASE_ORDER.length];
    this.render(this.controller.setOptions({ caseMode: next }));
    this.refreshCaseButton();
  }

  private refreshCaseButton(): void {
    const mode = this.controller.options.caseMode;
    this.caseButton.setLabel(CASE[mode].glyph);
    this.caseButton.setTooltipText(`Case: ${CASE[mode].label} · Alt+S`);
  }

  private regexTooltip(): string {
    return `Regular expression: ${this.regexToggle?.getActive() ? 'on' : 'off'} · Alt+R`;
  }

  private toggle(label: string, tooltip: () => string, onToggle: (active: boolean) => void) {
    const button = new Gtk.ToggleButton({ label });
    button.addCssClass('toggle');
    button.addCssClass('raised'); // raised + linked → one segmented control
    button.setCanFocus(false);
    button.setTooltipText(tooltip());
    this.disposables.connect(button, 'toggled', () => {
      button.setTooltipText(tooltip());
      onToggle(button.getActive());
    });
    return button;
  }

  // --- replace ---------------------------------------------------------------

  private replaceCurrent(): void {
    this.render(this.controller.replaceCurrent(this.replaceEntry.getText()));
  }

  private replaceAll(): void {
    const n = this.controller.replaceAll(this.replaceEntry.getText());
    this.render(this.controller.state);
    zym.notifications.addInfo(`Replaced ${n} ${n === 1 ? 'match' : 'matches'}`);
  }

  // --- behavior --------------------------------------------------------------

  private render(state: SearchState): void {
    this.countLabel.setLabel(countText(state));
    // A non-empty query that compiles but matches nothing warns in amber — on the
    // count label and as a warning outline on the search field; an uncompilable
    // pattern stays the entry's error tint instead.
    const noResults = state.query.length > 0 && !state.invalid && state.count === 0;
    for (const w of [this.countLabel, this.searchEntry]) {
      if (noResults) w.addCssClass('no-results');
      else w.removeCssClass('no-results');
    }
    if (state.invalid) this.searchEntry.addCssClass('invalid');
    else this.searchEntry.removeCssClass('invalid');
  }

  private installKeys(): void {
    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number, _keycode: number, state: number) => {
      const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
      const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
      if (ctrl && (keyval === Gdk.KEY_p || keyval === Gdk.KEY_n)) {
        // Ctrl+P older, Ctrl+N newer — recall the search history.
        if (keyval === Gdk.KEY_p) this.recallHistory(1);
        else this.recallHistory(-1);
        return true;
      }
      if ((state & Gdk.ModifierType.ALT_MASK) !== 0) {
        if (keyval === Gdk.KEY_s) {
          this.cycleCase();
          return true;
        }
        if (keyval === Gdk.KEY_r) {
          this.regexToggle.setActive(!this.regexToggle.getActive());
          return true;
        }
        return false;
      }
      switch (keyval) {
        case Gdk.KEY_Escape:
          // Search-motion: Esc abandons the pending operator. Otherwise keep the
          // cursor on the current match (confirm); only return to the origin when
          // there is no match to settle on.
          this.close(this.motion ? true : this.controller.state.count === 0);
          return true;
        case Gdk.KEY_Return:
        case Gdk.KEY_KP_Enter:
          // Search-motion: Enter confirms the seated match to the operator.
          if (this.motion) this.close(false);
          // Focus lives on the entry's inner GtkText, so test FOCUS_WITHIN —
          // has-focus on the entry itself is always false.
          else if (this.replaceEntry.getStateFlags() & Gtk.StateFlags.FOCUS_WITHIN) {
            if (ctrl) this.replaceAll();
            else this.replaceCurrent();
          }
          else this.render(shift ? this.controller.previous() : this.controller.next());
          return true;
        default:
          return false;
      }
    });
    this.disposables.addController(this.panel, keys);
  }

  /** Sever the panel's key/focus controllers + the entry/button handlers node-gtk
   *  roots. Called from TextEditor.dispose() when the editor (and this bar) drops. */
  dispose(): void {
    this.disposables.dispose();
  }

  private installFocusOut(): void {
    // Clicking back into the editor (focus leaves the bar) confirms at the
    // current match and keeps the highlights up.
    const focus = new Gtk.EventControllerFocus();
    focus.on('leave', () => this.close(false));
    this.disposables.addController(this.panel, focus);
  }
}

function countText(state: SearchState): string {
  if (state.invalid) return 'Bad pattern';
  if (state.query.length === 0) return '';
  if (state.count === 0) return 'No results';
  return `${state.current}/${state.count}`;
}
