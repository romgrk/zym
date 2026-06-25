/*
 * AgentSidebar — the full-height "secondary sidebar" column that hosts the active
 * agent's widget (`AgentTerminal` / `AgentConversation`). It sits between the
 * WorkbenchList sidebar and the window content, *outside* the main header bar — so,
 * exactly like WorkbenchList, it carries its OWN Adw header (a top bar over the
 * content via `Adw.ToolbarView`). Because the header and the agent widget are the
 * same column, the header lines up with the agent for free — no width-sync against
 * the window header bar (which has its own padding that never aligned cleanly).
 *
 * Every open agent's widget lives in a `Gtk.Stack`, so switching person just flips
 * the visible child — nothing is reparented or destroyed, preserving each agent's
 * live state (mirrors the workbench-switch philosophy). The column itself is
 * attached to / detached from its Paned by AppWindow: shown for an agent workbench,
 * hidden for the user's. Themed with the libadwaita `secondarySidebar` colors so it
 * reads as one surface with the agent widget it frames.
 */
import { Adw, Gtk } from '../gi.ts';
import { addStyles } from '../styles.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

addStyles(/* css */`
  #AgentSidebar, #AgentSidebar .agent-sidebar-header {
    background: var(--secondary-sidebar-bg-color);
    color: var(--secondary-sidebar-fg-color);
  }
  /* The edge toward the content uses the secondary-sidebar border color (its Paned
     handle is hidden, so this border is the divider). The seam under its own header
     uses the theme border, matching the window header bar beside it. */
  #AgentSidebar { border-right: 1px solid var(--secondary-sidebar-border-color); }
  #AgentSidebar .agent-sidebar-header { border-bottom: 1px solid var(--border-color); }
`);

export class AgentSidebar {
  /** The full-height column (header + agent stack) — the start child of AppWindow's
   *  agent-sidebar split. */
  readonly root: InstanceType<typeof Adw.ToolbarView>;

  // Every open agent's widget, one per stack page; the visible one is the active
  // workbench's agent. Children are never reparented — switching flips visibility.
  private readonly stack: InstanceType<typeof Gtk.Stack>;
  // The header title (the active agent's name).
  private readonly title: InstanceType<typeof Adw.WindowTitle>;

  constructor() {
    this.stack = new Gtk.Stack();
    this.stack.setHexpand(true);
    this.stack.setVexpand(true);

    // An Adw.HeaderBar (its height/chrome matches the window header beside it), with
    // its own title buttons off — the window controls live on the main header.
    const header = new Adw.HeaderBar();
    header.addCssClass('agent-sidebar-header');
    header.setShowStartTitleButtons(false);
    header.setShowEndTitleButtons(false);
    header.setTitleWidget(new Gtk.Box()); // clear the centered title slot
    this.title = new Adw.WindowTitle({ title: '' });
    header.packStart(this.title);

    this.root = new Adw.ToolbarView();
    this.root.setName('AgentSidebar'); // selector identity (#AgentSidebar)
    this.root.addTopBar(header);
    this.root.setContent(this.stack);
  }

  /** Host an agent's widget (kept alive in the stack across workbench switches). */
  addAgent(widget: Widget): void {
    this.stack.addChild(widget);
  }

  /** Drop an agent's widget when it is closed (unparent it from the stack). */
  removeAgent(widget: Widget): void {
    if (widget.getParent() === this.stack) this.stack.remove(widget);
  }

  /** Show `widget` as the active agent and set the header title. */
  show(widget: Widget, title: string): void {
    if (widget.getParent() === this.stack) this.stack.setVisibleChild(widget);
    this.title.setTitle(title);
  }

  /** Update the header title (the active agent was renamed). */
  setTitle(title: string): void {
    this.title.setTitle(title);
  }
}
