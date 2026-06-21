/*
 * Combobox — a reusable "Picker as a widget": an editable text input that drops a
 * filtered list below it, since GTK/Adwaita has no searchable dropdown (Gtk.DropDown
 * is a plain string list with no descriptions or typeahead). The input is the trigger
 * — click it or type to open the list, which fuzzy-filters as you type; Up/Down move
 * the selection, Enter/click commits, Escape cancels. Selecting fills the input with
 * the option's label and fires `onChange`. Options carry an optional muted `detail`
 * shown right-aligned, reusing the Picker's fuzzy ranking and match highlighting.
 *
 * The list lives in a non-autohide Gtk.Popover parented to the input, so focus stays
 * on the input while filtering (an autohide popover would steal it). Dismissal is
 * handled explicitly: Escape, a commit, or the input losing focus.
 */
import { Gtk, Gdk, Pango } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { rank, highlightMarkup } from './Picker.ts';

const POPOVER_MAX_HEIGHT = 320;
const DEFAULT_WIDTH = 160;

export interface ComboOption {
  /** Returned by `getValue()` and passed to `onChange` when chosen. */
  value: string;
  /** Shown in the input and as the row's main (fuzzy-matched) text. */
  label: string;
  /** Optional muted text shown right-aligned in the row. */
  detail?: string;
}

export interface ComboboxOptions {
  options: ComboOption[];
  /** Initially selected value (defaults to the first option). */
  value?: string;
  placeholder?: string;
  /** Input width in px (default 160). */
  width?: number;
  /** Fired when the user commits a different value. */
  onChange?: (value: string) => void;
}

addStyles(/* css */`
  #Combobox {
    font: var(--t-font-monospace);
  }
  #ComboboxPopover > contents {
    padding: 0;
    background-color: var(--window-bg-color);
    border: 1px solid var(--border-color);
    border-radius: var(--popover-radius-small);
  }
  #ComboboxList {
    border-radius: var(--popover-radius-small);
    background: transparent;
  }
  #ComboboxList row { padding: 0; }
  #ComboboxRow {
    padding: 0.35em 0.75em;
  }
  #ComboboxRow > .combobox-detail {
    margin-left: 1em;
    opacity: 0.5;
  }
`);

export class Combobox {
  /** The trigger input; add this to your layout. */
  readonly root: InstanceType<typeof Gtk.Entry>;

  private options: ComboOption[];
  private value: string;
  private readonly onChange?: (value: string) => void;
  private readonly width: number;

  private readonly entry: InstanceType<typeof Gtk.Entry>;
  private readonly popover: InstanceType<typeof Gtk.Popover>;
  private readonly listBox: InstanceType<typeof Gtk.ListBox>;
  private readonly scrolled: InstanceType<typeof Gtk.ScrolledWindow>;

  // Filtered options currently shown, parallel to the list rows (row index → option).
  private results: ComboOption[] = [];
  private open = false;
  // Suppress the `changed` reaction while we set the input text programmatically
  // (committing a label / restoring it), so it isn't mistaken for the user typing.
  private settingText = false;

  constructor(opts: ComboboxOptions) {
    this.options = opts.options;
    this.onChange = opts.onChange;
    this.width = opts.width ?? DEFAULT_WIDTH;
    this.value = opts.value ?? opts.options[0]?.value ?? '';

    this.entry = new Gtk.Entry();
    this.entry.setName('Combobox');
    this.entry.addCssClass('has-text-input'); // release the `space` leader so it types
    this.entry.setSizeRequest(this.width, -1);
    if (opts.placeholder) this.entry.setPlaceholderText(opts.placeholder);
    this.entry.setIconFromIconName(Gtk.EntryIconPosition.SECONDARY, 'pan-down-symbolic');
    this.entry.setText(this.selectedLabel()); // before wiring `changed`, so it's silent
    this.root = this.entry;

    this.listBox = new Gtk.ListBox();
    this.listBox.setName('ComboboxList');
    this.listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);
    this.listBox.setFocusable(false); // the input keeps focus; we drive selection

    this.scrolled = new Gtk.ScrolledWindow();
    this.scrolled.setChild(this.listBox);
    this.scrolled.setPropagateNaturalHeight(true);
    this.scrolled.setMaxContentHeight(POPOVER_MAX_HEIGHT);
    this.scrolled.setPolicy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);

    this.popover = new Gtk.Popover();
    this.popover.setName('ComboboxPopover');
    this.popover.setAutohide(false); // keep focus on the input while filtering
    this.popover.setHasArrow(false);
    this.popover.setPosition(Gtk.PositionType.BOTTOM);
    this.popover.setChild(this.scrolled);
    this.popover.setParent(this.entry);

    // Type to filter (and open). The `changed` signal also fires on programmatic
    // text changes, which `settingText` guards out.
    this.entry.on('changed', () => {
      if (this.settingText) return;
      if (!this.open) this.openPopover(false);
      this.rebuild(this.entry.getText());
    });
    this.entry.on('activate', () => this.chooseSelected());
    this.listBox.on('row-activated', (row) => this.chooseRow(row));

    // Click the input (including its chevron) to open the list with all options shown.
    const click = new Gtk.GestureClick();
    click.on('pressed', () => { if (!this.open) this.openPopover(true); });
    this.entry.addController(click);

    // Navigation keys, in the capture phase so they act before the entry's own
    // cursor handling. Printable keys fall through (return false) to the entry,
    // then surface via `changed`.
    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number) => this.onKey(keyval));
    this.entry.addController(keys);

    // Commit on focus-out (or restore the label if the user typed a stray filter).
    const focus = new Gtk.EventControllerFocus();
    focus.on('leave', () => setTimeout(() => { if (this.open) this.closePopover(true); }, 0));
    this.entry.addController(focus);
  }

  getValue(): string {
    return this.value;
  }

  /** Set the selection programmatically (no `onChange`). Ignored if not an option. */
  setValue(value: string): void {
    if (!this.options.some((o) => o.value === value)) return;
    this.value = value;
    this.setEntryText(this.selectedLabel());
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
    this.setEntryText(this.selectedLabel());
    if (this.open) this.rebuild(this.entry.getText());
  }

  setSensitive(sensitive: boolean): void {
    this.entry.setSensitive(sensitive);
  }

  private selectedLabel(): string {
    return this.options.find((o) => o.value === this.value)?.label ?? '';
  }

  private setEntryText(text: string): void {
    this.settingText = true;
    this.entry.setText(text);
    this.entry.setPosition(-1);
    this.settingText = false;
  }

  // Open the list. `showAll` resets the filter to show every option (used for click /
  // chevron / Down on a closed combobox); typing opens with the current query instead.
  private openPopover(showAll: boolean): void {
    if (this.open) return;
    this.open = true;
    // Match the popover width to the input.
    const width = Math.max(this.entry.getAllocatedWidth(), this.width);
    this.scrolled.setSizeRequest(width, -1);
    this.rebuild(showAll ? '' : this.entry.getText());
    this.popover.popup();
    // Select the text so the first keystroke replaces the shown label and filters
    // from scratch. Deferred so it wins over the click's own cursor placement.
    if (showAll) setTimeout(() => this.entry.selectRegion(0, -1), 0);
  }

  private closePopover(restoreLabel: boolean): void {
    if (!this.open) return;
    this.open = false;
    this.popover.popdown();
    if (restoreLabel) this.setEntryText(this.selectedLabel());
  }

  // Rebuild the visible rows for `query`: fuzzy-rank the options (or show all in
  // insertion order when empty), then select the row for the current value if it's
  // present, else the first.
  private rebuild(query: string): void {
    let row: InstanceType<typeof Gtk.ListBoxRow> | null;
    while ((row = this.listBox.getRowAtIndex(0))) this.listBox.remove(row);

    const items = this.options.map((o) => ({ value: o.value, text: o.label }));
    const byValue = new Map(this.options.map((o) => [o.value, o]));
    const ranked = rank(query, items);
    this.results = ranked.map((r) => byValue.get(r.item.value)!).filter(Boolean);

    ranked.forEach((r, i) => {
      const opt = this.results[i];
      if (opt) this.listBox.append(this.buildRow(opt, r.positions));
    });

    const selectIndex = Math.max(0, this.results.findIndex((o) => o.value === this.value));
    const target = this.listBox.getRowAtIndex(selectIndex);
    if (target) this.listBox.selectRow(target);
  }

  private buildRow(opt: ComboOption, positions: number[]): InstanceType<typeof Gtk.ListBoxRow> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });
    box.setName('ComboboxRow');
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
    hover.on('enter', () => this.listBox.selectRow(row));
    row.addController(hover);
    return row;
  }

  private move(delta: number): void {
    const count = this.results.length;
    if (count === 0) return;
    const selected = this.listBox.getSelectedRow();
    const current = selected ? selected.getIndex() : -1;
    const next = (current + delta + count) % count;
    const row = this.listBox.getRowAtIndex(next);
    if (row) this.listBox.selectRow(row);
  }

  private chooseSelected(): void {
    if (!this.open) { this.openPopover(true); return; }
    this.chooseRow(this.listBox.getSelectedRow());
  }

  private chooseRow(row: InstanceType<typeof Gtk.ListBoxRow> | null): void {
    if (!row) return;
    const opt = this.results[row.getIndex()];
    if (!opt) return;
    const changed = opt.value !== this.value;
    this.value = opt.value;
    this.setEntryText(opt.label);
    this.closePopover(false);
    if (changed) this.onChange?.(opt.value);
  }

  // Returns true to swallow the key (handled here), false to let the entry have it.
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
