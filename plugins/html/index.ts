/*
 * The HTML plugin — zym's third bundled language. It rounds out the
 * contribution model with the piece the first two plugins didn't exercise
 * together: a grammar with *cross-language injections* whose guests are owned by
 * other plugins. HTML's <script> blocks are re-highlit by the TypeScript plugin's
 * JS grammar, and its <style> blocks by a CSS grammar this plugin vendors as an
 * injection-only grammar.
 *
 * Both grammars ship in the bundled `tree-sitter-wasms` pack (like TypeScript's),
 * so nothing is built here — only the highlight/fold queries are authored
 * (adapted to zym's palette). The CSS grammar is registered WITHOUT file
 * detection (no `.css` opens as CSS): it exists only so HTML's <style> injection
 * resolves. A future CSS plugin can add `registerLanguage`/servers on top of the
 * same `css` grammar id with no change here.
 */
import type { Plugin, PluginContext } from '../../src/plugin/types.ts';
import type { ServerDef } from '../../src/lang/types.ts';

// HTML nodes that fold when multi-line: every element (incl. the raw-text
// <script>/<style> elements) and block comments. Mirrors queries/html/folds.scm,
// which drives folding; this is the fallback if the query ever drops out.
const HTML_FOLD_TYPES = ['element', 'script_element', 'style_element'];

// Injections: <style> content → the css grammar (vendored below); <script>
// content → `js`, which resolves through the registry to the TypeScript plugin's
// tsx grammar (a JS superset). Both are no-ops if the guest grammar isn't
// registered — script highlighting simply stays plain without the TS plugin.
const HTML_INJECTIONS = [
  { query: '(style_element (raw_text) @content)', language: 'css' },
  { query: '(script_element (raw_text) @content)', language: 'js' },
];

// vscode-html-language-server — the HTML server extracted from VS Code, shipped in
// vscode-langservers-extracted (the same package as eslint's binary). HTML needs
// no project root, so it activates per-file (`singleFile`). `embeddedLanguages`
// lets it offer CSS/JS completion inside <style>/<script>; `provideFormatter`
// turns on its built-in formatter.
const HTML_LS: ServerDef = {
  name: 'vscode-html-language-server',
  command: 'vscode-html-language-server',
  args: ['--stdio'],
  install: { via: 'npm', package: 'vscode-langservers-extracted' },
  singleFile: true,
  initializationOptions: {
    provideFormatter: true,
    embeddedLanguages: { css: true, javascript: true },
  },
};

export const htmlPlugin: Plugin = {
  id: 'html',
  name: 'HTML',
  description: 'HTML: grammar with <script>/<style> injections, folding, and the vscode-html language server.',

  activate(ctx: PluginContext) {
    const { languages } = ctx;

    // `html` is already a valid LSP languageId, so no `lspId` override.
    languages.registerLanguage({
      id: 'html',
      fileTypes: ['html', 'htm', 'xhtml', 'shtml'],
      comments: { block: { start: '<!--', end: '-->' } },
    });
    languages.registerGrammar('html', {
      wasm: 'tree-sitter-wasms/out/tree-sitter-html.wasm',
      highlightsPath: ctx.resolve('queries/html/highlights.scm'),
      foldTypes: HTML_FOLD_TYPES,
      foldsPath: ctx.resolve('queries/html/folds.scm'),
      injections: HTML_INJECTIONS,
    });
    languages.registerServer('html', HTML_LS);

    // Injection-only grammar for <style> blocks: no `registerLanguage` (you never
    // open a `.css` file *as* this — that's a future CSS plugin), the HTML grammar
    // injects it by the `css` id.
    languages.registerGrammar('css', {
      wasm: 'tree-sitter-wasms/out/tree-sitter-css.wasm',
      highlightsPath: ctx.resolve('queries/css/highlights.scm'),
      foldTypes: [],
    });
  },
};
