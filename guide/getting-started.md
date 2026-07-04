# Getting started

## Install

zym runs on Node.js and the GTK 4 stack. It is tested on Linux; macOS and
Windows are not supported yet.

**Arch Linux**: install [`zym-git`](https://aur.archlinux.org/packages/zym-git)
from the AUR (`yay -S zym-git`) and skip everything below — dependencies,
launcher, and desktop entry are all handled by the package.

**1. System libraries** — GTK 4, libadwaita, GtkSourceView 5, and Vte (GTK 4
build), with their GObject-Introspection typelibs:

```sh
# Arch
sudo pacman -S --needed nodejs npm gtk4 libadwaita gtksourceview5 vte4

# Fedora
sudo dnf install nodejs npm gtk4 libadwaita gtksourceview5 vte291-gtk4

# Debian / Ubuntu
sudo apt install gir1.2-gtk-4.0 gir1.2-adw-1 gir1.2-gtksource-5 gir1.2-vte-3.91
```

**2. Node.js ≥ 22.15.** zym runs its TypeScript source directly through Node's
type stripping, which needs a recent Node. If your distribution ships an older
one, install Node through [fnm](https://github.com/Schniz/fnm),
[nvm](https://github.com/nvm-sh/nvm), or your preferred version manager.

**3. The editor:**

```sh
npm install -g zym-editor
```

Two native modules (`node-gtk`, `native-keymap`) run an install step —
prebuilt binaries are downloaded when available. zym's manifest pre-approves
them for npm (the `allowScripts` field); pnpm ignores that field by design, so
there you approve the builds yourself:

```sh
pnpm add -g zym-editor
pnpm approve-builds -g   # select native-keymap and node-gtk
```

**4. Optional — desktop launcher:**

```sh
zym --install-desktop
```

This writes a `.desktop` entry and installs the app icons, so zym shows up in
your application launcher and can be pinned to the dock.

If anything goes wrong, see [Troubleshooting](troubleshooting.md).

## First launch

```sh
zym            # open the editor in the current directory
zym file.txt   # open a file
```

The window is a *workbench*: a center area of editor tabs, docks on the sides
(file tree and Source Control on the right, notification log at the bottom),
and a workbench sidebar on the far left listing you and any running agents.

## The space leader

Almost everything in zym is reached by pressing `space`, then a mnemonic:

| Keys          | Action |
| ------------- | ------ |
| `space space` | command palette — fuzzy-search every command |
| `space ?`     | keymap panel — every active binding and its source |
| `space o`     | fuzzy file picker |
| `space /`     | project-wide text search (ripgrep) |
| `space w`     | save |
| `space t`     | new terminal |
| `space g g`   | git panel |
| `space a a`   | agent picker |
| `space , ,`   | preferences |
| `space q`     | quit |

Mnemonics group into families: `space f …` files, `space g …` git,
`space l …` LSP, `space a …` agents. The full map is in
[Keybindings](keybindings.md).

In contexts that take literal text (entries, terminals, insert mode), `space`
just types a space — the leader only fires where it can't collide with typing.

## Modal editing

The editor is modal, with a vim implementation ported from Atom's
`vim-mode-plus` (and improved). All the essentials work as you'd expect —
motions, operators, text objects, registers, search with `/`, visual and
blockwise modes — plus multi-cursor and occurrence editing.

Terminals are modal too: they open in *insert* mode (keys go to the shell);
`escape` switches to *normal* mode where window navigation and the leader work,
and `i` or `a` returns to insert. `ctrl-[` always sends a literal Escape to the
shell. Copy/paste is `ctrl-shift-c` / `ctrl-shift-v`.

The exhaustive per-mode vim binding table lives in
[the vim keymap reference](vim-keymap-reference.md).

## Panes, tabs, docks

Vim's window vocabulary manages the layout:

| Keys                        | Action |
| --------------------------- | ------ |
| `ctrl-w v` / `ctrl-w s`     | split right / down |
| `ctrl-w h/j/k/l`            | focus the pane in that direction |
| `ctrl-w c`                  | close the pane |
| `alt-,` / `alt-.`           | previous / next tab |
| `alt-1` … `alt-9`           | jump to tab N (9 = last) |
| `alt-c` / `alt-C`           | close tab / reopen last closed |
| `ctrl-w g h/j/k/l`          | toggle the dock on that side |

## Notifications

Operations report through toasts over the workbench; every notification is
also kept in the session-long notification log in the bottom dock. Toggle the
log with `space n`; while it's focused, `c` clears the history and `q` hides
it.

## Sessions

A session is a named, reopenable snapshot of your workspace — open files (with
cursor and scroll), unsaved buffers, terminals, agents, layout, and window
geometry. A fresh window starts *unnamed*: it works normally but isn't saved
anywhere. `space s s` names and saves it (it acts as "save as" the first time);
once named, it autosaves as you work. `space s o` reopens a saved session,
`space s a` forks the current one under a new name, and `space s R` renames it.

Closing a window silently discards an *unnamed* session (only unsaved editor
tabs prompt) — so save it with a name if you want it back. Sessions live under
`~/.local/state/zym/` and are global, so `space s o` reaches any of them.

## Projects

One window can hold several projects. `space p o` opens another folder as a
project (its own file tree, Source Control, and tabs); it appears in the
left rail beside the first, and you switch between them there (or with
`super-,` / `super-.`). `space p c` closes the active project — and every
workbench under it, including the agents you launched in it (never the last
project).

## Where things live

zym follows the XDG base directories:

| Path | Contents |
| ---- | -------- |
| `~/.config/zym/` | `config.json`, `keymap.json` |
| `~/.local/state/zym/` | sessions, pickers' frecency data |
| `~/.cache/zym/` | installed language servers, generated editor schemes |
