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
import { escapeMarkup, markupLabel, clearChildren } from '../proseMarkup.ts';
import { iconLabel } from '../icons.ts';
import { NERDFONT } from '../nerdfont.ts';
import { clipboard } from '../TextEditor/vim/clipboard.ts';
import { highlightToMarkup } from '../../syntax/highlightToMarkup.ts';
import { parseBlocks, type Block, type ListItem } from './blocks.ts';

type Widget = InstanceType<typeof Gtk.Widget>;
const COPY_GLYPH = NERDFONT.ACTION.COPY;

// Colors as CSS variables (--t-ui-*); code blocks read the font store's monospace
// family (--t-font-monospace-family). See tasks/styling.md.
addStyles(`
  .quilx-md { }
  .quilx-md-code {
    background: var(--t-ui-surface-popover);
    padding: 8px 10px;
    border-radius: 6px;
    font-family: var(--t-font-monospace-family);
  }
  .quilx-md-quote {
    border-left: 3px solid var(--t-ui-border);
    padding-left: 10px;
    opacity: 0.85;
  }
  .quilx-md-table { }
  .quilx-md-th { font-weight: bold; padding: 3px 10px 3px 0; }
  .quilx-md-cell { padding: 3px 10px 3px 0; }
  .quilx-md-copy { padding: 2px 6px; margin: 4px; min-height: 0; min-width: 0; opacity: 0.45; }
  .quilx-md-copy:hover { opacity: 1; }
  /* Breathing room between blocks. */
  .quilx-md-heading { margin-top: 6px; margin-bottom: 2px; }
  .quilx-md-para { margin: 2px 0; }
  .quilx-md-code { margin: 4px 0; }
  .quilx-md-table { margin: 4px 0; }
  .quilx-md-list { margin: 2px 0; }
  .quilx-md-quote { margin: 4px 0; }
`);

// Pango named sizes per heading level (1..6).
const HEADING_SIZE = ['x-large', 'large', 'large', 'medium', 'medium', 'small'];

export class MarkdownView {
  readonly root: InstanceType<typeof Gtk.Box>;

  constructor() {
    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
    this.root.addCssClass('quilx-md');
  }

  /** Replace the rendered content with `md`.
   *
   * Consecutive prose blocks (headings, paragraphs, lists, quotes, rules) are
   * merged into ONE label so the user can drag-select across all of them at once
   * (GTK can't select across separate widgets). Tables and code blocks render as
   * their own widgets — they're selection "islands", but each is independently
   * selectable. */
  setMarkdown(md: string): void {
    clearChildren(this.root);
    let flow: string[] = [];
    const flush = () => {
      if (flow.length === 0) return;
      const markup = flow.join('\n\n');
      const label = markupLabel(markup, markup);
      label.addCssClass('quilx-md-flow');
      this.root.append(label);
      flow = [];
    };
    for (const block of parseBlocks(md)) {
      if (block.type === 'code') { flush(); this.root.append(renderCode(block.lang, block.code)); }
      else if (block.type === 'table') { flush(); this.root.append(renderTable(block.headers, block.aligns, block.rows)); }
      else flow.push(blockMarkup(block));
    }
    flush();
  }

  dispose(): void {
    clearChildren(this.root);
  }
}

// --- block rendering ---------------------------------------------------------

// Pango markup for a prose block (everything except code/table, which are widgets).
function blockMarkup(block: Block): string {
  switch (block.type) {
    case 'heading':
      return `<span size="${HEADING_SIZE[block.level - 1] ?? 'medium'}" weight="bold">${inline(block.text)}</span>`;
    case 'paragraph':
      return inline(block.text);
    case 'list':
      return listMarkup(block.ordered, block.items, 0);
    case 'blockquote':
      return blockquoteMarkup(block.blocks);
    case 'hr':
      return `<span foreground="${attrEscape(theme.ui.text.muted)}">────────────────</span>`;
    default:
      return ''; // code / table are rendered as widgets in setMarkdown
  }
}

// A list as markup lines (bullets / numbers), nested lists indented.
function listMarkup(ordered: boolean, items: ListItem[], depth: number): string {
  const indent = '    '.repeat(depth);
  const out: string[] = [];
  items.forEach((item, i) => {
    out.push(`${indent}${ordered ? `${i + 1}.` : '•'} ${inline(item.text)}`);
    for (const child of item.children) {
      if (child.type === 'list') out.push(listMarkup(child.ordered, child.items, depth + 1));
      else out.push(indent + '    ' + blockMarkup(child));
    }
  });
  return out.join('\n');
}

// A blockquote as markup: each line prefixed with a muted bar.
function blockquoteMarkup(blocks: Block[]): string {
  const inner = blocks
    .filter((b) => b.type !== 'code' && b.type !== 'table')
    .map(blockMarkup)
    .join('\n');
  const bar = `<span foreground="${attrEscape(theme.ui.text.muted)}">│</span> `;
  return inner.split('\n').map((line) => bar + line).join('\n');
}

function renderCode(lang: string | undefined, code: string): Widget {
  const inner = safeHighlight(code, lang) ?? escapeMarkup(code);
  const markup = `<span face="${attrEscape(fonts.monospaceFamily)}">${inner}</span>`;
  const label = markupLabel(markup, code);
  label.setSelectable(true);

  // A small copy button in the top-right corner.
  const copy = new Gtk.Button();
  copy.addCssClass('flat');
  copy.addCssClass('quilx-md-copy');
  copy.setChild(iconLabel(COPY_GLYPH));
  copy.setTooltipText('Copy');
  copy.setHalign(Gtk.Align.END);
  copy.setValign(Gtk.Align.START);
  copy.on('clicked', () => { clipboard.write(code); copy.setTooltipText('Copied'); });

  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  box.addCssClass('quilx-md-code');
  box.append(label);

  // Overlay the button so it doesn't take a header row.
  const overlay = new Gtk.Overlay();
  overlay.setChild(box);
  overlay.addOverlay(copy);
  return overlay;
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

// --- helpers -----------------------------------------------------------------

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

