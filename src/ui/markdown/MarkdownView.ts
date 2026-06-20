/*
 * MarkdownView — renders a markdown string into a column of GTK widgets, one per
 * block (see blocks.ts). Most blocks are Pango-markup labels; tables are real
 * `Gtk.Grid`s (which a single label can't do). Inline content reuses the shared
 * `markdownToPango`; fenced code is syntax-highlighted with tree-sitter via
 * `highlightToMarkup`; code/inline-code use the app monospace font.
 *
 * `setMarkdown(md)` rebuilds the column — cheap for chat-sized messages, and the
 * conversation view calls it on every streaming delta.
 */
import { Gtk } from '../../gi.ts';
import { addStyles } from '../../styles.ts';
import { theme } from '../../theme/theme.ts';
import { fonts } from '../../fonts.ts';
import { markdownToPango } from '../markdownMarkup.ts';
import { escapeMarkup } from '../proseMarkup.ts';
import { highlightToMarkup } from '../../syntax/highlightToMarkup.ts';
import { parseBlocks, type Block, type ListItem } from './blocks.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

addStyles(`
  .quilx-md { }
  .quilx-md-code {
    background: ${theme.ui.surface.popover};
    padding: 8px 10px;
    border-radius: 6px;
  }
  .quilx-md-quote {
    border-left: 3px solid ${theme.ui.border};
    padding-left: 10px;
    opacity: 0.85;
  }
  .quilx-md-table { }
  .quilx-md-th { font-weight: bold; padding: 3px 10px 3px 0; }
  .quilx-md-cell { padding: 3px 10px 3px 0; }
`);
// Code blocks use the app monospace font (not a generic family).
fonts.monospace('.quilx-md-code');

// Pango named sizes per heading level (1..6).
const HEADING_SIZE = ['x-large', 'large', 'large', 'medium', 'medium', 'small'];

export class MarkdownView {
  readonly root: InstanceType<typeof Gtk.Box>;

  constructor() {
    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
    this.root.addCssClass('quilx-md');
  }

  /** Replace the rendered content with `md`. */
  setMarkdown(md: string): void {
    clear(this.root);
    for (const block of parseBlocks(md)) this.root.append(renderBlock(block));
  }

  dispose(): void {
    clear(this.root);
  }
}

// --- block rendering ---------------------------------------------------------

function renderBlock(block: Block): Widget {
  switch (block.type) {
    case 'heading': {
      const markup = `<span size="${HEADING_SIZE[block.level - 1] ?? 'medium'}" weight="bold">${inline(block.text)}</span>`;
      return markupLabel(markup, block.text);
    }
    case 'paragraph':
      return markupLabel(inline(block.text), block.text);
    case 'code':
      return renderCode(block.lang, block.code);
    case 'list':
      return renderList(block.ordered, block.items);
    case 'table':
      return renderTable(block.headers, block.aligns, block.rows);
    case 'blockquote':
      return renderBlockquote(block.blocks);
    case 'hr':
      return new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL });
  }
}

function renderCode(lang: string | undefined, code: string): Widget {
  const inner = safeHighlight(code, lang) ?? escapeMarkup(code);
  const markup = `<span face="${attrEscape(fonts.monospaceFamily)}">${inner}</span>`;
  const label = markupLabel(markup, code);
  label.setSelectable(true);
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  box.addCssClass('quilx-md-code');
  box.append(label);
  return box;
}

function renderList(ordered: boolean, items: ListItem[]): Widget {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
  items.forEach((item, index) => {
    const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    const marker = new Gtk.Label({ label: ordered ? `${index + 1}.` : '•', xalign: 0 });
    marker.setValign(Gtk.Align.START);
    const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true });
    content.append(markupLabel(inline(item.text), item.text));
    for (const child of item.children) {
      const childWidget = renderBlock(child);
      childWidget.setMarginStart(12); // indent nested blocks
      content.append(childWidget);
    }
    row.append(marker);
    row.append(content);
    box.append(row);
  });
  return box;
}

function renderTable(
  headers: string[],
  aligns: Array<'left' | 'center' | 'right' | null>,
  rows: string[][],
): Widget {
  const grid = new Gtk.Grid({ columnSpacing: 0, rowSpacing: 0 });
  grid.addCssClass('quilx-md-table');
  grid.setHalign(Gtk.Align.START);
  headers.forEach((header, col) => {
    grid.attach(cell(header, aligns[col], 'quilx-md-th'), col, 0, 1, 1);
  });
  rows.forEach((cells, r) => {
    for (let col = 0; col < headers.length; col++) {
      grid.attach(cell(cells[col] ?? '', aligns[col], 'quilx-md-cell'), col, r + 1, 1, 1);
    }
  });
  return grid;
}

function cell(text: string, align: 'left' | 'center' | 'right' | null, cssClass: string): Widget {
  const label = markupLabel(inline(text), text);
  label.addCssClass(cssClass);
  label.setHalign(align === 'right' ? Gtk.Align.END : align === 'center' ? Gtk.Align.CENTER : Gtk.Align.START);
  label.setXalign(align === 'right' ? 1 : align === 'center' ? 0.5 : 0);
  return label;
}

function renderBlockquote(blocks: Block[]): Widget {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
  box.addCssClass('quilx-md-quote');
  for (const block of blocks) box.append(renderBlock(block));
  return box;
}

// --- helpers -----------------------------------------------------------------

// A wrapped, selectable label rendered from Pango markup, falling back to plain
// text (`fallback`) if Pango rejects the markup.
function markupLabel(markup: string, fallback: string): InstanceType<typeof Gtk.Label> {
  const label = new Gtk.Label({ xalign: 0, wrap: true, selectable: true });
  try {
    label.setMarkup(markup);
  } catch {
    label.setText(fallback);
  }
  return label;
}

// Inline markdown → Pango markup, with the app monospace font for inline code.
function inline(text: string): string {
  return markdownToPango(text, { codeFontFamily: fonts.monospaceFamily });
}

// Tree-sitter highlight, null on unsupported language or any failure (→ plain code).
function safeHighlight(code: string, lang: string | undefined): string | null {
  if (!lang) return null;
  try {
    return highlightToMarkup(code, lang);
  } catch {
    return null;
  }
}

function attrEscape(text: string): string {
  return escapeMarkup(text).replace(/"/g, '&quot;');
}

// Remove every child of a box (GTK4 has no clear()).
function clear(box: InstanceType<typeof Gtk.Box>): void {
  let child = box.getFirstChild();
  while (child) {
    const next = child.getNextSibling();
    box.remove(child);
    child = next;
  }
}
