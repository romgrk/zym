/*
 * Document-symbol picker — jump to any symbol (class, function, method, …) in the
 * *current* file via the LSP `textDocument/documentSymbol` request.
 *
 * Unlike the workspace-symbol picker, the outline is fetched once (it's a single
 * document), so this is a plain local-fuzzy-filter picker: every keystroke refines
 * the in-memory list rather than re-querying the server, and an empty query shows
 * the whole outline in document order. Built on `LocationPicker` for the
 * jump-to-location wiring, but with the preview pane turned off — the target file
 * is already on screen behind the picker, so a preview would only duplicate it.
 * This file fetches the symbols, renders the rows (a muted kind glyph + indented
 * name, with the container and line number muted on the right), and maps a row to
 * its location.
 */
import { Gtk } from '../gi.ts';
import { openLocationPicker } from './LocationPicker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { escapeMarkup, type PickerItem } from './Picker.ts';
import { symbolKindGlyph, Icons } from './icons.ts';
import { zym } from '../zym.ts';
import type { LspDocument, DocumentSymbolResult } from '../lsp/LspManager.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

export async function openDocumentSymbolPicker(
  host: Overlay,
  doc: LspDocument,
  onJump: (cursor: [number, number]) => void,
): Promise<void> {
  const path = doc.getPath();
  if (!path) return;

  const symbols = await zym.lsp.documentSymbols(doc);
  if (symbols.length === 0) {
    zym.notifications.addInfo('No symbols in this document');
    return;
  }

  // Items keyed by their (stable, unique) value, so the row renderer and `locate`
  // can recover the full symbol. Index keeps the value unique even when two
  // symbols share a name and position (rare, but possible across overloads).
  const byValue = new Map<string, DocumentSymbolResult>();
  const items = symbols.map((sym, i) => {
    const value = `${i}:${sym.point.row}:${sym.point.column}`;
    byValue.set(value, sym);
    return { value, text: sym.name } satisfies PickerItem;
  });

  openLocationPicker({
    host,
    placeholder: 'Go to symbol in document…',
    promptIcon: Icons.symbol,
    // The target file is already on screen behind the picker — a preview would
    // only duplicate it. Selection jumps the live editor instead.
    preview: false,
    items,
    renderRow: (item) => {
      const sym = byValue.get(item.value);
      if (!sym) return renderRowSingleLine({ main: escapeMarkup(item.text) });
      // Indent by nesting depth so the outline's hierarchy stays legible.
      const indent = '  '.repeat(sym.depth);
      // The kind glyph is a quiet visual cue, so dim it; the name carries the row.
      const glyph = `<span alpha="55%">${escapeMarkup(symbolKindGlyph(sym.kind))}</span>`;
      const main = `${indent}${glyph} ${escapeMarkup(sym.name)}`;
      const detail = sym.containerName
        ? `${sym.containerName}  :${sym.point.row + 1}`
        : `:${sym.point.row + 1}`;
      return renderRowSingleLine({ main, detail: `<span size="smaller">${escapeMarkup(detail)}</span>`, cropDetail: true });
    },
    locate: (item) => {
      const sym = byValue.get(item.value);
      if (!sym) return null;
      // Highlight the symbol name (its length from the start position) in the preview.
      return {
        path,
        line: sym.point.row,
        column: sym.point.column,
        endColumn: sym.point.column + sym.name.length,
      };
    },
    onJump: (loc) => onJump([loc.line, loc.column]),
  });
}
