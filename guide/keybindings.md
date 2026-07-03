# Keybindings

zym is organized around a **`space` leader**: press `space`, then a mnemonic.
Press `space ?` for the keymap panel — every active binding, and which layer it
comes from. `space space` opens the command palette, which fuzzy-searches every
command by name.

Vim bindings (motions, operators, text objects, …) are their own layer and are
documented in the [vim keymap reference](vim-keymap-reference.md). This page
covers everything else.

## Leader reference

### Top level

| Keys          | Command |
| ------------- | ------- |
| `space space` | command palette |
| `space ?`     | keymap panel |
| `space w`     | save file |
| `space o`     | fuzzy file picker |
| `space /`     | project search (quick-jump picker) |
| `space *`     | selected text → all matches in the search multibuffer |
| `space t`     | new terminal |
| `space n`     | toggle the notification log |
| `space q`     | quit |

### Files — `space f`

| Keys        | Command |
| ----------- | ------- |
| `space f f` | focus the file tree |
| `space f o` | fuzzy file picker |
| `space f e` | open by path (directory-navigating opener) |
| `space f m` | move the current file to another folder |
| `space f r` | rename the current file |

In the file tree: `j`/`k` move, `h` collapses / goes to parent, `l` enters a
directory or opens a file, `g g`/`G` jump to top/bottom, `,` toggles untracked
files, `.` toggles hidden files.

### Project — `space p`, workbench actions — `space x`

| Keys        | Command |
| ----------- | ------- |
| `space p s` | open the project-search multibuffer (editable results) |
| `space p r` | run a `package.json` script in a terminal |
| `space x x` | run the project's default action |
| `space x 1`…`9` | run the Nth project action |
| `space x o` | pick an action to run |
| `space x e` | edit the project settings (`.zym/settings.json`) |
| `space x r` | reset the live action set to the project defaults |

### Git — `space g`, hunks — `space h`

See [Git & GitHub](git.md) for the full workflow; highlights:

| Keys          | Command |
| ------------- | ------- |
| `space g g`   | git panel (Source Control) |
| `space g d d` | diff the current changes |
| `space g d b` | diff this branch vs master/main (PR-style) |
| `space g c`   | commit staged changes |
| `space g v`   | git log viewer |
| `space g b b` | branch picker (switch / create) |
| `space g h p` | check out a GitHub pull request |
| `space h s`   | stage the hunk under the cursor |

### LSP — `space l`

| Keys        | Command |
| ----------- | ------- |
| `space l d` | go to definition (also `g d` in normal mode) |
| `space l p` | peek definition inline |
| `space l D` | go to declaration (also `g D`) |
| `space l t` | go to type definition |
| `space l i` | go to implementation |
| `space l r` | find references |
| `space l s` | workspace symbols |
| `space l o` | document symbols (outline) |
| `space l k` | hover docs (also `K` in normal mode) |
| `space l a` | code action (quick fix / refactor) |
| `space l R` | rename symbol |
| `space l f` | format document |
| `space l l` | diagnostics panel |

### Agents — `space a`

See [Agents](agents.md); highlights:

| Keys          | Command |
| ------------- | ------- |
| `space a a`   | agent picker (agents, conversations, new) |
| `space a n n` | new agent |
| `space a n w` | new agent in a fresh git worktree |
| `space a s s` | send the selection to the current agent |
| `space a w`   | switch workbench (you / an agent) |

### Sessions — `space s`, settings — `space ,`

| Keys        | Command |
| ----------- | ------- |
| `space s s` | save the session (names it the first time) |
| `space s a` | save the session under a name |
| `space s o` | open a saved session |
| `space s R` | rename the current session |
| `space , ,` | preferences window |
| `space , c` | edit `config.json` as text |
| `space , k` | edit `keymap.json` as text |
| `space , p` | plugin manager |

## Windows, tabs, docks

| Keys                    | Command |
| ----------------------- | ------- |
| `ctrl-w v` / `ctrl-w s` | split right / down |
| `ctrl-w h/j/k/l`        | focus pane left/down/up/right |
| `ctrl-w w`              | focus next pane |
| `ctrl-w c`              | close pane |
| `alt-,` / `alt-.`       | previous / next tab |
| `alt-<` / `alt->`       | move tab backward / forward |
| `alt-1`…`alt-8`         | go to tab N |
| `alt-9`                 | go to last tab |
| `alt-c` / `alt-C`       | close tab / reopen last closed |
| `alt-p`                 | pin/unpin tab |
| `ctrl-w g h/j/k/l`      | toggle the dock on that side |
| `ctrl-w g s`            | toggle the workbench sidebar |
| `ctrl-w g a`            | toggle the agent sidebar |
| `super-,` / `super-.`   | previous / next workbench |

## Terminal

Terminals are modal: insert mode types into the shell, normal mode gives the
keys back to zym.

| Keys                            | Command |
| ------------------------------- | ------- |
| `escape`                        | normal mode |
| `i` / `a`                       | insert mode |
| `ctrl-[`                        | send a literal Escape to the shell |
| `ctrl-shift-c` / `ctrl-shift-v` | copy / paste |

## Customizing

Bindings are data: the defaults live in
[`src/keymaps/default.ts`](../src/keymaps/default.ts). To override them, create
`~/.config/zym/keymap.json` (`space , k` opens it) with the same
`{ "selector": { "keystroke": "command" } }` shape — user bindings take
priority, and the file is live-reloaded on save.

Selectors target a zym component by CSS class, optionally with state classes:
`.AppWindow`, `.Panel`, `.FileTree`, `.TextEditor.insert-mode`, ….

A binding's value may pass arguments to its command with
`{ "command": "...", "args": [...] }` instead of a bare string. For example,
`alt-1`…`alt-8` are a single parameterized command:

```json
{ ".Panel": { "alt-3": { "command": "tab:go-to", "args": [2] } } }
```

Use the value `"unset!"` to release a keystroke for a selector so it falls
through to the widget instead of triggering a binding. Widgets that take
literal text input (entries, the terminal, the editor in insert mode) carry a
`.has-text-input` class, and a single rule frees `space` there even though it's
the global leader prefix:

```json
{ ".has-text-input": { "space": "unset!" } }
```
