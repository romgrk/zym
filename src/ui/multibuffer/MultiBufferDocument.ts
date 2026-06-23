/*
 * MultiBufferDocument — the `TextEditorSource` backing for a multibuffer surface (search results /
 * continuous diff). It wraps the surface's multi-source `ProjectionView` + its `SyntaxProjection`
 * painter so a plain `TextEditor` renders N stitched sources as a first-class case — no scratch
 * `Document` shim, no `externalBuffer`/`syntaxProjection`/`undoTarget` injection.
 *
 * `isMultiSource` is true, so the editor suppresses its own line numbers / LSP / git gutter /
 * folding (the surface supplies its own gutter + overlays). The file/LSP members are inert; the
 * fold/translation surface + undo delegate to the `ProjectionView` (which coordinates the touched
 * sources' undo as one transaction). The surface owns building/retargeting the PV; this object owns
 * disposing it (via the editor's teardown calling `dispose`).
 */
import type { SourceBuffer } from '../../gi.ts';
import type { Point } from '../../text/Point.ts';
import type { ProjectionView } from '../TextEditor/ProjectionView.ts';
import type { SyntaxProjection } from '../../syntax/SyntaxProjection.ts';
import type { TextEditorSource } from '../TextEditor/TextEditorSource.ts';

export class MultiBufferDocument implements TextEditorSource {
  readonly isMultiSource = true;
  readonly documentSyntax = null;
  readonly currentFile = null;
  readonly title = '';
  readonly isLoaded = true;
  readonly lspDocument = null;
  readonly syntaxProjection: SyntaxProjection;
  private readonly pv: ProjectionView;

  constructor(pv: ProjectionView, syntaxProjection: SyntaxProjection) {
    this.pv = pv;
    this.syntaxProjection = syntaxProjection;
  }

  // --- view + lifecycle (the single view IS the surface's pre-built PV) -------
  createView(): SourceBuffer {
    return this.pv.buffer;
  }
  removeView(): void {
    /* the PV is disposed in dispose(); a multibuffer has exactly one view */
  }

  // --- block-decoration anchoring (delegate to the PV's coordinate map) -------
  screenRowForDocument(_buffer: SourceBuffer, documentKey: string | undefined, row: number): number | null {
    return this.pv.view.screenRowForDocument(documentKey ?? this.pv.view.soleDocumentKey ?? '', row);
  }
  onDidMaterialize(cb: () => void): () => void {
    return this.pv.onDidMaterialize(cb);
  }
  dispose(): void {
    this.pv.dispose();
  }
  getText(): string {
    return '';
  } // only the (suppressed) git gutter reads this — never called for a multibuffer
  setText(): void {
    /* the surface materializes the PV; no whole-buffer setText path */
  }

  // --- host (inert: a multibuffer has no load/save banners) -------------------
  addHost(): void {}
  removeHost(): void {}
  setActiveHost(): void {}

  // --- file / LSP (all inert) -------------------------------------------------
  loadFile(): void {}
  assignPath(): void {}
  ensureLoaded(): void {}
  restoreUnsaved(): void {}
  save(): void {}
  saveAs(): void {}
  hasDiskChange(): boolean {
    return false;
  }
  isModified(): boolean {
    return false;
  } // the surface tracks per-source modified state itself
  onTitleChange(): () => void { return () => {}; }
  onModifiedChange(): () => void {
    return () => {};
  }

  // --- undo (delegates to the PV, which spans the touched sources) ------------
  undo(): void {
    this.pv.undo();
  }
  redo(): void {
    this.pv.redo();
  }
  beginUserAction(): void {
    this.pv.beginUserAction();
  }
  endUserAction(): void {
    this.pv.endUserAction();
  }

  // --- folds + translation (delegate to the PV; folding is off, mostly inert) -
  foldScreenRange(_buffer: SourceBuffer, viewStart: number, viewEnd: number, placeholder: string): any {
    return this.pv.fold(viewStart, viewEnd, placeholder);
  }
  unfoldScreen(_buffer: SourceBuffer, fold: any): void {
    this.pv.unfold(fold);
  }
  foldPlaceholderRange(_buffer: SourceBuffer, fold: any): [number, number] {
    return this.pv.foldPlaceholderRange(fold);
  }
  foldDocumentText(_buffer: SourceBuffer, fold: any): string {
    return this.pv.foldDocumentText(fold);
  }
  isFoldAlive(fold: any): boolean {
    return this.pv.isFoldAlive(fold);
  }
  documentPointFromScreen(_buffer: SourceBuffer, point: Point): Point {
    return this.pv.documentPointFromScreen(point);
  }
  screenPointFromDocument(_buffer: SourceBuffer, point: Point): Point {
    return this.pv.screenPointFromDocument(point);
  }
  documentLineForScreenLine(_buffer: SourceBuffer, viewLine: number): number {
    return this.pv.documentLineForScreenLine(viewLine);
  }
  screenLineForDocumentLine(_buffer: SourceBuffer, modelLine: number): number {
    return this.pv.screenLineForDocumentLine(modelLine);
  }
  documentLineText(row: number): string {
    return this.pv.documentLineText(row);
  }
}
