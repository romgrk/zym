/*
 * WorkbenchList — the contents of the WorkbenchSidebar (the full-height column at the
 * very left of the window). Each entry is (will be) associated with a particular
 * workbench workbench: the first ("default", selected-by-default) entry is the
 * **user** (rendered as a pseudo-agent), the rest are the running terminal agents
 * (`quilx.agents`). The list is never empty — the user entry is always present —
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
 * The assembled widget (header bar + scrollable list) is exposed via `root`.
 */
import * as Os from 'node:os';
import { Adw, GLib, Gtk, Pango } from '../gi.ts';
import { quilx } from '../quilx.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import { createAgentStatusIcon, createAgentModeBadge, agentWorktreeMarkup } from './agentStatusIcon.ts';
import type { AgentTerminal } from './AgentTerminal.ts';

const USER_GLYPH = String.fromCodePoint(0xf007); // nf-fa-user (the default/user entry)
// Header logo placeholder (also the collapse toggle): a solid square glyph (so
// width == height) until there's a real logo. `LOGO_SIZE` makes the widget square.
const LOGO_GLYPH = '■'; // U+25A0 black square — placeholder
const CHANGED_GLYPH = String.fromCodePoint(0xf040); // nf-fa-pencil (changed-files badge)
// Add/remove animation duration: each row rides in/out inside a Gtk.Revealer that
// slides its height open (on launch) or shut (on close).
const ROW_TRANSITION_MS = 200;

addStyles(`
  /* A transparent left border keeps the row content from shifting when the active
     row gains its accent indicator; a subtle bottom border separates the rows.
     The row height itself lives on the content box (#WorkbenchRow) rather than the
     row, so the add/remove revealer can animate the row from 0 → full height
     without min-height pinning it open. */
  #WorkbenchList list row {
    border-left: 3px solid transparent;
    border-bottom: 1px solid ${theme.ui.border};
  }
  /* Each row is as tall as the header bar (an Adw.HeaderBar is 47px), so the list
     reads as a column of header-height entries. */
  #WorkbenchRow {
    min-height: 47px;
  }
  /* The active row is marked by an accent left-border indicator rather than a
     filled background. */
  #WorkbenchList list row:selected {
    color: ${theme.ui.fg};
    background-color: ${theme.ui.bg};
    border-left-color: ${theme.ui.info};
  }
  /* Logo placeholder (also the collapse toggle): a solid square glyph, accent-
     colored. Swap for the real logo image when there is one. */
  #WorkbenchList .workbenchlist-logo {
    color: ${theme.ui.fg};
  }
  /* Per-row edited-files count — a flat, muted button (click opens the files). */
  #WorkbenchRow .workbenchrow-files {
    min-width: 0;
    min-height: 0;
    padding: 0 2px;
    margin: 0;
    background: none;
    box-shadow: none;
  }
  #WorkbenchRow .workbenchrow-files label {
    color: ${theme.ui.textMuted};
    font-size: 0.85em;
  }
  #WorkbenchRow .workbenchrow-files:hover label { color: ${theme.ui.fg}; }
`);

export interface WorkbenchListOptions {
  /** Fired when an agent row is activated (clicked / Enter). */
  onActivate?: (agent: AgentTerminal) => void;
  /** Fired when the default (user) row is activated. */
  onActivateUser?: () => void;
  /** Fired when the robot button toggles collapse; the host resizes the sidebar. */
  onToggleCollapsed?: (collapsed: boolean) => void;
  /** Restart an agent (respawn / resume) — the list's `r` key. */
  onRestart?: (agent: AgentTerminal) => void;
  /** Stop an agent's process (it stays listed, restartable) — the list's `x` key. */
  onStop?: (agent: AgentTerminal) => void;
  /** Close an agent (terminate if running, then remove it from the list) — the `d d` key. */
  onClose?: (agent: AgentTerminal) => void;
  /** Rename an agent — the list's `R` key. */
  onRename?: (agent: AgentTerminal) => void;
  /** Open the files an agent has edited — the changed-files badge / `o` key. */
  onOpenChanges?: (agent: AgentTerminal) => void;
  /** Display name for the default (user) entry; defaults to the OS username. */
  userName?: string;
}

// A list entry: the always-present user row, or one of the running agents.
type Entry = { kind: 'user' } | { kind: 'agent'; agent: AgentTerminal };

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
  readonly root: InstanceType<typeof Gtk.Box>;

  private readonly listBox: InstanceType<typeof Gtk.ListBox>;
  private readonly scrolled: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly options: WorkbenchListOptions;
  private readonly userName: string;
  // Renders nerd-font glyphs (header robot, user, working cog) in the icon font.
  private readonly iconAttrs: InstanceType<typeof Pango.AttrList>;
  // The built rows, in list-box order (user first, then agents in launch order).
  // Includes rows mid-removal (`removing`) until their collapse transition finishes.
  private handles: RowHandle[] = [];
  // Outstanding GLib source ids for in-flight row transitions, cancelled on dispose
  // (and on a full rebuild) so a deferred callback never touches a freed widget.
  private timers = new Set<number>();
  // The agent whose row is selected (kept stable across rebuilds); null selects the
  // user row by default. Reflects the last-focused agent; see AppWindow.
  private selected: AgentTerminal | null = null;
  // Collapsed = icons only (narrow); expanded = icons + text. Toggled by the
  // header-bar logo button.
  private collapsed = false;
  private readonly subs = new CompositeDisposable();

  constructor(options: WorkbenchListOptions = {}) {
    this.options = options;
    this.userName = options.userName ?? Os.userInfo().username;

    this.iconAttrs = Pango.AttrList.new();
    this.iconAttrs.insert(Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)));

    this.listBox = new Gtk.ListBox();
    this.listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);
    this.listBox.on('row-activated', (row: any) => {
      const handle = this.handleForRow(row);
      if (handle && !handle.removing) this.activate(handle.entry);
    });

    this.scrolled = new Gtk.ScrolledWindow();
    this.scrolled.setChild(this.listBox);
    this.scrolled.setVexpand(true);

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.setName('WorkbenchList'); // selector identity + CSS (#WorkbenchList)
    this.registerCommands();
    this.root.append(this.buildHeader());
    this.root.append(this.scrolled);

    // Reconcile the list whenever the global agent set changes — added/removed
    // agents animate their rows in/out rather than snapping the whole list.
    this.subs.add(quilx.agents.onDidAddAgent(() => this.syncAgents()));
    this.subs.add(quilx.agents.onDidRemoveAgent(() => this.syncAgents()));
    this.rebuild();
  }

  /** Whether the sidebar is collapsed (icons only). */
  get isCollapsed(): boolean {
    return this.collapsed;
  }

  // The sidebar header bar: an Adw.HeaderBar (so its height/chrome matches the
  // window header bar beside it) whose only content is a left-aligned logo button
  // — styled flat like the git branch button — that toggles collapse. The logo is
  // a square placeholder for now (no asset yet). `.workbench-header` lets the chrome
  // theme the bar.
  private buildHeader(): InstanceType<typeof Adw.HeaderBar> {
    const bar = new Adw.HeaderBar();
    bar.addCssClass('workbench-header');
    bar.setShowStartTitleButtons(false);
    bar.setShowEndTitleButtons(false);
    bar.setTitleWidget(new Gtk.Box()); // clear the centered title — logo only

    const logo = new Gtk.Label({ label: LOGO_GLYPH }); // placeholder; swap for the real logo
    logo.addCssClass('workbenchlist-logo');
    logo.setValign(Gtk.Align.CENTER);
    logo.setHalign(Gtk.Align.CENTER);
    const button = new Gtk.Button();
    button.setChild(logo);
    button.addCssClass('flat'); // same flat style as the git branch button
    button.setTooltipText('Collapse / expand the sidebar');
    button.on('clicked', () => this.toggleCollapsed());
    bar.packStart(button);
    return bar;
  }

  // Toggle collapsed (icons only) ↔ expanded (icons + text): re-render the rows and
  // let the host resize the sidebar.
  private toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.rebuild();
    this.options.onToggleCollapsed?.(this.collapsed);
  }

  // Full, un-animated (re)build of every row — used for the initial render and the
  // collapse toggle (which re-renders all rows with different content). Add/remove of
  // individual agents goes through `syncAgents` instead, so it can animate.
  private rebuild(): void {
    for (const id of this.timers) GLib.sourceRemove(id);
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
    const entries: Entry[] = [{ kind: 'user' }, ...quilx.agents.getAgents().map((agent): Entry => ({ kind: 'agent', agent }))];
    for (const entry of entries) {
      const handle = this.createHandle(entry, true);
      this.handles.push(handle);
      this.listBox.append(handle.row);
    }

    this.applySelection();
  }

  // Reconcile the agent rows against `quilx.agents`: animate out rows whose agent has
  // gone, animate in rows for newly-launched agents (appended in launch order). The
  // always-present user row is left untouched.
  private syncAgents(): void {
    const agents = quilx.agents.getAgents();
    const present = new Set(agents);

    // Animate out rows whose agent is no longer live.
    for (const handle of this.handles) {
      if (handle.removing || handle.entry.kind !== 'agent') continue;
      if (!present.has(handle.entry.agent)) this.animateOut(handle);
    }

    // Animate in rows for agents that don't have one yet (excludes rows mid-removal).
    const shown = new Set<AgentTerminal>();
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
    const content = entry.kind === 'user' ? this.buildUserContent() : this.buildAgentContent(entry.agent, unsubs);

    const revealer = new Gtk.Revealer({
      // Fade + height-slide (rather than a hard SLIDE_DOWN): the opacity ramp masks
      // the content reflow and the accent/separator borders on the half-height row.
      transitionType: Gtk.RevealerTransitionType.FADE_SLIDE_DOWN,
      transitionDuration: ROW_TRANSITION_MS,
      revealChild: reveal,
    });
    revealer.setChild(content);

    const row = new Gtk.ListBoxRow();
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

  // Run `fn` after `ms` (0 → next idle) on the GLib loop, tracking the source so a
  // dispose/rebuild can cancel it before it touches a freed widget.
  private defer(ms: number, fn: () => void): void {
    let id = 0;
    const callback = () => {
      this.timers.delete(id);
      fn();
      return GLib.SOURCE_REMOVE;
    };
    id = ms <= 0
      ? GLib.idleAdd(GLib.PRIORITY_DEFAULT, callback)
      : GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, ms, callback);
    this.timers.add(id);
  }

  // The content box carrying the #WorkbenchRow identity (the Revealer's child). When
  // collapsed it holds only the leading icon; expanded, the icon plus the trailing
  // widgets.
  private rowContent(icon: InstanceType<typeof Gtk.Widget>, ...trailing: InstanceType<typeof Gtk.Widget>[]): InstanceType<typeof Gtk.Box> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    box.setName('WorkbenchRow');
    box.append(icon);
    if (!this.collapsed) for (const w of trailing) box.append(w);
    return box;
  }

  // The default row's content: the user, rendered like an agent — a person glyph + name.
  private buildUserContent(): InstanceType<typeof Gtk.Box> {
    const icon = new Gtk.Label({ label: USER_GLYPH });
    icon.setAttributes(this.iconAttrs);
    const label = new Gtk.Label({ label: this.userName, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END });
    return this.rowContent(icon, label);
  }

  // An agent row's content. Subscriptions (status/mode/title/files) are pushed onto
  // `unsubs`, which the row's handle owns and tears down when the row goes away.
  private buildAgentContent(agent: AgentTerminal, unsubs: Array<() => void>): InstanceType<typeof Gtk.Box> {
    // Status indicator (shared with the agent picker): a colored dot, or the cog
    // glyph while working. Shown in both modes; kept in sync.
    const status = createAgentStatusIcon(agent);
    unsubs.push(status.dispose);
    const dot = status.widget;

    if (this.collapsed) return this.rowContent(dot); // icon only

    // Permission-mode badge (plan/acceptEdits/auto/…), hidden in `default` mode.
    const mode = createAgentModeBadge(agent);
    unsubs.push(mode.dispose);

    const label = new Gtk.Label({ xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END });
    label.setText(agent.title);
    unsubs.push(agent.onTitleChange(() => label.setText(agent.title)));

    // Linked-worktree badge (git glyph + branch), only when the agent runs in one.
    const worktreeMarkup = agentWorktreeMarkup(agent.worktree);
    const worktree = worktreeMarkup
      ? new Gtk.Label({ useMarkup: true, label: worktreeMarkup })
      : null;

    // Changed-files badge (pencil + count) — a flat button that opens the edited
    // files; hidden until the agent edits one.
    const filesLabel = new Gtk.Label({ useMarkup: true });
    const files = new Gtk.Button();
    files.setChild(filesLabel);
    files.addCssClass('flat');
    files.addCssClass('workbenchrow-files');
    files.setCanFocus(false);
    files.on('clicked', () => this.options.onOpenChanges?.(agent));
    const updateFiles = () => this.applyFiles(files, filesLabel, agent);
    updateFiles();
    unsubs.push(agent.onDidChangeFiles(updateFiles));

    const trailing = [mode.widget, label, ...(worktree ? [worktree] : []), files];
    return this.rowContent(dot, ...trailing);
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

  // --- Keyboard navigation (vim bare keys while #WorkbenchList is focused) --------

  private registerCommands(): void {
    quilx.commands.add(this.root, {
      'core:down': () => this.moveSelection(1),
      'core:up': () => this.moveSelection(-1),
      'core:top': () => this.selectLiveIndex(0), // `g g`
      'core:bottom': () => this.selectLiveIndex(this.liveHandles().length - 1), // `G`
      'core:right': () => this.activate(this.selectedEntry()), // reveal the selection
      // Lifecycle on the selected row (a no-op on the user row).
      'agent:restart': () => this.withSelectedAgent((a) => this.options.onRestart?.(a)),
      'agent:rename': () => this.withSelectedAgent((a) => this.options.onRename?.(a)),
      'agent:stop': () => this.withSelectedAgent((a) => this.options.onStop?.(a)),
      'agent:close': () => this.withSelectedAgent((a) => this.options.onClose?.(a)),
      'agent:open-changes': () => this.withSelectedAgent((a) => this.options.onOpenChanges?.(a)),
    });
  }

  private selectedEntry(): Entry | undefined {
    const row = this.listBox.getSelectedRow();
    return row ? this.handleForRow(row)?.entry : undefined;
  }

  // Run `fn` with the agent of the currently selected row, if it's an agent row.
  private withSelectedAgent(fn: (agent: AgentTerminal) => void): void {
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
  selectAgent(agent: AgentTerminal | null): void {
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

  // The changed-files badge: a pencil glyph + count, or hidden when none. The
  // glyph is rendered in the icon font via a markup span; the tooltip lists names.
  private applyFiles(
    button: InstanceType<typeof Gtk.Button>,
    label: InstanceType<typeof Gtk.Label>,
    agent: AgentTerminal,
  ): void {
    const changed = agent.changedFiles;
    if (changed.length === 0) {
      button.setVisible(false);
      return;
    }
    button.setVisible(true);
    label.setMarkup(`<span font_family="${ICON_FONT_FAMILY}">${CHANGED_GLYPH}</span> ${changed.length}`);
    const names = changed.map((path) => path.split('/').pop() ?? path);
    button.setTooltipText(`Edited ${changed.length} file${changed.length === 1 ? '' : 's'} — click to open:\n${names.join('\n')}`);
  }

  dispose(): void {
    for (const id of this.timers) GLib.sourceRemove(id);
    this.timers.clear();
    for (const handle of this.handles) for (const unsub of handle.unsubs) unsub();
    this.handles = [];
    this.subs.dispose();
  }
}
