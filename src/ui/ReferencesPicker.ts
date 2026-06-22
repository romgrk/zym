/*
 * References picker — pick among the LSP references to the symbol at the cursor
 * and jump to one.
 *
 * Unlike the workspace-symbol / search pickers (which re-query a server per
 * keystroke), references are resolved up front in a single `textDocument/references`
 * call, so this is a *local* picker over a fixed candidate pool: the caller fetches
 * the references and hands them here, and the picker fuzzy-filters them on the fly.
 * Built on `LocationPicker`, so it gets the source preview and jump-to-location
 * wiring for free; this file only renders the rows (the matched line on the left,
 * a muted `path:line` location on the right) and maps a row back to its location.
 */
import * as Path from 'node:path';
import { Gtk } from '../gi.ts';
import { openLocationPicker } from './LocationPicker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { escapeMarkup, type PickerItem } from './Picker.ts';
import { Icons } from './icons.ts';
import type { ReferenceLocation } from '../lsp/LspManager.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

// A picker item carrying the reference's location and its display detail.
interface ReferenceItem extends PickerItem {
  /** Absolute path of the referencing file. */
  file: string;
  /** 0-based `[row, column]` of the reference, for `restoreCursor`. */
  cursor: [number, number];
  /** Right-aligned, muted `path:line` location shown after the matched line. */
  detailText: string;
}

export function openReferencesPicker(
  host: Overlay,
  references: ReferenceLocation[],
  onJump: (path: string, cursor: [number, number]) => void,
): void {
  const cwd = process.cwd();
  const items: ReferenceItem[] = references.map((r) => {
    const rel = Path.relative(cwd, r.path);
    return {
      // Unique per reference so duplicate lines still get distinct rows.
      value: `${r.path}:${r.point.row}:${r.point.column}`,
      text: r.lineText.trim(),
      file: r.path,
      cursor: [r.point.row, r.point.column],
      detailText: `${rel}:${r.point.row + 1}`,
    };
  });

  openLocationPicker({
    host,
    placeholder: 'Filter references…',
    promptIcon: Icons.search,
    items,
    // Render the matched line on the left, the `path:line` location as a muted,
    // croppable detail on the right (yields to the line text when space is tight).
    renderRow: (item) => {
      const it = item as ReferenceItem;
      return renderRowSingleLine({
        main: escapeMarkup(it.text),
        detail: `<span size="smaller">${escapeMarkup(it.detailText)}</span>`,
        cropDetail: true,
      });
    },
    locate: (item) => {
      const it = item as ReferenceItem;
      return { path: it.file, line: it.cursor[0], column: it.cursor[1] };
    },
    onJump: (loc) => onJump(loc.path, [loc.line, loc.column]),
  });
}
