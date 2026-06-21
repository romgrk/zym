/*
 * Combobox — a reusable "Picker as a widget": an editable row that drops a filtered
 * list below it, since GTK/Adwaita has no searchable dropdown (Gtk.DropDown is a
 * plain string list with no descriptions or typeahead). The trigger is an
 * Adw.EntryRow, so its `title` floats inside the row like a labelled Adwaita field;
 * click it or type to open the list, which fuzzy-filters as you type. Up/Down move
 * the selection, Enter/click commits, Escape cancels. Selecting fills the row with
 * the option's label and fires `onChange`. Options carry an optional muted `detail`
 * shown right-aligned, reusing the Picker's fuzzy ranking and match highlighting.
 *
 * The list lives in a non-autohide Gtk.Popover parented to the row, so focus stays
 * on the row while filtering (an autohide popover would steal it). Dismissal is
 * handled explicitly: Escape, a commit, or the row losing focus.
 */
import { Gtk, Gdk, Adw, Pango } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { rank, highlightMarkup } from './Picker.ts';

const POPOVER_MAX_HEIGHT = 320;
const DEFAULT_WIDTH = 140;

export interface ComboOption {
  /** Returned by `getValue()` and passed to `onChange` when chosen. */
  value: string;
  /** Shown in the row and as the list item's main (fuzzy-matched) text. */
  label: string;
  /** Optional muted text shown right-aligned in the list item. */
  detail?: string;
}

export interface ComboboxOptions {
  options: ComboOption[];
  /** Initially selected value (defaults to the first option). */
  value?: string;
  /** The floating field label shown inside the row. */
  title?: string;
  /** Row width in px (default 170). */
  width?: number;
  /** Fired when the user commits a different value. */
  onChange?: (value: string) => void;
}

addStyles(/* css */`
  #ComboboxList {
    background: transparent;
    box-shadow: none;
  }
  #ComboboxList > row {
    min-height: 0;
  }
  #ComboboxPopover > contents {
    padding: 0;
    background-color: var(--window-bg-color);
    border: 1px solid var(--border-color);
    border-radius: var(--popover-radius-small);
  }
  #ComboboxMenu {
    border-radius: var(--popover-radius-small);
    background: transparent;
  }
  #ComboboxMenu row { padding: 0; }
  #ComboboxItem {
    padding: 0.35em 0.75em;
  }
  #ComboboxItem > .combobox-detail {
    margin-left: 1em;
    opacity: 0.5;
  }
`);

export class Combobox {
  /** The trigger — a single-row boxed list. Add this to your layout. */
  readonly root: InstanceType<typeof Gtk.ListBox>;

  private options: ComboOption[];
  private value: string;
  private readonly onChange?: (value: string) => void;
  private readonly width: number;

  private readonly row: InstanceType<typeof Adw.EntryRow>;
  private readonly popover: InstanceType<typeof Gtk.Popover>;
  private readonly menu: InstanceType<typeof Gtk.ListBox>;
  private readonly scrolled: InstanceType<typeof Gtk.ScrolledWindow>;

  // Filtered options currently shown, parallel to the menu rows (row index → option).
  private results: ComboOption[] = [];
  private open = false;
  // Suppress the `changed` reaction while we set the row text programmatically
  // (committing a label / restoring it), so it isn't mistaken for the user typing.
  private settingText = false;

  constructor(opts: ComboboxOptions) {
    this.options = opts.options;
    this.onChange = opts.onChange;
    this.width = opts.width ?? DEFAULT_WIDTH;
    this.value = opts.value ?? opts.options[0]?.value ?? '';

    this.row = new Adw.EntryRow();
    this.row.setName('ComboboxRow');
    this.row.addCssClass('has-text-input'); // release the `space` leader so it types
    if (opts.title) this.row.setTitle(opts.title);
    this.row.setShowApplyButton(false);
    this.row.setActivatable(false); // clicking opens the list (below), not "activate"
    const chevron = new Gtk.Image({ iconName: 'pan-down-symbolic' });
    chevron.setOpacity(0.6);
    this.row.addSuffix(chevron);
    this.row.setText(this.selectedLabel()); // before wiring `changed`, so it's silent

    // A single-row boxed list gives the row its Adwaita card framing standalone.
    this.root = new Gtk.ListBox();
    this.root.setName('ComboboxList');
    this.root.addCssClass('boxed-list');
    this.root.setSelectionMode(Gtk.SelectionMode.NONE);
    this.root.setSizeRequest(this.width, -1);
    this.root.append(this.row);

    this.menu = new Gtk.ListBox();
    this.menu.setName('ComboboxMenu');
    this.menu.setSelectionMode(Gtk.SelectionMode.SINGLE);
    this.menu.setFocusable(false); // the row keeps focus; we drive selection

    this.scrolled = new Gtk.ScrolledWindow();
    this.scrolled.setChild(this.menu);
    this.scrolled.setPropagateNaturalHeight(true);
    this.scrolled.setMaxContentHeight(POPOVER_MAX_HEIGHT);
    this.scrolled.setPolicy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);

    this.popover = new Gtk.Popover();
    this.popover.setName('ComboboxPopover');
    this.popover.setAutohide(false); // keep focus on the row while filtering
    this.popover.setHasArrow(false);
    this.popover.setPosition(Gtk.PositionType.BOTTOM);
    this.popover.setChild(this.scrolled);
    this.popover.setParent(this.row);

    // Type to filter (and open). `changed` also fires on programmatic text changes,
    // which `settingText` guards out.
    this.row.on('changed', () => {
      if (this.settingText) return;
      if (!this.open) this.openPopover(false);
      else this.rebuild(this.row.getText() ?? '');
    });
    this.row.on('entry-activated', () => this.chooseSelected());
    this.menu.on('row-activated', (r) => this.chooseRow(r));

    // Click the row (including its chevron) to open the list with all options shown.
    const click = new Gtk.GestureClick();
    click.on('pressed', () => { if (!this.open) this.openPopover(true); });
    this.row.addController(click);

    // Navigation keys, in the capture phase so they act before the row's own entry
    // handling. Printable keys fall through (return false) and surface via `changed`.
    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number) => this.onKey(keyval));
    this.row.addController(keys);

    // Commit on focus-out (or restore the label if the user typed a stray filter).
    const focus = new Gtk.EventControllerFocus();
    focus.on('leave', () => setTimeout(() => { if (this.open) this.closePopover(true); }, 0));
    this.row.addController(focus);
  }

  getValue(): string {
    return this.value;
  }

  /** Set the selection programmatically (no `onChange`). Ignored if not an option. */
  setValue(value: string): void {
    if (!this.options.some((o) => o.value === value)) return;
    this.value = value;
    this.setRowText(this.selectedLabel());
  }

  /**
   * Replace the option list — e.g. when a dependent control (the agent kind) changes
   * the set of valid models. Keeps the current value if it's still present, otherwise
   * falls back to `value` (or the first option). Never fires `onChange`.
   */
  setOptions(options: ComboOption[], value?: string): void {
    this.options = options;
    const next = value ?? (options.some((o) => o.value === this.value) ? this.value : options[0]?.value ?? '');
    this.value = next;
    this.setRowText(this.selectedLabel());
    if (this.open) this.rebuild(this.row.getText() ?? '');
  }

  setSensitive(sensitive: boolean): void {
    this.row.setSensitive(sensitive);
  }

  private selectedLabel(): string {
    return this.options.find((o) => o.value === this.value)?.label ?? '';
  }

  private setRowText(text: string): void {
    this.settingText = true;
    this.row.setText(text);
    this.row.setPosition(-1);
    this.settingText = false;
  }

  // Open the list. `showAll` resets the filter to show every option (used for click /
  // chevron / Down on a closed combobox); typing opens with the current query instead.
  private openPopover(showAll: boolean): void {
    if (this.open) return;
    this.open = true;
    const width = Math.max(this.root.getAllocatedWidth(), this.width);
    this.scrolled.setSizeRequest(width, -1);
    this.rebuild(showAll ? '' : (this.row.getText() ?? ''));
    this.popover.popup();
    // Select the text so the first keystroke replaces the shown label and filters
    // from scratch. Deferred so it wins over the click's own cursor placement.
    if (showAll) setTimeout(() => this.row.selectRegion(0, -1), 0);
  }

  private closePopover(restoreLabel: boolean): void {
    if (!this.open) return;
    this.open = false;
    this.popover.popdown();
    if (restoreLabel) this.setRowText(this.selectedLabel());
  }

  // Rebuild the visible items for `query`: fuzzy-rank the options (or show all in
  // insertion order when empty), then select the top match so Enter picks the best
  // result (not whichever row happens to hold the current value).
  private rebuild(query: string): void {
    let r: InstanceType<typeof Gtk.ListBoxRow> | null;
    while ((r = this.menu.getRowAtIndex(0))) this.menu.remove(r);

    const items = this.options.map((o) => ({ value: o.value, text: o.label }));
    const byValue = new Map(this.options.map((o) => [o.value, o]));
    const ranked = rank(query, items);
    this.results = ranked.map((m) => byValue.get(m.item.value)!).filter(Boolean);

    ranked.forEach((m, i) => {
      const opt = this.results[i];
      if (opt) this.menu.append(this.buildItem(opt, m.positions));
    });

    const target = this.menu.getRowAtIndex(0);
    if (target) this.menu.selectRow(target);
  }

  private buildItem(opt: ComboOption, positions: number[]): InstanceType<typeof Gtk.ListBoxRow> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });
    box.setName('ComboboxItem');
    const main = new Gtk.Label({ xalign: 0, useMarkup: true });
    main.setMarkup(highlightMarkup(opt.label, positions));
    main.setHexpand(true);
    main.setEllipsize(Pango.EllipsizeMode.END);
    box.append(main);
    if (opt.detail) {
      const detail = new Gtk.Label({ xalign: 1 });
      detail.setText(opt.detail);
      detail.addCssClass('combobox-detail');
      box.append(detail);
    }
    const row = new Gtk.ListBoxRow();
    row.setChild(box);
    row.setFocusable(false);
    const hover = new Gtk.EventControllerMotion();
    hover.on('enter', () => this.menu.selectRow(row));
    row.addController(hover);
    return row;
  }

  private move(delta: number): void {
    const count = this.results.length;
    if (count === 0) return;
    const selected = this.menu.getSelectedRow();
    const current = selected ? selected.getIndex() : -1;
    const next = (current + delta + count) % count;
    const row = this.menu.getRowAtIndex(next);
    if (row) this.menu.selectRow(row);
  }

  private chooseSelected(): void {
    if (!this.open) { this.openPopover(true); return; }
    this.chooseRow(this.menu.getSelectedRow());
  }

  private chooseRow(row: InstanceType<typeof Gtk.ListBoxRow> | null): void {
    if (!row) return;
    const opt = this.results[row.getIndex()];
    if (!opt) return;
    const changed = opt.value !== this.value;
    this.value = opt.value;
    this.setRowText(opt.label);
    this.closePopover(false);
    if (changed) this.onChange?.(opt.value);
  }

  // Returns true to swallow the key (handled here), false to let the row's entry have it.
  private onKey(keyval: number): boolean {
    switch (keyval) {
      case Gdk.KEY_Down:
      case Gdk.KEY_KP_Down:
        if (this.open) this.move(1);
        else this.openPopover(true);
        return true;
      case Gdk.KEY_Up:
      case Gdk.KEY_KP_Up:
        if (this.open) this.move(-1);
        return true;
      case Gdk.KEY_Return:
      case Gdk.KEY_KP_Enter:
        this.chooseSelected();
        return true;
      case Gdk.KEY_Escape:
        if (!this.open) return false; // let the surrounding card handle Escape
        this.closePopover(true);
        return true;
      case Gdk.KEY_Tab:
      case Gdk.KEY_ISO_Left_Tab:
        if (this.open) this.chooseSelected(); // commit, but let focus move on
        return false;
      default:
        return false;
    }
  }
}
