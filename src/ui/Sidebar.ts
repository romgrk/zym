/*
 * Sidebar — the full-height workbench column at the very left of the window
 * (outside, left of the header bar): the `.WorkbenchSidebar` box wrapping the
 * workbench list (`WorkbenchList`), exposed as `root`. It is the start child of
 * the top-level split the host (AppWindow) owns.
 *
 * Every callback (the agent/project actions) is forwarded straight to the
 * `WorkbenchList` (exposed as `list`); the sidebar only adds the column assembly.
 */
import Gtk from 'gi:Gtk-4.0';
import { WorkbenchList, type WorkbenchListOptions } from './WorkbenchList.ts';

export type SidebarOptions = WorkbenchListOptions;

export class Sidebar {
  // The full-height sidebar column (`.WorkbenchSidebar`) wrapping the workbench list —
  // the start child of the host's top-level split.
  readonly root: InstanceType<typeof Gtk.Box>;
  // The workbench list filling the sidebar column (user row + running agents). Exposed
  // so the host can drive selection / modified marker / focus.
  readonly list: WorkbenchList;

  constructor(options: SidebarOptions = {}) {
    this.list = new WorkbenchList(options);

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.addCssClass('WorkbenchSidebar');
    this.root.addCssClass('sidebar-pane');
    this.list.root.setHexpand(true);
    this.list.root.setVexpand(true); // fill the sidebar (height + width)
    this.root.append(this.list.root);
  }

  dispose(): void {
    this.list.dispose();
  }
}
