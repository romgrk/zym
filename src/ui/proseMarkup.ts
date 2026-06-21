/*
 * proseMarkup — render a short, markdown-ish label as Pango markup for picker
 * rows: prose in the default sans font with `backtick`-delimited spans in
 * monospace (the backticks themselves hidden). The prose face is Pango's generic
 * "Sans" alias (so it overrides the picker card's monospace CSS); the code face
 * is the app's configured monospace family (from fonts.ts), matching the
 * monospace used everywhere else rather than Pango's generic "Monospace". Shared
 * by the pickers that show free-text labels (resume conversations, switch/send-
 * to agent).
 */
import { Gtk } from '../gi.ts';
import { theme } from '../theme/theme.ts';
import { fonts } from '../fonts.ts';

// Leading factor for picker prose rows; the inline-monospace runs sit taller than
// the sans prose, so symmetric leading keeps mixed lines vertically centred
// instead of hugging the top of the row.
export const PROSE_LINE_HEIGHT = 1.4;

/**
 * Markup for `text`: sans prose, `code` in monospace, with the fuzzy-matched
 * `positions` (indexing into the raw `text`, backticks included) highlighted in
 * the accent colour. Emitted per character so the face and highlight spans never
 * cross-nest (which Pango rejects). When `muted`, the prose is dimmed (lower
 * foreground alpha) while the match highlight stays at full strength.
 */
export function proseMarkup(text: string, positions: number[] = [], muted = false): string {
  const matched = new Set(positions);
  let out = '';
  let mono = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '`') { mono = !mono; continue; } // hide the delimiter, flip face
    const attrs = [];
    if (mono) attrs.push(`face="${fonts.monospaceFamily}"`);
    // Matched chars carry the accent colour; restore full opacity so the
    // highlight reads even when the row is muted.
    if (matched.has(i)) attrs.push(`foreground="${theme.ui.text.accent}" weight="bold"${muted ? ' alpha="100%"' : ''}`);
    const esc = escapeMarkup(ch);
    out += attrs.length ? `<span ${attrs.join(' ')}>${esc}</span>` : esc;
  }
  const alpha = muted ? ' alpha="45%"' : '';
  return `<span face="Sans" line_height="${PROSE_LINE_HEIGHT}"${alpha}>${out}</span>`;
}

/** Escape the Pango-markup metacharacters in `text`. */
export function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Set Pango `markup` on `label`, falling back to plain `fallback` if Pango rejects it. */
export function setMarkupSafe(label: InstanceType<typeof Gtk.Label>, markup: string, fallback: string): void {
  try {
    label.setMarkup(markup);
  } catch {
    label.setText(fallback);
  }
}

/** A new wrapped, selectable label rendered from `markup` (plain `fallback` on reject). */
export function markupLabel(markup: string, fallback: string): InstanceType<typeof Gtk.Label> {
  const label = new Gtk.Label({ xalign: 0, wrap: true, selectable: true });
  setMarkupSafe(label, markup, fallback);
  return label;
}

export function setLineHeight(markup: string, lineHeight: number) {
  return `<span line_height="${lineHeight}">${markup}</span>`
}

/** Remove every child of `box` (GTK4 has no `clear()`). */
export function clearChildren(box: InstanceType<typeof Gtk.Box>): void {
  let child = box.getFirstChild();
  while (child) {
    const next = child.getNextSibling();
    box.remove(child);
    child = next;
  }
}
