/*
 * CompletionPopup — the autocompletion dropdown: a list of candidates floated
 * just below the cursor in the editor's `Gtk.Overlay`, optionally with a second
 * pane to its right that shows the selected item's documentation (LSP docs).
 *
 * Keyboard-driven (the editor keeps focus; the `CompletionController` routes
 * Up/Down/Enter via a capture key controller), so the popup itself never takes
 * focus — it just renders the items and tracks the selection. Following the
 * project's floating-UI rule it's a plain overlay card, not a `GtkPopover` (which
 * froze the UI). Positioned by margins + top-left alignment, like the hover card.
 */
import { Gtk } from '../../gi.ts';
import { addStyles } from '../../styles.ts';
import { theme } from '../../theme/theme.ts';
import { monospaceFontCss } from '../../fonts.ts';
import { escapeMarkup } from '../Picker.ts';
import type { CompletionItem } from './CompletionSource.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

const POPUP_BG = theme.ui.bg ?? theme.ui.popoverBg ?? '#1e1e1e';
const SELECTED_BG = theme.ui.selectedBg ?? 'rgba(127, 127, 127, 0.25)';
const DETAIL_COLOR = theme.ui.textMuted ?? theme.ui.lineNumber ?? theme.ui.fg ?? '#888888';
const MONO = monospaceFontCss();
const LIST_WIDTH_PX = 340;
const DOC_WIDTH_PX = 360;
const MAX_HEIGHT_PX = 240;
// Left inset of a row's label inside the card: border (1px) + row padding (8px).
// `showAt`'s anchor is the word start, so we shift left by this to align the
// candidate text under the typed text rather than the card's edge.
const CONTENT_INSET_PX = 9;

addStyles(`
  #CompletionPopup {
    background-color: ${POPUP_BG};
    border: 1px solid var(--border-color);
    border-radius: var(--popover-radius-small);
    box-shadow: 0px 6px 20px 8px rgba(0,0,0,0.18);
  }
  /* Inner widgets paint nothing — the card's background shows through, and rows
     get no min-height so a single match is exactly one row tall. */
  #CompletionPopup scrolledwindow,
  #CompletionPopup list,
  #CompletionPopup row {
    background-color: transparent;
    min-height: 0;
  }
  #CompletionPopup row { padding: 1px 8px; }
  #CompletionPopup row:selected { background-color: ${SELECTED_BG}; border-radius: 0; }
  #CompletionPopup .completion-label { ${MONO.declarations} }
  #CompletionPopup .completion-detail { opacity: 0.6; margin-left: 1em; }
  #CompletionPopup separator.completion-divider { background-color: var(--border-color); }
  #CompletionPopup .completion-doc { padding: 6px 8px; }
`);

export class CompletionPopup {
  private readonly panel: InstanceType<typeof Gtk.Box>;
  private readonly listBox: InstanceType<typeof Gtk.ListBox>;
  private readonly divider: InstanceType<typeof Gtk.Separator>;
  private readonly docScroller: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly docLabel: InstanceType<typeof Gtk.Label>;
  private items: CompletionItem[] = [];
  private shown = false;

  constructor(host: Overlay) {
    this.listBox = new Gtk.ListBox();
    this.listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);

    const listScroller = new Gtk.ScrolledWindow();
    listScroller.setChild(this.listBox);
    listScroller.setPropagateNaturalHeight(true);
    listScroller.setMaxContentHeight(MAX_HEIGHT_PX);
    listScroller.setSizeRequest(LIST_WIDTH_PX, -1);

    // Right pane: the selected item's documentation. Hidden until a selected
    // item actually carries `documentation` (so a plain list stays compact).
    this.divider = new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL });
    this.divider.addCssClass('completion-divider');
    this.divider.setVisible(false);

    this.docLabel = new Gtk.Label({ label: '', xalign: 0, yalign: 0, wrap: true });
    this.docLabel.setValign(Gtk.Align.START);
    this.docLabel.addCssClass('completion-doc');
    this.docScroller = new Gtk.ScrolledWindow();
    this.docScroller.setChild(this.docLabel);
    this.docScroller.setPropagateNaturalHeight(true);
    this.docScroller.setMaxContentHeight(MAX_HEIGHT_PX);
    this.docScroller.setSizeRequest(DOC_WIDTH_PX, -1);
    this.docScroller.setVisible(false);

    this.panel = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    this.panel.setName('CompletionPopup');
    this.panel.setHalign(Gtk.Align.START);
    this.panel.setValign(Gtk.Align.START);
    this.panel.overflow = Gtk.Overflow.HIDDEN;
    this.panel.setCanTarget(false); // keyboard-driven; never steal editor focus
    this.panel.append(listScroller);
    this.panel.append(this.divider);
    this.panel.append(this.docScroller);
    this.panel.setVisible(false);
    host.addOverlay(this.panel);
  }

  get isOpen(): boolean {
    return this.shown;
  }

  /** Show `items` with the list's first row aligned to widget pixel `(x, y)`. */
  showAt(items: CompletionItem[], x: number, y: number): void {
    this.items = items;
    this.rebuild();
    this.panel.setMarginStart(Math.max(0, Math.round(x) - CONTENT_INSET_PX));
    this.panel.setMarginTop(Math.max(0, Math.round(y)));
    this.panel.setVisible(true);
    this.shown = true;
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.panel.setVisible(false);
  }

  /** Move the selection by `delta`, wrapping. (The controller caps the list to a
   *  count that fits, so no scroll-into-view — which would need to steal focus.) */
  move(delta: number): void {
    if (this.items.length === 0) return;
    const current = this.listBox.getSelectedRow()?.getIndex() ?? 0;
    const next = (current + delta + this.items.length) % this.items.length;
    const row = this.listBox.getRowAtIndex(next);
    if (row) this.listBox.selectRow(row);
    this.updateDoc();
  }

  getSelected(): CompletionItem | null {
    const index = this.listBox.getSelectedRow()?.getIndex();
    return index === undefined ? null : (this.items[index] ?? null);
  }

  private rebuild(): void {
    let child = this.listBox.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.listBox.remove(child);
      child = next;
    }
    for (const item of this.items) this.listBox.append(this.buildRow(item));
    const first = this.listBox.getRowAtIndex(0);
    if (first) this.listBox.selectRow(first);
    this.updateDoc();
  }

  /** Mirror the selected item's documentation into the side pane (or hide it). */
  private updateDoc(): void {
    const doc = this.getSelected()?.documentation?.trim();
    if (doc) {
      this.docLabel.setLabel(doc);
      this.divider.setVisible(true);
      this.docScroller.setVisible(true);
    } else {
      this.divider.setVisible(false);
      this.docScroller.setVisible(false);
    }
  }

  private buildRow(item: CompletionItem): InstanceType<typeof Gtk.ListBoxRow> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    const label = new Gtk.Label({ label: item.label, xalign: 0 });
    label.addCssClass('completion-label');
    box.append(label);
    if (item.detail) {
      const detail = new Gtk.Label({ label: item.detail, xalign: 1, useMarkup: true });
      detail.setMarkup(`<span foreground="${DETAIL_COLOR}">${escapeMarkup(item.detail)}</span>`);
      detail.setHexpand(true);
      detail.addCssClass('completion-detail');
      box.append(detail);
    }
    const row = new Gtk.ListBoxRow();
    row.setChild(box);
    return row;
  }
}
