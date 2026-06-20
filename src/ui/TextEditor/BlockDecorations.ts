/*
 * BlockDecorations — show a real widget *between* buffer lines with zero
 * buffer footprint (no synthesized text line). The "proper" virtual-line
 * mechanism from tasks/code-editing/inline-widgets.md, proven in
 * src/poc/inline-overlay.ts.
 *
 * How it works (per block):
 *   1. A `Gtk.TextTag` with `pixels-below-lines` (or `-above-`) = the widget's
 *      measured height, applied to the anchor line, reserves a blank band.
 *   2. `gtk_text_view_add_overlay(child, x, y)` drops the widget into that band at
 *      a *buffer* coordinate — so it scrolls with the text for free.
 *   3. A `GtkTextMark` tracks the anchor line across edits; `get_iter_location`
 *      gives its pixel rect (buffer coords) to position the overlay.
 *
 * Removal note: the overlay child is a controller-owned "slot" `Gtk.Box` that wraps
 * the consumer's widget. We never remove the slot from the view, because in this
 * node-gtk build `gtk_text_view_remove` is a no-op (it warns "not a child" and leaves
 * the child parented to the private `GtkTextViewChild`), and forcing `unparent()`
 * instead corrupts that child's internal overlay list → a `gtk_widget_snapshot_child`
 * assertion on the next paint. So removal detaches the consumer widget from the slot
 * (`Gtk.Box.remove`, which works) and hides+pools the slot for the view's lifetime;
 * `add()` reuses a pooled slot rather than creating a new overlay child.
 *
 * Scope: this is the **non-interactive / click-only** path (`add_overlay` children
 * are descendants of the text view, so a focusable nested *editor* leaks IM input
 * — see inline-widgets.md). Clickable widgets (the fold placeholder, code-lens
 * buttons) and drawn content work; a focusable peek editor uses the planned
 * sibling-overlay variant instead.
 *
 * The view must be **mapped** before an overlay is placed (pre-realize geometry is
 * 0); `add()` before map defers placement to the `map` signal. Layout changes that
 * move anchors (edits, fold toggles) aren't auto-followed — call `repositionAll()`.
 */
import { Gtk, type SourceView } from '../../gi.ts';

export type BlockDecorationPlacement = 'below' | 'above';

export interface BlockDecorationOptions {
  /** Anchor line (buffer row). The band sits below it ('below') or above it ('above'). */
  line: number;
  widget: InstanceType<typeof Gtk.Widget>;
  placement?: BlockDecorationPlacement;
}

export interface BlockDecorationHandle {
  /** Remove the band + overlay and drop the anchor mark. */
  remove(): void;
  /** Re-measure the widget height and reposition (after the widget's size changes). */
  invalidate(): void;
  /** Move to a new anchor line and/or swap the widget IN PLACE — keeping the same (parented)
   *  overlay slot, so the reserved band never collapses to zero and re-expands (which flickers /
   *  jumps the text). A no-op when neither the line nor the widget actually changes. Used by a
   *  surface that re-flows (the diff multibuffer's re-diff) to reconcile its headers/gaps without
   *  a teardown. */
  update(opts: { line?: number; widget?: InstanceType<typeof Gtk.Widget> }): void;
}

interface Block {
  mark: any; // GtkTextMark at the anchor line start
  tag: any; // per-block gap tag
  slot: any; // controller-owned Gtk.Box that IS the overlay child (holds `widget`)
  widget: any; // the consumer's widget, parented inside `slot`
  placement: BlockDecorationPlacement;
  height: number;
  placed: boolean; // overlay (the slot) added to the view yet (deferred until mapped)
  lastY: number; // last buffer-Y the overlay was moved to (skip no-op moves)
}

// Frames to keep repositioning after a layout-changing event (fold toggle, edit).
// A tick callback runs each frame; geometry settles within a couple, then it stops.
const REPOSITION_FRAMES = 6;

/** getIter*, defensively unwrapping node-gtk's [ok, iter] return shape. */
const unwrap = (res: any): any => (Array.isArray(res) ? res[1] : res);

export class BlockDecorations {
  private readonly view: SourceView;
  private readonly buffer: any;
  private readonly blocks = new Set<Block>();
  // Slots (overlay-child Boxes) detached from a removed block, hidden and parented,
  // kept for reuse — see the removal note in the file header.
  private readonly freeSlots: any[] = [];
  private nextTagId = 0;
  private flushPending = false;
  private repositionTickId = 0;
  private repositionFrames = 0;
  private vadjHooked = false;

  constructor(view: SourceView) {
    this.view = view;
    this.buffer = (view as any).getBuffer();

    // Place any blocks added before the view was mapped. `map` fires before the
    // first layout pass, so line geometry (get_iter_location) is still 0 — defer
    // and retry until it's valid (see scheduleFlush).
    (view as any).on('map', () => {
      this.scheduleFlush(0);
      this.hookVadjustment();
    });

    // An edit to (or around) a band's anchor line can drop the reserved-space tag and leave the
    // overlay stranded — fatal on an EDITABLE surface (the search/diff multibuffers), where you type
    // on the very rows carrying header/gap bands. Re-reserve + reposition every band after any buffer
    // mutation (coalesced to one frame), so a band's space survives editing. Tag/overlay ops don't
    // fire `changed`, so this never re-enters.
    this.buffer.on('changed', () => this.scheduleReserve());
  }

  /** Reposition whenever the content height changes — a fold collapse/expand, an
   *  edit, or a window resize moves anchors. The vadjustment's `changed` fires
   *  after allocation (fresh geometry); we defer to idle to avoid repositioning
   *  mid-allocation. This is what keeps a band aligned after a fold toggle. */
  private hookVadjustment(): void {
    if (this.vadjHooked) return;
    const vadj = (this.view as any).getVadjustment?.();
    if (!vadj) return;
    this.vadjHooked = true;
    vadj.on('changed', () => this.scheduleReposition());
  }

  add(options: BlockDecorationOptions): BlockDecorationHandle {
    const placement = options.placement ?? 'below';
    const lineIter = unwrap(this.buffer.getIterAtLine(options.line));
    // Reuse a pooled slot (already an overlay child of the view) if available, else
    // make a fresh Box that `place()` will add as a new overlay child.
    const reused = this.freeSlots.pop();
    const slot = reused ?? new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    slot.append(options.widget);
    slot.setVisible(true);
    const block: Block = {
      mark: this.buffer.createMark(null, lineIter, true /* left gravity: stay at line start */),
      tag: new Gtk.TextTag({ name: `inline-block:${this.nextTagId++}` } as any),
      slot,
      widget: options.widget,
      placement,
      height: 0,
      placed: false, // set once place() runs; place() skips re-adding an already-parented slot
      lastY: NaN,
    };
    (this.buffer.getTagTable() as any).add(block.tag);
    this.blocks.add(block);

    // Always place from the deferred flush, never synchronously — even when mapped.
    // A block added during a fold toggle runs right after the body's invisible-tag
    // change invalidated the layout; placing (addOverlay) synchronously then leaves
    // the overlay child unallocated until an external relayout. Deferring lets the
    // invalidation settle first (this is the path the initial placement uses).
    this.scheduleFlush(0);

    return {
      remove: () => this.removeBlock(block),
      invalidate: () => {
        if (block.placed) this.place(block);
      },
      update: (opts) => this.updateBlock(block, opts),
    };
  }

  /** Move a block to a new anchor line and/or swap its widget without removing the slot from the
   *  view — so the reserved band stays put (no collapse→re-expand flicker). Only re-places when
   *  something actually changed. */
  private updateBlock(block: Block, opts: { line?: number; widget?: any }): void {
    let dirty = false;
    if (opts.widget && opts.widget !== block.widget) {
      // Detach the old consumer widget from the slot and parent the new one (the slot — the overlay
      // child — stays put). Same Gtk.Box.remove path as removal; never unparent the slot itself.
      if (block.widget.getParent?.() === block.slot) block.slot.remove(block.widget);
      block.slot.append(opts.widget);
      block.widget = opts.widget;
      dirty = true;
    }
    if (opts.line != null && opts.line !== this.markLine(block)) {
      // Re-seat the anchor mark (its line moved by more than the splice carried it).
      const iter = unwrap(this.buffer.getIterAtLine(opts.line));
      this.buffer.deleteMark(block.mark);
      block.mark = this.buffer.createMark(null, iter, true /* left gravity */);
      dirty = true;
    }
    if (!dirty) return;
    if (block.placed) this.place(block); // re-measure band at the (possibly new) line + reposition
    else this.scheduleFlush(0);
  }

  /** Reposition every placed block — call after layout shifts an anchor (a fold
   *  toggle, an edit above a block); `add_overlay` follows scroll but not these.
   *  Deferred to idle: the triggering change (e.g. a fold's invisible tag) hasn't
   *  re-validated line geometry yet, so reading get_iter_location now is stale. */
  repositionAll(): void {
    this.scheduleReposition();
  }

  /** The band placement anchored at view `line` — `'above'` (a header band, taller cell above) or
   *  `'below'` (a gap/image band, taller cell below), else null. A gutter uses this to align its
   *  number onto the text rather than floating it into the reserved band. */
  placementAtLine(line: number): BlockDecorationPlacement | null {
    for (const block of this.blocks) if (block.placed && this.markLine(block) === line) return block.placement;
    return null;
  }

  /** Re-reserve + reposition every placed band after an edit (which can drop the reserved-space tag
   *  on its anchor line, or — after an undo — leave the band mispositioned until the layout settles).
   *  Deferred to a tick (a synchronous re-place during the edit's layout-invalidation leaves the
   *  overlay unallocated), then the geometry is settled over the next few frames via
   *  `scheduleReposition`. Coalesced. */
  private reserveTickId = 0;
  private scheduleReserve(): void {
    if (this.reserveTickId || this.blocks.size === 0) return;
    this.reserveTickId = (this.view as any).addTickCallback(() => {
      this.reserveTickId = 0;
      for (const block of this.blocks) if (block.placed) this.place(block); // re-apply the tag + reposition
      this.scheduleReposition(); // settle the position over the next frames (post-undo relayout)
      return false; // G_SOURCE_REMOVE — run once; the reposition window does the multi-frame settle
    });
  }

  // --- internals -------------------------------------------------------------

  /** Reposition every placed block once per frame for a short window, then stop.
   *  A layout-changing event (fold toggle) settles over a frame or two, and a tick
   *  callback runs in sync with the frame clock — so each pass reads progressively
   *  fresher geometry (vs. an idle/timeout, which fires at an unpredictable point in
   *  node-gtk's cooperative loop and can read mid-transition coordinates). */
  private scheduleReposition(): void {
    this.repositionFrames = 0; // (re)start the settle window
    if (this.repositionTickId) return; // a tick is already running
    this.repositionTickId = (this.view as any).addTickCallback(() => {
      for (const block of this.blocks) if (block.placed) this.reposition(block);
      if (++this.repositionFrames >= REPOSITION_FRAMES) {
        this.repositionTickId = 0;
        return false; // G_SOURCE_REMOVE
      }
      return true; // G_SOURCE_CONTINUE
    });
  }

  /** Retry placing unplaced blocks until the view has validated line geometry
   *  (get_iter_location returns a non-zero height). One timer at a time; ~one frame
   *  apart, capped so a never-ready view can't spin forever. */
  private scheduleFlush(tries: number): void {
    if (this.flushPending) return;
    this.flushPending = true;
    setTimeout(() => {
      this.flushPending = false;
      let allReady = true;
      for (const block of this.blocks) {
        if (block.placed) continue;
        if (this.lineRect(this.markLine(block)).height === 0) allReady = false;
        else this.place(block);
      }
      if (!allReady && tries < 30) this.scheduleFlush(tries + 1);
    }, 16);
  }

  private markLine(block: Block): number {
    return unwrap(this.buffer.getIterAtMark(block.mark)).getLine();
  }

  /** Anchor line's pixel rect (buffer coords). */
  private lineRect(line: number): { y: number; height: number } {
    const iter = unwrap(this.buffer.getIterAtLine(line));
    const loc = (this.view as any).getIterLocation(iter);
    const rect = Array.isArray(loc) ? loc[0] ?? loc[1] : loc;
    return { y: rect?.y ?? 0, height: rect?.height ?? 0 };
  }

  /** First add: measure the widget, reserve the band, add the overlay. No-ops (and
   *  reschedules) until the view has validated line geometry. */
  private place(block: Block): void {
    const line = this.markLine(block);
    if (this.lineRect(line).height === 0) {
      this.scheduleFlush(0); // geometry not ready (pre-first-draw) — retry
      return;
    }

    // Add the slot as an overlay first so it's parented and can measure correctly.
    // A reused (pooled) slot is already an overlay child — keep it, just (re)position.
    if (!block.slot.getParent?.()) {
      (this.view as any).addOverlay(block.slot, 0, this.lineRect(line).y);
    }
    block.placed = true;

    block.height = Math.max(1, (block.slot.measure(Gtk.Orientation.VERTICAL, -1) as any)[1]);

    // Reserve the band on the anchor line (re-applied each place in case it moved).
    const prop = block.placement === 'below' ? 'pixelsBelowLines' : 'pixelsAboveLines';
    (block.tag as any)[prop] = block.height;
    const start = unwrap(this.buffer.getIterAtLine(line));
    const end = unwrap(this.buffer.getIterAtLine(line + 1)); // ok: anchors aren't the last line
    this.buffer.removeTag(block.tag, this.buffer.getStartIter(), this.buffer.getEndIter());
    this.buffer.applyTag(block.tag, start, end);

    // Force a re-allocation: under node-gtk's cooperative loop, adding the overlay
    // and changing the gap tag don't otherwise trigger size_allocate, so the gap
    // stays unreserved and the overlay child unallocated (invisible) until some
    // external event (e.g. a window resize) forces a relayout.
    (this.view as any).queueResize?.();
    this.reposition(block);
  }

  private reposition(block: Block): void {
    const rect = this.lineRect(this.markLine(block));
    if (rect.height === 0) return; // geometry momentarily invalid — keep last position
    // 'below': band starts at the anchor's bottom. 'above': the tag pushed the anchor
    // down by `height`, so the band is the `height` px above its new top.
    const y = block.placement === 'below' ? rect.y + rect.height : rect.y - block.height;
    if (y === block.lastY) return; // no-op move (avoids churn during the settle window)
    block.lastY = y;
    (this.view as any).moveOverlay(block.slot, 0, y);
  }

  /** A reconciled band set backed by this controller — one per consumer (markdown images, the
   *  continuous diff's headers/gaps, the search results' headers/gaps). See `BlockBandSet`. */
  bands(): BlockBandSet {
    return new BlockBandSet(this);
  }

  private removeBlock(block: Block): void {
    if (!this.blocks.delete(block)) return;
    this.buffer.removeTag(block.tag, this.buffer.getStartIter(), this.buffer.getEndIter());
    (this.buffer.getTagTable() as any).remove(block.tag);
    this.buffer.deleteMark(block.mark);

    // Detach the consumer's widget from the slot (Gtk.Box.remove works), so it can be
    // freed. Do NOT remove/unparent the slot itself from the view: gtk_text_view_remove
    // is a no-op here and unparenting corrupts the GtkTextViewChild overlay list (see the
    // file header). Hide it and pool it for reuse instead.
    if (block.widget.getParent?.() === block.slot) block.slot.remove(block.widget);
    block.slot.setVisible(false);
    // Re-pool any slot that's an overlay child of the view (parented), regardless of
    // whether it finished placing; a never-parented fresh slot is just dropped (GC).
    if (block.slot.getParent?.()) this.freeSlots.push(block.slot);
  }
}

/** One band in a reconciled set: a stable `id` (which band — reused/moved across reconciles), a
 *  content `key` (the widget is rebuilt only when it changes), its anchor `line`, and a lazy
 *  `build`. */
export interface BlockBandSpec {
  id: string;
  key: string;
  line: number;
  placement?: BlockDecorationPlacement;
  build: () => InstanceType<typeof Gtk.Widget>;
}

/**
 * A keyed set of block-decoration bands reconciled in place against a freshly-derived list — the
 * one mechanism behind every consumer that re-flows its header/gap/image bands: the continuous
 * diff (`ContinuousDiffView`), the project-search results (`SearchResultsView`), and the markdown
 * image preview. Reusing handles in place (vs. teardown + re-add) avoids the band collapse →
 * re-expand that flickers and jumps the text. Owns its handles; create one per consumer via
 * `BlockDecorations.bands()`.
 */
export class BlockBandSet {
  private readonly entries = new Map<string, { handle: BlockDecorationHandle; key: string }>();
  private readonly blocks: BlockDecorations;
  constructor(blocks: BlockDecorations) {
    this.blocks = blocks;
  }

  /** Reconcile to `specs`: move/rebuild bands matched by `id` (rebuilding the widget only when its
   *  `key` changed, else keeping the live one), add new ones, and remove any whose `id` is gone. */
  reconcile(specs: BlockBandSpec[]): void {
    const seen = new Set<string>();
    for (const spec of specs) {
      seen.add(spec.id);
      const prev = this.entries.get(spec.id);
      if (prev) {
        prev.handle.update({ line: spec.line, widget: prev.key === spec.key ? undefined : spec.build() });
        prev.key = spec.key;
      } else {
        const handle = this.blocks.add({ line: spec.line, widget: spec.build(), placement: spec.placement });
        this.entries.set(spec.id, { handle, key: spec.key });
      }
    }
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) {
        entry.handle.remove();
        this.entries.delete(id);
      }
    }
  }

  /** Remove every band (teardown). */
  clear(): void {
    for (const entry of this.entries.values()) entry.handle.remove();
    this.entries.clear();
  }
}
