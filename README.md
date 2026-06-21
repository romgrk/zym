
<h1 align="center">
  quilx
</h1>

<p align="center">
  <b>neovim + agents + LSP<br/>
  Native GTK 4 — no Electron.<br/>
  Node.js under the hood — the full npm ecosystem.</b>
</p>

A keyboard-driven, modern code editor — blending the best from neovim, atom, zed, vscode, and so many others — with coding agents living right alongside you — each tracked live, so you always know which agent is working, waiting, or done.

*Beta state. Tested on Linux; might not run on macOS or Windows yet.*

![quilx running a coding agent side by side with the editor, file tree, and a fuzzy command palette](img/demo-agent-workflow.png)

## Highlights

- ⌨️ **Vim beyond its best**: the `vim-mode-plus` plugin ported from Atom — so good it's better than the original. Multi-cursor, occurrences, text objects, operators, and more (target.vim, leap.nvim, etc).
- 🤖 **Agents** (well at least `claude`) — you work alongside your minions. Jump to their workbench to see what they edited. Jump to your workbench to work on your own.
- 🪟 **Built for simplicity** — a `space`-leader scheme (thanks Spacemacs) and fuzzy finders for everything.
- 🎨 **Native GNOME look** — Adwaita with simple theming support.
- ✨ **Editor essentials** — LSP, tree-sitter syntax highlighting, file tree, git integration, and more.

*Coming up*: **🌳 `git worktree` integration**: spawn your minions in their own worktrees and switch to their view whenever you want.

Jump to the details: [Keybindings](#keybindings) ·
[Notifications](#notifications) · [Agents](#agents) ·
[Configuration](#configuration)

## In action

### Coding agents

Run `claude` and friends in the workbench, branch and switch between them from a
fuzzy command palette, and drive everything without leaving the keyboard.

![Fuzzy command palette listing the agent: commands](img/demo-command-palette.png)

### Code intelligence (LSP)

Language servers power completion, hover docs, and diagnostics — and quilx
offers to install a missing server for you.

![Autocomplete popup with documentation for the selected entry](img/demo-lsp-autocomplete.png)
![Hover tooltip showing an inferred type](img/demo-lsp-hover.png)
![Toast offering to install a missing language server](img/demo-lsp-autoinstall.png)

### Navigation & search

Jump to any symbol, search the project with ripgrep, or find-and-replace with
regex in the current file.

![Symbol picker filtering workspace symbols](img/demo-symbol-picker.png)
![Project-wide ripgrep picker with live results](img/demo-ripgrep-picker.png)
![In-buffer regex search and replace](img/demo-search-regex.png)

### Git & GitHub

Checkout a pull request branch without leaving your editor. Filter as if you were on GitHub.

![Pull request picker filtered by author](img/demo-github-pr-branch-filter.png)

Create a pull request in a single click.

![Creating a pull request from the current branch](img/demo-github-pr-create.png)

See live CI check status, and jump to any run log:

![CI checks all passing for a branch](img/demo-github-ci-success.png)

### Project sidebar

A file tree and a live git status view sit side by side in the left dock.

<p>
  <img src="img/demo-sidebar-files.png" alt="File tree in the sidebar" width="49%" />
  <img src="img/demo-sidebar-git.png" alt="Git status view listing staged and unstaged changes" width="49%" />
</p>


## Requirements

- Node.js and [pnpm](https://pnpm.io)
- GTK 4, libadwaita, and GtkSourceView 5 with their GObject-Introspection
  typelibs installed (`Gtk-4.0`, `Adw-1`, `GtkSource-5`)

## Install

```
pnpm add -g github:romgrk/quilx
```

## Usage

```sh
quilx [file]
```

## Keybindings

quilx is organized around a **`space` leader**: press `space`, then a mnemonic. Press `space ?` to see the keymap panel.

Bindings live in [`src/keymaps/default.ts`](src/keymaps/default.ts). To override
them, drop a `~/.config/quilx/keymap.json` (the same
`{ "selector": { "keystroke": "command" } }` shape) — user bindings take priority
over the defaults.

Selectors target a **quilx component** by name with an `#id`: `#AppWindow`,
`#Panel`, `#FileTree`, `#TextEditor.insert-mode`, etc.

A binding's value may also pass arguments to its command, using
`{ "command": "...", "args": [...] }` instead of a bare string. For example,
`Alt+1`…`Alt+8` are a single parameterized command:

```json
{ "#Panel": { "alt-3": { "command": "tab:go-to", "args": [2] } } }
```

Use the value `"unset!"` to release a keystroke for a selector so it falls
through to the widget instead of triggering a binding. Widgets that take literal
text input (entries, the terminal, the editor in insert mode) carry a
`.has-text-input` class, and a single rule frees `Space` there even though it's
the global leader prefix:

```json
{ ".has-text-input": { "space": "unset!" } }
```

## Notifications

Modeled on Atom's `NotificationManager`, quilx separates *posting* a notification
from *showing* it. Subsystems post through the global hub, `quilx.notifications`,
which keeps every notification for the session; views render from it.

```js
quilx.notifications.addInfo('Saved');
quilx.notifications.addWarning('Untracked files hidden');
quilx.notifications.addError('Push failed', { detail: 'rejected: non-fast-forward' });
```

There are five severities — `addInfo`, `addSuccess`, `addWarning`, `addError`,
and `addFatalError` — each taking a message and optional
`{ detail, description, icon, dismissable, buttons }`. By default a notification
auto-expires; pass `dismissable: true` to keep its toast until it's closed.

Each posted notification shows up in two places:

- a **transient toast** over the workbench (one action button is mapped from
  `buttons`), and
- the **notification log**, a panel in the bottom dock holding the full session
  history (severity icon, message, optional detail, and the time it was posted).

On a toast, `detail`/`description` and any buttons beyond the first are dropped —
they belong to the log. The log is hidden until toggled with `Space` `n`; while
it's focused, `c` clears the history and `q` hides it (commands
`notifications:toggle-log` and `notifications:clear`, also reachable from the
command picker). Window actions
like saving and the git commands post through this hub, so their results land in
the log too.

## Agents

quilx can host terminal-based coding agents (such as `claude`) right inside the
workbench. An agent is a terminal like any other, except it runs the agent CLI
instead of a login shell and is tracked in the global registry `quilx.agents`.
When the agent process exits the pane is *not* torn down — a "process exited"
notice is printed and the agent stays listed, flipped to an `exited` status, so
you can read its final output.

- `Space` `a` `a` opens the agent quick-switcher (`agent:switch`), a fuzzy picker
  over the running agents. Typing a prompt and choosing **Start agent** launches a
  fresh agent seeded with that prompt.
- `Space` `a` `n` launches a new agent (`agent:new`). The argv comes from the
  `agent.command` config (default `['claude']`).

Running agents appear in the workbench list:

| Indicator      | Meaning                          |
| -------------- | -------------------------------- |
| green dot      | idle / ready                     |
| amber dot      | waiting for the user (e.g. a permission prompt)  |
| grey cog       | working                          |
| muted dot      | the process has exited           |

Activating a row reveals and focuses that agent's terminal.

For a `claude` agent the live status is driven by **Claude Code hooks**: quilx
launches `claude` with a per-session `--settings` block whose hooks write a status
word to a file the terminal watches (via a `Gio` file monitor). The reporter
script is bundled at [`assets/hooks/agent-status.sh`](assets/hooks/agent-status.sh).

## Configuration

Settings live in `~/.config/quilx/config.json` (or `$XDG_CONFIG_HOME/quilx/`),
created automatically on first launch. The file is a flat map of dotted keys to
values:

```json
{
  "editor.tabLength": 4,
  "editor.fontSize": 15,
  "core.followSystemColorScheme": false
}
```

Each key is an **override** on top of its built-in default — only list the ones
you want to change; deleting a key reverts it to the default. A value that's out
of range or the wrong type is ignored with a warning. Saving the file applies the
changes immediately, no restart needed.

You can also open the **preferences window** (`space , ,`, or
`config:open-editor` from the command picker), which writes back to the same
`config.json`. Its labels are the config keys themselves (e.g. the `fileTree`
group, the `hideHidden` row), so they match exactly what you'd write by hand. To
edit the JSON in a tab instead, use `config:open-as-text`.

The baseline keys:

| Key                            | Type      | Default | Description                                        |
| ------------------------------ | --------- | ------- | -------------------------------------------------- |
| `core.followSystemColorScheme` | boolean   | `true`  | Follow the system light/dark preference            |
| `editor.tabLength`             | integer   | `2`     | Spaces a tab is rendered as (1–16)                 |
| `editor.fontFamily`            | string    | `""`    | Editor font family; empty uses the platform mono   |
| `editor.fontSize`              | integer   | `13`    | Editor font size in points (6–100)                 |

## License

[GPL-3.0-or-later](LICENSE).

The tree-sitter highlight queries under `src/syntax/queries/` are vendored from
[Zed](https://github.com/zed-industries/zed) (`crates/grammars/src/`), which are
licensed GPL-3.0 — bundling them is why quilx is distributed under the GPL.
