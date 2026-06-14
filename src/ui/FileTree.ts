/*
 * FileTree — a lazily-expanding directory tree of a root folder (typically the
 * cwd). Each directory is enumerated in JS into a sorted GListStore (directories
 * first, then by name) which a GtkTreeListModel expands lazily per directory;
 * activating a file row invokes `onOpenFile` with its absolute path, while
 * activating a directory toggles its expansion. The assembled, scrollable tree
 * is exposed via `root`.
 */
import { Gio, GObject, Gtk, Pango } from '../gi.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { fileIconGlyph } from './fileIcons.ts';

// Use the active theme's foreground for tree text/icons (rather than Adwaita's
// default), to match the editor. Selection state still overrides it per-row.
addStyles(`.quilx-filetree { color: ${theme.ui.fg}; }`);

const SIDEBAR_ATTRS = 'standard::name,standard::type';
const FILE_INFO_GTYPE = GObject.typeFromName('GFileInfo');

type GFile = ReturnType<typeof Gio.File.newForPath>;

// node-gtk does not expose GFile's interface methods on instances (they resolve
// to undefined on the concrete GLocalFile wrapper), so we reach them through the
// interface prototype. See https://github.com/romgrk/node-gtk for the quirk.
const FileProto = (Gio.File as any).prototype;
const enumerateChildren = (file: GFile): InstanceType<typeof Gio.FileEnumerator> =>
  FileProto.enumerateChildren.call(file, SIDEBAR_ATTRS, Gio.FileQueryInfoFlags.NONE, null);
const pathOf = (file: GFile): string | null => FileProto.getPath.call(file);

/**
 * A directory's contents as a model sorted directories-first, then entries
 * ordered case-insensitively by name. GtkCustomSorter can't be used here —
 * node-gtk hands its compare callback untyped `gconstpointer` args (undefined in
 * JS) — so we enumerate and sort in JS into a GListStore instead. Each row's
 * GFile is stashed under `standard::file` for later expansion / opening.
 */
function sortedDirectory(file: GFile): InstanceType<typeof Gio.ListStore> {
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
    info.setAttributeObject('standard::file', enumerator.getChild(info) as any);
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
}

export class FileTree {
  readonly root: InstanceType<typeof Gtk.ScrolledWindow>;

  private readonly list: InstanceType<typeof Gtk.ListView>;

  constructor(options: FileTreeOptions) {
    const rootList = sortedDirectory(Gio.File.newForPath(options.rootPath));

    const tree = Gtk.TreeListModel.new(rootList, false, false, (item: any) => {
      if (item.getFileType() !== Gio.FileType.DIRECTORY) return null;
      return sortedDirectory(item.getAttributeObject('standard::file') as any);
    });
    const selection = new Gtk.SingleSelection({ model: tree });

    // Each row is a TreeExpander (for the disclosure triangle) wrapping a box of
    // [icon label, name label]. The icon is a Nerd Font glyph rendered in the
    // bundled icon font; as plain label text it inherits the theme foreground
    // color (so icons are monochrome and follow light/dark themes).
    const iconAttrs = Pango.AttrList.new();
    iconAttrs.insert(Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)));

    const factory = new Gtk.SignalListItemFactory();
    factory.on('setup', (listItem: any) => {
      const expander = new Gtk.TreeExpander();
      const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
      const icon = new Gtk.Label({ xalign: 0 });
      icon.setAttributes(iconAttrs);
      box.append(icon);
      box.append(new Gtk.Label({ xalign: 0 }));
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
      const nameLabel = box.getLastChild();

      const name = info.getName();
      const isDir = info.getFileType() === Gio.FileType.DIRECTORY;
      iconLabel.setText(fileIconGlyph(name, isDir));
      nameLabel.setText(name);
    });

    const list = new Gtk.ListView({ model: selection, factory });
    list.on('activate', (position: number) => {
      const row = tree.getRow(position);
      if (!row) return;
      const info: any = row.getItem();
      if (info.getFileType() === Gio.FileType.DIRECTORY) {
        row.setExpanded(!row.getExpanded());
      } else {
        const path = pathOf(info.getAttributeObject('standard::file') as any);
        if (path) options.onOpenFile(path);
      }
    });

    const scrolled = new Gtk.ScrolledWindow();
    scrolled.setName('FileTree'); // selector identity for command/keymap rules
    scrolled.setChild(list);
    scrolled.setVexpand(true);
    this.root = scrolled;
    this.list = list;
  }

  /** Move keyboard focus into the tree. */
  focus() {
    this.list.grabFocus();
  }
}
