/*
 * WorkbenchView — the active workbench's view layer: the window's sidebars and docks
 * (reveal / toggle / show-hide), keyboard-focus memory, and directional + cyclic pane
 * navigation across the top-level focus zones. Split out of AppWindow so the shell only
 * composes; this owns "where focus goes and which columns/docks are shown".
 *
 * It always acts on the *active* workbench (read through `getWorkbench`), and the
 * window-level columns (the WorkbenchList sidebar + the agent secondary sidebar) it
 * attaches/detaches on their Paned splits. The panel-tree / tab-content operations it
 * needs (focus an editor/terminal, open a split view, build the live diff, register a
 * tab-close handler) are injected — they belong to the PaneItems spine.
 */
import Gtk from 'gi:Gtk-4.0';
import type Adw from 'gi:Adw-1';
type ApplicationWindow = InstanceType<typeof Adw.ApplicationWindow>;
type Widget = InstanceType<typeof Gtk.Widget>;
import type { Agent } from '../../agents/types.ts';
import { Workbench, type BottomDock, type DockSide } from './Workbench.ts';
import { Panel } from '../Panel.ts';
import type { PanelChild } from '../Panel.ts';
import type { Direction } from '../PanelGroup.ts';
import type { Sidebar } from '../Sidebar.ts';
import type { AgentSidebar } from '../AgentSidebar.ts';
import { GitPanel } from '../git/GitPanel.ts';
import { PluginManagerPanel } from '../PluginManagerPanel.ts';
import type { DiffView } from '../DiffView.ts';
import { fileIconGlyph } from '../fileIcons.ts';
import { Icons } from '../icons.ts';

// Expanded width (px) of the workbench sidebar — the full-height column at the very
// left of the window, outside (left of) the header bar — and its collapsed width
// (icons only). These are the two positions of the top-level sidebar↔content split.
export const SIDEBAR_WIDTH = 280;
export const SIDEBAR_COLLAPSED_WIDTH = 48;
// Default width of the agent "secondary sidebar" column (the agent widget). Wider
// than the file/Source-Control dock; resizable, and a dragged width is remembered
// for the rest of the session.
export const AGENT_SIDEBAR_WIDTH = 480;

// Overlap length of two 1-D segments [a0, a0+aLen] and [b0, b0+bLen]; <= 0 means
// they don't overlap. Used by directional pane navigation to require cross-axis
// alignment between zones.
function span(a0: number, aLen: number, b0: number, bLen: number): number {
  return Math.min(a0 + aLen, b0 + bLen) - Math.max(a0, b0);
}

export interface WorkbenchViewDeps {
  window: ApplicationWindow;
  sidebar: Sidebar;
  agentSidebar: AgentSidebar;
  // The top-level horizontal split (WorkbenchList column | rest) and the agent
  // secondary-sidebar split (agent column | content), both built by AppWindow.
  sidebarPaned: InstanceType<typeof Gtk.Paned>;
  agentPaned: InstanceType<typeof Gtk.Paned>;
  /** The active workbench (switches on person change). */
  getWorkbench: () => Workbench<'user' | Agent>;
  /** The agent whose workbench is active, if any. */
  activeAgent: () => Agent | null;
  /** The active editor's file path, for the vim-style split-opens-it behaviour. */
  activeEditorFile: () => string | null;
  /** Focus the editor/terminal backing a center-tab content widget. */
  focusContent: (widget: Widget) => void;
  /** Open a second *view* of `path` in `panel` (split). */
  openFileView: (path: string, panel: Panel) => void;
  /** Open (revealing) `path` — the GitPanel's row activation. */
  openFile: (path: string) => unknown;
  /** Build the live, editable working-tree diff for `workbench` (GitPanel embeds it). */
  buildCurrentChangesDiff: (workbench: Workbench<'user' | Agent>) => Promise<DiffView | null>;
  /** Register a tab-close teardown on a center widget (the PaneItems seam). */
  setTabCloseHandler: (widget: Widget, fn: () => void) => void;
  scheduleAutosave: () => void;
  toast: (message: string) => void;
}

export class WorkbenchView {
  private readonly d: WorkbenchViewDeps;

  // Per-tab focus memory: the widget that last held keyboard focus inside each
  // panel-tab child, so re-activating a panel restores focus to the exact same
  // widget. Keyed by the tab's content widget (the `.is-panel-child`); a WeakMap so
  // closed tabs drop.
  private readonly focusMemory = new WeakMap<Widget, Widget>();

  private sidebarHidden = false; // user toggle (sidebar:toggle); detaches the column entirely
  private sidebarShownWidth = SIDEBAR_WIDTH; // split position captured on hide, re-applied on show
  private agentSidebarWidth = AGENT_SIDEBAR_WIDTH; // last dragged width, re-applied on show
  private agentSidebarHidden = false; // user toggle (agent-sidebar:toggle)
  // The plugin manager center tab handle; null after it is closed.
  private pluginManagerTab: { root: Widget; child: PanelChild } | null = null;

  constructor(deps: WorkbenchViewDeps) {
    this.d = deps;
  }

  private get workbench(): Workbench<'user' | Agent> {
    return this.d.getWorkbench();
  }

  // --- Sidebars --------------------------------------------------------------

  // Apply the sidebar collapse/expand width to the top-level split: the list's robot
  // button toggles between icons-only and icons+text and forwards the new state here.
  setSidebarCollapsed(collapsed: boolean): void {
    this.d.sidebarPaned.setPosition(collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH);
  }

  // Toggle the workbench sidebar's visibility (sidebar:toggle, `ctrl-w g s`). Mirrors
  // toggleAgentSidebar: detach/attach the top-level split's start child — rather than
  // toggling `visible` — so an absent column leaves no stray handle, restoring its last
  // width (collapsed or expanded) on show. Steers focus to the center when it hides out
  // from under focus, into the list when freshly revealed.
  toggleSidebar(): void {
    const focusWasInside = this.isFocusWithin(this.d.sidebar.root);
    this.sidebarHidden = !this.sidebarHidden;
    if (this.sidebarHidden) {
      this.sidebarShownWidth = this.d.sidebarPaned.getPosition();
      this.d.sidebarPaned.setStartChild(null);
      if (focusWasInside) this.focusActivePane(); // it hid out from under focus
    } else {
      this.d.sidebarPaned.setStartChild(this.d.sidebar.root);
      this.d.sidebarPaned.setPosition(this.sidebarShownWidth);
      this.d.sidebar.list.focus(); // freshly revealed — focus into it
    }
  }

  // Remember a dragged agent-sidebar width so it survives switching away and back.
  // Driven by AppWindow's agentPaned `notify::position`.
  rememberAgentSidebarWidth(width: number): void {
    this.agentSidebarWidth = width;
  }

  // Reveal the agent "secondary sidebar" for `agent` (its widget becomes the visible
  // stack child + the column is attached at its last width), or detach the column —
  // when there's no agent (the user workbench) or the user has toggled it hidden.
  // Attaching/detaching the Paned start child — rather than toggling visibility —
  // keeps the column free of a stray handle when absent.
  showAgentSidebar(agent: Agent | null): void {
    if (agent) this.d.agentSidebar.show(agent); // keep the stack on the active agent (+ its edited-files badge)
    else this.d.agentSidebar.clearActive(); // user workbench — no agent to track
    const show = agent !== null && !this.agentSidebarHidden;
    if (show && !this.d.agentPaned.getStartChild()) {
      this.d.agentPaned.setStartChild(this.d.agentSidebar.root);
      this.d.agentPaned.setPosition(this.agentSidebarWidth);
    } else if (!show && this.d.agentPaned.getStartChild()) {
      this.d.agentPaned.setStartChild(null);
    }
  }

  // Toggle the agent "secondary sidebar" visibility (agent-sidebar:toggle, `ctrl-w g a`).
  // No-op + toast on the user workbench (nothing to toggle). Mirrors toggleDockSide:
  // focus the agent when revealing, fall back to the center when hiding out from under
  // focus.
  toggleAgentSidebar(): void {
    const agent = this.d.activeAgent();
    if (!agent) {
      this.d.toast('No agent sidebar to toggle');
      return;
    }
    const focusWasInside = this.isFocusWithin(this.d.agentSidebar.root);
    this.agentSidebarHidden = !this.agentSidebarHidden;
    this.showAgentSidebar(agent);
    if (this.agentSidebarHidden) {
      if (focusWasInside) this.focusActivePane(); // it hid out from under focus
    } else {
      agent.focus(); // freshly revealed — focus into it
    }
  }

  // --- Docks -----------------------------------------------------------------

  // The Panel currently shown in the bottom dock (`workbench.bottomDock`), or null.
  private bottomDockPanel(): Panel | null {
    switch (this.workbench.bottomDock) {
      case 'notifications': return this.workbench.notificationPanel;
      case 'diagnostics': return this.workbench.diagnosticsDock;
      case 'keymap': return this.workbench.keymapDock;
      default: return null;
    }
  }

  // Show / hide a dock side (the dock-visibility toggle), keeping its panels intact.
  // Showing moves focus into the dock; hiding falls focus back to the center when it
  // was inside the dock. An empty side has nothing to toggle (reports a toast). The
  // new layout is autosaved so it survives a restore.
  toggleDockSide(side: DockSide): void {
    if (!this.workbench.isDockOccupied(side)) {
      this.d.toast(`No ${side} dock to toggle`);
      return;
    }
    const focusWasInside = this.isFocusWithin(this.workbench.root) && this.isDockSideFocused(side);
    this.workbench.toggleDock(side);
    if (this.workbench.isDockVisible(side)) this.focusDockSide(side);
    else if (focusWasInside) this.focusActivePane(); // dock hid out from under focus
    this.d.scheduleAutosave();
  }

  // Whether keyboard focus currently sits inside the named dock side's content.
  private isDockSideFocused(side: DockSide): boolean {
    if (side === 'right') return this.isFocusWithin(this.workbench.leftPanel.root);
    if (side === 'bottom') {
      const panel = this.bottomDockPanel();
      return panel ? this.isFocusWithin(panel.root) : false;
    }
    return false; // left / top carry no built-in content yet
  }

  // Move focus into a freshly-shown dock side's content.
  private focusDockSide(side: DockSide): void {
    if (side === 'right') {
      this.focusSidePanel();
    } else if (side === 'bottom') {
      const panel = this.bottomDockPanel();
      if (panel) this.focusDock(panel, () => this.focusBottomDockContent());
    }
    // left / top have no built-in content to focus yet.
  }

  // Focus whatever view currently fills the bottom dock.
  private focusBottomDockContent(): void {
    if (this.workbench.bottomDock === 'notifications') this.workbench.notificationLog.focus();
    else if (this.workbench.bottomDock === 'diagnostics') this.workbench.diagnosticsPanel.focus();
    else if (this.workbench.bottomDock === 'keymap') this.workbench.keymapPanel.focus();
  }

  // Toggle the notification log in the bottom dock (replacing whatever was there).
  toggleNotificationLog(): void {
    if (this.workbench.bottomDock === 'notifications' && this.workbench.isDockVisible('bottom')) {
      this.setBottomDock(null);
    } else {
      this.setBottomDock('notifications');
      this.workbench.notificationLog.focus();
    }
  }

  // Toggle the Diagnostics panel in the bottom dock (replacing whatever was there).
  // Only closes when it's already the *shown* content — if it's selected but the
  // bottom dock was hidden (via the dock-visibility toggle), this re-reveals it.
  toggleDiagnosticsPanel(): void {
    if (this.workbench.bottomDock === 'diagnostics' && this.workbench.isDockVisible('bottom')) {
      this.setBottomDock(null);
    } else {
      this.setBottomDock('diagnostics');
      this.workbench.diagnosticsPanel.focus();
    }
  }

  // Toggle the keybinding reference list in the bottom dock.
  toggleKeymapPanel(): void {
    if (this.workbench.bottomDock === 'keymap' && this.workbench.isDockVisible('bottom')) {
      this.setBottomDock(null);
    } else {
      this.setBottomDock('keymap');
      this.workbench.keymapPanel.focus();
    }
  }

  // Dock the given panel into the active workbench's bottom slot (or clear it),
  // tracking which is shown on the workbench itself (`workbench.bottomDock`). Each
  // workbench owns its bottom dock independently, so it does NOT carry across to
  // another person's workbench — switching simply shows that workbench's own slot.
  private setBottomDock(which: BottomDock): void {
    this.workbench.bottomDock = which;
    this.workbench.setBottom(this.bottomDockPanel());
  }

  // Hide the named bottom dock if it's the one shown (its tab-close request), and
  // veto the underlying page close so the view persists for the next reopen.
  // Returns false so Panel keeps the page intact. The hide is deferred out of the
  // close-page signal emission, since it reparents the dock (an ancestor of the
  // emitting tab view) and that's unsafe to do mid-emission.
  hideBottomDock(which: Exclude<BottomDock, null>): boolean {
    setTimeout(() => {
      if (this.workbench.bottomDock === which) this.setBottomDock(null);
    }, 0);
    return false;
  }

  // Collapse the left dock when its last tab is closed, so the center reclaims the
  // space instead of showing the empty-state placeholder. The reveal/focus path
  // re-attaches and repopulates it. Runs from onEmpty (page-detached, after the
  // close completes), where the reparent is safe and synchronous (no one-frame
  // flash of the empty state).
  detachDock(panel: Panel): void {
    if (panel === this.workbench.leftPanel) this.workbench.setRight(null);
  }

  // Reveal+focus the file tree in the right-side dock, re-attaching the dock panel
  // and re-adding the tab if they were collapsed away by closing the dock's last
  // tab. The panel is re-attached (rooted) *before* any re-add: adding to a
  // detached, unrooted Adw.TabView yields a blank page.
  revealFileTree(): void {
    if (this.workbench.leftPanel.root.getParent() === null)
      this.workbench.setRight({ root: this.workbench.leftPanel.root });
    if (!this.workbench.leftPanel.getChildren().includes(this.workbench.fileTree.root)) {
      if (this.workbench.fileTree.root.getParent()) this.workbench.fileTree.root.unparent(); // drop any closed page
      this.workbench.filesTab = this.workbench.leftPanel.add(this.workbench.fileTree.root, {
        title: `${fileIconGlyph('', true)}  Files`,
      });
    }
    this.workbench.filesTab.select();
    this.workbench.fileTree.focus();
  }

  // Open (or reveal) Source Control as a tab in the active center panel — a normal
  // tab, no longer docked on the right. Reveals the existing tab when it is still
  // hosted in a panel; otherwise (re)adds it, unparenting any closed page first (the
  // zombie rule). The GitPanel is lazily built once per workbench (ensureGitPanel)
  // and reused across close/reopen.
  revealGitPanel(): void {
    const gitPanel = this.ensureGitPanel(this.workbench);
    if (this.workbench.center.reveal(gitPanel.root)) {
      gitPanel.focus();
      return;
    }
    // Still attached to the live window tree but not in this center — e.g. its tab was
    // dragged into a dock (a Panel outside the center). Reveal it where it lives instead
    // of unparenting it: unparenting a live page child corrupts it into a zombie that
    // vanishes from the tree (the reveal rule in docs/panels.md). `getRoot()` is non-null
    // only while it sits in the live tree, so it tells a live host from an orphaned page.
    if (gitPanel.root.getRoot()) {
      Panel.containing(gitPanel.root)?.reveal(gitPanel.root);
      gitPanel.focus();
      return;
    }
    if (gitPanel.root.getParent()) gitPanel.root.unparent(); // drop any closed/orphaned page
    this.workbench.gitTab = this.workbench.center.add(gitPanel.root, {
      title: `${Icons.git}  Git`,
      requireTabBar: true,
    });
    gitPanel.focus();
  }

  // Lazily create this workbench's Source Control panel on first reveal — it isn't
  // built at startup, so a workbench opens no git subscription until the user asks
  // for it. Idempotent: returns the existing panel once created.
  ensureGitPanel(workbench: Workbench<'user' | Agent>): GitPanel {
    if (workbench.gitPanel) return workbench.gitPanel;
    const gitPanel = new GitPanel({
      cwd: workbench.cwd,
      git: workbench.git,
      onOpenFile: (path) => this.d.openFile(path),
      // Build the embedded live diff against THIS workbench's repo (l/enter/o reveals the
      // selected change in it); the panel owns its lifecycle.
      buildDiffView: () => this.d.buildCurrentChangesDiff(workbench),
    });
    workbench.gitPanel = gitPanel;
    return gitPanel;
  }

  // Open (or reveal) the Plugin Manager as a center tab. Reveals the existing tab
  // when it is still hosted in a panel; opens a fresh one otherwise.
  openPluginManager(): void {
    if (this.pluginManagerTab && Panel.containing(this.pluginManagerTab.root)) {
      this.pluginManagerTab.child.select();
      this.pluginManagerTab.root.grabFocus();
      return;
    }
    const manager = new PluginManagerPanel();
    const child = this.workbench.center.add(manager.root, { title: 'Plugin Manager', requireTabBar: true });
    this.pluginManagerTab = { root: manager.root, child };
    // Sever the panel's command reg + per-row switch handlers when its tab closes
    // (disposeChild fires this), else the whole panel leaks per open/close (rule 2).
    this.d.setTabCloseHandler(manager.root, () => { manager.dispose(); this.pluginManagerTab = null; });
    manager.root.grabFocus();
  }

  // --- Focus & pane navigation ----------------------------------------------

  // Split the active center pane, opening the active editor's file in the new
  // pane (vim-style) when there is one; otherwise leave it empty and focused.
  splitPane(direction: Direction): void {
    const path = this.d.activeEditorFile();
    const pane = this.workbench.center.split(direction); // the new empty pane becomes active
    // A second *view* of the same file (shared Document/model), not a reveal — so a
    // split shows it side by side with independent cursors / scroll / folds.
    if (path) this.d.openFileView(path, pane);
    else this.focusActivePane();
  }

  // `ctrl-w c` acts on the focused zone. In a dock it closes that dock's active
  // tab — the dock collapses itself once its last tab goes, so focus then falls
  // back to the center. In the center it closes the active split pane and focuses
  // whatever pane takes its place.
  closePane(): void {
    const dock = this.focusedDockPanel();
    if (dock) {
      dock.closeActiveTab();
      if (dock.root.getParent() === null) this.focusActivePane(); // dock collapsed away
      return;
    }
    this.workbench.center.closeActivePanel();
    this.focusActivePane();
  }

  // The dock panel (left / agent / bottom) that currently holds keyboard focus, or
  // null when focus is in the center or nowhere.
  private focusedDockPanel(): Panel | null {
    const docks: Panel[] = [this.workbench.leftPanel];
    if (this.workbench.bottomDock === 'notifications') docks.push(this.workbench.notificationPanel);
    else if (this.workbench.bottomDock === 'diagnostics') docks.push(this.workbench.diagnosticsDock);
    else if (this.workbench.bottomDock === 'keymap') docks.push(this.workbench.keymapDock);
    return docks.find((p) => this.isFocusWithin(p.root)) ?? null;
  }

  // The top-level focus zones: each dock section and the center, with how to move
  // focus into each. Directional and cyclic pane navigation operate over these
  // (within the center, navigation first moves between its own splits). Whatever
  // currently occupies the bottom dock counts as a zone (so `ctrl-w j` reaches it).
  private focusZones(): { root: Widget; focus: () => void }[] {
    const zones: { root: Widget; focus: () => void }[] = [
      // The file tree lives in the right-side dock (one zone); entering it focuses
      // the tree (Source Control is a center tab now, not a dock tab).
      { root: this.workbench.leftPanel.root, focus: () => this.focusSidePanel() },
      // The agent list is its own full-height sidebar (left of everything); its
      // geometry makes it the leftmost zone for directional pane navigation.
      { root: this.d.sidebar.list.root, focus: () => this.d.sidebar.list.focus() },
      { root: this.workbench.center.root, focus: () => this.focusActivePane() },
    ];
    // The agent "secondary sidebar" (when an agent workbench is active) is a zone too —
    // its geometry (between the list and the center) places it for ctrl-w h/l.
    const activeAgent = this.d.activeAgent();
    if (activeAgent) {
      zones.push({ root: this.d.agentSidebar.root, focus: () => activeAgent.focus() });
    }
    if (this.workbench.bottomDock === 'notifications')
      zones.push({
        root: this.workbench.notificationPanel.root,
        focus: () => this.focusDock(this.workbench.notificationPanel, () => this.workbench.notificationLog.focus()),
      });
    else if (this.workbench.bottomDock === 'diagnostics')
      zones.push({
        root: this.workbench.diagnosticsDock.root,
        focus: () => this.focusDock(this.workbench.diagnosticsDock, () => this.workbench.diagnosticsPanel.focus()),
      });
    else if (this.workbench.bottomDock === 'keymap')
      zones.push({
        root: this.workbench.keymapDock.root,
        focus: () => this.focusDock(this.workbench.keymapDock, () => this.workbench.keymapPanel.focus()),
      });
    return zones;
  }

  // Directional focus: move between the center's splits first; on reaching the
  // center's edge (or from a dock section) move to the nearest zone in that
  // direction by on-screen geometry, so any dock arrangement works.
  navPane(direction: Direction): void {
    if (this.isFocusWithin(this.workbench.center.root) && this.workbench.center.focusDirection(direction)) {
      this.focusActivePane();
      return;
    }
    const zones = this.focusZones();
    // The origin zone is wherever focus sits; when focus isn't clearly in any zone
    // (e.g. an empty center pane that couldn't take keyboard focus) fall back to
    // the center so directional navigation still has somewhere to start from.
    const from =
      zones.find((z) => this.isFocusWithin(z.root)) ??
      zones.find((z) => z.root === this.workbench.center.root) ??
      null;
    // When leaving the center, navigate from the active leaf's rect (not the whole
    // center area) so the adjacent dock is found relative to where focus sits.
    const fromRect =
      from && from.root === this.workbench.center.root
        ? this.rectOf(this.workbench.center.activePanel.root)
        : from
          ? this.rectOf(from.root)
          : null;
    if (!fromRect) return;
    this.nearestZone(zones, from, fromRect, direction)?.focus();
  }

  // Cycle focus to the next zone (`ctrl-w w`): within the center, cycle its
  // splits; otherwise advance to the next zone in order, wrapping around.
  focusNextPane(): void {
    if (this.isFocusWithin(this.workbench.center.root) && this.workbench.center.focusNext()) {
      this.focusActivePane();
      return;
    }
    const zones = this.focusZones();
    const i = zones.findIndex((z) => this.isFocusWithin(z.root));
    // Default the starting point to the center when focus isn't in any zone, so
    // the cycle still advances from a sensible place.
    const start = i >= 0 ? i : zones.findIndex((z) => z.root === this.workbench.center.root);
    zones[(start + 1) % zones.length]?.focus();
  }

  // The nearest zone to `fromRect` in `direction`: its center must lie that way
  // and it must overlap on the cross axis; ties favor the most-overlapping zone.
  // (Same scoring as PanelGroup.focusDirection, applied across top-level zones.)
  private nearestZone(
    zones: { root: Widget; focus: () => void }[],
    from: { root: Widget } | null,
    fromRect: { x: number; y: number; w: number; h: number },
    direction: Direction,
  ): { focus: () => void } | null {
    const fromCx = fromRect.x + fromRect.w / 2;
    const fromCy = fromRect.y + fromRect.h / 2;
    let best: { focus: () => void } | null = null;
    let bestScore = Infinity;
    for (const zone of zones) {
      if (zone === from) continue;
      const r = this.rectOf(zone.root);
      if (!r || r.w <= 0 || r.h <= 0) continue;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      let distance: number;
      let overlap: number;
      switch (direction) {
        case 'left':
          if (cx >= fromCx) continue;
          distance = fromCx - cx;
          overlap = span(fromRect.y, fromRect.h, r.y, r.h);
          break;
        case 'right':
          if (cx <= fromCx) continue;
          distance = cx - fromCx;
          overlap = span(fromRect.y, fromRect.h, r.y, r.h);
          break;
        case 'up':
          if (cy >= fromCy) continue;
          distance = fromCy - cy;
          overlap = span(fromRect.x, fromRect.w, r.x, r.w);
          break;
        case 'down':
          if (cy <= fromCy) continue;
          distance = cy - fromCy;
          overlap = span(fromRect.x, fromRect.w, r.x, r.w);
          break;
      }
      if (overlap <= 0) continue;
      const score = distance - overlap * 0.001;
      if (score < bestScore) {
        bestScore = score;
        best = zone;
      }
    }
    return best;
  }

  // A widget's bounds relative to the workbench root (the common ancestor of all
  // zones), or null if unavailable.
  private rectOf(widget: Widget): { x: number; y: number; w: number; h: number } | null {
    try {
      const result: any = widget.computeBounds(this.workbench.root);
      const rect = Array.isArray(result) ? result[1] : result;
      if (!rect) return null;
      return { x: rect.getX(), y: rect.getY(), w: rect.getWidth(), h: rect.getHeight() };
    } catch {
      return null;
    }
  }

  // Move keyboard focus to the content of the active center pane (its editor or
  // terminal); fall back to the panel's empty-state placeholder when it has no
  // tabs, so an empty pane steals focus from whatever held it.
  focusActivePane(): void {
    const widget = this.workbench.center.activePanel.activeChild;
    if (!widget) {
      // An agent workbench's center starts empty (the agent lives in the agent sidebar) —
      // focus the agent rather than the welcome placeholder.
      const agent = this.d.activeAgent();
      if (agent) { agent.focus(); return; }
      this.workbench.center.activePanel.focusEmptyState();
      return;
    }
    if (this.restoreTabFocus(widget)) return; // restore where focus last sat in this tab
    this.d.focusContent(widget);
  }

  // Focus the file tree in the right-side dock; reveal it if the dock had been
  // collapsed away. (Source Control is no longer a dock tab — it opens in the
  // center via revealGitPanel.)
  private focusSidePanel(): void {
    if (this.workbench.leftPanel.root.getParent() === null || this.workbench.leftPanel.tabCount === 0) {
      this.revealFileTree();
      return;
    }
    const child = this.workbench.leftPanel.activeChild;
    if (child && this.restoreTabFocus(child)) return;
    this.workbench.fileTree.focus();
  }

  // Record the currently focused widget against the panel tab that contains it,
  // for restoreTabFocus. Driven by the window's notify::focus-widget.
  rememberFocus(): void {
    const focus = this.d.window.getFocus();
    if (!focus) return;
    const child = this.panelChildAncestor(focus);
    if (!child) return;
    // Focus on the tab's own root (a terminal in normal mode, an empty pane) has no
    // distinct inner target — drop any stale entry rather than leave one behind, so
    // a later restore re-derives focus from the tab itself. Otherwise a terminal
    // left in normal mode would resurrect the Vte it held in a previous insert
    // session, focusing the child while the mode says normal (see Terminal).
    if (child === focus) this.focusMemory.delete(child);
    else this.focusMemory.set(child, focus);
  }

  // The panel-tab content widget (`.is-panel-child`, set by Panel.add) that
  // contains `widget`, or null when it isn't inside a panel tab.
  private panelChildAncestor(widget: Widget): Widget | null {
    let cur: Widget | null = widget;
    while (cur) {
      if (cur.hasCssClass('is-panel-child')) return cur;
      cur = cur.getParent();
    }
    return null;
  }

  // Restore focus to the widget that last held it inside `child`'s tab, if still
  // valid (present in the window). Returns whether focus was restored, so callers
  // can fall back to their default focus target.
  restoreTabFocus(child: Widget): boolean {
    const remembered = this.focusMemory.get(child);
    if (!remembered || remembered === child || remembered.getRoot() === null) return false;
    return remembered.grabFocus();
  }

  // Focus a dock panel's active tab, restoring its remembered focus when known,
  // else running the tab's default focus action.
  private focusDock(panel: Panel, fallback: () => void): void {
    const child = panel.activeChild;
    if (child && this.restoreTabFocus(child)) return;
    fallback();
  }

  /** Whether keyboard focus currently sits inside `root`'s widget subtree. */
  isFocusWithin(root: Widget): boolean {
    let current: Widget | null = this.d.window.getFocus();
    while (current) {
      if (current === root) return true;
      current = current.getParent();
    }
    return false;
  }
}
