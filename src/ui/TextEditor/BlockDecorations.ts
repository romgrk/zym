import Gtk from 'gi:Gtk-4.0';
import type GtkSource from 'gi:GtkSource-5';
import { CompositeDisposable } from '../../util/eventKit.ts';

type SourceView = InstanceType<typeof GtkSource.View>;

export type BlockDecorationPlacement = 'below' | 'above' | 'on';
export type BlockWidth = 'viewport' | 'content';

const DEFAULT_HEIGHT = 20;
const DEFAULT_LINE_HEIGHT = 18;
const VIEWPORT_OVERSCAN = 1;
const REPOSITION_FRAMES = 6;
const REPOSITION_MAX_FRAMES = 180;

export interface BlockDecorationOptions {
  line: number;
  build: () => InstanceType<typeof Gtk.Widget>;
  dispose?: () => void;
  /** Widget-free height reservation. Materialization replaces it with the measured height. */
  height?: number;
  placement?: BlockDecorationPlacement;
  sticky?: boolean;
  fullWidth?: BlockWidth;
}

export interface BlockDecorationHandle {
  line(): number;
  widget(): InstanceType<typeof Gtk.Widget> | null;
  remove(): void;
  invalidate(): void;
  update(opts: {
    line?: number;
    build?: () => InstanceType<typeof Gtk.Widget>;
    dispose?: () => void;
    height?: number;
  }): void;
}

interface Block {
  mark: any;
  tag: any | null;
  slot: any | null;
  widget: any | null;
  build: () => InstanceType<typeof Gtk.Widget>;
  dispose: (() => void) | undefined;
  widgetDispose: (() => void) | undefined;
  placement: BlockDecorationPlacement;
  sticky: boolean;
  fullWidth: BlockWidth | null;
  height: number;
  reservedLine: number;
  reserved: boolean;
  materialized: boolean;
  lastX: number;
  lastY: number;
  lastWidth: number;
  orderLine: number;
  slotGeneration: number;
}

const unwrap = (res: any): any => (Array.isArray(res) ? res[1] : res);

export class BlockDecorations {
  private readonly view: SourceView;
  private readonly buffer: any;
  private readonly blocks = new Set<Block>();
  private readonly materialized = new Set<Block>();
  private orderedBlocks: Block[] = [];
  private orderDirty = false;
  private readonly freeSlots: any[] = [];
  private readonly freeStickySlots: any[] = [];
  private readonly slotGenerations = new WeakMap<object, number>();
  private readonly reservationTags = new Map<string, any>();
  private nextTagId = 0;
  private nonStickyGeneration = 0;
  private transactionDepth = 0;
  private readonly pendingReservationRemovals = new Map<any, Set<number>>();
  private readonly pendingReservationAdds = new Set<Block>();
  private viewportTickId = 0;
  private reservationTickId = 0;
  private reserveTickId = 0;
  private repositionTickId = 0;
  private repositionStableFrames = 0;
  private repositionTotalFrames = 0;
  private vadjHooked = false;
  private syncingViewport = false;
  private updatingReservations = false;
  private readonly subs = new CompositeDisposable();

  constructor(view: SourceView) {
    this.view = view;
    this.buffer = view.getBuffer();
    this.subs.connect(view, 'map', () => {
      this.hookVadjustment();
      this.scheduleReservationFlush();
      this.scheduleViewportSync();
    });
    this.subs.connect(this.buffer, 'changed', () => this.scheduleReserve());
  }

  add(options: BlockDecorationOptions): BlockDecorationHandle {
    const lineIter = unwrap(this.buffer.getIterAtLine(options.line));
    const block: Block = {
      mark: this.buffer.createMark(null, lineIter, true),
      tag: null,
      slot: null,
      widget: null,
      build: options.build,
      dispose: options.dispose,
      widgetDispose: undefined,
      placement: options.placement ?? 'below',
      sticky: options.sticky ?? false,
      fullWidth: options.fullWidth ?? null,
      height: Math.max(1, options.height ?? DEFAULT_HEIGHT),
      reservedLine: options.line,
      reserved: false,
      materialized: false,
      lastX: NaN,
      lastY: NaN,
      lastWidth: NaN,
      orderLine: options.line,
      slotGeneration: this.nonStickyGeneration,
    };
    this.blocks.add(block);
    this.orderDirty = true;
    this.reserve(block);
    this.scheduleViewportSync();

    return {
      line: () => this.markLine(block),
      widget: () => block.widget,
      remove: () => this.removeBlock(block),
      invalidate: () => { if (block.materialized) this.place(block); },
      update: (opts) => this.updateBlock(block, opts),
    };
  }

  repositionAll(): void {
    this.scheduleReposition();
  }

  /** Coalesce a declarative reconciliation's reservation removals into one layout mutation per tag. */
  transact(action: () => void): void {
    this.transactionDepth++;
    try {
      action();
    } finally {
      if (--this.transactionDepth === 0) this.scheduleReservationFlush();
    }
  }

  placementAtLine(line: number): BlockDecorationPlacement | null {
    this.ensureOrdered();
    const start = this.lowerBound(line);
    for (let i = start; i < this.orderedBlocks.length; i++) {
      const block = this.orderedBlocks[i];
      const blockLine = this.markLine(block);
      if (blockLine !== line) break;
      return block.placement;
    }
    return null;
  }

  stickyTopInset(): number {
    const scrollTop = Math.round(this.scrollTop());
    let inset = 0;
    for (const block of this.materialized) {
      if (!block.sticky) continue;
      const bandTop = this.bandTop(block, this.lineRect(this.markLine(block)));
      if (bandTop <= scrollTop) inset = Math.max(inset, block.height);
    }
    return inset;
  }

  dispose(): void {
    this.subs.dispose();
    this.cancelTick('viewportTickId');
    this.cancelTick('reservationTickId');
    this.cancelTick('reserveTickId');
    this.cancelTick('repositionTickId');
    this.transact(() => {
      for (const block of [...this.blocks]) this.removeBlock(block);
    });
    this.cancelTick('reservationTickId');
    this.pendingReservationAdds.clear();
    this.pendingReservationRemovals.clear();
    for (const tag of this.reservationTags.values()) this.buffer.getTagTable().remove(tag);
    this.reservationTags.clear();
  }

  private hookVadjustment(): void {
    if (this.vadjHooked) return;
    const vadj = this.view.getVadjustment?.();
    if (!vadj) return;
    this.vadjHooked = true;
    this.subs.connect(vadj, 'changed', () => {
      if (this.updatingReservations) return;
      this.scheduleViewportSync();
      this.scheduleReposition();
    });
    this.subs.connect(vadj, 'value-changed', () => {
      if (this.updatingReservations) return;
      this.syncViewport();
      for (const block of this.materialized) if (block.sticky) this.reposition(block);
    });
    const hadj = this.view.getHadjustment?.();
    if (!hadj) return;
    this.subs.connect(hadj, 'value-changed', () => {
      for (const block of this.materialized) if (block.sticky) this.reposition(block);
    });
    this.subs.connect(hadj, 'changed', () => {
      for (const block of this.materialized) {
        if (block.sticky || block.fullWidth === 'content') this.reposition(block);
      }
    });
  }

  private updateBlock(
    block: Block,
    opts: { line?: number; build?: () => InstanceType<typeof Gtk.Widget>; dispose?: () => void; height?: number },
  ): void {
    if (!this.blocks.has(block)) return;
    let geometryChanged = false;
    if (opts.line != null && opts.line !== this.markLine(block)) {
      this.removeReservation(block);
      this.buffer.deleteMark(block.mark);
      block.mark = this.buffer.createMark(null, unwrap(this.buffer.getIterAtLine(opts.line)), true);
      block.orderLine = opts.line;
      this.orderDirty = true;
      geometryChanged = true;
    }
    if (opts.height != null && Math.max(1, opts.height) !== block.height) {
      block.height = Math.max(1, opts.height);
      geometryChanged = true;
    }
    if (geometryChanged) this.reserve(block);

    if (opts.build) {
      block.build = opts.build;
      block.dispose = opts.dispose;
      if (block.materialized) this.replaceWidget(block);
    }
    if (block.materialized && geometryChanged) this.place(block);
    this.scheduleViewportSync();
  }

  private replaceWidget(block: Block): void {
    this.dropWidget(block);
    const widget = block.build();
    block.widget = widget;
    block.widgetDispose = block.dispose;
    block.slot.append(widget);
    this.place(block);
  }

  private reserve(block: Block): void {
    const line = this.markLine(block);
    const tag = this.reservationTag(block.placement, block.height);
    if (block.reserved && (block.tag !== tag || block.reservedLine !== line)) this.removeReservation(block);
    block.tag = tag;
    if (block.reserved) return;
    block.reservedLine = line;
    this.pendingReservationAdds.add(block);
    this.scheduleReservationFlush();
  }

  private removeReservation(block: Block): void {
    this.pendingReservationAdds.delete(block);
    if (!block.reserved || !block.tag) return;
    const current = this.markLine(block);
    this.queueReservationRemoval(block.tag, block.reservedLine);
    if (current !== block.reservedLine) this.queueReservationRemoval(block.tag, current);
    block.reserved = false;
    this.scheduleReservationFlush();
  }

  private queueReservationRemoval(tag: any, line: number): void {
    let lines = this.pendingReservationRemovals.get(tag);
    if (!lines) this.pendingReservationRemovals.set(tag, lines = new Set());
    lines.add(line);
  }

  private scheduleReservationFlush(): void {
    if (this.transactionDepth || this.reservationTickId || !this.view.getMapped?.()) return;
    this.reservationTickId = this.view.addTickCallback(() => {
      this.reservationTickId = 0;
      this.flushReservationChanges();
      return false;
    });
  }

  private flushReservationChanges(): void {
    this.updatingReservations = true;
    try {
      for (const [tag, lines] of this.pendingReservationRemovals) {
        const active = [...this.blocks].filter((block) => block.reserved && block.tag === tag);
        if (lines.size > active.length) {
          this.buffer.removeTag(tag, this.buffer.getStartIter(), this.buffer.getEndIter());
          for (const block of active) {
            const [start, end] = this.lineRange(this.markLine(block));
            this.buffer.applyTag(tag, start, end);
          }
        } else {
          for (const line of lines) {
            if (line < 0 || line >= this.buffer.getLineCount()) continue;
            const [start, end] = this.lineRange(line);
            this.buffer.removeTag(tag, start, end);
          }
          for (const block of active) {
            if (!lines.has(this.markLine(block))) continue;
            const [start, end] = this.lineRange(this.markLine(block));
            this.buffer.applyTag(tag, start, end);
          }
        }
      }
      this.pendingReservationRemovals.clear();
      for (const block of [...this.pendingReservationAdds]) {
        if (!this.blocks.has(block) || block.reserved || !block.tag) continue;
        const line = this.markLine(block);
        const [start, end] = this.lineRange(line);
        this.buffer.applyTag(block.tag, start, end);
        block.reservedLine = line;
        block.reserved = true;
      }
      this.pendingReservationAdds.clear();
    } finally {
      this.updatingReservations = false;
      this.scheduleViewportSync();
      this.scheduleReposition();
    }
  }

  private reservationTag(placement: BlockDecorationPlacement, height: number): any {
    const reservedHeight = placement === 'on' ? Math.max(1, height - DEFAULT_LINE_HEIGHT) : height;
    const key = `${placement}:${reservedHeight}`;
    const existing = this.reservationTags.get(key);
    if (existing) return existing;
    const tag = new Gtk.TextTag({ name: `inline-block:${this.nextTagId++}` });
    if (placement === 'above') tag.pixelsAboveLines = reservedHeight;
    else tag.pixelsBelowLines = reservedHeight;
    this.buffer.getTagTable().add(tag);
    this.reservationTags.set(key, tag);
    return tag;
  }

  private lineRange(line: number): [any, any] {
    const start = unwrap(this.buffer.getIterAtLine(line));
    const end = line + 1 < this.buffer.getLineCount()
      ? unwrap(this.buffer.getIterAtLine(line + 1))
      : this.buffer.getEndIter();
    return [start, end];
  }

  private scheduleReserve(): void {
    if (this.reserveTickId || this.blocks.size === 0 || !this.view.getMapped?.()) return;
    this.reserveTickId = this.view.addTickCallback(() => {
      this.reserveTickId = 0;
      for (const block of this.materialized) {
        this.removeReservation(block);
        this.reserve(block);
        this.place(block);
      }
      this.syncViewport();
      this.scheduleReposition();
      return false;
    });
  }

  private scheduleViewportSync(): void {
    if (this.viewportTickId || !this.view.getMapped?.()) return;
    this.viewportTickId = this.view.addTickCallback(() => {
      this.viewportTickId = 0;
      this.syncViewport();
      return false;
    });
  }

  private syncViewport(): void {
    if (this.syncingViewport || !this.view.getRealized?.() || this.blocks.size === 0) return;
    const rect = this.view.getVisibleRect();
    const allocatedHeight = this.view.getHeight?.() ?? 0;
    if (!rect?.height || allocatedHeight <= 1 || rect.height > allocatedHeight * 2) {
      this.scheduleViewportSync();
      return;
    }
    this.syncingViewport = true;
    try {
      this.ensureOrdered();
      const visibleTop = this.lineAtY(rect.y);
      const margin = rect.height * VIEWPORT_OVERSCAN;
      const from = this.lineAtY(Math.max(0, rect.y - margin));
      const to = this.lineAtY(rect.y + rect.height + margin);
      const maximumPlausibleRows = Math.ceil(((rect.height + margin * 2) / DEFAULT_LINE_HEIGHT) * 4);
      if (to - from > maximumPlausibleRows) {
        this.scheduleViewportSync();
        return;
      }
      const wanted = new Set<Block>();
      const start = this.lowerBound(from);
      const end = this.upperBound(to);
      for (let i = start; i < end; i++) wanted.add(this.orderedBlocks[i]);
      for (let i = this.upperBound(visibleTop) - 1; i >= 0; i--) {
        const block = this.orderedBlocks[i];
        if (block.sticky) { wanted.add(block); break; }
      }

      for (const block of [...this.materialized]) if (!wanted.has(block)) this.dematerialize(block);
      const entering = [...wanted].filter((block) => !block.materialized);
      for (const block of entering) if (!block.sticky) this.materialize(block);
      for (const block of entering) if (block.sticky) this.materialize(block);
      this.scheduleReposition();
    } finally {
      this.syncingViewport = false;
    }
  }

  private ensureOrdered(): void {
    if (!this.orderDirty) return;
    this.orderedBlocks = [...this.blocks];
    for (const block of this.orderedBlocks) block.orderLine = this.markLine(block);
    this.orderedBlocks.sort((a, b) => a.orderLine - b.orderLine);
    this.orderDirty = false;
  }

  private lowerBound(line: number): number {
    let low = 0;
    let high = this.orderedBlocks.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.markLine(this.orderedBlocks[mid]) < line) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private upperBound(line: number): number {
    let low = 0;
    let high = this.orderedBlocks.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.markLine(this.orderedBlocks[mid]) <= line) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private lineAtY(y: number): number {
    const result = this.view.getLineAtY(Math.round(y));
    return (Array.isArray(result) ? result[0] : result).getLine();
  }

  private materialize(block: Block): void {
    if (block.materialized) return;
    const widget = block.build();
    block.widget = widget;
    block.widgetDispose = block.dispose;
    let appended = false;
    if (!block.slot) {
      block.slot = block.sticky
        ? this.freeStickySlots.pop() ?? new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
        : this.freeSlots.pop() ?? new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
      block.slotGeneration = this.slotGenerations.get(block.slot) ?? 0;
    }
    block.slot.setSizeRequest(-1, -1);
    block.slot.append(widget);
    block.slot.setVisible(true);
    if (!block.slot.getParent?.()) {
      this.view.addOverlay(block.slot, 0, this.lineRect(this.markLine(block)).y);
      appended = true;
    }
    block.materialized = true;
    this.materialized.add(block);

    if (appended && !block.sticky) {
      this.nonStickyGeneration++;
      this.restackStickies();
    } else if (block.sticky && block.slotGeneration < this.nonStickyGeneration) {
      this.reslot(block);
    }
    block.slotGeneration = this.nonStickyGeneration;
    this.slotGenerations.set(block.slot, this.nonStickyGeneration);
    this.place(block);
  }

  private dematerialize(block: Block): void {
    if (!block.materialized) return;
    this.dropWidget(block);
    block.materialized = false;
    this.materialized.delete(block);
    block.slot.setVisible(false);
    block.lastX = NaN;
    block.lastY = NaN;
    block.lastWidth = NaN;
    if (block.sticky) this.freeStickySlots.push(block.slot);
    else this.freeSlots.push(block.slot);
    block.slot = null;
  }

  private dropWidget(block: Block): void {
    block.widgetDispose?.();
    block.widgetDispose = undefined;
    if (block.widget?.getParent?.() === block.slot) block.slot.remove(block.widget);
    block.widget = null;
  }

  private place(block: Block): void {
    if (!block.materialized) return;
    const rect = this.lineRect(this.markLine(block));
    if (rect.height === 0) {
      this.scheduleViewportSync();
      return;
    }
    const measured = Math.max(1, block.slot.measure(Gtk.Orientation.VERTICAL, -1)[1]);
    if (measured !== block.height) {
      block.height = measured;
      this.reserve(block);
      this.view.queueResize?.();
    }
    this.reposition(block);
  }

  private restackStickies(): void {
    for (const block of this.materialized) if (block.sticky) this.reslot(block);
  }

  private reslot(block: Block): void {
    const fresh = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    if (block.widget?.getParent?.() === block.slot) block.slot.remove(block.widget);
    fresh.append(block.widget);
    fresh.setVisible(true);
    const old = block.slot;
    block.slot = fresh;
    block.lastX = NaN;
    block.lastY = NaN;
    block.lastWidth = NaN;
    this.view.addOverlay(fresh, 0, this.lineRect(this.markLine(block)).y);
    old.setVisible(false);
    this.freeSlots.push(old);
    block.slotGeneration = this.nonStickyGeneration;
    this.slotGenerations.set(fresh, this.nonStickyGeneration);
  }

  private scheduleReposition(): void {
    this.repositionStableFrames = 0;
    if (this.repositionTickId || this.materialized.size === 0 || !this.view.getMapped?.()) return;
    this.repositionTotalFrames = 0;
    this.repositionTickId = this.view.addTickCallback(() => {
      let moved = false;
      for (const block of this.materialized) if (this.reposition(block)) moved = true;
      this.repositionStableFrames = moved ? 0 : this.repositionStableFrames + 1;
      if (this.repositionStableFrames >= REPOSITION_FRAMES || ++this.repositionTotalFrames >= REPOSITION_MAX_FRAMES) {
        this.repositionTickId = 0;
        return false;
      }
      return true;
    });
  }

  private reposition(block: Block): boolean {
    const rect = this.lineRect(this.markLine(block));
    if (rect.height === 0 || !block.slot) return false;
    let y = this.bandTop(block, rect);
    if (!block.sticky) {
      if (block.fullWidth) this.fitWidth(block, block.fullWidth);
      if (y === block.lastY) return false;
      block.lastY = y;
      this.view.moveOverlay(block.slot, 0, y);
      return true;
    }
    y = Math.max(y, Math.round(this.scrollTop()));
    const nextTop = this.nextStickyBandTop(block);
    if (nextTop != null) y = Math.min(y, nextTop - block.height);
    const hadj = this.view.getHadjustment?.();
    const x = hadj ? Math.round(hadj.getValue()) : 0;
    this.fitWidth(block, 'viewport');
    if (x === block.lastX && y === block.lastY) return false;
    block.lastX = x;
    block.lastY = y;
    this.view.moveOverlay(block.slot, x, y);
    return true;
  }

  private nextStickyBandTop(block: Block): number | null {
    this.ensureOrdered();
    const line = this.markLine(block);
    for (let i = this.upperBound(line); i < this.orderedBlocks.length; i++) {
      const next = this.orderedBlocks[i];
      if (next.sticky && next.materialized) {
        return this.bandTop(next, this.lineRect(this.markLine(next)));
      }
    }
    return null;
  }

  private fitWidth(block: Block, mode: BlockWidth): void {
    const hadj = this.view.getHadjustment?.();
    if (!hadj) return;
    const width = Math.round(mode === 'content' ? hadj.getUpper() : hadj.getPageSize());
    if (width > 0 && width !== block.lastWidth) {
      block.slot.setSizeRequest(width, -1);
      block.lastWidth = width;
    }
  }

  private bandTop(block: Block, rect: { y: number; height: number }): number {
    if (block.placement === 'below') return rect.y + rect.height;
    if (block.placement === 'on') return rect.y;
    return rect.y - block.height;
  }

  private scrollTop(): number {
    return this.view.getVadjustment?.()?.getValue() ?? 0;
  }

  private markLine(block: Block): number {
    return unwrap(this.buffer.getIterAtMark(block.mark)).getLine();
  }

  private lineRect(line: number): { y: number; height: number } {
    const loc = this.view.getIterLocation(unwrap(this.buffer.getIterAtLine(line)));
    const rect = Array.isArray(loc) ? loc[0] ?? loc[1] : loc;
    return { y: rect?.y ?? 0, height: rect?.height ?? 0 };
  }

  private removeBlock(block: Block): void {
    if (!this.blocks.delete(block)) return;
    this.pendingReservationAdds.delete(block);
    if (block.materialized) this.dematerialize(block);
    this.removeReservation(block);
    this.buffer.deleteMark(block.mark);
    block.slot?.setVisible(false);
    this.materialized.delete(block);
    this.orderDirty = true;
    this.scheduleViewportSync();
  }

  private cancelTick(field: 'viewportTickId' | 'reservationTickId' | 'reserveTickId' | 'repositionTickId'): void {
    const id = this[field];
    if (!id) return;
    this.view.removeTickCallback(id);
    this[field] = 0;
  }
}
