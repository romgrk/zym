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
import { fonts } from '../../fonts.ts';
import { markdownToPango } from '../markdownMarkup.ts';
import { escapeMarkup, markupLabel, clearChildren, setLineHeight } from '../proseMarkup.ts';
import { iconLabel } from '../icons.ts';
import { NERDFONT } from '../nerdfont.ts';
import { clipboard } from '../TextEditor/vim/clipboard.ts';
import { highlightToMarkup } from '../../syntax/highlightToMarkup.ts';
import { parseBlocks, type Block, type ListItem } from './blocks.ts';

type Widget = InstanceType<typeof Gtk.Widget>;
const COPY_GLYPH = NERDFONT.ACTION.COPY;

// Colors as CSS variables (--t-ui-*); code blocks read the font store's monospace
// family (--t-font-monospace-family). See docs/styling.md.
addStyles(/* css */`
  .zym-md { }
  .zym-md-code {
    background: var(--view-bg-color);
    padding: 8px 10px;
    border-radius: 6px;
    font-family: var(--t-font-monospace-family);
  }
  .zym-md-quote {
    border-left: 3px solid var(--border-color);
    padding-left: 10px;
    opacity: 0.85;
  }
  .zym-md-table {
    border-top: 1px solid var(--border-color);
    border-left: 1px solid var(--border-color);
    border-radius: 4px;
  }
  .zym-md-th, .zym-md-cell {
    border-right: 1px solid var(--border-color);
    border-bottom: 1px solid var(--border-color);
    padding: 4px 10px;
  }
  .zym-md-th { font-weight: bold; }
  .zym-md-copy { 
    margin: 8px;
    opacity: 0.45;
  }
  .zym-md-copy:hover { opacity: 1; }
  
  /* Breathing room between block widgets. NOTE: consecutive prose blocks are merged
     into a single .zym-md-flow label, so prose spacing (paragraphs, headings, lists)
     is governed by LINE_HEIGHT and the blank-line joins below — not these margins.
     Only code blocks and tables are standalone widgets these margins reach. */
  .zym-md-code { margin: 6px 0; }
  .zym-md-table { margin: 6px 0; }
`);

// Prose line spacing: looser than a single-line label so wrapped paragraphs are
// comfortable to read.
const LINE_HEIGHT = 1.4

// Inter-block separators inside the merged prose label. Most blocks are split by a
// full blank line; a heading instead hugs the block beneath it via a blank line with
// a small line-height (a heading reads as a label for the body that follows it).
// There is no per-paragraph margin in a single Pango label, so spacing is done with
// these blank lines — see the .zym-md-flow note in the stylesheet above.
const BLOCK_GAP = '\n\n';
const HEADING_GAP = '\n<span line_height="0.35"> </span>\n';

// Pango named sizes per heading level (1..6).
const HEADING_SIZE = ['x-large', 'large', 'large', 'medium', 'medium', 'small'];

export class MarkdownView {
  readonly root: InstanceType<typeof Gtk.Box>;
  private lastMarkdown = ''; // the source last rendered, for "copy message"

  constructor() {
    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    this.root.addCssClass('zym-md');
  }

  /** The markdown source last passed to `setMarkdown` (for copy-to-clipboard). */
  getMarkdown(): string { return this.lastMarkdown; }

  /** Replace the rendered content with `md`.
   *
   * Consecutive prose blocks (headings, paragraphs, lists, quotes, rules) are
   * merged into ONE label so the user can drag-select across all of them at once
   * (GTK can't select across separate widgets). Tables and code blocks render as
   * their own widgets — they're selection "islands", but each is independently
   * selectable. */
  setMarkdown(md: string): void {
    this.lastMarkdown = md;
    clearChildren(this.root);
    // Track each prose block's type alongside its markup so the join can pick a
    // tighter gap after a heading (see HEADING_GAP).
    let flow: Array<{ type: string; markup: string }> = [];
    const flush = () => {
      if (flow.length === 0) return;
      let markup = flow[0].markup;
      for (let i = 1; i < flow.length; i++) {
        markup += (flow[i - 1].type === 'heading' ? HEADING_GAP : BLOCK_GAP) + flow[i].markup;
      }
      const label = markupLabel(markup, markup);
      label.addCssClass('zym-md-flow');
      this.root.append(label);
      flow = [];
    };
    for (const block of parseBlocks(md)) {
      if (block.type === 'code') { flush(); this.root.append(renderCode(block.lang, block.code)); }
      else if (block.type === 'table') { flush(); this.root.append(renderTable(block.headers, block.aligns, block.rows)); }
      else flow.push({ type: block.type, markup: blockMarkup(block) });
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
      return setLineHeight(inline(block.text), LINE_HEIGHT);
    case 'list':
      return setLineHeight(listMarkup(block.ordered, block.items, 0), LINE_HEIGHT);
    case 'blockquote':
      return setLineHeight(blockquoteMarkup(block.blocks), LINE_HEIGHT);
    case 'hr':
      return `<span alpha="55%">────────────────</span>`;
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
  const bar = `<span alpha="55%">│</span> `;
  return inner.split('\n').map((line) => bar + line).join('\n');
}

function renderCode(lang: string | undefined, code: string): Widget {
  const inner = safeHighlight(code, lang) ?? escapeMarkup(code);
  const markup = `<span face="${attrEscape(fonts.monospaceFamily)}">${inner}</span>`;
  const label = markupLabel(markup, code);
  label.setSelectable(true);

  // A small copy button floated in the top-right corner via an overlay, so it
  // doesn't take a header row. It sits flush in the corner (no margin).
  const copy = new Gtk.Button();
  copy.addCssClass('flat');
  copy.addCssClass('zym-md-copy');
  copy.setChild(iconLabel(COPY_GLYPH));
  copy.setTooltipText('Copy');
  copy.setHalign(Gtk.Align.END);
  copy.setValign(Gtk.Align.START);
  copy.marginTop = 8
  copy.marginEnd = 8
  copy.on('clicked', () => { clipboard.write(code); copy.setTooltipText('Copied'); });

  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  box.addCssClass('zym-md-code');
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
  grid.addCssClass('zym-md-table');
  grid.setHalign(Gtk.Align.START);
  headers.forEach((header, col) => {
    grid.attach(cell(header, aligns[col], 'zym-md-th'), col, 0, 1, 1);
  });
  rows.forEach((cells, r) => {
    for (let col = 0; col < headers.length; col++) {
      grid.attach(cell(cells[col] ?? '', aligns[col], 'zym-md-cell'), col, r + 1, 1, 1);
    }
  });
  return grid;
}

function cell(text: string, align: 'left' | 'center' | 'right' | null, cssClass: string): Widget {
  const label = markupLabel(inline(text), text);
  label.addCssClass(cssClass);
  // FILL both axes so the cell's border delimits the whole grid cell rather than
  // shrink-wrapping the text; the text is positioned WITHIN the cell via xalign
  // (the column's alignment) and yalign (top, so a wrapping cell doesn't centre its
  // row's other cells).
  label.setHalign(Gtk.Align.FILL);
  label.setValign(Gtk.Align.FILL);
  label.setXalign(align === 'right' ? 1 : align === 'center' ? 0.5 : 0);
  label.setYalign(0);
  return label;
}

// --- helpers -----------------------------------------------------------------

// Inline markdown → Pango markup, with the app monospace font for inline code,
// dimmed to 70% alpha to set code spans apart from the prose (no color shift).
function inline(text: string): string {
  return markdownToPango(text, { codeFontFamily: fonts.monospaceFamily, codeAlpha: '70%' });
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

