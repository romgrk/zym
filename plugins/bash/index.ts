/*
 * The Bash plugin — shell-script support: file detection, a tree-sitter grammar
 * (highlighting + folding), and the bash-language-server LSP.
 *
 * Grammar:
 *  - Uses `tree-sitter-bash`, already shipped in the bundled `tree-sitter-wasms`
 *    pack (resolved by module specifier, like the Rust / Python / JSON grammars).
 *    The highlights/folds queries are vendored under `queries/bash/`.
 *  - Its external scanner imports a libc symbol (`isalpha`) that the pinned
 *    web-tree-sitter runtime doesn't export; the gap is shimmed once in
 *    `src/syntax/grammar.ts` (alongside the Markdown scanner's `strcmp`/`towlower`).
 *
 * Server:
 *  - `bash-language-server` (completion, hover, diagnostics, go-to) ships as an npm
 *    package (binary `bash-language-server`, invoked `bash-language-server start`),
 *    so it carries an npm `install` spec. It works per-file, so `singleFile` lets it
 *    activate on a loose script; a project root (a `.git` repo) is preferred when
 *    present.
 *
 * LSP languageId: the protocol id for shell is `shellscript` (our grammar key is
 * `bash`), so the language sets `lspId`.
 */
import type { Plugin, PluginContext } from '../../src/plugin/types.ts';
import type { ServerDef } from '../../src/lang/types.ts';

// Tree-sitter node types that fold when they span more than one line — block
// bodies, the if/case constructs, subshells, arrays and heredocs. `foldTypes` is
// the fallback if a query file is missing; `folds.scm` is the real source (it also
// folds comments).
const BASH_FOLD_TYPES = [
  'compound_statement', 'do_group', 'if_statement', 'case_statement', 'case_item',
  'subshell', 'array', 'heredoc_body',
];

// Common shell config files that carry no extension but are bash/sh scripts.
const BASH_FILENAMES = [
  '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.bash_aliases',
  '.profile', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout',
  '.kshrc', 'PKGBUILD',
];

// bash-language-server (https://github.com/bash-lsp/bash-language-server) — the
// canonical shell LSP. Ships on npm (binary `bash-language-server`), so it carries
// an install spec. `singleFile` lets it run on a loose script; a `.git` repo root is
// preferred when found.
const BASH_LANGUAGE_SERVER: ServerDef = {
  name: 'bash-language-server',
  command: 'bash-language-server',
  args: ['start'],
  roots: ['.git'],
  singleFile: true,
  install: { via: 'npm', package: 'bash-language-server' },
};

export const bashPlugin: Plugin = {
  id: 'bash',
  name: 'Bash',
  description: 'Bash / shell: tree-sitter grammar (highlighting + folding) and the bash-language-server LSP.',

  activate(ctx: PluginContext) {
    const { languages } = ctx;

    // The grammar key is `bash`; the LSP document languageId for shell is `shellscript`.
    languages.registerLanguage({
      id: 'bash',
      fileTypes: ['sh', 'bash', 'ksh', 'zsh', 'ash', 'dash'],
      filenames: BASH_FILENAMES,
      lspId: 'shellscript',
    });
    languages.registerGrammar('bash', {
      wasm: 'tree-sitter-wasms/out/tree-sitter-bash.wasm',
      highlightsPath: ctx.resolve('queries/bash/highlights.scm'),
      foldTypes: BASH_FOLD_TYPES,
      foldsPath: ctx.resolve('queries/bash/folds.scm'),
    });
    languages.registerServer('bash', BASH_LANGUAGE_SERVER);
  },
};
