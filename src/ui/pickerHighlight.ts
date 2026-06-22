/*
 * pickerHighlight — the Pango-markup helpers shared by the Picker and its row
 * renderers (see PickerRow). Kept in a leaf module (no Picker/PickerRow imports)
 * so both can depend on it without a cycle. Re-exported from Picker.ts for the
 * many callers that import these alongside the picker types.
 */
import { parse, lighten, formatHEX } from 'color-bits';
import { theme } from '../theme/theme.ts';
import { escapeMarkup } from './proseMarkup.ts';

// Color of the matched characters: the theme's accent foreground (Zed's
// `text.accent`), brightened so matches pop against the row text. Baked into Pango
// markup at row-build time, so it can't be a CSS variable (and Pango can't
// gradient-fill text, so it's a solid color); `formatHEX` keeps it 6-digit (no
// alpha) for the `foreground` attribute.
export const HIGHLIGHT_COLOR = theme.ui.text.accent;

/** Highlight the `[start, end)` slice of `text`, with positions in `text` coords. */
export function highlightSegment(text: string, start: number, end: number, positions: number[]): string {
  const local = positions.filter((p) => p >= start && p < end).map((p) => p - start);
  return highlightMarkup(text.slice(start, end), local);
}

/** Render `text` as Pango markup with the matched characters highlighted. */
export function highlightMarkup(text: string, positions: number[]): string {
  const matched = new Set(positions);
  let out = '';
  let highlit = false;
  for (let i = 0; i < text.length; i++) {
    const isMatch = matched.has(i);
    if (isMatch && !highlit) {
      out += `<span foreground="${HIGHLIGHT_COLOR}" weight="bold">`;
      highlit = true;
    } else if (!isMatch && highlit) {
      out += '</span>';
      highlit = false;
    }
    out += escapeMarkup(text[i]);
  }
  if (highlit) out += '</span>';
  return out;
}

// `escapeMarkup` (Pango metachar escaping) lives in proseMarkup; re-exported here
// for the callers that import it alongside the picker markup helpers.
export { escapeMarkup };
