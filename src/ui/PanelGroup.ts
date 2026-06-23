/*
 * PanelGroup — the splittable editor area at the center of the workbench. It is
 * a binary tree whose leaves are `Panel`s (tab groups / editor groups) and whose
 * branches are `Gtk.Paned` splits, each carrying an orientation and two child
 * nodes. Any layout is expressible by nesting splits.
 *
 * New tabs open into the *active* leaf (the one that last held focus). Splitting
 * the active leaf wraps it in a fresh Paned alongside a new empty leaf; closing a
 * leaf's last tab collapses its split so the sibling reclaims the freed space;
 * emptying the final remaining leaf leaves it in place, empty (showing the
 * Panel's empty state) — closing panels never quits the app.
 *
 * The assembled widget is `root`, a stable container whose single child is the
 * current tree-root widget — swapped in place as the tree reshapes, so the host
 * holds one unchanging widget.
 */
import { Gtk } from '../gi.ts';
import { Panel, type PanelChild } from './Panel.ts';
import type { PanelNode, TabState } from '../SessionManager.ts';

/**
 * What a host returns to rebuild one tab during `restoreLayout`: the widget to
 * host, an optional title, and an `onAttached` callback handed the tab handle so
 * the host can wire title-change bindings and its own bookkeeping. `null` skips
 * the tab (e.g. a file that no longer exists).
 */
export interface RestoredChild {
  widget: InstanceType<typeof Gtk.Widget>;
  title?: string;
  /** Keep the tab bar (and thus the title) visible even as a lone tab. */
  requireTabBar?: boolean;
  onAttached?: (child: PanelChild) => void;
}

type Widget = InstanceType<typeof Gtk.Widget>;
type Paned = InstanceType<typeof Gtk.Paned>;

/** A direction to split toward or navigate toward. */
export type Direction = 'left' | 'right' | 'up' | 'down';

// --- Tree nodes -------------------------------------------------------------
// Strip-only TS forbids constructor parameter properties, so fields are declared
// and assigned explicitly.

/** A leaf node: one editor group (a `Panel`). */
class Leaf {
  readonly panel: Panel;
  parent: Split | null = null;

  constructor(panel: Panel) {
    this.panel = panel;
  }

  get widget(): Widget {
    return this.panel.root;
  }
}

/** A branch node: a `Gtk.Paned` split holding two child nodes. */
class Split {
  readonly paned: Paned;
  parent: Split | null = null;
  start: Node;
  end: Node;

  constructor(paned: Paned, start: Node, end: Node) {
    this.paned = paned;
    this.start = start;
    this.end = end;
  }

  get widget(): Widget {
    return this.paned;
  }
}

type Node = Leaf | Split;

export interface PanelGroupOptions {
  /** Fired when the active leaf's selected tab changes (null when empty). */
  onActiveChanged?: (child: Widget | null) => void;
  /** Fired when any tab is closed, so the host can drop its bookkeeping. */
  onClosed?: (child: Widget) => void;
  /**
   * Show the "welcome" empty state (a sleeping cat over a keybinding cheatsheet,
   * see Panel) on the layout's first leaf whenever it sits empty — the central
   * pane, kept as the welcome surface even once the layout splits (other empty
   * panes get the plain placeholder). Used by the user workbench; agent centers
   * leave it off.
   */
  welcomeEmptyState?: boolean;
  /**
   * Asked before a tab closes; return false to veto (keep the page intact). Installed
   * on every leaf, so it covers whichever split the tab lives in. Omit to let tabs
   * close normally.
   */
  onTabCloseRequest?: (child: Widget) => boolean;
}

export class PanelGroup {
  readonly root: InstanceType<typeof Gtk.Box>;

  private readonly options: PanelGroupOptions;
  private rootNode: Node;
  private active: Leaf;
  // The pinned "agent panel": a leaf that can't be split, never takes other tabs,
  // and is never collapsed. Set via `pinChild` (an agent center pins its terminal);
  // null for an ordinary center, where every leaf is equal.
  private pinned: Leaf | null = null;
  // The most recently active non-pinned leaf — the work area opens land in when the
  // pinned panel itself is active. Stale entries (a collapsed leaf) are filtered out.
  private lastWorkArea: Leaf | null = null;

  constructor(options: PanelGroupOptions = {}) {
    this.options = options;

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.setName('PanelGroup'); // selector identity for command/keymap rules
    this.root.setHexpand(true);
    this.root.setVexpand(true);

    const leaf = this.createLeaf();
    this.rootNode = leaf;
    this.active = leaf;
    leaf.panel.activate();
    this.root.append(leaf.widget);
    this.updateWelcomeState();
  }

  // Apply the central pane's "welcome" empty state (opt-in via options): the
  // layout's first leaf carries it, every other leaf gets the plain placeholder —
  // so the welcome surface stays put on the first pane even after splits (and even
  // when several panes sit empty). A no-op when not enabled. Called after every
  // structural change (split / collapse / restore).
  private updateWelcomeState(): void {
    if (!this.options.welcomeEmptyState) return;
    const first = firstLeaf(this.rootNode);
    for (const leaf of this.leaves())
      leaf.panel.setEmptyVariant(leaf === first ? 'welcome' : 'minimal');
  }

  // --- Active leaf / tab access ---------------------------------------------

  /** The `Panel` backing the active leaf — where keyboard focus sits. */
  get activePanel(): Panel {
    return this.active.panel;
  }

  /**
   * The `Panel` a new open should land in: the active leaf, except when the active
   * leaf is the pinned agent panel — then the work area beside it (created on demand
   * by splitting the agent panel to the right). For an ordinary center this is just
   * `activePanel`.
   */
  get openPanel(): Panel {
    if (this.pinned && this.active === this.pinned) return this.ensureWorkArea().panel;
    return this.active.panel;
  }

  /** Add `child` as a new tab in the open panel and select it. Routes around the
   *  pinned agent panel (see `openPanel`). */
  add(child: Widget, options: { title?: string; requireTabBar?: boolean } = {}): PanelChild {
    return this.openPanel.add(child, options);
  }

  /**
   * Pin `child` into the root leaf as the agent panel: a single tab in a leaf that
   * can't be split, takes no other tabs, and is never collapsed. Must be called on a
   * fresh center (the active leaf is the lone root leaf), before any split or add.
   */
  pinChild(child: Widget, options: { title?: string; requireTabBar?: boolean } = {}): PanelChild {
    this.pinned = this.active;
    return this.active.panel.add(child, options);
  }

  // The work area for opens while the agent panel is active: reuse the most recent
  // non-pinned leaf if one survives, otherwise split the agent panel to the right to
  // birth one. Always returns an active leaf (splitLeaf activates the new one).
  private ensureWorkArea(): Leaf {
    const others = this.leaves().filter((leaf) => leaf !== this.pinned);
    if (others.length === 0) return this.splitLeaf(this.pinned!, 'right');
    const leaf =
      this.lastWorkArea && others.includes(this.lastWorkArea)
        ? this.lastWorkArea
        : others[others.length - 1];
    this.setActive(leaf);
    return leaf;
  }

  // --- Splitting ------------------------------------------------------------

  /**
   * Split the active leaf, placing a fresh empty leaf on the given side, and
   * make that new leaf active. Returns the new `Panel` so the host can populate
   * it. `left`/`right` produce a side-by-side split; `up`/`down` a stacked one.
   *
   * The pinned agent panel is never subdivided: a split from it instead opens the
   * work area beside it (created to the right if absent, else focused and split in
   * the requested direction).
   */
  split(direction: Direction): Panel {
    if (this.pinned && this.active === this.pinned) {
      const others = this.leaves().filter((leaf) => leaf !== this.pinned);
      if (others.length === 0) return this.splitLeaf(this.pinned, 'right').panel;
      const work = this.ensureWorkArea(); // reuse + activate an existing work area
      return this.splitLeaf(work, direction).panel;
    }
    return this.splitLeaf(this.active, direction).panel;
  }

  // Split `target`, seating a fresh empty leaf on the given side, and make the new
  // leaf active. Returns the new leaf.
  private splitLeaf(target: Leaf, direction: Direction): Leaf {
    const horizontal = direction === 'left' || direction === 'right';
    const orientation = horizontal
      ? Gtk.Orientation.HORIZONTAL
      : Gtk.Orientation.VERTICAL;

    const parent = target.parent;
    const wasStart = parent ? parent.start === target : false;

    // Measure the freed space before detaching, to seat the divider midway.
    const size = horizontal ? target.widget.getWidth() : target.widget.getHeight();

    // Detach the target from its current slot so it can be reparented.
    this.detach(target, parent, wasStart);

    // Build the split: new leaf goes before the target for left/up, after for
    // right/down.
    const newLeaf = this.createLeaf();
    const before = direction === 'left' || direction === 'up';
    const startNode = before ? newLeaf : target;
    const endNode = before ? target : newLeaf;

    const paned = new Gtk.Paned({ orientation });
    paned.setHexpand(true);
    paned.setVexpand(true);
    paned.setStartChild(startNode.widget);
    paned.setEndChild(endNode.widget);

    const split = new Split(paned, startNode, endNode);
    startNode.parent = split;
    endNode.parent = split;

    // Drop the split into the slot the target used to occupy.
    this.attach(split, parent, wasStart);
    if (size > 0) paned.setPosition(Math.floor(size / 2));

    this.setActive(newLeaf);
    this.updateWelcomeState();
    return newLeaf;
  }

  // --- Closing / collapsing -------------------------------------------------

  /** Close the active leaf entirely (all its tabs). A non-root leaf then
   *  collapses so its sibling reclaims the space; the root leaf stays put and
   *  shows its empty state. */
  closeActivePanel(): void {
    // The pinned agent panel is never closed (its terminal tab-close is vetoed too).
    if (this.pinned && this.active === this.pinned) return;
    // An already-empty pane has no tabs to close, so closeAll would be a no-op.
    // Route it through onLeafEmpty directly so `pane:close` still collapses an
    // empty non-root pane (the root leaf stays put — there's no sibling to
    // reclaim its space).
    if (this.active.panel.tabCount === 0) {
      this.onLeafEmpty(this.active);
      return;
    }
    // Closing each tab fires onClosed for host cleanup; emptying the leaf routes
    // through onLeafEmpty (collapse for non-root, no-op for root).
    this.active.panel.closeAll();
  }

  // Called when a leaf's panel loses its last tab. The root leaf is allowed to
  // sit empty (the Panel shows its empty state); any other leaf is collapsed away
  // so its sibling reclaims the freed space.
  private onLeafEmpty(leaf: Leaf): void {
    if (this.rootNode === leaf) return;
    if (leaf === this.pinned) return; // the agent panel stays put even if somehow emptied
    this.collapse(leaf);
  }

  // Remove `leaf` and promote its sibling into the parent split's slot.
  private collapse(leaf: Leaf): void {
    const parent = leaf.parent;
    if (!parent) return; // root leaf is handled by onLeafEmpty
    const sibling = parent.start === leaf ? parent.end : parent.start;
    const grand = parent.parent;
    const parentWasStart = grand ? grand.start === parent : false;

    // Detach both children from the dying parent paned.
    parent.paned.setStartChild(null);
    parent.paned.setEndChild(null);

    // Replace the parent split with the surviving sibling.
    this.attach(sibling, grand, parentWasStart);

    if (this.active === leaf) this.setActive(firstLeaf(sibling));
    this.updateWelcomeState();
    leaf.panel.dispose(); // the collapsed leaf's panel is gone — sever its controllers (rule 9)
  }

  /** Tear down every panel in the layout tree — called when the owning workbench
   *  closes. Each Panel's focus/click controllers + TabView handlers are node-gtk-
   *  rooted, so a dropped workbench would otherwise leak them all (rule 9). */
  dispose(): void {
    const walk = (node: Node): void => {
      if (node instanceof Leaf) node.panel.dispose();
      else { walk(node.start); walk(node.end); }
    };
    walk(this.rootNode);
  }

  // --- Session serialization -------------------------------------------------

  /**
   * Snapshot the layout tree as a `PanelNode`, serializing each tab through
   * `serializeChild` (which returns `null` for tabs that shouldn't persist).
   * The active tab of each leaf is recorded by its index among the kept tabs.
   */
  serializeLayout(serializeChild: (child: Widget) => TabState | null): PanelNode {
    return this.serializeNode(this.rootNode, serializeChild);
  }

  private serializeNode(node: Node, serializeChild: (child: Widget) => TabState | null): PanelNode {
    if (node instanceof Leaf) {
      const activeWidget = node.panel.activeChild;
      const tabs: TabState[] = [];
      let activeIndex = 0;
      for (const child of node.panel.getChildren()) {
        const state = serializeChild(child);
        if (!state) continue; // dropped tabs don't shift the recorded active index
        if (child === activeWidget) activeIndex = tabs.length;
        tabs.push(state);
      }
      return { type: 'leaf', tabs, activeIndex };
    }
    const orientation =
      node.paned.getOrientation() === Gtk.Orientation.HORIZONTAL ? 'horizontal' : 'vertical';
    return {
      type: 'split',
      orientation,
      position: node.paned.getPosition(),
      start: this.serializeNode(node.start, serializeChild),
      end: this.serializeNode(node.end, serializeChild),
    };
  }

  /**
   * Replace the whole tree with one rebuilt from `node`, building each tab
   * through `buildChild`. Intended for a fresh group (at restore time); the prior
   * tree is discarded. The first leaf becomes active.
   */
  restoreLayout(node: PanelNode, buildChild: (state: TabState) => RestoredChild | null): void {
    const newRoot = this.buildNode(node, buildChild);
    const current = this.root.getFirstChild();
    if (current) this.root.remove(current);
    newRoot.parent = null;
    this.rootNode = newRoot;
    this.root.append(newRoot.widget);

    const first = firstLeaf(newRoot);
    this.active = first;
    first.panel.activate(); // onActivate early-returns (active already set); sync below
    this.options.onActiveChanged?.(first.panel.activeChild);
    this.updateWelcomeState();
  }

  private buildNode(node: PanelNode, buildChild: (state: TabState) => RestoredChild | null): Node {
    if (node.type === 'leaf') {
      const leaf = this.createLeaf();
      const handles: PanelChild[] = [];
      let activeHandleIndex = -1;
      node.tabs.forEach((state, index) => {
        const built = buildChild(state);
        if (!built) return;
        const child = leaf.panel.add(built.widget, {
          title: built.title,
          requireTabBar: built.requireTabBar,
        });
        built.onAttached?.(child);
        if (index === node.activeIndex) activeHandleIndex = handles.length;
        handles.push(child);
      });
      // Reselect the intended active tab; if it was dropped, the last-added tab
      // (already selected by `add`) stands in.
      if (activeHandleIndex >= 0) handles[activeHandleIndex].select();
      return leaf;
    }

    const orientation =
      node.orientation === 'horizontal' ? Gtk.Orientation.HORIZONTAL : Gtk.Orientation.VERTICAL;
    const paned = new Gtk.Paned({ orientation });
    paned.setHexpand(true);
    paned.setVexpand(true);

    const start = this.buildNode(node.start, buildChild);
    const end = this.buildNode(node.end, buildChild);
    paned.setStartChild(start.widget);
    paned.setEndChild(end.widget);
    paned.setPosition(node.position);

    const split = new Split(paned, start, end);
    start.parent = split;
    end.parent = split;
    return split;
  }

  // --- Focus navigation -----------------------------------------------------

  /**
   * Move the active leaf to the nearest leaf in `direction`, using on-screen
   * geometry so it works for any layout. Returns false when there is no leaf
   * that way (the host can then fall back to a dock).
   */
  focusDirection(direction: Direction): boolean {
    const leaves = this.leaves();
    if (leaves.length < 2) return false;

    const from = this.rectOf(this.active.widget);
    if (!from) return false;
    const fromCx = from.x + from.w / 2;
    const fromCy = from.y + from.h / 2;

    let best: Leaf | null = null;
    let bestScore = Infinity;
    for (const leaf of leaves) {
      if (leaf === this.active) continue;
      const r = this.rectOf(leaf.widget);
      if (!r) continue;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;

      let distance: number;
      let overlap: number;
      switch (direction) {
        case 'left':
          if (cx >= fromCx) continue;
          distance = fromCx - cx;
          overlap = span(from.y, from.h, r.y, r.h);
          break;
        case 'right':
          if (cx <= fromCx) continue;
          distance = cx - fromCx;
          overlap = span(from.y, from.h, r.y, r.h);
          break;
        case 'up':
          if (cy >= fromCy) continue;
          distance = fromCy - cy;
          overlap = span(from.x, from.w, r.x, r.w);
          break;
        case 'down':
          if (cy <= fromCy) continue;
          distance = cy - fromCy;
          overlap = span(from.x, from.w, r.x, r.w);
          break;
      }
      if (overlap <= 0) continue; // not aligned across the cross axis
      // Prefer the closest leaf; break ties toward the most-overlapping one.
      const score = distance - overlap * 0.001;
      if (score < bestScore) {
        bestScore = score;
        best = leaf;
      }
    }

    if (!best) return false;
    this.setActive(best);
    return true;
  }

  /** Cycle the active leaf to the next one in tree order. */
  focusNext(): boolean {
    const leaves = this.leaves();
    if (leaves.length < 2) return false;
    const i = leaves.indexOf(this.active);
    this.setActive(leaves[(i + 1) % leaves.length]);
    return true;
  }

  /** Number of leaves (editor groups) currently in the tree. */
  get paneCount(): number {
    return this.leaves().length;
  }

  // --- Internals ------------------------------------------------------------

  // Create a leaf whose panel routes its lifecycle signals back into the tree.
  // `leaf` is captured by the closures, which only run after it is assigned.
  private createLeaf(): Leaf {
    // eslint-disable-next-line prefer-const -- assigned below; the closures above close over it and only run later
    let leaf!: Leaf;
    const panel = new Panel({
      onActiveChanged: (child) => {
        if (this.active === leaf) this.options.onActiveChanged?.(child);
      },
      onClosed: (child) => this.options.onClosed?.(child),
      onTabCloseRequest: this.options.onTabCloseRequest
        ? (child) => this.options.onTabCloseRequest!(child)
        : undefined,
      onEmpty: () => this.onLeafEmpty(leaf),
      // Focus entering this leaf (a click, or programmatic activation) makes it the
      // active leaf. The Panel owns the single-active-panel rule and the focus
      // controller; here we just sync the tree's notion of which leaf is active.
      onActivate: () => {
        if (this.active === leaf) return;
        this.active = leaf;
        if (this.pinned && leaf !== this.pinned) this.lastWorkArea = leaf;
        this.options.onActiveChanged?.(leaf.panel.activeChild);
      },
    });
    leaf = new Leaf(panel);

    // Fill its slot whether it sits in the root Box or a Paned.
    panel.root.setHexpand(true);
    panel.root.setVexpand(true);

    return leaf;
  }

  // Make `leaf` the active leaf. Routes through the Panel's single-active-panel
  // manager (which deactivates the previously active panel — another leaf or a
  // dock); `onActivate` then updates `this.active`.
  private setActive(leaf: Leaf): void {
    leaf.panel.activate();
  }

  // Remove `node` from its slot (a parent paned, or the root container).
  private detach(node: Node, parent: Split | null, wasStart: boolean): void {
    if (!parent) {
      this.root.remove(node.widget);
    } else if (wasStart) {
      parent.paned.setStartChild(null);
    } else {
      parent.paned.setEndChild(null);
    }
  }

  // Place `node` into a slot (a parent paned, or the root container), updating
  // the tree links to match.
  private attach(node: Node, parent: Split | null, asStart: boolean): void {
    node.parent = parent;
    if (!parent) {
      // The root container holds exactly one child; drop it before re-seating so
      // a collapsed split's emptied paned doesn't linger alongside the survivor.
      const current = this.root.getFirstChild();
      if (current) this.root.remove(current);
      this.rootNode = node;
      this.root.append(node.widget);
    } else if (asStart) {
      parent.start = node;
      parent.paned.setStartChild(node.widget);
    } else {
      parent.end = node;
      parent.paned.setEndChild(node.widget);
    }
  }

  private leaves(node: Node = this.rootNode, out: Leaf[] = []): Leaf[] {
    if (node instanceof Leaf) out.push(node);
    else {
      this.leaves(node.start, out);
      this.leaves(node.end, out);
    }
    return out;
  }

  // The widget's bounds relative to the group root, or null if unavailable.
  private rectOf(widget: Widget): { x: number; y: number; w: number; h: number } | null {
    try {
      const result: any = widget.computeBounds(this.root);
      const rect = Array.isArray(result) ? result[1] : result;
      if (!rect) return null;
      return { x: rect.getX(), y: rect.getY(), w: rect.getWidth(), h: rect.getHeight() };
    } catch {
      return null;
    }
  }
}

// Walk to the first leaf of a subtree (the start side all the way down).
function firstLeaf(node: Node): Leaf {
  let n = node;
  while (!(n instanceof Leaf)) n = n.start;
  return n;
}

// Overlap length of two 1-D segments [a0, a0+aLen] and [b0, b0+bLen].
function span(a0: number, aLen: number, b0: number, bLen: number): number {
  return Math.min(a0 + aLen, b0 + bLen) - Math.max(a0, b0);
}
