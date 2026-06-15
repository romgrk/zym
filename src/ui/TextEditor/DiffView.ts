/*
 * DiffView — a unified (inline) diff pane. Given a `DiffModel`, it synthesizes a
 * read-only buffer whose lines ARE the diff (context + removed + added, in file
 * order — see tasks/code-editing/diff.md), then paints `added`/`removed` line
 * backgrounds via the editor's decoration surface and a `+`/`−` `DiffGutter`.
 *
 * It reuses the buffer-only `TextEditor` (read-only), so it gets vim navigation,
 * search, and the decoration/gutter plumbing for free. Construct at runtime (the
 * gutter renderer is a node-gtk vfunc subclass); the assembled widget is `root`.
 */
import type { Gtk } from '../../gi.ts';
import { TextEditor } from './TextEditor.ts';
import { DiffGutter } from './DiffGutter.ts';
import { applyDiffDecorations } from './applyDiffDecorations.ts';
import type { DiffModel } from '../../util/DiffModel.ts';

export class DiffView {
  readonly root: InstanceType<typeof Gtk.Box>;
  private readonly editor: TextEditor;
  private readonly gutter: DiffGutter;

  constructor(model: DiffModel) {
    const text = model.lines.map((line) => line.text).join('\n');
    this.editor = new TextEditor({ buffer: { readOnly: true, initialText: text } });
    this.root = this.editor.root;

    applyDiffDecorations(this.editor.decorations.layer('diff'), model.lines);
    this.gutter = new DiffGutter(this.editor.sourceView, model.lines);
  }

  dispose(): void {
    this.gutter.dispose();
  }
}
