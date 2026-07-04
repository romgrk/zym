/*
 * GitLogView — a keyboard-navigable git history viewer, hosted as a single center
 * tab (opened via the `git:log` command).
 *
 * The whole viewer fits in one tab: a horizontal `Gtk.Paned` splits a commit list
 * (left) from the selected commit's read-only diff (right) — no side-split panel.
 * The left column carries a header (branch + upstream ref / ahead-behind / HEAD sha)
 * over a search field over a plain list of recent commits, newest first. Each commit
 * row shows its subject over an "author · date · sha" detail line, in the monospace
 * font. Navigation follows the project's vim-style list convention — j/k move, g g/G
 * jump to the ends — and moving the selection live-previews that commit's diff in the
 * right pane (debounced); o/Enter (or l) loads it and moves focus into the diff.
 *
 * The diff is built by `buildCommitDiffView` (shared with `git:diff-commit`) and
 * embedded directly, so this view owns its lifecycle (disposed on swap + on close).
 * Because the diff is a vim `TextEditor` whose normal-mode `escape` is taken, leaving
 * it back to the list needs a dedicated key: `ctrl-w h` (the commit list sits to the
 * left) → `git-log:focus-list`, scoped to `.GitLogView .TextEditor` so it only binds
 * inside this viewer. The command is registered on the view root, reachable from both
 * the search field and the embedded diff.
 *
 * The search field filters live, using the picker's fzy matcher (no highlighting):
 * `file:x` matches a changed path, `author:y` matches the author, and any bare word
 * matches the subject; all terms must match (AND). To keep the bare list keys (j/k/…)
 * from typing into the search field, those bindings are scoped to the list widget
 * (`.GitLogList`) rather than the whole view, so they only fire while the list — not
 * the entry — holds focus. `/` jumps to the search; Enter/Down/Escape return to the
 * list. The assembled widget is exposed via `root`.
 */
import Pango from 'gi:Pango-1.0';
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import { addStyles } from '../../styles.ts';
import { ICON_FONT_FAMILY, fonts } from '../../fonts.ts';
import { zym } from '../../zym.ts';
import { CompositeDisposable } from '../../util/eventKit.ts';
import { escapeMarkup } from '../pickerHighlight.ts';
import { fuzzyMatch } from '../fuzzyMatch.ts';
import { humanReadableTime } from '../../util/humanReadableTime.ts';
import { Icons } from '../icons.ts';
import { clipboard } from '../TextEditor/vim/clipboard.ts';
import { buildCommitDiffView } from '../diffViews.ts';
import { type DiffView } from '../DiffView.ts';
import {
  repoRoot,
  listCommits,
  listCommitFiles,
  upstreamRef,
  type GitRepo,
  type CommitSummary,
  type CommitRef,
} from '../../git.ts';

export interface GitLogViewOptions {
  cwd: string;
  git: GitRepo;
}

// How many recent commits to list (newest first) — matches the commit picker's depth.
const COMMIT_LIMIT = 200;

// The selected commit's diff is rebuilt when the selection settles, not on every j/k
// during a fast scroll — building a DiffView spins up a whole editor, so debounce it.
const PREVIEW_DEBOUNCE_MS = 90;

// Default divider position: a commit list wide enough for the "author · date · sha"
// detail line, leaving the rest of the tab for the diff.
const LIST_WIDTH = 380;

// A parsed search query: `file:`/`author:` filters plus bare words (matched against
// the subject). Empty across the board means "show everything".
interface Filters {
  file: string[];
  author: string[];
  words: string[];
}

// The header padding, search-field margin, and commit-row padding share the same
// base inset (2× the spacing token) so the chrome lines up.
addStyles(`
  .GitLogView .gitlog-header {
    padding: calc(2 * var(--t-spacing));
    border-bottom: 1px solid var(--border-color);
  }
  .GitLogView .gitlog-branch { font-weight: bold; }
  .GitLogView .gitlog-branch-icon { opacity: var(--dim-opacity); }
  .GitLogView .gitlog-details { opacity: var(--dim-opacity); }
  .GitLogView .gitlog-search-box {
    padding: calc(2 * var(--t-spacing));
    border-bottom: 1px solid var(--border-color);
  }
  .GitLogView .gitlog-empty { opacity: var(--dim-opacity); padding: 12px; }
  .GitLogList row {
    padding: calc(2 * var(--t-spacing));
    border-bottom: 1px solid var(--border-color);
  }
  .GitLogView .gitlog-subject { color: var(--view-fg-color); }
  /* Row gaps (the box itself has no spacing): subject → meta is half a spacing unit,
     meta → badges a full one. */
  .GitLogView .gitlog-meta { opacity: var(--dim-opacity); margin-top: calc(0.5 * var(--t-spacing)); }
  .GitLogView .gitlog-refs { margin-top: var(--t-spacing); }
  /* Ref badges: *other* branches/tags pointing at a commit (the current branch is
     not shown), on their own row under the meta line. A faint tint + matching border
     per kind, all from libadwaita's OS-following status colors: local branches read as
     accent, remote-tracking branches as warning, tags as success. */
  .GitLogView .gitlog-ref {
    font-size: var(--t-font-ui-size-small);
    padding: 0 6px;
    border-radius: 6px;
    border: 1px solid transparent;
  }
  .GitLogView .gitlog-ref-branch {
    color: var(--accent-color);
    background-color: alpha(var(--accent-color), 0.12);
    border-color: alpha(var(--accent-color), 0.4);
  }
  .GitLogView .gitlog-ref-remote {
    color: var(--warning-color);
    background-color: alpha(var(--warning-color), 0.12);
    border-color: alpha(var(--warning-color), 0.4);
  }
  .GitLogView .gitlog-ref-tag {
    color: var(--success-color);
    background-color: alpha(var(--success-color), 0.12);
    border-color: alpha(var(--success-color), 0.4);
  }
  /* Selected row: the shared row selection highlight — a neutral wash when the list is
     unfocused, an accent tint only while the list itself holds focus. Scoped to the
     list (not the whole view) so focusing the diff pane doesn't accent the row. */
  .GitLogList row:selected { background-color: var(--selection-bg); }
  .GitLogList:focus-within row:selected { background-color: var(--selection-bg-focus); }
  /* Right pane: the embedded diff (or a placeholder while nothing is selected). */
  .GitLogView .gitlog-diff-placeholder { opacity: var(--dim-opacity); padding: 12px; }
`);

// Badge order within a row: local branches first, then tags, then remote-tracking
// branches (the least important to see at a glance). The current branch / HEAD is
// filtered out before this. `Array.sort` is stable, so equal-rank refs keep git's
// `%D` order.
const REF_RANK: Record<CommitRef['kind'], number> = { head: 0, branch: 1, tag: 2, remote: 3 };
function orderRefs(refs: CommitRef[]): CommitRef[] {
  return [...refs].sort((a, b) => REF_RANK[a.kind] - REF_RANK[b.kind]);
}

export class GitLogView {
  readonly root: InstanceType<typeof Gtk.Paned>;

  private readonly git: GitRepo;
  private readonly cwd: string;
  private readonly repo: string | null;
  private readonly subs = new CompositeDisposable();

  private readonly branchLabel: InstanceType<typeof Gtk.Label>;
  private readonly detailsLabel: InstanceType<typeof Gtk.Label>;
  private readonly search: InstanceType<typeof Gtk.SearchEntry>;
  private readonly searchBox: InstanceType<typeof Gtk.Box>;
  private readonly listBox: InstanceType<typeof Gtk.ListBox>;
  private readonly scrolled: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly empty: InstanceType<typeof Gtk.Label>;
  private readonly diffPane: InstanceType<typeof Gtk.Box>; // right pane: holds the diff or placeholder

  private commits: CommitSummary[] = []; // all loaded commits (newest first)
  private filtered: CommitSummary[] = []; // those currently shown (after the search filter)
  private filesBySha = new Map<string, string[]>(); // sha → changed paths, for `file:` filtering

  // Embedded diff state: the live DiffView in the right pane, the sha it shows (so a
  // re-select of the same commit is a no-op), the build generation (drops a stale async
  // build superseded by a newer selection), and the preview debounce timer.
  private diff: DiffView | null = null;
  private diffSha: string | null = null;
  private buildGen = 0;
  private previewTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(options: GitLogViewOptions) {
    this.git = options.git;
    this.cwd = options.cwd;
    this.repo = repoRoot(options.cwd);

    // --- Header: branch (with icon) over its details (upstream / ahead-behind / HEAD).
    const branchIcon = new Gtk.Label();
    branchIcon.addCssClass('gitlog-branch-icon');
    branchIcon.setMarkup(`<span face="${ICON_FONT_FAMILY}">${Icons.git}</span>`);

    this.branchLabel = new Gtk.Label({ xalign: 0 });
    this.branchLabel.addCssClass('gitlog-branch');
    this.branchLabel.setEllipsize(Pango.EllipsizeMode.END);

    const branchRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    branchRow.append(branchIcon);
    branchRow.append(this.branchLabel);

    this.detailsLabel = new Gtk.Label({ xalign: 0 });
    this.detailsLabel.addCssClass('gitlog-details');

    const header = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
    header.addCssClass('gitlog-header');
    header.append(branchRow);
    header.append(this.detailsLabel);

    // --- Search field (between header and body): live `file:`/`author:`/word filter,
    // wrapped in a padded, bottom-bordered box that sets it off from the list.
    this.search = new Gtk.SearchEntry({ placeholderText: 'file:path author:name search…' });
    this.search.addCssClass('GitLogSearch');
    this.search.addCssClass('has-text-input'); // release the `space` leader so it types
    this.subs.connect(this.search, 'search-changed', () => this.applyFilter());

    this.searchBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.searchBox.addCssClass('gitlog-search-box');
    this.searchBox.append(this.search);

    // --- Body: a plain list of commits.
    this.listBox = new Gtk.ListBox();
    this.listBox.addCssClass('GitLogList');
    this.listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);
    this.subs.connect(this.listBox, 'row-activated', (row: any) => this.activate(row.getIndex()));

    this.scrolled = new Gtk.ScrolledWindow();
    this.scrolled.setChild(this.listBox);
    this.scrolled.setVexpand(true);
    this.scrolled.setPolicy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC); // never scroll sideways — rows ellipsize

    this.empty = new Gtk.Label({ label: 'No commits', xalign: 0 });
    this.empty.addCssClass('gitlog-empty');
    this.empty.setVisible(false);

    // --- Left column: header / search / list, stacked. Its own box so the Paned can
    // hold it whole (the Paned's own handle separates it from the diff).
    const listColumn = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    listColumn.addCssClass('gitlog-list-column');
    listColumn.append(header);
    listColumn.append(this.searchBox);
    listColumn.append(this.scrolled);
    listColumn.append(this.empty);

    // --- Right pane: the selected commit's diff, swapped in place; a placeholder until
    // one is selected (or when a commit touched no files).
    this.diffPane = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true });
    this.showDiffPlaceholder('Select a commit to view its diff');

    // --- One tab, split: list | diff. The list keeps its width on window resize; the
    // diff absorbs the extra space. Neither child collapses to nothing.
    this.root = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
    this.root.addCssClass('GitLogView');
    this.root.setStartChild(listColumn);
    this.root.setEndChild(this.diffPane);
    this.root.setPosition(LIST_WIDTH);
    this.root.setResizeStartChild(false);
    this.root.setShrinkStartChild(false);
    this.root.setShrinkEndChild(false);

    this.registerCommands();
    this.renderHeader();
    this.load();
  }

  /** Move keyboard focus into the list, selecting (and previewing) the first commit if
   *  none is yet. The `ctrl-w h` / `git-log:focus-list` target — the way back out of the
   *  embedded diff editor. */
  focus(): void {
    if (!this.listBox.getSelectedRow() && this.filtered.length) {
      const first = this.listBox.getRowAtIndex(0);
      if (first) { this.listBox.selectRow(first); this.schedulePreview(); }
    }
    (this.listBox.getSelectedRow() ?? this.listBox).grabFocus();
  }

  dispose(): void {
    this.disposed = true;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.clearDiff();
    this.subs.dispose();
  }

  // --- Header ------------------------------------------------------------------

  private renderHeader(): void {
    const branch = this.git.getBranch();
    this.branchLabel.setText(branch ?? 'detached HEAD');

    // Static parts are available synchronously from the cached repo state; the
    // upstream ref needs a git call, so fill it in once it lands.
    const parts: string[] = [];
    const ahead = this.git.getAheadBehind();
    if (ahead && (ahead.ahead || ahead.behind)) {
      parts.push(`↑${ahead.ahead} ↓${ahead.behind}`); // upstream delta, like the branch indicator
    }
    const head = this.git.getHead();
    if (head) parts.push(head.slice(0, 7));
    this.setDetails(parts);

    if (this.repo) {
      upstreamRef(this.repo, (ref) => {
        if (!ref) return;
        this.setDetails([ref, ...parts]); // upstream first, then ahead/behind + HEAD
      });
    }
  }

  private setDetails(parts: string[]): void {
    const text = parts.filter(Boolean).join('  ·  ');
    this.detailsLabel.setText(text);
    this.detailsLabel.setVisible(text.length > 0);
  }

  // --- Commit list -------------------------------------------------------------

  private load(): void {
    if (!this.repo) {
      this.showEmpty('Not a git repository');
      return;
    }
    listCommits(this.repo, 'HEAD', COMMIT_LIMIT, (commits) => {
      this.commits = commits;
      this.applyFilter();
      // The list already holds focus from `openGitLog`'s `focus()` (which ran before the
      // commits landed), so select + preview the newest commit now — unless the user has
      // since dropped into the search field.
      if (!this.listBox.getSelectedRow() && this.filtered.length && !(this.search as any).hasFocus()) {
        this.selectIndex(0);
      }
    });
    // Changed paths for the `file:` filter — loaded in one pass, alongside the
    // commits; a `file:` query before this lands simply matches nothing until it does.
    listCommitFiles(this.repo, 'HEAD', COMMIT_LIMIT, (files) => {
      this.filesBySha = files;
      if (this.parse(this.search.getText()).file.length) this.applyFilter();
    });
  }

  /** Re-filter `commits` by the current search query and rebuild the rows, keeping
   *  newest-first order (the filter narrows; it doesn't re-rank). */
  private applyFilter(): void {
    const filters = this.parse(this.search.getText());
    this.filtered = this.commits.filter((c) => this.matches(c, filters));

    let child = this.listBox.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.listBox.remove(child);
      child = next;
    }

    if (this.filtered.length === 0) {
      this.showEmpty(this.commits.length === 0 ? 'No commits yet' : 'No matching commits');
      return;
    }
    for (const commit of this.filtered) this.listBox.append(this.buildRow(commit));
    this.scrolled.setVisible(true);
    this.empty.setVisible(false);
  }

  /** Parse the query into `file:`/`author:` filters and bare subject words. */
  private parse(query: string): Filters {
    const filters: Filters = { file: [], author: [], words: [] };
    for (const token of query.trim().split(/\s+/).filter(Boolean)) {
      const m = /^(file|author):(.*)$/.exec(token);
      if (m) {
        if (m[2]) (m[1] === 'file' ? filters.file : filters.author).push(m[2]); // ignore a bare `file:`
      } else {
        filters.words.push(token);
      }
    }
    return filters;
  }

  /** Whether `c` satisfies every term: words → subject, author → author name,
   *  file → any changed path (all via the picker's fzy matcher, AND-combined). */
  private matches(c: CommitSummary, f: Filters): boolean {
    for (const w of f.words) if (!fuzzyMatch(w, c.subject)) return false;
    for (const a of f.author) if (!fuzzyMatch(a, c.author)) return false;
    for (const q of f.file) {
      const paths = this.filesBySha.get(c.sha) ?? [];
      if (!paths.some((p) => fuzzyMatch(q, p))) return false;
    }
    return true;
  }

  private showEmpty(text: string): void {
    this.empty.setText(text);
    this.empty.setVisible(true);
    this.scrolled.setVisible(false);
  }

  private buildRow(commit: CommitSummary): InstanceType<typeof Gtk.ListBoxRow> {
    const subject = new Gtk.Label({ xalign: 0, hexpand: true });
    subject.addCssClass('gitlog-subject');
    subject.setEllipsize(Pango.EllipsizeMode.END);
    subject.setText(commit.subject);

    // Detail line: [author] · [datetime] · [commit]. Only the short hash is set in
    // the monospace font (via markup); the author/date stay in the UI font.
    const when = humanReadableTime(commit.timestamp * 1000);
    const meta = new Gtk.Label({ xalign: 0, hexpand: true });
    meta.addCssClass('gitlog-meta');
    meta.setEllipsize(Pango.EllipsizeMode.END);
    meta.setMarkup(
      `${escapeMarkup(commit.author)} · ${escapeMarkup(when)} · ` +
        `<span face="${fonts.monospaceFamily}">${escapeMarkup(commit.shortSha)}</span>`,
    );

    // Subject, then the meta line, then — only when the commit has refs — a third row
    // of ref badges (checked-out branch first). The list never scrolls horizontally
    // (see `scrolled`'s policy), so a crowded badge row ellipsizes rather than widening.
    // Row gaps are set per-row in CSS (subject → meta vs meta → badges differ).
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    box.append(subject);
    box.append(meta);
    // Third row: badges for the *other* refs at this commit. The current branch (and a
    // detached HEAD) are dropped — "you are here" isn't shown as a tag.
    const refs = orderRefs(commit.refs.filter((r) => !r.head));
    if (refs.length) {
      const refsRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
      refsRow.addCssClass('gitlog-refs');
      for (const ref of refs) refsRow.append(this.buildRefChip(ref));
      box.append(refsRow);
    }

    const row = new Gtk.ListBoxRow();
    row.setChild(box);
    row.setTooltipText(refs.length ? `${refs.map((r) => r.name).join(', ')}\n${commit.subject}` : commit.subject);
    return row;
  }

  /** A single ref badge: a kind glyph (branch / tag) before the ref name, styled by
   *  `gitlog-ref-<kind>` (branch / remote / tag — head refs are filtered out before
   *  here). Long names ellipsize so one branch can't crowd the row. */
  private buildRefChip(ref: CommitRef): InstanceType<typeof Gtk.Label> {
    const glyph = ref.kind === 'tag' ? Icons.gitTag : Icons.git;
    const chip = new Gtk.Label({ xalign: 0 });
    chip.addCssClass('gitlog-ref');
    chip.addCssClass(`gitlog-ref-${ref.kind}`);
    chip.setEllipsize(Pango.EllipsizeMode.END);
    chip.setMaxWidthChars(22);
    chip.setMarkup(`<span face="${ICON_FONT_FAMILY}">${glyph}</span> ${escapeMarkup(ref.name)}`);
    return chip;
  }

  // --- Navigation / commands ---------------------------------------------------

  private registerCommands(): void {
    // List navigation is registered on the list widget so it dispatches only while
    // the list — not the search entry — is focused. Bindings (j/k/g g/G/l, o/Enter, /)
    // live in the central keymap under `.GitLogList`.
    this.subs.add(
      zym.commands.add(this.listBox, {
        'core:down': { didDispatch: () => this.move(1), description: 'Move down' },
        'core:up': { didDispatch: () => this.move(-1), description: 'Move up' },
        'core:top': { didDispatch: () => this.selectIndex(0), description: 'Go to the top' },
        'core:bottom': { didDispatch: () => this.selectIndex(this.filtered.length - 1), description: 'Go to the bottom' },
        'core:right': { didDispatch: () => this.openSelected(), description: 'Open the selected commit' },
        'git-log:open': { didDispatch: () => this.openSelected(), description: 'Open the selected commit in a diff' },
        'git-log:search': { didDispatch: () => this.search.grabFocus(), description: 'Filter the commit list' },
        'git-log:copy-sha': { didDispatch: () => this.copySelectedSha(), description: 'Copy the selected commit short hash' },
        'git-log:revert': { didDispatch: () => this.revertSelected(), description: 'Revert the selected commit' },
      }),
    );
    // `git-log:focus-list` / `git-log:focus-diff` are registered on the view ROOT (not a
    // leaf), so they dispatch from anywhere inside the viewer. They model the list and the
    // diff as two nested windows: `ctrl-w l` steps from the list INTO the diff, `ctrl-w h`
    // steps back; the OUTWARD directions are left to the global `.AppWindow` pane nav. The
    // search field also reaches focus-list (Enter/Down/Escape drop into the list).
    this.subs.add(
      zym.commands.add(this.root, {
        'git-log:focus-list': { didDispatch: () => this.focus(), description: 'Move focus to the commit list' },
        'git-log:focus-diff': { didDispatch: () => this.focusDiff(), description: 'Move focus to the diff pane' },
      }),
    );
  }

  /** Step into the diff pane (`ctrl-w l` from the list). Focuses the loaded diff, or —
   *  if nothing is loaded yet — opens the selected commit and focuses it. */
  private focusDiff(): void {
    if (this.diff) { this.diff.focus(); return; }
    this.openSelected();
  }

  private move(delta: number): void {
    if (this.filtered.length === 0) return;
    const selected = this.listBox.getSelectedRow();
    this.selectIndex((selected ? selected.getIndex() : -1) + delta);
  }

  private selectIndex(index: number): void {
    if (this.filtered.length === 0) return;
    const clamped = Math.max(0, Math.min(index, this.filtered.length - 1));
    const row = this.listBox.getRowAtIndex(clamped);
    if (row) {
      this.listBox.selectRow(row);
      row.grabFocus(); // scrolls the row into view
      this.schedulePreview(); // moving the selection live-previews that commit's diff
    }
  }

  /** Open the selected commit's diff and move focus into it (o/Enter/l). Reuses the
   *  preview already loaded for that commit when present; otherwise builds it now. */
  private openSelected(): void {
    const row = this.listBox.getSelectedRow();
    if (row) this.activate(row.getIndex());
  }

  private activate(index: number): void {
    const commit = this.filtered[index];
    if (commit) this.loadDiff(commit, /* focus */ true);
  }

  /** Yank the selected commit's short hash to the system clipboard (`y y`). */
  private copySelectedSha(): void {
    const row = this.listBox.getSelectedRow();
    const commit = row ? this.filtered[row.getIndex()] : undefined;
    if (!commit) return;
    clipboard.write(commit.shortSha);
    zym.notifications.addInfo(`Copied ${commit.shortSha}`);
  }

  /** Revert the selected commit (`R`): confirm, then create a new commit undoing it.
   *  Reverting modifies HEAD (and can conflict), so it's gated behind a confirmation. */
  private revertSelected(): void {
    const row = this.listBox.getSelectedRow();
    const commit = row ? this.filtered[row.getIndex()] : undefined;
    if (!commit) return;
    const dialog = new Adw.AlertDialog({
      heading: 'Revert commit',
      body: `Create a new commit that undoes ${commit.shortSha}?\n\n${commit.subject}`,
    });
    dialog.addResponse('cancel', 'Cancel');
    dialog.addResponse('revert', 'Revert');
    dialog.setResponseAppearance('revert', Adw.ResponseAppearance.SUGGESTED);
    dialog.setDefaultResponse('revert');
    dialog.setCloseResponse('cancel');
    dialog.on('response', (response: string) => {
      if (response === 'revert') void this.revert(commit);
    });
    dialog.present(this.root);
  }

  /** Run the revert, then reload the list so the new commit shows. A revert that hits
   *  conflicts fails (non-zero exit) and is surfaced with git's stderr for the user. */
  private async revert(commit: CommitSummary): Promise<void> {
    const result = await this.git.revert(commit.sha);
    if (this.disposed) return;
    if (result.isOk()) {
      this.load(); // success is silent; the revert added a commit — refresh the list (re-select the top)
    } else {
      zym.notifications.addError('Revert failed', { detail: result.unwrapErr().message.trim() });
    }
  }

  // --- Embedded diff -----------------------------------------------------------

  /** Debounced live preview of the selected commit's diff (focus stays on the list).
   *  Skipped during a fast j/k scroll — only the commit the selection settles on builds. */
  private schedulePreview(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      const row = this.listBox.getSelectedRow();
      const commit = row ? this.filtered[row.getIndex()] : undefined;
      if (commit) this.loadDiff(commit, /* focus */ false);
    }, PREVIEW_DEBOUNCE_MS);
  }

  /** Build `commit`'s diff (vs its first parent) and swap it into the right pane. A
   *  re-select of the commit already shown is a no-op (just refocuses when asked). The
   *  build is async + generation-guarded, so a newer selection wins. */
  private loadDiff(commit: CommitSummary, focus: boolean): void {
    if (!this.repo) return;
    if (this.diffSha === commit.sha) {
      if (focus) this.diff?.focus();
      return;
    }
    const gen = ++this.buildGen;
    void buildCommitDiffView(this.repo, commit, this.cwd).then((built) => {
      if (this.disposed || gen !== this.buildGen) {
        built?.view.dispose(); // superseded by a newer selection (or the view closed)
        return;
      }
      // Record the shown sha BEFORE swapping so a commit with no changes (placeholder)
      // is still remembered — re-selecting it won't rebuild.
      this.diffSha = commit.sha;
      if (!built) {
        this.showDiffPlaceholder('This commit has no file changes');
        return;
      }
      this.clearDiff();
      built.view.root.setHexpand(true);
      built.view.root.setVexpand(true);
      this.diffPane.append(built.view.root);
      this.diff = built.view;
      if (focus) built.view.focus();
    });
  }

  /** Drop whatever the right pane currently holds (the live diff or a placeholder),
   *  disposing the diff. Leaves the pane empty for the next `append`. */
  private clearDiff(): void {
    this.diff?.dispose();
    this.diff = null;
    let child = this.diffPane.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.diffPane.remove(child);
      child = next;
    }
  }

  /** Replace the right pane with a muted message (no commit selected, or no changes).
   *  Leaves `diffSha` to the caller — the constructor's first call runs with it null. */
  private showDiffPlaceholder(text: string): void {
    this.clearDiff();
    const label = new Gtk.Label({ label: text, xalign: 0, yalign: 0 });
    label.addCssClass('gitlog-diff-placeholder');
    this.diffPane.append(label);
  }
}
