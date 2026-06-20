/*
 * markdown/blocks.ts — a pragmatic block-level markdown parser.
 *
 * The shared `markdownMarkup.ts` (markdownToPango) stays a small, fast inline
 * renderer for hovers and other simple call sites. The conversation view needs
 * real block structure — headings, lists (ordered / unordered / nested), GFM
 * tables, fenced code, blockquotes, rules — which can't live in one Pango label
 * (tables in particular need widget layout). This parser splits a markdown string
 * into a flat block sequence; `MarkdownView` renders each block to a widget,
 * reusing `markdownToPango` for the *inline* content of each leaf.
 *
 * Not CommonMark-complete — it covers the usual cases an agent emits. Inline
 * markup inside blocks is left as raw text for the renderer to convert.
 */

export interface ListItem {
  /** The item's own inline text (raw markdown). */
  text: string;
  /** Nested blocks (a sub-list, mostly). */
  children: Block[];
}

export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lang?: string; code: string }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | { type: 'table'; headers: string[]; aligns: Array<'left' | 'center' | 'right' | null>; rows: string[][] }
  | { type: 'blockquote'; blocks: Block[] }
  | { type: 'hr' };

const FENCE = /^(\s*)(```+|~~~+)(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const BLOCKQUOTE = /^\s*>\s?(.*)$/;
const LIST_MARKER = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Parse a markdown string into a flat sequence of blocks. */
export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').replace(/\t/g, '    ').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop(); // drop the final-newline artifact
  return parseLines(lines, 0).blocks;
}

// Parse blocks until a line dedents below `minIndent` (used for blockquote/list
// nesting, where the caller has stripped a prefix). Top level uses minIndent 0.
function parseLines(lines: string[], minIndent: number): { blocks: Block[]; next: number } {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    if (indentOf(line) < minIndent && !LIST_MARKER.test(line)) break;

    const fence = line.match(FENCE);
    if (fence) { const r = parseFence(lines, i); blocks.push(r.block); i = r.next; continue; }

    const heading = line.match(HEADING);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] }); i++; continue; }

    if (HR.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    if (isTableStart(lines, i)) { const r = parseTable(lines, i); blocks.push(r.block); i = r.next; continue; }

    if (BLOCKQUOTE.test(line)) { const r = parseBlockquote(lines, i); blocks.push(r.block); i = r.next; continue; }

    if (LIST_MARKER.test(line)) { const r = parseList(lines, i); blocks.push(r.block); i = r.next; continue; }

    const r = parseParagraph(lines, i);
    blocks.push(r.block);
    i = r.next;
  }
  return { blocks, next: i };
}

function indentOf(line: string): number {
  return line.length - line.replace(/^\s+/, '').length;
}

function parseFence(lines: string[], start: number): { block: Block; next: number } {
  const m = lines[start].match(FENCE)!;
  const lang = m[3].trim().split(/\s+/)[0] || undefined;
  const closer = m[2][0]; // ` or ~
  let i = start + 1;
  const code: string[] = [];
  while (i < lines.length && !new RegExp(`^\\s*${closer === '`' ? '```+' : '~~~+'}\\s*$`).test(lines[i])) {
    code.push(lines[i]);
    i++;
  }
  i++; // skip the closing fence (or run off the end on an unterminated block)
  return { block: { type: 'code', lang, code: code.join('\n') }, next: i };
}

function parseParagraph(lines: string[], start: number): { block: Block; next: number } {
  const text: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') break;
    // A paragraph ends where another block begins.
    if (FENCE.test(line) || HEADING.test(line) || HR.test(line) || BLOCKQUOTE.test(line) || LIST_MARKER.test(line)) break;
    if (isTableStart(lines, i)) break;
    text.push(line.trim());
    i++;
  }
  return { block: { type: 'paragraph', text: text.join('\n') }, next: i };
}

function parseBlockquote(lines: string[], start: number): { block: Block; next: number } {
  const inner: string[] = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(BLOCKQUOTE);
    if (m) { inner.push(m[1]); i++; continue; }
    if (lines[i].trim() === '') break; // blank ends the quote
    break;
  }
  return { block: { type: 'blockquote', blocks: parseLines(inner, 0).blocks }, next: i };
}

// --- lists -------------------------------------------------------------------

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = lines[start].match(LIST_MARKER)!;
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: ListItem[] = [];
  let i = start;

  while (i < lines.length) {
    if (lines[i].trim() === '') {
      // A blank line continues the list only if a same-or-deeper item follows.
      const next = nextNonBlank(lines, i + 1);
      const m = next !== -1 ? lines[next].match(LIST_MARKER) : null;
      if (m && m[1].length >= baseIndent) { i = next; continue; }
      break;
    }
    const m = lines[i].match(LIST_MARKER);
    if (m && m[1].length === baseIndent) {
      items.push({ text: m[3], children: [] });
      i++;
      continue;
    }
    if (m && m[1].length > baseIndent && items.length > 0) {
      const nested = parseList(lines, i); // a deeper marker → sub-list on the last item
      items[items.length - 1].children.push(nested.block);
      i = nested.next;
      continue;
    }
    if (indentOf(lines[i]) > baseIndent && items.length > 0) {
      // Continuation text of the current item (lazy/indented paragraph).
      items[items.length - 1].text += '\n' + lines[i].trim();
      i++;
      continue;
    }
    break; // dedent / non-list line ends the list
  }
  return { block: { type: 'list', ordered, items }, next: i };
}

function nextNonBlank(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) if (lines[i].trim() !== '') return i;
  return -1;
}

// --- tables ------------------------------------------------------------------

function isTableStart(lines: string[], i: number): boolean {
  return i + 1 < lines.length && lines[i].includes('|') && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].includes('-');
}

function parseTable(lines: string[], start: number): { block: Block; next: number } {
  const headers = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map(alignmentOf);
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
    rows.push(splitRow(lines[i]));
    i++;
  }
  return { block: { type: 'table', headers, aligns, rows }, next: i };
}

// Split a table row into cells: drop the optional leading/trailing pipe, split on
// unescaped `|`, trim. (Escaped `\|` is preserved as a literal pipe.)
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function alignmentOf(delim: string): 'left' | 'center' | 'right' | null {
  const left = delim.startsWith(':');
  const right = delim.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}
