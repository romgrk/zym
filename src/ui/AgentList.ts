/*
 * AgentList — a live list of the running terminal agents (`quilx.agents`), under
 * an "Agents" header (a robot glyph + label, like FileTree's path header). Each
 * row shows a status dot (green running / muted exited) and the agent's title,
 * staying in sync as agents launch, exit, or rename. When there are no agents an
 * empty-state filler is shown instead. Activating a row invokes `onActivate` with
 * its agent, so the host can reveal and focus that agent's terminal. Lives in the
 * left dock below the file tree.
 *
 * The assembled widget (header + scrollable list) is exposed via `root`.
 */
import { Gtk, Pango } from '../gi.ts';
import { quilx } from '../quilx.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import type { AgentTerminal } from './AgentTerminal.ts';

// nf-md-robot from the bundled "Symbols Nerd Font Mono" (see fonts.ts).
const AGENT_GLYPH = String.fromCodePoint(0xf06a9);
// The per-row status indicator: a round dot (U+25CF) for idle/waiting/exited, and
// nf-md-cog-sync (U+F1978, in the icon font) while working.
const STATUS_DOT = '●';
const WORKING_GLYPH = String.fromCodePoint(0xf1978);

// Header styled like FileTree's; the empty-state filler muted; and the status
// indicator colored by the agent's state: working (grey cog), waiting on the user
// (warning/amber), idle/ready (success/green), exited (muted).
const DOT_CLASSES = ['quilx-agent-working', 'quilx-agent-waiting', 'quilx-agent-idle', 'quilx-agent-exited'];
addStyles(`
  #AgentList .agentlist-header {
    color: ${theme.ui.textMuted ?? '#9a9996'};
    font-weight: bold;
    padding: 6px 8px;
  }
  #AgentList .agentlist-empty {
    color: ${theme.ui.textMuted ?? '#9a9996'};
    padding: 12px;
  }
  .quilx-agent-working { color: ${theme.ui.textMuted ?? '#9a9996'}; }
  .quilx-agent-waiting { color: ${theme.ui.warning ?? '#e5a50a'}; }
  .quilx-agent-idle    { color: ${theme.ui.success ?? '#2ec27e'}; }
  .quilx-agent-exited  { color: ${theme.ui.textMuted ?? '#9a9996'}; }
`);

export interface AgentListOptions {
  /** Fired when a row is activated (clicked / Enter). */
  onActivate?: (agent: AgentTerminal) => void;
}

export class AgentList {
  readonly root: InstanceType<typeof Gtk.Box>;

  private readonly listBox: InstanceType<typeof Gtk.ListBox>;
  private readonly scrolled: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly empty: InstanceType<typeof Gtk.Label>;
  private readonly options: AgentListOptions;
  // Renders nerd-font glyphs (header robot, working cog) in the bundled icon font.
  private readonly iconAttrs: InstanceType<typeof Pango.AttrList>;
  // Agents parallel to the list rows, mapping a row index back to its agent.
  private agents: AgentTerminal[] = [];
  // The agent whose row is selected (kept stable across rebuilds). Reflects the
  // last-focused agent; see AppWindow's focus wiring.
  private selected: AgentTerminal | null = null;
  // Per-row unsubscribes (title + status), cleared on every rebuild.
  private rowUnsubs: Array<() => void> = [];
  private readonly subs = new CompositeDisposable();

  constructor(options: AgentListOptions = {}) {
    this.options = options;

    this.iconAttrs = Pango.AttrList.new();
    this.iconAttrs.insert(Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)));

    this.listBox = new Gtk.ListBox();
    this.listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);
    this.listBox.on('row-activated', (row: any) => {
      const agent = this.agents[row.getIndex()];
      if (agent) this.options.onActivate?.(agent);
    });

    this.scrolled = new Gtk.ScrolledWindow();
    this.scrolled.setChild(this.listBox);
    this.scrolled.setVexpand(true);

    // Empty-state filler, shown when no agents are running. Top-aligned (it sits
    // just under the header), filling the width.
    this.empty = new Gtk.Label({ label: 'No running agents', xalign: 0 });
    this.empty.addCssClass('agentlist-empty');

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.setName('AgentList'); // selector identity + CSS (#AgentList)
    this.root.append(this.buildHeader());
    this.root.append(this.scrolled);
    this.root.append(this.empty);

    // Rebuild the list whenever the global agent set changes.
    this.subs.add(quilx.agents.onDidAddAgent(() => this.rebuild()));
    this.subs.add(quilx.agents.onDidRemoveAgent(() => this.rebuild()));
    this.rebuild();
  }

  /** The "Agents" header: a robot glyph (bundled icon font) + label. */
  private buildHeader(): InstanceType<typeof Gtk.Box> {
    const icon = new Gtk.Label({ label: AGENT_GLYPH });
    icon.setAttributes(this.iconAttrs);

    const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    header.addCssClass('agentlist-header');
    header.append(icon);
    header.append(new Gtk.Label({ label: 'Agents', xalign: 0 }));
    return header;
  }

  private rebuild(): void {
    for (const unsub of this.rowUnsubs) unsub();
    this.rowUnsubs = [];

    let child = this.listBox.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.listBox.remove(child);
      child = next;
    }

    this.agents = quilx.agents.getAgents();
    for (const agent of this.agents) {
      // Status dot: green while running, muted once the process has exited.
      const dot = new Gtk.Label({ label: STATUS_DOT });
      this.applyStatus(dot, agent);
      this.rowUnsubs.push(agent.onDidChangeStatus(() => this.applyStatus(dot, agent)));

      const label = new Gtk.Label({ xalign: 0 });
      label.setText(agent.title);
      // Keep the row in sync with the agent's reported title.
      this.rowUnsubs.push(agent.onTitleChange(() => label.setText(agent.title)));

      // [dot, title]. The box carries the #AgentRow identity for padding/CSS.
      const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
      box.setName('AgentRow');
      box.append(dot);
      box.append(label);

      const row = new Gtk.ListBoxRow();
      row.setChild(box);
      this.listBox.append(row);
    }

    // Swap the list for the empty-state filler when there are no agents.
    const hasAgents = this.agents.length > 0;
    this.scrolled.setVisible(hasAgents);
    this.empty.setVisible(!hasAgents);

    this.applySelection();
  }

  /** Select the row for `agent` (or clear selection). Called when an agent is focused. */
  selectAgent(agent: AgentTerminal | null): void {
    this.selected = agent;
    this.applySelection();
  }

  // Reflect `this.selected` onto the list box; clears it if the agent is gone.
  private applySelection(): void {
    const index = this.selected ? this.agents.indexOf(this.selected) : -1;
    if (index === -1) {
      this.selected = null;
      this.listBox.unselectAll();
      return;
    }
    const row = this.listBox.getRowAtIndex(index);
    if (row) this.listBox.selectRow(row);
  }

  private applyStatus(dot: InstanceType<typeof Gtk.Label>, agent: AgentTerminal): void {
    for (const cls of DOT_CLASSES) dot.removeCssClass(cls);
    dot.addCssClass(`quilx-agent-${agent.status}`); // idle | working | waiting | exited
    // Working shows the cog glyph (icon font); the rest show the plain dot.
    if (agent.status === 'working') {
      dot.setText(WORKING_GLYPH);
      dot.setAttributes(this.iconAttrs);
    } else {
      dot.setText(STATUS_DOT);
      dot.setAttributes(null);
    }
  }

  dispose(): void {
    for (const unsub of this.rowUnsubs) unsub();
    this.rowUnsubs = [];
    this.subs.dispose();
  }
}
