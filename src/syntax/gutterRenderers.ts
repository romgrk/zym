/*
 * The editor's single, composite gutter renderer.
 *
 * One `GtkSourceGutterRendererText` draws the WHOLE left gutter — line number,
 * fold chevron, git change bar, and diagnostic glyph — by composing one markup
 * string per visible line (so it's ONE PangoLayout per line, not one per column).
 * This replaces the former four separate renderers (line-number + chevron in this
 * file, git bar in GitGutter, diagnostic glyph in DiagnosticsView), each of which
 * built+rendered its own PangoLayout per visible line per frame.
 *
 * Measured: collapsing 4 layouts/line → 1 cuts the gutter's per-frame Pango cost
 * ~4x (see src/poc/gutter-bench.ts). The trade-off is that the gutter is now
 * DISPLAY-ONLY — the fold chevron still shows ▾/▸ but no longer responds to clicks
 * (folding stays fully keyboard-driven: za/zo/zc/zr/zm). Per-renderer click
 * targeting was the only thing that forced the chevron to be its own renderer.
 *
 * SyntaxController owns line-number + chevron data directly (it's a `GutterHost`);
 * GitGutter and DiagnosticsView feed their cells through `setGitCell`/`setDiagCell`
 * (the `GutterCellSink`) instead of inserting renderers of their own. The renderer
 * reads its owning controller off `this.controller` (assigned right after
 * construction) — node-gtk preserves instance props as `this` inside vfuncs.
 */
import { GtkSource, registerClass } from '../gi.ts';
import { theme } from '../theme/theme.ts';

// Line-number gutter color (muted), matching how syntax colors are themed. The git
// bar / diagnostic glyph colors live with their owners (they hand us ready markup).
const LINE_NUMBER_COLOR = theme.ui.editor.lineNumber;

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
 *  for one view line, or '' for a blank cell (the renderer pads it to a space so
 *  the column keeps a stable width). */
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

// Composite gutter renderer: git bar + line number + fold chevron + diagnostic
// glyph, one markup string (one PangoLayout) per line. Column order L→R:
// [git][line number][chevron][diagnostic] — the change bar at the far-left edge,
// the diagnostic glyph nearest the text.
export class GutterRenderer extends GtkSource.GutterRendererText {
  queryData(_lines: any, line: number) {
    const c = (this as any).controller as GutterHost | undefined;
    if (!c) { this.setText(' ', -1); return; }
    let markup = '';
    // Git / diagnostic columns reserve a space on clean lines so a bar/glyph
    // appearing later doesn't shift the text column.
    if (c.hasGitColumn) markup += c.gitCellFor(line) || ' ';
    if (c.wantLineNumbers) {
      const num = String(c.modelLineFor(line) + 1).padStart(c.lineNumberWidth(), ' ');
      markup += `<span foreground="${LINE_NUMBER_COLOR}">${num}</span>`;
    }
    if (c.foldingEnabled) {
      // A nested header hidden inside an outer fold draws blank (no pile-up).
      const region = c.foldsByHeaderLine.get(line);
      const glyph = region ? (region.folded ? CHEVRON_FOLDED : CHEVRON_OPEN) : null;
      markup += ' ' + (glyph ? `<span face="${ICON_FONT}" size="75%" foreground="${LINE_NUMBER_COLOR}">${glyph}</span>` : ' ');
    }
    if (c.hasDiagColumn) markup += c.diagCellFor(line) || ' ';
    this.setMarkup(markup || ' ', -1);
  }
}
registerClass(GutterRenderer);
