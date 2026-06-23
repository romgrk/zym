/*
 * Sidebar — the full-height column at the very left of the window (outside, left of
 * the header bar) plus the top-level split that separates it from the content. It
 * assembles the workbench list (`WorkbenchList`) into a sidebar column, splits that
 * column from the window content with a horizontal `Gtk.Paned`, and owns the
 * collapse/expand width toggle the list's robot button drives.
 *
 * The host hands it the content widget (the header bar + workbench wrapped in the
 * toast overlay) as `content`; the sidebar puts it on the split's end side. Every
 * agent-related callback is forwarded straight to the `WorkbenchList` (exposed as
 * `list`); the sidebar only adds the assembly and the width toggle on top.
 */
import { Gtk } from '../gi.ts';
import { WorkbenchList, type WorkbenchListOptions } from './WorkbenchList.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

// Expanded width (px) of the workbench sidebar — the full-height column at the very
// left of the window, outside (left of) the header bar.
const SIDEBAR_WIDTH = 280;
// Collapsed sidebar width (icons only) — toggled by the list's robot button.
const SIDEBAR_COLLAPSED_WIDTH = 48;

// The list owns its own collapse toggle button; the sidebar applies the width, so the
// host configures everything *except* `onToggleCollapsed` (handled internally here).
export interface SidebarOptions extends Omit<WorkbenchListOptions, 'onToggleCollapsed'> {
  /** The content shown beside the sidebar (the split's end child) — typically the
   *  header bar + workbench wrapped in the toast overlay. */
  content: Widget;
}

export class Sidebar {
  // The top-level horizontal split: the full-height sidebar column on the start side,
  // the window content on the end side. Its position is the sidebar width, toggled
  // between expanded and collapsed by the list's robot button.
  readonly root: InstanceType<typeof Gtk.Paned>;
  // The workbench list filling the sidebar column (user row + running agents). Exposed
  // so the host can drive selection / modified marker / focus / branch refresh.
  readonly list: WorkbenchList;

  constructor(options: SidebarOptions) {
    const { content, ...listOptions } = options;
    this.list = new WorkbenchList({
      ...listOptions,
      onToggleCollapsed: (collapsed) => this.setCollapsed(collapsed),
    });

    const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    column.setName('WorkbenchSidebar'); // selector identity for CSS
    this.list.root.setHexpand(true);
    this.list.root.setVexpand(true); // fill the sidebar (height + width)
    column.append(this.list.root);

    // A top-level horizontal paned splits the sidebar column from the content (the
    // header bar + workbench, wrapped by the toast overlay), so the sidebar spans from
    // the window's top edge to its bottom; its width (the split position) is toggled
    // between expanded / collapsed by the list's robot button.
    this.root = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
    this.root.setStartChild(column);
    this.root.setEndChild(content);
    this.root.setPosition(SIDEBAR_WIDTH);
    this.root.setResizeStartChild(false); // window resize grows the content, not the sidebar
    this.root.setShrinkStartChild(false);
  }

  private setCollapsed(collapsed: boolean): void {
    this.root.setPosition(collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH);
  }

  dispose(): void {
    this.list.dispose();
  }
}
