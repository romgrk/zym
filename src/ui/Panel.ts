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
import { Adw, Gtk, Pango } from '../gi.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { zym } from '../zym.ts';
import { NERDFONT } from './nerdfont.ts';
import { symbolicImage } from './icons.ts';
import { keycap } from './Keycap.ts';

// Square off the tab buttons (Adwaita rounds them by default) and strip the gaps
// Adwaita puts around and between them. Structural, not color-derived, so it's
// installed unconditionally here rather than with the theme chrome (which only
// applies when the theme defines its own background).
addStyles(`
  #Panel tabbar tabbox { padding: 0; }
  #Panel tabbar > revealer > box { padding: 0; }
  #Panel tabbar { border-bottom: 1px solid var(--border-color); }
  #Panel tabboxchild {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
  }
  /* A panel-level widget (the panel root for an empty pane, or a direct panel
     child) that holds keyboard focus directly has no inner focus ring, so mark it
     with a thin selection-colored outline. */
  #Panel.active-empty,
  #Panel .active-empty {
    outline: 1px solid var(--t-ui-surface-selected);
    outline-offset: -1px;
  }
  /* Welcome empty state (the user's central pane): the sleeping cat over a
     cheatsheet and a charitable callout, styled after nvim's start screen — the
     whole block monospace and muted (colors come from the theme chrome). These
     rules are structural (layout + type scale + keycap chrome) only. */
  /* The cat is a calm, de-emphasized mascot — muted (theme chrome) and a touch
     translucent so it never competes with the text. */
  #PanelEmptyCat { opacity: 0.6; }
  #PanelEmptyCheatsheet,
  #PanelEmptyFooter {
    font-family: var(--t-font-monospace-family, monospace);
  }
  #PanelEmptyCheatsheet { margin-top: 6px; font-size: 1.1em; }
  /* (the binding badge itself is the reusable .keycap widget — see Keycap.ts) */
  /* The charitable callout is a quiet footnote: title a line above the link. */
  #PanelEmptyFooter { margin-top: 26px; font-size: 1.05em; }
  #PanelEmptyFooter .cheat-footer-hint { margin-top: 5px; }
`);

// Nerd Font emoticon for the empty-state face (bundled icon font); always the
// neutral face. The active panel is conveyed by the focus outline, not the face.
const EMOTICON_NEUTRAL = NERDFONT.STATUS.NEUTRAL;

// Empty-state caption — constant.
const EMPTY_TEXT = 'This panel is empty.';

// The "welcome" empty state shown when a user workbench's central pane sits empty
// (see PanelGroup): a sleeping cat over a small cheatsheet. The cat is a bundled
// symbolic SVG (assets/), recolored to the text color like any symbolic icon.
const CAT_ICON_FILE = 'cat-sleeping-symbolic.svg';
const CAT_ICON_SIZE = 52;

// A handful of high-value commands. `keys` is the binding in its canonical form —
// the exact keystroke string from the default keymap (see keymaps/default.ts) —
// shown as a single badge (e.g. `space f f`).
const WELCOME_SHORTCUTS: ReadonlyArray<{ action: string; keys: string }> = [
  { action: 'Command palette', keys: 'space space' }, // command-palette:toggle
  { action: 'Find a file', keys: 'space o' }, // file:find
  { action: 'Search in project', keys: 'space /' }, // project:search
  { action: 'File tree', keys: 'space f f' }, // file-tree:focus
  { action: 'Source control', keys: 'space g g' }, // git-panel:focus
  { action: 'New terminal', keys: 'space t' }, // terminal:new
  { action: 'New agent', keys: 'space a n' }, // agent:new
  { action: 'Show all keybindings', keys: 'space ?' }, // keymap:show
];

// A charitable callout under the cheatsheet, in the spirit of Vim/Nvim's start
// screen (`:help Kuwasha`). Kuwasha supports the Kibaale Community Centre in
// Uganda; the link opens its child-sponsorship page.
const HELP_CHILDREN_TITLE = 'Help children in Uganda';
const HELP_CHILDREN_URL = 'https://www.kuwasha.net/sponsorship/';
const HELP_CHILDREN_LINK = 'kuwasha.net';

type Widget = InstanceType<typeof Gtk.Widget>;

export interface PanelOptions {
  /** Fired when the active child changes (null when the panel is empty). */
  onActiveChanged?: (child: Widget | null) => void;
  /** Fired when a child's tab is closed. */
  onClosed?: (child: Widget) => void;
  /** Fired when the last child is removed. */
  onEmpty?: () => void;
  /** Fired when this panel becomes the single active panel (focus entered it, or
   *  a host activated it programmatically), so the host can sync its bookkeeping. */
  onActivate?: () => void;
  /** Intercept a tab-close request (alt-c or the tab's close button). Return
   *  `true` to let the tab close normally, or `false` to keep the page intact —
   *  e.g. a single-view dock that hides itself instead of destroying its one tab
   *  (so reopening shows the same widget with no teardown/rebuild). */
  onTabCloseRequest?: (child: Widget) => boolean;
}

/** A handle to a child hosted in a panel, for renaming, selecting, or closing its tab. */
export interface PanelChild {
  readonly widget: Widget;
  setTitle(title: string): void;
  /** Toggle Adw's "needs attention" tab highlight (an accent-coloured marker). */
  setNeedsAttention(needs: boolean): void;
  /** Make this child's tab the selected one in its panel. */
  select(): void;
  close(): void;
}

export class Panel {
  // At most one panel is active at a time — the one that contains keyboard focus.
  // Focusing a widget inside a panel makes it active (deactivating the previous);
  // focus moving onto an overlay (a picker/popover, outside every panel) leaves
  // the active panel unchanged, since no panel's focus-enter fires there.
  private static activePanel: Panel | null = null;

  // Maps each hosted child (tab content) back to the panel holding it, so a host
  // can resolve "which panel contains this focused widget" (e.g. to open new files
  // beside the last active editor, even when it sits in a side dock). Maintained in
  // add() / page-detached; a WeakMap so closed tabs drop out on their own.
  private static childPanels = new WeakMap<Widget, Panel>();

  /** The panel hosting `child` as one of its tabs, or null if it isn't in one. */
  static containing(child: Widget): Panel | null {
    return Panel.childPanels.get(child) ?? null;
  }

  readonly root: InstanceType<typeof Gtk.Box>;

  private readonly options: PanelOptions;
  private readonly view: InstanceType<typeof Adw.TabView>;
  // A two-page stack: the tab content when populated, the empty-state placeholder
  // when the panel holds no tabs. `updateEmptyState` swaps between them.
  private readonly stack: InstanceType<typeof Gtk.Stack>;
  // The tab bar. Its visibility is driven manually (see updateEmptyState) rather
  // than by Adw's autohide, which would wrap it in an animated revealer.
  private readonly bar: InstanceType<typeof Adw.TabBar>;
  // The centered box inside the empty-state placeholder; its contents are rebuilt
  // when the variant changes (see setEmptyVariant / renderEmptyContent).
  private emptyInner!: InstanceType<typeof Gtk.Box>;
  // Which empty state to render: the plain face (default), or the "welcome" cat +
  // cheatsheet used for the user's central pane. Set by the host via setEmptyVariant.
  private emptyVariant: 'minimal' | 'welcome' = 'minimal';
  // The widgets in the current empty state whose color follows the active state
  // (the face/cat brighten to the foreground when this is the active panel).
  private emptyActiveTargets: InstanceType<typeof Gtk.Widget>[] = [];
  // Children added with `requireTabBar` — they need their tab title shown at all
  // times (e.g. an editor), so the tab bar stays visible even for a lone tab
  // rather than going chromeless. Keyed by child widget so it clears on close.
  private readonly forcedBarChildren = new Set<Widget>();

  constructor(options: PanelOptions = {}) {
    this.options = options;

    this.view = new Adw.TabView();
    this.view.setVexpand(true);

    this.bar = new Adw.TabBar();
    this.bar.setView(this.view);
    // Autohide off: it hides a lone tab's bar by collapsing an internal animated
    // revealer, which we don't want. We replicate the "chromeless lone tab" look
    // by toggling the bar's own visibility in updateEmptyState instead.
    this.bar.setAutohide(false);
    // Size each tab to its content (capped + ellipsized by Adwaita) instead of
    // stretching tabs to fill the bar's full width.
    this.bar.setExpandTabs(false);

    const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    content.append(this.bar);
    content.append(this.view);

    this.stack = new Gtk.Stack();
    this.stack.setHexpand(true);
    this.stack.setVexpand(true);
    this.stack.addNamed(this.buildEmptyState(), 'empty');
    this.stack.addNamed(content, 'content');

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.setName('Panel'); // selector identity for command/keymap + CSS (#Panel)
    // A panel accepts keyboard focus on its top-level widget, so it can take focus
    // (and steal the active state) even with no focusable content — e.g. an empty
    // pane after a split.
    this.root.setFocusable(true);
    this.root.append(this.stack);

    // Focus entering this panel's subtree makes it the single active panel; any
    // focus change (including the root or a child taking focus directly) refreshes
    // the focus outline.
    const focus = new Gtk.EventControllerFocus();
    focus.on('enter', () => {
      this.activate();
      this.updateFocusOutline();
    });
    focus.on('leave', () => this.updateFocusOutline());
    focus.on('notify::is-focus', () => this.updateFocusOutline());
    this.root.addController(focus);

    this.view.on('notify::selected-page', () => {
      this.options.onActiveChanged?.(this.activeChild);
      this.updateFocusOutline(); // the focused child changed with the tab
    });
    this.view.on('page-detached', (page: any) => {
      Panel.childPanels.delete(page.getChild());
      this.forcedBarChildren.delete(page.getChild());
      this.options.onClosed?.(page.getChild());
      this.updateEmptyState();
      if (this.view.getNPages() === 0) this.options.onEmpty?.();
    });
    // When a close handler is supplied, take over Adw's close: it may veto the
    // close (keeping the page intact) so a dock can hide itself rather than
    // destroy its only view. Returning true delegates finishing to us, so we must
    // call closePageFinish with whether the close is allowed.
    if (this.options.onTabCloseRequest) {
      this.view.on('close-page', (page: any) => {
        const allow = this.options.onTabCloseRequest!(page.getChild());
        this.view.closePageFinish(page, allow);
        return true;
      });
    }

    this.updateEmptyState();
    this.registerTabCommands();
  }

  // The placeholder shown when the panel has no tabs. The outer box fills the
  // panel (so its background covers the whole area), with the content centered
  // inside it. The content is the current variant (see renderEmptyContent): the
  // plain face by default, or the cat + cheatsheet "welcome" state.
  private buildEmptyState(): Widget {
    const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    outer.setName('PanelEmptyState'); // CSS identity (#PanelEmptyState) — paints the fill
    outer.setHexpand(true);
    outer.setVexpand(true);
    // Not focusable: an empty pane takes focus on the panel root itself (see
    // focusEmptyState / the root's setFocusable), which is what carries the focus
    // outline.
    // Clicking the placeholder focuses (and thus activates) the pane — a focusable
    // Gtk.Box doesn't grab focus on click on its own. Scoped to the placeholder, so
    // it only fires for an empty pane (the placeholder isn't shown otherwise) and
    // never competes with a child widget's own click-to-focus.
    const click = new Gtk.GestureClick();
    click.on('pressed', () => this.root.grabFocus());
    outer.addController(click);

    // Centered content group: expands to claim the area, then centers within it.
    this.emptyInner = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.emptyInner.setHexpand(true);
    this.emptyInner.setVexpand(true);
    this.emptyInner.setHalign(Gtk.Align.CENTER);
    this.emptyInner.setValign(Gtk.Align.CENTER);
    this.renderEmptyContent();

    outer.append(this.emptyInner);
    return outer;
  }

  /** Choose which empty-state content to show: the plain face (`minimal`, the
   *  default for docks and splits) or the cat + cheatsheet (`welcome`, used by a
   *  user workbench's central pane). Idempotent; rebuilds the content on change. */
  setEmptyVariant(variant: 'minimal' | 'welcome'): void {
    if (this.emptyVariant === variant) return;
    this.emptyVariant = variant;
    if (this.emptyInner) this.renderEmptyContent();
  }

  // Rebuild the centered empty-state content for the current variant, refreshing
  // the set of widgets whose color tracks the active state, then re-apply that
  // state so the new widgets pick up the right color immediately.
  private renderEmptyContent(): void {
    let child = this.emptyInner.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.emptyInner.remove(child);
      child = next;
    }

    this.emptyActiveTargets =
      this.emptyVariant === 'welcome' ? this.buildWelcomeContent() : this.buildMinimalContent();

    this.setActive(this.isActive);
  }

  // The default empty state: a centered Nerd Font emoticon above a single muted
  // line. Returns the widgets that should follow the active color.
  private buildMinimalContent(): Widget[] {
    const faceAttrs = Pango.AttrList.new();
    faceAttrs.insert(
      Pango.attrFontDescNew(Pango.FontDescription.fromString(`${ICON_FONT_FAMILY} 32`)),
    );
    const emoticon = new Gtk.Label({ label: EMOTICON_NEUTRAL });
    emoticon.setName('PanelEmptyEmoticon'); // CSS identity (#PanelEmptyEmoticon)
    emoticon.setAttributes(faceAttrs);
    emoticon.setMarginBottom(12);

    const textAttrs = Pango.AttrList.new();
    textAttrs.insert(Pango.attrWeightNew(Pango.Weight.BOLD));
    textAttrs.insert(Pango.attrScaleNew(1.1));
    const text = new Gtk.Label({ label: EMPTY_TEXT });
    text.setName('PanelEmptyText'); // CSS identity (#PanelEmptyText)
    text.setAttributes(textAttrs);

    this.emptyInner.append(emoticon);
    this.emptyInner.append(text);
    return [emoticon, text];
  }

  // The "welcome" empty state, styled after Vim/Nvim's start screen: a sleeping cat
  // (our "logo") above a centered, monospace cheatsheet — the binding (canonical
  // form) on the left, the action on the right — and a charitable callout below.
  // Everything stays muted (the cat is a calm mascot), so nothing here follows the
  // active color (returns []).
  private buildWelcomeContent(): Widget[] {
    const cat = symbolicImage(CAT_ICON_FILE, CAT_ICON_SIZE);
    cat.setName('PanelEmptyCat'); // CSS identity (#PanelEmptyCat) — recolored like a symbolic icon
    cat.setMarginBottom(20);
    this.emptyInner.append(cat);

    // Two columns, like nvim's "type :cmd   description": the binding badge
    // right-aligned in column 0, the action left-aligned in column 1, so a clean
    // gutter runs down the middle.
    const grid = new Gtk.Grid();
    grid.setName('PanelEmptyCheatsheet'); // CSS identity (#PanelEmptyCheatsheet)
    grid.setRowSpacing(7);
    grid.setColumnSpacing(16);
    grid.setHalign(Gtk.Align.CENTER);

    WELCOME_SHORTCUTS.forEach((shortcut, row) => {
      const badge = keycap(shortcut.keys); // one unified badge holding the whole binding
      badge.setHalign(Gtk.Align.END);
      grid.attach(badge, 0, row, 1, 1);

      const action = new Gtk.Label({ label: shortcut.action });
      action.addCssClass('cheat-action');
      action.setHalign(Gtk.Align.START);
      action.setHexpand(true);
      grid.attach(action, 1, row, 1, 1);
    });

    this.emptyInner.append(grid);
    this.emptyInner.append(this.buildHelpChildren());
    return [];
  }

  // The charitable callout (cf. nvim's `:help Kuwasha`): a heading over a line with
  // a clickable link to Kuwasha's sponsorship page (GtkLabel opens the URI itself).
  private buildHelpChildren(): InstanceType<typeof Gtk.Box> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    box.setName('PanelEmptyFooter'); // CSS identity (#PanelEmptyFooter)
    box.setHalign(Gtk.Align.CENTER);

    const title = new Gtk.Label({ label: HELP_CHILDREN_TITLE });
    title.addCssClass('cheat-footer-title');
    box.append(title);

    const link = new Gtk.Label();
    link.addCssClass('cheat-footer-hint');
    link.setUseMarkup(true);
    link.setMarkup(`visit  <a href="${HELP_CHILDREN_URL}">${HELP_CHILDREN_LINK}</a>  to help`);
    box.append(link);

    return box;
  }

  /** Move keyboard focus onto the panel's own top-level widget (its root), so an
   *  empty pane can steal focus from whatever held it (e.g. after a split). Without
   *  focus here, key bindings scoped to the panel/window (the space leader, pane
   *  commands) wouldn't reach an empty pane. A no-op returning false when the panel
   *  has tabs — its active child owns focus then. */
  focusEmptyState(): boolean {
    if (this.view.getNPages() > 0) return false;
    if (this.root.grabFocus()) return true;
    // The root may not be mappable yet (e.g. the last tab was only just closed);
    // a widget can't take focus until mapped, so retry on the next layout pass.
    setTimeout(() => {
      if (this.view.getNPages() === 0) this.root.grabFocus();
    }, 0);
    return true;
  }

  /** Make this the single active panel, deactivating the previous one. Called when
   *  focus enters the panel, and by hosts that switch panes programmatically. */
  activate(): void {
    if (Panel.activePanel === this) return;
    Panel.activePanel?.setActive(false);
    Panel.activePanel = this;
    this.setActive(true);
    this.options.onActivate?.();
  }

  /** Whether this is the currently active panel. */
  get isActive(): boolean {
    return Panel.activePanel === this;
  }

  /** The single active panel — the one containing keyboard focus — or null. Lets a
   *  host resolve "the focused tab" across every panel (center splits + docks). */
  static get active(): Panel | null {
    return Panel.activePanel;
  }

  // Reflect whether this is the active panel: the empty-state face/cat sits in the
  // foreground color when active, muted otherwise (the glyph and text stay
  // constant). Targets vary with the empty-state variant (see renderEmptyContent).
  // Private — activation goes through `activate` so only one panel is ever active.
  private setActive(active: boolean): void {
    for (const widget of this.emptyActiveTargets) {
      if (active) widget.addCssClass('is-active');
      else widget.removeCssClass('is-active');
    }
  }

  // Apply the `.active-empty` outline to whichever panel-level widget currently
  // holds *direct* keyboard focus — the root (an empty pane that took focus
  // itself) or a direct panel child that holds focus directly rather than
  // delegating it to inner content (an editor's view shows its own focus ring, so
  // it gets no outline). Cleared from everything else.
  private updateFocusOutline(): void {
    const focus = this.focusWidget();
    let target: Widget | null = null;
    if (focus === this.root) target = this.root;
    else if (focus && focus.hasCssClass('is-panel-child') && this.getChildren().includes(focus))
      target = focus;

    this.root.removeCssClass('active-empty');
    for (const child of this.getChildren()) child.removeCssClass('active-empty');
    target?.addCssClass('active-empty');
  }

  // The window's current keyboard-focus widget, or null when unavailable.
  private focusWidget(): Widget | null {
    const root: any = this.root.getRoot();
    return root && typeof root.getFocus === 'function' ? root.getFocus() : null;
  }

  // Show the empty-state placeholder when there are no tabs, the tab content
  // otherwise. Called after every add/close so the panel never shows a blank
  // Adw.TabView. Also hides the tab bar for a lone tab (chromeless), replacing
  // Adw's autohide so no animated revealer is involved — unless a child requires
  // its title shown at all times, in which case the bar stays visible.
  private updateEmptyState(): void {
    const count = this.view.getNPages();
    this.stack.setVisibleChildName(count === 0 ? 'empty' : 'content');
    this.bar.setVisible(count >= 2 || this.forcedBarChildren.size > 0);
  }

  // Each panel owns the commands that switch *its own* tabs, registered against
  // its root widget instance. The shared `Panel` key bindings (central keymap)
  // route keystrokes to the focused panel, which dispatches them back here.
  private registerTabCommands(): void {
    zym.commands.add(this.root, {
      'tab:next': { didDispatch: () => this.selectNextTab(), description: 'Next tab' },
      'tab:previous': { didDispatch: () => this.selectPreviousTab(), description: 'Previous tab' },
      'tab:go-to-last': { didDispatch: () => this.selectLastTab(), description: 'Go to the last tab' },
      // Parameterized: the first argument is the 0-based tab index (the central
      // keymap binds alt-1..8 to `{ command: 'tab:go-to', args: [n] }`).
      'tab:go-to': { didDispatch: (_event, _element, index) => this.selectTab(index), description: 'Go to tab by index' },
      'tab:move-backward': { didDispatch: () => this.moveTabBackward(), description: 'Move tab before' },
      'tab:move-forward': { didDispatch: () => this.moveTabForward(), description: 'Move tab after' },
      'tab:close': { didDispatch: () => this.closeActiveTab(), description: 'Close the active tab' },
      'tab:pin': { didDispatch: () => this.setActiveTabPinned(true), description: 'Pin the active tab' },
      'tab:unpin': { didDispatch: () => this.setActiveTabPinned(false), description: 'Unpin the active tab' },
      'tab:toggle-pin': { didDispatch: () => this.toggleActiveTabPinned(), description: 'Toggle the active tab pinned' },
    });
  }

  /** Add `child` as a new tab and select it. Pass `requireTabBar` for a child
   *  whose tab title must stay visible at all times (keeps the tab bar shown even
   *  when it is the lone tab). */
  add(child: Widget, options: { title?: string; requireTabBar?: boolean } = {}): PanelChild {
    const page = this.view.append(child);
    // A direct child of a Panel — a styling hook for whatever lives in a tab.
    child.addCssClass('is-panel-child');
    Panel.childPanels.set(child, this); // back-reference for Panel.containing
    if (options.title) page.setTitle(options.title);
    if (options.requireTabBar) this.forcedBarChildren.add(child);
    this.view.setSelectedPage(page);
    this.updateEmptyState();
    return {
      widget: child,
      setTitle: (title: string) => page.setTitle(title),
      setNeedsAttention: (needs: boolean) => page.setNeedsAttention(needs),
      select: () => this.view.setSelectedPage(page),
      close: () => this.view.closePage(page),
    };
  }

  get activeChild(): Widget | null {
    const page = this.view.getSelectedPage();
    return page ? page.getChild() : null;
  }

  /** The child widgets in tab order — the hook session serialization walks. */
  getChildren(): Widget[] {
    const out: Widget[] = [];
    for (let i = 0; i < this.view.getNPages(); i++) out.push(this.view.getNthPage(i).getChild());
    return out;
  }

  /** Pin or unpin the active tab. Adw keeps pinned tabs grouped at the front
   *  (shrunk to their icon/title, with no close button) and reorders as needed.
   *  A no-op when the panel is empty or the tab is already in that state. */
  setActiveTabPinned(pinned: boolean): void {
    const page = this.view.getSelectedPage();
    if (page && page.getPinned() !== pinned) this.view.setPagePinned(page, pinned);
  }

  /** Toggle whether the active tab is pinned; a no-op when the panel is empty. */
  toggleActiveTabPinned(): void {
    const page = this.view.getSelectedPage();
    if (page) this.view.setPagePinned(page, !page.getPinned());
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

  /** Move the active tab one position towards the start; a no-op at the front. */
  moveTabBackward(): void {
    const page = this.view.getSelectedPage();
    if (page) this.view.reorderBackward(page);
  }

  /** Move the active tab one position towards the end; a no-op at the back. */
  moveTabForward(): void {
    const page = this.view.getSelectedPage();
    if (page) this.view.reorderForward(page);
  }
}
