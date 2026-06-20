/*
 * DiffLineNumberGutter — a left-gutter renderer drawing *file* line numbers in a
 * diff pane (not the synthesized buffer's row numbers). One renderer = one column;
 * a unified pane uses two (old + new file rows), a side-by-side pane one per side.
 * Labels are precomputed per MODEL row (the unfolded diff buffer); a queried view
 * line is translated back through the folds.
 *
 * The width is *primed* (like SyntaxController's line numbers): GtkSourceGutter-
 * RendererText sizes from the currently-set text, so without priming a column
 * measured on a short/blank line crops the wider numbers. The whole left gutter
 * gets a neutral background so the added/removed line tints read only in the text.
 *
 * Mirrors DiffGutter — a `GtkSource.GutterRendererText` subclass, instantiated only
 * at runtime (the node-gtk vfunc constraint).
 */
import { Gtk, GtkSource, registerClass, type SourceView } from '../../gi.ts';
import { theme } from '../../theme/theme.ts';
import type { StagedState } from '../multibuffer/diffMultiBuffer.ts';

const COLOR = theme.ui.editor.lineNumber;

// The staged/unstaged marker bar drawn in the diff multibuffer's gutter: info (blue) = the change
// is already in the index, warning (amber) = it isn't yet. A blank keeps unchanged rows aligned.
const STAGED_COLOR = theme.ui.status.info;
const UNSTAGED_COLOR = theme.ui.status.warning;
const MARKER_GLYPH = '▌';

/** Leading gutter cell: a colored bar for a staged/unstaged change, else a blank of equal width. */
function markerMarkup(state: StagedState): string {
  if (!state) return ' ';
  const color = state === 'staged' ? STAGED_COLOR : UNSTAGED_COLOR;
  return `<span foreground="${color}">${MARKER_GLYPH}</span>`;
}

/** Split a `#rrggbb(aa)` color into a Pango `background` color + a `background_alpha` percentage
 *  (Pango markup's `background` ignores alpha; the alpha rides in `background_alpha`). */
function pangoBackground(color: string): { rgb: string; alphaPct: number } {
  const hex = color.replace('#', '');
  const alpha = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { rgb: `#${hex.slice(0, 6)}`, alphaPct: Math.max(1, Math.round(alpha * 100)) };
}

class DiffLineNumberRenderer extends GtkSource.GutterRendererText {
  // Assigned after construction; read on every draw. (line is 0-based.)
  labels!: string[];
  viewToModel!: (line: number) => number;
  // Per-row cell background (`#rrggbbaa`) or null — added/removed rows tint their side's column.
  backgrounds: (string | null)[] | null = null;

  queryData(_lines: any, line: number) {
    const model = this.viewToModel ? this.viewToModel(line) : line;
    const label = this.labels?.[model] ?? '';
    const bg = this.backgrounds?.[model] ?? null;
    let attrs = `foreground="${COLOR}"`;
    if (bg) {
      const { rgb, alphaPct } = pangoBackground(bg);
      // The space-padded label spans the column width, so the background reads as a full band.
      attrs = `background="${rgb}" background_alpha="${alphaPct}%" ${attrs}`;
    }
    this.setMarkup(`<span ${attrs}>${label || ' '}</span>`, -1);
  }
}
registerClass(DiffLineNumberRenderer);

export class DiffLineNumberGutter {
  private readonly view: SourceView;
  private readonly renderer: DiffLineNumberRenderer;

  /** `position` orders the gutter columns L→R (chevron 0, line numbers, then +/−). `backgrounds`
   *  (optional, indexed like `labels`) tints added/removed rows' cells. */
  constructor(
    view: SourceView,
    labels: string[],
    viewToModel: ((line: number) => number) | undefined,
    position: number,
    backgrounds?: (string | null)[],
  ) {
    this.view = view;
    this.renderer = new DiffLineNumberRenderer();
    this.renderer .labels = labels;
    this.renderer.viewToModel = viewToModel ?? ((line: number) => line);
    this.renderer.backgrounds = backgrounds ?? null;
    this.renderer.setXpad(4);
    (this.view.getGutter(Gtk.TextWindowType.LEFT) as any).insert(this.renderer, position);

    this.primeWidth(labels);
  }

  /** Swap the per-row labels + cell backgrounds (after a re-diff re-flows the rows) and repaint. */
  setData(labels: string[], backgrounds?: (string | null)[]): void {
    (this.renderer as any).labels = labels;
    this.renderer.backgrounds = backgrounds ?? null;
    this.primeWidth(labels);
    (this.renderer as any).queueDraw?.();
  }

  /** Reserve width for the widest label (a number measured on a short line would crop). */
  private primeWidth(labels: string[]): void {
    const width = labels.reduce((max, label) => Math.max(max, label.length), 1);
    this.renderer.setText('0'.repeat(width), -1);
    this.renderer.queueResize();
  }

  dispose(): void {
    (this.view as any).getGutter(Gtk.TextWindowType.LEFT).remove(this.renderer);
  }
}

/** Markup for one number column: `[space][number][space]` — a single space hugging each side of
 *  the (right-aligned) number, the whole run carrying the cell background so an added/removed tint
 *  reads as a solid band, the spaces included. `label` is already padded to the column width (a
 *  blank side — added has no old #, removed no new — is all spaces of that width), so the two
 *  columns stay aligned and there's no other spacing in the gutter. */
function cellMarkup(label: string, bg: string | null): string {
  const content = ` ${label} `;
  if (!bg) return `<span foreground="${COLOR}">${content}</span>`;
  const { rgb, alphaPct } = pangoBackground(bg);
  return `<span background="${rgb}" background_alpha="${alphaPct}%" foreground="${COLOR}">${content}</span>`;
}

class CombinedDiffLineNumberRenderer extends GtkSource.GutterRendererText {
  // Assigned after construction; read on every draw. Per-row old/new labels + cell backgrounds.
  oldLabels!: string[];
  newLabels!: string[];
  oldBg: (string | null)[] | null = null;
  newBg: (string | null)[] | null = null;
  // Per-row staged/unstaged marker (the leading bar). null = no marker (unchanged row).
  stagedState: StagedState[] | null = null;
  // View rows that carry a header-widget band ABOVE them (an excerpt's first row). Their gutter
  // cell is taller by the band, so the number must bottom-align to land on the text instead of
  // floating up beside the filename widget. Other rows top-align (a `⋯` gap band sits BELOW its
  // row, so its number must stay at the top). `queryData` runs per line right before that line is
  // drawn, so toggling `yalign` here applies per row.
  headerRows: Set<number> = new Set();

  queryData(_lines: any, line: number) {
    (this as any).yalign = this.headerRows.has(line) ? 1 : 0;
    const marker = markerMarkup(this.stagedState?.[line] ?? null);
    const oldCell = cellMarkup(this.oldLabels?.[line] ?? '', this.oldBg?.[line] ?? null);
    const newCell = cellMarkup(this.newLabels?.[line] ?? '', this.newBg?.[line] ?? null);
    this.setMarkup(`${marker}${oldCell}${newCell}`, -1); // marker bar, then old/new columns (each carries its own [space..space])
  }
}
registerClass(CombinedDiffLineNumberRenderer);

/**
 * A SINGLE gutter renderer drawing BOTH the old and new file line numbers per row (one
 * PangoLayout/line, like the main editor's composite gutter) — vs. two separate renderers, for
 * the diff multibuffer where every visible line pays the per-line gutter cost. Each column tints
 * its added/removed rows (red old / green new). View == model (the diff has no folds).
 */
export class CombinedDiffLineNumberGutter {
  private readonly view: SourceView;
  private readonly renderer: CombinedDiffLineNumberRenderer;

  constructor(
    view: SourceView,
    oldLabels: string[],
    newLabels: string[],
    oldBg: (string | null)[],
    newBg: (string | null)[],
    headerRows: Set<number> = new Set(),
    stagedState: StagedState[] | null = null,
  ) {
    this.view = view;
    this.renderer = new CombinedDiffLineNumberRenderer();
    this.renderer.oldLabels = oldLabels;
    this.renderer.newLabels = newLabels;
    this.renderer.oldBg = oldBg;
    this.renderer.newBg = newBg;
    this.renderer.headerRows = headerRows;
    this.renderer.stagedState = stagedState;
    this.renderer.setXpad(0); // the `[space][number][space]` format carries the gutter's only spacing
    (this.view.getGutter(Gtk.TextWindowType.LEFT) as any).insert(this.renderer, 1);
    this.primeWidth(oldLabels, newLabels);
  }

  /** Swap the per-row labels + backgrounds + header rows + staged markers (after a re-diff re-flows
   *  the rows) and repaint. */
  setData(
    oldLabels: string[],
    newLabels: string[],
    oldBg: (string | null)[],
    newBg: (string | null)[],
    headerRows: Set<number> = new Set(),
    stagedState: StagedState[] | null = null,
  ): void {
    this.renderer.oldLabels = oldLabels;
    this.renderer.newLabels = newLabels;
    this.renderer.oldBg = oldBg;
    this.renderer.newBg = newBg;
    this.renderer.headerRows = headerRows;
    this.renderer.stagedState = stagedState;
    this.primeWidth(oldLabels, newLabels);
    (this.renderer as any).queueDraw?.();
  }

  /** Reserve width for the marker bar + the widest old + new columns (a number measured on a short
   *  line crops). */
  private primeWidth(oldLabels: string[], newLabels: string[]): void {
    const w = (labels: string[]) => labels.reduce((max, l) => Math.max(max, l.length), 1);
    // Mirror the rendered run `▌ old  new ` (marker bar, then each column ` <num> `, adjacent → two
    // spaces at the seam).
    this.renderer.setText(`${MARKER_GLYPH} ${'0'.repeat(w(oldLabels))}  ${'0'.repeat(w(newLabels))} `, -1);
    this.renderer.queueResize();
  }

  dispose(): void {
    (this.view as any).getGutter(Gtk.TextWindowType.LEFT).remove(this.renderer);
  }
}

// Right-align `n+1` (or blank) in a column sized to the widest number.
function column(rows: readonly (number | null)[]): string[] {
  let max = 0;
  for (const row of rows) if (row != null) max = Math.max(max, row + 1);
  const width = String(Math.max(1, max)).length;
  return rows.map((row) => (row != null ? String(row + 1).padStart(width) : ' '.repeat(width)));
}

/** Old-file line numbers, one per unified DiffLine (blank on added lines). */
export function oldLineLabels(lines: readonly { oldRow: number | null }[]): string[] {
  return column(lines.map((l) => l.oldRow));
}
/** New-file line numbers, one per unified DiffLine (blank on removed lines). */
export function newLineLabels(lines: readonly { newRow: number | null }[]): string[] {
  return column(lines.map((l) => l.newRow));
}
/** This side's file line numbers, one per side-by-side row (blank on fillers). */
export function sideLineLabels(lines: readonly { row: number | null }[]): string[] {
  return column(lines.map((l) => l.row));
}
