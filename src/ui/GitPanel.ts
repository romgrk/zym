/*
 * GitPanel — the git status panel (left dock, above the file tree).
 *
 * A single list of changed files in three groups — Staged / Changes / Untracked
 * — with a cursor (the selected row) driven by vim-style keys: j/k move, l opens
 * the file, s/u stage/unstage, X discards, and `c c` starts a commit. The mouse
 * works too: a click selects, a double-click opens the file. Reads and
 * mutations go through the git facade (`git.ts`, node `git` CLI); the panel refreshes on its
 * own operations and on `GitRepo.onChange` (external edits). Failures surface
 * through `quilx.notifications`.
 *
 * The commit message is edited in a normal editor tab (see AppWindow.onCommit);
 * this widget just presents status. The assembled panel is exposed via `root`.
 */
import * as Path from 'node:path';
import { Gtk, Pango } from '../gi.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { quilx } from '../quilx.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import { fileIconGlyph } from './fileIcons.ts';
import type { GitRepo } from '../git.ts';
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
  /** Open the file under the cursor in the editor (the `l` key). */
  onOpenFile: (path: string) => void;
  /** Start a commit: edit the message and commit on save (the `c c` chord). */
  onCommit: () => void;
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

// Compact, dense rows. The theme background/selection are applied centrally in
// AppWindow; file rows follow the theme foreground (the badge keeps its own
// per-status color via Pango markup, which overrides the CSS color).
addStyles(`
  /* No font-size override: section headers inherit the default label size, the
     same size every other label (file rows, file-tree headers) uses. */
  #GitPanel .git-header {
    color: ${theme.ui.text.muted};
    font-weight: bold;
    padding: 6px 8px 3px 8px;
  }
  #GitPanel #GitRow label { color: ${theme.ui.editor.foreground}; }
  #GitPanel #GitRow .git-icon { color: ${theme.ui.text.muted}; }
  #GitPanel row { min-height: 0; }
  #GitPanel #GitRow { padding: 0 8px 0 16px; } /* indent entries under the section header */
  #GitPanel .git-badge { font-weight: bold; font-feature-settings: "tnum" 1; }
  /* The cursor (selected row) is highlighted with the theme selection color, and
     only while the panel is focused — an unfocused panel shows no highlight. */
  #GitPanel row:selected { background-color: transparent; }
  #GitPanel:focus-within row:selected {
    background-color: ${theme.ui.surface.selected};
  }
`);

export class GitPanel {
  readonly root: InstanceType<typeof Gtk.Box>;

  // git/repo are swapped by `setRoot` when an agent re-roots into a worktree.
  private git: GitRepo;
  private repo: string | null; // repository top-level, or null outside a repo
  private readonly onOpenFile: (path: string) => void;
  private readonly onCommit: () => void;
  private readonly subs = new CompositeDisposable();
  private gitUnsub?: () => void; // the active git's onChange subscription
  private readonly list: InstanceType<typeof Gtk.ListBox>;
  private readonly scrolled: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly iconAttrs: InstanceType<typeof Pango.AttrList>;
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

    this.iconAttrs = Pango.AttrList.new();
    this.iconAttrs.insert(Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)));

    this.list = new Gtk.ListBox();
    this.list.setSelectionMode(Gtk.SelectionMode.SINGLE); // the selected row is the cursor

    this.scrolled = new Gtk.ScrolledWindow();
    this.scrolled.setChild(this.list);
    this.scrolled.setVexpand(true);

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.setName('GitPanel'); // selector identity for command/keymap + CSS
    this.root.append(this.scrolled);

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
    this.gitUnsub?.();
    this.subs.dispose();
  }

  // --- Commands (vim-style; bindings live in the central keymap) --------------

  private registerCommands(): void {
    quilx.commands.add(this.root, {
      'core:down': { didDispatch: () => this.move(+1), description: 'Move down' },
      'core:up': { didDispatch: () => this.move(-1), description: 'Move up' },
      'core:top': { didDispatch: () => this.selectIndex(0), description: 'Go to the top' }, // `g g`
      'core:bottom': { didDispatch: () => this.selectIndex(this.fileRows.length - 1), description: 'Go to the bottom' }, // `G`
      'core:right': { didDispatch: () => this.openSelected(), description: 'Open the selected file' }, // `l` — edit, like the file tree
      'git:stage': { didDispatch: () => this.act((c) => stage(this.repo!, c.relPath, this.done)), description: 'Stage changes' },
      'git:unstage': { didDispatch: () => this.act((c) => unstage(this.repo!, c.relPath, this.done)), description: 'Unstage changes' },
      'git:stage-all': { didDispatch: () => this.stageAllToggle(), description: 'Stage / unstage all' }, // `A`
      'git:discard': { didDispatch: () => this.discardSelected(), description: 'Discard changes' },
      'git:commit': { didDispatch: () => this.onCommit(), description: 'Commit staged changes' },
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
    if (info) this.open(info.change);
  }

  // Open a change's file. Untracked entries can be whole directories (porcelain
  // lists them with a trailing slash); opening one isn't implemented yet.
  private open(change: GitChange): void {
    if (change.relPath.endsWith('/')) {
      quilx.notifications.addTrace(`Opening a directory is not implemented: ${change.relPath}`);
      return;
    }
    this.onOpenFile(change.path);
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
    if (!ok) quilx.notifications.addError('Git operation failed', { detail: err.trim() });
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
   *  only restored when it was inside this panel (never stealing it from the
   *  editor); the list — not the row — is focused so selection doesn't force a
   *  scroll-into-view, and the offset is reapplied after layout. */
  private applyChanges(changes: GitChange[] | null, generation: number): void {
    if (generation !== this.refreshGeneration) return; // a newer refresh is in flight

    const prevKey = this.selectedKey();
    const keepFocus = this.hasFocusWithin();
    const scrollValue = this.scrolled.getVadjustment().getValue();

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
    for (const change of changes) {
      const row = this.buildRow(change, kind);
      this.fileRows.push({ change, kind, row });
      this.list.append(row);
    }
  }

  private buildRow(change: GitChange, kind: RowKind): InstanceType<typeof Gtk.ListBoxRow> {
    const icon = new Gtk.Label({ label: fileIconGlyph(Path.basename(change.relPath), false) });
    icon.setAttributes(this.iconAttrs);
    icon.addCssClass('git-icon'); // muted, less prominent than the filename

    const name = new Gtk.Label({ label: change.relPath, xalign: 0, hexpand: true });
    name.setEllipsize(Pango.EllipsizeMode.START); // keep the filename end visible

    const badgeColor = kind === 'staged' ? STAGED_COLOR : UNSTAGED_COLOR;
    const badge = new Gtk.Label();
    badge.addCssClass('git-badge');
    badge.setMarkup(`<span foreground="${badgeColor}">${STATE_LETTER[change.state]}</span>`);

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    box.setName('GitRow');
    box.append(icon);
    box.append(name);
    box.append(badge);

    const row = new Gtk.ListBoxRow();
    row.setChild(box);
    row.setTooltipText(change.relPath);

    // Double-click opens the file (staging is the s/u keys on the cursor).
    const gesture = new Gtk.GestureClick();
    gesture.on('pressed', (nPress: number) => {
      if (nPress === 2) this.open(change);
    });
    row.addController(gesture);
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

  /** Whether keyboard focus currently sits anywhere inside this panel. */
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
