/*
 * Combobox — a searchable single-select control built from primitives we fully drive
 * (Gtk.DropDown couldn't: it owns its popover placement and ties list-highlight to the
 * committed value). A single Gtk.Entry is always visible: in closed state it carries the
 * `combobox-button` CSS class so it renders like a button (no caret, button background);
 * clicking / focusing / typing opens the popover and switches it to edit mode.
 * Up/Down move the highlight *without* changing the value; Enter or a click commits (and
 * fires `onChange`); Escape or focus-loss reverts. Fuzzy filtering reuses the Picker's
 * ranking + match highlighting.
 *
 * `specialLabels` / `mutedLabels` style chosen labels (accent / dimmed), in both the
 * trigger and the list.
 */
import { Gtk, Gdk, Pango } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { rank } from './Picker.ts';
import { CompositeDisposable } from '../util/eventKit.ts';

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
  .ComboboxEntry.combobox-button { caret-color: transparent; }
  .ComboboxEntry > image { opacity: 0.7; }
  .ComboboxPopover > contents { padding: 0; }
  .ComboboxList { background: transparent; }
  .ComboboxItem { padding: 0.4em 0.7em; }
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
  private readonly entry: InstanceType<typeof Gtk.Entry>;
  private readonly popover: InstanceType<typeof Gtk.Popover>;
  private readonly listBox: InstanceType<typeof Gtk.ListBox>;
  private readonly scrolled: InstanceType<typeof Gtk.ScrolledWindow>;

  private results: ComboOption[] = []; // filtered options, parallel to the list rows
  private open = false;
  private settingText = false; // suppress `changed` while seeding the entry
  private suppressOpenOnFocus = false; // a focus() that shouldn't pop the list open

  private readonly disposables = new CompositeDisposable();

  constructor(config: ComboboxConfig) {
    this.options = config.options;
    this.value = config.value;
    this.onChange = config.onChange;
    this.special = new Set(config.specialLabels ?? []);
    this.muted = new Set(config.mutedLabels ?? []);
    this.ingest(config.options);

    // Single entry, always in the layout. In closed state it has `combobox-button`
    // so it looks like a button (no caret). Opening removes that class.
    this.entry = new Gtk.Entry();
    this.entry.addCssClass('ComboboxEntry');
    this.entry.addCssClass('has-text-input');
    this.entry.addCssClass('combobox-button');
    this.entry.setIconFromIconName(Gtk.EntryIconPosition.SECONDARY, 'pan-down-symbolic');
    this.entry.setIconActivatable(Gtk.EntryIconPosition.SECONDARY, false);

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.addCssClass('Combobox');
    this.root.append(this.entry);

    this.listBox = new Gtk.ListBox();
    this.listBox.addCssClass('ComboboxList');
    this.listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);
    this.listBox.setFocusable(false); // the entry keeps focus; we drive the highlight
    this.scrolled = new Gtk.ScrolledWindow();
    this.scrolled.setChild(this.listBox);
    this.scrolled.setPropagateNaturalHeight(true);
    this.scrolled.setMaxContentHeight(POPOVER_MAX_HEIGHT);
    this.scrolled.setPolicy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);

    this.popover = new Gtk.Popover();
    this.popover.addCssClass('ComboboxPopover');
    this.popover.setAutohide(false); // keep focus on the entry while filtering
    this.popover.setHasArrow(false);
    this.popover.setPosition(Gtk.PositionType.BOTTOM);
    this.popover.setChild(this.scrolled);
    this.popover.setParent(this.root);
    // A setParent'd popover must be unparented or it pins the subtree — defer it
    // alongside the controllers so dispose() is the whole teardown.
    this.disposables.defer(() => this.popover.unparent());

    this.updateDisplay();

    // Typing while closed: open seeded with what the user typed. These handlers
    // capture `this`, so they're tracked too — a dropped combobox would leak via
    // them otherwise (node-gtk roots connected closures).
    this.disposables.connect(this.entry, 'changed', () => {
      if (this.settingText) return;
      const text = this.entry.getText();
      if (!this.open) this.openPopup(text);
      else this.rebuild(text);
    });
    this.disposables.connect(this.entry, 'activate', () => this.acceptSelected());
    this.disposables.connect(this.listBox, 'row-activated', (row) => this.acceptRow(row));

    // Clicking while already focused (popup closed) reopens.
    const click = new Gtk.GestureClick();
    click.on('pressed', () => { if (!this.open) this.openPopup(); });
    this.disposables.addController(this.entry, click);

    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number) => this.onEntryKey(keyval));
    this.disposables.addController(this.entry, keys);

    // Focus-in opens the popup (e.g. tabbing into the widget).
    // Focus-out closes it — because the entry is always the sole Tab stop,
    // one Tab press naturally moves focus out and cancel() fires via the leave handler.
    const focus = new Gtk.EventControllerFocus();
    focus.on('enter', () => { if (!this.suppressOpenOnFocus) this.openPopup(); });
    focus.on('leave', () => setTimeout(() => { if (this.open) this.cancel(); }, 0));
    this.disposables.addController(this.entry, focus);
  }

  getValue(): string {
    return this.value;
  }

  /** Sever the entry controllers + the parented popover that would otherwise keep the
   *  control's subtree rooted by node-gtk. Idempotent (the bag seals itself). */
  dispose(): void {
    this.disposables.dispose();
  }

  /** Move keyboard focus into the control. By default focusing opens the popover (the same
   *  as a click); pass `false` to focus the closed control — it keeps its button styling and
   *  opens on the first real interaction. Use that when focusing before the widget is laid
   *  out, where opening immediately would mis-size the popover (every row ellipsized to "…"). */
  focus(open = true): void {
    if (open) {
      this.entry.grabFocus();
      return;
    }
    // Suppress only the open synchronously triggered by this grab; a later genuine focus
    // (post-layout) still opens normally.
    this.suppressOpenOnFocus = true;
    this.entry.grabFocus();
    this.suppressOpenOnFocus = false;
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
    this.setEntryText(label);
    this.entry.removeCssClass('combobox-special');
    this.entry.removeCssClass('combobox-muted');
    if (this.special.has(label)) this.entry.addCssClass('combobox-special');
    else if (this.muted.has(label)) this.entry.addCssClass('combobox-muted');
  }

  // Open the popup. With no `seed`, seeds the entry with the current label (all selected
  // so the first keystroke replaces it). With a `seed` string, the entry already contains
  // it (user just typed) — skip the text reset and just rebuild from it.
  private openPopup(seed?: string): void {
    if (this.open) return;
    this.open = true;
    this.entry.removeCssClass('combobox-button');
    this.entry.grabFocus();
    this.scrolled.setSizeRequest(Math.max(this.root.getWidth(), 1), -1);
    this.popover.popup();
    if (seed !== undefined) {
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
    this.entry.addCssClass('combobox-button');
  }

  // Revert: close without committing; the entry shows the unchanged value.
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
    // rank() only orders/filters here; we render plain labels (no match highlighting).
    this.results = rank(query, items).map((r) => byValue.get(r.item.value)!).filter(Boolean);
    for (const opt of this.results) this.listBox.append(this.buildItem(opt));
    const first = this.listBox.getRowAtIndex(0);
    if (first) this.listBox.selectRow(first);
  }

  private buildItem(opt: ComboOption): InstanceType<typeof Gtk.ListBoxRow> {
    const label = new Gtk.Label({ xalign: 0 });
    label.addCssClass('ComboboxItem');
    label.setText(opt.label);
    label.setEllipsize(Pango.EllipsizeMode.END); // keep rows within the trigger width
    this.styleLabel(label, opt.label);
    const row = new Gtk.ListBoxRow();
    row.setChild(label);
    row.setFocusable(false);
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
      case Gdk.KEY_Down: case Gdk.KEY_KP_Down:
        if (!this.open) { this.openPopup(); return true; }
        this.move(1); return true;
      case Gdk.KEY_Up: case Gdk.KEY_KP_Up:
        if (!this.open) { this.openPopup(); return true; }
        this.move(-1); return true;
      case Gdk.KEY_Return: case Gdk.KEY_KP_Enter: this.acceptSelected(); return true;
      // Only swallow Escape when the list is open (to close it); a closed combobox has
      // nothing to cancel, so let it bubble (e.g. to dismiss an enclosing dialog).
      case Gdk.KEY_Escape: if (!this.open) return false; this.cancel(); return true;
      default: return false;
    }
  }
}
