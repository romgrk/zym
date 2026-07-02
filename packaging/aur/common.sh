# Shared helpers for build-local.sh / publish-aur.sh — source, don't execute.
#
# Both scripts must agree with the PKGBUILD's pkgver() formula:
#   <package.json version>.r<commit count>.g<short hash>
# The functions here are the single place that formula lives on the script side.

msg() { printf '\033[1;34m::\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Extract "version" from a package.json fed on stdin.
pkg_json_version() {
  sed -n 's/[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1
}

# pkgver for a git REF of the repo at $1 (reads package.json from the committed
# tree, not the worktree — matches exactly what the AUR clones and builds).
compute_pkgver_ref() {
  local repo="$1" ref="$2" ver
  ver="$(git -C "$repo" show "$ref:package.json" | pkg_json_version)"
  printf '%s.r%s.g%s' "${ver:-0.0.0}" \
    "$(git -C "$repo" rev-list --count "$ref")" \
    "$(git -C "$repo" rev-parse --short "$ref")"
}

# pkgver for the working TREE at $1, "+.dirty" when it has uncommitted changes —
# so a local test build can never be confused with a real one.
compute_pkgver_worktree() {
  local repo="$1" ver pkgver
  ver="$(pkg_json_version < "$repo/package.json")"
  pkgver="$(printf '%s.r%s.g%s' "${ver:-0.0.0}" \
    "$(git -C "$repo" rev-list --count HEAD)" \
    "$(git -C "$repo" rev-parse --short HEAD)")"
  [[ -z "$(git -C "$repo" status --porcelain)" ]] || pkgver+=".dirty"
  printf '%s' "$pkgver"
}
