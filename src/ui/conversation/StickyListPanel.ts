/*
 * StickyListPanel — a sticky header + vertical list shown at the edge of the
 * conversation (the Tasks panel, the running-Subagents panel). Hidden until it
 * has rows; `render(rows)` swaps the list and shows/hides accordingly.
 */
import { Gtk } from '../../gi.ts';
import { addStyles } from '../../styles.ts';
import { clearChildren } from '../proseMarkup.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

addStyles(`
  .StickyListPanel {
    padding: 8px calc(4 * var(--t-spacing));
    background: var(--t-ui-surface-popover);
    border-bottom: 1px solid var(--t-ui-border);
  }
  .StickyListPanel .sticky-list-panel-header { font-weight: bold; opacity: 0.6; margin-bottom: 4px; }
  /* A panel placed BELOW the input card (running subagents/monitors) → divider on top. */
  .StickyListPanel.is-below { border-top: 1px solid var(--t-ui-border); border-bottom: none; }
  /* A flat link button opening a subagent/monitor page. */
  .StickyListPanel .sticky-list-panel-link { padding: 1px 4px; min-height: 0; color: var(--t-ui-text-info); }
`);

export class StickyListPanel {
  readonly root: InstanceType<typeof Gtk.Box>;
  private readonly list: InstanceType<typeof Gtk.Box>;

  /** `title` heads the panel; extra `cssClasses` layer onto the base styling. */
  constructor(title: string, ...cssClasses: string[]) {
    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.addCssClass('StickyListPanel');
    for (const c of cssClasses) this.root.addCssClass(c);
    this.root.setVisible(false);
    const header = new Gtk.Label({ xalign: 0, label: title });
    header.addCssClass('sticky-list-panel-header');
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
