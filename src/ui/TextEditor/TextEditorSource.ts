/*
 * TextEditorSource — the backing a `TextEditor` is driven by. It supplies the view buffer,
 * the fold/translation surface (`FoldHost`), undo (`UndoTarget`), the syntax painter (a single
 * `DocumentSyntax` OR a multi-source `SyntaxProjection`), and the file/LSP host bits.
 *
 * Two implementations, so `TextEditor` has ONE first-class backing (no scratch shim, no
 * `externalBuffer`/`syntaxProjection`/`undoTarget` injection):
 *   - `Document` — a single file/source (file-backed, or a file-less buffer-only input).
 *   - `MultiBufferDocument` — N sources stitched through one `ProjectionView` (the search-results
 *     / continuous-diff surfaces). `isMultiSource` is true; the file/LSP bits are inert.
 */
import type { SourceBuffer } from '../../gi.ts';
import type { DocumentSyntax } from '../../syntax/DocumentSyntax.ts';
import type { SyntaxProjection } from '../../syntax/SyntaxProjection.ts';
import type { FoldHost } from '../../syntax/syntax-controller.ts';
import type { UndoTarget } from './EditorModel.ts';
import type { LspDocument } from '../../lsp/LspManager.ts';
import type { DocumentHost } from './Document.ts';

export interface TextEditorSource extends FoldHost, UndoTarget {
  /** True when N sources are stitched through one `ProjectionView` (the multibuffer surfaces):
   *  the editor then suppresses its own line numbers / LSP / git gutter / folding and paints via
   *  the `syntaxProjection`. False for a normal (single-source) file or buffer-only editor. */
  readonly isMultiSource: boolean;

  // --- syntax painter -------------------------------------------------------
  /** The single-source parse to paint through the fold map, or null when `syntaxProjection` is
   *  used instead (multibuffer) — mutually exclusive. */
  readonly documentSyntax: DocumentSyntax | null;
  /** A multi-source painter projection (multibuffer), or null for a single source. */
  readonly syntaxProjection: SyntaxProjection | null;

  // --- block-decoration anchoring (the declarative BlockDecorationSet) ------
  /** The view row currently showing source `(documentKey, row)` in `buffer`'s view, or null when it
   *  isn't shown (collapsed / off the projection). `documentKey` omitted → the sole source (single
   *  file). Projects a block decoration's source anchor onto its view line. */
  screenRowForDocument(buffer: SourceBuffer, documentKey: string | undefined, row: number): number | null;
  /** Fired after a view buffer is re-materialized (`setText` — initial / rebuild / reload), the one
   *  event that drops block-decoration marks, so the editor can re-project anchored decorations.
   *  Returns an unsubscribe. */
  onDidMaterialize(cb: () => void): () => void;

  // --- view + lifecycle -----------------------------------------------------
  createView(): SourceBuffer;
  removeView(buffer: SourceBuffer): void;
  dispose(): void;
  getText(): string;
  setText(text: string): void;

  // --- host (the active view's reactions; inert for multibuffer) ------------
  addHost(host: DocumentHost): void;
  removeHost(host: DocumentHost): void;
  setActiveHost(host: DocumentHost): void;

  // --- file / LSP (all inert for a file-less / multibuffer source) ----------
  readonly currentFile: string | null;
  readonly title: string;
  readonly isLoaded: boolean;
  readonly lspDocument: LspDocument | null;
  loadFile(path: string, opts?: { silent?: boolean }): void;
  assignPath(path: string): void;
  ensureLoaded(): void;
  restoreUnsaved(text: string): void;
  save(): void;
  saveAs(path: string): void;
  hasDiskChange(): boolean;
  isModified(): boolean;
  onTitleChange(callback: () => void): () => void;
  onModifiedChange(callback: () => void): () => void;
}
