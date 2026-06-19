/*
 * GitStagingView — a tab-hosted staging interface (opened via `git:open-staging`,
 * `space g o`), distinct from the left-dock `GitPanel` (which stays as-is).
 *
 * A single scrollable column (`git status`-style). Each changed file is one row —
 * the full path in the app monospace font, staged green / unstaged+untracked red.
 * Pressing `o` on a file expands an **inline unified DiffViewer directly beneath
 * its row** (an accordion); `o` again collapses it. Several can be open at once.
 *
 *   Staged (1)
 *     src/foo.ts
 *     ├─ @@ -1,4 +1,6 @@            ◀ inline DiffViewer (unified)
 *     │  + added line
 *     │  - removed line
 *   Unstaged (2)
 *     src/bar.ts
 *     …
 *
 * Keys while the list is focused: j/k navigate, o toggles the inline diff, s/u
 * stage/unstage, X discards (restore tracked / delete untracked, no prompt), c c
 * commits (opens .git/COMMIT_EDITMSG in the editor area). The diff is read-only
 * (the DiffViewer); file-level staging is from the list. Per-row diff base: staged
 * rows = index↔HEAD, unstaged = worktree↔index, untracked = all-added.
 *
 * See tasks/git/staging-interface.md for the design and decisions.
 */
import * as Fs from 'node:fs';
import { Gtk, Pango } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { fonts } from '../fonts.ts';
import { theme } from '../theme/theme.ts';
import { quilx } from '../quilx.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import { computeDiff, foldUnchanged, needsTrailingNewline, type DiffModel } from '../util/DiffModel.ts';
import { DiffViewer } from './TextEditor/DiffViewer.ts';
import type { GitRepo } from '../git.ts';
import {
  type GitChange,
  type GitFileState,
  type GitDone,
  repoRoot,
  getChanges,
  stage,
  unstage,
  discard,
  clean,
  git,
} from '../git.ts';

export interface GitStagingViewOptions {
  cwd: string;
  git: GitRepo;
  /** Start a commit: open .git/COMMIT_EDITMSG in the editor area (save+close commits). */
  onCommit: () => void;
}

type RowKind = 'staged' | 'unstaged';
interface RowInfo {
  change: GitChange;
  kind: RowKind;
  row: InstanceType<typeof Gtk.ListBoxRow>;
}
interface DiffEntry {
  row: InstanceType<typeof Gtk.ListBoxRow>;
  viewer: DiffViewer;
}

// Short status letter per state; only deletions show one (their sole cue).
const STATE_LETTER: Record<GitFileState, string> = {
  new: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  conflicted: '!',
  untracked: 'U',
};

// The file list lives in the center (not the left dock), so it doesn't inherit the
// dock background — paint it with the theme editor background explicitly.
const FILES_BG = theme.ui.editor.background ?? theme.ui.surface.popover;

// Inline-diff height estimate (the inner view scrolls past the cap). No header bar
// (the staging diff passes `header: false`), so only a little vertical padding.
const DIFF_LINE_PX = 20;
const DIFF_HEADER_PX = 12;
const DIFF_MAX_PX = 480;

// File paths use the app monospace font (same as the editor), via the central sheet.
fonts.monospace('#GitStagingView .git-path');

addStyles(`
  #GitStagingView,
  #GitStagingView list { background-color: ${FILES_BG}; }
  #GitStagingView .git-header {
    color: ${theme.ui.text.muted};
    font-weight: bold;
    padding: 6px 8px 3px 8px;
  }
  #GitStagingView row { min-height: 0; }
  /* Indent the file rows under their group header, like terminal \`git status\`. */
  #GitStagingView #GitRow { padding: 0 8px 0 20px; }
  /* The full path is colored like \`git status\`: staged green, unstaged/untracked red. */
  #GitStagingView #GitRow.staged .git-path,
  #GitStagingView #GitRow.staged .git-badge { color: ${theme.ui.status.success}; }
  #GitStagingView #GitRow.unstaged .git-path,
  #GitStagingView #GitRow.unstaged .git-badge { color: ${theme.ui.status.error}; }
  #GitStagingView .git-badge { font-weight: bold; font-feature-settings: "tnum" 1; }
  #GitStagingView row:selected { background-color: transparent; }
  #GitStagingView:focus-within row:selected { background-color: ${theme.ui.surface.selected}; }
  /* Inline diff row: flush, with a left accent marking it as nested under its file. */
  #GitStagingView .git-diff-row { padding: 0; }
  #GitStagingView .git-diff-row:selected { background-color: transparent; }
`);

export class GitStagingView {
  readonly root: InstanceType<typeof Gtk.ScrolledWindow>;

  private git: GitRepo;
  private repo: string | null;
  private readonly onCommit: () => void;
  private readonly subs = new CompositeDisposable();
  private gitUnsub?: () => void;

  private readonly list: InstanceType<typeof Gtk.ListBox>;
  private fileRows: RowInfo[] = [];
  // Open inline diffs, keyed by `${kind}:${relPath}` (so a file with both a staged
  // and an unstaged row can show each independently).
  private readonly openDiffs = new Map<string, DiffEntry>();

  constructor(options: GitStagingViewOptions) {
    this.git = options.git;
    this.repo = repoRoot(options.cwd);
    this.onCommit = options.onCommit;

    this.list = new Gtk.ListBox();
    this.list.setSelectionMode(Gtk.SelectionMode.SINGLE);

    this.root = new Gtk.ScrolledWindow();
    this.root.setName('GitStagingView');
    this.root.setChild(this.list);

    this.registerCommands();
    this.gitUnsub = this.git.onChange(() => this.refresh());
    this.refresh();
  }

  /** Move keyboard focus into the file list (pane navigation), selecting a row. */
  focus(): void {
    if (!this.list.getSelectedRow() && this.fileRows.length) {
      this.list.selectRow(this.fileRows[0].row);
    }
    (this.list.getSelectedRow() ?? this.list).grabFocus();
  }

  dispose(): void {
    for (const entry of this.openDiffs.values()) entry.viewer.dispose();
    this.openDiffs.clear();
    this.gitUnsub?.();
    this.subs.dispose();
  }

  // --- Commands (vim-style; bindings live in the central keymap) --------------

  private registerCommands(): void {
    quilx.commands.add(this.root, {
      'core:down': { didDispatch: () => this.move(+1), description: 'Move down' },
      'core:up': { didDispatch: () => this.move(-1), description: 'Move up' },
      'core:top': { didDispatch: () => this.selectIndex(0), description: 'Go to the top' },
      'core:bottom': { didDispatch: () => this.selectIndex(this.fileRows.length - 1), description: 'Go to the bottom' },
      'core:right': { didDispatch: () => this.toggleDiff(), description: 'Expand / collapse the diff' }, // `o`
      'git:stage': { didDispatch: () => this.act((c) => stage(this.repo!, c.relPath, this.done)), description: 'Stage changes' },
      'git:unstage': { didDispatch: () => this.act((c) => unstage(this.repo!, c.relPath, this.done)), description: 'Unstage changes' },
      'git:discard': { didDispatch: () => this.discardSelected(), description: 'Discard changes' },
      'git:commit': { didDispatch: () => this.onCommit(), description: 'Commit staged changes' },
      'git:close-diff': { didDispatch: () => this.closeFocusedDiff(), description: 'Close the focused diff' }, // `q` while a diff is focused
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

  private selectIndex(index: number): void {
    if (!this.fileRows.length) return;
    const clamped = Math.max(0, Math.min(this.fileRows.length - 1, index));
    const target = this.fileRows[clamped].row;
    this.list.selectRow(target);
    target.grabFocus();
  }

  private discardSelected(): void {
    this.act((change) => {
      if (change.state === 'untracked') clean(this.repo!, change.relPath, this.done);
      else discard(this.repo!, change.relPath, this.done);
    });
  }

  private act(op: (change: GitChange) => void): void {
    const info = this.selected();
    if (info && this.repo) op(info.change);
  }

  private readonly done: GitDone = (ok, _out, err) => {
    if (!ok) quilx.notifications.addError('Git operation failed', { detail: err.trim() });
    this.refresh();
  };

  // --- Inline diff (accordion) -----------------------------------------------

  // `o` — toggle the inline DiffViewer under the file row beneath the cursor.
  private toggleDiff(): void {
    const info = this.selected();
    if (!info) return;
    const key = this.key(info.change, info.kind);
    if (this.openDiffs.has(key)) this.closeDiff(key);
    else this.openDiff(info);
  }

  private openDiff(info: RowInfo): void {
    const key = this.key(info.change, info.kind);
    if (this.openDiffs.has(key)) return;
    // Directories (untracked, trailing slash) have no diff to show.
    if (info.change.relPath.endsWith('/')) return;
    this.loadDiff(info.change, info.kind, (model) => {
      // Bail if the list was rebuilt (refresh) while the diff was loading — the
      // refresh path re-opens persisted diffs against the fresh rows itself.
      if (this.openDiffs.has(key) || info.row.getParent() !== this.list) return;
      const viewer = new DiffViewer(model, { languagePath: info.change.path, header: false });
      viewer.root.setVexpand(false);
      viewer.root.setSizeRequest(-1, this.diffHeight(model));

      const row = new Gtk.ListBoxRow();
      row.setChild(viewer.root);
      row.setSelectable(false);
      row.setActivatable(false);
      row.addCssClass('git-diff-row');
      this.list.insert(row, info.row.getIndex() + 1); // directly beneath the file row
      this.openDiffs.set(key, { row, viewer });
      viewer.focus(); // opening with `o` moves focus into the diff
    });
  }

  // Close the inline diff that currently holds focus (the `git:close-diff` command,
  // bound to `q` while a diff editor is focused) and return focus to the file list.
  private closeFocusedDiff(): void {
    const win = this.root.getRoot() as { getFocus?: () => InstanceType<typeof Gtk.Widget> | null } | null;
    const focus = win?.getFocus?.() ?? null;
    for (const [key, entry] of this.openDiffs) {
      for (let node = focus; node; node = node.getParent()) {
        if (node === entry.viewer.root) {
          this.closeDiff(key);
          this.focus();
          return;
        }
      }
    }
  }

  private closeDiff(key: string): void {
    const entry = this.openDiffs.get(key);
    if (!entry) return;
    this.openDiffs.delete(key);
    this.list.remove(entry.row);
    entry.viewer.dispose();
  }

  // Compute the diff model for a row: staged → index↔HEAD, unstaged → worktree↔index,
  // untracked → all-added. `git show HEAD:p` / `:p` read the HEAD / index blobs.
  private loadDiff(change: GitChange, kind: RowKind, cb: (model: DiffModel) => void): void {
    const repo = this.repo!;
    const rel = change.relPath;
    const work = (): string => {
      try {
        return Fs.readFileSync(change.path, 'utf8');
      } catch {
        return '';
      }
    };
    if (change.state === 'untracked') {
      cb(computeDiff('', work()));
    } else if (kind === 'staged') {
      git(repo, ['show', `HEAD:${rel}`], (okHead, head) => {
        git(repo, ['show', `:${rel}`], (okIndex, index) => {
          cb(computeDiff(okHead ? head : '', okIndex ? index : ''));
        });
      });
    } else {
      git(repo, ['show', `:${rel}`], (okIndex, index) => {
        cb(computeDiff(okIndex ? index : '', work()));
      });
    }
  }

  // A snug height for the inline diff, capped (the editor scrolls past the cap). Use
  // the exact number of *displayed* rows: total lines minus the folded bodies, plus
  // one marker line per fold (the unchanged runs start collapsed), plus the trailing
  // newline row the buffer adds only when the last changed line is empty (see
  // `diffBufferText`) — otherwise the view is ~a line short and scrolls.
  private diffHeight(model: DiffModel): number {
    const folds = foldUnchanged(model.lines);
    const hidden = folds.reduce((sum, f) => sum + f.count, 0);
    let displayed = Math.max(1, model.lines.length - hidden + folds.length);
    if (needsTrailingNewline(model.lines)) displayed += 1;
    return Math.min(DIFF_MAX_PX, DIFF_HEADER_PX + displayed * DIFF_LINE_PX);
  }

  // --- Change list -----------------------------------------------------------

  private refresh(): void {
    const prevKey = this.selectedKey();
    const keepFocus = this.hasFocusWithin();
    const scrollValue = this.root.getVadjustment().getValue();

    // Remember which diffs were open; dispose the viewers (their rows go with the
    // wholesale rebuild below) and re-open them against the fresh rows afterward.
    const openKeys = [...this.openDiffs.keys()];
    for (const entry of this.openDiffs.values()) entry.viewer.dispose();
    this.openDiffs.clear();

    let child = this.list.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.list.remove(child);
      child = next;
    }
    this.fileRows = [];

    if (!this.repo) {
      this.list.append(this.messageRow('Not a git repository'));
      return;
    }

    const changes = getChanges(this.repo);
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

    const restore =
      (prevKey && this.fileRows.find((r) => this.key(r.change, r.kind) === prevKey)) ||
      this.fileRows[0];
    if (restore) this.list.selectRow(restore.row);
    if (keepFocus) this.list.grabFocus();

    // Re-open any diffs whose row still exists (e.g. staging moved it between groups).
    for (const key of openKeys) {
      const info = this.fileRows.find((r) => this.key(r.change, r.kind) === key);
      if (info) this.openDiff(info);
    }

    setTimeout(() => {
      this.root.getVadjustment().setValue(scrollValue);
    }, 0);
  }

  private addGroup(title: string, changes: GitChange[], kind: RowKind): void {
    this.list.append(this.headerRow(`${title} (${changes.length})`));
    for (const change of changes) {
      const row = this.buildRow(change, kind);
      this.fileRows.push({ change, kind, row });
      this.list.append(row);
    }
  }

  private buildRow(change: GitChange, kind: RowKind): InstanceType<typeof Gtk.ListBoxRow> {
    // A fixed-width status column at the left holding the `D` of a deletion (the only
    // porcelain letter we keep) — reserved even when blank so every path lines up.
    const badge = new Gtk.Label({ label: change.state === 'deleted' ? STATE_LETTER.deleted : '', xalign: 0 });
    badge.addCssClass('git-badge');
    badge.setWidthChars(1);

    const name = new Gtk.Label({ label: change.relPath, xalign: 0, hexpand: true });
    name.addCssClass('git-path'); // monospace; colored green/red by the row's kind class
    name.setEllipsize(Pango.EllipsizeMode.START); // keep the filename end visible

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    box.setName('GitRow');
    box.addCssClass(kind); // `staged` | `unstaged` — drives the path (and badge) color
    box.append(badge);
    box.append(name);

    const row = new Gtk.ListBoxRow();
    row.setChild(box);
    row.setTooltipText(change.relPath);
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

  private hasFocusWithin(): boolean {
    const win = this.root.getRoot() as { getFocus?: () => InstanceType<typeof Gtk.Widget> | null } | null;
    let current: InstanceType<typeof Gtk.Widget> | null = win?.getFocus?.() ?? null;
    while (current) {
      if (current === this.root) return true;
      current = current.getParent();
    }
    return false;
  }
}
