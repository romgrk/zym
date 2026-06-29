/*
 * UnderlineOverlay — draws wavy underlines under buffer ranges (LSP diagnostic
 * squiggles) by painting them ourselves, instead of GtkTextTag's fixed, dense
 * `Pango.Underline.ERROR` style.
 *
 * It paints into the view's own snapshot (via EditorSourceView), in buffer
 * coordinates, so squiggles scroll with the text for free instead of repainting a
 * viewport-pinned `DrawingArea` every frame. For each underline it walks the buffer
 * rows the range spans, takes each line segment's buffer pixels via `getIterLocation`,
 * and strokes a low-amplitude sine wave with Cairo — anti-aliased, with full control
 * over color, amplitude, and wavelength.
 *
 * Producers (currently `DiagnosticsView`) push the full set via `setUnderlines`
 * and reset with `clear`. Drawing needs a realized, allocated view, so the visual
 * result needs interactive verification (it can't be exercised headlessly).
 */
import Gdk from 'gi:Gdk-4.0';
import type GtkSource from 'gi:GtkSource-5';
type SourceView = InstanceType<typeof GtkSource.View>;
import { Range } from '../../text/Range.ts';
import { Point } from '../../text/Point.ts';
import { CompositeDisposable, Disposable } from '../../util/eventKit.ts';
import type { EditorModel } from './EditorModel.ts';

export interface Underline {
  /** Buffer range to underline. */
  range: Range;
  /** Stroke color (`#rrggbb`/`#rrggbbaa`). */
  color: string;
}

// Wave shape, in pixels.
const AMPLITUDE = 1.5;
const WAVELENGTH = 6;
const LINE_WIDTH = 1;
const STEP = 1; // sampling interval along x

// getIterAtMark returns the iter (node-gtk may wrap a single out-param in an array).
const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);

export class UnderlineOverlay {
  private readonly view: SourceView;
  private readonly model: EditorModel;
  // Each underline is anchored to a pair of GtkTextMarks (not static coordinates), so
  // its position moves with edits exactly like a GtkTextTag — the squiggle tracks the
  // text live instead of lagging until the next diagnostics push.
  private placed: Array<{ startMark: any; endMark: any; color: string }> = [];
  private readonly colorCache = new Map<string, InstanceType<typeof Gdk.RGBA>>();
  // The buffer 'changed' handler goes here. node-gtk roots the closure in a Global for the
  // GObject's lifetime, and the closure captures `this` (→ view + model) — so a single
  // un-disconnected handler pins the editor forever. `dispose()` cuts it. See TextEditor `subs`.
  private readonly subs = new CompositeDisposable();

  constructor(view: SourceView, model: EditorModel) {
    this.view = view;
    this.model = model;

    // Re-snapshot on edits so squiggles track their lines (the marks have already moved
    // with the edit). The SCROLL repaint is automatic — the view re-runs snapshot_layer
    // as it scrolls — so no adjustment handlers are needed.
    const redraw = () => this.view.queueDraw();
    const buffer = this.model.buffer;
    buffer.on('changed', redraw);
    this.subs.add(new Disposable(() => buffer.off('changed', redraw)));
  }

  /** Detach the buffer handler (so this stops pinning the editor) and drop the anchor
   *  marks. Called by `TextDecorations.dispose()` on editor teardown. */
  dispose(): void {
    this.subs.dispose();
    this.clear(); // delete the GtkTextMarks this overlay left on the buffer
  }

  /** Replace the underline set and repaint, anchoring each range to a mark pair. */
  setUnderlines(underlines: Underline[]): void {
    const buffer = this.model.buffer;
    this.deleteMarks();
    // start mark right-gravity, end mark left-gravity → the pair brackets the range like
    // a GtkTextTag (inserts at the edges fall outside; inserts inside grow it).
    this.placed = underlines.map(({ range, color }) => ({
      startMark: buffer.createMark(null, this.model.iterAtPoint(range.start), false),
      endMark: buffer.createMark(null, this.model.iterAtPoint(range.end), true),
      color,
    }));
    this.view.queueDraw();
  }

  /** Remove all underlines. */
  clear(): void {
    if (this.placed.length === 0) return;
    this.deleteMarks();
    this.placed = [];
    this.view.queueDraw();
  }

  private deleteMarks(): void {
    const buffer = this.model.buffer;
    for (const p of this.placed) {
      buffer.deleteMark(p.startMark);
      buffer.deleteMark(p.endMark);
    }
  }

  /** Paint the squiggles into the view's ABOVE_TEXT snapshot layer, whose Cairo context
   *  is in buffer coordinates (the same space `getIterLocation` reports). */
  paint(cr: any): void {
    if (this.placed.length === 0 || !this.view.getRealized()) return;
    cr.setLineWidth(LINE_WIDTH);
    for (const u of this.placed) this.drawUnderline(cr, u);
  }

  private drawUnderline(cr: any, { startMark, endMark, color }: { startMark: any; endMark: any; color: string }): void {
    const c = this.rgba(color);
    cr.setSourceRgba(c.red, c.green, c.blue, c.alpha);
    // Resolve the marks to their current positions (they've tracked any edits).
    const buffer = this.model.buffer;
    const startIter = asIter(buffer.getIterAtMark(startMark));
    const endIter = asIter(buffer.getIterAtMark(endMark));
    const startRow = startIter.getLine();
    const startCol = startIter.getLineOffset();
    const endRow = endIter.getLine();
    const endCol = endIter.getLineOffset();
    const lastRow = this.model.getLastBufferRow();
    for (let row = startRow; row <= endRow && row <= lastRow; row++) {
      const startColumn = row === startRow ? startCol : 0;
      const lineEndColumn = this.model.bufferRangeForBufferRow(row).end.column;
      const endColumn = row === endRow ? endCol : lineEndColumn;
      if (endColumn <= startColumn) continue; // nothing on this row

      const span = this.lineSpan(row, startColumn, endColumn);
      if (span) this.stroke(cr, span.x0, span.x1, span.y);
    }
  }

  /** Buffer-pixel `[x0, x1]` and baseline `y` for `[startCol, endCol)` on `row`. In
   *  buffer coordinates (the snapshot layer's space), so positions are used directly. */
  private lineSpan(row: number, startColumn: number, endColumn: number): { x0: number; x1: number; y: number } | null {
    const startCell = this.view.getIterLocation(this.model.iterAtPoint(new Point(row, startColumn)));
    const endCell = this.view.getIterLocation(this.model.iterAtPoint(new Point(row, endColumn)));
    // Underline sits just below the cell box (in the descender gap).
    const y = startCell.y + startCell.height - AMPLITUDE + 0.5;
    return { x0: startCell.x, x1: endCell.x, y };
  }

  /** Stroke a sine wave from `x0` to `x1` along baseline `y`. */
  private stroke(cr: any, x0: number, x1: number, y: number): void {
    cr.moveTo(x0, y);
    for (let x = x0; x <= x1; x += STEP) {
      const offset = AMPLITUDE * Math.sin(((x - x0) / WAVELENGTH) * 2 * Math.PI);
      cr.lineTo(x, y + offset);
    }
    cr.stroke();
  }

  private rgba(hex: string): InstanceType<typeof Gdk.RGBA> {
    let rgba = this.colorCache.get(hex);
    if (!rgba) {
      rgba = new Gdk.RGBA();
      rgba.parse(hex);
      this.colorCache.set(hex, rgba);
    }
    return rgba;
  }
}
