
<h1 align="center">
  zym
</h1>

<p align="center">
  <b>zed + neovim + cursor<br/>
  Native GTK 4 — no Electron.<br/>
  Node.js under the hood — the full npm ecosystem.</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/zym-editor"><img src="https://img.shields.io/npm/v/zym-editor" alt="npm version"></a>
  <a href="https://github.com/romgrk/zym/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="license"></a>
</p>

A keyboard-driven, modern code editor — blending the best from neovim, atom,
zed, vscode, and so many others — with coding agents living right alongside
you — each tracked live, so you always know which agent is working, waiting,
or done.

*Beta state. Tested on Linux; might not run on macOS or Windows yet.*

![zym running a coding agent side by side with the editor, file tree, and a fuzzy command palette](https://raw.githubusercontent.com/romgrk/zym/master/img/demo-agent-workflow.png)

## Highlights

- ⌨️ **Vim beyond its best**: the `vim-mode-plus` plugin ported from Atom — so good it's better than the original. Multi-cursor, occurrences, text objects, operators, and more (target.vim, leap.nvim, etc).
- 🤖 **Agents** (well at least `claude`) — you work alongside your minions. Jump to their workbench to see what they edited. Jump to your workbench to work on your own.
- 🌳 **Worktree isolation** — spawn agents in their own `git worktree` and switch to their view whenever you want.
- 🪟 **Built for simplicity** — a `space`-leader scheme (thanks Spacemacs) and fuzzy finders for everything.
- 🎨 **Native GNOME look** — Adwaita with simple theming support.
- ✨ **Editor essentials** — LSP, tree-sitter syntax highlighting, file tree, git integration, and more.

## Install

zym needs Node.js ≥ 22.15 and the GTK 4 stack (GTK 4, libadwaita,
GtkSourceView 5, Vte):

```sh
# Arch
sudo pacman -S --needed nodejs npm gtk4 libadwaita gtksourceview5 vte4
# Fedora
sudo dnf install nodejs npm gtk4 libadwaita gtksourceview5 vte291-gtk4
# Debian / Ubuntu
sudo apt install gir1.2-gtk-4.0 gir1.2-adw-1 gir1.2-gtksource-5 gir1.2-vte-3.91
```

then:

```sh
npm install -g zym-editor --allow-scripts=native-keymap,node-gtk

zym                    # open the editor
zym --install-desktop  # add zym to your app launcher (optional)
```

Details, pnpm instructions, and fixes for common problems:
[getting started](guide/getting-started.md) ·
[troubleshooting](guide/troubleshooting.md).

## Quick start

Everything hangs off the **`space` leader** — press `space`, then a mnemonic:

| Keys          | Action |
| ------------- | ------ |
| `space space` | command palette — fuzzy-search every command |
| `space ?`     | keymap panel — every binding, live |
| `space o`     | fuzzy file picker |
| `space /`     | project-wide search (ripgrep) |
| `space g g`   | git panel |
| `space a a`   | agent picker |
| `space , ,`   | preferences |

The editor is modal (vim), terminals are modal too, and every list navigates
with `j`/`k`. Full tour: the **[user guide](guide/index.md)** —
[keybindings](guide/keybindings.md) ·
[configuration](guide/configuration.md) ·
[git & GitHub](guide/git.md) ·
[agents](guide/agents.md).

## In action

### Coding agents

Run `claude` and friends in the workbench, branch and switch between them from
a fuzzy command palette, and drive everything without leaving the keyboard.

![Fuzzy command palette listing the agent: commands](https://raw.githubusercontent.com/romgrk/zym/master/img/demo-command-palette.png)

### Code intelligence (LSP)

Language servers power completion, hover docs, and diagnostics — and zym
offers to install a missing server for you.

![Autocomplete popup with documentation for the selected entry](https://raw.githubusercontent.com/romgrk/zym/master/img/demo-lsp-autocomplete.png)
![Hover tooltip showing an inferred type](https://raw.githubusercontent.com/romgrk/zym/master/img/demo-lsp-hover.png)
![Toast offering to install a missing language server](https://raw.githubusercontent.com/romgrk/zym/master/img/demo-lsp-autoinstall.png)

### Navigation & search

Jump to any symbol, search the project with ripgrep, or find-and-replace with
regex in the current file.

![Symbol picker filtering workspace symbols](https://raw.githubusercontent.com/romgrk/zym/master/img/demo-symbol-picker.png)
![Project-wide ripgrep picker with live results](https://raw.githubusercontent.com/romgrk/zym/master/img/demo-ripgrep-picker.png)
![In-buffer regex search and replace](https://raw.githubusercontent.com/romgrk/zym/master/img/demo-search-regex.png)

### Git & GitHub

Checkout a pull request branch without leaving your editor. Filter as if you
were on GitHub.

![Pull request picker filtered by author](https://raw.githubusercontent.com/romgrk/zym/master/img/demo-github-pr-branch-filter.png)

Create a pull request in a single click.

![Creating a pull request from the current branch](https://raw.githubusercontent.com/romgrk/zym/master/img/demo-github-pr-create.png)

See live CI check status, and jump to any run log:

![CI checks all passing for a branch](https://raw.githubusercontent.com/romgrk/zym/master/img/demo-github-ci-success.png)

### Project sidebar

A file tree and a live git status view sit side by side in the left dock.

<p>
  <img src="https://raw.githubusercontent.com/romgrk/zym/master/img/demo-sidebar-files.png" alt="File tree in the sidebar" width="49%" />
  <img src="https://raw.githubusercontent.com/romgrk/zym/master/img/demo-sidebar-git.png" alt="Git status view listing staged and unstaged changes" width="49%" />
</p>

## Documentation

- **[User guide](guide/index.md)** — getting started, keybindings,
  configuration, git & GitHub, agents, troubleshooting.
- [Vim keymap reference](guide/vim-keymap-reference.md) — every binding, per
  mode.
- [`docs/`](docs/index.md) — internal architecture notes, if you want to hack
  on zym itself.

## License

[GPL-3.0-or-later](LICENSE).

The tree-sitter highlight queries under `src/syntax/queries/` are vendored from
[Zed](https://github.com/zed-industries/zed) (`crates/grammars/src/`), which are
licensed GPL-3.0 — bundling them is why zym is distributed under the GPL.
