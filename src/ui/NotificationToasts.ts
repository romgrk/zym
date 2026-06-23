/*
 * NotificationToasts — the transient, on-screen view of posted notifications.
 *
 * A bottom-right stack of toast cards (newest on top), the replacement for
 * Adw.ToastOverlay (which is bottom-center and offers no per-severity styling).
 * Each card shows the severity icon, the message and optional detail, an
 * optional action button, and a close button; the severity drives a CSS class
 * (`notification-<type>`) so the icon and accent border are colored per the
 * theme — see AppWindow.applyNotificationStyles.
 *
 * Non-dismissable toasts auto-expire after `timeout` seconds; dismissable ones
 * stay until closed. Either way, removing a card dismisses its notification so
 * the model stays in sync. Meant to be added as an overlay child aligned to the
 * bottom-right; the assembled stack is exposed via `root`.
 */
import { Gtk } from '../gi.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import type { Notification } from '../Notification.ts';
import { Icons, iconLabel } from './icons.ts';

export interface NotificationToastsOptions {
  /** Seconds a non-dismissable toast stays before auto-expiring. */
  timeout: number;
}

const MAX_WIDTH_CHARS = 44;
// Enter/leave animation: cards fade + slide in (and the stack reflows) instead
// of popping in as a block. The removal is delayed by this same duration so the
// collapse plays out before the widget leaves the tree.
const TRANSITION_MS = 200;

type Box = InstanceType<typeof Gtk.Box>;
type Revealer = InstanceType<typeof Gtk.Revealer>;

export class NotificationToasts {
  readonly root: Box;

  private readonly timeout: number;
  // Live toasts that can be transformed in place, keyed by `replaceKey`: a later
  // notification with the same key reuses the same card widget instead of
  // stacking a new one (both still appear as separate rows in the log).
  private readonly replaceable = new Map<
    string,
    { card: Box; revealer: Revealer; cancelTimer: () => void; notification: Notification; scope: CompositeDisposable }
  >();

  constructor(options: NotificationToastsOptions) {
    this.timeout = options.timeout;

    // The stack sits in the bottom-right corner at its natural size, so it never
    // covers (or steals clicks from) the rest of the overlay.
    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    this.root.setName('NotificationToasts'); // CSS identity (#NotificationToasts)
    this.root.setHalign(Gtk.Align.END);
    this.root.setValign(Gtk.Align.END);
    this.root.setMarginEnd(12);
    this.root.setMarginBottom(12);
    this.root.setCanTarget(true);
  }

  /**
   * Pop a toast for `notification`, newest on top — unless it carries a
   * `replaceKey` matching a live toast, in which case that same card is
   * transformed in place (e.g. "installing…" → "installed").
   */
  show(notification: Notification): void {
    const key = notification.getReplaceKey();
    const prev = key ? this.replaceable.get(key) : undefined;
    if (prev) {
      // Reuse the existing widget: stop its timer, drop the old severity class,
      // mark the superseded notification dismissed (it stays in the log), and
      // refill the card with the new content. The card stays revealed throughout,
      // so the swap reads as an in-place content change, not a re-entry.
      prev.cancelTimer();
      prev.card.removeCssClass(`notification-${prev.notification.getType()}`);
      prev.notification.dismiss();
      // Reuse the SAME per-card scope: `fillCard` clears it first, severing the
      // superseded card's button handlers + click controller before re-adding the
      // new ones, so reuse can't stack rooted closures on the recycled card.
      const cancelTimer = this.fillCard(prev.card, prev.revealer, notification, prev.scope);
      this.replaceable.set(key!, { card: prev.card, revealer: prev.revealer, cancelTimer, notification, scope: prev.scope });
      notification.setDisplayed(true);
      return;
    }

    const card = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    card.addCssClass('NotificationToast'); // CSS identity (.NotificationToast)
    // The card rides into the stack inside a revealer so it fades + slides in.
    const revealer = new Gtk.Revealer({
      transitionType: Gtk.RevealerTransitionType.FADE_SLIDE_UP,
      transitionDuration: TRANSITION_MS,
      revealChild: false,
    });
    revealer.setChild(card);
    // Per-card teardown: holds the card's button handlers + click controller, all
    // of which node-gtk roots while connected. `fillCard` clears it on reuse and
    // the removal paths clear it before the card leaves the tree (rule 9).
    const scope = new CompositeDisposable();
    const cancelTimer = this.fillCard(card, revealer, notification, scope);
    this.root.prepend(revealer);
    // Flip to revealed once mapped so the transition actually plays (toggling it
    // synchronously on an unmapped widget would snap straight to shown).
    setTimeout(() => {
      revealer.setRevealChild(true);
    }, 0);
    if (key) this.replaceable.set(key, { card, revealer, cancelTimer, notification, scope });
    notification.setDisplayed(true);
  }

  // Play the collapse transition, then drop the revealer from the tree.
  private animateOut(revealer: Revealer): void {
    if (!revealer.getParent()) return; // already removed
    revealer.setRevealChild(false);
    setTimeout(() => {
      if (revealer.getParent()) this.root.remove(revealer);
    }, TRANSITION_MS);
  }

  // (Re)fill `card` with `notification`'s content + behavior. Returns a function
  // that cancels the auto-expire timer (called when the card is reused in place).
  // `revealer` is the card's animated host — removing the toast collapses it.
  private fillCard(card: Box, revealer: Revealer, notification: Notification, scope: CompositeDisposable): () => void {
    scope.clear(); // sever the previous fill's button handlers + click controller before rebuilding
    for (let child = card.getFirstChild(); child; ) {
      const next = child.getNextSibling();
      card.remove(child);
      child = next;
    }
    card.addCssClass(`notification-${notification.getType()}`); // per-severity hook

    // An in-progress notification shows a spinner where the severity icon goes.
    let icon: InstanceType<typeof Gtk.Widget>;
    if (notification.isLoading()) {
      const spinner = new Gtk.Spinner();
      spinner.start();
      icon = spinner;
    } else {
      icon = iconLabel(notification.getIcon());
    }
    icon.setValign(Gtk.Align.START);
    icon.addCssClass('notification-icon');

    const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
    const message = new Gtk.Label({ xalign: 0, wrap: true });
    message.setText(notification.getMessage());
    message.setMaxWidthChars(MAX_WIDTH_CHARS);
    message.addCssClass('heading');
    text.append(message);

    const detail = notification.getDetail();
    if (detail) {
      const detailLabel = new Gtk.Label({ xalign: 0, wrap: true });
      detailLabel.setText(detail);
      detailLabel.setMaxWidthChars(MAX_WIDTH_CHARS);
      detailLabel.addCssClass('dim-label');
      text.append(detailLabel);
    }

    card.append(icon);
    card.append(text);

    // The first action button maps onto the toast (the full set lives in the log).
    // Acting on a terminal button dismisses the toast, mirroring the card-body
    // gesture below. A `replaceKey` notification instead drives an in-place
    // lifecycle (e.g. install → installing… → installed): its action transforms
    // this same card, so leave it alone and let the follow-up notice update it.
    // `remove` is defined further down but only invoked on click, by which point
    // its binding is initialized.
    const [button] = notification.getOptions().buttons ?? [];
    if (button) {
      const action = new Gtk.Button({ label: button.text });
      action.setValign(Gtk.Align.CENTER);
      scope.connect(action, 'clicked', () => {
        button.onDidClick();
        if (!notification.getReplaceKey()) remove();
      });
      card.append(action);
    }

    const close = new Gtk.Button();
    close.setChild(iconLabel(Icons.close));
    close.setValign(Gtk.Align.START);
    close.addCssClass('flat');
    close.addCssClass('circular');
    card.append(close);

    // Auto-expire non-dismissable toasts; dismissable ones wait for the close
    // button. `dismiss()` on removal keeps the model in sync (a no-op for the
    // non-dismissable case, which is already considered dismissed).
    let timeoutId: NodeJS.Timeout | null = null;
    const cancelTimer = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };
    const forget = () => {
      const key = notification.getReplaceKey();
      if (key && this.replaceable.get(key)?.card === card) this.replaceable.delete(key);
    };
    const remove = () => {
      scope.clear(); // detach the card's controller + button handlers before it leaves the tree
      cancelTimer();
      this.animateOut(revealer);
      notification.dismiss();
      forget();
    };
    scope.connect(close, 'clicked', remove);

    // Clicking the card body runs the default action and dismisses the toast.
    // The buttons above claim their own clicks, so they don't trip this gesture.
    if (notification.hasDefaultAction()) {
      card.addCssClass('activatable'); // hover/cursor affordance — see AppWindow
      const click = new Gtk.GestureClick();
      click.on('released', () => {
        notification.activate();
        remove();
      });
      scope.addController(card, click);
    }
    if (!notification.isDismissable()) {
      timeoutId = setTimeout(() => {
        timeoutId = null;
        scope.clear(); // detach the card's controller + button handlers before it leaves the tree
        this.animateOut(revealer);
        notification.dismiss();
        forget();
      }, this.timeout * 1000);
    }

    return cancelTimer;
  }
}
