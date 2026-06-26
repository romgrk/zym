/*
 * FileTree — a lazily-expanding directory tree of a root folder (typically the
 * cwd). Each directory is enumerated in JS into a sorted GListStore (directories
 * first, then by name) which a GtkTreeListModel expands lazily per directory;
 * activating a file row invokes `onOpenFile` with its absolute path, while
 * activating a directory toggles its expansion. The assembled, scrollable tree
 * is exposed via `root`.
 */
import * as Os from 'node:os';
import * as Path from 'node:path';
import { Gio, GObject, Gtk, Pango } from '../gi.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { zym } from '../zym.ts';
import type { Disposable } from '../util/eventKit.ts';
import type { GitRepo, FileGitStatus } from '../git.ts';
import { fileIconGlyph } from './fileIcons.ts';

// The file-tree filters are global config (so they can be set in config.json and
// observed live). Defaults: both on — hide dotfiles and untracked files. The
// `.`/`,` keys toggle these values; each FileTree observes them (see ctor).
const treeConfig = zym.config.scope('fileTree').register({
  hideHidden: {
    type: 'boolean',
    default: true,
    description: 'Hide dotfiles (POSIX hidden files) in the file tree.',
  },
  hideUntracked: {
    type: 'boolean',
    default: true,
    description: 'Hide files not tracked by git in the file tree (only inside a repo).',
  },
});

/** A directory path for display: the home directory collapsed to `~`. */
function displayPath(path: string): string {
  const home = Os.homedir();
  if (path === home) return '~';
  if (path.startsWith(home + Path.sep)) return '~' + path.slice(home.length);
  return path;
}

// Git diff colors (theme success/error), matching GitBranchButton.
const GIT_ADDED_COLOR = theme.ui.status.success;
const GIT_REMOVED_COLOR = theme.ui.status.error;

/** Pango markup for a file's git status: `?` for untracked, else +added/-removed.
 *  Colors are per-segment; the wrapper makes the digits bold, slightly smaller,
 *  and tabular (so they stay aligned across rows). */
function statusMarkup(status: FileGitStatus | undefined): string {
  let inner = '';
  if (status?.kind === 'untracked') {
    inner = `<span foreground="${GIT_ADDED_COLOR}">?</span>`;
  } else if (status?.kind === 'modified') {
    const parts: string[] = [];
    if (status.added > 0) parts.push(`<span foreground="${GIT_ADDED_COLOR}">+${status.added}</span>`);
    if (status.removed > 0) parts.push(`<span foreground="${GIT_REMOVED_COLOR}">-${status.removed}</span>`);
    inner = parts.join(' ');
  }
  if (!inner) return '';
  return `<span weight="bold" size="smaller" font_features="tnum=1">${inner}</span>`;
}

// Use the active theme's foreground for tree text/icons (rather than Adwaita's
// default), to match the editor. `.FileTree` is the ScrolledWindow's component
// CSS class (`addCssClass`). Target `label` directly — Adwaita colors row text
// on an inner node, so a color on the container won't inherit down — and exclude
// `:selected` rows so the selection keeps its own contrast.
addStyles(`
  .FileTree .filetree-header {
    color: var(--t-ui-text-muted);
    font-weight: bold;
    padding: 6px 8px;
  }
  .FileTree row:not(:selected) label {
    color: var(--t-ui-editor-foreground);
  }
  .FileTree row:not(:selected) .filetree-icon {
    color: var(--t-ui-text-muted); /* mute the file-type icon */
  }
  .FileTree expander {
    color: alpha(var(--t-ui-editor-foreground), 0.45); /* mute the disclosure chevron */
  }
  /* When the tree isn't focused, drop the accent selection background (and
     restore normal text) so the selected row reads as inactive; it regains the
     accent highlight once the tree is focused again. */
  .FileTree:not(:focus-within) row:selected {
    background: none;
  }
  .FileTree:not(:focus-within) row:selected label {
    color: var(--t-ui-editor-foreground);
  }
`);

const SIDEBAR_ATTRS = 'standard::name,standard::type';
const FILE_INFO_GTYPE = GObject.typeFromName('GFileInfo');

type GFile = ReturnType<typeof Gio.File.newForPath>;

// node-gtk does not expose GFile's interface methods on instances (they resolve
// to undefined on the concrete GLocalFile wrapper), so we reach them through the
// interface prototype. See https://github.com/romgrk/node-gtk for the quirk.
const FileProto = (Gio.File as any).prototype;
const enumerateChildren = (file: GFile): InstanceType<typeof Gio.FileEnumerator> =>
  FileProto.enumerateChildren.call(
    file,
    SIDEBAR_ATTRS,
    Gio.FileQueryInfoFlags.NONE,
    null,
  );
const pathOf = (file: GFile): string | null => FileProto.getPath.call(file);

/** Decides whether a directory entry is shown (by name, absolute path, kind). */
type VisibleFn = (name: string, path: string | null, isDir: boolean) => boolean;

/**
 * A directory's contents as a model sorted directories-first, then entries
 * ordered case-insensitively by name, with entries rejected by `isVisible`
 * filtered out. GtkCustomSorter/GtkCustomFilter can't be used here — node-gtk
 * hands their `gconstpointer`/`gpointer` callback args to JS as `undefined` — so
 * we enumerate, filter, and sort in JS into a GListStore instead. Each surviving
 * row's GFile is stashed under `standard::file` for later expansion / opening.
 */
function sortedDirectory(file: GFile, isVisible: VisibleFn): InstanceType<typeof Gio.ListStore> {
  const store = Gio.ListStore.new(FILE_INFO_GTYPE);

  let enumerator: InstanceType<typeof Gio.FileEnumerator>;
  try {
    enumerator = enumerateChildren(file);
  } catch {
    return store; // unreadable directory (e.g. permission denied) → empty
  }

  const infos: Array<InstanceType<typeof Gio.FileInfo>> = [];
  let info: InstanceType<typeof Gio.FileInfo> | null;
  while ((info = enumerator.nextFile(null)) !== null) {
    const child = enumerator.getChild(info);
    const isDir = info.getFileType() === Gio.FileType.DIRECTORY;
    if (!isVisible(info.getName(), pathOf(child), isDir)) continue;
    info.setAttributeObject('standard::file', child as any);
    infos.push(info);
  }
  enumerator.close(null);

  infos.sort((a, b) => {
    const aDir = a.getFileType() === Gio.FileType.DIRECTORY;
    const bDir = b.getFileType() === Gio.FileType.DIRECTORY;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.getName().toLowerCase().localeCompare(b.getName().toLowerCase());
  });
  for (const each of infos) store.append(each);

  return store;
}

export interface FileTreeOptions {
  rootPath: string;
  onOpenFile: (path: string) => void;
  /** When provided, rows show the file's git status (untracked / +/- lines). */
  git?: GitRepo;
}

export class FileTree {
  readonly root: InstanceType<typeof Gtk.Box>;

  private readonly list: InstanceType<typeof Gtk.ListView>;
  private tree: InstanceType<typeof Gtk.TreeListModel>;
  private readonly selection: InstanceType<typeof Gtk.SingleSelection>;
  private readonly onOpenFile: (path: string) => void;
  // Root + git are swapped by `setRoot` when an agent re-roots into a worktree.
  private rootFile: GFile;
  private header!: InstanceType<typeof Gtk.Label>;

  private git?: GitRepo;
  private statuses = new Map<string, FileGitStatus>();
  private readonly boundItems = new Set<any>();
  private gitUnsubscribe?: () => void;

  // Filters, seeded from `fileTree.*` config and kept in sync via observers (so a
  // config.json edit or the `.`/`,` toggles update the tree live). The untracked
  // filter only takes effect inside a git repo.
  private hideHidden: boolean;
  private hideUntracked: boolean;
  private trackedFiles = new Set<string>(); // absolute paths tracked by git
  private trackedDirs = new Set<string>();  // their ancestor directories
  private readonly configDisposables: Disposable[] = [];

  constructor(options: FileTreeOptions) {
    this.onOpenFile = options.onOpenFile;
    this.git = options.git;
    this.rootFile = Gio.File.newForPath(options.rootPath);
    this.hideHidden = treeConfig.get('hideHidden') === true;
    this.hideUntracked = treeConfig.get('hideUntracked') === true;
    if (this.git) {
      this.statuses = this.git.getFileStatuses();
      this.refreshTracked();
    }

    const tree = this.buildTree();
    const selection = new Gtk.SingleSelection({ model: tree });

    // Each row is a TreeExpander (for the disclosure triangle) wrapping a box of
    // [icon label, name label]. The icon is a Nerd Font glyph rendered in the
    // bundled icon font; as plain label text it inherits the theme foreground
    // color (so icons are monochrome and follow light/dark themes).
    const iconAttrs = Pango.AttrList.new();
    iconAttrs.insert(
      Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)),
    );

    const factory = new Gtk.SignalListItemFactory();
    factory.on('setup', (listItem: any) => {
      const expander = new Gtk.TreeExpander();
      const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
      const icon = new Gtk.Label({ xalign: 0 });
      icon.setAttributes(iconAttrs);
      icon.addCssClass('filetree-icon'); // muted, less prominent than the filename
      const name = new Gtk.Label({ xalign: 0, hexpand: true }); // push status to the right
      const status = new Gtk.Label({ xalign: 1, marginEnd: 6 });
      box.append(icon);
      box.append(name);
      box.append(status);
      expander.setChild(box);
      listItem.setChild(expander);
    });
    factory.on('bind', (listItem: any) => {
      const row = listItem.getItem();
      const expander = listItem.getChild();
      expander.setListRow(row);

      const info = row.getItem();
      const box = expander.getChild();
      const iconLabel = box.getFirstChild();
      const nameLabel = iconLabel.getNextSibling();

      const name = info.getName();
      const isDir = info.getFileType() === Gio.FileType.DIRECTORY;
      iconLabel.setText(fileIconGlyph(name, isDir));
      nameLabel.setText(name);

      this.boundItems.add(listItem);
      this.applyStatus(listItem);
    });
    factory.on('unbind', (listItem: any) => {
      this.boundItems.delete(listItem);
    });

    const list = new Gtk.ListView({ model: selection, factory });
    list.on('activate', (position: number) => {
      const row = tree.getRow(position);
      if (row) this.activateRow(row);
    });

    const scrolled = new Gtk.ScrolledWindow();
    scrolled.setChild(list);
    scrolled.setVexpand(true);

    // Header label: the root directory's full path (home collapsed to `~`), with
    // the real absolute path as the tooltip.
    const header = new Gtk.Label({
      label: displayPath(options.rootPath),
      tooltipText: options.rootPath,
      xalign: 0,
      ellipsize: Pango.EllipsizeMode.END,
    });
    header.addCssClass('filetree-header');
    this.header = header;

    const rootBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    rootBox.addCssClass('FileTree');
    rootBox.append(header);
    rootBox.append(scrolled);

    this.root = rootBox;
    this.list = list;
    this.tree = tree;
    this.selection = selection;

    this.registerCommands();

    // Apply (and follow) the configured filter values. observe fires immediately
    // with the current value — which equals the field seeded above, so the guard
    // in each setter skips a redundant initial rebuild — then again whenever the
    // config changes (user config.json load, or the toggle commands below).
    this.configDisposables.push(
      treeConfig.observe('hideHidden', (v) => this.setHideHidden(v === true)),
      treeConfig.observe('hideUntracked', (v) => this.setHideUntracked(v === true)),
    );

    if (this.git) this.gitUnsubscribe = this.git.onChange(() => this.refreshStatuses());
  }

  /** Move keyboard focus into the tree. */
  focus() {
    this.list.grabFocus();
  }

  /** Re-root the tree at `rootPath` (with `git`) when an agent moves into a
   *  worktree. Rebuilds the model in place — expand state is reset, which is fine
   *  for a re-root; the widget/tabs/commands stay put. */
  setRoot(rootPath: string, git?: GitRepo): void {
    this.gitUnsubscribe?.();
    this.gitUnsubscribe = undefined;
    this.git = git;
    this.rootFile = Gio.File.newForPath(rootPath);
    this.statuses = git ? git.getFileStatuses() : new Map();
    this.trackedFiles = new Set();
    this.trackedDirs = new Set();
    if (git) this.refreshTracked();
    this.header.setLabel(displayPath(rootPath));
    this.header.setTooltipText(rootPath);
    this.tree = this.buildTree();
    this.selection.setModel(this.tree);
    if (git) this.gitUnsubscribe = git.onChange(() => this.refreshStatuses());
  }

  /** Release the git subscription and config observers. */
  dispose() {
    this.gitUnsubscribe?.();
    for (const d of this.configDisposables) d.dispose();
  }

  // --- Session integration -------------------------------------------------

  /** The absolute paths of every currently-expanded directory, for the session. */
  serializeExpanded(): string[] {
    const out: string[] = [];
    const n = this.tree.getNItems();
    for (let i = 0; i < n; i++) {
      const row = this.tree.getRow(i);
      if (!row || !this.isDirectory(row) || !row.getExpanded()) continue;
      const path = pathOf((row.getItem() as any).getAttributeObject('standard::file'));
      if (path) out.push(path);
    }
    return out;
  }

  /**
   * Re-expand the saved directories. Expansion is lazy — opening a directory
   * appends its children to the flat model — so this sweeps repeatedly, expanding
   * any wanted directory it finds unopened, until a pass reveals nothing new.
   */
  restoreExpanded(paths: string[]): void {
    if (paths.length === 0) return;
    const want = new Set(paths);
    // Bounded against a pathological model; each productive pass expands ≥1 row.
    for (let guard = 0; guard < 10_000; guard++) {
      let changed = false;
      const n = this.tree.getNItems();
      for (let i = 0; i < n; i++) {
        const row = this.tree.getRow(i);
        if (!row || !this.isDirectory(row) || row.getExpanded()) continue;
        const path = pathOf((row.getItem() as any).getAttributeObject('standard::file'));
        if (path && want.has(path)) {
          row.setExpanded(true);
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  // --- Filters -------------------------------------------------------------

  /** Apply a new value for the dotfiles filter (driven by `tree.hideHidden`). */
  private setHideHidden(value: boolean): void {
    if (value === this.hideHidden) return;
    this.hideHidden = value;
    this.rebuild();
  }

  /** Apply a new value for the git filter (driven by `tree.hideUntracked`). */
  private setHideUntracked(value: boolean): void {
    if (value === this.hideUntracked) return;
    this.hideUntracked = value;
    if (this.hideUntracked) this.refreshTracked();
    this.rebuild();
  }

  /** Whether a directory entry passes the active filters. */
  private isVisible(name: string, path: string | null, isDir: boolean): boolean {
    if (this.hideHidden && name.startsWith('.')) return false;
    // The untracked filter only applies inside an actual repo; for a plain
    // directory the (dormant) repo reports nothing tracked, so gating on `git`
    // alone would hide every file. See git.ts `isRepo`.
    if (this.hideUntracked && this.git?.isRepo()) {
      if (!path) return false;
      // Show tracked files, and directories that contain a tracked file.
      return isDir ? this.trackedDirs.has(path) : this.trackedFiles.has(path);
    }
    return true;
  }

  /** A fresh TreeListModel for the root, lazily expanding through the filters. */
  private buildTree(): InstanceType<typeof Gtk.TreeListModel> {
    const isVisible: VisibleFn = (name, path, isDir) => this.isVisible(name, path, isDir);
    return Gtk.TreeListModel.new(
      sortedDirectory(this.rootFile, isVisible),
      false,
      false,
      (item: any) =>
        item.getFileType() !== Gio.FileType.DIRECTORY
          ? null
          : sortedDirectory(item.getAttributeObject('standard::file'), isVisible),
    );
  }

  /** Re-derive the visible tree after a filter change (resets expansion). */
  private rebuild(): void {
    this.tree = this.buildTree();
    this.selection.setModel(this.tree);
  }

  /** Refresh the tracked-paths set (and its ancestor directories) from git.
   *  Returns whether the tracked file set actually changed (the first poll
   *  landing, or an add/rm/commit) — plain working-tree edits leave it untouched,
   *  so callers can skip a needless rebuild. */
  private refreshTracked(): boolean {
    if (!this.git) return false;
    const next = this.git.getTrackedPaths();
    const changed =
      next.size !== this.trackedFiles.size || [...next].some((p) => !this.trackedFiles.has(p));
    this.trackedFiles = next;
    this.trackedDirs = new Set();
    for (const file of this.trackedFiles) {
      let dir = Path.dirname(file);
      while (!this.trackedDirs.has(dir)) {
        this.trackedDirs.add(dir);
        const parent = Path.dirname(dir);
        if (parent === dir) break; // reached filesystem root
        dir = parent;
      }
    }
    return changed;
  }

  // --- Git status ----------------------------------------------------------

  /** Recompute statuses (and tracked set) and refresh every bound row. */
  private refreshStatuses(): void {
    if (!this.git) return;
    this.statuses = this.git.getFileStatuses();
    const trackedChanged = this.refreshTracked(); // keep the tracked filter current
    // When the untracked filter is active the visible rows are derived from the
    // tracked set, so a change there must rebuild the tree — otherwise it keeps
    // showing a stale (and, on a fresh repo whose first poll only just landed,
    // empty) view. This is what fills in the tree after construction/re-root,
    // since the git warm-up populates the tracked set asynchronously.
    if (trackedChanged && this.hideUntracked) {
      const expanded = this.serializeExpanded();
      this.rebuild();
      this.restoreExpanded(expanded);
    }
    for (const listItem of this.boundItems) this.applyStatus(listItem);
  }

  /** Update one row's status label from the current status map. */
  private applyStatus(listItem: any): void {
    const row = listItem.getItem();
    if (!row) return;
    const file = (row.getItem()).getAttributeObject('standard::file');
    const path = file ? pathOf(file) : null;
    const markup = statusMarkup(path ? this.statuses.get(path) : undefined);

    const statusLabel = listItem.getChild().getChild().getLastChild();
    statusLabel.setVisible(markup !== '');
    if (markup) statusLabel.setMarkup(markup);
    else statusLabel.setText('');
  }

  // --- Navigation ----------------------------------------------------------

  private registerCommands(): void {
    zym.commands.add(this.root, {
      'core:down': { didDispatch: () => this.move(+1), description: 'Move down' },
      'core:up': { didDispatch: () => this.move(-1), description: 'Move up' },
      'core:top': { didDispatch: () => this.select(0), description: 'Go to the top' }, // `g g`
      'core:bottom': { didDispatch: () => this.select(this.tree.getNItems() - 1), description: 'Go to the bottom' }, // `G`
      'core:right': { didDispatch: () => this.enter(), description: 'Expand / open' },
      'core:left': { didDispatch: () => this.exit(), description: 'Collapse / go to parent' },
      // Toggle the config value; the observer applies it and rebuilds.
      'tree:toggle-hidden-files': { didDispatch: () => treeConfig.toggle('hideHidden'), description: 'Toggle hidden files' },
      'tree:toggle-untracked-files': { didDispatch: () => treeConfig.toggle('hideUntracked'), description: 'Toggle untracked files' },
    });
  }

  /** Select (and scroll/focus) the row `delta` steps from the current one. */
  private move(delta: number): void {
    const pos = this.selection.getSelected();
    this.select(pos === Gtk.INVALID_LIST_POSITION ? 0 : pos + delta);
  }

  /** Enter the selected row: expand a directory (or step into an open one),
   *  or open a file. */
  private enter(): void {
    const pos = this.selection.getSelected();
    if (pos === Gtk.INVALID_LIST_POSITION) return this.select(0);
    const row = this.tree.getRow(pos);
    if (!row) return;
    if (this.isDirectory(row)) {
      if (!row.getExpanded()) row.setExpanded(true);
      else this.select(pos + 1); // already open → step into first child
    } else {
      this.openFile(row);
    }
  }

  /** Exit the selected row: collapse an open directory, else jump to the parent. */
  private exit(): void {
    const pos = this.selection.getSelected();
    if (pos === Gtk.INVALID_LIST_POSITION) return;
    const row = this.tree.getRow(pos);
    if (!row) return;
    if (this.isDirectory(row) && row.getExpanded()) {
      row.setExpanded(false);
    } else {
      const parent = row.getParent();
      if (parent) this.select(parent.getPosition());
    }
  }

  /** Activate (Enter / double-click): toggle a directory, or open a file. */
  private activateRow(row: InstanceType<typeof Gtk.TreeListRow>): void {
    if (this.isDirectory(row)) row.setExpanded(!row.getExpanded());
    else this.openFile(row);
  }

  private openFile(row: InstanceType<typeof Gtk.TreeListRow>): void {
    const info: any = row.getItem();
    const path = pathOf(info.getAttributeObject('standard::file'));
    if (path) this.onOpenFile(path);
  }

  private isDirectory(row: InstanceType<typeof Gtk.TreeListRow>): boolean {
    return (row.getItem() as any).getFileType() === Gio.FileType.DIRECTORY;
  }

  /** Clamp `pos` into range, select it, and scroll it into view with focus. */
  private select(pos: number): void {
    const n = this.tree.getNItems();
    if (n === 0) return;
    const clamped = Math.max(0, Math.min(pos, n - 1));
    this.selection.setSelected(clamped);
    this.list.scrollTo(clamped, Gtk.ListScrollFlags.FOCUS, null);
  }
}
