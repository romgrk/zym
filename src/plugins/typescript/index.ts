/*
 * The TypeScript plugin — quilx's first plugin, and the reference for the
 * contribution model. It bundles everything that makes the TS/JS family a
 * first-class language: detection, tree-sitter grammars (vendored under
 * `queries/`), and the LSP server candidates (flow / tsserver / deno / eslint)
 * with their per-project activation.
 *
 * This was previously the in-process "built-in pack" (`src/lang/builtin.ts`);
 * it now activates through a `PluginContext`, so every contribution is tracked
 * and torn down cleanly if the plugin is deactivated. Server configs are authored
 * here (referencing Helix's `languages.toml` as a guide), not fetched; a server
 * that isn't installed/active simply never spawns.
 */
import type { Plugin, PluginContext } from '../../plugin/types.ts';
import type { ServerDef } from '../../lang/types.ts';

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
      // Inlay hints (rendered end-of-line by InlayHintController) — tsserver only emits
      // them when these preferences are on.
      includeInlayParameterNameHints: 'all',
      includeInlayParameterNameHintsWhenArgumentMatchesName: false,
      includeInlayFunctionParameterTypeHints: true,
      includeInlayVariableTypeHints: true,
      includeInlayVariableTypeHintsWhenTypeMatchesName: false,
      includeInlayPropertyDeclarationTypeHints: true,
      includeInlayFunctionLikeReturnTypeHints: true,
      includeInlayEnumMemberValueHints: true,
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

export const typescriptPlugin: Plugin = {
  id: 'typescript',
  name: 'TypeScript',
  description: 'TypeScript / JavaScript: grammar, folding, and language servers (tsserver, flow, deno, eslint).',

  activate(ctx: PluginContext) {
    const { languages } = ctx;

    // TypeScript (the typescript grammar; the tsx grammar would misread `<T>` casts).
    languages.registerLanguage({ id: 'typescript', fileTypes: ['ts', 'mts', 'cts'] });
    languages.registerGrammar('typescript', {
      wasm: 'tree-sitter-wasms/out/tree-sitter-typescript.wasm',
      highlightsPath: ctx.resolve('queries/typescript/highlights.scm'),
      foldTypes: JS_FOLD_TYPES,
      foldsPath: ctx.resolve('queries/typescript/folds.scm'),
    });
    languages.registerServer('typescript', TSSERVER);
    languages.registerServer('typescript', DENO);
    languages.registerServer('typescript', ESLINT);

    // TSX / JSX / plain JS — all backed by the tsx grammar (a superset), but each
    // maps to its own LSP languageId (the tsx grammar key isn't a valid LSP id).
    languages.registerLanguage({
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
    languages.registerGrammar('tsx', {
      wasm: 'tree-sitter-wasms/out/tree-sitter-tsx.wasm',
      highlightsPath: ctx.resolve('queries/tsx/highlights.scm'),
      foldTypes: JS_FOLD_TYPES,
      foldsPath: ctx.resolve('queries/tsx/folds.scm'),
    });
    languages.registerServer('tsx', FLOW);
    languages.registerServer('tsx', TSSERVER);
    languages.registerServer('tsx', DENO);
    languages.registerServer('tsx', ESLINT);
  },
};
