/*
 * ProjectSearchView — the project-wide full-text search surface, hosted as a center tab
 * (opened via `project:search-open`, or `project:search-results` seeded with the editor
 * selection).
 *
 * A header carries the search entry plus the ripgrep tuning flags — Match case / Whole word /
 * Regex toggles and "files to include / exclude" glob fields, with a "Hidden" toggle that also
 * searches git-ignored and dotfiles. Editing any of them re-runs the search (the entries are
 * `Gtk.SearchEntry`s, so their `search-changed` is already debounced; the toggles fire at once).
 *
 * Below the header sits the results: a `SearchResultsView` multibuffer (the same editable,
 * per-language-correct, collapsible surface `space *` always used). Each search rebuilds it from
 * scratch — results change wholesale between queries, so a fresh view is simpler and more robust
 * than mutating the projection in place. While there are no results (empty query / no matches /
 * error) a muted status label shows instead. A generation counter drops stale async results when
 * a newer search has started.
 *
 * The host (AppWindow) keys this view by its `root` widget for save-routing and the collapse
 * commands (which act on the inner `results`); it disposes the view when the tab closes.
 */
import { Gtk } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { zym } from '../zym.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import { DocumentRegistry } from './TextEditor/DocumentRegistry.ts';
import { SearchResultsView } from './SearchResultsView.ts';
import {
  runProjectSearch,
  matchesToExcerptInputs,
  DEFAULT_CONTEXT,
  type ProjectSearchOptions,
} from './multibuffer/projectSearch.ts';

export interface ProjectSearchViewOptions {
  cwd: string;
  /** The app's document registry — the inner results are editable (write-through + save). */
  documents: DocumentRegistry;
  /** Seed the search box (e.g. the editor selection); empty opens a blank box. */
  initialQuery?: string;
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
`);

// How long to wait after the last keystroke before re-running ripgrep. Each search rebuilds the
// whole results multibuffer (acquiring + parsing every matched file), so this is deliberately
// generous — it keeps typing responsive rather than searching on every character.
const SEARCH_DEBOUNCE_MS = 300;

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
  private readonly includeEntry: InstanceType<typeof Gtk.Entry>;
  private readonly excludeEntry: InstanceType<typeof Gtk.Entry>;
  private readonly content: InstanceType<typeof Gtk.Box>;
  private readonly status: InstanceType<typeof Gtk.Label>;

  // The current results multibuffer (null while the query is empty / yields nothing).
  private resultsView: SearchResultsView | null = null;
  // Bumped per search; an async rg result whose generation is stale is dropped (debounce race).
  private generation = 0;
  // Pending debounce timer between a keystroke and the search it triggers.
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: ProjectSearchViewOptions) {
    this.cwd = options.cwd;
    this.documents = options.documents;
    this.onActivate = options.onActivate;

    // --- Row 1: the query entry + the case/word/regex toggles.
    this.entry = new Gtk.SearchEntry({ placeholderText: 'Search the project…' });
    this.entry.addCssClass('ProjectSearchEntry');
    this.entry.addCssClass('has-text-input'); // release the `space` leader so it types
    this.entry.setHexpand(true);

    this.caseToggle = this.buildToggle('Aa', 'Match case');
    this.wordToggle = this.buildToggle('W', 'Match whole word');
    this.regexToggle = this.buildToggle('.*', 'Use regular expression');

    const toggles = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4 });
    toggles.addCssClass('project-search-toggles');
    toggles.append(this.caseToggle);
    toggles.append(this.wordToggle);
    toggles.append(this.regexToggle);

    const row1 = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    row1.addCssClass('project-search-row');
    row1.append(this.entry);
    row1.append(toggles);

    // --- Row 2: include / exclude glob fields + the "search hidden & ignored" toggle. Plain
    // Gtk.Entry (not Gtk.SearchEntry) — these are glob filters, not searches, so no search icon.
    this.includeEntry = new Gtk.Entry({ placeholderText: 'Files to include (e.g. *.ts, src/)' });
    this.includeEntry.addCssClass('has-text-input');
    this.includeEntry.setHexpand(true);
    this.excludeEntry = new Gtk.Entry({ placeholderText: 'Files to exclude (e.g. *.test.ts)' });
    this.excludeEntry.addCssClass('has-text-input');
    this.excludeEntry.setHexpand(true);
    this.ignoredToggle = this.buildToggle('Hidden', 'Also search ignored & hidden files');

    const row2 = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    row2.addCssClass('project-search-row');
    row2.append(this.includeEntry);
    row2.append(this.excludeEntry);
    row2.append(this.ignoredToggle);

    const header = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    header.addCssClass('project-search-header');
    header.append(row1);
    header.append(row2);

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
    this.entry.on('changed', () => this.scheduleSearch());
    this.includeEntry.on('changed', () => this.scheduleSearch());
    this.excludeEntry.on('changed', () => this.scheduleSearch());
    for (const t of [this.caseToggle, this.wordToggle, this.regexToggle, this.ignoredToggle]) {
      t.on('toggled', () => this.runSearch());
    }
    if (options.initialQuery) this.runSearch();
  }

  /** Move keyboard focus to the search entry, selecting any seeded text so typing replaces it. */
  focus(): void {
    this.entry.grabFocus();
    this.entry.selectRegion(0, -1);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
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
    button.addCssClass('flat');
    button.setCanFocus(false); // clicking a flag keeps the caret in the entry
    return button;
  }

  private currentOptions(): ProjectSearchOptions {
    return {
      caseSensitive: this.caseToggle.getActive(),
      wholeWord: this.wordToggle.getActive(),
      regex: this.regexToggle.getActive(),
      includeIgnored: this.ignoredToggle.getActive(),
      includeGlobs: splitGlobs(this.includeEntry.getText()),
      excludeGlobs: splitGlobs(this.excludeEntry.getText()),
    };
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

  /** Run ripgrep for the current query + flags and (re)build the results. Stale async results
   *  (a newer search started meanwhile) are dropped via the generation guard. */
  private runSearch(): void {
    if (this.disposed) return;
    if (this.searchTimer) clearTimeout(this.searchTimer); // an immediate run cancels a pending one
    this.searchTimer = null;
    const query = this.entry.getText().trim();
    const generation = ++this.generation;
    if (query === '') {
      this.setStatus('Type to search the project');
      return;
    }
    runProjectSearch(this.cwd, query, this.currentOptions(), (result) => {
      if (this.disposed || generation !== this.generation) return; // superseded
      if (result.error !== undefined) {
        this.setStatus(result.error);
        return;
      }
      const files = result.files ?? [];
      if (files.length === 0) {
        this.setStatus(`No results for “${query}”`);
        return;
      }
      const excerpts = matchesToExcerptInputs(files, { context: DEFAULT_CONTEXT });
      this.swapResults(
        new SearchResultsView({
          excerpts,
          cwd: this.cwd,
          // Editable results: edit in place (write-through + save) and replace across files as
          // undo-coordinated steps, matching the original `space *` behaviour.
          editable: true,
          documents: this.documents,
          onActivate: this.onActivate,
        }),
      );
    });
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

  private registerCommands(): void {
    // The search entry's own key: drop focus from the field into the results, keeping the query
    // (bound to `.ProjectSearchEntry` in the central keymap — Down / Enter).
    this.subs.add(
      zym.commands.add(this.entry, {
        'project-search:focus-results': {
          didDispatch: () => this.resultsView?.focus(),
          description: 'Move from the search box into the results',
        },
      }),
    );
  }
}
