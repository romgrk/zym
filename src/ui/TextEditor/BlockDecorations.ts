/*
 * BlockDecorations — show a real widget *between* buffer lines with zero
 * buffer footprint (no synthesized text line). The "proper" virtual-line
 * mechanism from docs/text-editor/inline-widgets.md, proven in
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
import Gtk from 'gi:Gtk-4.0';
import type GtkSource from 'gi:GtkSource-5';
type SourceView = InstanceType<typeof GtkSource.View>;
import { CompositeDisposable, Disposable } from '../../util/eventKit.ts';

// 'below'/'above' reserve a blank band under/over the anchor line (the widget floats in it, the line
// stays its own text height). 'on' instead grows the anchor line to the widget's height and places
// the widget OVER it — so the widget covers its (read-only) line and the caret rests on it (the diff
// file headers). The anchor line must not be the last buffer line.
export type BlockDecorationPlacement = 'below' | 'above' | 'on';

export interface BlockDecorationOptions {
  /** Anchor line (buffer row). The band sits below it ('below') or above it ('above'). */
  line: number;
  widget: InstanceType<typeof Gtk.Widget>;
  placement?: BlockDecorationPlacement;
  /** STICKY: a full-width bar pinned to the viewport (the multi-file diff file headers — VSCode-style
   *  sticky scroll). Repositioned on every scroll: its Y clamps to the viewport top once its anchor
   *  scrolls above it (pushed up by the next sticky band), and its X clamps to the viewport left with
   *  the slot forced to the visible width, so it stays put and spans the viewport on BOTH axes. A
   *  non-sticky band just scrolls natively with the text. The text view clips it (no overflow), and —
   *  being a text-window child — it neither swallows scroll nor needs an event controller. Used with
   *  `placement: 'on'` (the header covers its read-only row). */
  sticky?: boolean;
  /** Force a NON-sticky band to span the full viewport width (its slot width-requested to the
   *  visible width, re-fit on resize) instead of hugging the widget's natural width — so a band
   *  that scrolls with the text (the `⋯` diff gap) still fills the row like the sticky headers.
   *  Ignored for sticky bands, which are always full-width. */
  fullWidth?: boolean;
}

export interface BlockDecorationHandle {
  /** The decoration's current anchor line (its mark's line), tracking edits since placement. */
  line(): number;
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
  sticky: boolean; // pin to the viewport top when scrolled past (see BlockDecorationOptions.sticky)
  fullWidth: boolean; // span the full viewport width even when non-sticky (see BlockDecorationOptions.fullWidth)
  height: number;
  placed: boolean; // overlay (the slot) added to the view yet (deferred until mapped)
  lastX: number; // last buffer-X the overlay was moved to (sticky bands pin X; skip no-op moves)
  lastY: number; // last buffer-Y the overlay was moved to (skip no-op moves)
  lastWidth: number; // last width forced on the slot (sticky = full viewport width; -1 = natural)
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
  // The view/buffer/adjustment signal handlers below. Each closure captures `this`, so an
  // un-disconnected handler pins this controller (and the view + buffer it holds) forever;
  // `dispose()` releases them. See TextEditor `subs`.
  private readonly subs = new CompositeDisposable();

  constructor(view: SourceView) {
    this.view = view;
    this.buffer = view.getBuffer();

    // Place any blocks added before the view was mapped. `map` fires before the
    // first layout pass, so line geometry (get_iter_location) is still 0 — defer
    // and retry until it's valid (see scheduleFlush).
    const onMap = () => {
      this.scheduleFlush(0);
      this.hookVadjustment();
    };
    view.on('map', onMap);
    this.subs.add(new Disposable(() => view.off('map', onMap)));

    // An edit to (or around) a band's anchor line can drop the reserved-space tag and leave the
    // overlay stranded — fatal on an EDITABLE surface (the search/diff multibuffers), where you type
    // on the very rows carrying header/gap bands. Re-reserve + reposition every band after any buffer
    // mutation (coalesced to one frame), so a band's space survives editing. Tag/overlay ops don't
    // fire `changed`, so this never re-enters.
    const onChanged = () => this.scheduleReserve();
    this.buffer.on('changed', onChanged);
    this.subs.add(new Disposable(() => this.buffer.off('changed', onChanged)));
  }

  /** Reposition whenever the content height changes — a fold collapse/expand, an
   *  edit, or a window resize moves anchors. The vadjustment's `changed` fires
   *  after allocation (fresh geometry); we defer to idle to avoid repositioning
   *  mid-allocation. This is what keeps a band aligned after a fold toggle. */
  private hookVadjustment(): void {
    if (this.vadjHooked) return;
    const vadj = this.view.getVadjustment?.();
    if (!vadj) return;
    this.vadjHooked = true;
    const onVadjChanged = () => this.scheduleReposition();
    vadj.on('changed', onVadjChanged);
    this.subs.add(new Disposable(() => vadj.off('changed', onVadjChanged)));
    // STICKY: a sticky band must re-pin on every scroll — VERTICALLY (re-clamp to the viewport top) on
    // the vadjustment, and HORIZONTALLY (re-pin X to the viewport left + re-fit the width) on the
    // hadjustment (value = sideways scroll, changed = resize). Non-sticky bands scroll natively (no
    // per-scroll work). Done synchronously so the pin tracks the scroll in the same frame; it reads
    // only buffer-stable geometry, so it's safe here.
    const onScroll = () => { for (const b of this.blocks) if (b.placed && b.sticky) this.reposition(b); };
    vadj.on('value-changed', onScroll);
    this.subs.add(new Disposable(() => vadj.off('value-changed', onScroll)));
    const hadj = this.view.getHadjustment?.();
    if (hadj) {
      hadj.on('value-changed', onScroll);
      hadj.on('changed', onScroll);
      this.subs.add(new Disposable(() => { hadj.off('value-changed', onScroll); hadj.off('changed', onScroll); }));
    }
  }

  add(options: BlockDecorationOptions): BlockDecorationHandle {
    const placement = options.placement ?? 'below';
    const lineIter = unwrap(this.buffer.getIterAtLine(options.line));
    // Reuse a pooled slot (already an overlay child of the view) if available, else
    // make a fresh Box that `place()` will add as a new overlay child.
    const reused = this.freeSlots.pop();
    const slot = reused ?? new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    slot.setSizeRequest(-1, -1); // a pooled slot may carry a sticky full-width request — reset to natural
    slot.append(options.widget);
    slot.setVisible(true);
    const block: Block = {
      mark: this.buffer.createMark(null, lineIter, true /* left gravity: stay at line start */),
      tag: new Gtk.TextTag({ name: `inline-block:${this.nextTagId++}` }),
      slot,
      widget: options.widget,
      placement,
      sticky: options.sticky ?? false,
      fullWidth: options.fullWidth ?? false,
      height: 0,
      placed: false, // set once place() runs; place() skips re-adding an already-parented slot
      lastX: NaN,
      lastY: NaN,
      lastWidth: NaN,
    };
    (this.buffer.getTagTable()).add(block.tag);
    this.blocks.add(block);

    // Always place from the deferred flush, never synchronously — even when mapped.
    // A block added during a fold toggle runs right after the body's invisible-tag
    // change invalidated the layout; placing (addOverlay) synchronously then leaves
    // the overlay child unallocated until an external relayout. Deferring lets the
    // invalidation settle first (this is the path the initial placement uses).
    this.scheduleFlush(0);

    return {
      line: () => this.markLine(block),
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
    this.reserveTickId = this.view.addTickCallback(() => {
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
    this.repositionTickId = this.view.addTickCallback(() => {
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
    const loc = this.view.getIterLocation(iter);
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
      this.view.addOverlay(block.slot, 0, this.lineRect(line).y);
    }
    block.placed = true;

    block.height = Math.max(1, (block.slot.measure(Gtk.Orientation.VERTICAL, -1))[1]);

    // Reserve space on the anchor line (re-applied each place in case it moved). Detach the tag
    // first so the line is back to its NATURAL height before we reserve from it.
    const start = unwrap(this.buffer.getIterAtLine(line));
    const end = unwrap(this.buffer.getIterAtLine(line + 1)); // ok: anchors aren't the last line
    this.buffer.removeTag(block.tag, this.buffer.getStartIter(), this.buffer.getEndIter());
    if (block.placement === 'on') {
      // Grow the line to the widget's height (extra space BELOW its text), so the widget — placed at
      // the line top — covers the whole (read-only) line and the caret rests on it.
      block.tag.pixelsBelowLines = Math.max(1, block.height - this.lineRect(line).height);
    } else {
      block.tag[block.placement === 'below' ? 'pixelsBelowLines' : 'pixelsAboveLines'] = block.height;
    }
    this.buffer.applyTag(block.tag, start, end);

    // Force a re-allocation: under node-gtk's cooperative loop, adding the overlay
    // and changing the gap tag don't otherwise trigger size_allocate, so the gap
    // stays unreserved and the overlay child unallocated (invisible) until some
    // external event (e.g. a window resize) forces a relayout.
    this.view.queueResize?.();
    this.reposition(block);
  }

  private reposition(block: Block): void {
    const rect = this.lineRect(this.markLine(block));
    if (rect.height === 0) return; // geometry momentarily invalid — keep last position
    let y = this.bandTop(block, rect);
    if (!block.sticky) {
      // Non-sticky: anchored at the text-window left (buffer x=0), scrolls natively on both axes.
      // A full-width band still gets its slot fitted to the visible width (re-fit before the no-op
      // guard so a width-only change — e.g. a resize that leaves Y put — still lands).
      if (block.fullWidth) this.fitWidth(block);
      if (y === block.lastY) return; // no-op move (avoids churn during the settle window)
      block.lastY = y;
      this.view.moveOverlay(block.slot, 0, y);
      return;
    }
    // STICKY — a full-width bar pinned to the viewport. VERTICALLY: pin to the viewport top once the
    // band scrolls above it; PUSH UP so stacked bands don't accumulate (the earlier header slides up
    // and rides the text out of view as the next reaches the top).
    y = Math.max(y, Math.round(this.scrollTop()));
    const nextTop = this.nextStickyBandTop(block);
    if (nextTop != null) y = Math.min(y, nextTop - block.height);
    // HORIZONTALLY: pin X to the viewport left (buffer x = hscroll → window x ≈ 0) and force the slot
    // to the visible width, so the bar spans the viewport and stays put as the text scrolls sideways.
    const hadj = this.view.getHadjustment?.();
    const x = hadj ? Math.round(hadj.getValue()) : 0;
    this.fitWidth(block);
    if (x === block.lastX && y === block.lastY) return; // no-op move
    block.lastX = x;
    block.lastY = y;
    this.view.moveOverlay(block.slot, x, y);
  }

  /** Width-request the slot to the viewport's visible width (full-width / sticky bands), so the band
   *  spans the row rather than hugging its widget's natural width. Cheap no-op when unchanged. */
  private fitWidth(block: Block): void {
    const hadj = this.view.getHadjustment?.();
    const width = hadj ? Math.round(hadj.getPageSize()) : -1;
    if (width > 0 && width !== block.lastWidth) {
      block.slot.setSizeRequest(width, -1);
      block.lastWidth = width;
    }
  }

  /** The overlay's top in buffer coords for a block, by placement: 'below' = under the line, 'above'
   *  = the band above the line, 'on' = the line top (the widget covers the grown line). */
  private bandTop(block: Block, rect: { y: number; height: number }): number {
    if (block.placement === 'below') return rect.y + rect.height;
    if (block.placement === 'on') return rect.y;
    return rect.y - block.height; // 'above': the tag pushed the line down by `height`
  }

  /** The viewport's top in buffer coords (the vadjustment value) — the clamp for sticky bands. */
  private scrollTop(): number {
    const vadj = this.view.getVadjustment?.();
    return vadj ? vadj.getValue() : 0;
  }

  /** Pixels occluded at the viewport TOP by a sticky band pinned there (its height), or 0 when none
   *  is scrolled past — the editor reserves this so the caret can't hide under it (`topInsetProvider`).
   *  Heights are uniform, so the max over scrolled-past sticky bands is the pinned band's height. */
  stickyTopInset(): number {
    const scrollTop = Math.round(this.scrollTop());
    let inset = 0;
    for (const block of this.blocks) {
      if (!block.sticky || !block.placed) continue;
      const bandTop = this.bandTop(block, this.lineRect(this.markLine(block)));
      if (bandTop <= scrollTop) inset = Math.max(inset, block.height); // scrolled past → pinned at the top
    }
    return inset;
  }

  /** The natural band top (buffer Y) of the nearest sticky band BELOW `block` (next by anchor line),
   *  or null if none — the ceiling that pushes a stacked sticky band up so they don't pile on top of
   *  each other at the viewport top. */
  private nextStickyBandTop(block: Block): number | null {
    const line = this.markLine(block);
    let best: Block | null = null;
    let bestLine = Infinity;
    for (const b of this.blocks) {
      if (b === block || !b.sticky || !b.placed) continue;
      const l = this.markLine(b);
      if (l > line && l < bestLine) { bestLine = l; best = b; }
    }
    return best ? this.bandTop(best, this.lineRect(bestLine)) : null;
  }

  private removeBlock(block: Block): void {
    if (!this.blocks.delete(block)) return;
    this.buffer.removeTag(block.tag, this.buffer.getStartIter(), this.buffer.getEndIter());
    (this.buffer.getTagTable()).remove(block.tag);
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

  /** Tear down on editor disposal: drop every view/buffer/adjustment signal handler (each
   *  pins this controller → the view → the buffer), cancel any in-flight repositioning tick
   *  callbacks, and remove every block so its anchor mark + gap tag leave the buffer (which
   *  the shared document may outlive). Called from `TextEditor.dispose()`. */
  dispose(): void {
    this.subs.dispose();
    if (this.repositionTickId) {
      this.view.removeTickCallback(this.repositionTickId);
      this.repositionTickId = 0;
    }
    if (this.reserveTickId) {
      this.view.removeTickCallback(this.reserveTickId);
      this.reserveTickId = 0;
    }
    for (const block of [...this.blocks]) this.removeBlock(block);
  }
}
