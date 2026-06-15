/*
 * Language layer types — the contribution shapes a plugin (or the built-in pack)
 * registers with the `LanguageRegistry`. A language is identified once; a grammar
 * and any number of servers attach to it by id (VSCode-style), so contributions
 * can supply any subset (detection only, grammar only, an extra server, …).
 */

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
}

/** Tree-sitter grammar binding for a language. */
export interface GrammarDef {
  /** Resolvable path to the grammar `.wasm`. */
  wasm: string;
  /** Highlights query name (`queries/<query>/highlights.scm`). */
  query: string;
  /** Node types that fold when they span >1 line. */
  foldTypes: string[];
}

/** An LSP server candidate for a language, with per-project activation. */
export interface ServerDef {
  /** Stable id (e.g. `flow`, `typescript-language-server`). */
  name: string;
  command: string;
  args?: string[];
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
