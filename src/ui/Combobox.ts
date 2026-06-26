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
 * Per-option `cssClasses` are forwarded verbatim to that option's list row and — when it's
 * the selected value — to the trigger; the Combobox defines none of them (the caller owns
 * the styling). This is the one formatting lever that styles both surfaces, since the
 * trigger is a text-only Gtk.Entry (no room for a per-option widget or markup).
 *
 * An optional `title` is a floating label à la Adw.EntryRow: it rests in the value's
 * place as a placeholder while empty and floats above the selected value once one is
 * set (CSS-transitioned). The trigger also auto-sizes to fit the shown value, clamped
 * to `maxWidth`.
 */
import { Gtk, Gdk, Pango } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { rank } from './Picker.ts';
import { CompositeDisposable } from '../util/eventKit.ts';

const POPOVER_MAX_HEIGHT = 320;
// The popover is at least the trigger width but may grow to fit a longer row, capped here
// (beyond this the rows ellipsize rather than widen the popover further).
const POPOVER_MAX_WIDTH = 480;

// Width auto-sizing: the trigger shrinks/grows to fit the shown label, sized in
// `width-chars` (the only lever that actually moves a Gtk.Entry's width — its intrinsic
// natural width ignores a smaller size-request). The char count is clamped to
// [MIN_CHARS, maxChars], where maxChars is derived from the px `maxWidth`. CHROME_PX is
// the entry's non-text overhead (border + padding + the dropdown icon), used only to
// convert that px cap into chars. TITLE_FLOAT_SCALE is how much the floated title shrinks
// — kept in sync with `scale(...)` in the CSS below.
const DEFAULT_MAX_WIDTH = 220;
const MIN_CHARS = 4;
const CHROME_PX = 44;
const TITLE_FLOAT_SCALE = 0.78;

export interface ComboOption {
  /** Returned by `getValue()` and matched by `value` when (re)selecting. */
  value: string;
  /** Shown in the trigger and the list; also the fuzzy-match text. */
  label: string;
  /** CSS classes applied to this option's list row and — when it's the selected value — to
   *  the trigger. The Combobox defines none of them; the caller owns the styling. */
  cssClasses?: string[];
}

export interface ComboboxConfig {
  options: ComboOption[];
  value: string;
  onChange?: (value: string) => void;
  /** Floating label (Adw.EntryRow-like): a placeholder while the value is empty, floats
   *  above the selected value once one is set. */
  title?: string;
  /** Upper bound (px) on the auto-sized trigger width. Defaults to DEFAULT_MAX_WIDTH. */
  maxWidth?: number;
}

addStyles(/* css */`
  .ComboboxEntry.combobox-button { caret-color: transparent; }
  .ComboboxEntry > image { opacity: 0.7; }
  .ComboboxPopover > contents { padding: 0; }
  .ComboboxList { background: transparent; }
  .ComboboxItem { padding: 0.4em 0.7em; }

  /* Floating title (Adw.EntryRow-like). With a title the entry gains top padding so the
     value text sits in the lower half, leaving room above for the title to float into.
     The title is an overlay child (top-left aligned); both states share the same
     translate()+scale() transform structure so GTK interpolates it smoothly. It's dimmed
     with Adwaita's --dim-opacity (the muted-foreground idiom) rather than a hardcoded
     colour, so it tracks the theme in both states. */
  .ComboboxEntry.has-title { padding-top: 13px; padding-bottom: 1px; }
  /* The chevron shares that asymmetric top padding, which would drop it ~6px below the
     entry's true centre (half of 13−1); pull it back up so it sits vertically centred.
     (Untitled entries have no such padding, so this is scoped to .has-title.) */
  .ComboboxEntry.has-title > image { transform: translateY(-6px); }
  .Combobox .combobox-title {
    margin-left: 8px;
    opacity: var(--dim-opacity);
    transform-origin: 0 0;
    /* Resting (no value): the title's baseline sits on the value text's — the placeholder
       occupies the value's position (Adw.EntryRow convention). The title baseline is 15px
       into its 18px box and the value baseline is ~30px down the 34px entry, so box-top ≈ 15
       (lower than box-centring, which would be ~8). */
    transform: translate(0, 15px) scale(1);
    transition: transform 150ms ease;
  }
  .Combobox.is-floated .combobox-title {
    transform: translate(0, 2px) scale(0.78);
  }
`);

export class Combobox {
  /** Add this to your layout. */
  readonly root: InstanceType<typeof Gtk.Box>;

  private options: ComboOption[];
  private value: string;
  private readonly onChange?: (value: string) => void;

  private readonly title?: string;
  private readonly maxWidth: number;

  private valueToOption = new Map<string, ComboOption>();
  private entryClasses: string[] = []; // the per-option classes currently on the trigger
  private readonly entry: InstanceType<typeof Gtk.Entry>;
  private readonly overlay: InstanceType<typeof Gtk.Overlay>;
  private readonly titleLabel?: InstanceType<typeof Gtk.Label>;
  private readonly popover: InstanceType<typeof Gtk.Popover>;
  private readonly listBox: InstanceType<typeof Gtk.ListBox>;
  private readonly scrolled: InstanceType<typeof Gtk.ScrolledWindow>;

  private results: ComboOption[] = []; // filtered options, parallel to the list rows
  private open = false;
  private settingText = false; // suppress `changed` while seeding the entry
  private suppressOpenOnFocus = false; // a focus() that shouldn't pop the list open
  private outsideCloseInstalled = false; // the toplevel click-outside watcher is attached

  private readonly disposables = new CompositeDisposable();

  constructor(config: ComboboxConfig) {
    this.options = config.options;
    this.value = config.value;
    this.onChange = config.onChange;
    this.title = config.title;
    this.maxWidth = config.maxWidth ?? DEFAULT_MAX_WIDTH;
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

    // The entry, with an optional floating title overlaid on top of it.
    this.overlay = new Gtk.Overlay();
    this.overlay.setChild(this.entry);
    if (this.title !== undefined) {
      this.entry.addCssClass('has-title');
      const label = new Gtk.Label({ label: this.title, xalign: 0 });
      label.addCssClass('combobox-title');
      label.setHalign(Gtk.Align.START);
      label.setValign(Gtk.Align.START);
      label.setCanTarget(false); // let clicks fall through to the entry beneath
      this.titleLabel = label;
      this.overlay.addOverlay(label);
    }
    this.root.append(this.overlay);

    this.listBox = new Gtk.ListBox();
    this.listBox.addCssClass('ComboboxList');
    this.listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);
    this.listBox.setFocusable(false); // the entry keeps focus; we drive the highlight
    this.scrolled = new Gtk.ScrolledWindow();
    this.scrolled.setChild(this.listBox);
    this.scrolled.setFocusable(false); // never a Tab stop — Tab leaves the combobox entirely
    this.scrolled.setPropagateNaturalHeight(true);
    this.scrolled.setMaxContentHeight(POPOVER_MAX_HEIGHT);
    // Let the popover grow past the trigger width to fit a longer row: propagate the list's
    // natural width (capped at POPOVER_MAX_WIDTH) instead of pinning to the trigger. The
    // trigger width becomes the *minimum* (set on open).
    this.scrolled.setPropagateNaturalWidth(true);
    this.scrolled.setMaxContentWidth(POPOVER_MAX_WIDTH);
    this.scrolled.setPolicy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);

    this.popover = new Gtk.Popover();
    this.popover.addCssClass('ComboboxPopover');
    this.popover.setAutohide(false); // keep focus on the entry while filtering
    // Tab navigation must skip the popover and land on the next real widget — not descend
    // into the open popover (which, when it then closes, would orphan focus to the window).
    this.popover.setCanFocus(false);
    this.popover.setFocusable(false);
    this.popover.setHasArrow(false);
    this.popover.setPosition(Gtk.PositionType.BOTTOM);
    this.popover.setChild(this.scrolled);
    this.popover.setParent(this.root);
    // A setParent'd popover must be unparented or it pins the subtree — defer it
    // alongside the controllers so dispose() is the whole teardown.
    this.disposables.defer(() => this.popover.unparent());

    this.updateDisplay(); // also seeds the float state + auto-width
    // Re-measure once the entry is realized and its real font metrics are known (the
    // width set above, pre-layout, is only an estimate).
    this.disposables.connect(this.entry, 'realize', () => this.applyWidth());

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

    // Clicking the trigger (re)opens the popup. CAPTURE phase so this fires before the
    // entry's inner GtkText claims the press — otherwise a click while the entry already
    // holds focus (e.g. reopening right after an outside-click close) never reaches us.
    const click = new Gtk.GestureClick();
    click.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
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
    this.value = this.valueToOption.has(value) ? value : options[0]?.value ?? '';
    this.updateDisplay();
    if (this.open) this.rebuild(this.entry.getText());
  }

  private ingest(options: ComboOption[]): void {
    this.valueToOption = new Map(options.map((o) => [o.value, o]));
  }

  private selectedLabel(): string {
    return this.valueToOption.get(this.value)?.label ?? '';
  }

  private updateDisplay(): void {
    const opt = this.valueToOption.get(this.value);
    this.setEntryText(opt?.label ?? '');
    this.entry.setPosition(0); // show the start of a value too long to fit (not its end)
    // Swap the per-option classes on the trigger: drop the previous value's, apply the new.
    for (const c of this.entryClasses) this.entry.removeCssClass(c);
    this.entryClasses = opt?.cssClasses ?? [];
    for (const c of this.entryClasses) this.entry.addCssClass(c);
    this.updateFloat();
    this.applyWidth();
  }

  // Float the title up while there's a value or the popup is open; otherwise it rests in
  // the placeholder position. The CSS transitions the move/scale.
  private updateFloat(): void {
    if (!this.titleLabel) return;
    if (this.open || this.value !== '') this.root.addCssClass('is-floated');
    else this.root.removeCssClass('is-floated');
  }

  // Pixel width of `text` rendered in the entry's font.
  private measureTextWidth(text: string): number {
    const [width] = this.entry.createPangoLayout(text).getPixelSize();
    return width;
  }

  // Size the trigger to fit the shown label, in characters (the lever Gtk.Entry honours),
  // clamped to [MIN_CHARS, maxChars]. Only ever called in the closed state, so filtering
  // while open never reflows the field.
  private applyWidth(): void {
    const valueLabel = this.selectedLabel();
    // Empty value → the title shows full-size as a placeholder and must fit; a set value
    // shows in the lower half with the floated (shrunk) title above it.
    const primary = valueLabel || this.title || '';
    let chars = primary.length;
    if (valueLabel && this.title !== undefined) {
      chars = Math.max(chars, Math.ceil(this.title.length * TITLE_FLOAT_SCALE));
    }
    // Convert the px maxWidth into a char cap using the font's digit width.
    const em = this.measureTextWidth('0') || 8;
    const maxChars = Math.max(MIN_CHARS, Math.floor((this.maxWidth - CHROME_PX) / em));
    chars = Math.min(maxChars, Math.max(MIN_CHARS, chars));
    this.entry.setWidthChars(chars);
    this.entry.setMaxWidthChars(chars);
  }

  // Open the popup. With no `seed`, seeds the entry with the current label (all selected
  // so the first keystroke replaces it). With a `seed` string, the entry already contains
  // it (user just typed) — skip the text reset and just rebuild from it.
  private openPopup(seed?: string): void {
    if (this.open) return;
    this.open = true;
    this.updateFloat(); // focusing/opening floats the title even with an empty value
    this.entry.removeCssClass('combobox-button');
    this.entry.grabFocus();
    // Trigger width is the popover's MINIMUM; propagateNaturalWidth lets it grow past this.
    const triggerWidth = Math.max(this.root.getWidth(), 1);
    this.scrolled.setSizeRequest(triggerWidth, -1);
    // Build the rows BEFORE measuring/placing so the popover sizes to the real content.
    if (seed !== undefined) {
      this.rebuild(seed);
    } else {
      this.setEntryText(this.selectedLabel());
      this.entry.selectRegion(0, -1);
      this.rebuild('');
      this.selectValueRow(this.value);
    }
    this.placePopover(triggerWidth);
    this.popover.popup();
    this.installOutsideClose();
  }

  // Left-align the popover with the trigger. GtkPopover centers itself on its pointing-to
  // rect, so we span that rect to the popover's own (measured) width with its left edge at
  // the trigger's left edge (x=0 in the parent's coords) — the centered popover then lands
  // left-aligned, for any content width. The rect also spans the trigger's full height, so
  // a BOTTOM popover drops just below it and — when GTK flips it up for lack of room — a TOP
  // popover sits just above it (anchored to the trigger's top, not overlapping the trigger).
  private placePopover(triggerWidth: number): void {
    const [min, nat] = this.scrolled.measure(Gtk.Orientation.HORIZONTAL, -1);
    const width = Math.min(POPOVER_MAX_WIDTH, Math.max(triggerWidth, min, nat));
    const target = new Gdk.Rectangle();
    target.x = 0;
    target.y = 0;
    target.width = width;
    target.height = this.root.getHeight();
    this.popover.setPointingTo(target);
  }

  private setEntryText(text: string): void {
    this.settingText = true;
    this.entry.setText(text);
    this.entry.setPosition(-1);
    this.settingText = false;
  }

  private closePopup(): void {
    this.open = false;
    this.updateFloat(); // an empty value drops the title back to the placeholder position
    this.popover.popdown();
    this.entry.addCssClass('combobox-button');
  }

  // Close on a press that lands outside the trigger and the popover. We keep the popover
  // non-autohiding so the entry retains focus for filtering, which means GTK won't dismiss
  // it on an outside click — so we watch for one ourselves. A click gesture on the toplevel
  // in the CAPTURE phase sees the press before the target widget; since it never claims the
  // sequence, the press still reaches whatever was clicked. ('pressed' hands plain x/y — no
  // raw GdkEvent, which node-gtk can't wrap.) On most backends a press on the popover lands
  // on its own surface and never reaches this gesture; the popover-bounds check covers
  // backends where it shares the toplevel surface. Installed once, on first open.
  private installOutsideClose(): void {
    if (this.outsideCloseInstalled) return;
    const root = this.root.getRoot() as unknown as InstanceType<typeof Gtk.Widget> | null;
    if (!root) return;
    this.outsideCloseInstalled = true;
    const click = new Gtk.GestureClick();
    click.setButton(0); // any button
    click.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    click.on('pressed', (_nPress: number, x: number, y: number) => {
      if (!this.open) return;
      if (this.pointInWidget(this.entry, root, x, y)) return;
      if (this.pointInWidget(this.popover, root, x, y)) return;
      this.cancel();
    });
    this.disposables.addController(root, click);
  }

  // True if (x, y) — in `root`/toplevel coordinates — falls within `widget`'s bounds.
  // `computeBounds` fails (returns ok=false) across separate surfaces, which reads as "not
  // inside" — fine, since such a widget's own clicks never reach the toplevel watcher.
  private pointInWidget(widget: InstanceType<typeof Gtk.Widget>, root: InstanceType<typeof Gtk.Widget>, x: number, y: number): boolean {
    const [ok, bounds] = widget.computeBounds(root);
    if (!ok) return false;
    // Read the rect through its accessors: node-gtk refuses to convert the non-primitive
    // `origin`/`size` struct fields, but getX/getY/getWidth/getHeight return plain numbers.
    const bx = bounds.getX(), by = bounds.getY();
    return x >= bx && x <= bx + bounds.getWidth() && y >= by && y <= by + bounds.getHeight();
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
    if (opt.cssClasses) for (const c of opt.cssClasses) label.addCssClass(c);
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
