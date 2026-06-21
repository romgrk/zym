/*
 * MarkupCard — the content of a floating card (inside an `EditorPopover`): a wrapping
 * `Gtk.Label` that renders either a markdown string (LSP hover / doc) or pre-built Pango
 * markup (a signature, a git-blame line). Code spans use the editor monospace font and
 * fenced blocks are syntax-highlighted via `highlight` (tree-sitter, editor-supplied).
 * Shared by the hover, signature, and completion-doc cards so they render identically.
 */
import { Gtk } from '../../gi.ts';
import { fonts } from '../../fonts.ts';
import { markdownToPango } from '../markdownMarkup.ts';
import { setMarkupSafe } from '../proseMarkup.ts';

/** Syntax-highlight a fenced code block to Pango markup; null falls back to plain code. */
export type CodeHighlighter = (code: string, lang: string | undefined) => string | null;

export interface MarkupCardOptions {
  /** Fixed min width (px); the label wraps to it. */
  widthPx?: number;
  /** Highlighter for fenced code blocks (omitted → Pango generic monospace). */
  highlight?: CodeHighlighter;
}

export class MarkupCard {
  /** The label widget — set as an `EditorPopover` child; style/align via its caller. */
  readonly label: InstanceType<typeof Gtk.Label>;
  private readonly highlight?: CodeHighlighter;

  constructor(opts: MarkupCardOptions = {}) {
    this.label = new Gtk.Label({ useMarkup: true, wrap: true, xalign: 0 });
    if (opts.widthPx) this.label.setSizeRequest(opts.widthPx, -1);
    this.highlight = opts.highlight;
  }

  /** Render a markdown string (LSP hover/doc) — code mono + fenced blocks highlighted. */
  setMarkdown(md: string): void {
    setMarkupSafe(this.label, markdownToPango(md, { codeFontFamily: fonts.monospaceFamily, highlightCode: this.highlight }), md);
  }

  /** Set pre-built Pango markup (e.g. a signature, a git-blame line). */
  setMarkup(markup: string, fallback = ''): void {
    setMarkupSafe(this.label, markup, fallback);
  }

  clear(): void {
    this.label.setText('');
  }
}
