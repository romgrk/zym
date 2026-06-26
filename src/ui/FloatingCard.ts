/*
 * FloatingCard — the overlay "card" shell shared by the Picker and other floating
 * panels (e.g. the agent launcher). It owns the bits every floating card needs but
 * that aren't specific to a search list: mounting an opaque card in a `Gtk.Overlay`
 * (top-centre of the whole overlay by default, or aligned to a given widget via
 * `anchor`), remembering and restoring focus, and dismissing when focus leaves the
 * card for another in-app widget (but not when the whole window is deactivated). It
 * knows nothing about the card's contents — the caller appends its own widgets to
 * `panel` and registers whatever keymap/commands it needs (the card only provides
 * `close`, which the caller can bind to Escape).
 */
import { Gtk, Adw } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { CompositeDisposable } from '../util/eventKit.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;
type Widget = InstanceType<typeof Gtk.Widget>;

/** Default distance from the top of the overlay to the card (the Picker's position). */
const CARD_MARGIN_TOP = 48 * 2;

/** Min gap kept between an anchored card and the host's edges when clamping. */
const ANCHOR_MARGIN = 8;

/** Fade-in/out duration (ms) when `fade` is enabled. */
const FADE_MS = 110;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));

/** A widget's bounds in `relativeTo`'s coordinate space, or null if not yet computable
 *  (e.g. the target isn't realized). `computeBounds` returns `[ok, Graphene.Rect]`. */
function boundsIn(widget: Widget, relativeTo: Widget): { x: number; y: number; width: number; height: number } | null {
  const res: any = widget.computeBounds(relativeTo);
  const ok = Array.isArray(res) ? res[0] : !!res;
  const rect = Array.isArray(res) ? res[1] : res;
  if (!ok || !rect) return null;
  return { x: rect.getX(), y: rect.getY(), width: rect.getWidth(), height: rect.getHeight() };
}

/** Natural size of `widget` along `orientation` (px); `measure` returns `[min, nat, …]`. */
function naturalSize(widget: Widget, orientation: number, forSize: number): number {
  const m: any = widget.measure(orientation, forSize);
  return Array.isArray(m) ? m[1] : m;
}

// The shared drop shadow for every floating card (a soft, wide blur with no spread —
// a large spread reads as a dark halo — at reduced opacity), and the optional dim
// scrim painted behind a card over the rest of the window.
addStyles(/* css */`
  .floating-card {
    box-shadow: 0px 8px 28px 0px alpha(var(--t-ui-shadow), 0.55);
  }
  .floating-card-scrim {
    background-color: alpha(black, 0.35);
  }
`);

/**
 * Align the card to a widget's on-screen box instead of the whole overlay — e.g.
 * centre the Picker over the active TextEditor in a split, rather than the window.
 * The position is computed once, when the card first lays out, and not updated if
 * the target later moves/resizes (the card is short-lived and modal). The scrim, if
 * any, still covers the whole window.
 */
export interface CardAnchor {
  /** Widget to align to. Must share `host`'s window (its bounds are mapped into the
   *  host's coordinate space). Typically the active editor's root widget. */
  to: Widget;
  /** Horizontal placement within the target's width. Default `center`. */
  halign?: 'center' | 'start' | 'end';
  /** Offset below the target's top edge (default `CARD_MARGIN_TOP`). */
  top?: number;
  /** Min gap kept from the host's edges when clamping (default `ANCHOR_MARGIN`). */
  margin?: number;
}

export interface FloatingCardOptions {
  /** Overlay to mount the card in (supplied by the caller, e.g. AppWindow's). */
  host: Overlay;
  /** CSS class for the card; the caller scopes its keymap/styles to this class. */
  name: string;
  /** Distance from the top of the overlay to the card (default 48, the Picker's).
   *  Ignored when `anchor` is set. */
  top?: number;
  /** Align the card to a widget instead of the overlay's top-centre (see `CardAnchor`). */
  anchor?: CardAnchor;
  /** Dim the rest of the window with a scrim behind the card; clicking it dismisses. */
  dim?: boolean;
  /** Fade the card (and scrim) in on open and out on close. */
  fade?: boolean;
  /** Extra teardown run when the card closes (dispose subscriptions, timers). */
  onClose?: () => void;
}

export interface FloatingCardHandle {
  /** The card container — append the card's content to it. */
  readonly panel: InstanceType<typeof Gtk.Box>;
  /**
   * Dismiss the card. By default focus returns to whatever held it before the card
   * opened; pass `false` when the caller is about to move focus itself (e.g. after a
   * selection that opens an editor). Idempotent.
   */
  close(restoreFocus?: boolean): void;
  /** Whether the card has been dismissed. */
  isClosed(): boolean;
}

/**
 * Mount a floating card in `host` and return a handle. The card is added to the
 * overlay immediately (empty); the caller then appends its content to `panel`,
 * sizes it, and grabs focus into it.
 */
export function openFloatingCard(options: FloatingCardOptions): FloatingCardHandle {
  const { host } = options;

  // Funnel for this card's controller teardown. node-gtk roots a connected
  // controller's signal closures behind a Global handle, so the scrim/focus
  // controllers must be removed (in `close()`, while the widgets still exist)
  // before the overlay drops them — otherwise the whole card subtree leaks.
  const disposables = new CompositeDisposable();

  // Remember whatever held focus before the card opened, so dismissing returns
  // focus there (e.g. back to the editor) rather than stranding it on the removed
  // overlay. Captured before the caller grabs focus into the card.
  const previousFocus = host.getRoot()?.getFocus() ?? null;

  // Optional dim scrim behind the card, covering the rest of the window. Added first so
  // it sits below the panel; clicking it dismisses the card (standard modal behaviour).
  let scrim: InstanceType<typeof Gtk.Box> | null = null;
  if (options.dim) {
    scrim = new Gtk.Box();
    scrim.addCssClass('floating-card-scrim');
    const click = new Gtk.GestureClick();
    click.on('released', () => close());
    disposables.addController(scrim, click);
    host.addOverlay(scrim);
  }

  // A floating, opaque card. Positioned at the top-centre of the overlay by the
  // halign/valign/margin below — unless `anchor` is set, in which case the
  // get-child-position handler (installed near the end) overrides that.
  const panel = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
  panel.addCssClass(options.name);
  panel.addCssClass('floating-card'); // shared drop shadow
  panel.setHalign(Gtk.Align.CENTER);
  panel.setValign(Gtk.Align.START);
  panel.setMarginTop(options.top ?? CARD_MARGIN_TOP);
  panel.overflow = Gtk.Overflow.HIDDEN;

  // Fade the card + scrim together by tweening a shared opacity (Adw respects the
  // system reduce-motion / enable-animations setting, jumping straight to the end).
  const setOpacity = (v: number) => { panel.setOpacity(v); scrim?.setOpacity(v); };
  const fadeTo = (to: number, onDone?: () => void) => {
    const target = Adw.CallbackAnimationTarget.new((v) => setOpacity(v));
    const anim = new Adw.TimedAnimation({
      widget: panel, valueFrom: panel.getOpacity(), valueTo: to, duration: FADE_MS,
      easing: Adw.Easing.EASE_OUT_CUBIC, target,
    });
    if (onDone) anim.on('done', onDone);
    anim.play();
  };

  // The overlay positioning callback (set below when `anchor` is used); disconnected
  // on removal so a per-open handler doesn't accumulate on the long-lived host.
  let positionHandler: ((child: any, alloc: any) => boolean) | null = null;

  let closed = false;
  const close = (restoreFocus = true) => {
    if (closed) return;
    closed = true;
    options.onClose?.();
    const remove = () => {
      if (positionHandler) host.off('get-child-position', positionHandler);
      // Sever the scrim/focus controllers while their widgets still exist and are
      // in the tree — before removeOverlay drops them — so node-gtk releases the
      // rooted closures instead of pinning the whole card subtree.
      disposables.dispose();
      host.removeOverlay(panel);
      if (scrim) host.removeOverlay(scrim);
      if (restoreFocus) previousFocus?.grabFocus();
    };
    if (options.fade) fadeTo(0, remove);
    else remove();
  };

  // Dismiss when focus moves to another widget in the app (click elsewhere, tab
  // away): close and hand focus back to wherever it came from. `leave` fires only
  // when focus exits the panel *and* its descendants, so moving focus between the
  // card's own widgets doesn't trigger it.
  //
  // A `leave` also fires when the whole window is deactivated (alt-tabbing to
  // another app), but that must NOT close the card — it should still be there on
  // return. So defer a tick (let the focus/active state settle) and close only if
  // the window is still active: i.e. focus genuinely moved to another in-app widget
  // rather than the app losing focus entirely (where focus stays within the card).
  const focus = new Gtk.EventControllerFocus();
  focus.on('leave', () => {
    setTimeout(() => {
      if (closed) return;
      const root = panel.getRoot() as any;
      const windowActive = root?.isActive?.() ?? true;
      const focused = root?.getFocus?.() ?? null;
      const focusWithin = !!focused && (focused === panel || focused.isAncestor(panel));
      // Only dismiss when focus genuinely moved to another in-app widget. A null focus
      // means a transient popup grabbed it onto its own surface (e.g. a Gtk.DropDown's
      // list opening) — that must NOT dismiss the card, or the card would vanish the
      // moment one of its dropdowns opens.
      if (windowActive && focused && !focusWithin) close();
    }, 0);
  });
  disposables.addController(panel, focus);

  // Widget-anchored positioning: place the card relative to `anchor.to`'s on-screen
  // box via the overlay's `get-child-position` (the same mechanism Peek uses). The
  // overlay only allocates the card's own rect, so the scrim and any other overlay
  // children fall through to default positioning (return false). The target's bounds
  // are mapped into the host's coordinate space and the placement is computed once,
  // then cached — the card's own size is still measured each pass so its content can
  // grow, but it doesn't chase the target if the layout later shifts. Until the
  // target is realized (or before the card has a size) we fall through to the
  // top-centre default.
  if (options.anchor) {
    const anchor = options.anchor;
    let placed: { x: number; y: number } | null = null;
    positionHandler = (child, alloc) => {
      if (child !== panel || !alloc) return false;
      const natW = naturalSize(panel, Gtk.Orientation.HORIZONTAL, -1);
      const natH = naturalSize(panel, Gtk.Orientation.VERTICAL, natW);
      if (!placed) {
        const rect = boundsIn(anchor.to, host);
        if (!rect || natW <= 0) return false; // not ready yet — keep the default centre
        const m = anchor.margin ?? ANCHOR_MARGIN;
        const x =
          anchor.halign === 'start' ? rect.x
          : anchor.halign === 'end' ? rect.x + rect.width - natW
          : rect.x + (rect.width - natW) / 2;
        const y = rect.y + (anchor.top ?? CARD_MARGIN_TOP);
        placed = {
          x: clamp(Math.round(x), m, Math.max(m, host.getWidth() - natW - m)),
          y: clamp(Math.round(y), m, Math.max(m, host.getHeight() - natH - m)),
        };
      }
      alloc.x = placed.x;
      alloc.y = placed.y;
      alloc.width = natW;
      alloc.height = natH;
      return true;
    };
    host.on('get-child-position', positionHandler);
  }

  host.addOverlay(panel);

  // Fade in (from fully transparent) once mounted.
  if (options.fade) {
    setOpacity(0);
    fadeTo(1);
  }

  return {
    panel,
    close,
    isClosed: () => closed,
  };
}
