# Changelog

## 0.2.0 — 2026-07-02

First announced release. 🎉

zym is a keyboard-driven, modal code editor for Linux — native GTK 4 /
libadwaita, running on Node.js through node-gtk. See the
[README](README.md) and the [user guide](guide/index.md) for the full tour.

What's in the box:

- **Modal editing** — Atom's `vim-mode-plus`, ported and improved: motions,
  operators, text objects, registers, visual/blockwise, multi-cursor,
  occurrence editing, surround.
- **Coding agents** — run `claude` (and friends) in the workbench, with live
  status tracking, per-agent workbenches, `git worktree` isolation,
  send-selection/file-to-agent, and inline comment-to-agent.
- **`space` leader** — Spacemacs-style mnemonic commands, a fuzzy command
  palette, and fuzzy pickers for files, symbols, branches, PRs, and more.
- **Code intelligence** — LSP completion, hover, diagnostics, navigation,
  rename, code actions, formatting; missing servers are offered for install.
- **Git & GitHub** — staging (file and hunk), editable diffs, log viewer,
  branches/stash, PR checkout/create, live CI checks.
- **Editor essentials** — tree-sitter highlighting and folding, project-wide
  ripgrep search (editable results), file tree, sessions, notifications,
  schema-validated configuration with a generated preferences window.

Packaging fixes over the (unannounced) `0.1.0` npm publish:

- Depend on `node-gtk ^4.0.1` (0.1.0 declared `^2.1.0`, which cannot run zym).
- Ship the missing runtime dependencies (`marked`, `web-tree-sitter`,
  `tree-sitter-wasms`).
- Add npm metadata (`repository`, `engines`, keywords) and the user guide to
  the tarball.
