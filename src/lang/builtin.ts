/*
 * Built-in language pack — the curated, hand-authored languages quilx ships
 * with, registered in-process at startup (effectively the first "plugin"). Each
 * entry pairs detection + a tree-sitter grammar (where we vendor one) + LSP
 * server candidates with per-project activation.
 *
 * Server configs are authored here (referencing Helix's `languages.toml` as a
 * guide), not fetched. Servers must be on `PATH`; an inactive/uninstalled server
 * simply never spawns. Extend by adding languages here (or, later, via plugins).
 */
import type { LanguageRegistry } from './LanguageRegistry.ts';
import type { ServerDef } from './types.ts';

// Tree-sitter node types that fold when they span more than one line. Shared by
// the TS-family grammars.
const JS_FOLD_TYPES = [
  'statement_block', 'object', 'array', 'class_body', 'switch_body',
  'named_imports', 'arguments', 'interface_body', 'enum_body', 'object_type',
];

// JS/TS server candidates. flow / tsserver / deno are mutually exclusive (group
// `js-types`, picked per project by root markers + priority); eslint is additive.
const FLOW: ServerDef = {
  name: 'flow', command: 'flow', args: ['lsp'],
  roots: ['.flowconfig'], group: 'js-types', priority: 20,
  install: { via: 'npm', package: 'flow-bin' },
};
const TSSERVER: ServerDef = {
  name: 'typescript-language-server', command: 'typescript-language-server', args: ['--stdio'],
  roots: ['tsconfig.json', 'jsconfig.json', 'package.json'], group: 'js-types', priority: 10,
  // typescript-language-server needs the `typescript` package alongside it.
  install: { via: 'npm', package: 'typescript-language-server typescript' },
  // Offer cross-module symbols in completion (their `import` line arrives via
  // completionItem/resolve as additionalTextEdits → applied on accept).
  initializationOptions: {
    preferences: {
      includeCompletionsForModuleExports: true,
      includeCompletionsForImportStatements: true,
    },
  },
};
const DENO: ServerDef = {
  name: 'deno', command: 'deno', args: ['lsp'],
  roots: ['deno.json', 'deno.jsonc'], group: 'js-types', priority: 30,
  // Deno is a standalone runtime, not an npm package — installed out of band.
};
const ESLINT: ServerDef = {
  name: 'eslint', command: 'vscode-eslint-language-server', args: ['--stdio'],
  roots: ['.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yaml',
    '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs'],
  // The eslint LSP binary ships in vscode-langservers-extracted (not in `eslint`).
  install: { via: 'npm', package: 'vscode-langservers-extracted' },
  // The eslint server pulls these via workspace/configuration (empty section, so
  // the whole object is returned). Defaults mirror the VS Code extension; flat vs
  // legacy config is auto-detected. Tune via `lsp.servers.<lang>.eslint`.
  settings: {
    validate: 'on',
    run: 'onType',
    format: false,
    quiet: false,
    onIgnoredFiles: 'off',
    options: {},
    rulesCustomizations: [],
    problems: { shortenToSingleLine: false },
    nodePath: null,
    workingDirectory: { mode: 'location' },
    codeAction: {
      disableRuleComment: { enable: true, location: 'separateLine' },
      showDocumentation: { enable: true },
    },
  },
};

/** Register the built-in languages on `reg`. */
export function registerBuiltins(reg: LanguageRegistry): void {
  // TypeScript (the typescript grammar; tsx grammar would misread `<T>` casts).
  reg.registerLanguage({ id: 'typescript', fileTypes: ['ts', 'mts', 'cts'] });
  reg.registerGrammar('typescript', {
    wasm: 'tree-sitter-wasms/out/tree-sitter-typescript.wasm',
    query: 'typescript',
    foldTypes: JS_FOLD_TYPES,
  });
  reg.registerServer('typescript', TSSERVER);
  reg.registerServer('typescript', DENO);
  reg.registerServer('typescript', ESLINT);

  // TSX / JSX / plain JS — all backed by the tsx grammar (a superset), but each
  // maps to its own LSP languageId (tsx grammar key isn't a valid LSP id).
  reg.registerLanguage({
    id: 'tsx',
    fileTypes: ['tsx', 'jsx', 'js', 'mjs', 'cjs'],
    lspIds: {
      tsx: 'typescriptreact',
      jsx: 'javascriptreact',
      js: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
    },
  });
  reg.registerGrammar('tsx', {
    wasm: 'tree-sitter-wasms/out/tree-sitter-tsx.wasm',
    query: 'tsx',
    foldTypes: JS_FOLD_TYPES,
  });
  reg.registerServer('tsx', FLOW);
  reg.registerServer('tsx', TSSERVER);
  reg.registerServer('tsx', DENO);
  reg.registerServer('tsx', ESLINT);
}
