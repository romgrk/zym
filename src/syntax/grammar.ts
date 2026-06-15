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
import { fileURLToPath } from 'node:url';
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

/** A loaded grammar: the parser language, its highlights query, fold node types. */
export interface Grammar {
  language: any;
  query: any;
  foldTypes: Set<string>;
}

// Highlights queries are vendored verbatim from Zed (GPL-3.0; see /LICENSE and the
// header in each .scm) under queries/<name>/highlights.scm. They use Zed's capture
// names; the highlighter maps those to colors with longest-prefix fallback — e.g.
// @function.method → @function — so dotted names need no special handling here
// (see theme/theme.ts and syntax-controller's resolveTag).
//
// We DON'T use the stock tree-sitter-javascript grammar: Zed's javascript query is
// written for Zed's TS-aware JS grammar and references TS-only nodes/tokens that
// the pinned v0.20.3 wasm lacks (it won't compile). Instead .js/.jsx route to the
// tsx grammar — a superset that parses plain JS, JSX and TS — so Zed's tsx query
// applies verbatim. Plain .ts uses the typescript grammar (the tsx grammar would
// misread `<T>` casts as JSX).
const QUERIES_DIR = Path.join(Path.dirname(fileURLToPath(import.meta.url)), 'queries');

function loadHighlights(name: string): string {
  return Fs.readFileSync(Path.join(QUERIES_DIR, name, 'highlights.scm'), 'utf8');
}

// The language definitions (extensions, grammar wasm + query + fold types) live
// in the `LanguageRegistry` (src/lang); this module just loads/caches the wasm
// and runs the query. Grammar specs come from `languages.grammarFor`.

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
  const language = await Parser.Language.load(require_.resolve(spec.wasm));
  const grammar: Grammar = {
    language,
    query: language.query(loadHighlights(spec.query)),
    foldTypes: new Set(spec.foldTypes),
  };
  cache.set(langId, grammar);
  return grammar;
}

/** Synchronously get an already-loaded grammar, or null if not preloaded. */
export function getGrammar(langId: string): Grammar | null {
  return cache.get(langId) ?? null;
}

/**
 * Load the runtime and every known grammar up front. Must be awaited BEFORE the
 * GLib main loop starts: emscripten's async wasm init does not resolve once the
 * loop is running, so grammars are loaded here and used synchronously after.
 */
export async function preloadGrammars(): Promise<void> {
  await initTreeSitter();
  for (const id of languages.grammarLanguageIds()) await loadGrammar(id);
}

/** Create a fresh parser bound to a grammar's language. */
export function createParser(grammar: Grammar): any {
  const parser = new Parser();
  parser.setLanguage(grammar.language);
  return parser;
}
