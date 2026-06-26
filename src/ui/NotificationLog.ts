/*
 * NotificationLog — the persistent view of `zym.notifications`. A scrollable
 * list of every notification posted this session (newest at the bottom), the
 * counterpart to the transient toasts: toasts come and go, this is the history.
 *
 * Each row shows the severity icon, the message with optional `detail`, and the
 * post time. It backfills from `getNotifications()` on construction, appends a
 * row per `onDidAddNotification`, and empties on `onDidClearNotifications`.
 * Lives in the bottom dock, toggled by `notifications:toggle-log`.
 *
 * The assembled, scrollable list is exposed via `root`.
 */
import { Gtk } from '../gi.ts';
import { zym } from '../zym.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import type { Notification } from '../Notification.ts';
import { iconLabel } from './icons.ts';

export class NotificationLog {
  readonly root: InstanceType<typeof Gtk.ScrolledWindow>;

  private readonly listBox: InstanceType<typeof Gtk.ListBox>;
  private readonly subs = new CompositeDisposable();
  // Notifications parallel to the rows, mapping a row index back to its model so
  // an activated row can run its default action.
  private rows: Notification[] = [];

  constructor() {
    this.listBox = new Gtk.ListBox();
    this.listBox.setSelectionMode(Gtk.SelectionMode.NONE);
    this.listBox.addCssClass('NotificationList');
    // Activating a row (click / Enter) runs that notification's default action,
    // if any; the row is only activatable when it has one.
    this.listBox.on('row-activated', (row: any) => this.rows[row.getIndex()]?.activate());

    this.root = new Gtk.ScrolledWindow();
    this.root.addCssClass('NotificationLog');
    this.root.setChild(this.listBox);
    this.root.setVexpand(true);

    // Backfill the existing history, then stay live.
    for (const notification of zym.notifications.getNotifications()) this.addRow(notification);
    this.subs.add(zym.notifications.onDidAddNotification((n) => this.addRow(n as Notification)));
    this.subs.add(zym.notifications.onDidClearNotifications(() => this.clearRows()));
  }

  /** Move keyboard focus into the log (so its scoped bindings apply). */
  focus(): void {
    this.listBox.grabFocus();
  }

  // Append one notification as a row: severity icon, message (+ optional detail),
  // and the post time. The type drives a CSS class so themes can color rows.
  private addRow(notification: Notification): void {
    const icon = iconLabel(notification.getIcon());
    icon.setValign(Gtk.Align.START);
    icon.addCssClass('notification-icon'); // colored per severity — see AppWindow

    const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
    const message = new Gtk.Label({ xalign: 0, wrap: true });
    message.setText(notification.getMessage());
    text.append(message);

    const detail = notification.getDetail();
    if (detail) {
      const detailLabel = new Gtk.Label({ xalign: 0, wrap: true });
      detailLabel.setText(detail);
      detailLabel.addCssClass('dim-label');
      text.append(detailLabel);
    }

    const time = new Gtk.Label({ xalign: 1 });
    time.setText(notification.getTimestamp().toLocaleTimeString());
    time.addCssClass('dim-label');
    time.setValign(Gtk.Align.START);

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    box.addCssClass('NotificationRow');
    box.addCssClass(`notification-${notification.getType()}`); // per-severity hook
    box.append(icon);
    box.append(text);
    box.append(time);

    const row = new Gtk.ListBoxRow();
    row.setSelectable(false);
    // Only rows with a default action are activatable (and show the affordance).
    row.setActivatable(notification.hasDefaultAction());
    row.setChild(box);
    this.listBox.append(row);
    this.rows.push(notification);
  }

  private clearRows(): void {
    let child = this.listBox.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.listBox.remove(child);
      child = next;
    }
    this.rows = [];
  }

  dispose(): void {
    this.subs.dispose();
  }
}
