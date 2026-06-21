/*
 * DiffView — a unified (inline) diff pane. Given a `DiffModel`, it synthesizes a
 * read-only buffer whose lines ARE the diff (context + removed + added, in file
 * order — see tasks/code-editing/diff.md), then paints `added`/`removed` line
 * backgrounds via the editor's decoration surface and a `+`/`−` `DiffGutter`.
 *
 * Unchanged runs collapse by handing the editor their ranges as *provided folds*
 * — the same fold projection + chevron gutter as code folding, with a
 * `⋯ N unchanged lines` placeholder (see SyntaxController.setProvidedFolds). The
 * vim z-fold commands (zo/zc/za/zr/zm) drive them through the default fold controller.
 *
 * It reuses the buffer-only `TextEditor` (read-only), so it gets vim navigation,
 * search, and the decoration/gutter plumbing for free. Construct at runtime (the
 * gutter renderer is a node-gtk vfunc subclass); the assembled widget is `root`.
 */
import type { Gtk } from '../../gi.ts';
import { TextEditor } from './TextEditor.ts';
import { DiffGutter } from './DiffGutter.ts';
import { DiffLineNumberGutter, oldLineLabels, newLineLabels } from './DiffLineNumberGutter.ts';
import { applyDiffDecorations } from './applyDiffDecorations.ts';
import { revealRow, changeStartRows } from './diffNav.ts';
import { diffBufferText, needsTrailingNewline, foldUnchanged, diffFoldLabel, type DiffModel } from '../../util/DiffModel.ts';

export class DiffView {
  readonly root: InstanceType<typeof Gtk.Box>;
  readonly editor: TextEditor;
  private readonly gutter: DiffGutter;
  private readonly lineNumbers: DiffLineNumberGutter[];
  // Hunk navigation: the (model) row each hunk starts on; `hunkIndex` is the
  // last-revealed hunk (-1 before any navigation).
  private readonly hunkRows: number[];
  private hunkIndex = -1;

  constructor(model: DiffModel, options: { languagePath?: string } = {}) {
    // The buffer is the diff lines verbatim; unchanged runs fold (diff fold method).
    // Terminate the buffer only when the last line is empty and changed (so it can
    // carry its line background) — no spurious trailing blank row otherwise; the
    // decorations span the unterminated last line's content to match.
    const terminated = needsTrailingNewline(model.lines);
    const text = diffBufferText(model.lines, terminated);
    this.editor = new TextEditor({
      buffer: { readOnly: true, initialText: text, languagePath: options.languagePath },
    });
    this.root = this.editor.root;

    applyDiffDecorations(this.editor.decorations.layer('diff'), model.lines, terminated);
    const viewToModel = (line: number) => this.editor.modelLineForViewLine(line);
    const view = this.editor.sourceView;
    // File line numbers as two columns (old | new), left of the +/− mark; each keys
    // by MODEL row, so a queried view line is translated through the folds.
    this.lineNumbers = [
      new DiffLineNumberGutter(view, oldLineLabels(model.lines), viewToModel, 1),
      new DiffLineNumberGutter(view, newLineLabels(model.lines), viewToModel, 2),
    ];
    this.gutter = new DiffGutter(view, model.lines, viewToModel, 3);
    // Collapse the unchanged runs through the fold projection; each marker shows its
    // git-diff-style context line (the enclosing scope), computed from the line texts.
    this.editor.setProvidedFolds(
      foldUnchanged(model.lines).map((f) => ({
        startLine: f.bodyStart,
        endLine: f.bodyEnd,
        whole: true,
        folded: true,
        placeholder: diffFoldLabel(model.lines, f.bodyStart, f.count),
      })),
    );
    this.hunkRows = changeStartRows(model.lines.map((line) => line.kind));
  }

  /** Focus the diff buffer (so vim nav + the fold keys act on it). */
  focus(): void {
    this.editor.focus();
  }

  get hunkCount(): number {
    return this.hunkRows.length;
  }

  nextHunk(): void {
    this.gotoHunk(this.hunkIndex + 1);
  }

  prevHunk(): void {
    this.gotoHunk(this.hunkIndex - 1);
  }

  private gotoHunk(index: number): void {
    if (this.hunkRows.length === 0) return;
    const n = this.hunkRows.length;
    this.hunkIndex = ((index % n) + n) % n;
    // hunkRows are model rows; map to the (folded) view row before scrolling.
    revealRow(this.editor.sourceView, this.editor.viewLineForModelLine(this.hunkRows[this.hunkIndex]));
  }

  dispose(): void {
    this.gutter.dispose();
    for (const gutter of this.lineNumbers) gutter.dispose();
    // Tear the editor down explicitly: on a mode switch the root is detached (not
    // destroyed), so the TextEditor's `destroy` fallback never fires and its global
    // StyleManager handler would otherwise leak.
    this.editor.dispose();
  }
}
