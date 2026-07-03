/*
 * WorkbenchList — the contents of the WorkbenchSidebar (the full-height column at the
 * very left of the window). Each entry is (will be) associated with a particular
 * workbench workbench: the first ("default", selected-by-default) entry is the
 * **user** (rendered as a pseudo-agent), the rest are the running terminal agents
 * (`zym.agents`). The list is never empty — the user entry is always present —
 * so there is no empty state.
 *
 * The top is an `Adw.HeaderBar` whose only content is a robot **button** that
 * toggles the sidebar between collapsed (icons only) and expanded (icons + text);
 * the host wires the actual width change via `onToggleCollapsed`.
 *
 * Activating an agent entry invokes `onActivate`; the user entry invokes
 * `onActivateUser`. Each agent row shows a status indicator + title + a changed-
 * files badge and stays in sync as agents launch, exit, or rename.
 *
 * The assembled widget — an `Adw.ToolbarView` with the header bar as a top bar
 * over the scrollable list — is exposed via `root`.
 */
import * as Os from 'node:os';
import * as Path from 'node:path';
import Pango from 'gi:Pango-1.0';
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import { zym } from '../zym.ts';
import { addStyles } from '../styles.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import { ImageIcons } from '../icons.ts';
import { createAgentStatusIcon } from './agentStatusIcon.ts';
import { Icons, iconLabel } from './icons.ts';
import type { Agent } from '../agents/types.ts';

// The user row's leading icon size — matches the agent status icon so the two rows line up.
const USER_ICON_SIZE = 16;
// Project name shown in the sidebar header: the last path component of the cwd.
export const PROJECT_NAME = Path.basename(process.cwd());
// Add/remove animation duration: each row rides in/out inside a Gtk.Revealer that
// slides its height open (on launch) or shut (on close).
const ROW_TRANSITION_MS = 250;

addStyles(/* css */`
  /* The unsaved-changes marker (a small dot) next to the project title — warning-colored. */
  .zym-modified-dot { color: var(--t-ui-status-warning); }
  
  .WorkbenchRow {
    padding: calc(0.4 * var(--t-spacing)) calc(2 * var(--t-spacing));
  }
  .Workbenchrow--icon {
    margin-right: calc(1.5 * var(--t-spacing));
  }
  
  .Workbenchrow--label {
    font-weight: bold;
  }
  /* The user row's icon is dimmed to match the exited agent icon (muted foreground). */
  .Workbenchrow--user-icon {
    opacity: var(--dim-opacity);
  }
`);

export interface WorkbenchListOptions {
  /** Fired when an agent row is activated (clicked / Enter). */
  onActivate?: (agent: Agent) => void;
  /** Fired when the default (user) row is activated. */
  onActivateUser?: () => void;
  /** Fired when the robot button toggles collapse; the host resizes the sidebar. */
  onToggleCollapsed?: (collapsed: boolean) => void;
  /** Restart an agent (respawn / resume) — the list's `r` key. */
  onRestart?: (agent: Agent) => void;
  /** Stop an agent's process (it stays listed, restartable) — the list's `x` key. */
  onStop?: (agent: Agent) => void;
  /** Close an agent (terminate if running, then remove it from the list) — the `d d` key. */
  onClose?: (agent: Agent) => void;
  /** Rename an agent — the list's `R` key. */
  onRename?: (agent: Agent) => void;
  /** Open the files an agent has edited — the changed-files badge / `o` key. */
  onOpenChanges?: (agent: Agent) => void;
  /** Display name for the default (user) entry; defaults to the OS username. */
  userName?: string;
}

// A list entry: the always-present user row, or one of the running agents.
type Entry = { kind: 'user' } | { kind: 'agent'; agent: Agent };

// A built row: its entry, the ListBoxRow, the Revealer that animates it in/out, and
// the per-row unsubscribes (title + status + files). `removing` marks a row that is
// playing its collapse transition — it stays in the list box until the animation
// ends, but is excluded from navigation/selection in the meantime.
interface RowHandle {
  entry: Entry;
  row: InstanceType<typeof Gtk.ListBoxRow>;
  revealer: InstanceType<typeof Gtk.Revealer>;
  unsubs: Array<() => void>;
  removing: boolean;
}

export class WorkbenchList {
  readonly root: InstanceType<typeof Adw.ToolbarView>;

  private readonly listBox: InstanceType<typeof Gtk.ListBox>;
  private readonly scrolled: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly options: WorkbenchListOptions;
  private readonly userName: string;
  // The built rows, in list-box order (user first, then agents in launch order).
  // Includes rows mid-removal (`removing`) until their collapse transition finishes.
  private handles: RowHandle[] = [];
  // Outstanding timer IDs for in-flight row transitions, cancelled on dispose
  // (and on a full rebuild) so a deferred callback never touches a freed widget.
  private timers = new Set<NodeJS.Timeout>();
  // The agent whose row is selected (kept stable across rebuilds); null selects the
  // user row by default. Reflects the last-focused agent; see AppWindow.
  private selected: Agent | null = null;
  // Collapsed = icons only (narrow); expanded = icons + text. Toggled by the
  // header-bar sidebar toggle button.
  private collapsed = false;
  // The active session's name in the header bar (empty for the unnamed/default
  // session); hidden while collapsed (the bar is too narrow to show it).
  private headerTitle: InstanceType<typeof Adw.WindowTitle> | null = null;
  // The unsaved-changes marker shown after the project title; toggled via opacity
  // (slot always reserved) and hidden while collapsed. `modified` is the last state.
  private modifiedDot: InstanceType<typeof Gtk.Label> | null = null;
  private modified = false;
  private readonly subs = new CompositeDisposable();

  constructor(options: WorkbenchListOptions = {}) {
    this.options = options;
    this.userName = options.userName ?? Os.userInfo().username;

    // An Adw.ToolbarView holds the project-title header bar as a top bar over the
    // scrollable workbench list, so the bar matches the window header beside it and
    // the view manages the seam (and undershoot shadow) between header and list.
    this.root = new Adw.ToolbarView();
    this.root.addCssClass('WorkbenchList');
    this.root.addTopBar(this.buildHeader());

    this.scrolled = new Gtk.ScrolledWindow();
    this.scrolled.setVexpand(true);
    this.root.setContent(this.scrolled);

    this.listBox = new Gtk.ListBox();
    this.listBox.addCssClass('navigation-sidebar')
    this.listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);
    this.subs.connect(this.listBox, 'row-activated', (row: any) => {
      const handle = this.handleForRow(row);
      if (handle && !handle.removing) this.activate(handle.entry);
    });
    this.scrolled.setChild(this.listBox);

    this.registerCommands();

    // Reconcile the list whenever the global agent set changes — added/removed
    // agents animate their rows in/out rather than snapping the whole list.
    this.subs.add(zym.agents.onDidAddAgent(() => this.syncAgents()));
    this.subs.add(zym.agents.onDidRemoveAgent(() => this.syncAgents()));
    this.rebuild();
  }

  /** Whether the sidebar is collapsed (icons only). */
  get isCollapsed(): boolean {
    return this.collapsed;
  }

  // The sidebar header bar: an Adw.HeaderBar (so its height/chrome matches the
  // window header bar beside it) showing the project name as its centered title.
  // `.workbench-header` lets the chrome theme the bar.
  private buildHeader(): InstanceType<typeof Adw.HeaderBar> {
    const bar = new Adw.HeaderBar();
    bar.addCssClass('workbench-header');
    bar.setShowStartTitleButtons(false);
    bar.setShowEndTitleButtons(false);

    // The active session's name — empty until a session is named (`setSessionName`).
    // Hidden when collapsed (no room in 48px). Packed at the start (not the centered
    // title slot) so it aligns left.
    bar.setTitleWidget(new Gtk.Box()); // clear the centered title slot
    this.headerTitle = new Adw.WindowTitle({ title: '' });
    this.headerTitle.setTooltipText(process.cwd());
    bar.packStart(this.headerTitle);

    // Unsaved-changes marker — a warning-colored dot right after the project title,
    // shown when any open editor has unsaved edits (driven by the host via
    // `setModified`). Toggled with opacity so its slot never shifts the title.
    this.modifiedDot = iconLabel(Icons.modified);
    this.modifiedDot.addCssClass('zym-modified-dot');
    this.modifiedDot.setTooltipText('Unsaved changes');
    this.modifiedDot.setCanTarget(false);
    this.updateModifiedDot();
    bar.packStart(this.modifiedDot);
    return bar;
  }

  /** Reflect whether any open editor has unsaved edits (the host computes this). */
  setModified(modified: boolean): void {
    this.modified = modified;
    this.updateModifiedDot();
  }

  /** Reflect the active session name in the header — just the name, empty for the
   *  unnamed/default session (docs/session-management.md). */
  setSessionName(name: string | null): void {
    this.headerTitle?.setTitle(name ?? '');
  }

  // The dot shows only when there are unsaved edits and the sidebar is expanded
  // (collapsed has no room — the title is hidden too). Opacity keeps the slot fixed.
  private updateModifiedDot(): void {
    const visible = this.modified && !this.collapsed;
    this.modifiedDot?.setOpacity(visible ? 1 : 0);
    this.modifiedDot?.setCanTarget(visible);
  }

  // Toggle collapsed (icons only) ↔ expanded (icons + text): re-render the rows and
  // let the host resize the sidebar.
  private toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.headerTitle?.setVisible(!this.collapsed); // no room for the title at 48px
    this.updateModifiedDot(); // hide the marker too while collapsed
    this.rebuild();
    this.options.onToggleCollapsed?.(this.collapsed);
  }

  // Full, un-animated (re)build of every row — used for the initial render and the
  // collapse toggle (which re-renders all rows with different content). Add/remove of
  // individual agents goes through `syncAgents` instead, so it can animate.
  private rebuild(): void {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    for (const handle of this.handles) for (const unsub of handle.unsubs) unsub();
    this.handles = [];

    let child = this.listBox.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.listBox.remove(child);
      child = next;
    }

    // The user entry is always first; agents follow in launch order. Rows are built
    // already-revealed so the initial render snaps in without a transition.
    const entries: Entry[] = [{ kind: 'user' }, ...zym.agents.getAgents().map((agent): Entry => ({ kind: 'agent', agent }))];
    for (const entry of entries) {
      const handle = this.createHandle(entry, true);
      this.handles.push(handle);
      this.listBox.append(handle.row);
    }

    this.applySelection();
  }

  // Reconcile the agent rows against `zym.agents`: animate out rows whose agent has
  // gone, animate in rows for newly-launched agents (appended in launch order). The
  // always-present user row is left untouched.
  private syncAgents(): void {
    const agents = zym.agents.getAgents();
    const present = new Set(agents);

    // Animate out rows whose agent is no longer live.
    for (const handle of this.handles) {
      if (handle.removing || handle.entry.kind !== 'agent') continue;
      if (!present.has(handle.entry.agent)) this.animateOut(handle);
    }

    // Animate in rows for agents that don't have one yet (excludes rows mid-removal).
    const shown = new Set<Agent>();
    for (const handle of this.handles) {
      if (!handle.removing && handle.entry.kind === 'agent') shown.add(handle.entry.agent);
    }
    for (const agent of agents) {
      if (shown.has(agent)) continue;
      const handle = this.createHandle({ kind: 'agent', agent }, false);
      this.handles.push(handle);
      this.listBox.append(handle.row);
      this.animateIn(handle);
    }

    this.applySelection();
  }

  // Build a row for `entry`, wrapping its content in a Revealer that slides the row's
  // height open/shut. `reveal` is the revealer's initial state: true snaps the row in
  // (rebuild), false leaves it collapsed for `animateIn` to play.
  private createHandle(entry: Entry, reveal: boolean): RowHandle {
    const unsubs: Array<() => void> = [];
    const content =
      entry.kind === 'user'
        ? this.buildUserContent()
        : this.buildAgentContent(entry.agent, unsubs);

    const revealer = new Gtk.Revealer({
      // Fade + height-slide (rather than a hard SLIDE_DOWN): the opacity ramp masks
      // the content reflow and the accent/separator borders on the half-height row.
      transitionType: Gtk.RevealerTransitionType.FADE_SLIDE_DOWN,
      transitionDuration: ROW_TRANSITION_MS,
      revealChild: reveal,
    });
    revealer.setChild(content);

    const row = new Gtk.ListBoxRow();
    row.addCssClass('WorkbenchRow');
    row.setChild(revealer);
    return { entry, row, revealer, unsubs, removing: false };
  }

  // Play the slide-open transition. The flip to revealed is deferred one loop turn so
  // the revealer animates from collapsed rather than snapping straight to shown.
  private animateIn(handle: RowHandle): void {
    this.defer(0, () => {
      if (!handle.removing) handle.revealer.setRevealChild(true);
    });
  }

  // Play the slide-shut transition, then drop the row from the list. The row is marked
  // `removing` (so it leaves navigation/selection at once) and its subscriptions are
  // cut immediately — only the visual collapse waits for the timer.
  private animateOut(handle: RowHandle): void {
    if (handle.removing) return;
    handle.removing = true;
    handle.row.setSelectable(false);
    handle.row.setActivatable(false);
    for (const unsub of handle.unsubs) unsub();
    handle.unsubs = [];
    handle.revealer.setRevealChild(false);
    this.defer(ROW_TRANSITION_MS, () => {
      this.listBox.remove(handle.row);
      this.handles = this.handles.filter((h) => h !== handle);
    });
  }

  // Run `fn` after `ms` (0 → next tick), tracking the timer so a dispose/rebuild
  // can cancel it before it touches a freed widget.
  private defer(ms: number, fn: () => void): void {
    const id = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms > 0 ? ms : 0);
    this.timers.add(id);
  }

  // The row content box carrying the. When collapsed it holds only the leading
  // icon; expanded, the icon plus the trailing widgets.
  private rowContent(icon: InstanceType<typeof Gtk.Widget>, ...trailing: InstanceType<typeof Gtk.Widget>[]): InstanceType<typeof Gtk.Box> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    icon.addCssClass('Workbenchrow--icon')
    box.append(icon);
    if (!this.collapsed) for (const w of trailing) box.append(w);
    return box;
  }

  // The default row's content: the user, rendered like an agent — a symbolic person
  // icon (dimmed to match the exited agent icon) + name.
  private buildUserContent(): InstanceType<typeof Gtk.Box> {
    const icon = ImageIcons.USER(USER_ICON_SIZE);
    icon.addCssClass('Workbenchrow--user-icon');
    const label = new Gtk.Label({ label: this.userName, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END });
    label.addCssClass('Workbenchrow--label')
    return this.rowContent(icon, label);
  }

  // An agent row's content. Subscriptions (status/mode/title/files) are pushed onto
  // `unsubs`, which the row's handle owns and tears down when the row goes away.
  private buildAgentContent(
    agent: Agent,
    unsubs: Array<() => void>,
  ): InstanceType<typeof Gtk.Box> {
    // Status indicator (shared with the conversation footer): a bundled symbolic
    // icon — dot (idle/waiting), loading (working), circle outline (disconnected) —
    // swapped in place as the status changes. Shown in both modes; kept in sync.
    const status = createAgentStatusIcon(agent);
    unsubs.push(status.dispose);
    const dot = status.widget;

    if (this.collapsed) return this.rowContent(dot); // icon only

    const label = new Gtk.Label({ xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END });
    label.addCssClass('Workbenchrow--label'); // same title font as the user row
    label.setText(agent.title);
    unsubs.push(agent.onTitleChange(() => label.setText(agent.title)));

    // Single-line row: [status dot | name]. The edited-files badge now lives on the
    // agent-sidebar header (AgentSidebar), reflecting the active agent, not per-row.
    return this.rowContent(dot, label);
  }

  // The live rows (everything not mid-removal) — the source of truth for navigation
  // and selection, which must ignore rows that are animating out.
  private liveHandles(): RowHandle[] {
    return this.handles.filter((h) => !h.removing);
  }

  private handleForRow(row: InstanceType<typeof Gtk.ListBoxRow>): RowHandle | undefined {
    return this.handles.find((h) => h.row === row);
  }

  // Activate an entry: reveal the agent's terminal, or run the user action.
  private activate(entry: Entry | undefined): void {
    if (!entry) return;
    if (entry.kind === 'user') this.options.onActivateUser?.();
    else this.options.onActivate?.(entry.agent);
  }

  // --- Keyboard navigation (vim bare keys while .WorkbenchList is focused) --------

  private registerCommands(): void {
    zym.commands.add(this.root, {
      'core:down': { didDispatch: () => this.moveSelection(1), description: 'Move down' },
      'core:up': { didDispatch: () => this.moveSelection(-1), description: 'Move up' },
      'core:top': { didDispatch: () => this.selectLiveIndex(0), description: 'Go to the top' }, // `g g`
      'core:bottom': { didDispatch: () => this.selectLiveIndex(this.liveHandles().length - 1), description: 'Go to the bottom' }, // `G`
      'core:right': { didDispatch: () => this.activate(this.selectedEntry()), description: 'Reveal the selection' },
      // Lifecycle on the selected row (a no-op on the user row).
      'agent:restart': { didDispatch: () => this.withSelectedAgent((a) => this.options.onRestart?.(a)), description: 'Restart the selected agent' },
      'agent:rename': { didDispatch: () => this.withSelectedAgent((a) => this.options.onRename?.(a)), description: 'Rename the selected agent' },
      'agent:stop': { didDispatch: () => this.withSelectedAgent((a) => this.options.onStop?.(a)), description: 'Stop the selected agent' },
      'agent:close': { didDispatch: () => this.withSelectedAgent((a) => this.options.onClose?.(a)), description: 'Close the selected agent' },
      'agent:open-changes': { didDispatch: () => this.withSelectedAgent((a) => this.options.onOpenChanges?.(a)), description: "Open the selected agent's changes" },
    });
  }

  private selectedEntry(): Entry | undefined {
    const row = this.listBox.getSelectedRow();
    return row ? this.handleForRow(row)?.entry : undefined;
  }

  // Run `fn` with the agent of the currently selected row, if it's an agent row.
  private withSelectedAgent(fn: (agent: Agent) => void): void {
    const entry = this.selectedEntry();
    if (entry?.kind === 'agent') fn(entry.agent);
  }

  private moveSelection(delta: number): void {
    const live = this.liveHandles();
    const selectedRow = this.listBox.getSelectedRow();
    const current = selectedRow ? live.findIndex((h) => h.row === selectedRow) : -1;
    this.selectLiveIndex(current + delta);
  }

  // Select (and scroll/focus) the live row at `index`, clamped into range. Indexing is
  // over the live rows, so rows animating out don't count as positions.
  private selectLiveIndex(index: number): void {
    const live = this.liveHandles();
    if (live.length === 0) return;
    const clamped = Math.max(0, Math.min(index, live.length - 1));
    const handle = live[clamped];
    this.listBox.selectRow(handle.row);
    handle.row.grabFocus();
  }

  /** Move keyboard focus into the list (so its scoped bindings apply and the
   *  pane-navigation commands see focus as being within the workbench list). */
  focus(): void {
    const row = this.listBox.getSelectedRow() ?? this.liveHandles()[0]?.row;
    if (row) row.grabFocus();
    else this.listBox.grabFocus();
  }

  /** Select the row for `agent`, or the default user row when `null`. Called when
   *  an agent gains/loses focus. */
  selectAgent(agent: Agent | null): void {
    this.selected = agent;
    this.applySelection();
  }

  // Reflect `this.selected` onto the list box (the user row when nothing is
  // selected, so a default entry is always highlighted).
  private applySelection(): void {
    const live = this.liveHandles();
    const handle = this.selected
      ? live.find((h) => h.entry.kind === 'agent' && h.entry.agent === this.selected)
      : live[0]; // the user row
    if (handle) this.listBox.selectRow(handle.row);
  }

  dispose(): void {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    for (const handle of this.handles) for (const unsub of handle.unsubs) unsub();
    this.handles = [];
    this.subs.dispose();
  }
}
