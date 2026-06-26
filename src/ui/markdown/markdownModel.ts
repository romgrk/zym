/*
 * markdownModel — parse a markdown string into a flat, render-ready block IR for
 * the native MarkdownRenderer widget (see ./MarkdownRenderer.ts and
 * docs/ui/markdown-renderer.md).
 *
 * Block structure comes from `marked`'s lexer (token AST, NOT its HTML); we walk
 * the tokens ourselves. Nesting (lists, blockquotes) is FLATTENED here into a
 * linear sequence of blocks carrying an `indent` level and a `quoteDepth`, so the
 * widget's layout pass is a simple vertical stack — every selectable text run is
 * one `MdSegment` with three parallel views of the same content:
 *   - `markup`  — Pango markup the layout renders,
 *   - `plain`   — the visible text (EXACTLY the laid-out layout's text, so Pango
 *                 byte offsets from xy_to_index map back into it for selection),
 *   - `links`   — clickable ranges as [start,end) byte offsets into `plain`.
 *
 * Inline tokens (emphasis, code, links, images) are walked into those three views
 * together (see InlineBuilder). Images render as a muted alt-text placeholder (v1).
 */
import { marked, type Token, type Tokens } from 'marked';
import { theme, resolveSyntaxColor } from '../../theme/theme.ts';
import { fonts } from '../../fonts.ts';
import { Pango, PangoCairo } from '../../gi.ts';
import { escapeMarkup } from '../proseMarkup.ts';

export type Align = 'left' | 'center' | 'right';

/** A clickable link range, as [start,end) UTF-8 byte offsets into a segment's `plain`. */
export interface LinkSpan {
  start: number;
  end: number;
  href: string;
}

/** One selectable text run: its Pango markup, its visible text, and any link ranges. */
export interface MdSegment {
  markup: string;
  plain: string;
  links: LinkSpan[];
}

/** Vertical spacing (px) reserved above/below a block. */
interface Spacing {
  marginTop: number;
  marginBottom: number;
}

/** Indentation context a block inherits from its enclosing lists/quotes. */
interface Nesting {
  /** List-nesting depth (0 = top level); each level adds INDENT_PX. */
  indent: number;
  /**
   * Enclosing blockquote group ids, outermost first (empty = not quoted). Each
   * blockquote occurrence gets a UNIQUE id (not just a depth), so the renderer can
   * draw ONE continuous bar spanning the whole quote and never merge two adjacent
   * quotes. The array length is the nesting depth.
   */
  quotes: number[];
}

export type MdBlock =
  | (MdSegment &
      Nesting &
      Spacing & {
        kind: 'line';
        /** Monospace (code) vs the inherited UI font. */
        mono: boolean;
        /** A named Pango size (e.g. 'x-large') for headings, or '' for body size. */
        size: string;
        bold: boolean;
        /** A background fill behind the block (fenced code); a hex color or undefined. */
        background?: string;
      })
  | (Nesting &
      Spacing & {
        kind: 'table';
        header: MdSegment[];
        rows: MdSegment[][];
        aligns: Align[];
      })
  | (Nesting & Spacing & { kind: 'hr' });

/** Syntax-highlight a fenced code block to Pango markup, or null to fall back to plain. */
export type HighlightFn = (code: string, lang: string | undefined) => string | null;

// Named Pango sizes per heading level (1..6); relative to the widget's base font.
const HEADING_SIZE = ['xx-large', 'x-large', 'large', 'large', 'medium', 'medium'];

// Harmonized bottom margin between block elements (paragraphs, lists, tables).
const BLOCK_MARGIN = 10;

// Monospace runs (inline code + code blocks) render a touch smaller than the UI
// font: at the same point size a monospace face reads larger AND heavier, which
// unbalances code beside prose. The correction is DETECTED at runtime from both the
// x-height (apparent size) and the stem thickness (apparent weight) of each face, so
// it adapts to ANY UI/monospace pairing instead of a hand-tuned constant. The result
// is a Pango markup `size` percentage (relative to the inherited UI size), memoized
// per font pair.
let monoSizeCache: { key: string; attr: string } | null = null;

export function monoSizeAttr(): string {
  const key = `${fonts.uiFamily}|${fonts.monospaceFamily}`;
  if (monoSizeCache?.key !== key) {
    const pct = Math.round(measureMonoScale(fonts.uiFamily, fonts.monospaceFamily) * 100);
    monoSizeCache = { key, attr: `${pct}%` };
  }
  return monoSizeCache.attr;
}

// Fold two perceptual signals together, weighted equally (geometric mean): the
// x-height ratio (apparent SIZE) and the stem-thickness ratio (apparent WEIGHT — a
// heavier monospace reads larger, which x-height alone misses). Parameter-free and
// clamped; <1 shrinks a mono face that reads bigger/heavier than the prose. For
// Adwaita Sans vs JetBrains Mono this lands ~87% (x-height alone would say 94%).
function measureMonoScale(uiFamily: string, monoFamily: string): number {
  try {
    const ui = faceMetrics(uiFamily);
    const mono = faceMetrics(monoFamily);
    if (ui.xHeight > 0 && mono.xHeight > 0 && ui.stem > 0 && mono.stem > 0) {
      const sizeRatio = ui.xHeight / mono.xHeight;
      const weightRatio = ui.stem / mono.stem;
      return Math.min(1.1, Math.max(0.7, Math.sqrt(sizeRatio * weightRatio)));
    }
  } catch {
    // fontmap/metrics unavailable (e.g. before the display is up) — fall through
  }
  return 0.85;
}

// A face's x-height and stem thickness in Pango units, measured at a large size for
// precision: the inked HEIGHT of 'x' (the x-height) and the inked WIDTH of '|' (a
// clean vertical bar ≈ the stem thickness = stroke weight; '|' has no serifs, unlike
// l/I/i which slab-serifed faces such as JetBrains Mono widen).
function faceMetrics(family: string): { xHeight: number; stem: number } {
  const ctx = PangoCairo.FontMap.getDefault().createContext();
  const layout = Pango.Layout.new(ctx);
  layout.setFontDescription(Pango.FontDescription.fromString(`${family} 256`));
  layout.setText('x', -1);
  const xHeight = layout.getExtents()[0].height;
  layout.setText('|', -1);
  const stem = layout.getExtents()[0].width;
  return { xHeight, stem };
}

// Colors pulled from the active theme (hex, so they're safe in Pango markup attrs).
const LINK_COLOR = theme.ui.text.accent;
const CODE_COLOR = resolveSyntaxColor('markup.raw') ?? theme.ui.text.accent;
const MUTED_COLOR = theme.ui.text.muted;
const CODE_BG = theme.ui.surface.popover;

// Per-document counter handing each blockquote a unique group id (reset per parse).
let quoteSeq = 0;

/** Parse `md` into a flat block IR. `highlight` syntax-colors fenced code (optional). */
export function buildBlocks(md: string, highlight?: HighlightFn): MdBlock[] {
  quoteSeq = 0;
  const tokens = marked.lexer(md);
  const out: MdBlock[] = [];
  walkBlocks(tokens, { indent: 0, quotes: [] }, out, highlight);
  return out;
}

function walkBlocks(tokens: Token[], nest: Nesting, out: MdBlock[], hl?: HighlightFn, inItem = false): void {
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
        break;

      case 'heading': {
        const h = t as Tokens.Heading;
        out.push({
          kind: 'line', ...renderInline(h.tokens), ...nest, mono: false, bold: true,
          size: HEADING_SIZE[h.depth - 1] ?? 'medium',
          // h1/h2 get a bit more breathing room below than the deeper headings.
          marginTop: h.depth <= 2 ? 16 : 12, marginBottom: h.depth <= 2 ? 10 : 6,
        });
        break;
      }

      case 'paragraph': {
        const p = t as Tokens.Paragraph;
        out.push({ kind: 'line', ...renderInline(p.tokens), ...nest, mono: false, bold: false, size: '', marginTop: 0, marginBottom: BLOCK_MARGIN });
        break;
      }

      // A loose text token (list-item content without a wrapping paragraph).
      case 'text': {
        const tx = t as Tokens.Text;
        const seg = tx.tokens ? renderInline(tx.tokens) : plainSegment(tx.text);
        out.push({ kind: 'line', ...seg, ...nest, mono: false, bold: false, size: '', marginTop: 0, marginBottom: 2 });
        break;
      }

      case 'code': {
        const cb = t as Tokens.Code;
        const inner = hl?.(cb.text, cb.lang ?? undefined) ?? escapeMarkup(cb.text);
        out.push({
          kind: 'line', markup: inner, plain: cb.text, links: [], ...nest,
          mono: true, bold: false, size: '', background: CODE_BG, marginTop: 6, marginBottom: 8,
        });
        break;
      }

      case 'blockquote':
        walkBlocks((t as Tokens.Blockquote).tokens, { indent: nest.indent, quotes: [...nest.quotes, ++quoteSeq] }, out, hl);
        break;

      case 'list': {
        renderList(t as Tokens.List, nest, out, hl);
        // A top-level list closes with the harmonized block margin (its items keep
        // their own tight spacing); a list nested inside a list item stays tight —
        // the enclosing list owns the final gap.
        if (!inItem) {
          const last = out[out.length - 1];
          if (last) last.marginBottom = Math.max(last.marginBottom, BLOCK_MARGIN);
        }
        break;
      }

      case 'table': {
        const tb = t as Tokens.Table;
        out.push({
          kind: 'table', ...nest, marginTop: 6, marginBottom: BLOCK_MARGIN,
          aligns: tb.header.map((c) => (c.align ?? 'left') as Align),
          header: tb.header.map((c) => renderInline(c.tokens)),
          rows: tb.rows.map((row) => row.map((c) => renderInline(c.tokens))),
        });
        break;
      }

      case 'hr':
        out.push({ kind: 'hr', ...nest, marginTop: 10, marginBottom: 10 });
        break;

      case 'html':
        // No HTML support: surface the raw markup as escaped monospace text.
        out.push({ kind: 'line', ...plainSegment((t as Tokens.HTML).text.replace(/\n+$/, '')), ...nest, mono: true, bold: false, size: '', marginTop: 0, marginBottom: 8 });
        break;

      default: {
        // Unknown/leaf token: best-effort plain text if it carries any.
        const g = t as Tokens.Generic;
        if (typeof g.text === 'string')
          out.push({ kind: 'line', ...plainSegment(g.text), ...nest, mono: false, bold: false, size: '', marginTop: 0, marginBottom: 8 });
      }
    }
  }
}

// Each list item renders its leading content as one line carrying the bullet/number
// marker; deeper blocks (nested lists, extra paragraphs) recurse one indent level in.
function renderList(list: Tokens.List, nest: Nesting, out: MdBlock[], hl?: HighlightFn): void {
  const start = typeof list.start === 'number' ? list.start : 1;
  list.items.forEach((item, i) => {
    const marker = list.ordered ? `${start + i}.` : '•';
    const sub: MdBlock[] = [];
    walkBlocks(item.tokens, { indent: nest.indent, quotes: nest.quotes }, sub, hl, true);
    const first = sub.find((b) => b.kind === 'line');
    if (first && first.kind === 'line') {
      prependMarker(first, `${marker} `);
      first.marginTop = 1;
      first.marginBottom = Math.min(first.marginBottom, 3);
    } else {
      out.push({ kind: 'line', ...plainSegment(`${marker} `), ...nest, mono: false, bold: false, size: '', marginTop: 1, marginBottom: 3 });
    }
    // Nested blocks that are NOT the marker line indent one level deeper.
    for (const b of sub) {
      if (b !== first && (b.kind === 'line' || b.kind === 'table' || b.kind === 'hr')) b.indent += 1;
      out.push(b);
    }
  });
}

// Prepend a list marker to a segment, shifting its link offsets by the marker's bytes.
function prependMarker(seg: MdSegment, marker: string): void {
  const shift = byteLen(marker);
  seg.markup = escapeMarkup(marker) + seg.markup;
  seg.plain = marker + seg.plain;
  for (const l of seg.links) { l.start += shift; l.end += shift; }
}

// --- inline ------------------------------------------------------------------

function plainSegment(text: string): MdSegment {
  return { markup: escapeMarkup(text), plain: text, links: [] };
}

function renderInline(tokens: Token[] | undefined): MdSegment {
  const b = new InlineBuilder();
  walkInline(tokens ?? [], b);
  return { markup: b.markup, plain: b.plain, links: b.links };
}

function walkInline(tokens: Token[], b: InlineBuilder): void {
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
      case 'html': {
        const tk = t as Tokens.Text;
        if (tk.tokens && tk.tokens.length) walkInline(tk.tokens, b);
        else b.text(tk.text);
        break;
      }
      case 'escape':
        b.text((t as Tokens.Escape).text);
        break;
      case 'strong':
        b.wrap('<b>', '</b>', (t as Tokens.Strong).tokens, b);
        break;
      case 'em':
        b.wrap('<i>', '</i>', (t as Tokens.Em).tokens, b);
        break;
      case 'del':
        b.wrap('<s>', '</s>', (t as Tokens.Del).tokens, b);
        break;
      case 'codespan':
        b.code((t as Tokens.Codespan).text);
        break;
      case 'br':
        b.lineBreak();
        break;
      case 'link': {
        const lk = t as Tokens.Link;
        const start = b.bytes;
        b.open(`<span foreground="${LINK_COLOR}" underline="single">`);
        walkInline(lk.tokens, b);
        b.close('</span>');
        b.links.push({ start, end: b.bytes, href: lk.href });
        break;
      }
      case 'image': {
        const im = t as Tokens.Image;
        b.image(im.text || im.href);
        break;
      }
      default: {
        const g = t as Tokens.Generic;
        if (typeof g.text === 'string') b.text(g.text);
      }
    }
  }
}

// Builds the {markup, plain, links} triple in lock-step: text appends to both
// views and advances the byte cursor; tag open/close touch only the markup.
class InlineBuilder {
  markup = '';
  plain = '';
  bytes = 0;
  links: LinkSpan[] = [];

  text(s: string): void {
    this.markup += escapeMarkup(s);
    this.plain += s;
    this.bytes += byteLen(s);
  }

  open(tag: string): void { this.markup += tag; }
  close(tag: string): void { this.markup += tag; }

  wrap(openTag: string, closeTag: string, tokens: Token[], b: InlineBuilder): void {
    this.open(openTag);
    walkInline(tokens, b);
    this.close(closeTag);
  }

  code(s: string): void {
    this.markup += `<span face="${attrEscape(fonts.monospaceFamily)}" size="${monoSizeAttr()}" foreground="${CODE_COLOR}">${escapeMarkup(s)}</span>`;
    this.plain += s;
    this.bytes += byteLen(s);
  }

  image(alt: string): void {
    const s = `🖼 ${alt}`;
    this.markup += `<span foreground="${MUTED_COLOR}" style="italic">${escapeMarkup(s)}</span>`;
    this.plain += s;
    this.bytes += byteLen(s);
  }

  lineBreak(): void {
    this.markup += '\n';
    this.plain += '\n';
    this.bytes += 1;
  }
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function attrEscape(text: string): string {
  return escapeMarkup(text).replace(/"/g, '&quot;');
}
