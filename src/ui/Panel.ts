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
import { quilx } from '../quilx.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

// Tab-navigation key bindings, shared by every panel and registered once. They
// target the `Panel` selector (each panel sets its widget name to "Panel"), so
// the CAPTURE-phase keymap controller routes a keystroke to whichever panel
// currently holds focus (its root is in the focus chain). The matching commands
// are registered per-instance (see `registerTabCommands`), so dispatch lands on
// the focused panel and the host needs no "which panel has focus?" bookkeeping.
const TAB_KEYMAP: Record<string, string> = {
  'ctrl-Page_Down': 'tab:next',
  'ctrl-Page_Up': 'tab:previous',
  'alt-9': 'tab:go-to-last',
};
for (let n = 1; n <= 8; n++) TAB_KEYMAP[`alt-${n}`] = `tab:go-to-${n}`;

let tabKeymapRegistered = false;
function ensureTabKeymap(): void {
  if (tabKeymapRegistered) return;
  tabKeymapRegistered = true;
  quilx.keymaps.add('Panel', { Panel: TAB_KEYMAP });
}

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
    this.root.setName('Panel'); // selector identity for command/keymap rules
    this.root.addCssClass('quilx-panel'); // hook for theme-chrome tab-bar styling
    this.root.append(bar);
    this.root.append(this.view);

    this.view.on('notify::selected-page', () => {
      this.options.onActiveChanged?.(this.activeChild);
    });
    this.view.on('page-detached', (page: any) => {
      this.options.onClosed?.(page.getChild());
      if (this.view.getNPages() === 0) this.options.onEmpty?.();
    });

    ensureTabKeymap();
    this.registerTabCommands();
  }

  // Each panel owns the commands that switch *its own* tabs, registered against
  // its root widget instance. The shared `TAB_KEYMAP` (above) routes keystrokes
  // to the focused panel, which dispatches them back here.
  private registerTabCommands(): void {
    const commands: Record<string, () => void> = {
      'tab:next': () => this.selectNextTab(),
      'tab:previous': () => this.selectPreviousTab(),
      'tab:go-to-last': () => this.selectLastTab(),
    };
    for (let n = 1; n <= 8; n++) {
      commands[`tab:go-to-${n}`] = () => this.selectTab(n - 1);
    }
    quilx.commands.add(this.root, commands);
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

  /** Number of open tabs. */
  get tabCount(): number {
    return this.view.getNPages();
  }

  /** Select the next tab, wrapping from the last back to the first. */
  selectNextTab(): void {
    if (this.view.selectNextPage()) return;
    if (this.view.getNPages() > 0) this.view.setSelectedPage(this.view.getNthPage(0));
  }

  /** Select the previous tab, wrapping from the first around to the last. */
  selectPreviousTab(): void {
    if (this.view.selectPreviousPage()) return;
    const count = this.view.getNPages();
    if (count > 0) this.view.setSelectedPage(this.view.getNthPage(count - 1));
  }

  /** Select the tab at `index` (0-based); a no-op if out of range. */
  selectTab(index: number): void {
    if (index < 0 || index >= this.view.getNPages()) return;
    this.view.setSelectedPage(this.view.getNthPage(index));
  }

  /** Select the last tab; a no-op when there are none. */
  selectLastTab(): void {
    const count = this.view.getNPages();
    if (count > 0) this.view.setSelectedPage(this.view.getNthPage(count - 1));
  }
}
