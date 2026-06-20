/*
 * Workbench — one person's dock layout: named fixed slots (left / right / top /
 * bottom) around a splittable center, built from nested Gtk.Paned so each
 * populated dock is resizable. An empty slot is set to `null`, so its Paned shows
 * only the other child (no handle). Exposed via `root`.
 *
 * A Workbench is first-class: besides the dock frame it *owns* the widgets that fill
 * its slots (its `center`, `fileTree`, Source-Control, the bottom-dock panels, …),
 * handed to the constructor by `AppWindow.buildWorkbench`. Each "person" in the
 * WorkbenchList (the user, each agent) owns one; switching person just swaps which
 * Workbench the window shows (the others stay detached but alive, preserving their
 * tabs/state). Nothing is shared or reparented on switch — AppWindow reads the active
 * person's widgets straight off `this.workbench.*`. `owner` carries the person this
 * Workbench belongs to, for the WorkbenchList to render/select.
 *
 * The top and bottom docks sit *inside the center column* — i.e. within the
 * width left between the left and right docks, not spanning the whole window —
 * and open at roughly a quarter of the column's height.
 *
 * Each dock side (left/right/top/bottom) is independently toggleable: its assigned
 * content and its visibility are tracked separately, so a dock can be hidden and
 * re-shown without tearing down the panels it holds (`toggleDock`/`setDockVisible`).
 * The per-side visibility is persisted in the session.
 *
 * Nesting (outermost → in):
 *   hLeft[ left | hCenterRight[ vTop[ top | vBottom[ center | bottom ] ] | right ] ]
 */
import { Gtk } from '../gi.ts';
import type { GitRepo } from '../git.ts';
import type { DiagnosticsPanel } from '../lsp/diagnostics/DiagnosticsPanel.ts';
import type { FileTree } from './FileTree.ts';
import type { GitPanel } from './GitPanel.ts';
import type { KeymapPanel } from './KeymapPanel.ts';
import type { NotificationLog } from './NotificationLog.ts';
import type { Panel, PanelChild } from './Panel.ts';
import type { PanelGroup } from './PanelGroup.ts';

const SIDEBAR_WIDTH = 220;
// Fraction of the center column height a top/bottom dock takes when opened.
const DOCK_FRACTION = 0.25;

// Anything with a single top-level widget can occupy a dock slot — a Panel for
// the side docks, the splittable PanelGroup for the center.
type Dockable = { root: InstanceType<typeof Gtk.Widget> };

// The four toggleable dock sides (the center is not a dock — it is never hidden).
export type DockSide = 'left' | 'right' | 'top' | 'bottom';
export const DOCK_SIDES: DockSide[] = ['left', 'right', 'top', 'bottom'];

// What currently occupies the (otherwise empty) bottom dock.
export type BottomDock = 'notifications' | 'diagnostics' | 'keymap' | null;

// The widgets that fill a workbench's slots, built by AppWindow.buildWorkbench and
// handed to the constructor (which docks the center + Source-Control). `bottomDock`
// is not here — the bottom slot starts empty and is toggled later.
export interface WorkbenchContents {
  // The workbench's root directory and the (pooled) git repo for it. Every
  // per-person view — file tree, Source Control, and the chrome/pickers while
  // this workbench is active — resolves against these, so an agent in a worktree
  // sees its own tree/branch (see tasks/agents.md "git worktree integration").
  cwd: string;
  git: GitRepo;
  center: PanelGroup;
  fileTree: FileTree;
  leftPanel: Panel;
  filesTab: PanelChild;
  notificationLog: NotificationLog;
  notificationPanel: Panel;
  diagnosticsPanel: DiagnosticsPanel;
  diagnosticsDock: Panel;
  keymapPanel: KeymapPanel;
  keymapDock: Panel;
}

export class Workbench<TOwner = unknown> {
  readonly root: InstanceType<typeof Gtk.Paned>;

  // The person this workbench belongs to (the user or an agent); read by the
  // WorkbenchList to render/select.
  owner: TOwner;

  // This workbench's root directory and pooled git repo (see WorkbenchContents).
  // `cwd`/`git` are reassigned by AppWindow when an agent re-roots into a worktree.
  cwd: string;
  git: GitRepo;

  // The widgets filling this workbench's slots. `center`/`fileTree`/… are built once;
  // `filesTab`/`gitTab` are reassigned when the left dock is collapsed and re-revealed;
  // `bottomDock` tracks which panel (if any) is docked at the bottom.
  //
  // Source Control (`gitPanel`/`gitTab`) is **lazily created**: it stays null until
  // the user first reveals it (AppWindow.ensureGitPanel), so a workbench doesn't open
  // a git subscription it may never use.
  center: PanelGroup;
  fileTree: FileTree;
  gitPanel: GitPanel | null = null;
  leftPanel: Panel;
  filesTab: PanelChild;
  gitTab: PanelChild | null = null;
  notificationLog: NotificationLog;
  notificationPanel: Panel;
  diagnosticsPanel: DiagnosticsPanel;
  diagnosticsDock: Panel;
  keymapPanel: KeymapPanel;
  keymapDock: Panel;
  bottomDock: BottomDock = null;

  private readonly hLeft: InstanceType<typeof Gtk.Paned>;
  private readonly hCenterRight: InstanceType<typeof Gtk.Paned>;
  private readonly vTop: InstanceType<typeof Gtk.Paned>;
  private readonly vBottom: InstanceType<typeof Gtk.Paned>;

  // Each dock side keeps its assigned content *and* a visibility flag, decoupled so
  // a dock can be hidden without losing its panels: the Paned slot shows the content
  // only when the side is both occupied and visible. Toggling visibility just detaches
  // / re-attaches the content widget (its tabs/state live on inside it). Defaults to
  // visible — content is shown as soon as it's assigned (see setSlot below).
  private readonly dockContent: Record<DockSide, Dockable | null> = {
    left: null, right: null, top: null, bottom: null,
  };
  private readonly dockVisible: Record<DockSide, boolean> = {
    left: true, right: true, top: true, bottom: true,
  };

  constructor(owner: TOwner, contents: WorkbenchContents, options: { showSideDock: boolean }) {
    this.owner = owner;
    this.cwd = contents.cwd;
    this.git = contents.git;
    this.center = contents.center;
    this.fileTree = contents.fileTree;
    this.leftPanel = contents.leftPanel;
    this.filesTab = contents.filesTab;
    this.notificationLog = contents.notificationLog;
    this.notificationPanel = contents.notificationPanel;
    this.diagnosticsPanel = contents.diagnosticsPanel;
    this.diagnosticsDock = contents.diagnosticsDock;
    this.keymapPanel = contents.keymapPanel;
    this.keymapDock = contents.keymapDock;

    this.hLeft = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
    this.hCenterRight = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
    this.vTop = new Gtk.Paned({ orientation: Gtk.Orientation.VERTICAL });
    this.vBottom = new Gtk.Paned({ orientation: Gtk.Orientation.VERTICAL });

    // Fixed inner structure; the slots are the outer children set via setX().
    // The center column (top / center / bottom stacked) lives between the left
    // and right docks, so top/bottom never span under the side docks.
    this.vTop.setEndChild(this.vBottom);
    this.hCenterRight.setStartChild(this.vTop);
    this.hLeft.setEndChild(this.hCenterRight);

    // Keep the left sidebar at a fixed width and not shrinking under the editor.
    this.hLeft.setPosition(SIDEBAR_WIDTH);
    this.hLeft.setResizeStartChild(false);
    this.hLeft.setShrinkStartChild(false);

    // The right dock is fixed-width too: window resize grows the center, not it.
    // (A Paned has no position-from-end, so the dock's width comes from a width
    // request set in `setRight` rather than a position.)
    this.hCenterRight.setResizeEndChild(false);
    this.hCenterRight.setShrinkEndChild(false);

    this.root = this.hLeft;
    this.root.setName('Workbench'); // selector identity for command/keymap rules

    // The user's workbench shows Files/Source-Control in the right dock; an agent's
    // opens terminal-only (the panel is still built, so reveal-on-demand — file-tree:
    // focus / git commands — can attach it later). The bottom slot starts empty.
    if (options.showSideDock) this.setRight({ root: contents.leftPanel.root });
    this.setCenter(contents.center);
  }

  // Assign a side's content. Assigning a non-null panel also (re)shows the side —
  // putting something in a dock means you want to see it — so the dock-content
  // pickers (bottom: notifications/diagnostics/keymap; right: reveal a tab) need no
  // separate "show" call. Clearing (null) leaves the visibility flag untouched, so a
  // later re-assignment restores the side's last shown/hidden state.
  setLeft(panel: Dockable | null) { this.setSlot('left', panel); }
  setRight(panel: Dockable | null) { this.setSlot('right', panel); }
  setTop(panel: Dockable | null) { this.setSlot('top', panel); }
  setBottom(panel: Dockable | null) { this.setSlot('bottom', panel); }

  setCenter(panel: Dockable | null) {
    this.vBottom.setStartChild(panel?.root ?? null);
  }

  private setSlot(side: DockSide, panel: Dockable | null) {
    this.dockContent[side] = panel;
    if (panel) this.dockVisible[side] = true;
    this.applyDock(side);
  }

  /** Is a panel currently assigned to this side (regardless of visibility)? */
  isDockOccupied(side: DockSide): boolean {
    return this.dockContent[side] !== null;
  }

  /** Is this side currently shown (occupied *and* not hidden)? */
  isDockVisible(side: DockSide): boolean {
    return this.dockContent[side] !== null && this.dockVisible[side];
  }

  /** Show / hide a dock side without discarding its content. */
  setDockVisible(side: DockSide, visible: boolean) {
    this.dockVisible[side] = visible;
    this.applyDock(side);
  }

  /** Flip a dock side's visibility (keeping its panels). No-op on an empty side. */
  toggleDock(side: DockSide): void {
    if (!this.isDockOccupied(side)) return;
    this.setDockVisible(side, !this.dockVisible[side]);
  }

  /** The visibility flags for all sides, for session persistence. */
  dockVisibility(): Record<DockSide, boolean> {
    return { ...this.dockVisible };
  }

  // Push a side's effective state (content if visible, else null) into its Paned slot.
  private applyDock(side: DockSide) {
    const panel = this.dockVisible[side] ? this.dockContent[side] : null;
    switch (side) {
      case 'left':
        this.hLeft.setStartChild(panel?.root ?? null);
        break;
      case 'right':
        this.hCenterRight.setEndChild(panel?.root ?? null);
        // Give the dock a stable width (it doesn't resize with the window); the user
        // can still drag the handle wider. Min-width, so a narrow file tree won't
        // collapse it.
        if (panel) panel.root.setSizeRequest(SIDEBAR_WIDTH, -1);
        break;
      case 'top':
        this.vTop.setStartChild(panel?.root ?? null);
        if (panel) this.sizeDock(this.vTop, DOCK_FRACTION); // top is the start child
        break;
      case 'bottom':
        this.vBottom.setEndChild(panel?.root ?? null);
        if (panel) this.sizeDock(this.vBottom, 1 - DOCK_FRACTION); // bottom is the end child
        break;
    }
  }

  // Position a vertical dock paned so the dock takes DOCK_FRACTION of the column
  // height. `startFraction` is the share given to the paned's start child.
  private sizeDock(paned: InstanceType<typeof Gtk.Paned>, startFraction: number) {
    const height = paned.getHeight();
    if (height > 0) paned.setPosition(Math.round(height * startFraction));
  }
}
