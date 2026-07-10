/*
 * ProjectSearchView — the project-wide full-text search surface, hosted as a center tab
 * (opened via `project:search-open` / `project:search-open-word`, both seeded with the
 * editor selection when one exists).
 *
 * A header carries the search entry plus the ripgrep tuning flags — Match case / Whole word /
 * Regex toggles and "files to include / exclude" glob fields, with a "Hidden" toggle that also
 * searches git-ignored and dotfiles. Editing any of them re-runs the search (the entries are
 * `Gtk.SearchEntry`s, so their `search-changed` is already debounced; the toggles fire at once).
 *
 * Below the header sits the results: a `SearchResultsView` multibuffer (an editable,
 * per-language-correct, collapsible surface). Each search rebuilds it from
 * scratch — results change wholesale between queries, so a fresh view is simpler and more robust
 * than mutating the projection in place. While there are no results (empty query / no matches /
 * error) a muted status label shows instead. A generation counter drops stale async results when
 * a newer search has started.
 *
 * The host (AppWindow) keys this view by its `root` widget for save-routing and the collapse
 * commands (which act on the inner `results`); it disposes the view when the tab closes.
 */
import Gtk from 'gi:Gtk-4.0';
import { addStyles } from '../styles.ts';
import { zym } from '../zym.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import { DocumentRegistry } from './TextEditor/DocumentRegistry.ts';
import { SearchResultsView } from './SearchResultsView.ts';
import {
  searchProject,
  groupMatches,
  matchesToExcerptInputs,
  DEFAULT_CONTEXT,
  type ProjectSearchOptions,
  type RgMatch,
} from './multibuffer/projectSearch.ts';
import type { ProcHandle } from '../process/runner.ts';
import { projectSearchPresets, saveSearchPreset, type SearchPreset } from '../projectSettings.ts';

export interface ProjectSearchViewOptions {
  cwd: string;
  /** The app's document registry — the inner results are editable (write-through + save). */
  documents: DocumentRegistry;
  /** Seed the search box (e.g. the editor selection); empty opens a blank box. */
  initialQuery?: string;
  /** Seed the search flags / glob filters (e.g. carried from a preset or the picker). */
  initialOptions?: ProjectSearchOptions;
  /** Jump to a file/line when a result row is activated (Enter / double-click). */
  onActivate: (location: { path: string; row: number }) => void;
}

addStyles(`
  .ProjectSearchView .project-search-header {
    padding: calc(2 * var(--t-spacing));
    border-bottom: 1px solid var(--border-color);
  }
  .ProjectSearchView .project-search-row { margin-bottom: var(--t-spacing); }
  .ProjectSearchView .project-search-row:last-child { margin-bottom: 0; }
  .ProjectSearchView .project-search-toggles button {
    min-width: 0;
    min-height: 0;
    padding: 2px 8px;
  }
  .ProjectSearchView .project-search-status { color: var(--t-ui-text-muted); padding: 12px; }
  .ProjectSearchView .project-search-glob { min-width: 16ch; }
  .project-search-save { padding: 6px; }
`);

// How long to wait after the last keystroke before re-running ripgrep. Each search rebuilds the
// whole results multibuffer (acquiring + parsing every matched file), so this is deliberately
// generous — it keeps typing responsive rather than searching on every character.
const SEARCH_DEBOUNCE_MS = 300;

// While a search streams, coalesce match batches into a results refresh at most this often.
const VIEW_UPDATE_MS = 60;

// rg streams matches faster than the editable multibuffer absorbs them, so push at most this many
// new files into the editor per refresh and continue on the next frame. `SearchResultsView` grows
// in place (an O(new) append, not a full re-flow), so this keeps each frame bounded — results fill
// progressively without a single giant synchronous build hanging the loop.
const VIEW_FILES_PER_FLUSH = 20;
// Hard cap on files built into the editable view (rows already cap at MAX_MATCHES) — a broad query
// (e.g. a single letter) isn't a useful editing surface past this, and the cap bounds total cost.
const MAX_VIEW_FILES = 300;

/** Split a comma-separated glob field into trimmed, non-empty patterns. */
function splitGlobs(text: string): string[] {
  return text.split(',').map((g) => g.trim()).filter((g) => g !== '');
}

export class ProjectSearchView {
  readonly root: InstanceType<typeof Gtk.Box>;

  private readonly cwd: string;
  private readonly documents: DocumentRegistry;
  private readonly onActivate: (location: { path: string; row: number }) => void;
  private readonly subs = new CompositeDisposable();

  private readonly entry: InstanceType<typeof Gtk.SearchEntry>;
  private readonly caseToggle: InstanceType<typeof Gtk.ToggleButton>;
  private readonly wordToggle: InstanceType<typeof Gtk.ToggleButton>;
  private readonly regexToggle: InstanceType<typeof Gtk.ToggleButton>;
  private readonly ignoredToggle: InstanceType<typeof Gtk.ToggleButton>;
  private readonly globEntry: InstanceType<typeof Gtk.Entry>;
  private readonly presetDropdown: InstanceType<typeof Gtk.DropDown>;
  private readonly content: InstanceType<typeof Gtk.Box>;
  private readonly status: InstanceType<typeof Gtk.Label>;
  // The presets backing the dropdown rows (parallel to its model, after the leading "Presets"
  // placeholder), so a selection index maps straight to a preset.
  private presetsForModel: SearchPreset[] = [];
  // While applying an option set (a preset / seed), suppress the per-control search handlers so
  // we run one search at the end instead of one per changed control.
  private applyingOptions = false;
  // Handlers for the (rebuilt-on-open) save-preset popover; cleared each open.
  private presetSubs = new CompositeDisposable();

  // The current results multibuffer (null while the query is empty / yields nothing).
  private resultsView: SearchResultsView | null = null;
  // Bumped per search; a stale streaming callback (a newer search started) is dropped.
  private generation = 0;
  // Pending debounce timer between a keystroke and the search it triggers.
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  // The in-flight streaming search, cancelled when a new one starts or on dispose.
  private searchHandle: ProcHandle | null = null;
  // Matches accumulated so far for the current search, regrouped into excerpts on each refresh.
  private matches: RgMatch[] = [];
  // How many matched files are currently built into the results (the streamed prefix already shown).
  private appliedFileCount = 0;
  // Pending coalesced results refresh (see VIEW_UPDATE_MS).
  private viewUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFocusFirstMatch = false;
  private disposed = false;

  constructor(options: ProjectSearchViewOptions) {
    this.cwd = options.cwd;
    this.documents = options.documents;
    this.onActivate = options.onActivate;

    // --- One options row: query entry, flag toggles, a single glob field, and the presets combo.
    this.entry = new Gtk.SearchEntry({ placeholderText: 'Search the project…' });
    this.entry.addCssClass('ProjectSearchEntry');
    this.entry.addCssClass('has-text-input'); // release the `space` leader so it types
    this.entry.setHexpand(true);

    this.caseToggle = this.buildToggle('Aa', 'Match case');
    this.wordToggle = this.buildToggle('W', 'Match whole word');
    this.regexToggle = this.buildToggle('.*', 'Use regular expression');
    this.ignoredToggle = this.buildToggle('Hidden', 'Also search ignored & hidden files');

    // `.linked` joins the toggles into one segmented group; `.raised` keeps them lifted (not flat).
    const toggles = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });
    toggles.addCssClass('project-search-toggles');
    toggles.addCssClass('linked');
    toggles.addCssClass('raised');
    toggles.append(this.caseToggle);
    toggles.append(this.wordToggle);
    toggles.append(this.regexToggle);
    toggles.append(this.ignoredToggle);

    // One glob field: comma-separated globs, a `!` prefix excludes (e.g. `*.ts, !*.test.ts`).
    this.globEntry = new Gtk.Entry({ placeholderText: 'Files: *.ts, !*.test.ts' });
    this.globEntry.addCssClass('has-text-input');
    this.globEntry.addCssClass('project-search-glob');

    // Presets combo: a leading "Presets" placeholder, the presets, then a "Save current as…" row.
    this.presetDropdown = Gtk.DropDown.newFromStrings(['Presets']);
    this.presetDropdown.setTooltipText('Apply or save a search preset');
    this.rebuildPresetModel();
    this.subs.connect(this.presetDropdown, 'notify::selected', () => this.onPresetSelected());

    const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    row.addCssClass('project-search-row');
    row.append(this.entry);
    row.append(toggles);
    row.append(this.globEntry);
    row.append(this.presetDropdown);

    const header = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    header.addCssClass('project-search-header');
    header.append(row);

    // --- Body: the results multibuffer (swapped in per search) over a muted status label.
    this.status = new Gtk.Label({ label: 'Type to search the project', xalign: 0, yalign: 0 });
    this.status.addCssClass('project-search-status');
    this.content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.content.setVexpand(true);
    this.content.append(this.status);

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.addCssClass('ProjectSearchView');
    this.root.append(header);
    this.root.append(this.content);

    this.registerCommands();

    // Seed before wiring the change handlers so the seed doesn't fire one — we search once,
    // immediately, below. Typing then re-searches on a debounce; toggling a flag is a deliberate
    // action, so it searches at once.
    if (options.initialQuery) this.entry.setText(options.initialQuery);
    if (options.initialOptions) this.applyOptions(options.initialOptions);
    this.subs.connect(this.entry, 'changed', () => this.scheduleSearch());
    this.subs.connect(this.globEntry, 'changed', () => { if (!this.applyingOptions) this.scheduleSearch(); });
    for (const t of [this.caseToggle, this.wordToggle, this.regexToggle, this.ignoredToggle]) {
      this.subs.connect(t, 'toggled', () => { if (!this.applyingOptions) this.runSearch(); });
    }
    if (options.initialQuery) this.runSearch();
  }

  /** Move keyboard focus to the search entry, selecting any seeded text so typing replaces it. */
  focus(): void {
    this.entry.grabFocus();
    this.entry.selectRegion(0, -1);
  }

  focusSearch(): void {
    this.entry.grabFocus();
    this.entry.setPosition(-1); // caret at end, clears the focus-grab selection ("without changing it")
  }

  focusFirstMatch(): void {
    if (this.resultsView?.focusFirstMatch()) return;
    this.pendingFocusFirstMatch = true;
    this.entry.grabFocus(); // a focus home until results arrive (and where focus stays on no matches)
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    if (this.viewUpdateTimer) clearTimeout(this.viewUpdateTimer);
    this.viewUpdateTimer = null;
    this.searchHandle?.cancel();
    this.searchHandle = null;
    this.presetSubs.dispose();
    this.subs.dispose();
    this.resultsView?.dispose();
    this.resultsView = null;
  }

  /** The active results multibuffer, for the host's save-routing + collapse commands. */
  get results(): SearchResultsView | null {
    return this.resultsView;
  }

  /** Save every file the results surface edited (editable multibuffer). */
  save(): void {
    this.resultsView?.save();
  }

  /** Whether the results surface has unsaved edits. */
  isModified(): boolean {
    return this.resultsView?.isModified() ?? false;
  }

  // --- search ------------------------------------------------------------------

  private buildToggle(label: string, tooltip: string): InstanceType<typeof Gtk.ToggleButton> {
    const button = new Gtk.ToggleButton({ label });
    button.setTooltipText(tooltip);
    button.setCanFocus(false); // clicking a flag keeps the caret in the entry
    return button;
  }

  private currentOptions(): ProjectSearchOptions {
    return {
      caseSensitive: this.caseToggle.getActive(),
      wholeWord: this.wordToggle.getActive(),
      regex: this.regexToggle.getActive(),
      includeIgnored: this.ignoredToggle.getActive(),
      globs: splitGlobs(this.globEntry.getText()),
    };
  }

  /** Seed the header controls from `options` (a preset / the initial flags + globs). Wrapped in the
   *  `applyingOptions` guard so the per-control handlers don't each fire a search. */
  private applyOptions(options: ProjectSearchOptions): void {
    this.applyingOptions = true;
    try {
      this.caseToggle.setActive(!!options.caseSensitive);
      this.wordToggle.setActive(!!options.wholeWord);
      this.regexToggle.setActive(!!options.regex);
      this.ignoredToggle.setActive(!!options.includeIgnored);
      this.globEntry.setText(options.globs?.join(', ') ?? '');
    } finally {
      this.applyingOptions = false;
    }
  }

  /** The current options with default (falsy / empty) fields dropped — a compact preset to store. */
  private compactOptions(): ProjectSearchOptions {
    const o = this.currentOptions();
    const out: ProjectSearchOptions = {};
    if (o.caseSensitive) out.caseSensitive = true;
    if (o.wholeWord) out.wholeWord = true;
    if (o.regex) out.regex = true;
    if (o.includeIgnored) out.includeIgnored = true;
    if (o.globs?.length) out.globs = o.globs;
    return out;
  }

  // --- presets combo ---------------------------------------------------------

  /** Rebuild the dropdown rows: a "Presets" placeholder, the presets, then "Save current as…". */
  private rebuildPresetModel(): void {
    this.presetsForModel = projectSearchPresets(this.cwd);
    const labels = ['Presets', ...this.presetsForModel.map((p) => p.name), 'Save current as…'];
    this.presetDropdown.setModel(Gtk.StringList.new(labels));
    this.presetDropdown.setSelected(0);
  }

  /** Act on a dropdown choice: apply a preset's options, or open the save prompt; then snap back to
   *  the "Presets" placeholder. */
  private onPresetSelected(): void {
    const i = this.presetDropdown.getSelected();
    if (i <= 0) return; // the placeholder
    if (i <= this.presetsForModel.length) {
      const preset = this.presetsForModel[i - 1];
      this.presetDropdown.setSelected(0);
      this.applyOptions(preset.options);
      this.runSearch();
    } else {
      this.presetDropdown.setSelected(0); // the "Save current as…" row
      this.openSavePresetPopover();
    }
  }

  /** A small popover anchored to the combo: type a name to save the current options as a preset. */
  private openSavePresetPopover(): void {
    this.presetSubs.dispose();
    this.presetSubs = new CompositeDisposable();
    const popover = new Gtk.Popover();
    popover.setParent(this.presetDropdown);
    this.presetSubs.defer(() => popover.unparent());
    const entry = new Gtk.Entry({ placeholderText: 'Preset name…' });
    entry.addCssClass('has-text-input');
    entry.addCssClass('project-search-save');
    this.presetSubs.connect(entry, 'activate', () => {
      const name = entry.getText().trim();
      if (name !== '') {
        saveSearchPreset(this.cwd, { name, options: this.compactOptions() });
        this.rebuildPresetModel();
      }
      popover.popdown();
    });
    popover.setChild(entry);
    popover.popup();
    entry.grabFocus();
  }

  /** Re-run the search once the user pauses typing (debounced). Replaces any pending timer, so
   *  only the last keystroke in a burst triggers a search. */
  private scheduleSearch(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    // setTimeout fires under the GLib main loop (libuv is pumped each iteration); a microtask
    // would not — see docs/text-editor/multibuffer.md "Scheduling re-flow under the GLib loop".
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.runSearch();
    }, SEARCH_DEBOUNCE_MS);
  }

  /** Stream ripgrep for the current query + flags, growing the results as matches arrive. The
   *  previous search's rg is cancelled; stale streaming callbacks are dropped via the generation
   *  guard. */
  private runSearch(): void {
    if (this.disposed) return;
    if (this.searchTimer) clearTimeout(this.searchTimer); // an immediate run cancels a pending one
    this.searchTimer = null;
    this.searchHandle?.cancel(); // stop the in-flight rg before starting a new run
    if (this.viewUpdateTimer) { clearTimeout(this.viewUpdateTimer); this.viewUpdateTimer = null; }
    this.matches = [];
    this.appliedFileCount = 0;
    this.pendingFocusFirstMatch = false; // a fresh run drops any arming from a superseded query
    const query = this.entry.getText().trim();
    const generation = ++this.generation;
    if (query === '') {
      this.setStatus('Type to search the project');
      return;
    }
    this.searchHandle = searchProject(this.cwd, query, this.currentOptions(), {
      onMatches: (batch) => {
        if (this.disposed || generation !== this.generation) return; // superseded
        this.matches.push(...batch);
        this.scheduleViewUpdate();
      },
      onDone: () => {
        if (this.disposed || generation !== this.generation) return;
        this.flushViewUpdate(); // build any remaining files (continues frame by frame)
        if (this.matches.length === 0) this.setStatus(`No results for “${query}”`);
      },
      onError: (message) => {
        if (this.disposed || generation !== this.generation) return;
        this.setStatus(message);
      },
    });
  }

  /** Coalesce streamed batches into a results refresh (see VIEW_UPDATE_MS). */
  private scheduleViewUpdate(): void {
    if (this.viewUpdateTimer !== null) return;
    this.viewUpdateTimer = setTimeout(() => {
      this.viewUpdateTimer = null;
      this.flushViewUpdate();
    }, VIEW_UPDATE_MS);
  }

  /** Grow (or create) the results surface, adding at most `VIEW_FILES_PER_FLUSH` more files per
   *  call and scheduling another frame while files remain. Files stream in first-seen order, so the
   *  shown prefix only grows; `SearchResultsView` appends the new rows in place (O(new)), keeping
   *  the caret / edits / scroll. */
  private flushViewUpdate(): void {
    if (this.viewUpdateTimer) { clearTimeout(this.viewUpdateTimer); this.viewUpdateTimer = null; }
    if (this.disposed || this.matches.length === 0) return;
    const files = groupMatches(this.matches);
    const cap = Math.min(files.length, MAX_VIEW_FILES);
    const target = Math.min(cap, this.appliedFileCount + VIEW_FILES_PER_FLUSH);
    if (target <= this.appliedFileCount && this.resultsView) return; // nothing new to add
    const excerpts = matchesToExcerptInputs(files.slice(0, target), { context: DEFAULT_CONTEXT });
    if (this.resultsView) {
      this.resultsView.setExcerpts(excerpts); // grow in place — keeps caret / edits / scroll
    } else {
      this.swapResults(
        new SearchResultsView({
          excerpts,
          cwd: this.cwd,
          // Editable results: edit in place (write-through + save) and replace across files as
          // undo-coordinated steps.
          editable: true,
          documents: this.documents,
          onActivate: this.onActivate,
        }),
      );
    }
    this.appliedFileCount = target;
    if (this.pendingFocusFirstMatch && this.resultsView?.focusFirstMatch()) this.pendingFocusFirstMatch = false;
    if (target < cap) this.scheduleViewUpdate(); // more files pending — continue next frame
  }

  /** Replace the body with `view` (disposing the previous results), or with the status label
   *  when `view` is null. */
  private swapResults(view: SearchResultsView | null): void {
    if (this.resultsView) {
      this.content.remove(this.resultsView.root);
      this.resultsView.dispose();
      this.resultsView = null;
    }
    if (view) {
      this.resultsView = view;
      this.status.setVisible(false);
      view.root.setVexpand(true); // fill the body beneath the header
      this.content.append(view.root);
    } else {
      this.status.setVisible(true);
    }
  }

  /** Show a muted status message in place of any results. */
  private setStatus(text: string): void {
    this.swapResults(null);
    this.status.setText(text);
  }

  private submitSearch(): void {
    if (this.searchTimer) {
      this.runSearch(); // commit immediately instead of waiting out the debounce
      this.pendingFocusFirstMatch = true; // land on THIS query's first match once it flushes
    } else {
      this.focusFirstMatch();
    }
  }

  private registerCommands(): void {
    // The search entry's own keys (bound to `.ProjectSearchEntry` in the central keymap): Down drops
    // focus into the results (keeping the query); Enter submits — commit + land on the first match.
    this.subs.add(
      zym.commands.add(this.entry, {
        'project-search:focus-results': {
          didDispatch: () => this.resultsView?.focus(),
          description: 'Move from the search box into the results',
        },
        'project-search:submit': {
          didDispatch: () => this.submitSearch(),
          description: 'Search now and jump to the first match',
        },
      }),
    );
    this.subs.add(
      zym.commands.add(this.root, {
        'project-search:focus-search': {
          didDispatch: () => this.focusSearch(),
          description: 'Focus the search box (keep the current query)',
        },
      }),
    );
  }
}
