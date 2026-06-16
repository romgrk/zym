/*
 * The C / C++ plugin — C and C++ support: file detection, tree-sitter grammars
 * (highlighting + folding), and the clangd language server.
 *
 * Grammars:
 *  - C uses `tree-sitter-c` and C++ uses `tree-sitter-cpp`, both already shipped
 *    in the bundled `tree-sitter-wasms` pack (resolved by module specifier, like
 *    the JSON / CSS / TypeScript grammars). C++ is a superset of C, so it gets its
 *    own grammar + queries rather than reusing C's. Headers (`.h`) map to C by
 *    convention; C++-only header suffixes (`.hpp`, `.hh`, …) map to C++.
 *
 * Server:
 *  - `clangd` drives both languages: diagnostics, completion, hover, go-to,
 *    formatting. It speaks per-document languageIds (`c` / `cpp`), so a single
 *    ServerDef serves both. A standalone binary (shipped with LLVM, installed out
 *    of band like marksman / deno), so there's no `install` spec — absent ⇒
 *    skipped, never crash-looped. It works per-file, so `singleFile` lets it
 *    activate on a stray source; a `compile_commands.json` / repo root is
 *    preferred when present (and is what gives clangd its include paths).
 */
import type { Plugin, PluginContext } from '../../plugin/types.ts';
import type { ServerDef } from '../../lang/types.ts';

// Block bodies fold when multi-line; the `folds.scm` queries also fold multi-line
// comments. `foldTypes` is the fallback if a query file is ever missing.
const C_FOLD_TYPES = ['compound_statement', 'field_declaration_list', 'enumerator_list', 'initializer_list'];
const CPP_FOLD_TYPES = [...C_FOLD_TYPES, 'declaration_list'];

// clangd (https://clangd.llvm.org) — the LLVM C/C++ language server. A standalone
// binary (installed out of band, like marksman), so no `install` spec — absent ⇒
// skipped. Prefers a compilation database (`compile_commands.json` /
// `compile_flags.txt`) or a `.clangd` config for include paths; `singleFile` still
// lets it activate on a loose source file rooted at its directory.
const CLANGD: ServerDef = {
  name: 'clangd',
  command: 'clangd',
  args: ['--background-index'],
  roots: ['compile_commands.json', 'compile_flags.txt', '.clangd', '.git'],
  singleFile: true,
};

export const cppPlugin: Plugin = {
  id: 'cpp',
  name: 'C / C++',
  description: 'C / C++: tree-sitter grammars (highlighting + folding) and the clangd language server.',

  activate(ctx: PluginContext) {
    const { languages } = ctx;

    // C — `c` is a valid LSP languageId. `.h` headers map to C by convention.
    languages.registerLanguage({ id: 'c', fileTypes: ['c', 'h'] });
    languages.registerGrammar('c', {
      wasm: 'tree-sitter-wasms/out/tree-sitter-c.wasm',
      highlightsPath: ctx.resolve('queries/c/highlights.scm'),
      foldTypes: C_FOLD_TYPES,
      foldsPath: ctx.resolve('queries/c/folds.scm'),
    });
    languages.registerServer('c', CLANGD);

    // C++ — `cpp` is a valid LSP languageId. The header/source suffixes are the
    // usual C++-only ones (`.h` belongs to C above).
    languages.registerLanguage({
      id: 'cpp',
      fileTypes: ['cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'h++', 'ipp', 'tpp', 'cppm', 'ino'],
    });
    languages.registerGrammar('cpp', {
      wasm: 'tree-sitter-wasms/out/tree-sitter-cpp.wasm',
      highlightsPath: ctx.resolve('queries/cpp/highlights.scm'),
      foldTypes: CPP_FOLD_TYPES,
      foldsPath: ctx.resolve('queries/cpp/folds.scm'),
    });
    languages.registerServer('cpp', CLANGD);
  },
};
