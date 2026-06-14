/*
 * Panel — a content host holding one or more child widgets. With a single child
 * it shows just that child; with several it shows an Adw.TabBar above an
 * Adw.TabView, turning the children into switchable tabs. The tab bar auto-hides
 * down to one child, so the single-child case is chromeless ("just its only
 * child"). The assembled widget is `root`.
 *
 * Children are added with `add()`, which returns a handle for renaming or
 * closing the child's tab. The panel tracks the active child and fires
 * `onActiveChanged` / `onClosed` / `onEmpty` so a host can route state to
 * whatever is focused. This is the building block of the future splittable
 * panel tree (VS Code-style editor groups).
 */
import { Adw, Gtk } from '../gi.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

export interface PanelOptions {
  /** Fired when the active child changes (null when the panel is empty). */
  onActiveChanged?: (child: Widget | null) => void;
  /** Fired when a child's tab is closed. */
  onClosed?: (child: Widget) => void;
  /** Fired when the last child is removed. */
  onEmpty?: () => void;
}

/** A handle to a child hosted in a panel, for renaming or closing its tab. */
export interface PanelChild {
  readonly widget: Widget;
  setTitle(title: string): void;
  close(): void;
}

export class Panel {
  readonly root: InstanceType<typeof Gtk.Box>;

  private readonly options: PanelOptions;
  private readonly view: InstanceType<typeof Adw.TabView>;

  constructor(options: PanelOptions = {}) {
    this.options = options;

    this.view = new Adw.TabView();
    this.view.setVexpand(true);

    const bar = new Adw.TabBar();
    bar.setView(this.view);
    bar.setAutohide(true); // a lone child is shown chromeless, with no tab bar

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.append(bar);
    this.root.append(this.view);

    this.view.on('notify::selected-page', () => {
      this.options.onActiveChanged?.(this.activeChild);
    });
    this.view.on('page-detached', (page: any) => {
      this.options.onClosed?.(page.getChild());
      if (this.view.getNPages() === 0) this.options.onEmpty?.();
    });
  }

  /** Add `child` as a new tab and select it. */
  add(child: Widget, options: { title?: string } = {}): PanelChild {
    const page = this.view.append(child);
    if (options.title) page.setTitle(options.title);
    this.view.setSelectedPage(page);
    return {
      widget: child,
      setTitle: (title: string) => page.setTitle(title),
      close: () => this.view.closePage(page),
    };
  }

  get activeChild(): Widget | null {
    const page = this.view.getSelectedPage();
    return page ? page.getChild() : null;
  }
}
