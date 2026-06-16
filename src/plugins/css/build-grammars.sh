#!/usr/bin/env bash
#
# Build this plugin's SCSS tree-sitter grammar to wasm, vendored next to it in
# ./grammars/. Self-contained: the plugin owns its own grammar build; the repo
# has no grammar-build machinery.
#
# CSS itself is NOT built here — the bundled `tree-sitter-wasms` pack already
# ships `tree-sitter-css.wasm`, which the plugin loads directly. Only SCSS (a CSS
# superset: nesting, `$variables`, `@mixin`/`@include`, `@if`/`@each`, …) needs a
# vendored grammar, since `tree-sitter-wasms` omits it.
#
# Why the wasm is checked in: `tree-sitter-scss` ships only C sources (no wasm),
# and quilx loads grammars as wasm (web-tree-sitter). Re-run this to refresh it.
#
# Requirements: the `tree-sitter` CLI (>= 0.24) and network. `tree-sitter build
# --wasm` auto-downloads wasi-sdk into ~/.cache/tree-sitter on first run — no
# emscripten or Docker needed. We compile the package's existing ABI-14 parser.c
# (we do NOT run `tree-sitter generate`, which a 0.25+ CLI would emit as ABI 15,
# unloadable in the pinned web-tree-sitter 0.20.x).
set -euo pipefail

VERSION="${SCSS_GRAMMAR_VERSION:-1.0.0}"
PKG="tree-sitter-scss"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HERE/grammars"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Fetching $PKG@$VERSION …"
URL="$(npm view "$PKG@$VERSION" dist.tarball)"
curl -sL "$URL" | tar xz -C "$WORK"

mkdir -p "$DEST"
abi="$(grep -m1 -oP 'LANGUAGE_VERSION \K[0-9]+' "$WORK/package/src/parser.c")"
echo "Building $PKG.wasm (ABI $abi) …"
[ "$abi" -le 14 ] || { echo "  refusing: ABI $abi > 14 won't load in web-tree-sitter 0.20.x"; exit 1; }
( cd "$WORK/package" && tree-sitter build --wasm -o "$DEST/tree-sitter-scss.wasm" . )

echo "Vendored into $DEST:"
ls -l "$DEST"/*.wasm
echo "Highlights/folds queries live in ../queries/ (authored against quilx's palette, not from the package)."
