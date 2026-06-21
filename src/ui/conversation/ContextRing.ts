/*
 * ContextRing — a tiny circular gauge for how full the model's context window is.
 *
 * GTK/libadwaita has no circular-progress widget, so this is a transparent
 * `Gtk.DrawingArea` that strokes two Cairo arcs: a faint full-circle track plus a
 * foreground arc swept from 12 o'clock clockwise to `fraction × 2π`. The arc color
 * steps through info → warning → error in thirds of the window.
 *
 * Theme tokens are re-read on every draw (cheap for a ~14px widget) so a live theme
 * switch repaints correctly. Drawing needs a realized, allocated widget, so the
 * visual result is only exercised interactively (not headlessly).
 */
import { Gdk, Gtk } from '../../gi.ts';
import { theme } from '../../theme/theme.ts';

const SIZE = 14; // widget px — sits on the footer's text baseline
const STROKE = 2;

export class ContextRing {
  readonly widget: InstanceType<typeof Gtk.DrawingArea>;
  private fraction = 0; // 0..1, clamped

  constructor() {
    this.widget = new Gtk.DrawingArea();
    this.widget.setContentWidth(SIZE);
    this.widget.setContentHeight(SIZE);
    this.widget.setValign(Gtk.Align.CENTER);
    this.widget.setCanTarget(false); // decorative — never steals pointer/focus
    this.widget.setDrawFunc((_area: unknown, cr: any) => this.draw(cr));
  }

  /** Set the fill fraction (tokens / contextWindow). Repaints only on change. */
  setFraction(f: number): void {
    const next = Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 0;
    if (next === this.fraction) return;
    this.fraction = next;
    this.widget.queueDraw();
  }

  private stroke(cr: any, color: string): void {
    const rgba = new Gdk.RGBA();
    rgba.parse(color);
    cr.setSourceRgba(rgba.red, rgba.green, rgba.blue, rgba.alpha);
    cr.stroke();
  }

  private draw(cr: any): void {
    const c = SIZE / 2;
    const r = (SIZE - STROKE) / 2;
    cr.setLineWidth(STROKE);

    // Track: a full faint circle.
    cr.arc(c, c, r, 0, 2 * Math.PI);
    this.stroke(cr, theme.ui.border);

    // Fill: an arc from 12 o'clock, clockwise.
    if (this.fraction > 0) {
      const start = -Math.PI / 2;
      cr.arc(c, c, r, start, start + this.fraction * 2 * Math.PI);
      this.stroke(cr, this.fillColor());
    }
  }

  // Thirds of the window: info → warning → error as it fills.
  private fillColor(): string {
    if (this.fraction >= 2 / 3) return theme.ui.status.error;
    if (this.fraction >= 1 / 3) return theme.ui.status.warning;
    return theme.ui.status.info;
  }
}
