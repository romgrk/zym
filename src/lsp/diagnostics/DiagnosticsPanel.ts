/*
 * DiagnosticsPanel — the "Diagnostics" view: every diagnostic across all open
 * files, the counterpart to the per-editor inline squiggles.
 *
 * A thin consumer of the shared `LocationList` (so it shares list navigation and
 * keybindings with project-wide search and other location lists). It maps the
 * `DiagnosticsStore` to `LocationItem`s — severity glyph, muted `file:line`, then
 * the message — and rebuilds on every `did-update`; activating a row jumps to the
 * location via `onOpenLocation`.
 *
 * The list widget is exposed via `root`.
 */
import * as Path from 'node:path';
import { quilx } from '../../quilx.ts';
import { CompositeDisposable } from '../../util/eventKit.ts';
import { DiagnosticSeverity } from 'vscode-languageserver-protocol';
import { LocationList } from '../../ui/LocationList.ts';
import { severityStyle } from './severity.ts';

export interface DiagnosticLocation {
  path: string;
  line: number;
  character: number;
}

export class DiagnosticsPanel {
  readonly root: InstanceType<typeof LocationList>['root'];

  private readonly list: LocationList;
  private readonly subs = new CompositeDisposable();

  constructor(onOpenLocation: (target: DiagnosticLocation) => void) {
    this.list = new LocationList({
      emptyText: 'No diagnostics',
      onActivate: (item) => onOpenLocation({ path: item.path, line: item.line, character: item.character }),
    });
    this.root = this.list.root;

    this.rebuild();
    this.subs.add(quilx.lsp.diagnostics.onDidUpdate(() => this.rebuild()));
  }

  /** Move keyboard focus into the list. */
  focus(): void {
    this.list.focus();
  }

  // Rebuild the whole list from the store. Diagnostic volumes are modest, so a
  // full rebuild on each update is simpler than diffing and plenty fast.
  private rebuild(): void {
    const store = quilx.lsp.diagnostics;
    const items = [];
    for (const path of store.paths().sort()) {
      for (const { diagnostic } of store.get(path)) {
        const sev = severityStyle(diagnostic.severity ?? DiagnosticSeverity.Error);
        const message =
          typeof diagnostic.message === 'string' ? diagnostic.message : (diagnostic.message as { value: string }).value;
        items.push({
          path,
          line: diagnostic.range.start.line,
          character: diagnostic.range.start.character,
          glyph: sev.glyph,
          glyphColor: sev.color,
          location: `${Path.basename(path)}:${diagnostic.range.start.line + 1}`, // 1-based line, no column
          text: message,
        });
      }
    }
    this.list.setItems(items);
  }

  dispose(): void {
    this.subs.dispose();
    this.list.dispose();
  }
}
