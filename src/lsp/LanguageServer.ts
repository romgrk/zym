/*
 * LanguageServer — the LSP lifecycle and document state for one server process,
 * keyed by (server, rootDir) and shared by every open file under that root.
 *
 * Owns an `LspClient` (transport) and adds: the initialize→initialized→shutdown
 * handshake, negotiated capabilities + position encoding, open-document version
 * tracking, full-text document sync, and the typed requests Phase 1 uses
 * (go-to-definition). It speaks LSP types (URIs, `Position`); callers convert
 * to/from quilx `Point`/`Range` via `position.ts`.
 */
import {
  InitializeRequest,
  InitializedNotification,
  ShutdownRequest,
  ExitNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidSaveTextDocumentNotification,
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesNotification,
  PublishDiagnosticsNotification,
  ConfigurationRequest,
  RegistrationRequest,
  UnregistrationRequest,
  WorkDoneProgressCreateRequest,
  ShowMessageNotification,
  LogMessageNotification,
  DefinitionRequest,
  DeclarationRequest,
  TypeDefinitionRequest,
  ImplementationRequest,
  ReferencesRequest,
  HoverRequest,
  CompletionRequest,
  CompletionResolveRequest,
  CodeActionRequest,
  CodeActionResolveRequest,
  RenameRequest,
  PrepareRenameRequest,
  DocumentFormattingRequest,
  DocumentRangeFormattingRequest,
  TextDocumentSyncKind,
  MessageType,
  type ClientCapabilities,
  type ServerCapabilities,
  type Diagnostic,
  type Position,
  type Range as LspRange,
  type Location,
  type Definition,
  type LocationLink,
  type Hover,
  type CompletionList,
  type CompletionItem,
  type CompletionContext,
  type CodeAction,
  type Command,
  type CodeActionContext,
  type WorkspaceEdit,
  type TextEdit,
  type FormattingOptions,
} from 'vscode-languageserver-protocol';
import { Emitter, Disposable } from '../util/eventKit.ts';
import { LspClient } from './LspClient.ts';
import { pathToUri, uriToPath } from './position.ts';
import { WorkspaceWatcher, type FileChange } from './workspaceWatcher.ts';
import { watcherRegExp } from './glob.ts';
import type { ServerDef } from '../lang/types.ts';
import type { PositionEncoding } from './position.ts';

/** A diagnostics push for one document. */
export interface DiagnosticsEvent {
  uri: string;
  diagnostics: Diagnostic[];
}

/** One `didChange` content change: full-text (`{ text }`) or incremental (`+ range`). */
export type ContentChange = { text: string; range?: LspRange };

/** A `client/registerCapability` entry for `workspace/didChangeWatchedFiles`. */
interface WatcherRegistration {
  id: string;
  method: string;
  registerOptions?: {
    watchers?: { globPattern: string | { baseUri: string | { uri: string }; pattern: string } }[];
  };
}

export class LanguageServer {
  readonly langId: string;
  readonly rootDir: string;
  readonly key: string;
  private readonly client: LspClient;
  private readonly emitter = new Emitter();
  private capabilities: ServerCapabilities = {};
  private encoding: PositionEncoding = 'utf-16';
  private readyPromise: Promise<void> | null = null;
  // Server-specific init options (sent in `initialize`), e.g. tsserver plugins.
  private readonly initializationOptions: unknown;
  // Server settings, answered to `workspace/configuration` requests and pushed via
  // `workspace/didChangeConfiguration` (e.g. eslint's options).
  private readonly settings: unknown;
  // uri → document version (monotonic, per LSP didChange contract).
  private readonly versions = new Map<string, number>();
  // File-watching: registration id → its watcher glob regexes (matching absolute
  // paths), and the lazily-created tree watcher feeding didChangeWatchedFiles.
  private readonly watchRegistrations = new Map<string, RegExp[]>();
  private watcher: WorkspaceWatcher | null = null;

  constructor(spec: ServerDef, langId: string, rootDir: string) {
    this.langId = langId;
    this.rootDir = rootDir;
    this.key = serverKey(spec.name, rootDir);
    this.initializationOptions = spec.initializationOptions;
    this.settings = spec.settings;
    this.client = new LspClient(spec, rootDir);
  }

  get positionEncoding(): PositionEncoding {
    return this.encoding;
  }

  /** Why the process failed to spawn/connect (e.g. an EACCES message), if known. */
  get failureReason(): string | undefined {
    return this.client.failureReason;
  }

  /** Start the process and run the initialize handshake (idempotent). */
  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.doStart();
    return this.readyPromise;
  }

  private async doStart(): Promise<void> {
    this.client.start();
    this.client.onExit((code) => this.emitter.emit('exit', code));
    this.client.onNotification(PublishDiagnosticsNotification.type, (p) =>
      this.emitter.emit('diagnostics', { uri: p.uri, diagnostics: p.diagnostics } satisfies DiagnosticsEvent),
    );
    // Server messages → surfaced by the manager (showMessage is user-facing;
    // logMessage is verbose server output, routed to the trace log).
    this.client.onNotification(ShowMessageNotification.type, (p) => this.emitter.emit('message', p));
    this.client.onNotification(LogMessageNotification.type, (p) => this.emitter.emit('log', p));

    // Answer the server→client requests (otherwise vscode-jsonrpc replies
    // MethodNotFound, which e.g. stops eslint from ever linting):
    //  - workspace/configuration → our `settings`, resolved per requested section
    this.client.onRequest(ConfigurationRequest.type, (params: { items: { section?: string }[] }) =>
      params.items.map((item) => getConfigSection(this.settings, item.section)),
    );
    //  - client/registerCapability: we act on file-watcher registrations (and
    //    acknowledge the rest); progress-token creation is acknowledged.
    this.client.onRequest(RegistrationRequest.type, (params: { registrations?: WatcherRegistration[] }) => {
      for (const reg of params.registrations ?? []) {
        if (reg.method === DidChangeWatchedFilesNotification.method) this.registerWatchers(reg);
      }
      return null;
    });
    this.client.onRequest(UnregistrationRequest.type, (params: { unregisterations?: { id: string }[] }) => {
      for (const unreg of params.unregisterations ?? []) this.watchRegistrations.delete(unreg.id);
      if (this.watchRegistrations.size === 0) this.disposeWatcher();
      return null;
    });
    this.client.onRequest(WorkDoneProgressCreateRequest.type, () => null);

    const result = await this.client.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: pathToUri(this.rootDir),
      workspaceFolders: [{ uri: pathToUri(this.rootDir), name: this.rootDir }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: this.initializationOptions,
    });
    this.capabilities = result.capabilities;
    this.encoding = (result.capabilities.positionEncoding as PositionEncoding) ?? 'utf-16';
    this.client.sendNotification(InitializedNotification.type, {});
    // Push settings too (the notification model), for servers that read them here
    // rather than pulling via workspace/configuration.
    if (this.settings !== undefined) {
      this.client.sendNotification(DidChangeConfigurationNotification.type, { settings: this.settings });
    }
  }

  // --- file watching (workspace/didChangeWatchedFiles) -----------------------

  // Record a server's file-watcher registration: compile each watcher's glob to
  // an absolute-path regex, and start the tree watcher on first registration.
  private registerWatchers(reg: WatcherRegistration): void {
    const watchers = reg.registerOptions?.watchers ?? [];
    const regexes = watchers.map((w) => {
      const { base, pattern } = this.resolveGlob(w.globPattern);
      return watcherRegExp(base, pattern);
    });
    if (regexes.length === 0) return;
    this.watchRegistrations.set(reg.id, regexes);
    if (!this.watcher) {
      this.watcher = new WorkspaceWatcher(this.rootDir, (changes) => this.onWatchedChanges(changes));
      this.watcher.start();
    }
  }

  // A glob may be a bare string (relative to the workspace root) or a
  // RelativePattern ({ baseUri, pattern }) — normalize to a literal base + glob.
  private resolveGlob(globPattern: string | { baseUri: string | { uri: string }; pattern: string }): {
    base: string;
    pattern: string;
  } {
    if (typeof globPattern === 'string') return { base: this.rootDir, pattern: globPattern };
    const baseUri = typeof globPattern.baseUri === 'string' ? globPattern.baseUri : globPattern.baseUri.uri;
    return { base: uriToPath(baseUri), pattern: globPattern.pattern };
  }

  // Forward only the changes matching a registered watcher glob to the server.
  private onWatchedChanges(changes: FileChange[]): void {
    const regexes = [...this.watchRegistrations.values()].flat();
    const matched = changes.filter((c) => regexes.some((re) => re.test(c.path)));
    if (matched.length === 0) return;
    this.client.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: matched.map((c) => ({ uri: pathToUri(c.path), type: c.type })),
    });
  }

  private disposeWatcher(): void {
    this.watcher?.dispose();
    this.watcher = null;
  }

  /** Whether the server advertised support for a navigation kind. */
  supportsNavigation(kind: NavigationKind): boolean {
    return !!this.capabilities[NAVIGATION[kind].capability];
  }

  /** Whether the server advertised support for find-references. */
  get hasReferences(): boolean {
    return !!this.capabilities.referencesProvider;
  }

  /** Whether the server advertised support for hover. */
  get hasHover(): boolean {
    return !!this.capabilities.hoverProvider;
  }

  /** Whether the server advertised support for completion. */
  get hasCompletion(): boolean {
    return !!this.capabilities.completionProvider;
  }

  /** Characters that should trigger completion (e.g. `.`), per the server. */
  get completionTriggerCharacters(): string[] {
    const provider = this.capabilities.completionProvider;
    return (typeof provider === 'object' && provider.triggerCharacters) || [];
  }

  /** Whether the server resolves completion items lazily (`completionItem/resolve`,
   *  where many servers — e.g. tsserver — send the documentation/detail). */
  get hasCompletionResolve(): boolean {
    const provider = this.capabilities.completionProvider;
    return typeof provider === 'object' && !!provider.resolveProvider;
  }

  /** Whether the server negotiated incremental document sync (vs full-text). */
  get supportsIncrementalSync(): boolean {
    const sync = this.capabilities.textDocumentSync;
    const kind = typeof sync === 'object' ? sync.change : sync;
    return kind === TextDocumentSyncKind.Incremental;
  }

  // --- document sync --------------------------------------------------------

  // Defer a document notification until the initialize handshake has completed,
  // so notifications never reach the server before `initialized` (LSP ordering).
  // `start()` is idempotent; chaining on the same promise preserves call order.
  private send(fn: () => void): void {
    void this.start().then(fn).catch(() => {
      // Server failed to initialize / went away — drop the notification.
    });
  }

  didOpen(path: string, languageId: string, text: string): void {
    const uri = pathToUri(path);
    this.versions.set(uri, 1);
    this.send(() =>
      this.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId, version: 1, text },
      }),
    );
  }

  /**
   * Sync a buffer change. `contentChanges` is either a single full-text entry
   * (`[{ text }]`) or incremental entries (`[{ range, text }, …]`); the caller
   * picks based on `supportsIncrementalSync`. Versions bump monotonically.
   */
  didChange(path: string, contentChanges: ContentChange[]): void {
    const uri = pathToUri(path);
    if (!this.versions.has(uri)) return; // not open
    const version = (this.versions.get(uri) ?? 1) + 1;
    this.versions.set(uri, version);
    this.send(() =>
      this.client.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version },
        contentChanges,
      }),
    );
  }

  didSave(path: string, text?: string): void {
    const uri = pathToUri(path);
    if (!this.versions.has(uri)) return;
    this.send(() =>
      this.client.sendNotification(DidSaveTextDocumentNotification.type, {
        textDocument: { uri },
        ...(text !== undefined ? { text } : {}),
      }),
    );
  }

  didClose(path: string): void {
    const uri = pathToUri(path);
    if (!this.versions.delete(uri)) return;
    this.send(() =>
      this.client.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri },
      }),
    );
  }

  isOpen(path: string): boolean {
    return this.versions.has(pathToUri(path));
  }

  // --- requests --------------------------------------------------------------

  /** Resolve a navigation (definition/declaration/type-def/impl); LSP locations or null. */
  async navigate(
    kind: NavigationKind,
    path: string,
    position: Position,
  ): Promise<Definition | LocationLink[] | null> {
    if (!this.supportsNavigation(kind)) return null;
    await this.start();
    return this.client.sendRequest(NAVIGATION[kind].request.type, {
      textDocument: { uri: pathToUri(path) },
      position,
    });
  }

  /** Find all references to the symbol at `position` (declaration included). */
  async references(path: string, position: Position): Promise<Location[] | null> {
    if (!this.hasReferences) return null;
    await this.start();
    return this.client.sendRequest(ReferencesRequest.type, {
      textDocument: { uri: pathToUri(path) },
      position,
      context: { includeDeclaration: true },
    });
  }

  /** Hover (type/docs) for the symbol at `position`, or null. */
  async hover(path: string, position: Position): Promise<Hover | null> {
    if (!this.hasHover) return null;
    await this.start();
    return this.client.sendRequest(HoverRequest.type, {
      textDocument: { uri: pathToUri(path) },
      position,
    });
  }

  /** Completion candidates at `position` (a list or bare array), or null. */
  async completion(
    path: string,
    position: Position,
    context?: CompletionContext,
  ): Promise<CompletionList | CompletionItem[] | null> {
    if (!this.hasCompletion) return null;
    await this.start();
    return this.client.sendRequest(CompletionRequest.type, {
      textDocument: { uri: pathToUri(path) },
      position,
      context,
    });
  }

  /** Resolve a completion item (fills in documentation/detail the list omitted). */
  async resolveCompletion(item: CompletionItem): Promise<CompletionItem> {
    if (!this.hasCompletionResolve) return item;
    await this.start();
    return this.client.sendRequest(CompletionResolveRequest.type, item);
  }

  /** Whether the server advertised support for code actions. */
  get hasCodeActions(): boolean {
    return !!this.capabilities.codeActionProvider;
  }

  /** Whether code actions are resolved lazily (`codeAction/resolve` fills the `edit`). */
  get hasCodeActionResolve(): boolean {
    const provider = this.capabilities.codeActionProvider;
    return typeof provider === 'object' && !!provider.resolveProvider;
  }

  /** Code actions (quick-fixes, refactors, …) for `range`, given its diagnostics. */
  async codeAction(
    path: string,
    range: LspRange,
    context: CodeActionContext,
  ): Promise<(Command | CodeAction)[] | null> {
    if (!this.hasCodeActions) return null;
    await this.start();
    return this.client.sendRequest(CodeActionRequest.type, {
      textDocument: { uri: pathToUri(path) },
      range,
      context,
    });
  }

  /** Resolve a code action's lazy `edit` (servers often omit it from the list). */
  async resolveCodeAction(action: CodeAction): Promise<CodeAction> {
    if (!this.hasCodeActionResolve || action.edit) return action;
    await this.start();
    return this.client.sendRequest(CodeActionResolveRequest.type, action);
  }

  /** Whether the server advertised support for rename. */
  get hasRename(): boolean {
    return !!this.capabilities.renameProvider;
  }

  /** Rename the symbol at `position` to `newName` → a `WorkspaceEdit`, or null. */
  async rename(path: string, position: Position, newName: string): Promise<WorkspaceEdit | null> {
    if (!this.hasRename) return null;
    await this.start();
    return this.client.sendRequest(RenameRequest.type, {
      textDocument: { uri: pathToUri(path) },
      position,
      newName,
    });
  }

  /** Validate a rename at `position` (range + placeholder), or null if not renamable. */
  async prepareRename(path: string, position: Position): Promise<{ range: LspRange; placeholder?: string } | null> {
    const provider = this.capabilities.renameProvider;
    if (typeof provider !== 'object' || !provider.prepareProvider) return null;
    await this.start();
    return this.client.sendRequest(PrepareRenameRequest.type, {
      textDocument: { uri: pathToUri(path) },
      position,
    });
  }

  /** Whether the server can format a whole document. */
  get hasFormatting(): boolean {
    return !!this.capabilities.documentFormattingProvider;
  }

  /** Whether the server can format a range. */
  get hasRangeFormatting(): boolean {
    return !!this.capabilities.documentRangeFormattingProvider;
  }

  /** Format the whole document → `TextEdit`s, or null. */
  async formatting(path: string, options: FormattingOptions): Promise<TextEdit[] | null> {
    if (!this.hasFormatting) return null;
    await this.start();
    return this.client.sendRequest(DocumentFormattingRequest.type, {
      textDocument: { uri: pathToUri(path) },
      options,
    });
  }

  /** Format a range → `TextEdit`s, or null. */
  async rangeFormatting(path: string, range: LspRange, options: FormattingOptions): Promise<TextEdit[] | null> {
    if (!this.hasRangeFormatting) return null;
    await this.start();
    return this.client.sendRequest(DocumentRangeFormattingRequest.type, {
      textDocument: { uri: pathToUri(path) },
      range,
      options,
    });
  }

  // --- events ----------------------------------------------------------------

  onDiagnostics(handler: (event: DiagnosticsEvent) => void): Disposable {
    return this.emitter.on('diagnostics', handler as (v?: unknown) => void);
  }

  onExit(handler: (code: number | null) => void): Disposable {
    return this.emitter.on('exit', handler as (v?: unknown) => void);
  }

  /** A `window/showMessage` from the server (`{ type, message }`) — user-facing. */
  onMessage(handler: (params: { type: number; message: string }) => void): Disposable {
    return this.emitter.on('message', handler as (v?: unknown) => void);
  }

  /** A `window/logMessage` from the server (`{ type, message }`) — verbose output. */
  onLog(handler: (params: { type: number; message: string }) => void): Disposable {
    return this.emitter.on('log', handler as (v?: unknown) => void);
  }

  /** Politely shut the server down, then tear down the transport. */
  async shutdown(): Promise<void> {
    this.disposeWatcher();
    try {
      await this.client.sendRequest(ShutdownRequest.type, undefined);
      this.client.sendNotification(ExitNotification.type, undefined);
    } catch {
      // ignore — we kill the process next regardless
    }
    this.client.dispose();
  }
}

/** Stable identity for reusing a server across files of one project. */
export function serverKey(serverName: string, rootDir: string): string {
  return `${serverName} ${rootDir}`;
}

/** Single-target navigation requests (each returns one or more locations). */
export type NavigationKind = 'definition' | 'declaration' | 'typeDefinition' | 'implementation';

// Maps a navigation kind to its request type and the capability that gates it.
const NAVIGATION = {
  definition: { request: DefinitionRequest, capability: 'definitionProvider' },
  declaration: { request: DeclarationRequest, capability: 'declarationProvider' },
  typeDefinition: { request: TypeDefinitionRequest, capability: 'typeDefinitionProvider' },
  implementation: { request: ImplementationRequest, capability: 'implementationProvider' },
} satisfies Record<NavigationKind, { request: { type: unknown }; capability: keyof ServerCapabilities }>;

// Advertised client capabilities (full-text sync, diagnostics, navigation,
// references); extended as features land.
const CLIENT_CAPABILITIES: ClientCapabilities = {
  general: { positionEncodings: ['utf-8', 'utf-16'] },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: true },
    publishDiagnostics: { relatedInformation: true },
    definition: { dynamicRegistration: false, linkSupport: true },
    declaration: { dynamicRegistration: false, linkSupport: true },
    typeDefinition: { dynamicRegistration: false, linkSupport: true },
    implementation: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
    completion: {
      dynamicRegistration: false,
      // No snippet support yet, so servers send plain insert text (not ${…} tabstops).
      // `labelDetailsSupport` makes servers split the concise signature
      // (`labelDetails.detail`) from the source module (`labelDetails.description`)
      // instead of cramming both into `detail`.
      completionItem: {
        snippetSupport: false,
        documentationFormat: ['markdown', 'plaintext'],
        labelDetailsSupport: true,
      },
    },
    codeAction: {
      dynamicRegistration: false,
      // Accept CodeAction literals (with kinds) rather than only Commands, and
      // resolve their `edit` lazily — many servers omit it from the list.
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: ['quickfix', 'refactor', 'refactor.extract', 'refactor.inline',
            'refactor.rewrite', 'source', 'source.organizeImports', 'source.fixAll'],
        },
      },
      resolveSupport: { properties: ['edit'] },
      dataSupport: true,
    },
    rename: { dynamicRegistration: false, prepareSupport: true },
    formatting: { dynamicRegistration: false },
    rangeFormatting: { dynamicRegistration: false },
  },
  workspace: {
    workspaceFolders: true,
    // We answer workspace/configuration and accept didChangeConfiguration, so
    // config-driven servers (eslint, …) can read their settings.
    configuration: true,
    didChangeConfiguration: { dynamicRegistration: false },
    // We honor dynamically-registered file watchers (workspace/didChangeWatchedFiles).
    didChangeWatchedFiles: { dynamicRegistration: true },
  },
  // Accept progress tokens (we ack window/workDoneProgress/create); not yet shown.
  window: { workDoneProgress: true },
};

/**
 * Resolve a requested config `section` (a dotted path, per `workspace/configuration`)
 * against a server's `settings` object. No section → the whole settings; a missing
 * path → null (the LSP "no configuration" value). Pure; exported for testing.
 */
export function getConfigSection(settings: unknown, section: string | undefined): unknown {
  if (settings == null) return null;
  if (!section) return settings;
  let current: unknown = settings;
  for (const key of section.split('.')) {
    if (current && typeof current === 'object' && key in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return null;
    }
  }
  return current ?? null;
}

export { TextDocumentSyncKind, MessageType };
