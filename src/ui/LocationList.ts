/*
 * LocationList — a shared, keyboard-navigable list of file locations.
 *
 * A reusable building block for any feature that presents "jump to this spot in
 * a file" results: the LSP Diagnostics panel today, project-wide search and
 * others later. Consumers feed it `LocationItem`s and an `onActivate` callback;
 * the list owns the rendering, selection, and navigation keybindings so every
 * such panel behaves identically.
 *
 * Each row shows an optional leading Nerd Font glyph, the muted location
 * (`file:line`) first, then the content text. Navigation is the project's
 * vim-style list convention (`j`/`k`, `g g`/`G`, `l`/Enter to open), bound to
 * `.LocationList` in the central keymap and backed by the `core:*` commands
 * registered here.
 */
import { Gtk, Pango } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { zym } from '../zym.ts';
import { CompositeDisposable } from '../util/eventKit.ts';

export interface LocationItem {
  /** Jump target. */
  path: string;
  line: number; // 0-based row
  character: number; // 0-based column
  /** Optional leading glyph (a Nerd Font code point) and its color. */
  glyph?: string;
  glyphColor?: string;
  /** Muted prefix shown first, e.g. `file.ts:13`. */
  location: string;
  /** Main content, e.g. the diagnostic message or the matched line. */
  text: string;
}

export interface LocationListOptions {
  /** Text shown when the list is empty. */
  emptyText?: string;
  /** Invoked when a row is activated (click / Enter / `l`). */
  onActivate: (item: LocationItem) => void;
}

// Row glyphs render a touch smaller than the text (Pango relative size).
const ICON_SIZE = '85%';
addStyles(`
  .LocationList .locationlist-location { color: var(--t-ui-text-muted); }
  .LocationList .locationlist-empty { color: var(--t-ui-text-muted); padding: 12px; }
  /* Selected row: theme selection color while the list is active (focused), a
     muted (faded) version of it otherwise. */
  .LocationList list row:selected { background-color: alpha(var(--t-ui-surface-selected), 0.4); }
  .LocationList:focus-within list row:selected { background-color: var(--t-ui-surface-selected); }
`);

export class LocationList {
  readonly root: InstanceType<typeof Gtk.Box>;

  private readonly listBox: InstanceType<typeof Gtk.ListBox>;
  private readonly scrolled: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly empty: InstanceType<typeof Gtk.Label>;
  private readonly onActivate: (item: LocationItem) => void;
  private items: LocationItem[] = [];
  private readonly subs = new CompositeDisposable();

  constructor(options: LocationListOptions) {
    this.onActivate = options.onActivate;

    this.listBox = new Gtk.ListBox();
    this.listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);
    this.listBox.on('row-activated', (row: any) => this.activate(row.getIndex()));

    this.scrolled = new Gtk.ScrolledWindow();
    this.scrolled.setChild(this.listBox);
    this.scrolled.setVexpand(true);

    this.empty = new Gtk.Label({ label: options.emptyText ?? 'Nothing here', xalign: 0 });
    this.empty.addCssClass('locationlist-empty');

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.addCssClass('LocationList');
    this.root.append(this.scrolled);
    this.root.append(this.empty);

    this.registerCommands();
    this.setItems([]);
  }

  /** Replace the list contents. */
  setItems(items: LocationItem[]): void {
    let child = this.listBox.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.listBox.remove(child);
      child = next;
    }
    this.items = items;
    for (const item of items) this.listBox.append(this.buildRow(item));

    const has = items.length > 0;
    this.scrolled.setVisible(has);
    this.empty.setVisible(!has);
  }

  /** Move keyboard focus into the list. */
  focus(): void {
    this.listBox.grabFocus();
  }

  private buildRow(item: LocationItem): InstanceType<typeof Gtk.ListBoxRow> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });

    if (item.glyph) {
      const icon = new Gtk.Label({ xalign: 0.5 });
      icon.setMarkup(`<span face="${ICON_FONT_FAMILY}" size="${ICON_SIZE}" foreground="${item.glyphColor ?? theme.ui.editor.foreground}">${item.glyph}</span>`);
      icon.setValign(Gtk.Align.START);
      box.append(icon);
    }

    const location = new Gtk.Label({ xalign: 0 });
    location.addCssClass('locationlist-location'); // muted
    location.setText(item.location);
    location.setValign(Gtk.Align.START);
    box.append(location);

    const text = new Gtk.Label({ xalign: 0, hexpand: true });
    text.setEllipsize(Pango.EllipsizeMode.END);
    text.setText(item.text);
    box.append(text);

    const row = new Gtk.ListBoxRow();
    row.setChild(box);
    return row;
  }

  private activate(index: number): void {
    const item = this.items[index];
    if (item) this.onActivate(item);
  }

  private registerCommands(): void {
    // The keymap (`.LocationList`) binds j/k/g g/G/l to these — shared by every
    // LocationList instance.
    this.subs.add(
      zym.commands.add(this.root, {
        'core:down': { didDispatch: () => this.moveSelection(1), description: 'Move down' },
        'core:up': { didDispatch: () => this.moveSelection(-1), description: 'Move up' },
        'core:top': { didDispatch: () => this.selectIndex(0), description: 'Go to the top' },
        'core:bottom': { didDispatch: () => this.selectIndex(this.items.length - 1), description: 'Go to the bottom' },
        'core:right': {
          didDispatch: () => {
            const row = this.listBox.getSelectedRow();
            if (row) this.activate(row.getIndex());
          },
          description: 'Open the selection',
        },
      }),
    );
  }

  private moveSelection(delta: number): void {
    if (this.items.length === 0) return;
    const selected = this.listBox.getSelectedRow();
    this.selectIndex((selected ? selected.getIndex() : -1) + delta);
  }

  private selectIndex(index: number): void {
    if (this.items.length === 0) return;
    const clamped = Math.max(0, Math.min(index, this.items.length - 1));
    const row = this.listBox.getRowAtIndex(clamped);
    if (row) {
      this.listBox.selectRow(row);
      row.grabFocus();
    }
  }

  dispose(): void {
    this.subs.dispose();
  }
}
