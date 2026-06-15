/*
 * DiagnosticsView — renders one editor's diagnostics onto its GtkSource view.
 *
 * Two presentations, both driven by the shared `DiagnosticsStore`:
 *  - inline squiggles: custom-drawn wavy underline spans painted by the editor's
 *    `UnderlineOverlay` (anti-aliased Cairo waves, nicer than GtkTextTag's fixed
 *    `Pango.Underline.ERROR`), re-synced on every update
 *  - gutter glyphs: a Nerd Font severity icon per affected line, drawn by a
 *    `GtkSource.GutterRendererText` (same approach as the fold gutter) so we get
 *    colored glyphs from the bundled Symbols Nerd Font rather than theme icons
 *
 * Ranges arrive as LSP ranges (in the producing server's position encoding) and
 * are converted to quilx `Range`s via `EditorModel` + `position.lspToRange`.
 * Re-renders whenever the store updates for this editor's file.
 */
import { Gtk, GtkSource, registerClass, type SourceView } from '../../gi.ts';
import { DiagnosticSeverity } from 'vscode-languageserver-protocol';
import { CompositeDisposable } from '../../util/eventKit.ts';
import { quilx } from '../../quilx.ts';
import { ICON_FONT_FAMILY } from '../../fonts.ts';
import { Point } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';
import { lspToRange } from '../position.ts';
import { isLineFolded } from '../../syntax/syntax-controller.ts';
import { severityStyle } from './severity.ts';
import type { EditorModel } from '../../ui/TextEditor/EditorModel.ts';
import type { UnderlineOverlay, Underline } from '../../ui/TextEditor/UnderlineOverlay.ts';

export class DiagnosticsView {
  private readonly view: SourceView;
  private readonly model: EditorModel;
  private readonly getPath: () => string | null;
  private readonly underlines: UnderlineOverlay;
  private readonly renderer: any;
  // line → most-severe DiagnosticSeverity on that line (lower number = worse).
  private readonly severityByLine = new Map<number, number>();
  private readonly subscriptions = new CompositeDisposable();

  constructor(
    view: SourceView,
    underlines: UnderlineOverlay,
    model: EditorModel,
    getPath: () => string | null,
  ) {
    this.view = view;
    this.model = model;
    this.getPath = getPath;
    this.underlines = underlines;

    this.renderer = new DiagnosticGutterRenderer();
    this.renderer.severityByLine = this.severityByLine;
    this.renderer.buffer = (view as any).getBuffer();
    (this.view as any).getGutter(Gtk.TextWindowType.LEFT).insert(this.renderer, 0);

    this.subscriptions.add(
      quilx.lsp.diagnostics.onDidUpdate((path) => {
        if (path === this.getPath()) this.render();
      }),
    );
  }

  /** Re-apply squiggles + gutter glyphs for the current file's diagnostics. */
  render(): void {
    const path = this.getPath();
    this.severityByLine.clear();
    const underlines: Underline[] = [];
    const entries = path ? quilx.lsp.diagnostics.get(path) : [];
    const lineAt = (row: number) => this.model.lineTextForBufferRow(row);
    for (const { diagnostic, encoding } of entries) {
      const severity = diagnostic.severity ?? DiagnosticSeverity.Error;
      const range = lspToRange(diagnostic.range, lineAt, encoding);
      underlines.push({ range: visibleRange(range), color: severityStyle(severity).color });
      const line = range.start.row;
      const worst = this.severityByLine.get(line);
      if (worst === undefined || severity < worst) this.severityByLine.set(line, severity);
    }
    this.underlines.setUnderlines(underlines);
    this.renderer.queueDraw();
  }

  dispose(): void {
    this.underlines.clear();
    this.severityByLine.clear();
    (this.view as any).getGutter(Gtk.TextWindowType.LEFT).remove(this.renderer);
    this.subscriptions.dispose();
  }
}

// Draws the Nerd Font severity glyph for any line that has diagnostics. Reads the
// `severityByLine` map the view keeps in sync; `queueDraw()` triggers a refresh.
class DiagnosticGutterRenderer extends GtkSource.GutterRendererText {
  queryData(_lines: any, line: number) {
    const severity: number | undefined = (this as any).severityByLine?.get(line);
    // Blank for clean lines, and for diagnostic lines hidden inside a fold (so
    // glyphs don't pile up at the collapsed position).
    if (severity === undefined || isLineFolded((this as any).buffer, line)) {
      this.setMarkup(' ', -1);
      return;
    }
    const sev = severityStyle(severity);
    this.setMarkup(`<span face="${ICON_FONT_FAMILY}" size="85%" foreground="${sev.color}">${sev.glyph}</span>`, -1);
  }
}
registerClass(DiagnosticGutterRenderer);

// Expand an empty (point) range to one character so the squiggle is visible.
function visibleRange(range: Range): Range {
  if (range.start.compare(range.end) !== 0) return range;
  return new Range(range.start, new Point(range.start.row, range.start.column + 1));
}
