/*
 * Tree-sitter grammar registry and loader.
 *
 * Owns the one-time web-tree-sitter runtime init and a small table mapping
 * language ids (and file extensions) to a grammar wasm, a highlights query, and
 * the node types worth folding. Grammars are loaded lazily and cached.
 *
 * web-tree-sitter is pinned to 0.20.x: it's CommonJS (`export = Parser`, so the
 * Language class hangs off Parser and queries are built with `language.query`),
 * and its ABI matches the prebuilt tree-sitter-wasms grammars. See
 * memory: node-gtk-vfunc-constraints / treesitter-highlight-fold-findings.
 */
import { createRequire } from 'node:module';
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { languages } from '../lang/index.ts';

const require_ = createRequire(import.meta.url);
const Parser = require_('web-tree-sitter') as any;

let initPromise: Promise<void> | null = null;

/** Initialize the web-tree-sitter runtime exactly once. */
export function initTreeSitter(): Promise<void> {
  if (!initPromise) {
    const dir = Path.dirname(require_.resolve('web-tree-sitter'));
    initPromise = Parser.init({ locateFile: (name: string) => Path.join(dir, name) }) as Promise<void>;
  }
  return initPromise!;
}

/** A compiled language injection: a query over the host + the guest language. */
export interface CompiledInjection {
  /** Compiled query capturing `@content` (+ optional `@language`) over the host. */
  query: any;
  /** Static guest language id when the match captures no `@language`. */
  language?: string;
}

/** A loaded grammar: the parser language, its highlights query, fold node types. */
export interface Grammar {
  language: any;
  query: any;
  foldTypes: Set<string>;
  /** Compiled folds query (`@fold` captures); null when the grammar ships none. */
  foldsQuery: any | null;
  /** Language injections declared by the grammar (empty when none). */
  injections: CompiledInjection[];
}

// Highlights queries are vendored verbatim from Zed (GPL-3.0; see /LICENSE and the
// header in each .scm). They use Zed's capture names; the highlighter maps those
// to colors with longest-prefix fallback — e.g. @function.method → @function — so
// dotted names need no special handling here (see theme/theme.ts and
// syntax-controller's resolveTag). Each grammar's `highlightsPath` (a `GrammarDef`
// field) is an absolute path the contributing plugin owns; this module just reads
// it.
//
// The language definitions (extensions, grammar wasm + query + fold types) live
// in the `LanguageRegistry` (src/lang), contributed by plugins (src/plugins);
// this module just loads/caches the wasm and runs the query. Grammar specs come
// from `languages.grammarFor`.

/** Resolve a grammar's wasm: absolute paths as-is, else a node_modules specifier. */
function resolveWasm(wasm: string): string {
  return Path.isAbsolute(wasm) ? wasm : require_.resolve(wasm);
}

/** Map a file path to a known language id, or null if unsupported. */
export function langIdForPath(path: string): string | null {
  return languages.languageForPath(path);
}

const cache = new Map<string, Grammar>();

/** Load (and cache) a grammar by language id, or null if unknown. */
export async function loadGrammar(langId: string): Promise<Grammar | null> {
  const spec = languages.grammarFor(langId);
  if (!spec) return null;
  const cached = cache.get(langId);
  if (cached) return cached;

  await initTreeSitter();
  const language = await Parser.Language.load(resolveWasm(spec.wasm));
  const grammar: Grammar = {
    language,
    query: language.query(Fs.readFileSync(spec.highlightsPath, 'utf8')),
    foldTypes: new Set(spec.foldTypes),
    foldsQuery: spec.foldsPath ? language.query(Fs.readFileSync(spec.foldsPath, 'utf8')) : null,
    injections: (spec.injections ?? []).map((inj) => ({
      query: language.query(inj.query),
      language: inj.language,
    })),
  };
  cache.set(langId, grammar);
  return grammar;
}

/** Synchronously get an already-loaded grammar, or null if not preloaded. */
export function getGrammar(langId: string): Grammar | null {
  return cache.get(langId) ?? null;
}

/** Drop a cached grammar (e.g. when a plugin unregisters it). */
export function clearGrammar(langId: string): void {
  cache.delete(langId);
}

// Common fenced-code-block info-string names → a file extension the registry
// knows, so e.g. ```python / ```c++ resolve to the right grammar even though the
// language detection is keyed by extension. Only the spelling differs here; the
// registry still decides whether a grammar is actually registered for it.
const FENCE_ALIASES: Record<string, string> = {
  javascript: 'js', js: 'js', node: 'js',
  typescript: 'ts', ts: 'ts',
  jsx: 'jsx', tsx: 'tsx',
  python: 'py', py: 'py',
  ruby: 'rb', rb: 'rb',
  rust: 'rs', rs: 'rs',
  golang: 'go', go: 'go',
  'c++': 'cpp', cxx: 'cpp', cpp: 'cpp',
  'c#': 'cs', csharp: 'cs', cs: 'cs',
  shell: 'sh', bash: 'sh', zsh: 'sh', sh: 'sh',
  yml: 'yaml', yaml: 'yaml',
  html: 'html', css: 'css', json: 'json',
};

/**
 * Resolve a language *name* (an injection's guest language — a grammar langId, a
 * file extension, or a fenced-code info string like `typescript`/`c++`) to a
 * registered grammar's langId, or null. Pure (no wasm); injectable registry for
 * tests. Tries, in order: the name as a langId with a grammar; an alias→extension
 * via the registry's detection; the alias as a langId.
 */
export function resolveGuestLangId(name: string, reg = languages): string | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  if (reg.grammarFor(n)) return n; // a langId that has a grammar (e.g. markdown-inline, tsx)
  const alias = FENCE_ALIASES[n] ?? n;
  const byExt = reg.languageForPath(`x.${alias}`);
  if (byExt && reg.grammarFor(byExt)) return byExt; // 'ts' → typescript, 'js' → tsx, …
  return reg.grammarFor(alias) ? alias : null;
}

/** The already-loaded grammar for an injection's guest language name, or null. */
export function grammarForName(name: string): Grammar | null {
  const langId = resolveGuestLangId(name);
  return langId ? getGrammar(langId) : null;
}

/**
 * Load the runtime and every known grammar up front. Must be awaited BEFORE the
 * GLib main loop starts: emscripten's async wasm init does not resolve once the
 * loop is running, so grammars are loaded here and used synchronously after.
 */
export async function preloadGrammars(): Promise<void> {
  await initTreeSitter();
  for (const id of languages.grammarLanguageIds()) {
    // One grammar failing to load (a missing/ABI-incompatible wasm, a malformed
    // query) must not take down the whole editor — skip it and warn. The language
    // simply falls back to no tree-sitter highlighting.
    try {
      await loadGrammar(id);
    } catch (error) {
      console.warn(`[grammar] failed to load "${id}": ${(error as Error).message}`);
    }
  }
}

/** Create a fresh parser bound to a grammar's language. */
export function createParser(grammar: Grammar): any {
  const parser = new Parser();
  parser.setLanguage(grammar.language);
  return parser;
}
