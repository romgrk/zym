/*
 * InlayHintController — LSP inlay hints (parameter names / inferred types) rendered as
 * native end-of-line annotations, per view.
 *
 * The native annotation API is line-anchored (end-of-line), so a line's hints are joined
 * and trailed after the line rather than placed at their exact column — "simple
 * end-of-line inlay hints" per tasks/code-editing/virtual-lines.md. (Mid-line placement
 * would need the gap-tag + overlay recipe.) Like everything annotation-based, this is
 * per-view thanks to the A2 document-model: each view has its own buffer.
 *
 * Refetches the whole document (debounced) on edits + on demand; cheap timeout-bounded
 * LSP request. Gated by `editor.inlayHints`.
 */
import { GLib, type SourceView } from '../../gi.ts';
import { quilx } from '../../quilx.ts';
import { AnnotationController } from './AnnotationController.ts';
import type { LspDocument } from '../../lsp/LspManager.ts';

const DEBOUNCE_MS = 400;

export class InlayHintController {
  private readonly annotations: AnnotationController;
  private readonly getDoc: () => LspDocument | null;
  private timer = 0;
  private seq = 0; // drops stale async responses
  private disposed = false;

  constructor(view: SourceView, getDoc: () => LspDocument | null) {
    this.annotations = new AnnotationController(view);
    this.getDoc = getDoc;
  }

  /** Recompute after a short idle (coalesces a burst of edits into one request). */
  scheduleRefresh(): void {
    if (this.timer) GLib.sourceRemove(this.timer);
    this.timer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
      this.timer = 0;
      void this.refresh();
      return GLib.SOURCE_REMOVE;
    });
  }

  /** Fetch inlay hints for the whole document and render them end-of-line per line. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    if (quilx.config.get('editor.inlayHints') === false) {
      this.annotations.clear();
      return;
    }
    const doc = this.getDoc();
    if (!doc) {
      this.annotations.clear();
      return;
    }
    const token = ++this.seq;
    const hints = await quilx.lsp.inlayHints(doc);
    if (this.disposed || token !== this.seq) return; // superseded by a newer request

    // One annotation per line: join that line's hint labels (e.g. `a: b: number`).
    const byLine = new Map<number, string[]>();
    for (const hint of hints) {
      const labels = byLine.get(hint.line);
      if (labels) labels.push(hint.label);
      else byLine.set(hint.line, [hint.label]);
    }
    this.annotations.setAnnotations(
      [...byLine.entries()].map(([line, labels]) => ({ line, text: labels.join(' '), style: 'none' as const })),
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) GLib.sourceRemove(this.timer);
    this.timer = 0;
    this.annotations.dispose();
  }
}
