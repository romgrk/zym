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
import * as Path from 'node:path';

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

interface GrammarSpec {
  wasm: string;          // resolvable module path to the grammar .wasm
  extensions: string[];  // file extensions that select this grammar
  highlights: string;    // tree-sitter highlights query (capture names → styles)
  foldTypes: string[];   // node types that fold when they span >1 line
}

// Highlights queries. Capture names map to colors in the highlighter (see
// COLORS). Patterns are ordered general → specific; tag priority (not query
// order) resolves overlaps — e.g. a method-call identifier gets both @property
// and @function, and the higher-priority @function wins. Keywords are split
// into control-flow (@keyword.control) and declaration/storage (@keyword) to
// mirror VS Code's purple/blue distinction.
//
// COMMON works against JavaScript, TypeScript, and TSX (TS/TSX are supersets).
// Language specs append the bits that differ (class-name node type, TS types).
const COMMON_HIGHLIGHTS = `
(comment) @comment

(string) @string
(template_string) @string
(regex) @string
(escape_sequence) @escape

(number) @number
(true) @boolean
(false) @boolean
(null) @constant

[
  "if" "else" "for" "while" "do" "switch" "case" "break" "continue" "return"
  "throw" "try" "catch" "finally" "yield" "await" "import" "export" "from" "default"
] @keyword.control

[
  "const" "let" "var" "function" "class" "extends" "new" "static" "get" "set"
  "async" "typeof" "instanceof" "in" "of" "delete" "void"
] @keyword

; properties and object keys
(property_identifier) @property
(shorthand_property_identifier) @property
(pair key: (property_identifier) @property)

; functions: declarations, methods, and call sites
(function_declaration name: (identifier) @function)
(generator_function_declaration name: (identifier) @function)
(method_definition name: (property_identifier) @function)
(call_expression function: (identifier) @function)
(call_expression function: (member_expression property: (property_identifier) @function))
(new_expression constructor: (identifier) @type)
`;

// JS: class name is a plain identifier.
const JS_HIGHLIGHTS = COMMON_HIGHLIGHTS + `
(class_declaration name: (identifier) @type)
`;

// TS/TSX: class name is a type_identifier, plus type nodes and TS keywords.
const TS_HIGHLIGHTS = COMMON_HIGHLIGHTS + `
(class_declaration name: (type_identifier) @type)
(type_identifier) @type
(predefined_type) @type
(interface_declaration name: (type_identifier) @type)
(type_alias_declaration name: (type_identifier) @type)

[
  "interface" "type" "enum" "namespace" "declare" "implements" "abstract"
  "readonly" "public" "private" "protected" "override" "as" "keyof" "satisfies"
] @keyword
`;

const JS_FOLD_TYPES = [
  'statement_block', 'object', 'array', 'class_body', 'switch_body',
  'named_imports', 'arguments',
];

// TS adds type-level containers.
const TS_FOLD_TYPES = [
  ...JS_FOLD_TYPES, 'interface_body', 'enum_body', 'object_type',
];

const SPECS: Record<string, GrammarSpec> = {
  javascript: {
    wasm: 'tree-sitter-wasms/out/tree-sitter-javascript.wasm',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    highlights: JS_HIGHLIGHTS,
    foldTypes: JS_FOLD_TYPES,
  },
  typescript: {
    wasm: 'tree-sitter-wasms/out/tree-sitter-typescript.wasm',
    extensions: ['.ts', '.mts', '.cts'],
    highlights: TS_HIGHLIGHTS,
    foldTypes: TS_FOLD_TYPES,
  },
  tsx: {
    wasm: 'tree-sitter-wasms/out/tree-sitter-tsx.wasm',
    extensions: ['.tsx'],
    highlights: TS_HIGHLIGHTS,
    foldTypes: TS_FOLD_TYPES,
  },
};

/** Map a file path to a known language id, or null if unsupported. */
export function langIdForPath(path: string): string | null {
  const ext = Path.extname(path).toLowerCase();
  for (const [id, spec] of Object.entries(SPECS)) {
    if (spec.extensions.includes(ext)) return id;
  }
  return null;
}

const cache = new Map<string, Grammar>();

/** Load (and cache) a grammar by language id, or null if unknown. */
export async function loadGrammar(langId: string): Promise<Grammar | null> {
  const spec = SPECS[langId];
  if (!spec) return null;
  const cached = cache.get(langId);
  if (cached) return cached;

  await initTreeSitter();
  const language = await Parser.Language.load(require_.resolve(spec.wasm));
  const grammar: Grammar = {
    language,
    query: language.query(spec.highlights),
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
  for (const id of Object.keys(SPECS)) await loadGrammar(id);
}

/** Create a fresh parser bound to a grammar's language. */
export function createParser(grammar: Grammar): any {
  const parser = new Parser();
  parser.setLanguage(grammar.language);
  return parser;
}
