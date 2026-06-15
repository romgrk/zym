#!/usr/bin/env bash
#
# Build this plugin's Markdown tree-sitter grammars (block + inline) to wasm,
# vendored next to it in ./grammars/. Self-contained: the plugin owns its own
# grammar build; the repo has no grammar-build machinery.
#
# Why the wasm is checked in: @tree-sitter-grammars/tree-sitter-markdown ships
# only C sources (no wasm), and quilx loads grammars as wasm (web-tree-sitter).
# Re-run this to reproduce/refresh ./grammars/*.wasm.
#
# Requirements: the `tree-sitter` CLI (>= 0.24) and network. `tree-sitter build
# --wasm` auto-downloads wasi-sdk into ~/.cache/tree-sitter on first run — no
# emscripten or Docker needed. We compile the package's existing ABI-14 parser.c
# (we do NOT run `tree-sitter generate`, which a 0.25+ CLI would emit as ABI 15,
# unloadable in the pinned web-tree-sitter 0.20.x).
set -euo pipefail

VERSION="${MARKDOWN_GRAMMAR_VERSION:-0.3.2}"
PKG="@tree-sitter-grammars/tree-sitter-markdown"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HERE/grammars"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Fetching $PKG@$VERSION …"
URL="$(npm view "$PKG@$VERSION" dist.tarball)"
curl -sL "$URL" | tar xz -C "$WORK"

mkdir -p "$DEST"
for g in tree-sitter-markdown tree-sitter-markdown-inline; do
  abi="$(grep -m1 -oP 'LANGUAGE_VERSION \K[0-9]+' "$WORK/package/$g/src/parser.c")"
  echo "Building $g.wasm (ABI $abi) …"
  [ "$abi" -le 14 ] || { echo "  refusing: ABI $abi > 14 won't load in web-tree-sitter 0.20.x"; exit 1; }
  ( cd "$WORK/package/$g" && tree-sitter build --wasm -o "$DEST/$g.wasm" . )
done

echo "Vendored into $DEST:"
ls -l "$DEST"/*.wasm
echo "Highlights queries live in ../queries/ (adapted to quilx's palette, authored — not from the package)."
