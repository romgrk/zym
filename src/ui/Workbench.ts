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
 * Nesting (outermost → in):
 *   hLeft[ left | hCenterRight[ vTop[ top | vBottom[ center | bottom ] ] | right ] ]
 */
import { Gtk } from '../gi.ts';
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

// What currently occupies the (otherwise empty) bottom dock.
export type BottomDock = 'notifications' | 'diagnostics' | 'keymap' | null;

// The widgets that fill a workbench's slots, built by AppWindow.buildWorkbench and
// handed to the constructor (which docks the center + Source-Control). `bottomDock`
// is not here — the bottom slot starts empty and is toggled later.
export interface WorkbenchContents {
  center: PanelGroup;
  fileTree: FileTree;
  gitPanel: GitPanel;
  leftPanel: Panel;
  filesTab: PanelChild;
  gitTab: PanelChild;
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

  // The widgets filling this workbench's slots. `center`/`fileTree`/… are built once;
  // `filesTab`/`gitTab` are reassigned when the left dock is collapsed and re-revealed;
  // `bottomDock` tracks which panel (if any) is docked at the bottom.
  center: PanelGroup;
  fileTree: FileTree;
  gitPanel: GitPanel;
  leftPanel: Panel;
  filesTab: PanelChild;
  gitTab: PanelChild;
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

  constructor(owner: TOwner, contents: WorkbenchContents, options: { showSideDock: boolean }) {
    this.owner = owner;
    this.center = contents.center;
    this.fileTree = contents.fileTree;
    this.gitPanel = contents.gitPanel;
    this.leftPanel = contents.leftPanel;
    this.filesTab = contents.filesTab;
    this.gitTab = contents.gitTab;
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

  setLeft(panel: Dockable | null) {
    this.hLeft.setStartChild(panel?.root ?? null);
  }

  setCenter(panel: Dockable | null) {
    this.vBottom.setStartChild(panel?.root ?? null);
  }

  setRight(panel: Dockable | null) {
    this.hCenterRight.setEndChild(panel?.root ?? null);
    // Give the dock a stable width (it doesn't resize with the window); the user
    // can still drag the handle wider. Min-width, so a narrow file tree won't
    // collapse it.
    if (panel) panel.root.setSizeRequest(SIDEBAR_WIDTH, -1);
  }

  setTop(panel: Dockable | null) {
    this.vTop.setStartChild(panel?.root ?? null);
    if (panel) this.sizeDock(this.vTop, DOCK_FRACTION); // top is the start child
  }

  setBottom(panel: Dockable | null) {
    this.vBottom.setEndChild(panel?.root ?? null);
    if (panel) this.sizeDock(this.vBottom, 1 - DOCK_FRACTION); // bottom is the end child
  }

  // Position a vertical dock paned so the dock takes DOCK_FRACTION of the column
  // height. `startFraction` is the share given to the paned's start child.
  private sizeDock(paned: InstanceType<typeof Gtk.Paned>, startFraction: number) {
    const height = paned.getHeight();
    if (height > 0) paned.setPosition(Math.round(height * startFraction));
  }
}
