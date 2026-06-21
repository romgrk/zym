/*
 * markdownMarkup — render a markdown string to Pango markup for a Gtk.Label.
 *
 * A deliberately small subset, enough for LSP hover (and reusable elsewhere):
 * fenced and inline code to monospace, bold, italic, headings to bold, bullet
 * lists, links to their text, and horizontal rules to a divider. Everything is
 * Pango-escaped; unsupported constructs degrade to text. Not a CommonMark
 * implementation — block nesting, tables, images, etc. pass through as plain text.
 *
 * Options:
 *  - `codeFontFamily`: monospace family for code spans (e.g. the editor font);
 *    omitted → Pango's generic monospace (`<tt>`).
 *  - `codeColor`: foreground color for code spans (a Pango color, e.g. a hex);
 *    omitted → inherit the surrounding text color.
 *  - `codeAlpha`: foreground alpha for code spans (a Pango alpha, e.g. `70%`), to
 *    dim them relative to the prose; omitted → full opacity.
 *  - `highlightCode(code, lang)`: syntax-highlight a fenced block to Pango markup
 *    (returns null to fall back to plain escaped code). `lang` is the fence's
 *    info string.
 */
import { escapeMarkup } from './proseMarkup.ts';

export interface MarkdownOptions {
  codeFontFamily?: string;
  codeColor?: string;
  codeAlpha?: string;
  highlightCode?: (code: string, lang: string | undefined) => string | null;
}

/** Convert a markdown string to Pango markup. */
export function markdownToPango(md: string, opts: MarkdownOptions = {}): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];

    // Fenced code block: collect raw lines until the closing fence; syntax-
    // highlight if a highlighter is given (else escape plain), in monospace. The
    // ```info string is the language.
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const lang = fence[1].trim().split(/\s+/)[0] || undefined;
      i++;
      const raw: string[] = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) raw.push(lines[i++]);
      i++; // skip the closing fence
      const code = raw.join('\n');
      const inner = opts.highlightCode?.(code, lang) ?? escapeMarkup(code);
      out.push(wrapCode(inner, opts.codeFontFamily, opts.codeColor, opts.codeAlpha));
      continue;
    }

    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      out.push(`<b>${inline(heading[1], opts.codeFontFamily, opts.codeColor, opts.codeAlpha)}</b>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push('──────────');
      i++;
      continue;
    }

    const item = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (item) {
      out.push(`${item[1]}• ${inline(item[2], opts.codeFontFamily, opts.codeColor, opts.codeAlpha)}`);
      i++;
      continue;
    }

    out.push(inline(line, opts.codeFontFamily, opts.codeColor, opts.codeAlpha));
    i++;
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Wrap markup-ready code content (already escaped/highlighted) in a monospace
// run: a specific family when given (matching the editor), else generic monospace.
// An optional foreground color and/or alpha set the code spans apart from the prose.
function wrapCode(content: string, family?: string, color?: string, alpha?: string): string {
  const attrs: string[] = [];
  if (family) attrs.push(`face="${attrEscape(family)}"`);
  if (color) attrs.push(`foreground="${attrEscape(color)}"`);
  if (alpha) attrs.push(`alpha="${attrEscape(alpha)}"`);
  return attrs.length ? `<span ${attrs.join(' ')}>${content}</span>` : `<tt>${content}</tt>`;
}

// Inline spans within a single line. Code is extracted to placeholders first so
// its contents aren't re-processed as bold/italic, then restored last.
function inline(text: string, codeFontFamily?: string, codeColor?: string, codeAlpha?: string): string {
  const codes: string[] = [];
  let s = escapeMarkup(text);
  s = s.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(c);
    return `\x00${codes.length - 1}\x00`;
  });
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // link → its text
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_]+)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<i>$2</i>');
  // eslint-disable-next-line no-control-regex -- \x00 is our own code-span sentinel, inserted above
  s = s.replace(/\x00(\d+)\x00/g, (_, n: string) => wrapCode(codes[Number(n)], codeFontFamily, codeColor, codeAlpha));
  return s;
}

/** Escape a string for use inside a double-quoted Pango markup attribute. */
function attrEscape(text: string): string {
  return escapeMarkup(text).replace(/"/g, '&quot;');
}
