/*
 * HeaderCountButton — a header-bar MenuButton showing an icon + a running count,
 * opening a popover that lists the running items. Hidden while the count is zero.
 * The agent header bar (AgentSidebar) packs these; the conversation's SubagentView
 * (robot) / MonitorView (terminal) own one each and feed it rows via `setRows`.
 *
 * No teardown of its own: it adds no signal handlers (the popover is owned by the
 * MenuButton via setPopover, not setParent'd), and the rows' click handlers are
 * owned by the caller's render bag.
 */
import Gtk from 'gi:Gtk-4.0';
import { addStyles } from '../../styles.ts';
import { clearChildren } from '../proseMarkup.ts';
import { headerButtonContent } from '../headerButton.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

addStyles(`
  /* The popover's list of running items (the button's own look is .agent-header-button). */
  .agent-header-list { padding: 4px; min-width: 240px; }
  .agent-header-list > button { padding: 4px 6px; min-height: 0; }
`);

export class HeaderCountButton {
  /** The MenuButton to pack into the header bar. */
  readonly button: InstanceType<typeof Gtk.MenuButton>;
  private readonly setCount: (value: number | string) => void;
  private readonly list: InstanceType<typeof Gtk.Box>;

  constructor(glyph: string, tooltip: string) {
    this.button = new Gtk.MenuButton();
    this.button.addCssClass('flat');
    this.button.addCssClass('agent-header-button'); // shared with the edited-files badge
    this.button.setTooltipText(tooltip);
    this.button.setVisible(false); // shown once there's at least one running item

    const content = headerButtonContent(glyph);
    this.setCount = content.setCount;
    this.button.setChild(content.root);

    this.list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
    this.list.addCssClass('agent-header-list');
    const scroller = new Gtk.ScrolledWindow();
    scroller.setPolicy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
    scroller.setMaxContentHeight(320); // scroll if many items, rather than a giant popover
    scroller.setPropagateNaturalHeight(true);
    scroller.setChild(this.list);

    const popover = new Gtk.Popover();
    popover.setChild(scroller);
    this.button.setPopover(popover);
  }

  /** Replace the popover's rows and refresh the icon + count; hide the button at zero. */
  setRows(rows: Widget[]): void {
    clearChildren(this.list);
    for (const row of rows) this.list.append(row);
    const n = rows.length;
    this.setCount(n);
    this.button.setVisible(n > 0);
    if (n === 0) this.button.popdown(); // nothing left to show — close if open
  }

  /** Close the popover (e.g. after a row opens its page). */
  close(): void {
    this.button.popdown();
  }
}
