/*
 * CompletionPopup — the autocompletion dropdown: a list of candidates anchored
 * just below the word via the shared `EditorPopover` (a chrome-less Gtk.Popover;
 * this panel is the visual card), optionally with a second pane to its right that
 * shows the selected item's documentation (LSP docs).
 *
 * Keyboard-driven (the editor keeps focus; the `CompletionController` routes
 * Up/Down/Enter via a capture key controller), so the popup itself never takes
 * focus — it just renders the items and tracks the selection. It's a plain overlay
 * card, positioned by margins + top-left alignment, like the hover card.
 */
import { Gtk, Pango } from '../../gi.ts';
import { addStyles } from '../../styles.ts';
import { theme } from '../../theme/theme.ts';
import { highlightMarkup } from '../Picker.ts';
import { escapeMarkup } from '../proseMarkup.ts';
import { iconLabel, completionKindGlyph } from '../icons.ts';
import { EditorPopover } from './EditorPopover.ts';
import { MarkupCard } from './MarkupCard.ts';
import type { EditorModel } from './EditorModel.ts';
import type { SourceView } from '../../gi.ts';
import type { CompletionItem, RankedCompletion } from './CompletionSource.ts';

const POPUP_BG = theme.ui.editor.background;
const SELECTED_BG = theme.ui.surface.selected;
const DETAIL_COLOR = theme.ui.text.muted;
const LIST_WIDTH_PX = 420;
const DOC_WIDTH_PX = 440;
const DIVIDER_PX = 1; // the vertical separator between the list and the doc pane
// The horizontal space the doc pane adds to the panel. When the pane opens on the
// *left* of the list, the list's anchor inset grows by this so its column stays put.
const DOC_PANEL_PX = DOC_WIDTH_PX + DIVIDER_PX;
const MAX_HEIGHT_PX = 240;
// A row's left structure: card border + row padding + the fixed-width kind-icon
// column + the icon's right margin. `showAt` shifts the popup left by this so the
// *label* (candidate text) — not the icon — lines up under the word being typed.
const BORDER_PX = 1;
const ROW_PADDING_PX = 8;
const ICON_WIDTH_PX = 18;
const ICON_MARGIN_PX = 8;
// Optical correction: the structural inset lands the label ~3px left of the word, so trim
// the inset by 3 (shifts the whole popup right 3px) to line the text up precisely.
const LABEL_ALIGN_FIX_PX = 3;
const LABEL_INSET_PX = BORDER_PX + ROW_PADDING_PX + ICON_WIDTH_PX + ICON_MARGIN_PX - LABEL_ALIGN_FIX_PX;

addStyles(`
  #CompletionPopup {
    background-color: ${POPUP_BG};
    border: 1px solid var(--border-color);
    border-radius: var(--popover-radius-small);
    box-shadow: 0px 6px 20px 8px var(--t-ui-shadow);
  }
  /* Inner widgets paint nothing — the card's background shows through, and rows
     get no min-height so a single match is exactly one row tall. */
  #CompletionPopup scrolledwindow,
  #CompletionPopup list,
  #CompletionPopup row {
    background-color: transparent;
    min-height: 0;
  }
  #CompletionPopup row { padding: 1px ${ROW_PADDING_PX}px; }
  #CompletionPopup row:selected { background-color: ${SELECTED_BG}; border-radius: 0; }
  #CompletionPopup .completion-icon { margin-right: ${ICON_MARGIN_PX}px; color: ${DETAIL_COLOR}; opacity: 0.8; }
  #CompletionPopup .completion-label { font: var(--t-font-monospace); }
  #CompletionPopup .completion-detail { opacity: 0.55; margin-left: 0.5em; }
  #CompletionPopup .completion-description { opacity: 0.45; margin-left: 0.75em; font-size: 0.9em; }
  #CompletionPopup separator.completion-divider { background-color: var(--border-color); }
  #CompletionPopup .completion-doc { padding: 6px 8px; }
`);

export class CompletionPopup {
  private readonly panel: InstanceType<typeof Gtk.Box>;
  private readonly listBox: InstanceType<typeof Gtk.ListBox>;
  private readonly listScroller: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly divider: InstanceType<typeof Gtk.Separator>;
  private readonly docScroller: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly docCard: MarkupCard; // the doc pane's content — same card as LSP hover
  private readonly popover: EditorPopover;
  private readonly model: EditorModel;
  private readonly view: SourceView;
  private entries: RankedCompletion[] = [];
  private shown = false;
  private anchor: { row: number; column: number } | null = null; // word-start, for re-anchoring
  // Once any entry's docs have been shown, the doc pane stays open (empty for
  // doc-less entries) so cycling doesn't flicker it open/closed. Reset per show.
  private docPaneSticky = false;
  // Which side of the list the doc pane opens on. It goes right by default, but flips
  // left when there isn't room on the right — so the widened popover never has to slide
  // back on-screen (which would drag the list off its anchored column). See `chooseDocSide`.
  private docOnLeft = false;

  constructor(
    model: EditorModel,
    view: SourceView,
    highlightCode?: (code: string, lang: string | undefined) => string | null,
  ) {
    this.model = model;
    this.view = view;
    this.docCard = new MarkupCard({ highlight: highlightCode });
    this.listBox = new Gtk.ListBox();
    this.listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);

    this.listScroller = new Gtk.ScrolledWindow();
    this.listScroller.setChild(this.listBox);
    this.listScroller.setPropagateNaturalHeight(true);
    this.listScroller.setMaxContentHeight(MAX_HEIGHT_PX);
    this.listScroller.setSizeRequest(LIST_WIDTH_PX, -1);

    // Right pane: the selected item's documentation. Hidden until a selected
    // item actually carries `documentation` (so a plain list stays compact).
    this.divider = new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL });
    this.divider.addCssClass('completion-divider');
    this.divider.setVisible(false);

    this.docCard.label.setValign(Gtk.Align.START);
    this.docCard.label.setYalign(0);
    this.docCard.label.addCssClass('completion-doc');
    this.docScroller = new Gtk.ScrolledWindow();
    this.docScroller.setChild(this.docCard.label);
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
    this.panel.append(this.listScroller);
    this.panel.append(this.divider);
    this.panel.append(this.docScroller);
    // A cursor-anchored popover below the word, positioned by EditorPopover. `bare` strips
    // the popover's chrome (the #CompletionPopup panel is the visual card); `persistent`
    // re-opens it if GTK pops it down on a cycle's preview edit / list selection (unlike
    // hover/signature, the completion list must survive its own buffer edits).
    this.popover = new EditorPopover(model, view, this.panel, {
      position: 'bottom',
      bare: true,
      persistent: true,
    });
  }

  get isOpen(): boolean {
    return this.shown;
  }

  /** Show `entries` below `point`, the candidate labels lined up under the word being
   *  completed (`contentInset = LABEL_INSET_PX` skips the row border/padding/icon column).
   *  The popover slides to stay on-screen; the doc pane opens to the right, growing the
   *  card rightward without moving the list (its left edge is anchored). */
  showAt(entries: RankedCompletion[], point: { row: number; column: number }): void {
    this.anchor = point;
    this.entries = entries;
    this.rebuild();
    this.popover.showAt(point, LABEL_INSET_PX);
    this.shown = true;
  }

  /** Re-anchor at the stored point: EditorPopover left-aligns by the panel's *current*
   *  measured width, so calling this after the doc pane opens keeps the list's left edge put
   *  (the doc pane grows away from it — right, or left when there's no room on the right)
   *  instead of the popover sliding to re-centre. Goes through the deferred `showAt` —
   *  `updateDoc` can run inside the async doc-resolve continuation, where synchronous GTK
   *  layout (measure) would freeze node-gtk. */
  private reanchor(): void {
    if (!this.shown || !this.anchor) return;
    // The list label always lands on the word's column. When the doc pane sits on the
    // left, the list is no longer the panel's first child, so the inset grows by the doc
    // pane's width to keep that column fixed (the pane extends leftward, the list stays).
    const inset = LABEL_INSET_PX + (this.docPaneSticky && this.docOnLeft ? DOC_PANEL_PX : 0);
    this.popover.showAt(this.anchor, inset);
  }

  /** Decide which side the doc pane should open on, keeping the list pinned to the cursor
   *  column either way. Prefer the right (keeps the common case stable); flip left when the
   *  right can't fit the pane but the left can — so the widened popover doesn't have to slide
   *  back on-screen (the slide is what drags the list off its column). When *neither* side has
   *  room (the panel is wider than the window can hold at this column), the pane overflows no
   *  matter what, so open it on the side with more room — the least overflow, and the least
   *  the popover can be shifted off-screen. Geometry is in toplevel-surface pixels, the box
   *  GTK positions the popover within. */
  private chooseDocSide(): boolean {
    if (!this.anchor) return false;
    const rect = this.model.pixelRectForBufferPosition(this.anchor);
    if (!rect) return false;
    try {
      const root = (this.view as any).getRoot?.();
      const surfaceWidth = root?.getWidth?.() ?? 0;
      if (!surfaceWidth) return false;
      const res: any = (this.view as any).computeBounds(root);
      const bounds = Array.isArray(res) ? res[1] : res;
      const originX = bounds ? bounds.getX() : 0;
      const listLeftX = originX + rect.x - LABEL_INSET_PX; // the list's left edge, toplevel-relative
      const leftRoom = listLeftX; // free space from the surface's left edge to the list
      const rightRoom = surfaceWidth - (listLeftX + LIST_WIDTH_PX); // …to its right edge
      if (rightRoom >= DOC_PANEL_PX) return false; // right fits → right
      if (leftRoom >= DOC_PANEL_PX) return true; // only left fits → left
      return leftRoom > rightRoom; // neither fits → the roomier side overflows less
    } catch {
      return false; // geometry unavailable → keep the default right side
    }
  }

  /** Order the panel's children to match `docOnLeft` (doc · divider · list, or the reverse). */
  private applyDocOrder(): void {
    if (this.docOnLeft) {
      this.panel.reorderChildAfter(this.docScroller, null);
      this.panel.reorderChildAfter(this.divider, this.docScroller);
      this.panel.reorderChildAfter(this.listScroller, this.divider);
    } else {
      this.panel.reorderChildAfter(this.listScroller, null);
      this.panel.reorderChildAfter(this.divider, this.listScroller);
      this.panel.reorderChildAfter(this.docScroller, this.divider);
    }
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.anchor = null;
    this.popover.hide();
  }

  dispose(): void {
    this.popover.dispose();
  }

  /** Number of candidates. */
  get length(): number {
    return this.entries.length;
  }

  /** The selected row index, or -1 when nothing is selected. */
  getSelectedIndex(): number {
    return this.listBox.getSelectedRow()?.getIndex() ?? -1;
  }

  /**
   * Select the row at `index`, or clear the selection when `index < 0` (the
   * "nothing selected" state). Updates the documentation pane to match.
   */
  select(index: number): void {
    if (index < 0) {
      this.listBox.unselectAll();
    } else {
      const row = this.listBox.getRowAtIndex(index);
      if (row) this.listBox.selectRow(row);
      this.scrollSelectedIntoView();
    }
    this.updateDoc();
  }

  /** Scroll the list so the selected row is visible (the list can hold more
   *  candidates than fit, and the popup never takes focus to auto-scroll). */
  private scrollSelectedIntoView(): void {
    const row = this.listBox.getSelectedRow();
    const adjustment = this.listScroller.getVadjustment();
    if (!row || !adjustment) return;
    let rect;
    try {
      const result: any = (row as any).computeBounds(this.listBox);
      rect = Array.isArray(result) ? result[1] : result;
    } catch {
      return;
    }
    if (!rect) return;
    const top = rect.getY();
    const bottom = top + rect.getHeight();
    const viewTop = adjustment.getValue();
    const viewBottom = viewTop + adjustment.getPageSize();
    if (top < viewTop) adjustment.setValue(top);
    else if (bottom > viewBottom) adjustment.setValue(bottom - adjustment.getPageSize());
  }

  getSelected(): CompletionItem | null {
    const index = this.listBox.getSelectedRow()?.getIndex();
    return index === undefined ? null : (this.entries[index]?.item ?? null);
  }

  /** Re-render the doc pane from the current selection (e.g. after a late
   *  `resolve` filled in its documentation). */
  refreshDoc(): void {
    this.updateDoc();
  }

  private rebuild(): void {
    let child = this.listBox.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.listBox.remove(child);
      child = next;
    }
    for (const entry of this.entries) this.listBox.append(this.buildRow(entry));
    // Start with nothing selected (the -1 state); the first Tab selects row 0.
    this.listBox.unselectAll();
    this.docPaneSticky = false; // fresh list: pane closed until docs appear
    this.updateDoc();
  }

  /** Mirror the selected item's documentation into the side pane. The pane is
   *  sticky: once any entry has shown docs it stays open (empty for doc-less
   *  entries) so cycling doesn't flicker it open and closed. */
  private updateDoc(): void {
    const wasOpen = this.docPaneSticky;
    const doc = this.getSelected()?.documentation?.trim();
    if (doc) this.docPaneSticky = true;
    // Render LSP docs as markdown — code mono + fenced blocks highlighted, same as the
    // hover card (MarkupCard).
    if (doc) this.docCard.setMarkdown(doc);
    else this.docCard.clear();
    this.divider.setVisible(this.docPaneSticky);
    this.docScroller.setVisible(this.docPaneSticky);
    // The pane just opened → the panel widened. Pick the side with room (so GTK never has to
    // slide the popover back on-screen), order the children to match, then re-anchor so the
    // list's column stays put while the pane grows away from it.
    if (this.docPaneSticky !== wasOpen) {
      if (this.docPaneSticky) {
        this.docOnLeft = this.chooseDocSide();
        this.applyDocOrder();
      }
      this.reanchor();
    }
  }

  private buildRow({ item, positions }: RankedCompletion): InstanceType<typeof Gtk.ListBoxRow> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });

    // Muted kind icon (Nerd Font Codicon) in a fixed-width column, like VSCode.
    const icon = iconLabel(completionKindGlyph(item.kind));
    icon.addCssClass('completion-icon');
    icon.setSizeRequest(ICON_WIDTH_PX, -1);
    icon.setXalign(0.5);
    box.append(icon);

    // Label + detail packed together on the left (VSCode style: the detail sits
    // just after the label), in a hexpanding box so the description pins right.
    const main = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    main.setHexpand(true);

    const label = new Gtk.Label({ xalign: 0, useMarkup: true });
    // Highlight the fuzzy-matched characters (same accent the picker uses).
    label.setMarkup(highlightMarkup(item.label, positions));
    label.addCssClass('completion-label');
    label.setEllipsize(Pango.EllipsizeMode.END);
    main.append(label);

    if (item.detail) {
      const detail = new Gtk.Label({ xalign: 0, useMarkup: true });
      detail.setMarkup(`<span foreground="${DETAIL_COLOR}">${escapeMarkup(item.detail)}</span>`);
      detail.addCssClass('completion-detail');
      detail.setEllipsize(Pango.EllipsizeMode.END);
      detail.setMaxWidthChars(40);
      main.append(detail);
    }
    box.append(main);

    // Source module / import path (LSP `labelDetails.description`), dimmed, far right.
    if (item.description) {
      const description = new Gtk.Label({ xalign: 1, useMarkup: true });
      description.setMarkup(`<span foreground="${DETAIL_COLOR}">${escapeMarkup(item.description)}</span>`);
      description.addCssClass('completion-description');
      description.setEllipsize(Pango.EllipsizeMode.END);
      description.setMaxWidthChars(24);
      box.append(description);
    }

    const row = new Gtk.ListBoxRow();
    row.setChild(box);
    return row;
  }
}
