/*
 * Combobox — a searchable single-select control built from primitives we fully drive
 * (Gtk.DropDown couldn't: it owns its popover placement and ties list-highlight to the
 * committed value). The trigger shows the current label + chevron; clicking it (or typing
 * / Down on it) swaps it in place for a text entry and drops a filtered list popover right
 * below — so the trigger reads as becoming the entry field. Up/Down move the highlight
 * *without* changing the value; Enter or a click commits (and fires `onChange`); Escape or
 * focus-loss reverts. Fuzzy filtering reuses the Picker's ranking + match highlighting.
 *
 * `specialLabels` / `mutedLabels` style chosen labels (accent / dimmed), in both the
 * trigger and the list.
 */
import { Gtk, Gdk, Pango } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { rank, highlightMarkup } from './Picker.ts';

const POPOVER_MAX_HEIGHT = 320;

export interface ComboOption {
  /** Returned by `getValue()` and matched by `value` when (re)selecting. */
  value: string;
  /** Shown in the trigger and the list. */
  label: string;
}

export interface ComboboxConfig {
  options: ComboOption[];
  value: string;
  onChange?: (value: string) => void;
  /** Labels rendered with emphasis (the `.combobox-special` accent). */
  specialLabels?: string[];
  /** Labels rendered dimmed (the `.combobox-muted` look). */
  mutedLabels?: string[];
}

addStyles(/* css */`
  #ComboboxDisplay {
    padding: 0.25em 0.4em;
    border-radius: var(--popover-radius-small);
  }
  #ComboboxDisplay:hover { background: alpha(currentColor, 0.07); }
  #ComboboxDisplay > .combobox-chevron { opacity: 0.6; margin-left: 0.4em; }
  #ComboboxEntry { padding: 0.25em 0.4em; }
  #ComboboxPopover > contents {
    padding: 0;
    background-color: var(--window-bg-color);
    border: 1px solid var(--border-color);
    border-radius: var(--popover-radius-small);
  }
  #ComboboxList { background: transparent; }
  #ComboboxList > row { padding: 0; }
  #ComboboxItem { padding: 0.35em 0.6em; }
  /* opacity (not a theme color var) so it also resolves in the popup surface */
  .combobox-special { color: var(--accent-color); font-weight: bold; }
  .combobox-muted { opacity: 0.55; }
`);

export class Combobox {
  /** Add this to your layout. */
  readonly root: InstanceType<typeof Gtk.Box>;

  private options: ComboOption[];
  private value: string;
  private readonly onChange?: (value: string) => void;
  private readonly special: Set<string>;
  private readonly muted: Set<string>;

  private valueToLabel = new Map<string, string>();
  private readonly stack: InstanceType<typeof Gtk.Stack>;
  private readonly displayLabel: InstanceType<typeof Gtk.Label>;
  private readonly entry: InstanceType<typeof Gtk.Entry>;
  private readonly popover: InstanceType<typeof Gtk.Popover>;
  private readonly listBox: InstanceType<typeof Gtk.ListBox>;
  private readonly scrolled: InstanceType<typeof Gtk.ScrolledWindow>;

  private results: ComboOption[] = []; // filtered options, parallel to the list rows
  private open = false;
  private settingText = false; // suppress `changed` while seeding the entry

  constructor(config: ComboboxConfig) {
    this.options = config.options;
    this.value = config.value;
    this.onChange = config.onChange;
    this.special = new Set(config.specialLabels ?? []);
    this.muted = new Set(config.mutedLabels ?? []);
    this.ingest(config.options);

    // Closed trigger: label + chevron, clickable and keyboard-openable.
    this.displayLabel = new Gtk.Label({ xalign: 0, hexpand: true });
    this.displayLabel.setEllipsize(Pango.EllipsizeMode.END);
    const chevron = new Gtk.Image({ iconName: 'pan-down-symbolic' });
    chevron.addCssClass('combobox-chevron');
    const display = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    display.setName('ComboboxDisplay');
    display.append(this.displayLabel);
    display.append(chevron);
    display.setFocusable(true);
    const click = new Gtk.GestureClick();
    click.on('released', () => this.openPopup());
    display.addController(click);
    const displayKeys = new Gtk.EventControllerKey();
    displayKeys.on('key-pressed', (keyval: number, _kc: number, state: number) => this.onDisplayKey(keyval, state));
    display.addController(displayKeys);

    // Open trigger: a plain entry (no search icon) in the trigger's place.
    this.entry = new Gtk.Entry();
    this.entry.setName('ComboboxEntry');
    this.entry.addCssClass('has-text-input'); // release the space leader so it types

    this.stack = new Gtk.Stack();
    this.stack.addNamed(display, 'display');
    this.stack.addNamed(this.entry, 'edit');

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.setName('Combobox');
    this.root.append(this.stack);

    this.listBox = new Gtk.ListBox();
    this.listBox.setName('ComboboxList');
    this.listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);
    this.listBox.setFocusable(false); // the entry keeps focus; we drive the highlight
    this.scrolled = new Gtk.ScrolledWindow();
    this.scrolled.setChild(this.listBox);
    this.scrolled.setPropagateNaturalHeight(true);
    this.scrolled.setMaxContentHeight(POPOVER_MAX_HEIGHT);
    this.scrolled.setPolicy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);

    this.popover = new Gtk.Popover();
    this.popover.setName('ComboboxPopover');
    this.popover.setAutohide(false); // keep focus on the entry while filtering
    this.popover.setHasArrow(false);
    this.popover.setPosition(Gtk.PositionType.BOTTOM);
    this.popover.setChild(this.scrolled);
    this.popover.setParent(this.root);

    this.updateDisplay();

    this.entry.on('changed', () => { if (this.open && !this.settingText) this.rebuild(this.entry.getText()); });
    this.entry.on('activate', () => this.acceptSelected());
    this.listBox.on('row-activated', (row) => this.acceptRow(row));

    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number) => this.onEntryKey(keyval));
    this.entry.addController(keys);

    const focus = new Gtk.EventControllerFocus();
    focus.on('leave', () => setTimeout(() => { if (this.open) this.cancel(); }, 0));
    this.entry.addController(focus);
  }

  getValue(): string {
    return this.value;
  }

  /** Set the selection programmatically (no `onChange`). */
  setValue(value: string): void {
    this.value = value;
    this.updateDisplay();
  }

  /** Replace the options, keeping `value` if it's still present (else the first). */
  setOptions(options: ComboOption[], value: string): void {
    this.options = options;
    this.ingest(options);
    this.value = this.valueToLabel.has(value) ? value : options[0]?.value ?? '';
    this.updateDisplay();
    if (this.open) this.rebuild(this.entry.getText());
  }

  private ingest(options: ComboOption[]): void {
    this.valueToLabel = new Map(options.map((o) => [o.value, o.label]));
  }

  private selectedLabel(): string {
    return this.valueToLabel.get(this.value) ?? '';
  }

  private styleLabel(label: InstanceType<typeof Gtk.Label>, text: string): void {
    label.removeCssClass('combobox-special');
    label.removeCssClass('combobox-muted');
    if (this.special.has(text)) label.addCssClass('combobox-special');
    else if (this.muted.has(text)) label.addCssClass('combobox-muted');
  }

  private updateDisplay(): void {
    const label = this.selectedLabel();
    this.displayLabel.setText(label);
    this.styleLabel(this.displayLabel, label);
  }

  // Open the list, swapping the trigger for the entry. `seed` (a typed character) starts
  // the filter; otherwise the entry seeds with the current label, selected so the first
  // keystroke replaces it, and the list shows everything with the current value highlighted.
  private openPopup(seed?: string): void {
    if (this.open) return;
    this.open = true;
    this.scrolled.setSizeRequest(Math.max(this.root.getWidth(), 1), -1);
    this.stack.setVisibleChildName('edit');
    this.popover.popup();
    this.entry.grabFocus();
    if (seed !== undefined) {
      this.setEntryText(seed);
      this.rebuild(seed);
    } else {
      this.setEntryText(this.selectedLabel());
      this.entry.selectRegion(0, -1);
      this.rebuild('');
      this.selectValueRow(this.value);
    }
  }

  private setEntryText(text: string): void {
    this.settingText = true;
    this.entry.setText(text);
    this.entry.setPosition(-1);
    this.settingText = false;
  }

  private closePopup(): void {
    this.open = false;
    this.popover.popdown();
    this.stack.setVisibleChildName('display');
  }

  // Revert: close without committing; the trigger shows the unchanged value.
  private cancel(): void {
    this.closePopup();
    this.updateDisplay();
  }

  private commit(opt: ComboOption): void {
    const changed = opt.value !== this.value;
    this.value = opt.value;
    this.closePopup();
    this.updateDisplay();
    if (changed) this.onChange?.(opt.value);
  }

  // Rebuild the visible rows for `query`, selecting the top match.
  private rebuild(query: string): void {
    let row: InstanceType<typeof Gtk.ListBoxRow> | null;
    while ((row = this.listBox.getRowAtIndex(0))) this.listBox.remove(row);

    const items = this.options.map((o) => ({ value: o.value, text: o.label }));
    const byValue = new Map(this.options.map((o) => [o.value, o]));
    const ranked = rank(query, items);
    this.results = ranked.map((r) => byValue.get(r.item.value)!).filter(Boolean);
    ranked.forEach((r, i) => {
      const opt = this.results[i];
      if (opt) this.listBox.append(this.buildItem(opt, r.positions));
    });
    const first = this.listBox.getRowAtIndex(0);
    if (first) this.listBox.selectRow(first);
  }

  private buildItem(opt: ComboOption, positions: number[]): InstanceType<typeof Gtk.ListBoxRow> {
    const label = new Gtk.Label({ xalign: 0, useMarkup: true });
    label.setName('ComboboxItem');
    label.setMarkup(highlightMarkup(opt.label, positions));
    this.styleLabel(label, opt.label);
    const row = new Gtk.ListBoxRow();
    row.setChild(label);
    row.setFocusable(false);
    const hover = new Gtk.EventControllerMotion();
    hover.on('enter', () => this.listBox.selectRow(row));
    row.addController(hover);
    return row;
  }

  private selectValueRow(value: string): void {
    const i = this.results.findIndex((o) => o.value === value);
    const row = this.listBox.getRowAtIndex(i >= 0 ? i : 0);
    if (row) this.listBox.selectRow(row);
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

  private acceptSelected(): void {
    this.acceptRow(this.listBox.getSelectedRow());
  }

  private acceptRow(row: InstanceType<typeof Gtk.ListBoxRow> | null): void {
    if (!row) { this.cancel(); return; }
    const opt = this.results[row.getIndex()];
    if (opt) this.commit(opt);
    else this.cancel();
  }

  // Returns true to swallow the key.
  private onEntryKey(keyval: number): boolean {
    switch (keyval) {
      case Gdk.KEY_Down: case Gdk.KEY_KP_Down: this.move(1); return true;
      case Gdk.KEY_Up: case Gdk.KEY_KP_Up: this.move(-1); return true;
      case Gdk.KEY_Return: case Gdk.KEY_KP_Enter: this.acceptSelected(); return true;
      case Gdk.KEY_Escape: this.cancel(); return true;
      default: return false;
    }
  }

  // On the closed trigger: Down/Enter open; a printable key opens seeded with it.
  private onDisplayKey(keyval: number, state: number): boolean {
    if (keyval === Gdk.KEY_Down || keyval === Gdk.KEY_KP_Down || keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
      this.openPopup();
      return true;
    }
    if (state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK)) return false;
    const ch = Gdk.keyvalToUnicode(keyval);
    if (ch < 32 || ch === 127) return false;
    this.openPopup(String.fromCharCode(ch));
    return true;
  }
}
