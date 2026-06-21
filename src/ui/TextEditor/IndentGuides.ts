/*
 * IndentGuides — faint vertical lines marking each indentation level, drawn
 * in the leading whitespace. A transparent `Gtk.DrawingArea` stacked over the text
 * (like UnderlineOverlay), repainted on scroll and edits.
 *
 * Levels follow the *actual* indentation of each line (so guides line up with the
 * text), and a blank line borrows the level of the nearest non-blank line below
 * (then above) so guides run unbroken through blank lines inside a block.
 * Column→pixel uses the monospace char width measured from a visible content line.
 *
 * Toggle with `editor.indentGuides`. Drawing needs a realized, allocated view, so
 * the visual result needs interactive verification (not exercised headlessly).
 */
import { Gdk, Gtk, type SourceView } from '../../gi.ts';
import { Point } from '../../text/Point.ts';
import { theme } from '../../theme/theme.ts';
import { zym } from '../../zym.ts';
import { CompositeDisposable, Disposable } from '../../util/eventKit.ts';
import type { EditorModel } from './EditorModel.ts';

const LINE_WIDTH = 1;

// node-gtk returns a bare iter for get_iter_at_line (some builds wrap it). Normalize.
const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);

export class IndentGuides {
  readonly widget: InstanceType<typeof Gtk.DrawingArea>;

  private readonly view: SourceView;
  private readonly model: EditorModel;
  private readonly buffer: any;
  private enabled = true;
  // Signal handlers (view/buffer/adjustment) + the config observer all land here. Each
  // node-gtk handler closure captures `this` (→ view + model), so a single un-disconnected
  // one pins the editor forever; `dispose()` cuts them. See TextEditor `subs`.
  private readonly subs = new CompositeDisposable();
  private readonly rgba = new Gdk.RGBA();
  // Monospace char advance, measured lazily from a visible content line and cached
  // (constant for the editor's font). The column-0 origin is NOT cached — it's
  // re-read each draw, because it shifts after open (deferred gutter install).
  private charWidth = 0;

  constructor(view: SourceView, model: EditorModel) {
    this.view = view;
    this.model = model;
    this.buffer = view.getBuffer();
    this.rgba.parse(theme.ui.border);

    this.widget = new Gtk.DrawingArea();
    this.widget.setCanTarget(false);
    this.widget.setDrawFunc((_area: unknown, cr: any) => this.draw(cr));

    const redraw = () => this.widget.queueDraw();
    // (Re)bind on notify::v/hadjustment too — the ScrolledWindow swaps in its own
    // adjustments when the view is parented, so a construction-only binding can catch a
    // throwaway adjustment whose value-changed never fires (see UnderlineOverlay).
    const bind = (getter: 'getVadjustment' | 'getHadjustment', notify: string) => {
      let bound: any = null;
      const rebind = () => {
        const adj = (view as any)[getter]?.();
        if (!adj || adj === bound) return;
        if (bound) bound.off('value-changed', redraw); // drop the stale binding before re-binding
        bound = adj;
        adj.on('value-changed', redraw);
      };
      rebind();
      (view as any).on(notify, rebind);
      this.subs.add(new Disposable(() => {
        view.off(notify, rebind);
        if (bound) bound.off('value-changed', redraw);
      }));
    };
    bind('getVadjustment', 'notify::vadjustment');
    bind('getHadjustment', 'notify::hadjustment');
    this.buffer.on('changed', redraw); // indentation may have changed
    this.subs.add(new Disposable(() => this.buffer.off('changed', redraw)));
    this.subs.add(
      zym.config.observe('editor.indentGuides', (v) => {
        this.enabled = v !== false;
        redraw();
      }),
    );
  }

  /** Detach the view/buffer/adjustment handlers + the config observer, so this overlay
   *  stops pinning the editor on teardown. Called from `TextEditor.dispose()`. */
  dispose(): void {
    this.subs.dispose();
  }

  private draw(cr: any): void {
    if (!this.enabled || !this.view.getRealized()) return;
    const view = this.view as any;
    const rect = view.getVisibleRect();
    if (!rect || !rect.height) return;

    const last = this.model.getLastBufferRow();
    // getLineAtY fills (target_iter, line_top) — the iter is the FIRST out-param. The
    // generic "last element" helper grabbed line_top (an int) and threw in the draw
    // func, so guides never rendered. Take r[0].
    const lineAtY = (y: number): number => {
      const r = view.getLineAtY(y);
      return (Array.isArray(r) ? r[0] : r).getLine();
    };
    const top = Math.max(0, lineAtY(rect.y));
    const bottom = Math.min(last, lineAtY(rect.y + rect.height));
    if (!this.ensureMetrics(top, bottom)) return;

    const tabLength = this.model.getTabLength();
    const stride = tabLength * this.charWidth; // buffer px per indent level
    // Indent level per visible row, computed from ONE batched text read (not two
    // FFI-heavy per-row line reads) — the bulk of the old per-frame scroll cost.
    const levels = this.levelsForRange(top, bottom, last, tabLength);

    // Geometry, computed ONCE per frame. The column-0 x and the buffer→widget translation
    // are constant across a frame, so hoist them out of the per-row loop (the old code did
    // a bufferToWindowCoords per row). `dy` is the vertical translation; `wx` the (constant)
    // column-0 widget x. When every visible row is the same height — no soft-wrap or scaled
    // line on screen, the common case for code — each row's y follows arithmetically with NO
    // per-row FFI; otherwise we fall back to a getIterLocation per row.
    const topCell = view.getIterLocation(this.lineStartIter(top));
    const lineHeight = topCell.height;
    const [wx, wyTop] = view.bufferToWindowCoords(Gtk.TextWindowType.WIDGET, topCell.x, topCell.y);
    const dy = topCell.y - wyTop;
    const botCell = bottom === top ? topCell : view.getIterLocation(this.lineStartIter(bottom));
    // Both endpoints at the base height AND an exact total span ⟹ every row in between is
    // exactly `lineHeight` tall: rows are never shorter than the base, so a wrapped or
    // scaled (e.g. markdown heading) row would make the span larger and force the fallback.
    const uniform =
      botCell.height === lineHeight && botCell.y - topCell.y === (bottom - top) * lineHeight;

    cr.setLineWidth(LINE_WIDTH);
    cr.setSourceRgba(this.rgba.red, this.rgba.green, this.rgba.blue, this.rgba.alpha);
    for (let row = top; row <= bottom; row++) {
      const level = levels[row - top];
      if (level <= 0) continue;
      let wy: number;
      let height: number;
      if (uniform) {
        wy = wyTop + (row - top) * lineHeight;
        height = lineHeight;
      } else {
        const cell = row === top ? topCell : view.getIterLocation(this.lineStartIter(row));
        wy = cell.y - dy; // same translation the hoisted bufferToWindowCoords applied
        height = cell.height;
      }
      for (let k = 0; k < level; k++) {
        const x = Math.round(wx + k * stride) + 0.5; // +0.5 → crisp 1px line
        cr.moveTo(x, wy);
        cr.lineTo(x, wy + height);
      }
    }
    cr.stroke();
  }

  /** A line-start iter for `row` (column 0), without `iterAtPoint`'s clamp machinery. */
  private lineStartIter(row: number): any {
    return asIter(this.buffer.getIterAtLine(row));
  }

  /**
   * The guide level to show for each row in `[top, bottom]`, read from a SINGLE
   * `getText` over the visible block (then computed in JS) instead of two FFI-heavy
   * per-row line reads (`isBufferRowBlank` + `indentationForBufferRow`). A blank line
   * borrows the level of the nearest non-blank line below (then above), matching
   * `guideLevel`; only a blank row whose nearest non-blank neighbour lies off-screen
   * falls back to the model scan (rare — the viewport tail/head being all-blank).
   */
  private levelsForRange(top: number, bottom: number, last: number, tabLength: number): number[] {
    const n = bottom - top + 1;
    const startIter = this.lineStartIter(top);
    const endIter = bottom >= last ? this.buffer.getEndIter() : this.lineStartIter(bottom + 1);
    const lines: string[] = this.buffer.getText(startIter, endIter, true).split('\n');

    const blank: boolean[] = new Array(n);
    const raw: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const line = lines[i] ?? '';
      const lead = /^\s*/.exec(line)![0];
      blank[i] = lead.length === line.length;
      let width = 0;
      for (const ch of lead) width += ch === '\t' ? tabLength : 1;
      raw[i] = Math.floor(width / tabLength);
    }

    const out: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      if (!blank[i]) { out[i] = raw[i]; continue; }
      // Blank: nearest non-blank below (down to EOF) wins, else nearest above (up to BOF).
      let level = -1;
      for (let j = i + 1; j < n; j++) if (!blank[j]) { level = raw[j]; break; }
      if (level < 0) {
        if (bottom < last) { out[i] = this.guideLevel(top + i, last); continue; } // neighbour below off-screen
        for (let j = i - 1; j >= 0; j--) if (!blank[j]) { level = raw[j]; break; }
        if (level < 0) {
          if (top > 0) { out[i] = this.guideLevel(top + i, last); continue; } // neighbour above off-screen
          level = 0;
        }
      }
      out[i] = level;
    }
    return out;
  }

  /** The indent level whose guides this row should show. */
  private guideLevel(row: number, last: number): number {
    if (!this.model.isBufferRowBlank(row)) return Math.floor(this.model.indentationForBufferRow(row));
    // Blank line: continue the guides of the nearest non-blank line below, else above.
    for (let r = row + 1; r <= last; r++) {
      if (!this.model.isBufferRowBlank(r)) return Math.floor(this.model.indentationForBufferRow(r));
    }
    for (let r = row - 1; r >= 0; r--) {
      if (!this.model.isBufferRowBlank(r)) return Math.floor(this.model.indentationForBufferRow(r));
    }
    return 0;
  }

  /** Measure the monospace char advance from a visible content line. */
  private ensureMetrics(top: number, bottom: number): boolean {
    if (this.charWidth > 0) return true;
    const view = this.view as any;
    for (let row = top; row <= bottom; row++) {
      if (this.model.lineLength(row) < 2) continue;
      const a = view.getIterLocation(this.model.iterAtPoint(new Point(row, 0)));
      const b = view.getIterLocation(this.model.iterAtPoint(new Point(row, 1)));
      if (b.x > a.x) {
        this.charWidth = b.x - a.x;
        return true;
      }
    }
    return false; // nothing measurable on screen yet
  }
}
