/*
 * GitLogView — a keyboard-navigable git history viewer, hosted as a center tab
 * (opened via the `git:log` command).
 *
 * A header carrying the branch and its details (upstream ref, ahead/behind, HEAD
 * sha) sits above a search field and a plain list of recent commits, newest first.
 * Each commit row shows its subject over an "author · date · sha" detail line, in
 * the monospace font. Navigation follows the project's vim-style list convention —
 * j/k move, g g/G jump to the ends — and o/Enter (or l) opens the selected commit's
 * diff, which the host shows in a side split (see AppWindow.openGitLog).
 *
 * The search field filters live, using the picker's fzy matcher (no highlighting):
 * `file:x` matches a changed path, `author:y` matches the author, and any bare word
 * matches the subject; all terms must match (AND). To keep the bare list keys (j/k/…)
 * from typing into the search field, those bindings are scoped to the list widget
 * (`#GitLogList`) rather than the whole view, so they only fire while the list — not
 * the entry — holds focus. `/` jumps to the search; Enter/Down/Escape return to the
 * list. The assembled widget is exposed via `root`.
 */
import { Gtk, Pango } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { ICON_FONT_FAMILY, fonts } from '../fonts.ts';
import { zym } from '../zym.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import { escapeMarkup } from './pickerHighlight.ts';
import { fuzzyMatch } from './fuzzyMatch.ts';
import { humanReadableTime } from '../util/humanReadableTime.ts';
import { Icons } from './icons.ts';
import {
  repoRoot,
  listCommits,
  listCommitFiles,
  upstreamRef,
  type GitRepo,
  type CommitSummary,
} from '../git.ts';

export interface GitLogViewOptions {
  cwd: string;
  git: GitRepo;
  /** Open the selected commit's diff (the host places it in a side split). */
  onOpenCommit: (commit: CommitSummary) => void;
}

// How many recent commits to list (newest first) — matches the commit picker's depth.
const COMMIT_LIMIT = 200;

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
  #GitLogView .gitlog-header {
    padding: calc(2 * var(--t-spacing));
    border-bottom: 1px solid var(--border-color);
  }
  #GitLogView .gitlog-branch { font-weight: bold; }
  #GitLogView .gitlog-branch-icon { color: var(--t-ui-text-muted); }
  #GitLogView .gitlog-details { color: var(--t-ui-text-muted); }
  #GitLogView .gitlog-search-box {
    padding: calc(2 * var(--t-spacing));
    border-bottom: 1px solid var(--border-color);
  }
  #GitLogView .gitlog-empty { color: var(--t-ui-text-muted); padding: 12px; }
  #GitLogList row {
    padding: calc(2 * var(--t-spacing));
    border-bottom: 1px solid var(--border-color);
  }
  #GitLogView .gitlog-subject { color: var(--t-ui-editor-foreground); }
  #GitLogView .gitlog-meta { color: var(--t-ui-text-muted); }
  /* Selected row: full selection color while focused, a muted version otherwise. */
  #GitLogList row:selected { background-color: alpha(var(--t-ui-surface-selected), 0.4); }
  #GitLogView:focus-within #GitLogList row:selected { background-color: var(--t-ui-surface-selected); }
`);

export class GitLogView {
  readonly root: InstanceType<typeof Gtk.Box>;

  private readonly git: GitRepo;
  private readonly repo: string | null;
  private readonly onOpenCommit: (commit: CommitSummary) => void;
  private readonly subs = new CompositeDisposable();

  private readonly branchLabel: InstanceType<typeof Gtk.Label>;
  private readonly detailsLabel: InstanceType<typeof Gtk.Label>;
  private readonly search: InstanceType<typeof Gtk.SearchEntry>;
  private readonly searchBox: InstanceType<typeof Gtk.Box>;
  private readonly listBox: InstanceType<typeof Gtk.ListBox>;
  private readonly scrolled: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly empty: InstanceType<typeof Gtk.Label>;

  private commits: CommitSummary[] = []; // all loaded commits (newest first)
  private filtered: CommitSummary[] = []; // those currently shown (after the search filter)
  private filesBySha = new Map<string, string[]>(); // sha → changed paths, for `file:` filtering

  constructor(options: GitLogViewOptions) {
    this.git = options.git;
    this.repo = repoRoot(options.cwd);
    this.onOpenCommit = options.onOpenCommit;

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
    this.search.setName('GitLogSearch'); // selector identity for the entry's own keymap
    this.search.addCssClass('has-text-input'); // release the `space` leader so it types
    this.search.on('search-changed', () => this.applyFilter());

    this.searchBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.searchBox.addCssClass('gitlog-search-box');
    this.searchBox.append(this.search);

    // --- Body: a plain list of commits.
    this.listBox = new Gtk.ListBox();
    this.listBox.setName('GitLogList'); // selector identity for the list-only keymap + CSS
    this.listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);
    this.listBox.on('row-activated', (row: any) => this.activate(row.getIndex()));

    this.scrolled = new Gtk.ScrolledWindow();
    this.scrolled.setChild(this.listBox);
    this.scrolled.setVexpand(true);

    this.empty = new Gtk.Label({ label: 'No commits', xalign: 0 });
    this.empty.addCssClass('gitlog-empty');
    this.empty.setVisible(false);

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.setName('GitLogView'); // CSS identity (the list keymap targets #GitLogList)
    this.root.append(header);
    this.root.append(this.searchBox);
    this.root.append(this.scrolled);
    this.root.append(this.empty);

    this.registerCommands();
    this.renderHeader();
    this.load();
  }

  /** Move keyboard focus into the list, selecting the first commit if none is yet. */
  focus(): void {
    if (!this.listBox.getSelectedRow() && this.filtered.length) {
      const first = this.listBox.getRowAtIndex(0);
      if (first) this.listBox.selectRow(first);
    }
    (this.listBox.getSelectedRow() ?? this.listBox).grabFocus();
  }

  dispose(): void {
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

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
    box.append(subject);
    box.append(meta);

    const row = new Gtk.ListBoxRow();
    row.setChild(box);
    row.setTooltipText(commit.subject);
    return row;
  }

  // --- Navigation / commands ---------------------------------------------------

  private registerCommands(): void {
    // List navigation is registered on the list widget so it dispatches only while
    // the list — not the search entry — is focused. Bindings (j/k/g g/G/l, o/Enter, /)
    // live in the central keymap under `#GitLogList`.
    this.subs.add(
      zym.commands.add(this.listBox, {
        'core:down': { didDispatch: () => this.move(1), description: 'Move down' },
        'core:up': { didDispatch: () => this.move(-1), description: 'Move up' },
        'core:top': { didDispatch: () => this.selectIndex(0), description: 'Go to the top' },
        'core:bottom': { didDispatch: () => this.selectIndex(this.filtered.length - 1), description: 'Go to the bottom' },
        'core:right': { didDispatch: () => this.openSelected(), description: 'Open the selected commit' },
        'git-log:open': { didDispatch: () => this.openSelected(), description: 'Open the selected commit in a diff' },
        'git-log:search': { didDispatch: () => this.search.grabFocus(), description: 'Filter the commit list' },
      }),
    );
    // The search entry's own keys (bound to `#GitLogSearch` in the central keymap):
    // drop from the field down into the filtered results, keeping the query.
    this.subs.add(
      zym.commands.add(this.search, {
        'git-log:focus-list': { didDispatch: () => this.focus(), description: 'Move from the filter to the commit list' },
      }),
    );
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
    }
  }

  private openSelected(): void {
    const row = this.listBox.getSelectedRow();
    if (row) this.activate(row.getIndex());
  }

  private activate(index: number): void {
    const commit = this.filtered[index];
    if (commit) this.onOpenCommit(commit);
  }
}
