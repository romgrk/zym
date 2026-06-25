/*
 * GitPanel — the git status panel. Opens as a tab in the active center panel
 * (via `git-panel:focus` → AppWindow.revealGitPanel), like a normal editor tab.
 *
 * A single list of changed files in three groups — Staged / Changes / Untracked
 * — with a cursor (the selected row) driven by vim-style keys: j/k move, l/enter/o open
 * the change's diff, s/u stage/unstage, X discards, and `c c` starts a commit. The mouse
 * works too: a click selects the row and opens its diff. Reads and
 * mutations go through the git facade (`git.ts`, node `git` CLI); the panel refreshes on its
 * own operations and on `GitRepo.onChange` (external edits). Failures surface
 * through `zym.notifications`.
 *
 * The commit message is edited in a normal editor tab (see AppWindow.onCommit);
 * this widget just presents status. The assembled panel is exposed via `root`.
 */
import { Gtk, Pango } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { zym } from '../zym.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import type { DiffView } from './DiffView.ts';
import type { AheadBehind, GitRepo } from '../git.ts';
import {
  type GitChange,
  type GitFileState,
  type GitDone,
  repoRoot,
  getChangesAsync,
  stage,
  unstage,
  stageAll,
  unstageAll,
  discard,
  clean,
} from '../git.ts';

export interface GitPanelOptions {
  cwd: string;
  git: GitRepo;
  /** Open the file under the cursor in the editor (the fallback when no diff is wired). */
  onOpenFile: (path: string) => void;
  /** Start a commit: edit the message and commit on save (the `c c` chord). */
  onCommit: () => void;
  /** Build a live, editable working-tree DiffView for the current changes (the host owns the
   *  document registry). `l`/`enter`/`o` embed it beside the list and reveal the selected change.
   *  Null when there's nothing to diff. Omitted → `l`/`enter`/`o` fall back to `onOpenFile`. */
  buildDiffView?: () => Promise<DiffView | null>;
}

type RowKind = 'staged' | 'unstaged';
interface RowInfo {
  change: GitChange;
  kind: RowKind;
  row: InstanceType<typeof Gtk.ListBoxRow>;
}

// Short status letter per state (the `git status` short-format letters); the
// color comes from where the change lives, not the letter — see buildRow.
const STATE_LETTER: Record<GitFileState, string> = {
  new: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  conflicted: '!',
  untracked: 'U',
};

// Badge colors, matching `git status`: staged in green, unstaged/untracked in red.
const STAGED_COLOR = theme.ui.status.success;
const UNSTAGED_COLOR = theme.ui.status.error;

// Horizontal gap between a row's cells; also the state letter's trailing margin
// (one extra spacing unit), so the letter sits clear of the path.
const ROW_SPACING = 6;

// Width the change list keeps once the embedded diff is shown beside it; the diff
// (the Paned's end child) takes the rest — most of the panel's width.
const LIST_WIDTH = 300;

/** The `git status`-style header lines for the current branch/upstream state,
 *  mirroring git's own wording. `muted` marks the parenthetical advice hint. */
function gitStatusLines(
  branch: string,
  upstream: string | null,
  ab: AheadBehind | null,
): { text: string; muted?: boolean }[] {
  const lines: { text: string; muted?: boolean }[] = [{ text: `On branch ${branch}` }];
  if (!upstream || !ab) return lines; // no upstream → just the branch line, like git
  const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;
  const { ahead, behind } = ab;
  if (ahead === 0 && behind === 0) {
    lines.push({ text: `Your branch is up to date with '${upstream}'.` });
  } else if (behind === 0) {
    lines.push({ text: `Your branch is ahead of '${upstream}' by ${commits(ahead)}.` });
    lines.push({ text: `  (use "git push" to publish your local commits)`, muted: true });
  } else if (ahead === 0) {
    lines.push({ text: `Your branch is behind '${upstream}' by ${commits(behind)}, and can be fast-forwarded.` });
    lines.push({ text: `  (use "git pull" to update your local branch)`, muted: true });
  } else {
    lines.push({ text: `Your branch and '${upstream}' have diverged,` });
    lines.push({ text: `and have ${ahead} and ${behind} different commits each, respectively.` });
    lines.push({ text: `  (use "git pull" to merge the remote branch into yours)`, muted: true });
  }
  return lines;
}

// Compact, dense rows. The theme background/selection are applied centrally in
// AppWindow. Each file row leads with the state letter (its per-status color via
// Pango markup) followed by the path, which CSS tints to the same staged/unstaged
// color and renders in the monospace font.
addStyles(/* css */`
  /* No font-size override: section headers inherit the default label size, the
     same size every other label (file rows, file-tree headers) uses. */
  #GitPanel .git-header {
    color: var(--t-ui-editor-foreground);
    font-weight: bold;
    padding: 6px 8px 3px 8px;
  }
  /* File path: monospace, colored by where the change lives — staged green /
     unstaged red — so it matches the leading state letter. */
  #GitPanel #GitRow .git-name { font: var(--t-font-monospace); }
  #GitPanel #GitRow .git-name.staged { color: var(--t-ui-status-success); }
  #GitPanel #GitRow .git-name.unstaged { color: var(--t-ui-status-error); }
  #GitPanel row { min-height: 0; }
  #GitPanel #GitRow { padding: 0 8px 0 16px; } /* indent entries under the section header */
  /* The state letter: bold, small, tabular figures; its margin-end is set in code
     (one row-spacing unit) so it sits clear of the path. */
  #GitPanel .git-badge { font-weight: bold; font-size: var(--t-font-ui-size-small); font-feature-settings: "tnum" 1; }
  /* The git-status-style preamble (branch + upstream tracking line), shown above
     the change groups. The parenthetical advice hint is muted, like git's. */
  #GitPanel .git-status { padding: 6px 8px; }
  #GitPanel .git-status label { color: var(--t-ui-editor-foreground); }
  #GitPanel .git-status .git-status-hint { color: var(--t-ui-text-muted); }
  /* The cursor (selected row) is highlighted with the theme selection color, and
     only while the panel is focused — an unfocused panel shows no highlight. */
  #GitPanel row:selected { 
    background-color: alpha(var(--window-fg-color), 0.1);
  }
  #GitPanelList:focus-within row:selected {
    background-color: var(--t-ui-surface-selected);
  }
`);

export class GitPanel {
  // A horizontal split: the change list (start) and, once `l`/`enter`/`o` opens a change,
  // the embedded live DiffView (end, taking most of the width). The end child stays null
  // until a diff is first shown.
  readonly root: InstanceType<typeof Gtk.Paned>;

  // git/repo are swapped by `setRoot` when an agent re-roots into a worktree.
  private git: GitRepo;
  private repo: string | null; // repository top-level, or null outside a repo
  private readonly onOpenFile: (path: string) => void;
  private readonly onCommit: () => void;
  private readonly buildDiffView?: () => Promise<DiffView | null>;
  private readonly subs = new CompositeDisposable();
  // Per-poll row controllers: cleared+rebuilt every refresh (rule 9), torn down with `subs`.
  private readonly rowScope = this.subs.nest();
  private gitUnsub?: () => void; // the active git's onChange subscription
  private readonly list: InstanceType<typeof Gtk.ListBox>;
  private readonly scrolled: InstanceType<typeof Gtk.ScrolledWindow>;
  // The embedded diff (end child), or null when only the list is shown. Disposed +
  // rebuilt on each open so it always reflects the current change set.
  private diffView: DiffView | null = null;
  // Bumped per open so a slow async diff build that resolves after a newer open (or after
  // dispose) is dropped instead of clobbering the current one.
  private diffGeneration = 0;
  private disposed = false;
  // The selectable file rows, in display order (headers excluded), for cursor nav.
  private fileRows: RowInfo[] = [];
  // Bumped per refresh so a slow async `git status` that resolves after a newer
  // refresh has started is dropped instead of clobbering the list.
  private refreshGeneration = 0;

  constructor(options: GitPanelOptions) {
    this.git = options.git;
    this.repo = repoRoot(options.cwd);
    this.onOpenFile = options.onOpenFile;
    this.onCommit = options.onCommit;
    this.buildDiffView = options.buildDiffView;

    this.list = new Gtk.ListBox();
    this.list.setName('GitPanelList'); // scopes the bare list keys (so they don't fire in the diff)
    this.list.setSelectionMode(Gtk.SelectionMode.SINGLE); // the selected row is the cursor

    this.scrolled = new Gtk.ScrolledWindow();
    this.scrolled.setChild(this.list);
    this.scrolled.setVexpand(true);
    // Never scroll horizontally: rows fit the panel width (paths ellipsize, the
    // status preamble wraps) instead of widening the list.
    this.scrolled.setPolicy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);

    // Horizontal split: list (start) | embedded diff (end, added on first open). The list
    // keeps a fixed width on resize; the diff absorbs the rest. No end child yet → the
    // Paned shows just the list, no handle.
    this.root = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
    this.root.setName('GitPanel'); // selector identity for command/keymap + CSS
    this.root.setStartChild(this.scrolled);
    this.root.setResizeStartChild(false);
    this.root.setShrinkStartChild(false);
    this.root.setShrinkEndChild(false);

    this.registerCommands();
    this.gitUnsub = this.git.onChange(() => this.refresh());
    this.refresh();
  }

  /** Re-root the panel at `cwd` (with `git`) when an agent moves into a worktree:
   *  swap the repo + git subscription and re-render. */
  setRoot(cwd: string, git: GitRepo): void {
    this.gitUnsub?.();
    this.git = git;
    this.repo = repoRoot(cwd);
    this.gitUnsub = git.onChange(() => this.refresh());
    this.refresh();
  }

  /** Move keyboard focus into the panel (pane navigation), selecting a row. */
  focus(): void {
    if (!this.list.getSelectedRow() && this.fileRows.length) {
      this.list.selectRow(this.fileRows[0].row);
    }
    (this.list.getSelectedRow() ?? this.list).grabFocus();
  }

  dispose(): void {
    this.disposed = true;
    this.diffGeneration++; // drop any in-flight diff build
    this.diffView?.dispose();
    this.diffView = null;
    this.gitUnsub?.();
    this.subs.dispose();
  }

  // --- Commands (vim-style; bindings live in the central keymap) --------------

  private registerCommands(): void {
    zym.commands.add(this.root, {
      'core:down': { didDispatch: () => this.move(+1), description: 'Move down' },
      'core:up': { didDispatch: () => this.move(-1), description: 'Move up' },
      'core:top': { didDispatch: () => this.selectIndex(0), description: 'Go to the top' }, // `g g`
      'core:bottom': { didDispatch: () => this.selectIndex(this.fileRows.length - 1), description: 'Go to the bottom' }, // `G`
      'core:right': { didDispatch: () => this.openSelected(), description: 'Open the selected change in the diff' }, // `l`
      'git:open-diff': { didDispatch: () => this.openSelected(), description: 'Open the selected change in the diff' }, // `o` / `enter`
      'git:stage': { didDispatch: () => this.act((c) => stage(this.repo!, c.relPath, this.done)), description: 'Stage changes' },
      'git:unstage': { didDispatch: () => this.act((c) => unstage(this.repo!, c.relPath, this.done)), description: 'Unstage changes' },
      'git:stage-all': { didDispatch: () => this.stageAllToggle(), description: 'Stage / unstage all' }, // `A`
      'git:discard': { didDispatch: () => this.discardSelected(), description: 'Discard changes' },
      'git:commit': { didDispatch: () => this.onCommit(), description: 'Commit staged changes' },
      // Move focus between the list and the embedded diff (vim `ctrl-w h`/`l`); registered on the
      // root so they resolve from inside the diff editor too.
      'git-panel:focus-diff': { didDispatch: () => this.diffView?.focus(), description: 'Focus the diff' },
      'git-panel:focus-list': { didDispatch: () => this.focusList(), description: 'Focus the change list' },
      'git-panel:close-diff': { didDispatch: () => this.closeDiff(), description: 'Close the diff' }, // `q` in the diff
    });
  }

  private selected(): RowInfo | null {
    const row = this.list.getSelectedRow();
    return row ? this.fileRows.find((r) => r.row === row) ?? null : null;
  }

  private move(delta: number): void {
    const current = this.selected();
    const index = current ? this.fileRows.indexOf(current) : -1;
    this.selectIndex(index + delta);
  }

  // Select the file row at `index` (clamped), scrolling it into view.
  private selectIndex(index: number): void {
    if (!this.fileRows.length) return;
    const clamped = Math.max(0, Math.min(this.fileRows.length - 1, index));
    const target = this.fileRows[clamped].row;
    this.list.selectRow(target);
    target.grabFocus(); // scrolls the row into view
  }

  // `A` — stage everything, or unstage everything when nothing is left unstaged.
  private stageAllToggle(): void {
    if (!this.repo) return;
    const hasUnstaged = this.fileRows.some((r) => r.kind === 'unstaged');
    if (hasUnstaged) stageAll(this.repo, this.done);
    else unstageAll(this.repo, this.done);
  }

  private openSelected(): void {
    const info = this.selected();
    if (info) this.showDiff(info.change);
  }

  // Open the change's diff: reveal the embedded live DiffView (most of the panel's width) with
  // its caret on this change's excerpt, and focus it. Untracked entries can be whole directories
  // (porcelain lists them with a trailing slash) — not diffable. With no diff wired (e.g. tests),
  // fall back to opening the file in the editor. The diff is rebuilt on each open so it always
  // reflects the current change set; a generation guard drops a build a newer open superseded.
  private showDiff(change: GitChange): void {
    if (change.relPath.endsWith('/')) {
      zym.notifications.addTrace(`Opening a directory is not implemented: ${change.relPath}`);
      return;
    }
    if (!this.buildDiffView) {
      this.onOpenFile(change.path);
      return;
    }
    const targetPath = change.path;
    const generation = ++this.diffGeneration;
    void this.buildDiffView().then((view) => {
      if (this.disposed || generation !== this.diffGeneration) {
        view?.dispose(); // a newer open (or panel close) superseded this build — drop it
        return;
      }
      if (!view) {
        zym.notifications.addTrace('No changes to diff');
        return;
      }
      const hadDiff = this.diffView !== null;
      this.diffView?.dispose();
      this.diffView = view;
      this.root.setEndChild(view.root); // detaches+replaces the old diff
      if (!hadDiff) this.root.setPosition(LIST_WIDTH); // size the split once; keep a dragged width after
      // Keep the list selection in step with where the caret sits in the diff.
      view.onCursorFileChanged((path) => this.selectRowForPath(path));
      view.revealFile(targetPath);
      view.focus();
    }).catch((err) => {
      zym.notifications.addError('Could not open the diff', { detail: String(err) });
    });
  }

  // Focus the change list (the selected row, or the list itself) — the `ctrl-w h` way back
  // out of the embedded diff.
  private focusList(): void {
    (this.list.getSelectedRow() ?? this.list).grabFocus();
  }

  // Select (highlight, no focus grab) the list row for `path` — driven by the diff caret crossing
  // into that file, so the list tracks the diff. A file can have two rows (staged + unstaged); the
  // first match is fine. No-op when it isn't listed.
  private selectRowForPath(path: string): void {
    const info = this.fileRows.find((r) => r.change.path === path);
    if (info) this.list.selectRow(info.row); // selection only — focus stays in the diff
  }

  // Close the embedded diff (the `q` key inside it): collapse the split back to just the list
  // and return focus there. Bumps the generation so an in-flight build doesn't re-open it.
  private closeDiff(): void {
    if (!this.diffView) return;
    this.diffGeneration++;
    this.diffView.dispose();
    this.diffView = null;
    this.root.setEndChild(null);
    this.focusList();
  }

  // Restore (tracked) or delete (untracked) the file under the cursor — `X`.
  private discardSelected(): void {
    this.act((change) => {
      if (change.state === 'untracked') clean(this.repo!, change.relPath, this.done);
      else discard(this.repo!, change.relPath, this.done);
    });
  }

  // Run an action on the change under the cursor (no-op when nothing is selected).
  private act(op: (change: GitChange) => void): void {
    const info = this.selected();
    if (info && this.repo) op(info.change);
  }

  // Mutation callback: report failures; the change set refresh follows.
  private readonly done: GitDone = (ok, _out, err) => {
    if (!ok) zym.notifications.addError('Git operation failed', { detail: err.trim() });
    this.refresh();
  };

  // --- Change list -----------------------------------------------------------

  private refresh(): void {
    // `git status` runs off the UI thread (via the broker); rebuild once it lands.
    // A generation guard drops a result superseded by a newer refresh.
    const generation = ++this.refreshGeneration;
    if (!this.repo) {
      this.applyChanges(null, generation);
      return;
    }
    getChangesAsync(this.repo, (changes) => this.applyChanges(changes, generation));
  }

  /** Rebuild the change list from `changes` (null = not a repo). Tearing the list
   *  down resets focus/selection/scroll, so remember the cursor, focus, and scroll
   *  and reapply them — a poll-driven refresh must leave the view put. Focus is
   *  only restored when it was inside the LIST (never stealing it from the editor or
   *  the embedded diff); the list — not the row — is focused so selection doesn't force
   *  a scroll-into-view, and the offset is reapplied after layout. */
  private applyChanges(changes: GitChange[] | null, generation: number): void {
    if (generation !== this.refreshGeneration) return; // a newer refresh is in flight

    const prevKey = this.selectedKey();
    const keepFocus = this.listHasFocus();
    const scrollValue = this.scrolled.getVadjustment().getValue();

    this.rowScope.clear(); // release every previous row's rooted click closure before dropping the rows
    let child = this.list.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.list.remove(child);
      child = next;
    }
    this.fileRows = [];

    if (!changes) {
      this.list.append(this.messageRow('Not a git repository'));
      return;
    }

    // A `git status`-style preamble (branch + upstream tracking) above the groups.
    const status = this.statusRow();
    if (status) this.list.append(status);

    const staged = changes.filter((c) => c.staged);
    const unstaged = changes.filter((c) => c.unstaged && c.state !== 'untracked');
    const untracked = changes.filter((c) => c.state === 'untracked');

    if (!staged.length && !unstaged.length && !untracked.length) {
      this.list.append(this.messageRow('No changes'));
      if (keepFocus) this.list.grabFocus();
      return;
    }

    if (staged.length) this.addGroup('Staged', staged, 'staged');
    if (unstaged.length) this.addGroup('Unstaged', unstaged, 'unstaged');
    if (untracked.length) this.addGroup('Untracked', untracked, 'unstaged');

    // Restore the cursor onto the same change if it survived, else the first row.
    const restore =
      (prevKey && this.fileRows.find((r) => this.key(r.change, r.kind) === prevKey)) ||
      this.fileRows[0];
    if (restore) this.list.selectRow(restore.row); // selection only — no scroll
    if (keepFocus) this.list.grabFocus(); // focus the list, not the row (no scroll)

    // Reapply the scroll offset once the rebuilt rows have been laid out (the
    // adjustment's range is only correct after allocation).
    setTimeout(() => {
      this.scrolled.getVadjustment().setValue(scrollValue);
    }, 0);
  }

  private addGroup(title: string, changes: GitChange[], kind: RowKind): void {
    this.list.append(this.headerRow(`${title} (${changes.length})`));
    let lastRow: InstanceType<typeof Gtk.ListBoxRow> | null = null;
    for (const change of changes) {
      const row = this.buildRow(change, kind);
      this.fileRows.push({ change, kind, row });
      this.list.append(row);
      lastRow = row;
    }
    lastRow?.setMarginBottom(2 * ROW_SPACING); // separate each section by 2× the row spacing
  }

  private buildRow(change: GitChange, kind: RowKind): InstanceType<typeof Gtk.ListBoxRow> {
    const badgeColor = kind === 'staged' ? STAGED_COLOR : UNSTAGED_COLOR;
    const badge = new Gtk.Label();
    badge.addCssClass('git-badge');
    badge.setMarginEnd(ROW_SPACING); // one extra spacing unit after the letter
    badge.setMarkup(`<span foreground="${badgeColor}">${STATE_LETTER[change.state]}</span>`);

    const name = new Gtk.Label({ label: change.relPath, xalign: 0, hexpand: true });
    name.setEllipsize(Pango.EllipsizeMode.START); // keep the filename end visible
    name.addCssClass('git-name'); // monospace, tinted to the staged/unstaged status color
    name.addCssClass(kind); // 'staged' | 'unstaged' — matches the leading letter's color

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: ROW_SPACING });
    box.setName('GitRow');
    box.append(badge); // the state letter leads the row, before the path
    box.append(name);

    const row = new Gtk.ListBoxRow();
    row.setChild(box);
    row.setTooltipText(change.relPath);

    // A single click opens the change's diff (staging is the s/u keys on the cursor). The
    // `nPress === 1` guard keeps a double-click from opening twice (the 2nd press is ignored).
    const gesture = new Gtk.GestureClick();
    gesture.on('pressed', (nPress: number) => {
      if (nPress === 1) this.showDiff(change);
    });
    this.rowScope.addController(row, gesture);
    return row;
  }

  // --- Helpers ---------------------------------------------------------------

  private key(change: GitChange, kind: RowKind): string {
    return `${kind}:${change.relPath}`;
  }

  private selectedKey(): string | null {
    const info = this.selected();
    return info ? this.key(info.change, info.kind) : null;
  }

  private headerRow(text: string): InstanceType<typeof Gtk.ListBoxRow> {
    const label = new Gtk.Label({ label: text, xalign: 0 });
    label.addCssClass('git-header');
    const row = new Gtk.ListBoxRow();
    row.setChild(label);
    row.setSelectable(false);
    row.setActivatable(false);
    return row;
  }

  private messageRow(text: string): InstanceType<typeof Gtk.ListBoxRow> {
    const label = new Gtk.Label({ label: text, xalign: 0 });
    label.addCssClass('dim-label');
    label.setMarginStart(8);
    label.setMarginTop(8);
    const row = new Gtk.ListBoxRow();
    row.setChild(label);
    row.setSelectable(false);
    row.setActivatable(false);
    return row;
  }

  /** The `git status`-style preamble row (branch + upstream tracking), read from the
   *  reactive repo state. Null when there is no branch (not a repo / no branch info),
   *  so the row is simply omitted. Non-selectable, like the group headers. */
  private statusRow(): InstanceType<typeof Gtk.ListBoxRow> | null {
    const branch = this.git.getBranch();
    if (!branch) return null;
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    box.addCssClass('git-status');
    for (const line of gitStatusLines(branch, this.git.getUpstream(), this.git.getAheadBehind())) {
      const label = new Gtk.Label({ label: line.text, xalign: 0 });
      label.setWrap(true); // wrap to the panel width rather than widening the list
      if (line.muted) label.addCssClass('git-status-hint');
      box.append(label);
    }
    const row = new Gtk.ListBoxRow();
    row.setChild(box);
    row.setSelectable(false);
    row.setActivatable(false);
    return row;
  }

  /** Whether keyboard focus currently sits inside the change list (not the embedded diff) —
   *  so a poll-driven rebuild only re-grabs focus when it was the list's, never the diff's. */
  private listHasFocus(): boolean {
    const win = this.root.getRoot() as { getFocus?: () => InstanceType<typeof Gtk.Widget> | null } | null;
    let current: InstanceType<typeof Gtk.Widget> | null = win?.getFocus?.() ?? null;
    while (current) {
      if (current === this.scrolled) return true;
      current = current.getParent();
    }
    return false;
  }
}
