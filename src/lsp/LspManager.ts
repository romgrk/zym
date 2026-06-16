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
import { CompletionTriggerKind, MessageType } from 'vscode-languageserver-protocol';
import type {
  Definition, LocationLink, Location, Position, Hover, CompletionItem,
  CodeAction, Command, Range as LspRange, WorkspaceEdit, TextEdit, FormattingOptions, SignatureHelp,
  SymbolInformation, WorkspaceSymbol, DocumentSymbol, InlayHint,
} from 'vscode-languageserver-protocol';

/** A normalized inlay hint for end-of-line rendering: which buffer row + the label. */
export interface InlayHintInfo {
  line: number;
  label: string;
  paddingLeft: boolean;
}

/** An inlay-hint label is a string or an array of parts ({ value }); join to text. */
function inlayLabelText(label: InlayHint['label']): string {
  return typeof label === 'string' ? label : label.map((part) => part.value).join('');
}
import { Emitter, Disposable } from '../util/eventKit.ts';
import { Point } from '../text/Point.ts';
import { Range } from '../text/Range.ts';
import { languages } from '../lang/index.ts';
import type { ServerDef, ActiveServer, ServerOverrides, InstallSpec } from '../lang/types.ts';
import { LanguageServer, serverKey, type NavigationKind } from './LanguageServer.ts';
export type { NavigationKind } from './LanguageServer.ts';
import { DiagnosticsStore } from './diagnostics/DiagnosticsStore.ts';
import { nodeModulesBinDirs, resolveCommand } from './which.ts';
import { installServer, managedBinDir } from './installer.ts';
import { pointToPosition, positionToPoint, advancePosition, rangeToLsp, uriToPath } from './position.ts';
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

/**
 * One text edit in pre-edit coordinates, for incremental document sync. `start`
 * is where the replaced range began (quilx `Point`); `oldText` is what was there
 * (used to derive the replaced range's end); `newText` is the replacement. The
 * editor adapter maps its buffer-change events to these, keeping this layer
 * GTK-free.
 */
export interface DocumentEdit {
  start: Point;
  oldText: string;
  newText: string;
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

/** A workspace-symbol search hit, resolved to a jumpable target. */
export interface WorkspaceSymbolResult {
  /** Symbol name (e.g. `LspManager`). */
  name: string;
  /** LSP `SymbolKind` (drives the icon). */
  kind: number;
  /** Enclosing symbol (e.g. the class for a method), when the server supplies it. */
  containerName?: string;
  path: string;
  point: Point;
}

/** A symbol in the current document's outline, flattened from the LSP response. */
export interface DocumentSymbolResult {
  /** Symbol name (e.g. `documentSymbols`). */
  name: string;
  /** LSP `SymbolKind` (drives the icon). */
  kind: number;
  /** Enclosing symbol (e.g. the class for a method), when known. */
  containerName?: string;
  /** Nesting depth in the outline (0 = top level), for indentation. */
  depth: number;
  /** Position of the symbol's name (where the cursor lands on jump). */
  point: Point;
}

/** A user-facing trace of a major LSP event, routed to the notification log. */
export interface LspNotice {
  level: 'trace' | 'info' | 'success' | 'warning' | 'error';
  message: string;
  detail?: string;
  /** An optional action the notification offers as a button (e.g. "Install"). */
  action?: { label: string; run: () => void };
  /** Notices sharing a key reuse one transient toast in place (see Notification). */
  replaceKey?: string;
  /** Keep the toast until replaced/closed (vs auto-expiring) — for in-progress notices. */
  sticky?: boolean;
  /** Show a spinner instead of the icon (in-progress). */
  loading?: boolean;
}

export interface LspConfig {
  enable?: boolean;
  /** Language ids to suppress entirely (no servers start). */
  disabledLanguages?: string[];
  /** Per-language server overrides (disable/tweak a server, or add one). */
  serverOverrides?: ServerOverrides;
  /** Install a missing server automatically (default false — otherwise prompt). */
  autoInstall?: boolean;
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
  // Whether a server's command resolves, memoized by `command\0rootDir`; and the
  // commands we've already noted as missing (so the warning fires once).
  private readonly availability = new Map<string, boolean>();
  private readonly reportedMissing = new Set<string>();
  // Server names with an install currently in flight (so we don't install twice).
  private readonly installing = new Set<string>();
  private autoInstall = false;
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
    this.autoInstall = config.autoInstall ?? false;
    languages.setOverrides({
      disabledLanguages: config.disabledLanguages,
      servers: config.serverOverrides,
    });
    // Re-probe availability in case a server was installed since last time.
    this.availability.clear();
    this.reportedMissing.clear();
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
    this.emitNotice({ level, message, detail });
  }

  private emitNotice(notice: LspNotice): void {
    this.emitter.emit('notice', notice);
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
    // The LSP document languageId (e.g. `typescriptreact`), not our grammar id.
    const languageId = languages.lspLanguageId(path) ?? resolved[0].langId;
    for (const r of resolved) {
      const server = this.ensureServer(r);
      // Guard against a duplicate didOpen (e.g. a crash-restart re-opens the doc
      // for the one server that died, while its siblings are already open).
      if (server && !server.isOpen(path)) server.didOpen(path, languageId, text);
    }
  }

  /**
   * Sync a buffer change to every open server. `edits` (pre-edit coordinates,
   * from the editor adapter) enable incremental sync; a server that negotiated it
   * and got a single edit receives just that delta, otherwise the full text.
   */
  didChange(doc: LspDocument, edits?: DocumentEdit[]): void {
    const path = doc.getPath();
    if (!path) return;
    let fullText: string | null = null; // computed once, only if a server needs it
    for (const server of this.runningServersForPath(path)) {
      if (!server.isOpen(path)) continue;
      // Incremental needs a single edit (multiple edits per event have ambiguous
      // sequential coordinates — fall back to full, which is always correct).
      if (server.supportsIncrementalSync && edits?.length === 1) {
        server.didChange(path, [incrementalChange(edits[0], doc, server.positionEncoding)]);
      } else {
        if (fullText === null) fullText = doc.getText();
        server.didChange(path, [{ text: fullText }]);
      }
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

  /**
   * Resolve a completion item against the file's primary server, filling in the
   * documentation/detail many servers omit from the list response. Returns the
   * item unchanged if the server has no resolve support or is slow.
   */
  async resolveCompletion(doc: LspDocument, item: CompletionItem): Promise<CompletionItem> {
    if (!this.enabled) return item;
    const path = doc.getPath();
    if (!path) return item;
    const server = this.primaryServerForPath(path);
    if (!server || !server.hasCompletionResolve) return item;
    const result = await Promise.race([
      server.resolveCompletion(item),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    return result ?? item;
  }

  /** Trigger characters (e.g. `.`) the primary server wants completion opened on. */
  completionTriggerCharacters(doc: LspDocument): string[] {
    const path = doc.getPath();
    if (!path) return [];
    return this.primaryServerForPath(path)?.completionTriggerCharacters ?? [];
  }

  /** Signature help (call's parameter list + active param) at the cursor, or null. */
  async signatureHelp(doc: LspDocument): Promise<SignatureHelp | null> {
    if (!this.enabled) return null;
    const path = doc.getPath();
    if (!path) return null;
    const server = this.primaryServerForPath(path);
    if (!server || !server.hasSignatureHelp) return null;
    const cursor = doc.getCursorBufferPosition();
    const position = pointToPosition(cursor, doc.lineTextForRow(cursor.row), server.positionEncoding);
    return Promise.race([
      server.signatureHelp(path, position),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
  }

  /** Inlay hints for the whole document (parameter names / inferred types), normalized
   *  for end-of-line annotation rendering. Bounded by a timeout. */
  async inlayHints(doc: LspDocument): Promise<InlayHintInfo[]> {
    if (!this.enabled) return [];
    const path = doc.getPath();
    if (!path) return [];
    const server = this.primaryServerForPath(path);
    if (!server || !server.hasInlayHint) return [];
    const lines = doc.getText().split('\n');
    const lastRow = Math.max(0, lines.length - 1);
    const end = pointToPosition(new Point(lastRow, [...lines[lastRow]].length), lines[lastRow], server.positionEncoding);
    const range = { start: { line: 0, character: 0 }, end };
    const hints = await Promise.race([
      server.inlayHint(path, range),
      new Promise<InlayHint[]>((resolve) => setTimeout(() => resolve([]), 3000)),
    ]);
    return hints.map((hint) => ({
      line: hint.position.line,
      label: inlayLabelText(hint.label),
      paddingLeft: !!hint.paddingLeft,
    }));
  }

  /** Characters that (re)trigger signature help (e.g. `(`, `,`) for the primary server. */
  signatureHelpTriggerCharacters(doc: LspDocument): string[] {
    const path = doc.getPath();
    if (!path) return [];
    return this.primaryServerForPath(path)?.signatureHelpTriggerCharacters ?? [];
  }

  /** The primary server's position encoding (for converting `textEdit` ranges). */
  completionPositionEncoding(doc: LspDocument): PositionEncoding | null {
    const path = doc.getPath();
    if (!path) return null;
    return this.primaryServerForPath(path)?.positionEncoding ?? null;
  }

  /**
   * Code actions (quick-fixes, refactors, organize-imports, …) for `range` — or
   * the cursor when omitted — from the primary server. The diagnostics overlapping
   * the range are passed as context so the server can offer their quick-fixes.
   */
  async codeActions(doc: LspDocument, range?: Range): Promise<(Command | CodeAction)[]> {
    if (!this.enabled) return [];
    const path = doc.getPath();
    if (!path) return [];
    const server = this.primaryServerForPath(path);
    if (!server || !server.hasCodeActions) return [];
    const enc = server.positionEncoding;
    const cursor = doc.getCursorBufferPosition();
    const lspRange = rangeToLsp(range ?? new Range(cursor, cursor), (r) => doc.lineTextForRow(r), enc);
    const diagnostics = this.diagnostics
      .get(path)
      .map((e) => e.diagnostic)
      .filter((d) => rangesOverlap(d.range, lspRange));
    const result = await server.codeAction(path, lspRange, { diagnostics });
    return result ?? [];
  }

  /** Resolve a code action's lazy `edit` against the file's primary server. */
  async resolveCodeAction(doc: LspDocument, action: CodeAction): Promise<CodeAction> {
    const path = doc.getPath();
    if (!path) return action;
    return this.primaryServerForPath(path)?.resolveCodeAction(action) ?? action;
  }

  /** Whether the cursor's primary server can rename (for command gating). */
  canRename(doc: LspDocument): boolean {
    const path = doc.getPath();
    return !!path && !!this.primaryServerForPath(path)?.hasRename;
  }

  /** Rename the symbol at the cursor to `newName` → a `WorkspaceEdit`, or null. */
  async rename(doc: LspDocument, newName: string): Promise<WorkspaceEdit | null> {
    if (!this.enabled) return null;
    const path = doc.getPath();
    if (!path) return null;
    const server = this.primaryServerForPath(path);
    if (!server || !server.hasRename) return null;
    const cursor = doc.getCursorBufferPosition();
    const position = pointToPosition(cursor, doc.lineTextForRow(cursor.row), server.positionEncoding);
    return server.rename(path, position, newName);
  }

  /**
   * Format the document (or `range`, if given and the server supports range
   * formatting) → `TextEdit`s. `options` carries the editor's tab settings.
   */
  async format(doc: LspDocument, options: FormattingOptions, range?: Range): Promise<TextEdit[]> {
    if (!this.enabled) return [];
    const path = doc.getPath();
    if (!path) return [];
    const server = this.primaryServerForPath(path);
    if (!server) return [];
    if (range && server.hasRangeFormatting) {
      const lspRange = rangeToLsp(range, (r) => doc.lineTextForRow(r), server.positionEncoding);
      return (await server.rangeFormatting(path, lspRange, options)) ?? [];
    }
    return server.hasFormatting ? (await server.formatting(path, options)) ?? [] : [];
  }

  /** Whether `doc`'s primary server can search workspace symbols (for command gating). */
  canWorkspaceSymbols(doc: LspDocument): boolean {
    const path = doc.getPath();
    return !!path && !!this.primaryServerForPath(path)?.hasWorkspaceSymbols;
  }

  /**
   * Search project-wide symbols matching `query` against `doc`'s primary server,
   * resolved to jumpable targets. The query is matched server-side (so the picker
   * shows the server's ranking); an empty query yields no results on most servers.
   */
  async workspaceSymbols(doc: LspDocument, query: string): Promise<WorkspaceSymbolResult[]> {
    if (!this.enabled) return [];
    const path = doc.getPath();
    if (!path) return [];
    const server = this.primaryServerForPath(path);
    if (!server || !server.hasWorkspaceSymbols) return [];
    const result = await server.workspaceSymbol(query);
    if (!result) return [];
    const enc = server.positionEncoding;
    // Hits cluster in a few files; cache each file's lines so converting many
    // positions (encoding-aware) reads every target file at most once.
    const lineCache = new Map<string, string[]>();
    const linesFor = (p: string): string[] => {
      let lines = lineCache.get(p);
      if (!lines) {
        try { lines = Fs.readFileSync(p, 'utf8').split('\n'); } catch { lines = []; }
        lineCache.set(p, lines);
      }
      return lines;
    };
    return (result as (SymbolInformation | WorkspaceSymbol)[]).map((sym) => {
      const targetPath = uriToPath(sym.location.uri);
      // SymbolInformation carries a full range; a lazy WorkspaceSymbol may have only
      // a uri (needs workspaceSymbol/resolve) — fall back to the file's top.
      const start = 'range' in sym.location ? sym.location.range.start : { line: 0, character: 0 };
      const lineText = linesFor(targetPath)[start.line] ?? '';
      return {
        name: sym.name,
        kind: sym.kind,
        containerName: sym.containerName || undefined,
        path: targetPath,
        point: positionToPoint(start, lineText, enc),
      };
    });
  }

  /** Whether `doc`'s primary server can produce a document outline (for command gating). */
  canDocumentSymbols(doc: LspDocument): boolean {
    const path = doc.getPath();
    return !!path && !!this.primaryServerForPath(path)?.hasDocumentSymbols;
  }

  /**
   * The symbol outline for `doc`, flattened to a depth-tagged list in document
   * order. Handles both response shapes: a hierarchical `DocumentSymbol` tree
   * (positions resolved against the live document) or a flat `SymbolInformation`
   * list (positions resolved against the file on disk).
   */
  async documentSymbols(doc: LspDocument): Promise<DocumentSymbolResult[]> {
    if (!this.enabled) return [];
    const path = doc.getPath();
    if (!path) return [];
    const server = this.primaryServerForPath(path);
    if (!server || !server.hasDocumentSymbols) return [];
    const result = await server.documentSymbol(path);
    if (!result || result.length === 0) return [];
    const enc = server.positionEncoding;

    // Hierarchical shape: positions index into the live document.
    if ('selectionRange' in result[0] || 'children' in result[0]) {
      const out: DocumentSymbolResult[] = [];
      const walk = (nodes: DocumentSymbol[], depth: number, container?: string) => {
        for (const node of nodes) {
          const start = node.selectionRange.start;
          out.push({
            name: node.name,
            kind: node.kind,
            containerName: container,
            depth,
            point: positionToPoint(start, doc.lineTextForRow(start.line), enc),
          });
          if (node.children?.length) walk(node.children, depth + 1, node.name);
        }
      };
      walk(result as DocumentSymbol[], 0);
      return out;
    }

    // Flat shape: `SymbolInformation` — positions index the same (live) document.
    return (result as SymbolInformation[]).map((sym) => {
      const start = sym.location.range.start;
      return {
        name: sym.name,
        kind: sym.kind,
        containerName: sym.containerName || undefined,
        depth: 0,
        point: positionToPoint(start, doc.lineTextForRow(start.line), enc),
      };
    });
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
      // Server-pushed messages (window/showMessage) → the notification log/toasts.
      server.onMessage((m) => this.notice(messageLevel(m.type), `${spec.name}: ${m.message}`));
      // Verbose server logs (window/logMessage): surface only errors/warnings to the
      // trace log (a server explaining why it's idle); drop info/debug chatter.
      server.onLog((m) => {
        if (m.type === MessageType.Error || m.type === MessageType.Warning) {
          this.notice('trace', `${spec.name}: ${m.message}`);
        }
      });
      server.onExit((code) => {
        this.servers.delete(key);
        const st = this.restartState.get(key);
        if (st?.stableTimer) {
          clearTimeout(st.stableTimer);
          st.stableTimer = undefined;
        }
        // Spawn-level failure (e.g. EACCES) carries no exit code — surface its reason.
        const detail = code != null ? `exit code ${code}` : server!.failureReason ?? 'process closed';
        this.notice('warning', `${spec.name} exited`, detail);
        this.recoverFromCrash(key, spec, langId);
      });
      const invocation = [spec.command, ...(spec.args ?? [])].join(' ');
      this.notice('trace', `starting ${spec.name}`, `${invocation} (cwd ${rootDir})`);
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
          // Report why: the spawn-level reason if we have one, else the rejection.
          const reason = server!.failureReason ?? (err as Error).message;
          this.notice('error', `failed to start ${spec.name}`, `${reason} — ${invocation}`);
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
   * see `LanguageRegistry.activeServers`). Servers whose command isn't installed
   * are dropped here — so an uninstalled optional server is skipped quietly
   * rather than spawned, failed, and crash-restarted. The primary is the language
   * server requests target (highest-priority grouped server); ungrouped linters
   * are additive (diagnostics only). Empty when nothing active is installed.
   */
  private resolveServers(path: string): ResolvedServer[] {
    const langId = languages.languageForPath(path);
    if (!langId) return [];
    const active = languages.activeServers(path).filter((a) => this.isInstalled(a.server, a.rootDir));
    if (active.length === 0) return [];
    const primaryKey = primaryKeyOf(active);
    return active.map(({ server, rootDir }) => {
      const key = serverKey(server.name, rootDir);
      return { langId, server, rootDir, key, primary: key === primaryKey };
    });
  }

  // Whether a server's command resolves (quilx-managed dir, then project
  // node_modules/.bin, then PATH), memoized per (command, rootDir). The first time
  // it's found missing, `handleMissing` decides what to do about it (once).
  private isInstalled(server: ServerDef, rootDir: string): boolean {
    const cacheKey = `${server.command}\0${rootDir}`;
    let installed = this.availability.get(cacheKey);
    if (installed === undefined) {
      const dirs = [managedBinDir(server.name), ...nodeModulesBinDirs(rootDir)];
      installed = resolveCommand(server.command, dirs) !== null;
      this.availability.set(cacheKey, installed);
      if (!installed) this.handleMissing(server, rootDir);
    }
    return installed;
  }

  // A server's command isn't installed. Auto-install if enabled and we know how;
  // otherwise warn once — with an "Install" action when an install method exists.
  private handleMissing(server: ServerDef, rootDir: string): void {
    if (server.install && this.autoInstall) {
      void this.install(server, true);
      return;
    }
    if (this.reportedMissing.has(server.command)) return;
    this.reportedMissing.add(server.command);
    const detail = `command "${server.command}" not found on PATH or in node_modules/.bin (from ${rootDir})`;
    if (server.install) {
      // Sticky + the install `replaceKey`, so the prompt persists until acted on
      // and clicking Install transforms this same toast into installing→installed.
      this.emitNotice({
        level: 'warning',
        message: `${server.name} not started`,
        detail,
        action: { label: 'Install', run: () => void this.install(server) },
        replaceKey: installNoticeKey(server),
        sticky: true,
      });
    } else {
      this.notice('warning', `${server.name} not started`, detail);
    }
  }

  // Install a server into the managed dir, then re-probe and reload so it starts.
  // `auto` marks an install kicked off by `lsp.autoInstall` (vs a user click) so
  // the info notice makes clear it happened on its own — never silently.
  private async install(server: ServerDef, auto = false): Promise<void> {
    if (!server.install || this.installing.has(server.name)) return;
    this.installing.add(server.name);
    // One transient toast spans the install: the in-progress notice is sticky and
    // shares a `replaceKey` with the result, which transforms it in place. The log
    // keeps both as separate entries.
    const replaceKey = installNoticeKey(server);
    const detail = describeInstall(server.install);
    const message = auto ? `auto-installing ${server.name}` : `installing ${server.name}…`;
    this.emitNotice({ level: 'info', message, detail, replaceKey, sticky: true, loading: true });
    const result = await installServer(server);
    this.installing.delete(server.name);
    if (result.ok) {
      // Keep the same `detail` so the in-place toast doesn't shift when it swaps.
      this.emitNotice({ level: 'success', message: `${server.name} installed`, detail, replaceKey });
      // Forget cached "missing" verdicts so the freshly-installed binary is seen.
      this.availability.clear();
      this.reportedMissing.clear();
      void this.reload();
    } else {
      this.emitNotice({ level: 'error', message: `failed to install ${server.name}`, detail: result.message, replaceKey });
    }
  }

  /** Built-in servers that declare an install method, with current install state. */
  installableServers(): { name: string; command: string; installed: boolean; installing: boolean }[] {
    return languages.installableServers().map((s) => ({
      name: s.name,
      command: s.command,
      installed: resolveCommand(s.command, [managedBinDir(s.name)]) !== null,
      installing: this.installing.has(s.name),
    }));
  }

  /** Install a server by name (for the `lsp:install-server` command). */
  async installByName(name: string): Promise<void> {
    const server = languages.installableServers().find((s) => s.name === name);
    if (server) await this.install(server);
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

/** A short human-readable description of how a server installs (for notices). */
function describeInstall(spec: InstallSpec): string {
  return 'via' in spec ? `npm install ${spec.package}` : spec.command.join(' ');
}

/** Shared transient-toast key for a server's install lifecycle (prompt → installing → done). */
function installNoticeKey(server: ServerDef): string {
  return `lsp-install:${server.name}`;
}

/**
 * Build an incremental `didChange` content change from a single edit. The
 * replaced range's start is converted with the (unchanged) prefix of its current
 * line; its end is derived from start + `oldText` (encoding-aware), so it lands in
 * the server's pre-change coordinates without needing the old line text. Exported
 * for testing.
 */
export function incrementalChange(
  edit: DocumentEdit,
  doc: Pick<LspDocument, 'lineTextForRow'>,
  encoding: PositionEncoding,
): { range: { start: Position; end: Position }; text: string } {
  const start = pointToPosition(edit.start, doc.lineTextForRow(edit.start.row), encoding);
  const end = advancePosition(start, edit.oldText, encoding);
  return { range: { start, end }, text: edit.newText };
}

// Whether two LSP ranges overlap (touching endpoints count, so an empty cursor
// range at a diagnostic's edge still picks up its quick-fixes).
function rangesOverlap(a: LspRange, b: LspRange): boolean {
  const before = (p: Position, q: Position) => p.line < q.line || (p.line === q.line && p.character < q.character);
  return !before(a.end, b.start) && !before(b.end, a.start);
}

/** Map an LSP `window/showMessage` MessageType to a notice level. */
function messageLevel(type: number): LspNotice['level'] {
  if (type === MessageType.Error) return 'error';
  if (type === MessageType.Warning) return 'warning';
  if (type === MessageType.Info) return 'info';
  return 'trace'; // Log / Debug
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
