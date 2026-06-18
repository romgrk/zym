/*
 * OverlayDecoration — a floating, non-interactive card positioned at a buffer point
 * that follows the text (it lives in the editor's `Gtk.Overlay`, addressed in
 * widget-relative pixels, so the host repositions it as the view scrolls). The shared
 * base for the cursor-anchored cards (LSP hover, signature help) and the natural home
 * for future popups (code lens, peek references). Atom's `overlay` decoration.
 *
 * `Peek` (focusable, sibling overlay) and `Leap` (mark layer) are specialized
 * overlays; completion has its own dropdown positioning — they don't use this.
 *
 * Positioning is by margins + bottom-left alignment: the card's bottom edge sits
 * `gapPx` above the anchor (so it grows upward, no height needed) and its left edge at
 * the anchor, clamped into the overlay. See tasks/code-editing/decorations.md.
 */
import { Gtk } from '../../gi.ts';
import type { EditorModel } from './EditorModel.ts';

export interface OverlayCardOptions {
  /** CSS class for the card box (its look). */
  cssClass?: string;
  /** Fixed card width in px (the content wraps to it). */
  widthPx?: number;
  /** Gap kept between the card's bottom and the anchor. */
  gapPx?: number;
}

export class OverlayDecoration {
  /** The card box — the consumer appends its content (a label, etc.) and styles it. */
  readonly content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  private overlay: InstanceType<typeof Gtk.Overlay> | null = null;
  private readonly model: EditorModel;
  private readonly widthPx: number;
  private readonly gapPx: number;

  constructor(model: EditorModel, opts: OverlayCardOptions = {}) {
    this.model = model;
    this.widthPx = opts.widthPx ?? 300;
    this.gapPx = opts.gapPx ?? 4;
    if (opts.cssClass) this.content.addCssClass(opts.cssClass);
    this.content.setSizeRequest(this.widthPx, -1);
    this.content.setHalign(Gtk.Align.START);
    this.content.setValign(Gtk.Align.END);
    this.content.setCanTarget(false); // non-interactive — clicks pass through to the text
    this.content.setVisible(false);
  }

  /** Add the card to the editor's overlay layer (once the overlay exists). */
  attach(overlay: InstanceType<typeof Gtk.Overlay>): void {
    this.overlay = overlay;
    overlay.addOverlay(this.content);
  }

  /** Anchor the card's bottom-left `gapPx` above `point` (grows upward), clamped to the
   *  overlay, then show. `xInset` nudges the left edge (e.g. past the card's padding so
   *  text lines up with the code column). Returns false if the point is off-screen. */
  anchorAbove(point: { row: number; column: number }, xInset = 0): boolean {
    if (!this.overlay) return false;
    const rect = this.model.pixelRectForBufferPosition(point);
    if (!rect) return false;
    const ow = this.overlay.getWidth();
    const oh = this.overlay.getHeight();
    const x = rect.x - xInset;
    this.content.setMarginStart(ow > 0 ? Math.max(0, Math.min(x, ow - this.widthPx)) : Math.max(0, x));
    this.content.setMarginBottom(oh > 0 ? Math.max(0, oh - rect.y + this.gapPx) : this.gapPx);
    this.content.setVisible(true);
    return true;
  }

  /** Show without repositioning (the card stays anchored at its last point). */
  show(): void {
    this.content.setVisible(true);
  }
  hide(): void {
    this.content.setVisible(false);
  }
  get visible(): boolean {
    return this.content.getVisible();
  }
}
