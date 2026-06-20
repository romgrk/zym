/*
 * The editor's single, composite gutter renderer — drawn via the GtkSnapshot API.
 *
 * One `GtkSourceGutterRenderer` (the BASE class, not `...Text`) draws the WHOLE
 * left gutter — git change bar, line number, fold chevron, diagnostic glyph — by
 * painting each column itself in `snapshot_line`, instead of composing a Pango
 * markup string and handing it to GtkSourceGutterRendererText. Owning the drawing
 * is what lets the gutter render arbitrary content (e.g. beside block decorations)
 * and, later, become clickable; it also drops cost two ways:
 *   - line numbers (every line, the hot path) draw with `layout.setText` +
 *     `appendLayout(color)` — no per-line Pango *markup* parse, which is the
 *     dominant cost the old `setMarkup` path paid (see src/poc/gutter-bench.ts);
 *   - the git / diagnostic columns are markup, but now only the FEW lines that
 *     actually carry a bar/glyph build a layout — clean lines draw nothing (the
 *     old composite emitted a space per line and paid a layout for it).
 *
 * Column order L→R: [git][line number][chevron][diagnostic] — bar at the far-left
 * edge, diagnostic glyph nearest the text. Width comes from `measure` (digits +
 * present columns × monospace char width). Display-only for now: the chevron shows
 * ▾/▸ but takes no clicks (folding is keyboard-driven: za/zo/zc/zR/zM).
 *
 * SyntaxController owns line-number + chevron data directly (it's a `GutterHost`);
 * GitGutter and DiagnosticsView feed their cells through `setGitCell`/`setDiagCell`
 * (the `GutterCellSink`) instead of inserting renderers of their own. The renderer
 * reads its owning controller off `this.controller` (assigned right after
 * construction) — node-gtk preserves instance props as `this` inside vfuncs.
 */
import { Gdk, Graphene, Gtk, GtkSource, registerClass } from '../gi.ts';
import { theme } from '../theme/theme.ts';

// Line-number gutter color (muted), matching how syntax colors are themed. The git
// bar / diagnostic glyph colors live with their owners (they hand us ready markup).
const LINE_NUMBER_COLOR = theme.ui.editor.lineNumber;
const LINE_NUMBER_RGBA = (() => {
  const rgba = new Gdk.RGBA();
  rgba.parse(LINE_NUMBER_COLOR);
  return rgba;
})();

// Fold chevron — Nerd Font fa-chevron (down = expanded, right = collapsed), drawn
// in the bundled icon font (same family as the diagnostic glyph; see fonts.ts
// ICON_FONT_FAMILY) at a smaller size + muted color so it reads as a subtle fold
// affordance rather than a heavy triangle.
const ICON_FONT = 'Symbols Nerd Font Mono';
const CHEVRON_OPEN = '\u{f078}'; // nf-fa-chevron_down
const CHEVRON_FOLDED = '\u{f054}'; // nf-fa-chevron_right

/** The slice of SyntaxController the composite renderer reads (assigned as
 *  `.controller` right after construction). Structural, so the renderer doesn't
 *  import the whole controller. A cell function returns a Pango-markup fragment
 *  for one view line, or '' for a blank cell (which now draws nothing). */
export interface GutterHost {
  foldsByHeaderLine: Map<number, { folded: boolean }>;
  lineNumberWidth(): number;
  modelLineFor(line: number): number;
  wantLineNumbers: boolean;
  foldingEnabled: boolean;
  hasGitColumn: boolean;
  hasDiagColumn: boolean;
  gitCellFor(line: number): string;
  diagCellFor(line: number): string;
}

/** What GitGutter / DiagnosticsView call to contribute their gutter column without
 *  owning a renderer. Implemented by SyntaxController. Passing `null` clears the
 *  column (and its reserved width); every setter triggers a gutter redraw. */
export interface GutterCellSink {
  setGitCell(cell: ((viewLine: number) => string) | null): void;
  setDiagCell(cell: ((viewLine: number) => string) | null): void;
  redrawGutter(): void;
}

/** Total gutter width in monospace character columns, for the current set of
 *  active columns. Mirrored by `measure` (sizing) and `snapshotLine` (layout). */
function columnCount(c: GutterHost): number {
  return (c.hasGitColumn ? 1 : 0)
    + (c.wantLineNumbers ? c.lineNumberWidth() : 0)
    + (c.foldingEnabled ? 2 : 0) // a leading space + the chevron glyph
    + (c.hasDiagColumn ? 1 : 0);
}

// Composite gutter renderer: git bar + line number + fold chevron + diagnostic
// glyph, drawn column by column with the snapshot API (one cheap text layout for
// numbers, a markup layout only for non-empty rich cells).
export class GutterRenderer extends GtkSource.GutterRenderer {
  // Reused layouts (created lazily on the realized widget): `numLayout` for line
  // numbers (plain text), `cellLayout` for git/chevron/diagnostic markup.
  private numLayout: any = null;
  private cellLayout: any = null;
  // Monospace cell metrics, refreshed each frame in `begin` (cheap; guards font changes).
  private charWidth = 0;
  private lineHeight = 0;

  private ensureLayouts(): void {
    if (!this.numLayout) this.numLayout = (this as any).createPangoLayout('');
    if (!this.cellLayout) this.cellLayout = (this as any).createPangoLayout('');
  }

  private refreshMetrics(): void {
    this.ensureLayouts();
    this.numLayout.setText('0', -1);
    const [w, h] = this.numLayout.getPixelSize();
    this.charWidth = w || this.charWidth || 1;
    this.lineHeight = h || this.lineHeight;
  }

  // Called once per frame before the line loop — refresh metrics here so a font/scale
  // change is picked up without a separate invalidation path.
  begin(_lines: any): void {
    this.refreshMetrics();
  }

  // Reserve the gutter's width: present columns × monospace char width + xpad both sides
  // (matching how GtkSourceGutterRendererText sized from its primed text).
  measure(orientation: any, _forSize: number): [number, number, number, number] {
    const c = (this as any).controller as GutterHost | undefined;
    if (orientation !== Gtk.Orientation.HORIZONTAL || !c) return [0, 0, -1, -1];
    this.refreshMetrics();
    const xpad = (this as any).getXpad?.() ?? 0;
    const width = columnCount(c) * this.charWidth + 2 * xpad;
    return [width, width, -1, -1];
  }

  snapshotLine(snapshot: any, lines: any, line: number): void {
    const c = (this as any).controller as GutterHost | undefined;
    if (!c) return;
    if (!this.charWidth) this.refreshMetrics();
    const cw = this.charWidth;

    // Align the whole content block within the cell (handles xpad + vertical placement
    // against the text line), then walk columns left→right from there.
    const [blockX, blockY] = (this as any).alignCell(line, columnCount(c) * cw, this.lineHeight);
    let x = blockX;

    if (c.hasGitColumn) {
      const markup = c.gitCellFor(line);
      if (markup) this.drawMarkup(snapshot, markup, x, blockY);
      x += cw;
    }

    if (c.wantLineNumbers) {
      const digits = c.lineNumberWidth();
      const num = String(c.modelLineFor(line) + 1).padStart(digits, ' ');
      this.numLayout.setText(num, -1);
      this.drawLayout(snapshot, this.numLayout, LINE_NUMBER_RGBA, x, blockY);
      x += digits * cw;
    }

    if (c.foldingEnabled) {
      const region = c.foldsByHeaderLine.get(line);
      const glyph = region ? (region.folded ? CHEVRON_FOLDED : CHEVRON_OPEN) : null;
      // A leading space, then the chevron (so it doesn't hug the number).
      if (glyph) {
        const markup = `<span face="${ICON_FONT}" size="75%" foreground="${LINE_NUMBER_COLOR}">${glyph}</span>`;
        this.drawMarkup(snapshot, markup, x + cw, blockY);
      }
      x += 2 * cw;
    }

    if (c.hasDiagColumn) {
      const markup = c.diagCellFor(line);
      if (markup) this.drawMarkup(snapshot, markup, x, blockY);
      x += cw;
    }
  }

  private drawLayout(snapshot: any, layout: any, color: any, x: number, y: number): void {
    snapshot.save();
    snapshot.translate(new Graphene.Point().init(Math.round(x), Math.round(y)));
    snapshot.appendLayout(layout, color);
    snapshot.restore();
  }

  private drawMarkup(snapshot: any, markup: string, x: number, y: number): void {
    this.cellLayout.setMarkup(markup, -1);
    this.drawLayout(snapshot, this.cellLayout, LINE_NUMBER_RGBA, x, y);
  }
}
registerClass(GutterRenderer);
