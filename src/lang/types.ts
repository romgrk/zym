/*
 * Language layer types — the contribution shapes a plugin (or the built-in pack)
 * registers with the `LanguageRegistry`. A language is identified once; a grammar
 * and any number of servers attach to it by id (VSCode-style), so contributions
 * can supply any subset (detection only, grammar only, an extra server, …).
 */

/** Comment delimiters, for toggling line comments (`editor:toggle-line-comments`). */
export interface CommentSpec {
  /** Line-comment leader (`//`, `#`, …). */
  line?: string;
  /** Block-comment pair; the per-line wrap used when the language has no `line` leader (CSS, HTML). */
  block?: { start: string; end: string };
}

/** Detection: how a file maps to a language id. */
export interface LanguageDef {
  /** Language id (e.g. `typescript`); grammars/servers attach by this id. */
  id: string;
  /** Bare extensions (no dot), matched against the file's extension. */
  fileTypes?: string[];
  /** Exact basenames (e.g. `Makefile`). */
  filenames?: string[];
  /** Glob patterns matched against the basename (e.g. `*.config.js`). */
  globs?: string[];
  /** Comment delimiters (omit for languages without comments, e.g. JSON). */
  comments?: CommentSpec;
  /**
   * The LSP document `languageId` (per the protocol) when it differs from `id` —
   * `id` is our grammar key, which may not be a valid LSP id.
   */
  lspId?: string;
  /**
   * Per-extension LSP language ids, overriding `lspId`/`id`. Needed when one
   * grammar spans several LSP languages (the `tsx` grammar backs `.js`→javascript,
   * `.jsx`→javascriptreact, `.tsx`→typescriptreact).
   */
  lspIds?: Record<string, string>;
}

/**
 * A language injection: a region of a host grammar's tree highlighted by another
 * grammar (Markdown's fenced code blocks → the code's grammar; Markdown's inline
 * spans → the markdown-inline grammar). The `query` runs against the host grammar
 * and captures the regions to inject; the guest language is named per-match.
 */
export interface InjectionDef {
  /**
   * A tree-sitter query (over the host grammar) capturing the regions to inject.
   * Capture `@content` (or `@injection.content`) for the node(s) to re-highlight,
   * and optionally `@language` (or `@injection.language`) for a node whose *text*
   * names the guest language (e.g. a fenced block's info string).
   */
  query: string;
  /**
   * Guest language id when the query captures no `@language` — a static injection
   * such as an inline self-injection (`language: 'markdown-inline'`). A captured
   * `@language` overrides this.
   */
  language?: string;
}

/**
 * A normalized cross-grammar injection rule — the high-level form contributed by
 * plugins (`ctx.languages.registerInjection`) and by the user
 * (`editor.languageInjections`, after parsing). Unlike `InjectionDef` (which a
 * grammar declares about *itself*), a rule names its `hosts` explicitly, so a plugin
 * can inject into grammars it doesn't own (e.g. CSS-in-JS into the TS/JS grammars).
 *
 * Exactly one matcher is set; `src/syntax/userInjections.ts` compiles it to a
 * tree-sitter query (the `comment`/`tag` sugar) or uses `query` verbatim.
 */
export interface InjectionRule {
  /** Host language ids this rule attaches to (e.g. `['typescript', 'tsx']`). */
  hosts: string[];
  /** Guest language id its captured content is highlighted as. */
  language: string;
  /** Keyword in a line/block comment immediately before a template literal. */
  comment?: string;
  /** Tagged-template tag (a `css` tag, or the root identifier of a `styled.div` tag). */
  tag?: string;
  /** Raw tree-sitter injection query (capturing `@injection.content`), used verbatim. */
  query?: string;
}

/** Tree-sitter grammar binding for a language. */
export interface GrammarDef {
  /** The grammar `.wasm`: an absolute path, or a module specifier resolved
   *  against zym's `node_modules` (e.g. `tree-sitter-wasms/out/…`). */
  wasm: string;
  /** Absolute path to the highlights query file (`…/highlights.scm`). Plugins
   *  vendor this alongside their code (`ctx.resolve('queries/…/highlights.scm')`). */
  highlightsPath: string;
  /** Node types treated as one indent level (the indent source counts enclosing
   *  ones). Also the folding fallback when no `foldsPath` is given. */
  foldTypes: string[];
  /** Absolute path to a tree-sitter folds query (`…/folds.scm`, capturing `@fold`
   *  nodes — incl. comments). Drives folding when present; else `foldTypes` does. */
  foldsPath?: string;
  /** Language injections (e.g. Markdown's code fences + inline spans). Optional. */
  injections?: InjectionDef[];
}

/**
 * How to obtain a server's binary when it isn't installed. Structured sources
 * (e.g. `npm`) let the editor own the install location and map package→binary;
 * `{ command }` is a raw escape hatch for anything that doesn't fit. Installs go
 * into a zym-managed dir (see `lsp/installer.ts`), never the user's env/project.
 */
export type InstallSpec =
  | { via: 'npm'; package: string; version?: string }
  | { command: string[] };

/** An LSP server candidate for a language, with per-project activation. */
export interface ServerDef {
  /** Stable id (e.g. `flow`, `typescript-language-server`). */
  name: string;
  command: string;
  args?: string[];
  /** How to install the server's binary if it's missing (optional). */
  install?: InstallSpec;
  initializationOptions?: unknown;
  settings?: unknown;
  /**
   * Ancestor marker filenames that locate the project root AND gate activation:
   * the server activates only when a root is found (unless `singleFile`).
   */
  roots?: string[];
  /** Activate with no root (root = the file's directory) when no marker is found. */
  singleFile?: boolean;
  /**
   * Mutual-exclusion group. Among activated servers sharing a group, only the
   * highest-`priority` one runs (e.g. flow vs tsserver vs deno). Ungrouped
   * servers (linters like eslint) run additively.
   */
  group?: string;
  /** Tiebreak within a `group`; higher wins. Default 0. */
  priority?: number;
}

/** A server resolved as active for a file, with its located project root. */
export interface ActiveServer {
  server: ServerDef;
  rootDir: string;
}

/**
 * User override for one server within a language, identified by server name.
 * A name matching a built-in server tweaks it; an unknown name with a `command`
 * adds a new server. Set fields replace the built-in's; `disable` removes it.
 */
export interface ServerOverride {
  disable?: boolean;
  command?: string;
  args?: string[];
  initializationOptions?: unknown;
  settings?: unknown;
  roots?: string[];
  singleFile?: boolean;
  group?: string;
  priority?: number;
}

/** Per-language server overrides, keyed by language id then by server name. */
export type ServerOverrides = Record<string, Record<string, ServerOverride>>;
