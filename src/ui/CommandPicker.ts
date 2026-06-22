/*
 * Command picker — a command palette over the picker UI. Enumerates every
 * command currently available to the focused widget and its ancestors (via the
 * CommandManager), opens the fuzzy picker over their names, and dispatches the
 * chosen command back to the element that offered it.
 *
 * Rows are styled for readability: a command's `prefix:` is muted and followed
 * by a space (`file: save`), matched characters are highlighted, and the
 * command's description (when it has one) is shown right-aligned in a smaller,
 * proportional (non-monospace) muted font.
 *
 * The available commands are snapshotted *before* the picker grabs focus, so the
 * list reflects the context the user was in (the editor, the file tree, …) rather
 * than the picker itself.
 */
import { Gtk } from '../gi.ts';
import { openPicker, escapeMarkup, HIGHLIGHT_COLOR, type PickerItem } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { fonts } from '../fonts.ts';
import { getActiveElements } from '../util/getActiveElements.ts';
import { zym } from '../zym.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

const PREFIX_ALPHA = '55%'; // muted `prefix:` segment
const DESC_ALPHA = '55%'; // muted trailing description
const SHORTCUT_ALPHA = '60%'; // muted keybinding (still bold + monospace)

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Render `prefix:verb` as `prefix: verb` — the `prefix` muted, a space inserted
// after the colon — with matched characters highlighted. Hyphens (word
// separators in command names) are muted too, so `focus-left` reads as the words
// with dim joiners. Positions index into the raw command name.
export function formatCommandName(name: string, positions: number[]): string {
  const matched = new Set(positions);
  const colon = name.indexOf(':');
  let out = '';
  for (let i = 0; i < name.length; i++) {
    const ch = escapeMarkup(name[i]);
    const muted = (colon !== -1 && i < colon) || name[i] === '-';
    if (matched.has(i)) out += `<span foreground="${HIGHLIGHT_COLOR}" weight="bold">${ch}</span>`;
    else if (muted) out += `<span alpha="${PREFIX_ALPHA}">${ch}</span>`;
    else out += ch;
    if (i === colon) out += ' '; // a space after the ':'
  }
  return out;
}

export function openCommandPicker(host: Overlay): void {
  const elements = getActiveElements();
  const commands = zym.commands.getAvailableCommands(elements);
  // Resolve a chosen name back to its element (to dispatch) and description.
  const byName = new Map(commands.map((c) => [c.name, c]));
  // Primary keystroke per command (computed once; highest-priority binding).
  // Shown verbatim, as written in the keymap (e.g. `space w`, `ctrl-shift-p`).
  const shortcutByName = new Map<string, string>();
  for (const c of commands) {
    const [primary] = zym.keymaps.keystrokesForCommand(c.name, elements);
    if (primary) shortcutByName.set(c.name, primary);
  }
  // The proportional UI font for descriptions (the picker itself is monospace).
  const uiFont = fonts.uiFamily;

  // Match against `name` AND `description`, but rank name hits first: the text is
  // `<description> <name>` with `boostFrom` on the name, so name matches earn the
  // fuzzy boost (the file picker's trick). Display reads the name from `value`,
  // so the description in `text` only affects matching/ranking.
  const items: PickerItem[] = commands
    .map((c) => c.name)
    .sort()
    .map((name) => {
      const description = byName.get(name)?.description;
      if (!description) return { value: name, text: name, boostFrom: 0 };
      return { value: name, text: `${description} ${name}`, boostFrom: description.length + 1 };
    });

  openPicker({
    host,
    placeholder: 'Run command…',
    items,
    renderRow: (item, positions) => {
      const name = item.value;
      const description = byName.get(name)?.description;
      // Positions index into `text` (`<description> <name>`). Split them into the
      // name range (the suffix) and the description range (the prefix).
      const nameStart = item.text.length - name.length;
      const namePositions = positions.filter((p) => p >= nameStart).map((p) => p - nameStart);
      const descPositions = description ? positions.filter((p) => p < description.length) : [];
      return renderRowSingleLine({
        main: formatCommandName(name, namePositions),
        // Right-aligned detail: the muted description (smaller, proportional, with
        // its own matches highlighted) followed by the keybinding flush-right —
        // bold, monospace, color-muted. Not dimmed as a whole, so each part keeps
        // the emphasis its markup sets.
        detail: detailMarkup(description, descPositions, shortcutByName.get(name), uiFont),
        detailMuted: false,
        // Commands whose `when` is currently false are shown but dimmed; choosing
        // one is a no-op (see onSelect).
        dim: byName.get(name)?.enabled === false,
      });
    },
    onSelect: (name) => {
      const command = byName.get(name);
      if (!command || command.enabled === false) return; // disabled — not applicable now
      zym.commands.dispatch(command.element, name);
    },
  });
}

function detailMarkup(
  description: string | undefined,
  descPositions: number[],
  shortcut: string | undefined,
  uiFont: string,
): string | undefined {
  const parts: string[] = [];
  if (description) parts.push(descMarkup(description, descPositions, uiFont));
  // Keybinding last → flush-right and column-aligned across rows; bold, monospace
  // (inherits the picker font), color-muted, shown exactly as written in the keymap.
  if (shortcut) parts.push(`<span weight="bold" alpha="${SHORTCUT_ALPHA}">${escapeText(shortcut)}</span>`);
  return parts.length ? parts.join('   ') : undefined;
}

// The description in a smaller, proportional, muted font, with matched chars
// (from searching the description) drawn full-strength in the highlight color.
function descMarkup(description: string, positions: number[], uiFont: string): string {
  const matched = new Set(positions);
  let inner = '';
  for (let i = 0; i < description.length; i++) {
    const ch = escapeText(description[i]);
    inner += matched.has(i)
      ? `<span foreground="${HIGHLIGHT_COLOR}" alpha="100%">${ch}</span>`
      : ch;
  }
  return `<span size="smaller" font_family="${uiFont}" alpha="${DESC_ALPHA}">${inner}</span>`;
}
