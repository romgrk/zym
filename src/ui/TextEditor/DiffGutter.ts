/*
 * DiffGutter — a left-gutter renderer for a unified (inline) diff pane: a `+` on
 * added lines and a `−` on removed lines, blank on context. Mirrors `GitGutter`
 * (a `GtkSource.GutterRendererText` subclass reading a per-line map), but driven
 * by a static `DiffModel.lines` array rather than a live re-diff.
 *
 * The renderer subclass is instantiated only at runtime (after the GTK main loop
 * starts), per the node-gtk vfunc constraint.
 */
import { Gtk, GtkSource, registerClass, type SourceView } from '../../gi.ts';

/** Anything with a diff `kind` — a unified `DiffLine` or a side-by-side `SideLine`. */
interface KindedLine {
  kind: string;
}

const GLYPH: Record<'added' | 'removed', string> = { added: '+', removed: '−' };
const COLOR: Record<'added' | 'removed', string> = { added: '#2ec27e', removed: '#e01b24' };

class DiffGutterRenderer extends GtkSource.GutterRendererText {
  // Assigned after construction; read on every draw. (line is 0-based.)
  kindByLine!: Map<number, 'added' | 'removed'>;

  queryData(_lines: any, line: number) {
    const kind = this.kindByLine?.get(line);
    if (!kind) {
      this.setMarkup(' ', -1);
      return;
    }
    this.setMarkup(`<span foreground="${COLOR[kind]}">${GLYPH[kind]}</span>`, -1);
  }
}
registerClass(DiffGutterRenderer);

export class DiffGutter {
  private readonly view: SourceView;
  private readonly renderer: DiffGutterRenderer;
  private readonly kindByLine = new Map<number, 'added' | 'removed'>();

  constructor(view: SourceView, lines: readonly KindedLine[]) {
    this.view = view;
    lines.forEach((line, row) => {
      if (line.kind === 'added' || line.kind === 'removed') this.kindByLine.set(row, line.kind);
    });

    this.renderer = new DiffGutterRenderer();
    (this.renderer as any).kindByLine = this.kindByLine;
    (this.view as any).getGutter(Gtk.TextWindowType.LEFT).insert(this.renderer, 0);
  }

  dispose(): void {
    (this.view as any).getGutter(Gtk.TextWindowType.LEFT).remove(this.renderer);
  }
}
