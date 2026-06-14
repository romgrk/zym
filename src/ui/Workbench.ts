/*
 * Workbench — the dock layout with named fixed slots (left / right / top /
 * bottom) around a center area, built from nested Gtk.Paned so each populated
 * dock is resizable. An empty slot is set to `null`, so its Paned shows only the
 * other child (no handle). The center holds a single Panel today; it is the
 * future home of the dynamic, splittable panel tree. Exposed via `root`.
 *
 * Nesting (outermost → in):
 *   vTop[ top | vBottom[ hLeft[ left | hCenterRight[ center | right ] ] | bottom ] ]
 */
import { Gtk } from '../gi.ts';
import { Panel } from './Panel.ts';

const SIDEBAR_WIDTH = 220;

export class Workbench {
  readonly root: InstanceType<typeof Gtk.Paned>;

  private readonly hCenterRight: InstanceType<typeof Gtk.Paned>;
  private readonly hLeft: InstanceType<typeof Gtk.Paned>;
  private readonly vBottom: InstanceType<typeof Gtk.Paned>;
  private readonly vTop: InstanceType<typeof Gtk.Paned>;

  constructor() {
    this.hCenterRight = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
    this.hLeft = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
    this.vBottom = new Gtk.Paned({ orientation: Gtk.Orientation.VERTICAL });
    this.vTop = new Gtk.Paned({ orientation: Gtk.Orientation.VERTICAL });

    // Fixed inner structure; the slots are the outer children set via setX().
    this.hLeft.setEndChild(this.hCenterRight);
    this.hLeft.setPosition(SIDEBAR_WIDTH);
    this.hLeft.setResizeStartChild(false);
    this.hLeft.setShrinkStartChild(false);

    this.vBottom.setStartChild(this.hLeft);
    this.vTop.setEndChild(this.vBottom);

    this.root = this.vTop;
    this.root.setName('Workbench'); // selector identity for command/keymap rules
  }

  setLeft(panel: Panel | null) {
    this.hLeft.setStartChild(panel?.root ?? null);
  }

  setCenter(panel: Panel | null) {
    this.hCenterRight.setStartChild(panel?.root ?? null);
  }

  setRight(panel: Panel | null) {
    this.hCenterRight.setEndChild(panel?.root ?? null);
  }

  setTop(panel: Panel | null) {
    this.vTop.setStartChild(panel?.root ?? null);
  }

  setBottom(panel: Panel | null) {
    this.vBottom.setEndChild(panel?.root ?? null);
  }
}
