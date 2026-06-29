/*
 * Workspace-symbol picker — jump to any project-wide symbol (class, function,
 * method, …) via the LSP `workspace/symbol` request.
 *
 * It's a remote-search picker: each (debounced) keystroke asks the active file's
 * primary language server for symbols matching the query, and the server's own
 * ranking is shown verbatim (`localFilter: false`) — no local fuzzy refinement,
 * since the server already filters. Built on `LocationPicker`, so it gets the
 * source preview and the jump-to-location wiring for free; this file only renders
 * the rows (a muted kind glyph + name on the left, container + relative path,
 * muted, on the right) and maps a row back to its symbol's location.
 */
import * as Path from 'node:path';
import Gtk from 'gi:Gtk-4.0';
import { openLocationPicker } from './LocationPicker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { escapeMarkup, type PickerItem } from './Picker.ts';
import { symbolKindGlyph, Icons } from './icons.ts';
import { zym } from '../zym.ts';
import type { LspDocument, WorkspaceSymbolResult } from '../lsp/LspManager.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

export function openWorkspaceSymbolPicker(
  host: Overlay,
  doc: LspDocument,
  cwd: string,
  onJump: (path: string, cursor: [number, number]) => void,
): void {
  // Current results keyed by their (stable, unique) item value, so the row
  // renderer and `locate` can recover the full symbol. Rebuilt on each fetch.
  const byValue = new Map<string, WorkspaceSymbolResult>();

  openLocationPicker({
    host,
    placeholder: 'Search workspace symbols…',
    promptIcon: Icons.symbol,
    // The server filters and ranks; show its results as-is rather than re-filtering.
    localFilter: false,
    fetch: (query, sink) => {
      zym.lsp
        .workspaceSymbols(doc, query)
        .then((symbols) => {
          byValue.clear();
          sink.replace(
            symbols.map((sym) => {
              const value = `${sym.path}:${sym.point.row}:${sym.point.column}`;
              byValue.set(value, sym);
              return { value, text: sym.name } satisfies PickerItem;
            }),
          );
        })
        .catch((err) => sink.error(err instanceof Error ? err.message : String(err)));
    },
    renderRow: (item) => {
      const sym = byValue.get(item.value);
      if (!sym) return renderRowSingleLine({ main: escapeMarkup(item.text) });
      // The kind glyph is a quiet visual cue, so dim it; the name carries the row.
      const glyph = `<span alpha="55%">${escapeMarkup(symbolKindGlyph(sym.kind))}</span>`;
      const main = escapeMarkup(sym.name);
      const rel = Path.relative(cwd, sym.path);
      const detail = sym.containerName ? `${sym.containerName}  ${rel}` : rel;
      // Smaller path: it yields to the symbol name (cropping from the start) when space is tight.
      return renderRowSingleLine({
        icon: glyph,
        main,
        detail: `<span size="smaller">${escapeMarkup(detail)}</span>`,
      });
    },
    locate: (item) => {
      const sym = byValue.get(item.value);
      if (!sym) return null;
      // Highlight the symbol name (its length from the start position) in the preview.
      return {
        path: sym.path,
        line: sym.point.row,
        column: sym.point.column,
        endColumn: sym.point.column + sym.name.length,
      };
    },
    onJump: (loc) => onJump(loc.path, [loc.line, loc.column]),
  });
}
