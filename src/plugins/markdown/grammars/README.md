# Vendored Markdown tree-sitter grammars

`tree-sitter-markdown.wasm` (block) and `tree-sitter-markdown-inline.wasm`
(inline) — the split grammar quilx's Markdown highlighting uses (the block
grammar injects the inline grammar into `inline` nodes, and fenced code blocks
into the fence language's grammar; see `tasks/code-editing/syntax-injection.md`).

- **Source:** [`@tree-sitter-grammars/tree-sitter-markdown`](https://github.com/tree-sitter-grammars/tree-sitter-markdown)
  v0.3.2 — **MIT licensed**.
- **Built by:** `../build-grammars.sh` (this plugin's own script — compiles the package's
  ABI-14 `parser.c` to wasm via `tree-sitter build --wasm`, which uses wasi-sdk —
  no emscripten/Docker). Re-run it to reproduce these binaries.
- **ABI 14**, so they load in the pinned `web-tree-sitter` 0.20.x.

The highlights queries (`../queries/markdown*/highlights.scm`) are adapted from
[nvim-treesitter](https://github.com/nvim-treesitter/nvim-treesitter) (Apache-2.0)
to quilx's capture-name palette; they're authored, not copied from the package.
