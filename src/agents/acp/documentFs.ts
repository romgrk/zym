/*
 * acp/documentFs.ts — the editor-backed `AcpFsHost` (the ACP `fs` capability).
 *
 * Reads return the live buffer when the path is open in the DocumentRegistry,
 * so the agent sees unsaved edits instead of stale disk state. Writes always
 * land on disk first, then an open document reloads in place through the same
 * silent-reload path an external change takes (caret kept, LSP re-synced, mtime
 * bookkeeping stays consistent so the file watcher doesn't re-fire) — the
 * agent's write is immediately live in the editor, even over a modified buffer.
 * That clobber is ACP's intended semantics: the written content is authoritative
 * because the agent based it on the buffer state it just read through this same
 * capability.
 *
 * Kept out of AcpSession.ts so that module stays runtime-pure — the registry
 * drags in GTK. Injected per-window by AgentController (the registry lives on
 * the window's PaneItems).
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import type { DocumentRegistry } from '../../ui/TextEditor/DocumentRegistry.ts';
import type { AcpFsHost } from './AcpSession.ts';

export function createDocumentFs(documents: DocumentRegistry): AcpFsHost {
  return {
    readTextFile(path: string): string {
      const doc = documents.find(Path.normalize(path));
      // A lazily-assigned document (path known, content not read) falls through
      // to disk — the buffer holds nothing newer.
      if (doc?.isLoaded) return doc.getText();
      return Fs.readFileSync(path, 'utf8');
    },
    writeTextFile(path: string, content: string): void {
      Fs.mkdirSync(Path.dirname(path), { recursive: true });
      Fs.writeFileSync(path, content);
      const doc = documents.find(Path.normalize(path));
      // Reload under the document's own key (`loadFile` reassigns `currentFile`,
      // so a normalization mismatch must not retarget the entry).
      if (doc?.isLoaded) doc.loadFile(doc.currentFile ?? path, { silent: true });
    },
  };
}
