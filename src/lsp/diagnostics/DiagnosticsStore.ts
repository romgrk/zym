/*
 * DiagnosticsStore — the source of truth for diagnostics, namespaced by
 * (serverName, path).
 *
 * One file may be served by several language servers (e.g. tsserver + eslint),
 * each publishing its own diagnostics for the same path; keying by path alone
 * would let them clobber. So diagnostics are stored per (serverName, path) and
 * **merged** on read for the UI (gutter/squiggles/panel). Each server's set
 * carries its own position encoding, so the merged view exposes encoding
 * per-diagnostic (servers may negotiate different encodings) for lazy range
 * conversion against the editor's line text (which the store doesn't have).
 *
 * Emits `did-update` with the affected path whenever any server's diagnostics
 * for that file change, including clears.
 */
import type { Diagnostic } from 'vscode-languageserver-protocol';
import { Emitter, Disposable } from '../../util/eventKit.ts';
import type { PositionEncoding } from '../position.ts';

interface ServerDiagnostics {
  diagnostics: Diagnostic[];
  /** Encoding of the server that produced them (for range conversion). */
  encoding: PositionEncoding;
}

/** One diagnostic plus the encoding of the server that produced it. */
export interface DiagnosticEntry {
  diagnostic: Diagnostic;
  encoding: PositionEncoding;
}

export class DiagnosticsStore {
  // path → (serverName → that server's diagnostics for the file).
  private readonly byPath = new Map<string, Map<string, ServerDiagnostics>>();
  private readonly emitter = new Emitter();

  /**
   * Replace one server's diagnostics for a path; removes that server's entry
   * (and the path, if it was the last) when empty.
   */
  set(serverName: string, path: string, diagnostics: Diagnostic[], encoding: PositionEncoding): void {
    let perServer = this.byPath.get(path);
    if (diagnostics.length === 0) {
      if (perServer?.delete(serverName) && perServer.size === 0) this.byPath.delete(path);
    } else {
      if (!perServer) {
        perServer = new Map();
        this.byPath.set(path, perServer);
      }
      perServer.set(serverName, { diagnostics, encoding });
    }
    this.emitter.emit('did-update', path);
  }

  /** Drop every server's diagnostics for a path (e.g. on close). No-op if absent. */
  clear(path: string): void {
    if (this.byPath.delete(path)) this.emitter.emit('did-update', path);
  }

  /** Drop one server's diagnostics for a path (e.g. when that server crashes). */
  clearServer(serverName: string, path: string): void {
    const perServer = this.byPath.get(path);
    if (!perServer?.delete(serverName)) return;
    if (perServer.size === 0) this.byPath.delete(path);
    this.emitter.emit('did-update', path);
  }

  /** Merged diagnostics for a path across all its servers, sorted by position. */
  get(path: string): DiagnosticEntry[] {
    const perServer = this.byPath.get(path);
    if (!perServer) return [];
    const out: DiagnosticEntry[] = [];
    for (const { diagnostics, encoding } of perServer.values()) {
      for (const diagnostic of diagnostics) out.push({ diagnostic, encoding });
    }
    out.sort((a, b) => {
      const pa = a.diagnostic.range.start;
      const pb = b.diagnostic.range.start;
      return pa.line - pb.line || pa.character - pb.character;
    });
    return out;
  }

  /** Every path that currently has diagnostics from at least one server, optionally
   *  filtered by `accept` (e.g. to a workbench's root). */
  paths(accept?: (path: string) => boolean): string[] {
    const all = [...this.byPath.keys()];
    return accept ? all.filter(accept) : all;
  }

  /** Total diagnostic count across all files and servers. */
  get count(): number {
    let n = 0;
    for (const perServer of this.byPath.values()) {
      for (const entry of perServer.values()) n += entry.diagnostics.length;
    }
    return n;
  }

  /**
   * Diagnostic counts grouped by severity (1=Error … 4=Hint), across all files
   * and servers, optionally filtered by `accept` (e.g. to a workbench's root).
   * Severities the LSP omits default to Error, matching the panel.
   */
  countsBySeverity(accept?: (path: string) => boolean): Record<number, number> {
    const counts: Record<number, number> = {};
    for (const [path, perServer] of this.byPath) {
      if (accept && !accept(path)) continue;
      for (const { diagnostics } of perServer.values()) {
        for (const d of diagnostics) {
          const sev = d.severity ?? 1; // DiagnosticSeverity.Error
          counts[sev] = (counts[sev] ?? 0) + 1;
        }
      }
    }
    return counts;
  }

  onDidUpdate(handler: (path: string) => void): Disposable {
    return this.emitter.on('did-update', handler as (v?: unknown) => void);
  }
}
