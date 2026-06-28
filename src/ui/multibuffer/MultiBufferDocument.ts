/*
 * MultiBufferDocument — the `TextEditorSource` backing for a multibuffer surface (search results /
 * continuous diff). It wraps the surface's multi-source `Screen` + its `SyntaxProjection`
 * painter so a plain `TextEditor` renders N stitched sources as a first-class case — no scratch
 * `Document` shim, no `externalBuffer`/`syntaxProjection`/`undoTarget` injection.
 *
 * `isMultiSource` is true, so the editor suppresses its own line numbers / LSP / git gutter /
 * folding (the surface supplies its own gutter + overlays). The file/LSP members are inert; the
 * fold/translation surface + undo delegate to the `Screen` (which coordinates the touched
 * sources' undo as one transaction). The surface owns building/retargeting the PV; this object owns
 * disposing it (via the editor's teardown calling `dispose`).
 */
import type { Point } from '../../text/Point.ts';
import type { Screen } from '../TextEditor/Screen.ts';
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
  private readonly screen: Screen;

  constructor(screen: Screen, syntaxProjection: SyntaxProjection) {
    this.screen = screen;
    this.syntaxProjection = syntaxProjection;
  }

  // --- view + lifecycle (the single view IS the surface's pre-built PV) -------
  createView(): Screen {
    return this.screen;
  }
  removeView(): void {
    /* the PV is disposed in dispose(); a multibuffer has exactly one view */
  }

  // --- block-decoration anchoring (delegate to the PV's coordinate map) -------
  screenRowForDocument(_screen: Screen, documentKey: string | undefined, row: number): number | null {
    return this.screen.view.screenRowForDocument(documentKey ?? this.screen.view.soleDocumentKey ?? '', row);
  }
  onDidMaterialize(cb: () => void): () => void {
    return this.screen.onDidMaterialize(cb);
  }
  dispose(): void {
    this.screen.dispose();
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
  renameTo(): void {}
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
    this.screen.undo();
  }
  redo(): void {
    this.screen.redo();
  }
  beginUserAction(): void {
    this.screen.beginUserAction();
  }
  endUserAction(): void {
    this.screen.endUserAction();
  }

  // --- document (unfolded source) reads (folding is off for a multibuffer) ----
  // The fold/translation surface lives on the `Screen` the surface built (`this.screen`); the editor
  // reaches it directly. A multibuffer keeps `buffer == screen` (folding off), so its "document"
  // line count / text is the stitched view buffer itself.
  documentLineText(row: number): string {
    return this.screen.documentLineText(row);
  }
  documentLineCount(): number {
    return this.screen.buffer.getLineCount();
  }
  documentTextInRange(start: Point, end: Point): string {
    const buf = this.screen.buffer as any;
    const iter = (line: number, col: number): any => {
      const r = buf.getIterAtLineOffset(line, col);
      return Array.isArray(r) ? r[r.length - 1] : r;
    };
    return buf.getText(iter(start.row, start.column), iter(end.row, end.column), true);
  }
}
