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

export class UnderlineOverlay {
  /** The DrawingArea to add as an overlay child over the text. */
  readonly widget: InstanceType<typeof Gtk.DrawingArea>;

  private readonly view: SourceView;
  private readonly model: EditorModel;
  private underlines: Underline[] = [];
  private readonly colorCache = new Map<string, InstanceType<typeof Gdk.RGBA>>();

  constructor(view: SourceView, model: EditorModel) {
    this.view = view;
    this.model = model;

    this.widget = new Gtk.DrawingArea();
    this.widget.setCanTarget(false); // never intercept clicks
    this.widget.setDrawFunc((_area: unknown, cr: any) => this.draw(cr));

    // Repaint as the text scrolls so squiggles track their lines. The view's
    // scroll adjustments exist once it's inside the ScrolledWindow.
    const redraw = () => this.widget.queueDraw();
    (this.view as any).getVadjustment()?.on('value-changed', redraw);
    (this.view as any).getHadjustment()?.on('value-changed', redraw);
  }

  /** Replace the underline set and repaint. */
  setUnderlines(underlines: Underline[]): void {
    this.underlines = underlines;
    this.widget.queueDraw();
  }

  /** Remove all underlines. */
  clear(): void {
    if (this.underlines.length === 0) return;
    this.underlines = [];
    this.widget.queueDraw();
  }

  private draw(cr: any): void {
    if (this.underlines.length === 0 || !this.view.getRealized()) return;
    cr.setLineWidth(LINE_WIDTH);
    for (const underline of this.underlines) this.drawUnderline(cr, underline);
  }

  private drawUnderline(cr: any, { range, color }: Underline): void {
    const c = this.rgba(color);
    cr.setSourceRgba(c.red, c.green, c.blue, c.alpha);
    const lastRow = this.model.getLastBufferRow();
    for (let row = range.start.row; row <= range.end.row && row <= lastRow; row++) {
      const startColumn = row === range.start.row ? range.start.column : 0;
      const lineEndColumn = this.model.bufferRangeForBufferRow(row).end.column;
      const endColumn = row === range.end.row ? range.end.column : lineEndColumn;
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
