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
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import { addStyles } from '../styles.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import { NERDFONT } from './nerdfont.ts';
import { headerButtonContent } from './headerButton.ts';
import type { Agent } from '../agents/types.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

const CHANGED_GLYPH = NERDFONT.ACTION.EDIT; // edited-files badge

addStyles(/* css */`
  .AgentSidebar, .AgentSidebar .agent-sidebar-header {
    background: var(--secondary-sidebar-bg-color);
    color: var(--secondary-sidebar-fg-color);
  }
  /* The edge toward the content uses the secondary-sidebar border color (its Paned
     handle is hidden, so this border is the divider). The seam under its own header
     uses the theme border, matching the window header bar beside it. */
  .AgentSidebar { border-right: 1px solid var(--secondary-sidebar-border-color); }
  .AgentSidebar .agent-sidebar-header { border-bottom: 1px solid var(--border-color); }

  /* The edited-files button at the header's trailing edge (pencil + count) opens the
     active agent's Agent Changes diff; its look is the shared .agent-header-button class
     (see headerButton.ts), consistent with the subagent/monitor count buttons. */
`);

export interface AgentSidebarOptions {
  /** Review the active agent's changes (the header's edited-files button). */
  onOpenChanges?: (agent: Agent) => void;
}

export class AgentSidebar {
  /** The full-height column (header + agent stack) — the start child of AppWindow's
   *  agent-sidebar split. */
  readonly root: InstanceType<typeof Adw.ToolbarView>;

  private readonly options: AgentSidebarOptions;
  // Every open agent's widget, one per stack page; the visible one is the active
  // workbench's agent. Children are never reparented — switching flips visibility.
  private readonly stack: InstanceType<typeof Gtk.Stack>;
  // The header bar (packs the title, the active agent's header widgets, edited-files).
  private readonly header: InstanceType<typeof Adw.HeaderBar>;
  // The active agent's header widgets currently packed (subagent/monitor count
  // buttons); removed and replaced when a different agent is shown.
  private packedHeaderWidgets: Widget[] = [];
  // The header title (the active agent's name).
  private readonly title: InstanceType<typeof Adw.WindowTitle>;
  // The edited-files button + its count label (right side of the header), reflecting
  // the active agent. Hidden when it has no edits (or no agent is shown).
  private readonly files: InstanceType<typeof Gtk.Button>;
  private readonly filesSetCount: (value: number | string) => void;
  // The agent the header currently reflects, and the unsubscribe for its file-change
  // notifications — swapped whenever a different agent is shown.
  private activeAgent: Agent | null = null;
  private filesUnsub: (() => void) | null = null;
  // Owns the header signal connections so they're released on dispose (node-gtk pins a
  // `.on` handler's captured `this` behind a Global handle otherwise — see eventKit).
  private readonly subs = new CompositeDisposable();

  constructor(options: AgentSidebarOptions = {}) {
    this.options = options;
    this.stack = new Gtk.Stack();
    this.stack.setHexpand(true);
    this.stack.setVexpand(true);

    // An Adw.HeaderBar (its height/chrome matches the window header beside it), with
    // its own title buttons off — the window controls live on the main header.
    const header = new Adw.HeaderBar();
    this.header = header;
    header.addCssClass('agent-sidebar-header');
    header.setShowStartTitleButtons(false);
    header.setShowEndTitleButtons(false);
    header.setTitleWidget(new Gtk.Box()); // clear the centered title slot
    this.title = new Adw.WindowTitle({ title: '' });
    header.packStart(this.title);

    // The edited-files badge, packed at the trailing edge; opens the active agent's
    // changes on click. (Moved here from the per-row badge in WorkbenchList.)
    this.files = new Gtk.Button();
    this.files.addCssClass('flat');
    this.files.addCssClass('agent-header-button'); // shared with the subagent/monitor count buttons
    this.files.setCanFocus(false);
    this.files.setVisible(false);
    const filesContent = headerButtonContent(CHANGED_GLYPH);
    this.filesSetCount = filesContent.setCount;
    this.files.setChild(filesContent.root);
    this.subs.connect(this.files, 'clicked', () => { if (this.activeAgent) this.options.onOpenChanges?.(this.activeAgent); });
    header.packEnd(this.files);

    this.root = new Adw.ToolbarView();
    this.root.addCssClass('AgentSidebar');
    this.root.addTopBar(header);
    this.root.setContent(this.stack);
  }

  /** Host an agent's widget (kept alive in the stack across workbench switches). */
  addAgent(widget: Widget): void {
    this.stack.addChild(widget);
  }

  /** Drop an agent's widget when it is closed (unparent it from the stack). */
  removeAgent(widget: Widget): void {
    if (this.activeAgent?.root === widget) this.setActiveAgent(null); // it was the shown one
    if (widget.getParent() === this.stack) this.stack.remove(widget);
  }

  /** Show `agent` as the active one: flip the visible stack child, set the header
   *  title, and point the edited-files button at it. */
  show(agent: Agent): void {
    if (agent.root.getParent() === this.stack) this.stack.setVisibleChild(agent.root);
    this.title.setTitle(agent.title);
    this.setTopic(agent.topic ?? null);
    this.setActiveAgent(agent);
  }

  /** No agent is shown (the user workbench) — drop the edited-files tracking. */
  clearActive(): void {
    this.title.setSubtitle('');
    this.setActiveAgent(null);
  }

  /** Update the header title (the active agent was renamed). */
  setTitle(title: string): void {
    this.title.setTitle(title);
  }

  /** Update the header subtitle to the active agent's live topic. Hidden while empty
   *  or identical to the name (a first topic that just seeded the name isn't echoed). */
  setTopic(topic: string | null): void {
    this.title.setSubtitle(topic && topic !== this.title.getTitle() ? topic : '');
  }

  // Point the header (edited-files button) at `agent`, swapping the file-change
  // subscription so the count stays live; null clears it (and hides the button).
  private setActiveAgent(agent: Agent | null): void {
    if (agent !== this.activeAgent) {
      this.filesUnsub?.();
      this.filesUnsub = agent ? agent.onDidChangeFiles(() => this.updateFiles()) : null;
      // Swap the per-agent header widgets (subagent/monitor count buttons): unpack the
      // previous agent's, pack the new one's just left of the edited-files badge. Packed
      // in reverse so the agent's array order reads left-to-right in the header.
      for (const w of this.packedHeaderWidgets) this.header.remove(w);
      this.packedHeaderWidgets = agent?.headerWidgets ?? [];
      for (let i = this.packedHeaderWidgets.length - 1; i >= 0; i--) this.header.packEnd(this.packedHeaderWidgets[i]);
      this.activeAgent = agent;
    }
    this.updateFiles();
  }

  // Reflect the active agent's edited-files count onto the badge: a pencil glyph +
  // count (with a tooltip listing names), or hidden when there are none / no agent.
  private updateFiles(): void {
    const changed = this.activeAgent?.changedFiles ?? [];
    if (changed.length === 0) {
      this.files.setVisible(false);
      return;
    }
    this.files.setVisible(true);
    this.filesSetCount(changed.length);
    const names = changed.map((path) => path.split('/').pop() ?? path);
    this.files.setTooltipText(`Edited ${changed.length} file${changed.length === 1 ? '' : 's'} — click to review:\n${names.join('\n')}`);
  }

  /** Release the header signal connections + the active agent's file-change sub. */
  dispose(): void {
    this.subs.dispose();
    this.filesUnsub?.();
    this.filesUnsub = null;
  }
}
