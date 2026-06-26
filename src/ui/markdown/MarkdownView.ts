/*
 * MarkdownView — a thin adapter that preserves the prior column-of-labels API
 * (root / setMarkdown / getMarkdown / dispose) on top of the native render-node
 * MarkdownRenderer widget (see ./MarkdownRenderer.ts).
 *
 * The whole document is now ONE Gtk.Widget that paints via the GSK scene graph, so
 * selection / copy / links span every block — the old per-block Gtk.Label approach
 * couldn't select across blocks. `root` IS that widget. Kept as an adapter so the
 * conversation UI (Message / AgentConversation / toolRows) needs no changes; new
 * code can use `createMarkdownRenderer()` directly.
 */
import { createMarkdownRenderer, type MarkdownRenderer } from './MarkdownRenderer.ts';

export class MarkdownView {
  /** The render-node widget; parent it like any Gtk.Widget. */
  readonly root: MarkdownRenderer;
  private lastMarkdown = ''; // the source last rendered, for "copy message"

  constructor() {
    this.root = createMarkdownRenderer();
    // Preserve the legacy CSS hooks in case any surrounding stylesheet targets them.
    this.root.addCssClass('document');
    this.root.addCssClass('MarkdownView');
  }

  /** The markdown source last passed to `setMarkdown` (for copy-to-clipboard). */
  getMarkdown(): string {
    return this.lastMarkdown;
  }

  setMarkdown(md: string): void {
    this.lastMarkdown = md;
    this.root.setMarkdown(md);
  }

  dispose(): void {
    this.root.teardown();
  }
}
