# Vendored SCSS tree-sitter grammar

`tree-sitter-scss.wasm` — the grammar quilx's SCSS highlighting/folding uses. SCSS
is a CSS superset (nesting, `$variables`, `#{interpolation}`, `@mixin`/`@include`,
`@if`/`@each`/`@for`, `@use`/`@forward`, …), so it needs its own grammar.

CSS itself is **not** vendored here: the bundled `tree-sitter-wasms` pack already
ships `tree-sitter-css.wasm`, which the plugin loads by module specifier.

- **Source:** [`tree-sitter-scss`](https://github.com/serenadeai/tree-sitter-scss)
  v1.0.0 — **MIT licensed**.
- **Built by:** `../build-grammars.sh` (this plugin's own script — compiles the
  package's ABI-14 `parser.c` to wasm via `tree-sitter build --wasm`, which uses
  wasi-sdk — no emscripten/Docker). Re-run it to reproduce this binary.
- **ABI 14**, so it loads in the pinned `web-tree-sitter` 0.20.x.

The highlight/fold queries (`../queries/{css,scss}/*.scm`) are authored against
quilx's capture-name palette (see `theme.syntax`), not copied from the package.
