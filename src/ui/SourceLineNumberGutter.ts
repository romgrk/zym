/*
 * SourceLineNumberGutter — a left-gutter renderer drawing each row's *source* line number in a
 * multibuffer (project search). A multibuffer view row doesn't equal a source line: header /
 * gap / blank rows are synthesized, and each excerpt shows a slice of a different file. So the
 * renderer asks the LIVE `ViewProjection` for the source line behind each view row
 * (`sourceRowAtViewRow`) — a real source row renders `sourceRow + 1`, a block / folded row
 * renders blank (the column keeps its width). Re-segmentation swaps the projection, so it's
 * read through a getter rather than captured.
 *
 * Mirrors `DiffLineNumberGutter`: a `GtkSource.GutterRendererText` subclass instantiated only
 * at runtime (the node-gtk vfunc constraint), width *primed* up front so a number measured on a
 * short line isn't cropped.
 */
import { Gtk, GtkSource, registerClass, type SourceView } from '../gi.ts';
import { theme } from '../theme/theme.ts';
import type { ViewProjection } from './TextEditor/ViewProjection.ts';

const COLOR = theme.ui.editor.lineNumber;

/** The gutter label for one view row: the 1-based SOURCE line number behind it, right-aligned
 *  to `width`; all-blank (width spaces) for a header / gap / blank / folded row. Pure — the
 *  unit-tested core of the renderer. */
export function lineNumberLabel(projection: ViewProjection, viewRow: number, width: number): string {
  const src = projection.sourceRowAtViewRow(viewRow);
  return (src ? String(src.sourceRow + 1) : '').padStart(width);
}

class MultiBufferLineRenderer extends GtkSource.GutterRendererText {
  // Assigned after construction; read on every draw.
  getProjection!: () => ViewProjection;
  // The band placement at a row ('above' = header band, 'below' = gap band, null = none), so the
  // number can be aligned onto the text instead of floating into the reserved band.
  bandAt!: (line: number) => 'above' | 'below' | null;
  width = 1;

  queryData(_lines: any, line: number) {
    // A header band ABOVE makes the cell taller above → bottom-align (yalign 1) keeps the number on
    // the text; a gap band BELOW makes it taller below → top-align (yalign 0). Plain rows: either
    // (cell == text height). `queryData` runs per row right before it's drawn, so this is per-row.
    (this as any).yalign = this.bandAt(line) === 'below' ? 0 : 1;
    const label = lineNumberLabel(this.getProjection(), line, this.width);
    this.setMarkup(`<span foreground="${COLOR}">${label || ' '}</span>`, -1);
  }
}
registerClass(MultiBufferLineRenderer);

export class SourceLineNumberGutter {
  private readonly view: SourceView;
  private readonly renderer: MultiBufferLineRenderer;

  /** `maxLineNumber` is the widest 1-based source line that can show (sizes the column; an
   *  edit can grow a source past it, but crossing a digit boundary is rare and only widens
   *  padding, never the rendered number, which is read live). `bandAt` reports the band placement
   *  at a row (from the live `BlockDecorations`) so the number aligns onto the text, not into the
   *  reserved header/gap band. */
  constructor(view: SourceView, getProjection: () => ViewProjection, maxLineNumber: number, bandAt: (line: number) => 'above' | 'below' | null) {
    this.view = view;
    this.renderer = new MultiBufferLineRenderer();
    (this.renderer as any).getProjection = getProjection;
    (this.renderer as any).bandAt = bandAt;
    (this.renderer as any).width = String(Math.max(1, maxLineNumber)).length;
    this.renderer.setXpad(4);
    (this.view as any).getGutter(Gtk.TextWindowType.LEFT).insert(this.renderer, 0);

    // Reserve width for the widest number up front (a number measured on a short line crops).
    this.renderer.setText('0'.repeat((this.renderer as any).width), -1);
    this.renderer.queueResize();
  }

  dispose(): void {
    (this.view as any).getGutter(Gtk.TextWindowType.LEFT).remove(this.renderer);
  }
}
