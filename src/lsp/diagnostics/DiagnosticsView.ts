/*
 * DiagnosticsView — renders one editor's diagnostics onto its GtkSource view.
 *
 * Two presentations, both driven by the shared `DiagnosticsStore`:
 *  - inline squiggles: custom-drawn wavy underline spans painted by the editor's
 *    `UnderlineOverlay` (anti-aliased Cairo waves, nicer than GtkTextTag's fixed
 *    `Pango.Underline.ERROR`), re-synced on every update
 *  - gutter glyphs: a Nerd Font severity icon per affected line, fed as a per-line
 *    cell into the editor's single composite gutter (SyntaxController, the
 *    `GutterCellSink`) — it composes the colored Symbols-Nerd-Font glyph into the
 *    one gutter markup string rather than this view owning its own renderer.
 *
 * Ranges arrive as LSP ranges (in the producing server's position encoding) and
 * are converted to zym `Range`s via `EditorModel` + `position.lspToRange`.
 * Re-renders whenever the store updates for this editor's file.
 */
import { type SourceView } from '../../gi.ts';
import { DiagnosticSeverity } from 'vscode-languageserver-protocol';
import { CompositeDisposable } from '../../util/eventKit.ts';
import { zym } from '../../zym.ts';
import { ICON_FONT_FAMILY } from '../../fonts.ts';
import { Point } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';
import { lspToRange } from '../position.ts';
import type { GutterCellSink } from '../../syntax/gutterRenderers.ts';
import { severityStyle } from './severity.ts';
import { VirtualText, type AnnotationStyleName } from '../../ui/TextEditor/VirtualText.ts';
import type { EditorModel } from '../../ui/TextEditor/EditorModel.ts';
import type { TextDecorations, Underline } from '../../ui/TextEditor/TextDecorations.ts';

/** Map an LSP severity to an annotation style for error-lens trailing text. */
function annotationStyle(severity: number): AnnotationStyleName {
  if (severity === DiagnosticSeverity.Error) return 'error';
  if (severity === DiagnosticSeverity.Warning) return 'warning';
  return 'accent'; // information / hint
}

export class DiagnosticsView {
  private readonly view: SourceView;
  private readonly model: EditorModel;
  private readonly getPath: () => string | null;
  private readonly decorations: TextDecorations;
  // The shared composite gutter we feed our severity-glyph cell into.
  private readonly gutter: GutterCellSink;
  // line → most-severe DiagnosticSeverity on that line (lower number = worse).
  private readonly severityByLine = new Map<number, number>();
  // Error lens: native end-of-line trailing message per line (GtkSourceAnnotations).
  private readonly annotations: VirtualText;
  private readonly subscriptions = new CompositeDisposable();

  constructor(
    view: SourceView,
    gutter: GutterCellSink,
    decorations: TextDecorations,
    model: EditorModel,
    getPath: () => string | null,
  ) {
    this.view = view;
    this.model = model;
    this.getPath = getPath;
    this.decorations = decorations;
    this.gutter = gutter;

    // Contribute the severity-glyph column to the editor's single composite gutter.
    // severityByLine is keyed by VIEW line (the LSP range is translated to view space),
    // so a diagnostic inside a fold lands on the placeholder line — no pile-up.
    this.gutter.setDiagCell((viewLine) => {
      const severity = this.severityByLine.get(viewLine);
      if (severity === undefined) return '';
      const sev = severityStyle(severity);
      return `<span face="${ICON_FONT_FAMILY}" size="85%" foreground="${sev.color}">${sev.glyph}</span>`;
    });

    this.annotations = new VirtualText(view);

    this.subscriptions.add(
      zym.lsp.diagnostics.onDidUpdate((path) => {
        if (path === this.getPath()) this.render();
      }),
    );
    // Re-render when the error-lens toggle changes.
    this.subscriptions.add(zym.config.observe('editor.errorLens', () => this.render()));
  }

  /** Re-apply squiggles + gutter glyphs + error-lens annotations for the current
   *  file's diagnostics. */
  render(): void {
    const path = this.getPath();
    this.severityByLine.clear();
    const underlines: Underline[] = [];
    // line → the worst diagnostic to trail (message + severity) + how many share the line.
    const lensByLine = new Map<number, { message: string; severity: number; count: number }>();
    const entries = path ? zym.lsp.diagnostics.get(path) : [];
    // LSP ranges are in MODEL (file) coordinates; encode columns off the MODEL line,
    // then translate to VIEW space — folds collapse text so view lines/cols diverge
    // from the model's (a diagnostic inside a fold maps onto its placeholder line).
    const lineAt = (row: number) => this.model.modelLineTextForRow(row);
    for (const { diagnostic, encoding } of entries) {
      const severity = diagnostic.severity ?? DiagnosticSeverity.Error;
      const range = this.model.viewRangeFromModel(lspToRange(diagnostic.range, lineAt, encoding));
      underlines.push({ range: visibleRange(range), color: severityStyle(severity).color });
      const line = range.start.row;
      const worst = this.severityByLine.get(line);
      if (worst === undefined || severity < worst) this.severityByLine.set(line, severity);

      const message = typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value;
      const lens = lensByLine.get(line);
      if (!lens) lensByLine.set(line, { message, severity, count: 1 });
      else {
        lens.count++;
        if (severity < lens.severity) {
          lens.message = message;
          lens.severity = severity;
        }
      }
    }
    this.decorations.setUnderlines(underlines);
    this.gutter.redrawGutter();

    // Error lens: the worst message per line, trailing the line (`+N` when several).
    if (zym.config.get('editor.errorLens') !== false) {
      this.annotations.setAnnotations(
        [...lensByLine.entries()].map(([line, lens]) => ({
          line,
          text: lens.message.split('\n')[0] + (lens.count > 1 ? `  +${lens.count - 1}` : ''),
          style: annotationStyle(lens.severity),
        })),
      );
    } else {
      this.annotations.clear();
    }
  }

  /** Sorted view-space start positions of every diagnostic in the current file
   *  (for vim `]d`/`[d`). Recomputed from the store so it always reflects the
   *  latest, mirroring `render()`'s MODEL→VIEW range conversion. */
  diagnosticPositions(): Point[] {
    const path = this.getPath();
    const entries = path ? zym.lsp.diagnostics.get(path) : [];
    const lineAt = (row: number) => this.model.modelLineTextForRow(row);
    const positions = entries.map(
      ({ diagnostic, encoding }) =>
        this.model.viewRangeFromModel(lspToRange(diagnostic.range, lineAt, encoding)).start,
    );
    // The store sorts by MODEL position; folds can re-order in VIEW space, so re-sort.
    positions.sort((a, b) => a.compare(b));
    return positions;
  }

  dispose(): void {
    this.decorations.clearUnderlines();
    this.severityByLine.clear();
    this.annotations.dispose();
    this.gutter.setDiagCell(null); // drop our column from the composite gutter
    this.subscriptions.dispose();
  }
}

// Expand an empty (point) range to one character so the squiggle is visible.
function visibleRange(range: Range): Range {
  if (range.start.compare(range.end) !== 0) return range;
  return new Range(range.start, new Point(range.start.row, range.start.column + 1));
}
