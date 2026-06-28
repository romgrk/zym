/*
 * Diff file picker — jump to any file in the *current* continuous diff (`z /`).
 *
 * A plain local-fuzzy-filter picker over the diff's files: every keystroke refines the in-memory
 * list, an empty query shows them all in view order, and selecting one jumps the diff's caret to
 * that file's header. Opened over the diff editor (like `lsp:document-symbols`) — no preview, since
 * the diff is already on screen behind it.
 */
import Gtk from 'gi:Gtk-4.0';
import * as Path from 'node:path';
import { openPicker, highlightMarkup, type PickerItem } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { fileIconGlyph } from './fileIcons.ts';
import { iconSpan, Icons } from './icons.ts';
import type { DiffView } from './DiffView.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

/** Open the diff's file picker over `diff`, jumping to the chosen file's header on select. */
export function openDiffFilePicker(host: Overlay, diff: DiffView): void {
  const files = diff.fileList();
  if (files.length === 0) return;
  // `value` is the absolute path (what `goToFile` keys on); `text` the display label we fuzzy-match.
  const items = files.map((f) => ({ value: f.path, text: f.label }) satisfies PickerItem);

  openPicker({
    host,
    anchor: { to: diff.root }, // centre over the diff editor, not the whole window
    dim: false, // sit over the diff without darkening it
    placeholder: 'Jump to file…',
    promptIcon: Icons.search,
    items,
    renderRow: (item, positions) => {
      // A dimmed file-type glyph leads the (fuzzy-highlighted) path — matches the diff header look.
      const glyph = `<span alpha="55%">${iconSpan(fileIconGlyph(Path.basename(item.text), false))}</span>`;
      return renderRowSingleLine({ main: `${glyph} ${highlightMarkup(item.text, positions)}` });
    },
    onSelect: (value) => diff.goToFile(value),
  });
}
