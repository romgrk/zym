/*
 * The JSON plugin — JSON and JSONC support: file detection, a tree-sitter
 * grammar (highlighting + folding), and the vscode-json language server.
 *
 * Grammar:
 *  - JSON uses `tree-sitter-json`, already shipped in the bundled
 *    `tree-sitter-wasms` pack (resolved by module specifier, like the CSS and
 *    TypeScript grammars). The same grammar backs JSONC — it parses `//` and
 *    block comments as `(comment)` nodes, which the highlights/folds queries
 *    already handle — so JSONC needs no separate grammar.
 *
 * Server:
 *  - `vscode-json-language-server` (from `vscode-langservers-extracted`, the same
 *    package the TypeScript plugin's eslint server and the CSS plugin's css server
 *    come from) drives JSON + JSONC: schema-aware validation, completion, hover.
 *    It speaks per-document languageIds (`json` / `jsonc`), so one ServerDef serves
 *    both. Works per-file, so `singleFile` lets it activate on a stray document.
 */
import type { Plugin, PluginContext } from '../../src/plugin/types.ts';
import type { ServerDef } from '../../src/lang/types.ts';

// Object / array bodies fold when multi-line; the `folds.scm` query also folds
// multi-line comments. `foldTypes` is the fallback if a query file is missing.
const JSON_FOLD_TYPES = ['object', 'array'];

// vscode-json-language-server: schema-aware validation, completion, hover for
// JSON + JSONC. Ships in vscode-langservers-extracted (its eslint / css siblings
// are already used by the TypeScript / CSS plugins). Works per-file, so
// `singleFile` lets it activate on a stray document; a repo / package.json root is
// preferred when present.
const VSCODE_JSON: ServerDef = {
  name: 'vscode-json-language-server',
  command: 'vscode-json-language-server',
  args: ['--stdio'],
  roots: ['package.json', '.git'],
  singleFile: true,
  install: { via: 'npm', package: 'vscode-langservers-extracted' },
  // The server pulls these via workspace/configuration, requesting the `json`
  // section; we answer from this object (see getConfigSection). Validation is the
  // headline feature, so it's enabled.
  settings: {
    json: { validate: { enable: true }, schemas: [] },
  },
};

export const jsonPlugin: Plugin = {
  id: 'json',
  name: 'JSON',
  description: 'JSON / JSONC: tree-sitter grammar (highlighting + folding) and the vscode-json language server.',

  activate(ctx: PluginContext) {
    const { languages } = ctx;

    // JSON — `json` is already a valid LSP languageId, so no lspId override.
    languages.registerLanguage({ id: 'json', fileTypes: ['json'] });
    languages.registerGrammar('json', {
      wasm: 'tree-sitter-wasms/out/tree-sitter-json.wasm',
      highlightsPath: ctx.resolve('queries/json/highlights.scm'),
      foldTypes: JSON_FOLD_TYPES,
      foldsPath: ctx.resolve('queries/json/folds.scm'),
    });
    languages.registerServer('json', VSCODE_JSON);

    // JSONC (JSON with comments) — `jsonc` is a valid LSP languageId. Backed by
    // the same json grammar (it parses comments as `(comment)` nodes).
    languages.registerLanguage({
      id: 'jsonc',
      fileTypes: ['jsonc'],
      comments: { line: '//', block: { start: '/*', end: '*/' } },
    });
    languages.registerGrammar('jsonc', {
      wasm: 'tree-sitter-wasms/out/tree-sitter-json.wasm',
      highlightsPath: ctx.resolve('queries/json/highlights.scm'),
      foldTypes: JSON_FOLD_TYPES,
      foldsPath: ctx.resolve('queries/json/folds.scm'),
    });
    languages.registerServer('jsonc', VSCODE_JSON);
  },
};
