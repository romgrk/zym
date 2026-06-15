/*
 * SideBySideDiffView — a two-column (old | new) diff pane. From a `DiffModel`,
 * `splitSides` produces two line-aligned, equally-tall line arrays (each changed
 * row paired, the shorter side padded with blank fillers). Each side is a
 * read-only buffer pane with its own line backgrounds (`removed`/`added`/`filler`)
 * and a `+`/`−` gutter; the two views' vertical scroll is hard-locked.
 *
 * Equal line counts + no wrapping mean row N sits at the same pixel y on both
 * sides, so scroll-sync is a value copy. Built at runtime (vfunc gutter); the
 * assembled widget is `root`. See tasks/code-editing/diff.md.
 */
import { Gtk, type SourceView } from '../../gi.ts';
import { TextEditor } from './TextEditor.ts';
import { DiffGutter } from './DiffGutter.ts';
import { applyDiffDecorations } from './applyDiffDecorations.ts';
import { splitSides, type DiffModel, type SideLine } from '../../util/DiffModel.ts';

export class SideBySideDiffView {
  readonly root: InstanceType<typeof Gtk.Paned>;
  private readonly left: TextEditor;
  private readonly right: TextEditor;
  private readonly gutters: DiffGutter[];

  constructor(model: DiffModel) {
    const { left, right } = splitSides(model);
    this.left = makePane(left);
    this.right = makePane(right);
    this.gutters = [new DiffGutter(this.left.sourceView, left), new DiffGutter(this.right.sourceView, right)];

    syncScroll(this.left.sourceView, this.right.sourceView);

    this.root = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
    this.root.setStartChild(this.left.root);
    this.root.setEndChild(this.right.root);
    this.root.setResizeStartChild(true);
    this.root.setResizeEndChild(true);
    this.root.setWideHandle(true);
  }

  dispose(): void {
    for (const gutter of this.gutters) gutter.dispose();
  }
}

/** A read-only pane for one side, with per-line diff backgrounds applied. */
function makePane(lines: SideLine[]): TextEditor {
  const editor = new TextEditor({ buffer: { readOnly: true, initialText: lines.map((l) => l.text).join('\n') } });
  applyDiffDecorations(editor.decorations.layer('diff'), lines);
  return editor;
}

/** Hard-lock the two views' vertical scroll (value copy, reentrancy-guarded). */
function syncScroll(a: SourceView, b: SourceView): void {
  const adjA = (a as any).getVadjustment?.();
  const adjB = (b as any).getVadjustment?.();
  if (!adjA || !adjB) return;
  let syncing = false;
  const link = (from: any, to: any) =>
    from.on('value-changed', () => {
      if (syncing) return;
      syncing = true;
      to.setValue(from.getValue());
      syncing = false;
    });
  link(adjA, adjB);
  link(adjB, adjA);
}
