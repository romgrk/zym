/*
 * Panel — a content host holding zero or more child widgets. With a single child
 * it shows just that child; with several it shows an Adw.TabBar above an
 * Adw.TabView, turning the children into switchable tabs. The tab bar auto-hides
 * down to one child, so the single-child case is chromeless ("just its only
 * child"). With no children it shows a friendly empty-state placeholder — a panel
 * is allowed to sit empty (e.g. a fresh split whose source widget can't be
 * duplicated). The assembled widget is `root`.
 *
 * Children are added with `add()`, which returns a handle for renaming or
 * closing the child's tab. The panel tracks the active child and fires
 * `onActiveChanged` / `onClosed` / `onEmpty` so a host can route state to
 * whatever is focused. This is the building block of the future splittable
 * panel tree (VS Code-style editor groups).
 */
import { Adw, GLib, Gtk, Pango } from '../gi.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { quilx } from '../quilx.ts';

// Square off the tab buttons (Adwaita rounds them by default) and strip the gaps
// Adwaita puts around and between them. Structural, not color-derived, so it's
// installed unconditionally here rather than with the theme chrome (which only
// applies when the theme defines its own background).
addStyles(`
  #Panel tabbar taboxchild { border-radius: 0; margin: 0; }
  #Panel tabbar revealer { width: 0; height: 0; }
  #Panel tabbar tabbox { padding: 0; }
  #Panel tabbar > revealer > box { padding: 0; }
`);

// Nerd Font emoticons for the empty-state face (bundled icon font). Neutral while
// the panel is idle, smiling when it is the active panel — see Panel.setActive.
const EMOTICON_NEUTRAL = String.fromCodePoint(0xf11a); // nf-fa-meh_o
const EMOTICON_HAPPY = String.fromCodePoint(0xf118); // nf-fa-smile_o

// Empty-state caption: cheerier once the panel is focused (active).
const EMPTY_TEXT_IDLE = 'This panel is feeling a little lonely.';
const EMPTY_TEXT_ACTIVE = 'This panel is feeling ok.';

type Widget = InstanceType<typeof Gtk.Widget>;

export interface PanelOptions {
  /** Fired when the active child changes (null when the panel is empty). */
  onActiveChanged?: (child: Widget | null) => void;
  /** Fired when a child's tab is closed. */
  onClosed?: (child: Widget) => void;
  /** Fired when the last child is removed. */
  onEmpty?: () => void;
}

/** A handle to a child hosted in a panel, for renaming, selecting, or closing its tab. */
export interface PanelChild {
  readonly widget: Widget;
  setTitle(title: string): void;
  /** Make this child's tab the selected one in its panel. */
  select(): void;
  close(): void;
}

export class Panel {
  readonly root: InstanceType<typeof Gtk.Box>;

  private readonly options: PanelOptions;
  private readonly view: InstanceType<typeof Adw.TabView>;
  // A two-page stack: the tab content when populated, the empty-state placeholder
  // when the panel holds no tabs. `updateEmptyState` swaps between them.
  private readonly stack: InstanceType<typeof Gtk.Stack>;
  // The empty-state placeholder (shown when the panel has no tabs), its face, and
  // its caption; the face's glyph/color and the caption text follow the panel's
  // active state.
  private emptyState!: InstanceType<typeof Gtk.Box>;
  private emoticon!: InstanceType<typeof Gtk.Label>;
  private emptyText!: InstanceType<typeof Gtk.Label>;

  constructor(options: PanelOptions = {}) {
    this.options = options;

    this.view = new Adw.TabView();
    this.view.setVexpand(true);

    const bar = new Adw.TabBar();
    bar.setView(this.view);
    bar.setAutohide(true); // a lone child is shown chromeless, with no tab bar

    const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    content.append(bar);
    content.append(this.view);

    this.stack = new Gtk.Stack();
    this.stack.setHexpand(true);
    this.stack.setVexpand(true);
    this.stack.addNamed(this.buildEmptyState(), 'empty');
    this.stack.addNamed(content, 'content');

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.setName('Panel'); // selector identity for command/keymap + CSS (#Panel)
    this.root.append(this.stack);

    this.view.on('notify::selected-page', () => {
      this.options.onActiveChanged?.(this.activeChild);
    });
    this.view.on('page-detached', (page: any) => {
      this.options.onClosed?.(page.getChild());
      this.updateEmptyState();
      if (this.view.getNPages() === 0) this.options.onEmpty?.();
    });

    this.updateEmptyState();
    this.registerTabCommands();
  }

  // The placeholder shown when the panel has no tabs: a centered Nerd Font
  // emoticon above a single muted line. The outer box fills the panel (so its
  // background covers the whole area), with the content centered inside it. The
  // face tracks the active state.
  private buildEmptyState(): Widget {
    const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    outer.setName('PanelEmptyState'); // CSS identity (#PanelEmptyState) — paints the fill
    outer.setHexpand(true);
    outer.setVexpand(true);
    // Focusable so an empty pane can take keyboard focus after a split (the host
    // grabs focus on the panel root when it has no active tab to focus instead).
    outer.setFocusable(true);

    // Centered content group: expands to claim the area, then centers within it.
    const inner = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    inner.setHexpand(true);
    inner.setVexpand(true);
    inner.setHalign(Gtk.Align.CENTER);
    inner.setValign(Gtk.Align.CENTER);

    // The emoticon is a Nerd Font glyph rendered in the bundled icon font (like
    // the file-tree icons); its color is left to CSS so it follows the theme.
    const faceAttrs = Pango.AttrList.new();
    faceAttrs.insert(
      Pango.attrFontDescNew(Pango.FontDescription.fromString(`${ICON_FONT_FAMILY} 32`)),
    );
    this.emoticon = new Gtk.Label({ label: EMOTICON_NEUTRAL });
    this.emoticon.setName('PanelEmptyEmoticon'); // CSS identity (#PanelEmptyEmoticon)
    this.emoticon.setAttributes(faceAttrs);
    this.emoticon.setMarginBottom(12);

    // Bold, slightly enlarged caption; color stays muted via CSS.
    const textAttrs = Pango.AttrList.new();
    textAttrs.insert(Pango.attrWeightNew(Pango.Weight.BOLD));
    textAttrs.insert(Pango.attrScaleNew(1.1));
    this.emptyText = new Gtk.Label({ label: EMPTY_TEXT_IDLE });
    this.emptyText.setName('PanelEmptyText'); // CSS identity (#PanelEmptyText)
    this.emptyText.setAttributes(textAttrs);

    inner.append(this.emoticon);
    inner.append(this.emptyText);
    outer.append(inner);
    this.emptyState = outer;
    return outer;
  }

  /** Move keyboard focus into the panel's empty-state placeholder, so an empty
   *  pane can steal focus from whatever held it (e.g. after a split). Without
   *  focus here, key bindings scoped to the panel/window (the space leader, pane
   *  commands) wouldn't reach an empty pane. A no-op returning false when the
   *  panel has tabs — its active child owns focus then. */
  focusEmptyState(): boolean {
    if (this.view.getNPages() > 0) return false;
    if (this.emptyState.grabFocus()) return true;
    // The empty page may have only just become the stack's visible child (e.g.
    // the last tab was closed); GtkStack maps it on the next layout pass, and a
    // widget can't take focus until mapped. Retry once it is.
    GLib.idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (this.view.getNPages() === 0) this.emptyState.grabFocus();
      return GLib.SOURCE_REMOVE;
    });
    return true;
  }

  /** Reflect whether this is the active panel: the empty-state face smiles in the
   *  foreground color when active, and sits neutral and muted otherwise. */
  setActive(active: boolean): void {
    this.emoticon.setLabel(active ? EMOTICON_HAPPY : EMOTICON_NEUTRAL);
    this.emptyText.setLabel(active ? EMPTY_TEXT_ACTIVE : EMPTY_TEXT_IDLE);
    for (const label of [this.emoticon, this.emptyText]) {
      if (active) label.addCssClass('is-active');
      else label.removeCssClass('is-active');
    }
  }

  // Show the empty-state placeholder when there are no tabs, the tab content
  // otherwise. Called after every add/close so the panel never shows a blank
  // Adw.TabView.
  private updateEmptyState(): void {
    this.stack.setVisibleChildName(this.view.getNPages() === 0 ? 'empty' : 'content');
  }

  // Each panel owns the commands that switch *its own* tabs, registered against
  // its root widget instance. The shared `Panel` key bindings (central keymap)
  // route keystrokes to the focused panel, which dispatches them back here.
  private registerTabCommands(): void {
    quilx.commands.add(this.root, {
      'tab:next': () => this.selectNextTab(),
      'tab:previous': () => this.selectPreviousTab(),
      'tab:go-to-last': () => this.selectLastTab(),
      // Parameterized: the first argument is the 0-based tab index (the central
      // keymap binds alt-1..8 to `{ command: 'tab:go-to', args: [n] }`).
      'tab:go-to': (_event, _element, index) => this.selectTab(index),
      'tab:close': () => this.closeActiveTab(),
    });
  }

  /** Add `child` as a new tab and select it. */
  add(child: Widget, options: { title?: string } = {}): PanelChild {
    const page = this.view.append(child);
    // A direct child of a Panel — a styling hook for whatever lives in a tab.
    child.addCssClass('is-panel-child');
    if (options.title) page.setTitle(options.title);
    this.view.setSelectedPage(page);
    this.updateEmptyState();
    return {
      widget: child,
      setTitle: (title: string) => page.setTitle(title),
      select: () => this.view.setSelectedPage(page),
      close: () => this.view.closePage(page),
    };
  }

  get activeChild(): Widget | null {
    const page = this.view.getSelectedPage();
    return page ? page.getChild() : null;
  }

  /** Close the selected tab (the active panel child); a no-op when empty. */
  closeActiveTab(): void {
    const page = this.view.getSelectedPage();
    if (page) this.view.closePage(page);
  }

  /** Close every tab. Each closure fires `onClosed`; the last fires `onEmpty`. */
  closeAll(): void {
    const pages: any[] = [];
    for (let i = 0; i < this.view.getNPages(); i++) pages.push(this.view.getNthPage(i));
    for (const page of pages) this.view.closePage(page);
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

  /** Select the tab at `index` (0-based); a no-op if out of range or not an
   *  integer (e.g. the command run from the palette with no argument). */
  selectTab(index: number): void {
    if (!Number.isInteger(index)) return;
    if (index < 0 || index >= this.view.getNPages()) return;
    this.view.setSelectedPage(this.view.getNthPage(index));
  }

  /** Select the last tab; a no-op when there are none. */
  selectLastTab(): void {
    const count = this.view.getNPages();
    if (count > 0) this.view.setSelectedPage(this.view.getNthPage(count - 1));
  }
}
