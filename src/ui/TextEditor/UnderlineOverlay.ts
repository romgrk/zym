/*
 * UnderlineOverlay — draws wavy underlines under buffer ranges (LSP diagnostic
 * squiggles) by painting them ourselves, instead of GtkTextTag's fixed, dense
 * `Pango.Underline.ERROR` style.
 *
 * It's a transparent `Gtk.DrawingArea` stacked over the text in the editor's
 * `Gtk.Overlay` (the same place the unfocused-caret layer lives). For each
 * underline it walks the buffer rows the range spans, converts each line segment
 * to widget pixels via `getIterLocation` + `bufferToWindowCoords(WIDGET)` (so the
 * gutter offset and scroll position are accounted for), and strokes a low-
 * amplitude sine wave with Cairo — anti-aliased, with full control over color,
 * amplitude, and wavelength. It repaints as the view scrolls.
 *
 * Producers (currently `DiagnosticsView`) push the full set via `setUnderlines`
 * and reset with `clear`. Drawing needs a realized, allocated view, so the visual
 * result needs interactive verification (it can't be exercised headlessly).
 */
import { Gdk, Gtk, type SourceView } from '../../gi.ts';
import { Range } from '../../text/Range.ts';
import { Point } from '../../text/Point.ts';
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
  /** The DrawingArea to add as an overlay child over the text. */
  readonly widget: InstanceType<typeof Gtk.DrawingArea>;

  private readonly view: SourceView;
  private readonly model: EditorModel;
  // Each underline is anchored to a pair of GtkTextMarks (not static coordinates), so
  // its position moves with edits exactly like a GtkTextTag — the squiggle tracks the
  // text live instead of lagging until the next diagnostics push.
  private placed: Array<{ startMark: any; endMark: any; color: string }> = [];
  private readonly colorCache = new Map<string, InstanceType<typeof Gdk.RGBA>>();

  constructor(view: SourceView, model: EditorModel) {
    this.view = view;
    this.model = model;

    this.widget = new Gtk.DrawingArea();
    this.widget.setCanTarget(false); // never intercept clicks
    this.widget.setDrawFunc((_area: unknown, cr: any) => this.draw(cr));

    // Repaint as the text scrolls/changes so squiggles track their lines. The
    // ScrolledWindow swaps in its own adjustments when the view is parented, so we
    // (re)bind `value-changed` on `notify::v/hadjustment` as well as now — binding
    // only at construction catches the throwaway pre-parent adjustment, whose
    // `value-changed` never fires, so the squiggles would stay fixed while scrolling.
    const redraw = () => this.widget.queueDraw();
    const bind = (getter: 'getVadjustment' | 'getHadjustment', notify: string) => {
      let bound: any = null;
      const rebind = () => {
        const adj = (this.view as any)[getter]?.();
        if (!adj || adj === bound) return;
        bound = adj;
        adj.on('value-changed', redraw);
      };
      rebind();
      (this.view as any).on(notify, rebind);
    };
    bind('getVadjustment', 'notify::vadjustment');
    bind('getHadjustment', 'notify::hadjustment');
    // Redraw on edits too: the marks have already moved with the edit, so repaint now
    // (at their new positions) rather than waiting for the next diagnostics push — this
    // is what removes the on-edit lag.
    (this.model.buffer as any).on('changed', redraw);
  }

  /** Replace the underline set and repaint, anchoring each range to a mark pair. */
  setUnderlines(underlines: Underline[]): void {
    const buffer = this.model.buffer as any;
    this.deleteMarks();
    // start mark right-gravity, end mark left-gravity → the pair brackets the range like
    // a GtkTextTag (inserts at the edges fall outside; inserts inside grow it).
    this.placed = underlines.map(({ range, color }) => ({
      startMark: buffer.createMark(null, this.model.iterAtPoint(range.start), false),
      endMark: buffer.createMark(null, this.model.iterAtPoint(range.end), true),
      color,
    }));
    this.widget.queueDraw();
  }

  /** Remove all underlines. */
  clear(): void {
    if (this.placed.length === 0) return;
    this.deleteMarks();
    this.placed = [];
    this.widget.queueDraw();
  }

  private deleteMarks(): void {
    const buffer = this.model.buffer as any;
    for (const p of this.placed) {
      buffer.deleteMark(p.startMark);
      buffer.deleteMark(p.endMark);
    }
  }

  private draw(cr: any): void {
    if (this.placed.length === 0 || !this.view.getRealized()) return;
    cr.setLineWidth(LINE_WIDTH);
    for (const u of this.placed) this.drawUnderline(cr, u);
  }

  private drawUnderline(cr: any, { startMark, endMark, color }: { startMark: any; endMark: any; color: string }): void {
    const c = this.rgba(color);
    cr.setSourceRgba(c.red, c.green, c.blue, c.alpha);
    // Resolve the marks to their current positions (they've tracked any edits).
    const buffer = this.model.buffer as any;
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

  /** Widget-pixel `[x0, x1]` and baseline `y` for `[startCol, endCol)` on `row`. */
  private lineSpan(row: number, startColumn: number, endColumn: number): { x0: number; x1: number; y: number } | null {
    const startCell = (this.view as any).getIterLocation(this.model.iterAtPoint(new Point(row, startColumn)));
    const endCell = (this.view as any).getIterLocation(this.model.iterAtPoint(new Point(row, endColumn)));
    // Underline sits just below the cell box (in the descender gap).
    const [x0, y] = (this.view as any).bufferToWindowCoords(
      Gtk.TextWindowType.WIDGET,
      startCell.x,
      startCell.y + startCell.height,
    );
    const [x1] = (this.view as any).bufferToWindowCoords(Gtk.TextWindowType.WIDGET, endCell.x, endCell.y);
    return { x0, x1, y: y - AMPLITUDE + 0.5 };
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
