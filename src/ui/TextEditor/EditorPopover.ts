/*
 * EditorPopover — a cursor-anchored Gtk.Popover, the shared base for the editor's floating
 * cards (LSP hover, signature help, and the autocompletion list). Centralizes the three
 * things every one of them needs:
 *
 *  - Anchoring: parented to the view, pointed at a buffer position (via the model's
 *    widget-relative pixel rect); GTK flips it above/below to fit the viewport.
 *  - Freeze-safe show: calling Gtk.Popover.popup() inside the promise-continuation
 *    microtask that node-gtk drains under the GLib loop (e.g. after `await lsp.hover()`)
 *    freezes the UI; deferring it onto a libuv tick (setTimeout 0 — the context a
 *    subprocess callback already runs in) is safe.
 *  - Left-alignment: GtkPopover centers on its anchor rect, so to line the card's text up
 *    with the code column we span the anchor rect across the card's *measured* width with
 *    its left edge one chrome-inset left of the point — the centered card then lands there,
 *    correct for any content width.
 *
 * autohide=false throughout: these are informational, keyboard-driven surfaces that must
 * never steal focus from the editor.
 */
import { Gdk, Gtk, type SourceView } from '../../gi.ts';
import { addStyles } from '../../styles.ts';
import type { EditorModel } from './EditorModel.ts';

// The popover is a themed surface card by default (hover, signature); `.is-bare` strips its
// chrome to a transparent positioner for content that draws its own card (the completion
// list). The platform theme supplies the border-radius / shadow.
addStyles(`
  #EditorPopover > contents {
    background-color: var(--t-ui-surface-popover);
    color: var(--t-ui-editor-foreground);
    padding: 6px 8px;
  }
  #EditorPopover.is-bare > contents {
    background: none;
    box-shadow: none;
    border: none;
    padding: 0;
    min-width: 0;
  }
`);

export interface EditorPopoverOptions {
  /** Place the card above ('top', the default) or below ('bottom') the anchor. */
  position?: 'top' | 'bottom';
  /** Strip the popover's own surface chrome — for content that draws its own card. */
  bare?: boolean;
  /** The popover's horizontal chrome (border + contents padding) in px — what sits between
   *  the popover edge and the child. The card shifts left by it so the child's edge, not the
   *  popover's, lands at the anchor; it's also added to the card width. Default 0. */
  chrome?: number;
  /** Keep the card open across edits/selection inside it: GtkPopover pops itself down when
   *  the view scrolls/relays under it (a completion preview, a list selection), so re-open it
   *  while it's meant to be shown — the net effect that keeps the signature card alive as the
   *  cursor moves. Transient cards (hover, signature) leave this off; they re-show on demand. */
  persistent?: boolean;
}

export class EditorPopover {
  readonly popover: InstanceType<typeof Gtk.Popover>;
  private readonly model: EditorModel;
  private readonly child: InstanceType<typeof Gtk.Widget>;
  private readonly chrome: number;
  private showId: ReturnType<typeof setTimeout> | null = null;
  private wantShown = false; // the caller's intent — drives the persistent re-open

  constructor(
    model: EditorModel,
    view: SourceView,
    child: InstanceType<typeof Gtk.Widget>,
    opts: EditorPopoverOptions = {},
  ) {
    this.model = model;
    this.child = child;
    this.chrome = opts.chrome ?? 0;
    this.popover = new Gtk.Popover();
    this.popover.setName('EditorPopover'); // styling hook: #EditorPopover (see styling.md)
    this.popover.setChild(child);
    this.popover.setAutohide(false); // don't grab — dismissal is driven by the editor
    this.popover.setCanFocus(false); // never move focus off the view (keeps keys flowing)
    this.popover.setFocusable(false);
    this.popover.setHasArrow(false);
    this.popover.setPosition(opts.position === 'bottom' ? Gtk.PositionType.BOTTOM : Gtk.PositionType.TOP);
    if (opts.bare) this.popover.addCssClass('is-bare');
    this.popover.setParent(view);
    if (opts.persistent) this.popover.on('closed', () => this.wantShown && this.popupSoon());
  }

  /** Point the card at buffer `point` and show it, LEFT-aligned: the popover's left edge
   *  lands `chrome + contentInset` left of the point, so the content's anchor — the chrome
   *  plus the child's own left inset (e.g. a completion icon column; default 0) — sits on
   *  the point's column. GtkPopover centers on its anchor rect, so the rect is spanned to
   *  the card's measured width to land that left edge. Returns false if off-screen. */
  showAt(point: { row: number; column: number }, contentInset = 0): boolean {
    if (!this.model.pixelRectForBufferPosition(point)) return false; // off-screen → caller may retry
    this.wantShown = true;
    // Everything below touches GTK layout (measure() forces a size pass; popup() makes a
    // surface) — run it on a libuv tick, never inside the promise-continuation microtask
    // node-gtk drains under the GLib loop (callers like LSP hover/completion reach here
    // after an `await`), which can freeze. Recompute the rect on the tick so it's current.
    if (this.showId) clearTimeout(this.showId);
    this.showId = setTimeout(() => {
      this.showId = null;
      const rect = this.model.pixelRectForBufferPosition(point);
      if (!rect) return;
      // The popover takes the content's natural width (≥ the child's min) plus its chrome.
      const [min, nat] = this.child.measure(Gtk.Orientation.HORIZONTAL, -1);
      const target = new Gdk.Rectangle();
      target.x = rect.x - this.chrome - contentInset;
      target.y = rect.y;
      target.width = Math.max(min, nat) + 2 * this.chrome;
      target.height = rect.height;
      this.popover.setPointingTo(target);
      this.popover.popup();
    }, 0);
    return true;
  }

  /** Re-show at the last anchor (content changed in place, anchor unchanged). */
  show(): void {
    this.wantShown = true;
    this.popupSoon();
  }

  hide(): void {
    this.wantShown = false; // set before popdown so a `closed` handler doesn't re-open it
    if (this.showId) {
      clearTimeout(this.showId);
      this.showId = null;
    }
    this.popover.popdown();
  }

  get visible(): boolean {
    return this.popover.getVisible();
  }

  // popup() on a libuv tick (see showAt); a no-op if it's already up, so a redundant
  // persistent re-open doesn't flicker.
  private popupSoon(): void {
    if (this.showId) clearTimeout(this.showId);
    this.showId = setTimeout(() => {
      this.showId = null;
      this.popover.popup();
    }, 0);
  }

  dispose(): void {
    this.hide();
    this.popover.unparent(); // a setParent'd popover must be unparented to free it
  }
}
