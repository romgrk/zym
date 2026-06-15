/*
 * LspManager — the orchestration core that ties editors to language servers.
 *
 * Responsibilities:
 *  - resolve a file → its active servers (via `LanguageRegistry.activeServers`):
 *    a language may run several servers per project (e.g. flow + eslint), each
 *    gated by root markers, so one document can drive more than one server
 *  - spawn/reuse one `LanguageServer` per (server, rootDir), so a project shares
 *    a single process
 *  - drive document sync to *every* active server (didOpen/Change/Save/Close)
 *  - route published diagnostics into a `DiagnosticsStore` keyed by file path
 *  - answer requests (definition/references/hover) against the *primary* server
 *    (the language server; ungrouped linters contribute diagnostics only),
 *    resolving the LSP target back to a quilx `Point`
 *
 * This layer is GTK-free: it talks to editors through the small `LspDocument`
 * interface, so the GTK `TextEditor` wiring is a thin adapter added later. The
 * pure helpers (`resolveRootDir`, `locationToTarget`) are exported for testing.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { CompletionTriggerKind } from 'vscode-languageserver-protocol';
import type {
  Definition, LocationLink, Location, Position, Hover, CompletionItem,
} from 'vscode-languageserver-protocol';
import { Emitter, Disposable } from '../util/eventKit.ts';
import { Point } from '../text/Point.ts';
import { languages } from '../lang/index.ts';
import type { ServerDef, ActiveServer, ServerOverrides } from '../lang/types.ts';
import { LanguageServer, serverKey, type NavigationKind } from './LanguageServer.ts';
export type { NavigationKind } from './LanguageServer.ts';
import { DiagnosticsStore } from './diagnostics/DiagnosticsStore.ts';
import { pointToPosition, positionToPoint, uriToPath } from './position.ts';
import type { PositionEncoding } from './position.ts';

/** The minimal editor surface the manager needs. Implemented by a TextEditor adapter. */
export interface LspDocument {
  /** Absolute file path, or null for an unsaved buffer (then LSP is skipped). */
  getPath(): string | null;
  /** Full buffer text (for full-text document sync). */
  getText(): string;
  /** Text of a single row (for position-encoding conversion). */
  lineTextForRow(row: number): string;
  /** Current cursor position. */
  getCursorBufferPosition(): Point;
}

/** A resolved navigation/location target with its line text (for previews). */
export interface ReferenceLocation {
  path: string;
  point: Point;
  /** Text of the target line (a preview for reference/results lists). */
  lineText: string;
}

/** A resolved go-to target — a `ReferenceLocation` is one (the preview is unused). */
export type DefinitionTarget = ReferenceLocation;

/** A user-facing trace of a major LSP event, routed to the notification log. */
export interface LspNotice {
  level: 'trace' | 'info' | 'warning' | 'error';
  message: string;
  detail?: string;
}

export interface LspConfig {
  enable?: boolean;
  /** Language ids to suppress entirely (no servers start). */
  disabledLanguages?: string[];
  /** Per-language server overrides (disable/tweak a server, or add one). */
  serverOverrides?: ServerOverrides;
}

// Crash recovery: restart a crashed server with exponential backoff, giving up
// after MAX_RESTARTS consecutive rapid crashes. A server that stays up for
// STABILITY_MS has its crash count forgiven, so an occasional crash always
// recovers while a tight crash loop is bounded.
const MAX_RESTARTS = 4;
const BASE_RESTART_DELAY_MS = 1000;
const MAX_RESTART_DELAY_MS = 16000;
const STABILITY_MS = 30000;

interface RestartState {
  attempts: number;
  stableTimer?: ReturnType<typeof setTimeout>;
  pendingTimer?: ReturnType<typeof setTimeout>;
}

// One server that should run for a file: its def, located project root, reuse
// key, and whether it's the primary (the language server requests target).
interface ResolvedServer {
  langId: string;
  server: ServerDef;
  rootDir: string;
  key: string;
  primary: boolean;
}

export class LspManager {
  readonly diagnostics: DiagnosticsStore;
  private enabled = true;
  private readonly servers = new Map<string, LanguageServer>();
  // Open documents (path → adapter), so a restarted server can re-open them.
  private readonly openDocs = new Map<string, LspDocument>();
  // Per-(server,rootDir) crash-recovery bookkeeping.
  private readonly restartState = new Map<string, RestartState>();
  private readonly emitter = new Emitter();

  constructor() {
    this.diagnostics = new DiagnosticsStore();
  }

  /**
   * Apply user config (from `lsp.*`): enable/disable, language suppression, and
   * per-server overrides (keyed into the `LanguageRegistry`). Since overrides
   * change which servers a file resolves to, open documents are reconciled —
   * every server is restarted under the new config (config changes are rare).
   */
  configure(config: LspConfig): void {
    this.enabled = config.enable ?? true;
    languages.setOverrides({
      disabledLanguages: config.disabledLanguages,
      servers: config.serverOverrides,
    });
    void this.reload();
  }

  // Restart everything under the current config: shut every server down, clear
  // their diagnostics, then re-open the still-open documents (which re-resolve
  // against the new overrides). A no-op at startup, when nothing is open yet.
  private async reload(): Promise<void> {
    const docs = [...this.openDocs.values()];
    await this.shutdownAll();
    for (const doc of docs) {
      const path = doc.getPath();
      if (path) this.diagnostics.clear(path);
    }
    if (!this.enabled) return;
    for (const doc of docs) this.didOpen(doc);
  }

  /** Subscribe to major LSP events (server start/ready/exit/failure) for logging. */
  onNotice(handler: (notice: LspNotice) => void): Disposable {
    return this.emitter.on('notice', handler as (v?: unknown) => void);
  }

  private notice(level: LspNotice['level'], message: string, detail?: string): void {
    this.emitter.emit('notice', { level, message, detail } satisfies LspNotice);
  }

  // --- document lifecycle ----------------------------------------------------

  didOpen(doc: LspDocument): void {
    if (!this.enabled) return;
    const path = doc.getPath();
    if (!path) return;
    const resolved = this.resolveServers(path);
    if (resolved.length === 0) return;
    this.openDocs.set(path, doc); // retained so a restart can re-open it
    const text = doc.getText();
    for (const r of resolved) {
      const server = this.ensureServer(r);
      // Guard against a duplicate didOpen (e.g. a crash-restart re-opens the doc
      // for the one server that died, while its siblings are already open).
      if (server && !server.isOpen(path)) server.didOpen(path, r.langId, text);
    }
  }

  didChange(doc: LspDocument): void {
    const path = doc.getPath();
    if (!path) return;
    const text = doc.getText();
    for (const server of this.runningServersForPath(path)) {
      if (server.isOpen(path)) server.didChange(path, text);
    }
  }

  didSave(doc: LspDocument): void {
    const path = doc.getPath();
    if (!path) return;
    const text = doc.getText();
    for (const server of this.runningServersForPath(path)) {
      if (server.isOpen(path)) server.didSave(path, text);
    }
  }

  didClose(doc: LspDocument): void {
    const path = doc.getPath();
    if (!path) return;
    this.openDocs.delete(path);
    for (const server of this.runningServersForPath(path)) server.didClose(path);
    this.diagnostics.clear(path);
  }

  // --- requests --------------------------------------------------------------

  /** Resolve a navigation (definition/declaration/type-def/impl) at the cursor. */
  async goto(doc: LspDocument, kind: NavigationKind): Promise<DefinitionTarget | null> {
    if (!this.enabled) return null;
    const path = doc.getPath();
    if (!path) return null;
    const server = this.primaryServerForPath(path);
    if (!server || !server.supportsNavigation(kind)) return null;
    const cursor = doc.getCursorBufferPosition();
    const position = pointToPosition(cursor, doc.lineTextForRow(cursor.row), server.positionEncoding);
    const result = await server.navigate(kind, path, position);
    const loc = firstLocation(result);
    if (!loc) return null;
    return locationToTarget(loc.uri, loc.range.start, server.positionEncoding, doc);
  }

  /** Find references to the symbol at the cursor; resolved to jumpable targets. */
  async references(doc: LspDocument): Promise<ReferenceLocation[]> {
    if (!this.enabled) return [];
    const path = doc.getPath();
    if (!path) return [];
    const server = this.primaryServerForPath(path);
    if (!server || !server.hasReferences) return [];
    const cursor = doc.getCursorBufferPosition();
    const position = pointToPosition(cursor, doc.lineTextForRow(cursor.row), server.positionEncoding);
    const result = await server.references(path, position);
    if (!result) return [];
    return result.map((loc) => locationToTarget(loc.uri, loc.range.start, server.positionEncoding, doc));
  }

  /** Hover info (type/docs) for the symbol at the cursor, as a markdown string. */
  async hover(doc: LspDocument): Promise<string | null> {
    if (!this.enabled) return null;
    const path = doc.getPath();
    if (!path) return null;
    const server = this.primaryServerForPath(path);
    if (!server || !server.hasHover) return null;
    const cursor = doc.getCursorBufferPosition();
    const position = pointToPosition(cursor, doc.lineTextForRow(cursor.row), server.positionEncoding);
    // Bound the request so a slow/unresponsive server can't hang the feature.
    const hover = await Promise.race([
      server.hover(path, position),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    if (!hover) return null;
    const markdown = hoverToMarkdown(hover.contents).trim();
    return markdown || null;
  }

  /**
   * Completion candidates at the cursor (raw LSP items; the UI source adapts them
   * to the framework's shape). Targets the primary server. Bounded by a timeout
   * so a slow server can't stall the popup.
   */
  async completion(doc: LspDocument, opts: { triggerCharacter?: string } = {}): Promise<CompletionItem[]> {
    if (!this.enabled) return [];
    const path = doc.getPath();
    if (!path) return [];
    const server = this.primaryServerForPath(path);
    if (!server || !server.hasCompletion) return [];
    const cursor = doc.getCursorBufferPosition();
    const position = pointToPosition(cursor, doc.lineTextForRow(cursor.row), server.positionEncoding);
    const context = opts.triggerCharacter
      ? { triggerKind: CompletionTriggerKind.TriggerCharacter, triggerCharacter: opts.triggerCharacter }
      : { triggerKind: CompletionTriggerKind.Invoked };
    const result = await Promise.race([
      server.completion(path, position, context),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    if (!result) return [];
    return Array.isArray(result) ? result : result.items;
  }

  /** Trigger characters (e.g. `.`) the primary server wants completion opened on. */
  completionTriggerCharacters(doc: LspDocument): string[] {
    const path = doc.getPath();
    if (!path) return [];
    return this.primaryServerForPath(path)?.completionTriggerCharacters ?? [];
  }

  // --- server management -----------------------------------------------------

  /** Already-running servers for a path (no spawn), in resolution order. */
  private runningServersForPath(path: string): LanguageServer[] {
    const out: LanguageServer[] = [];
    for (const r of this.resolveServers(path)) {
      const server = this.servers.get(r.key);
      if (server) out.push(server);
    }
    return out;
  }

  /**
   * The running server requests target — the primary (language server) for the
   * path, if it is up. Ungrouped linters never become primary, so requests
   * (hover/definition/references) skip them.
   */
  private primaryServerForPath(path: string): LanguageServer | null {
    const primary = this.resolveServers(path).find((r) => r.primary);
    return primary ? this.servers.get(primary.key) ?? null : null;
  }

  /** Spawn + initialize the server for a resolved entry if not already running. */
  private ensureServer(r: ResolvedServer): LanguageServer | null {
    const { server: spec, langId, rootDir, key } = r;
    let server = this.servers.get(key);
    if (!server) {
      // Starting now supersedes any pending backoff restart for this server.
      const pending = this.restartState.get(key)?.pendingTimer;
      if (pending) {
        clearTimeout(pending);
        this.restartState.get(key)!.pendingTimer = undefined;
      }
      server = new LanguageServer(spec, langId, rootDir);
      this.servers.set(key, server);
      server.onDiagnostics((e) => {
        this.diagnostics.set(spec.name, uriToPath(e.uri), e.diagnostics, server!.positionEncoding);
      });
      server.onExit((code) => {
        this.servers.delete(key);
        const st = this.restartState.get(key);
        if (st?.stableTimer) {
          clearTimeout(st.stableTimer);
          st.stableTimer = undefined;
        }
        this.notice('warning', `${spec.name} exited`, code != null ? `exit code ${code}` : undefined);
        this.recoverFromCrash(key, spec, langId);
      });
      this.notice('trace', `starting ${spec.command} for ${langId}`, rootDir);
      void server
        .start()
        .then(() => {
          this.notice('trace', `${spec.name} ready`);
          // Forgive earlier crashes once the server has stayed up a while.
          const st = this.restartStateFor(key);
          if (st.stableTimer) clearTimeout(st.stableTimer);
          st.stableTimer = setTimeout(() => this.restartState.delete(key), STABILITY_MS);
        })
        .catch((err) => {
          this.servers.delete(key);
          this.notice('error', `failed to start ${spec.command}`, (err as Error).message);
        });
    }
    return server;
  }

  // --- crash recovery --------------------------------------------------------

  // A server crashed: clear its now-stale diagnostics, then schedule a restart
  // with exponential backoff (unless disabled, nothing is open, or it's crashing
  // in a tight loop — then give up with an error).
  private recoverFromCrash(key: string, spec: ServerDef, langId: string): void {
    const docs = this.docsForKey(key);
    // Clear only this server's now-stale diagnostics; siblings (e.g. eslint) keep theirs.
    for (const { path } of docs) this.diagnostics.clearServer(spec.name, path);

    if (!this.enabled || docs.length === 0) {
      this.restartState.delete(key);
      return;
    }

    const st = this.restartStateFor(key);
    if (st.attempts >= MAX_RESTARTS) {
      this.notice(
        'error',
        `${spec.name} keeps crashing`,
        `gave up after ${st.attempts} restarts — reopen a ${langId} file to retry`,
      );
      this.restartState.delete(key);
      return;
    }

    const delay = Math.min(BASE_RESTART_DELAY_MS * 2 ** st.attempts, MAX_RESTART_DELAY_MS);
    st.attempts++;
    this.notice('trace', `restarting ${spec.name}`, `attempt ${st.attempts} in ${Math.round(delay / 1000)}s`);
    st.pendingTimer = setTimeout(() => {
      st.pendingTimer = undefined;
      this.restartServer(key);
    }, delay);
  }

  // Re-open every still-open document for a crashed server; the first re-open
  // spawns a fresh instance (it was removed from the map on crash).
  private restartServer(key: string): void {
    if (!this.enabled) return;
    for (const { doc } of this.docsForKey(key)) this.didOpen(doc);
  }

  // Open documents that currently route to `key` (one doc may route to several).
  private docsForKey(key: string): { path: string; doc: LspDocument }[] {
    const out: { path: string; doc: LspDocument }[] = [];
    for (const [path, doc] of this.openDocs) {
      if (this.resolveServers(path).some((r) => r.key === key)) out.push({ path, doc });
    }
    return out;
  }

  private restartStateFor(key: string): RestartState {
    let st = this.restartState.get(key);
    if (!st) {
      st = { attempts: 0 };
      this.restartState.set(key, st);
    }
    return st;
  }

  /**
   * Resolve a path to every server that should run for it (per-project: root
   * markers gate activation, exclusion groups + priority pick within a group;
   * see `LanguageRegistry.activeServers`). The primary is the language server
   * requests target (highest-priority grouped server); ungrouped linters are
   * additive (diagnostics only). Empty when the file maps to no active server.
   */
  private resolveServers(path: string): ResolvedServer[] {
    const langId = languages.languageForPath(path);
    if (!langId) return [];
    const active = languages.activeServers(path);
    if (active.length === 0) return [];
    const primaryKey = primaryKeyOf(active);
    return active.map(({ server, rootDir }) => {
      const key = serverKey(server.name, rootDir);
      return { langId, server, rootDir, key, primary: key === primaryKey };
    });
  }


  /** Shut down every server (e.g. on app quit) and cancel pending restarts. */
  async shutdownAll(): Promise<void> {
    for (const st of this.restartState.values()) {
      if (st.stableTimer) clearTimeout(st.stableTimer);
      if (st.pendingTimer) clearTimeout(st.pendingTimer);
    }
    this.restartState.clear();
    const all = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(all.map((s) => s.shutdown()));
  }
}

// The primary among active servers — the one requests (hover/definition/
// references) target. Grouped servers are the actual language servers, so a
// grouped server always wins over ungrouped linters; ties break on priority.
// Falls back to the first active server when none is grouped. Exported for tests.
export function primaryKeyOf(active: ActiveServer[]): string | null {
  const grouped = active.filter((a) => a.server.group);
  const pool = grouped.length > 0 ? grouped : active;
  if (pool.length === 0) return null;
  let best = pool[0];
  for (const a of pool) {
    if ((a.server.priority ?? 0) > (best.server.priority ?? 0)) best = a;
  }
  return serverKey(best.server.name, best.rootDir);
}

// --- pure helpers (exported for testing) ------------------------------------

/**
 * Resolve the project root for `filePath`: the nearest ancestor directory
 * containing one of the `roots` markers, else the nearest one containing `.git`,
 * else the file's own directory.
 */
export function resolveRootDir(filePath: string, roots: string[]): string {
  const startDir = Path.dirname(Path.resolve(filePath));
  let gitDir: string | null = null;
  let dir = startDir;
  while (true) {
    for (const marker of roots) {
      if (Fs.existsSync(Path.join(dir, marker))) return dir;
    }
    if (gitDir === null && Fs.existsSync(Path.join(dir, '.git'))) gitDir = dir;
    const parent = Path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return gitDir ?? startDir;
}

// Normalize the three shapes of Hover.contents into one markdown string.
// MarkupContent → its value; a {language,value} MarkedString → a fenced block;
// a plain-string MarkedString → itself; an array → joined with blank lines.
function hoverToMarkdown(contents: Hover['contents']): string {
  const one = (c: any): string => {
    if (typeof c === 'string') return c;
    if (c && typeof c === 'object' && 'language' in c) {
      return c.value ? `\`\`\`${c.language}\n${c.value}\n\`\`\`` : '';
    }
    return c?.value ?? ''; // MarkupContent
  };
  return Array.isArray(contents) ? contents.map(one).filter(Boolean).join('\n\n') : one(contents);
}

/** Pick the first concrete location from any LSP definition result shape. */
function firstLocation(result: Definition | LocationLink[] | null): Location | null {
  if (!result) return null;
  const arr = Array.isArray(result) ? result : [result];
  if (arr.length === 0) return null;
  const first = arr[0] as Location | LocationLink;
  // LocationLink uses `targetUri`/`targetSelectionRange`; Location uses `uri`/`range`.
  if ('targetUri' in first) {
    return { uri: first.targetUri, range: first.targetSelectionRange ?? first.targetRange };
  }
  return first;
}

/**
 * Convert an LSP location (uri + start position) to a quilx target, reading the
 * target file's line for accurate encoding conversion. Uses `doc` when the
 * target is the same file already in the editor.
 */
export function locationToTarget(
  uri: string,
  position: Position,
  encoding: PositionEncoding,
  doc: LspDocument,
): ReferenceLocation {
  const path = uriToPath(uri);
  let lineText = '';
  if (doc.getPath() === path) {
    lineText = doc.lineTextForRow(position.line);
  } else {
    try {
      lineText = Fs.readFileSync(path, 'utf8').split('\n')[position.line] ?? '';
    } catch {
      lineText = '';
    }
  }
  return { path, point: positionToPoint(position, lineText, encoding), lineText };
}
