/*
 * StickyListPanel — a sticky header + vertical list shown at the edge of the
 * conversation (the Tasks panel, the running-Subagents panel). Hidden until it
 * has rows; `render(rows)` swaps the list and shows/hides accordingly.
 */
import { Gtk } from '../../gi.ts';
import { clearChildren } from '../proseMarkup.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

export class StickyListPanel {
  readonly root: InstanceType<typeof Gtk.Box>;
  private readonly list: InstanceType<typeof Gtk.Box>;

  /** `title` heads the panel; extra `cssClasses` layer onto the base styling. */
  constructor(title: string, ...cssClasses: string[]) {
    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.addCssClass('quilx-conversation-tasks');
    for (const c of cssClasses) this.root.addCssClass(c);
    this.root.setVisible(false);
    const header = new Gtk.Label({ xalign: 0, label: title });
    header.addCssClass('quilx-conversation-tasks-header');
    this.list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
    this.root.append(header);
    this.root.append(this.list);
  }

  /** Replace the list with `rows`; an empty array hides the whole panel. */
  render(rows: Widget[]): void {
    clearChildren(this.list);
    if (rows.length === 0) { this.root.setVisible(false); return; }
    for (const row of rows) this.list.append(row);
    this.root.setVisible(true);
  }
}
