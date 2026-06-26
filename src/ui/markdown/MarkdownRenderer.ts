/*
 * MarkdownRenderer — a Gtk.Widget subclass that renders a full markdown document
 * by drawing directly into the GSK render-node scene graph (no child widgets, no
 * Cairo draw func). See docs/ui/markdown-renderer.md.
 *
 * Why a raw widget: the prior MarkdownView stitched a document from many
 * Gtk.Labels, so selection couldn't cross a label boundary (heading → code →
 * table). Here the WHOLE document is one widget, so selection, copy, and link
 * hit-testing span every block uniformly.
 *
 * Pipeline:
 *   markdown ──buildBlocks──▶ flat MdBlock[] (model)
 *           ──relayout(w)──▶ positioned Pango layouts + fills/rules (geometry)
 *           ──snapshot()───▶ Gsk nodes: appendColor (fills/rules/selection) +
 *                            appendLayout (text)
 *
 * Layout is height-for-width: getRequestMode = HEIGHT_FOR_WIDTH, measure() lays
 * the document out at the proposed width and returns the resulting height, and we
 * re-lay-out lazily whenever the allocated width changes.
 *
 * node-gtk specifics:
 *   - The vfunc overrides are named so snake_case(name) hits the GtkWidget vfunc:
 *     `snapshot`→snapshot, `measure`→measure, `getRequestMode`→get_request_mode.
 *     `measure` returns the [min, nat, minBaseline, natBaseline] tuple node-gtk
 *     marshals into the vfunc's four out-params.
 *   - State is initialised in a normal constructor (node-gtk subclass constructors
 *     work fine — verified; see node-gtk#457). registerClass must run ONCE before
 *     the first `new` — instantiating an unregistered subclass aborts the process —
 *     so the `createMarkdownRenderer()` factory registers on first use; call it
 *     after GTK init.
 *   - Teardown is `teardown()`, NOT `dispose()`: `dispose` snake-cases onto the
 *     GObject::dispose vfunc and we must not shadow it. See docs/lifecycle-and-disposal.md.
 *
 * Input uses Gtk.GestureClick + EventControllerMotion + EventControllerKey, each
 * attached through the CompositeDisposable per the lifecycle rules.
 */
import { Gtk, Gdk, Gsk, Graphene, Pango, Gio } from '../../gi.ts';
import { registerClass } from '../../gi.ts';
import { CompositeDisposable } from '../../util/eventKit.ts';
import { theme } from '../../theme/theme.ts';
import { fonts } from '../../fonts.ts';
import { escapeMarkup } from '../proseMarkup.ts';
import { clipboard } from '../TextEditor/vim/clipboard.ts';
import { highlightToMarkup } from '../../syntax/highlightToMarkup.ts';
import { buildBlocks, monoSizeAttr, type MdBlock, type LinkSpan } from './markdownModel.ts';
import { addStyles } from '../../styles.ts';

// The document renders in the inherited UI font (the .AppWindow baseline) bumped to
// the LARGE size (fonts.ts → `--t-font-ui-size-large`), so long-form markdown reads
// comfortably. createPangoLayout() picks the size up from the widget's CSS node, and
// headings / code spans scale relative to it.
addStyles(/* css */ `
  .MarkdownRenderer {
    font-size: 1.1em;
  }
`);

type Snapshot = InstanceType<typeof Gtk.Snapshot>;
type Layout = InstanceType<typeof Pango.Layout>;
type RGBA = InstanceType<typeof Gdk.RGBA>;

// Layout metrics (px).
const LEFT_PAD = 4;
const RIGHT_PAD = 4;
const TOP_PAD = 4;
const BOTTOM_PAD = 6;
const INDENT_PX = 22; // per list-nesting level
const QUOTE_PX = 14; // per blockquote-nesting level (bar→text indent)
const QUOTE_BAR_W = 3;
const CODE_PAD = 10;
const QUOTE_PAD = CODE_PAD; // blockquote inner top/bottom padding (matches code blocks)
const QUOTE_MARGIN_TOP = 6; // outer margin above a blockquote (matches code marginTop)
const QUOTE_MARGIN_BOTTOM = 8; // outer margin below a blockquote (matches code marginBottom)
const CELL_PAD_X = 8;
const CELL_PAD_Y = 4;
const HR_H = 2;
const BLOCK_RADIUS = 6; // rounded-corner radius for code + blockquote backgrounds
const MAX_COL = 320; // cap on a table column's natural width
const MIN_WIDTH = 120;
const MAX_NATURAL = 820;

/** A caret: a byte offset into a segment's text, addressed by document segment index. */
interface Caret {
  seg: number;
  byte: number;
}

/** A positioned, selectable text run (one Pango layout drawn at x,y). */
interface Seg {
  layout: Layout;
  plain: string;
  links: LinkSpan[];
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A solid fill (block background / table header) drawn behind text. */
interface Fill {
  x: number;
  y: number;
  w: number;
  h: number;
  color: RGBA;
  radius: number;
}

export class MarkdownRenderer extends Gtk.Widget {
  private disposables: CompositeDisposable;
  private blocks: MdBlock[];
  private segs: Seg[];
  private fills: Fill[];
  private rules: Fill[]; // thin lines (hr, borders, quote bars); radius 0
  private layoutWidth: number;
  private totalHeight: number;
  private naturalCache: number;

  private selAnchor: Caret | null;
  private selHead: Caret | null;
  private dragMoved: boolean;
  private dragStartX: number;
  private dragStartY: number;

  private cForeground: RGBA;
  private cSelection: RGBA;
  private cBorder: RGBA;
  private cQuoteBar: RGBA;
  private cQuoteBg: RGBA;
  private cHeaderBg: RGBA;

  constructor() {
    super();
    this.disposables = new CompositeDisposable();
    this.blocks = [];
    this.segs = [];
    this.fills = [];
    this.rules = [];
    this.layoutWidth = -1;
    this.totalHeight = 0;
    this.naturalCache = -1;
    this.selAnchor = null;
    this.selHead = null;
    this.dragMoved = false;
    this.dragStartX = 0;
    this.dragStartY = 0;

    this.cForeground = rgba(theme.ui.editor.foreground);
    this.cSelection = rgba(theme.ui.surface.selected);
    this.cBorder = rgba(theme.ui.border);
    this.cQuoteBar = rgba(theme.ui.text.muted);
    // Blockquote fill: the view foreground at low opacity, like a faint callout tint.
    this.cQuoteBg = rgba(theme.ui.view.fg);
    this.cQuoteBg.alpha = 0.15;
    this.cHeaderBg = rgba(theme.ui.surface.selected);

    this.addCssClass('MarkdownRenderer');
    this.setFocusable(true);
    this.setCursorFromName('text');

    this.installInput();
  }

  /** Replace the rendered document. */
  setMarkdown(md: string): void {
    this.blocks = buildBlocks(md, safeHighlight);
    this.layoutWidth = -1;
    this.naturalCache = -1;
    this.selAnchor = null;
    this.selHead = null;
    this.queueResize();
    this.queueDraw();
  }

  teardown(): void {
    this.disposables.dispose();
  }

  // --- GtkWidget vfuncs ------------------------------------------------------

  getRequestMode() {
    return Gtk.SizeRequestMode.HEIGHT_FOR_WIDTH;
  }

  // `orientation` is a Gtk.Orientation; typed as number since GTK enums aren't
  // referenceable as types through the node-gtk value import (method params are
  // bivariant, so this still satisfies the vfunc override).
  measure(orientation: number, forSize: number): [number, number, number, number] {
    if (orientation === Gtk.Orientation.HORIZONTAL) {
      return [MIN_WIDTH, this.naturalWidth(), -1, -1];
    }
    const width = forSize > 0 ? forSize : this.naturalWidth();
    if (width !== this.layoutWidth) this.relayout(width);
    return [this.totalHeight, this.totalHeight, -1, -1];
  }

  snapshot(snapshot: Snapshot): void {
    const width = this.getWidth();
    if (width <= 0) return;
    if (width !== this.layoutWidth) this.relayout(width);

    for (const f of this.fills) appendFill(snapshot, f);
    for (const r of this.rules) snapshot.appendColor(r.color, rect(r.x, r.y, r.w, r.h));

    const norm = this.normSelection();
    if (norm) this.snapshotSelection(snapshot, norm.lo, norm.hi);

    for (const s of this.segs) {
      snapshot.save();
      snapshot.translate(point(s.x, s.y));
      snapshot.appendLayout(s.layout, this.cForeground);
      snapshot.restore();
    }
  }

  // --- layout ----------------------------------------------------------------

  private naturalWidth(): number {
    if (this.naturalCache >= 0) return this.naturalCache;
    let max = MIN_WIDTH;
    for (const b of this.blocks) {
      const indent = LEFT_PAD + RIGHT_PAD + b.indent * INDENT_PX + b.quotes.length * QUOTE_PX;
      if (b.kind === 'line') {
        const l = this.createPangoLayout(null);
        setLayoutMarkup(l, lineMarkup(b), b.plain);
        l.setWidth(-1);
        const [w] = l.getPixelSize();
        max = Math.max(max, w + indent + (b.background ? CODE_PAD * 2 : 0));
      } else if (b.kind === 'table') {
        max = MAX_NATURAL; // tables prefer the full column
      }
    }
    this.naturalCache = Math.min(max, MAX_NATURAL);
    return this.naturalCache;
  }

  private relayout(width: number): void {
    this.layoutWidth = width;
    this.segs = [];
    this.fills = [];
    this.rules = [];
    let y = TOP_PAD;

    // Each blockquote is one visual box: a single continuous bar spanning all its
    // blocks (incl. the gaps between them), with code-block padding inside and
    // margin outside. `groups` gives every quote's [first,last] block range so we
    // open its box at its first block and close it (drawing the bar) at its last.
    const groups = quoteGroups(this.blocks);
    const barTop = new Map<number, number>();
    const barX = new Map<number, number>();
    // The quote's rounded background, pushed at OPEN (so it sits behind any inner
    // content fills, e.g. a code block inside the quote) and given its height at CLOSE.
    const quoteBg = new Map<number, Fill>();

    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i];
      const opening = block.quotes.filter((id) => groups.get(id)!.first === i); // outer→inner
      const closing = block.quotes.filter((id) => groups.get(id)!.last === i); // outer→inner

      // Open every blockquote that starts at this block: outer margin, then top padding.
      for (const id of opening) {
        y += QUOTE_MARGIN_TOP;
        const bx = LEFT_PAD + block.indent * INDENT_PX + groups.get(id)!.depth * QUOTE_PX;
        barX.set(id, bx);
        barTop.set(id, y);
        const fill: Fill = { x: bx, y, w: Math.max(0, width - bx - RIGHT_PAD), h: 0, color: this.cQuoteBg, radius: BLOCK_RADIUS };
        this.fills.push(fill); // height filled in at close
        quoteBg.set(id, fill);
        y += QUOTE_PAD;
      }

      const indentPx = LEFT_PAD + block.indent * INDENT_PX + block.quotes.length * QUOTE_PX;
      // The quote's own padding replaces the first/last inner block's outer margin.
      if (opening.length === 0) y += block.marginTop;

      if (block.kind === 'hr') {
        this.rules.push({ x: indentPx, y: y + 3, w: Math.max(0, width - indentPx - RIGHT_PAD), h: HR_H, color: this.cBorder, radius: 0 });
        y += HR_H + 6;
      } else if (block.kind === 'table') {
        y = this.layoutTable(block, indentPx, y, width);
      } else {
        const pad = block.background ? CODE_PAD : 0;
        const contentW = Math.max(1, width - indentPx - RIGHT_PAD - pad * 2);
        const layout = this.createPangoLayout(null);
        layout.setWrap(Pango.WrapMode.WORD_CHAR);
        layout.setWidth(contentW * Pango.SCALE);
        setLayoutMarkup(layout, lineMarkup(block), block.plain);
        const [, h] = layout.getPixelSize();
        if (block.background)
          this.fills.push({ x: indentPx, y, w: Math.max(0, width - indentPx - RIGHT_PAD), h: h + pad * 2, color: rgba(block.background), radius: BLOCK_RADIUS });
        this.segs.push({ layout, plain: block.plain, links: block.links, x: indentPx + pad, y: y + pad, w: contentW, h });
        y += h + pad * 2;
      }

      if (closing.length === 0) y += block.marginBottom;

      // Close every blockquote ending here (inner→outer): bottom padding, finalize the
      // background height, draw the ONE continuous bar (inset to clear the rounded
      // corners), then the outer margin.
      for (const id of closing.reverse()) {
        y += QUOTE_PAD;
        const top = barTop.get(id)!;
        const boxH = y - top;
        quoteBg.get(id)!.h = boxH;
        this.rules.push({ x: barX.get(id)!, y: top + BLOCK_RADIUS, w: QUOTE_BAR_W, h: Math.max(1, boxH - 2 * BLOCK_RADIUS), color: this.cQuoteBar, radius: 0 });
        y += QUOTE_MARGIN_BOTTOM;
      }
    }

    this.totalHeight = y + BOTTOM_PAD;
  }

  private layoutTable(block: Extract<MdBlock, { kind: 'table' }>, x0: number, y0: number, width: number): number {
    const ncol = block.aligns.length;
    if (ncol === 0) return y0;
    const allRows = [block.header, ...block.rows];
    const avail = Math.max(60, width - x0 - RIGHT_PAD);

    // Natural column widths (unwrapped, capped), scaled down to fit the available width.
    const natural = new Array<number>(ncol).fill(0);
    for (let c = 0; c < ncol; c++)
      for (const row of allRows) {
        const seg = row[c];
        if (!seg) continue;
        const l = this.cellLayout(seg, row === block.header);
        l.setWidth(-1);
        natural[c] = Math.max(natural[c], Math.min(l.getPixelSize()[0], MAX_COL));
      }
    const naturalSum = natural.reduce((a, b) => a + b, 0);
    const innerAvail = avail - ncol * CELL_PAD_X * 2;
    let colW = natural;
    if (naturalSum > innerAvail && naturalSum > 0) {
      const scale = innerAvail / naturalSum;
      colW = natural.map((w) => Math.max(24, Math.floor(w * scale)));
    }
    const tableW = colW.reduce((a, b) => a + b, 0) + ncol * CELL_PAD_X * 2;

    const rowYs: number[] = [];
    let y = y0;
    for (const row of allRows) {
      rowYs.push(y);
      const isHeader = row === block.header;
      const layouts = colW.map((w, c) => {
        const seg = row[c] ?? { markup: '', plain: '', links: [] };
        const l = this.cellLayout(seg, isHeader);
        l.setWidth(Math.max(1, w) * Pango.SCALE);
        l.setAlignment(alignOf(block.aligns[c]));
        return l;
      });
      const rowH = Math.max(1, ...layouts.map((l) => l.getPixelSize()[1]));
      if (isHeader) this.fills.push({ x: x0, y, w: tableW, h: rowH + CELL_PAD_Y * 2, color: this.cHeaderBg, radius: 0 });
      let cx = x0;
      for (let c = 0; c < ncol; c++) {
        const seg = row[c];
        this.segs.push({ layout: layouts[c], plain: seg?.plain ?? '', links: seg?.links ?? [], x: cx + CELL_PAD_X, y: y + CELL_PAD_Y, w: colW[c], h: rowH });
        cx += colW[c] + CELL_PAD_X * 2;
      }
      y += rowH + CELL_PAD_Y * 2;
    }
    const tableH = y - y0;

    // Grid lines: a horizontal rule above each row + the bottom, and a vertical rule
    // at each column boundary + both edges.
    for (let r = 0; r <= allRows.length; r++)
      this.rules.push({ x: x0, y: r < allRows.length ? rowYs[r] : y, w: tableW, h: 1, color: this.cBorder, radius: 0 });
    let vx = x0;
    this.rules.push({ x: vx, y: y0, w: 1, h: tableH, color: this.cBorder, radius: 0 });
    for (let c = 0; c < ncol; c++) {
      vx += colW[c] + CELL_PAD_X * 2;
      this.rules.push({ x: vx, y: y0, w: 1, h: tableH, color: this.cBorder, radius: 0 });
    }
    return y;
  }

  private cellLayout(seg: { markup: string; plain: string }, bold: boolean): Layout {
    const l = this.createPangoLayout(null);
    l.setWrap(Pango.WrapMode.WORD_CHAR);
    setLayoutMarkup(l, bold ? `<span weight="bold">${seg.markup}</span>` : seg.markup, seg.plain);
    return l;
  }

  // --- selection geometry ----------------------------------------------------

  private snapshotSelection(snapshot: Snapshot, lo: Caret, hi: Caret): void {
    for (let i = lo.seg; i <= hi.seg && i < this.segs.length; i++) {
      const s = this.segs[i];
      const total = byteLen(s.plain);
      const start = i === lo.seg ? lo.byte : 0;
      const end = i === hi.seg ? hi.byte : total;
      if (start >= end) continue;
      this.snapshotSegSelection(snapshot, s, start, end);
    }
  }

  // Draw one highlight rect per visual line of the [start,end) byte range.
  //
  // We deliberately DON'T use pango_layout_line_get_x_ranges: node-gtk mis-marshals
  // its caller-allocated `int**`/`n_ranges` out-param and returns only a single
  // value, so the [start,end] pairs never arrive and nothing gets highlighted. We
  // reconstruct each line's selection span from `index_to_pos` (per-glyph rect,
  // marshals fine) and the line's logical extents for the run-to-line-end case.
  // This is exact for LTR; bidi/RTL lines collapse to one bounding rect (good enough).
  private snapshotSegSelection(snapshot: Snapshot, s: Seg, start: number, end: number): void {
    const layout = s.layout;
    const iter = layout.getIter();
    do {
      const line = iter.getLine();
      if (!line) continue;
      const lineStart = line.startIndex;
      const lineEnd = lineStart + line.length;
      if (end <= lineStart || start >= lineEnd) continue;
      const selS = Math.max(start, lineStart);
      const [y0, y1] = iter.getLineYrange();
      const leftX = layout.indexToPos(selS).x;
      let rightX: number;
      if (end >= lineEnd) {
        // Selection runs to/through the line end → extend to the line's right text
        // edge. line.getExtents() gives the text WIDTH but its x drops the alignment
        // offset (unlike index_to_pos), so we add that offset back via the line's
        // first-glyph x — otherwise center/right-aligned table cells are mispositioned.
        const lineOffsetX = layout.indexToPos(lineStart).x;
        rightX = lineOffsetX + line.getExtents()[1].width;
      } else {
        rightX = layout.indexToPos(end).x;
      }
      const rx = s.x + Math.min(leftX, rightX) / Pango.SCALE;
      const rw = Math.abs(rightX - leftX) / Pango.SCALE;
      const ry = s.y + y0 / Pango.SCALE;
      const rh = (y1 - y0) / Pango.SCALE;
      snapshot.appendColor(this.cSelection, rect(rx, ry, Math.max(1, rw), rh));
    } while (iter.nextLine());
  }

  private normSelection(): { lo: Caret; hi: Caret } | null {
    if (!this.selAnchor || !this.selHead) return null;
    const a = this.selAnchor;
    const b = this.selHead;
    if (a.seg === b.seg && a.byte === b.byte) return null;
    return caretCmp(a, b) <= 0 ? { lo: a, hi: b } : { lo: b, hi: a };
  }

  // --- hit testing -----------------------------------------------------------

  private caretAt(px: number, py: number): Caret {
    if (this.segs.length === 0) return { seg: 0, byte: 0 };
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this.segs.length; i++) {
      const s = this.segs[i];
      const dy = py < s.y ? s.y - py : py >= s.y + s.h ? py - (s.y + s.h) : 0;
      const dx = px < s.x ? s.x - px : px > s.x + s.w ? px - (s.x + s.w) : 0;
      const dist = dy * 4096 + dx; // vertical band dominates; x breaks ties within a row
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    const s = this.segs[best];
    const lx = Math.max(0, px - s.x) * Pango.SCALE;
    const ly = Math.max(0, py - s.y) * Pango.SCALE;
    const [, index, trailing] = s.layout.xyToIndex(Math.round(lx), Math.round(ly));
    return { seg: best, byte: trailing > 0 ? advanceByte(s.plain, index) : index };
  }

  private linkAtXY(px: number, py: number): string | null {
    for (const s of this.segs) {
      if (px < s.x || px > s.x + s.w || py < s.y || py > s.y + s.h) continue;
      if (s.links.length === 0) return null;
      const lx = Math.round(Math.max(0, px - s.x) * Pango.SCALE);
      const ly = Math.round(Math.max(0, py - s.y) * Pango.SCALE);
      const [inside, index] = s.layout.xyToIndex(lx, ly);
      if (!inside) return null;
      for (const l of s.links) if (index >= l.start && index < l.end) return l.href;
      return null;
    }
    return null;
  }

  // --- input -----------------------------------------------------------------

  private installInput(): void {
    // Press sets the anchor (and handles double/triple-click word/block select);
    // drag extends the head. Using a dedicated GestureDrag — not motion-gated-on-
    // press — is what makes selection track the pointer smoothly: its 'drag-update'
    // fires on every motion event during the button hold (GtkText/GtkLabel use the
    // same GestureClick + GestureDrag pair). A bare EventControllerMotion only
    // delivers sparse motion under a button grab, so it both stutters and skips
    // positions. Motion is left for hover-cursor only.
    const click = new Gtk.GestureClick();
    click.setButton(Gdk.BUTTON_PRIMARY);
    this.disposables.connect(click, 'pressed', (n: number, x: number, y: number) => this.onPress(n, x, y));
    this.disposables.connect(click, 'released', (n: number, x: number, y: number) => this.onRelease(n, x, y));
    this.disposables.addController(this, click);

    const drag = new Gtk.GestureDrag();
    drag.setButton(Gdk.BUTTON_PRIMARY);
    this.disposables.connect(drag, 'drag-update', (ox: number, oy: number) => this.onDragUpdate(ox, oy));
    this.disposables.addController(this, drag);

    const motion = new Gtk.EventControllerMotion();
    this.disposables.connect(motion, 'motion', (x: number, y: number) => this.onMotion(x, y));
    this.disposables.addController(this, motion);

    const key = new Gtk.EventControllerKey();
    this.disposables.connect(key, 'key-pressed', (keyval: number, _code: number, state: number) => this.onKey(keyval, state));
    this.disposables.addController(this, key);
  }

  private onPress(nPress: number, x: number, y: number): void {
    this.grabFocus();
    this.dragMoved = false;
    this.dragStartX = x;
    this.dragStartY = y;
    const caret = this.caretAt(x, y);
    if (nPress >= 3) this.selectSegment(caret.seg);
    else if (nPress === 2) this.selectWord(caret);
    else {
      this.selAnchor = caret;
      this.selHead = caret;
    }
    this.queueDraw();
  }

  private onDragUpdate(offsetX: number, offsetY: number): void {
    if (Math.abs(offsetX) + Math.abs(offsetY) > 2) this.dragMoved = true;
    this.selHead = this.caretAt(this.dragStartX + offsetX, this.dragStartY + offsetY);
    this.queueDraw();
  }

  private onRelease(nPress: number, x: number, y: number): void {
    if (!this.dragMoved && nPress === 1) {
      const href = this.linkAtXY(x, y);
      if (href) openUri(href);
    }
  }

  private onMotion(x: number, y: number): void {
    this.setCursorFromName(this.linkAtXY(x, y) ? 'pointer' : 'text');
  }

  private onKey(keyval: number, state: number): boolean {
    const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
    if (ctrl && keyval === Gdk.KEY_c) {
      this.copySelection();
      return true;
    }
    if (ctrl && keyval === Gdk.KEY_a) {
      this.selectAll();
      return true;
    }
    if (keyval === Gdk.KEY_Escape) {
      this.selAnchor = null;
      this.selHead = null;
      this.queueDraw();
      return true;
    }
    return false;
  }

  private selectWord(caret: Caret): void {
    const s = this.segs[caret.seg];
    if (!s) return;
    const text = s.plain;
    const js = byteToJs(text, caret.byte);
    const isWord = (ch: string): boolean => /[\p{L}\p{N}_]/u.test(ch);
    let a = js;
    let b = js;
    while (a > 0 && isWord(text[a - 1])) a--;
    while (b < text.length && isWord(text[b])) b++;
    if (a === b) {
      b = Math.min(text.length, js + 1); // not on a word: select one char
    }
    this.selAnchor = { seg: caret.seg, byte: jsToByte(text, a) };
    this.selHead = { seg: caret.seg, byte: jsToByte(text, b) };
  }

  private selectSegment(seg: number): void {
    const s = this.segs[seg];
    if (!s) return;
    this.selAnchor = { seg, byte: 0 };
    this.selHead = { seg, byte: byteLen(s.plain) };
  }

  private selectAll(): void {
    if (this.segs.length === 0) return;
    this.selAnchor = { seg: 0, byte: 0 };
    this.selHead = { seg: this.segs.length - 1, byte: byteLen(this.segs[this.segs.length - 1].plain) };
    this.queueDraw();
  }

  private copySelection(): void {
    const norm = this.normSelection();
    if (!norm) return;
    const parts: string[] = [];
    for (let i = norm.lo.seg; i <= norm.hi.seg && i < this.segs.length; i++) {
      const s = this.segs[i];
      const total = byteLen(s.plain);
      const start = i === norm.lo.seg ? norm.lo.byte : 0;
      const end = i === norm.hi.seg ? norm.hi.byte : total;
      parts.push(sliceBytes(s.plain, start, end));
    }
    clipboard.write(parts.join('\n'));
  }
}

let registered = false;

/** Create a MarkdownRenderer. Registers the GType on first use (instantiating an
 *  unregistered GObject subclass aborts the process), so this MUST be called after
 *  GTK is initialized (inside app activate / after startLoop). */
export function createMarkdownRenderer(): MarkdownRenderer {
  if (!registered) {
    registerClass(MarkdownRenderer);
    registered = true;
  }
  return new MarkdownRenderer();
}

// --- module helpers ----------------------------------------------------------

// Map each blockquote group id → the block range it spans + its nesting depth.
// A quote's blocks are contiguous (its children are emitted consecutively), so
// [first,last] is a run; the renderer opens the box at `first` and draws the bar
// when it closes at `last`.
function quoteGroups(blocks: MdBlock[]): Map<number, { first: number; last: number; depth: number }> {
  const groups = new Map<number, { first: number; last: number; depth: number }>();
  blocks.forEach((b, i) => {
    b.quotes.forEach((id, depth) => {
      const g = groups.get(id);
      if (g) g.last = i;
      else groups.set(id, { first: i, last: i, depth });
    });
  });
  return groups;
}

// Wrap a line block's inline markup with its font/weight/size run.
function lineMarkup(block: Extract<MdBlock, { kind: 'line' }>): string {
  const attrs: string[] = [];
  // Code blocks: the monospace face plus the same rebalancing size as inline code
  // (mono never carries a named heading `size`, so there's no conflicting attr).
  if (block.mono) attrs.push(`face="${attrEscape(fonts.monospaceFamily)}"`, `size="${monoSizeAttr()}"`);
  if (block.bold) attrs.push('weight="bold"');
  if (block.size) attrs.push(`size="${block.size}"`);
  return attrs.length ? `<span ${attrs.join(' ')}>${block.markup}</span>` : block.markup;
}

function setLayoutMarkup(layout: Layout, markup: string, fallback: string): void {
  try {
    layout.setMarkup(markup, -1);
  } catch {
    layout.setText(fallback, -1);
  }
}

function appendFill(snapshot: Snapshot, f: Fill): void {
  const bounds = rect(f.x, f.y, f.w, f.h);
  if (f.radius > 0) {
    const rounded = new Gsk.RoundedRect();
    rounded.initFromRect(bounds, f.radius);
    snapshot.pushRoundedClip(rounded);
    snapshot.appendColor(f.color, bounds);
    snapshot.pop();
  } else {
    snapshot.appendColor(f.color, bounds);
  }
}

function safeHighlight(code: string, lang: string | undefined): string | null {
  if (!lang) return null;
  try {
    return highlightToMarkup(code, lang);
  } catch {
    return null;
  }
}

function openUri(uri: string): void {
  try {
    Gio.AppInfo.launchDefaultForUri(uri, null);
  } catch {
    // best-effort: a malformed or unhandled URI just does nothing
  }
}

function rgba(spec: string): RGBA {
  const c = new Gdk.RGBA();
  if (!c.parse(spec)) c.parse('#000000');
  return c;
}

function rect(x: number, y: number, w: number, h: number): InstanceType<typeof Graphene.Rect> {
  const r = new Graphene.Rect();
  r.init(x, y, w, h);
  return r;
}

function point(x: number, y: number): InstanceType<typeof Graphene.Point> {
  const p = new Graphene.Point();
  p.init(x, y);
  return p;
}

function alignOf(a: 'left' | 'center' | 'right') {
  return a === 'right' ? Pango.Alignment.RIGHT : a === 'center' ? Pango.Alignment.CENTER : Pango.Alignment.LEFT;
}

function caretCmp(a: Caret, b: Caret): number {
  return a.seg - b.seg || a.byte - b.byte;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function byteToJs(s: string, byte: number): number {
  return Buffer.from(s, 'utf8').subarray(0, byte).toString('utf8').length;
}

function jsToByte(s: string, js: number): number {
  return Buffer.byteLength(s.slice(0, js), 'utf8');
}

function sliceBytes(s: string, start: number, end: number): string {
  return Buffer.from(s, 'utf8').subarray(start, end).toString('utf8');
}

// Advance a byte offset past the one codepoint starting at it (for xy_to_index trailing).
function advanceByte(s: string, byte: number): number {
  const js = byteToJs(s, byte);
  if (js >= s.length) return byte;
  const cp = s.codePointAt(js);
  return cp === undefined ? byte : byte + byteLen(String.fromCodePoint(cp));
}

function attrEscape(text: string): string {
  return escapeMarkup(text).replace(/"/g, '&quot;');
}
