/*
 * Gutter renderers for the SyntaxController: a fold-chevron column and a
 * fold-aware line-number column, both GtkSourceGutterRendererText subclasses.
 * Each reads its owning controller off `this.controller` (a GutterHost the
 * SyntaxController assigns right after construction) — verified that node-gtk
 * preserves instance props as `this` inside vfunc callbacks.
 *
 * The line numbers are custom (not GtkSourceView's built-in gutter) because the
 * built-in renders a number for every folded line at the collapsed y — a mashup;
 * these draw the model line for visible rows and nothing for collapsed bodies.
 */
import { GtkSource, registerClass } from '../gi.ts';
import { theme } from '../theme/theme.ts';

// Line-number gutter color (muted), matching how syntax colors are themed.
const LINE_NUMBER_COLOR = theme.ui.lineNumber;

/** The slice of SyntaxController the gutter renderers read (assigned as
 *  `.controller` right after construction). Structural, so the renderers don't
 *  import the whole controller and its richer `FoldRegion` map still satisfies it. */
export interface GutterHost {
  foldsByHeaderLine: Map<number, { folded: boolean }>;
  toggleHeaderLine(line: number): void;
  lineNumberWidth(): number;
  modelLineFor(line: number): number;
}

// Fold-chevron gutter renderer.
export class FoldRenderer extends GtkSource.GutterRendererText {
  // Set the glyph for this line: ▸ folded, ▾ foldable-open, else blank. A nested
  // header hidden inside an outer fold draws blank (so it doesn't pile up).
  queryData(_lines: any, line: number) {
    const controller = (this as any).controller as GutterHost | undefined;
    const region = controller?.foldsByHeaderLine.get(line);
    const glyph = region ? (region.folded ? '▸' : '▾') : ' ';
    this.setMarkup(glyph, -1);
  }

  // Only fold-header lines respond to clicks.
  queryActivatable(iter: any, _area: any) {
    return Boolean((this as any).controller?.foldsByHeaderLine.has(iter.getLine()));
  }

  // Click: toggle the fold on this line.
  // @ts-expect-error - overriding the activate vfunc; the base class also
  // exposes a no-arg activate() action method, so the signatures don't unify.
  activate(iter: any, _area: any, _button: number, _state: any, _nPresses: number) {
    (this as any).controller?.toggleHeaderLine(iter.getLine());
  }
}
registerClass(FoldRenderer);

// Fold-aware line-number gutter renderer. Draws the 1-based model line number for
// visible lines and NOTHING for lines hidden inside a fold.
export class LineNumberRenderer extends GtkSource.GutterRendererText {
  queryData(_lines: any, line: number) {
    const controller = (this as any).controller as GutterHost | undefined;
    const width = controller ? controller.lineNumberWidth() : 1;
    // Always emit fixed-width content so the gutter column keeps a stable width
    // (empty text collapses it to zero → no numbers show).
    if (!controller) {
      this.setText(' '.repeat(width), -1);
    } else {
      const num = String(controller.modelLineFor(line) + 1).padStart(width, ' ');
      this.setMarkup(`<span foreground="${LINE_NUMBER_COLOR}">${num}</span>`, -1);
    }
  }
}
registerClass(LineNumberRenderer);
