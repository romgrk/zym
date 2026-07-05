/*
 * The Rust plugin — Rust support: file detection, a tree-sitter grammar
 * (highlighting + folding), and the rust-analyzer language server.
 *
 * Grammar:
 *  - Uses `tree-sitter-rust`, already shipped in the bundled `tree-sitter-wasms`
 *    pack (resolved by module specifier, like the CSS / TypeScript / JSON
 *    grammars). The highlights/folds queries are vendored under `queries/rust/`.
 *
 * Server:
 *  - `rust-analyzer` is the canonical Rust language server. Like Deno, it's a
 *    standalone binary installed out of band (via rustup / the distro), not an
 *    npm package — so there's no `install` spec; it simply never spawns if it
 *    isn't on PATH. It roots at a Cargo workspace (`Cargo.toml`) and prefers a
 *    `rust-project.json` for non-cargo projects.
 */
import type { Plugin, PluginContext } from '../../src/plugin/types.ts';
import type { ServerDef } from '../../src/lang/types.ts';

// Tree-sitter node types that fold when they span more than one line — block
// bodies and bracketed groups. `foldTypes` is the fallback if a query file is
// missing; `folds.scm` is the real source (it also folds multi-line comments).
const RUST_FOLD_TYPES = [
  'block', 'declaration_list', 'field_declaration_list', 'enum_variant_list',
  'use_list', 'match_block', 'arguments', 'array_expression', 'struct_pattern',
];

// rust-analyzer: completion, hover, diagnostics, go-to-def for Rust. A standalone
// binary (rustup component `rust-analyzer`, or distro package), so no `install`
// spec — it activates only when found on PATH and a workspace root is present.
const RUST_ANALYZER: ServerDef = {
  name: 'rust-analyzer',
  command: 'rust-analyzer',
  roots: ['Cargo.toml', 'Cargo.lock', 'rust-project.json', '.git'],
};

export const rustPlugin: Plugin = {
  id: 'rust',
  name: 'Rust',
  description: 'Rust: tree-sitter grammar (highlighting + folding) and the rust-analyzer language server.',

  activate(ctx: PluginContext) {
    const { languages } = ctx;

    // `rust` is already a valid LSP languageId, so no lspId override.
    languages.registerLanguage({
      id: 'rust',
      fileTypes: ['rs'],
      comments: { line: '//', block: { start: '/*', end: '*/' } },
    });
    languages.registerGrammar('rust', {
      wasm: 'tree-sitter-wasms/out/tree-sitter-rust.wasm',
      highlightsPath: ctx.resolve('queries/rust/highlights.scm'),
      foldTypes: RUST_FOLD_TYPES,
      foldsPath: ctx.resolve('queries/rust/folds.scm'),
    });
    languages.registerServer('rust', RUST_ANALYZER);
  },
};
