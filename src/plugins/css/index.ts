/*
 * The CSS plugin — CSS, SCSS, and Sass support: file detection, tree-sitter
 * grammars (highlighting + folding), and a language server. The first built-in
 * plugin to mix a bundled grammar (CSS) with a vendored one (SCSS).
 *
 * Grammars:
 *  - CSS uses `tree-sitter-css`, already shipped in the bundled `tree-sitter-wasms`
 *    pack (resolved by module specifier, like TypeScript's grammars).
 *  - SCSS uses `tree-sitter-scss` (a CSS superset), which `tree-sitter-wasms` omits,
 *    so it's vendored under `./grammars/` and built by `./build-grammars.sh`
 *    (same recipe as the Markdown plugin). Registered only when the wasm is present,
 *    so a missing build degrades to LSP-only rather than rolling back the plugin.
 *  - Sass (the indented syntax) has no ABI-14 tree-sitter grammar, so it gets
 *    detection + LSP only — no `registerGrammar`, exactly how Markdown shipped
 *    before its grammar was vendored.
 *
 * Servers:
 *  - `vscode-css-language-server` (from `vscode-langservers-extracted`, the same
 *    package the TypeScript plugin's eslint server comes from) drives CSS and SCSS:
 *    validation, completion, hover, color decorators. It speaks per-document
 *    languageIds (`css` / `scss`), so a single ServerDef serves both.
 *  - `some-sass-language-server` (SomeSass) drives the indented Sass syntax, which
 *    vscode-css doesn't handle. Optional (no `install`): skipped if not on PATH,
 *    like marksman — never crash-looped.
 */
import * as Fs from 'node:fs';
import type { Plugin, PluginContext } from '../../plugin/types.ts';
import type { ServerDef } from '../../lang/types.ts';

// Node types that fold when multi-line. Every CSS/SCSS body (rule sets, at-rules,
// `@mixin`, `@if`/`@each`, …) is a `block`; `@keyframes` wraps its frames in a
// `keyframe_block_list`. The `folds.scm` queries also fold multi-line comments;
// `foldTypes` is the fallback if a query file is ever missing.
const CSS_FOLD_TYPES = ['block', 'keyframe_block_list'];

// vscode-css-language-server: CSS/SCSS/Less validation, completion, hover, and
// color decorators. Ships in vscode-langservers-extracted (its eslint sibling is
// already used by the TypeScript plugin). Works per-file, so `singleFile` lets it
// activate on a stray stylesheet; a repo / package.json root is preferred when present.
const VSCODE_CSS: ServerDef = {
  name: 'vscode-css-language-server',
  command: 'vscode-css-language-server',
  args: ['--stdio'],
  roots: ['package.json', '.git'],
  singleFile: true,
  install: { via: 'npm', package: 'vscode-langservers-extracted' },
  // The server pulls these via workspace/configuration, requesting the `css` /
  // `scss` / `less` sections; we answer each from this object (see getConfigSection).
  // Validation is the headline feature, so it's enabled for every dialect.
  settings: {
    css: { validate: true, lint: {} },
    scss: { validate: true, lint: {} },
    less: { validate: true, lint: {} },
  },
};

// SomeSass (https://github.com/wkillerud/some-sass) — language intelligence for the
// indented Sass syntax (and SCSS), which vscode-css can't parse. A standalone binary
// (installed out of band, like deno/marksman), so no `install` spec — absent ⇒ skipped.
const SOMESASS: ServerDef = {
  name: 'some-sass-language-server',
  command: 'some-sass-language-server',
  args: ['--stdio'],
  roots: ['package.json', '.git'],
  singleFile: true,
};

export const cssPlugin: Plugin = {
  id: 'css',
  name: 'CSS',
  description: 'CSS / SCSS / Sass: grammars (highlighting + folding) and the vscode-css / SomeSass language servers.',

  activate(ctx: PluginContext) {
    const { languages } = ctx;

    // CSS — `css` is already a valid LSP languageId, so no lspId override.
    languages.registerLanguage({ id: 'css', fileTypes: ['css'] });
    languages.registerGrammar('css', {
      wasm: 'tree-sitter-wasms/out/tree-sitter-css.wasm',
      highlightsPath: ctx.resolve('queries/css/highlights.scm'),
      foldTypes: CSS_FOLD_TYPES,
      foldsPath: ctx.resolve('queries/css/folds.scm'),
    });
    languages.registerServer('css', VSCODE_CSS);

    // SCSS — `scss` is a valid LSP languageId. Grammar is vendored (built by
    // build-grammars.sh); register it only when the wasm is present so a missing
    // build leaves SCSS LSP-only instead of throwing and rolling back the plugin.
    languages.registerLanguage({ id: 'scss', fileTypes: ['scss'] });
    languages.registerServer('scss', VSCODE_CSS);
    const scssWasm = ctx.resolve('grammars/tree-sitter-scss.wasm');
    const scssHl = ctx.resolve('queries/scss/highlights.scm');
    const scssFolds = ctx.resolve('queries/scss/folds.scm');
    if ([scssWasm, scssHl, scssFolds].every((p) => Fs.existsSync(p))) {
      languages.registerGrammar('scss', {
        wasm: scssWasm,
        highlightsPath: scssHl,
        foldTypes: CSS_FOLD_TYPES,
        foldsPath: scssFolds,
      });
    }

    // Sass (indented syntax) — detection + LSP only; no ABI-14 grammar exists for
    // the indented dialect (the SCSS grammar would mis-parse it). `sass` is a valid
    // LSP languageId; SomeSass is the server that understands it.
    languages.registerLanguage({ id: 'sass', fileTypes: ['sass'] });
    languages.registerServer('sass', SOMESASS);
  },
};
