# quilx

A modal source-code editor built with [GtkSourceView 5](https://gitlab.gnome.org/GNOME/gtksourceview),
GTK 4 and [Adwaita](https://gnome.pages.gitlab.gnome.org/libadwaita/), running on
[node-gtk](https://github.com/romgrk/node-gtk).

## Features

- **Vim-style modal editing** via `GtkSource.VimIMContext`, with a status line
  showing the command bar (`:`, `/`) and pending command preview (e.g. `2dw`)
- Syntax highlighting with automatic language detection
- Adwaita light/dark style schemes that follow the system preference, plus a
  toolbar toggle to force dark mode
- Open / Save / Save-As through the native `Gtk.FileDialog`
- A source-map (minimap) gutter on the right
- Keyboard shortcuts: `Ctrl+O` open, `Ctrl+S` save, `Ctrl+Shift+S` save-as,
  `Ctrl+Q` quit

## Requirements

- Node.js and [pnpm](https://pnpm.io)
- GTK 4, libadwaita, and GtkSourceView 5 with their GObject-Introspection
  typelibs installed (`Gtk-4.0`, `Adw-1`, `GtkSource-5`)

## Setup

`node-gtk` is consumed as a local linked dependency (`link:../node-gtk`), so a
checkout of [node-gtk](https://github.com/romgrk/node-gtk) must sit alongside
this project:

```
src/
├── node-gtk/
└── quilx/
```

Then install:

```sh
pnpm install
```

## Usage

```sh
pnpm start [file]
# or
node src/editor.js [file]
```

With no argument, quilx opens its own source. In the editor, normal mode is
active by default — press `i` to insert, `Esc` to return to normal mode, and use
`:w`, `:e <path>`, `:q`, `:wq` as you would in Vim.

## Configuration

Settings live in `~/.config/quilx/config.json` (or `$XDG_CONFIG_HOME/quilx/`),
created automatically on first launch and seeded with an empty `{}`. The file is
a flat map of dotted keys to values, mirroring the schema key paths exactly:

```json
{
  "editor.tabLength": 4,
  "editor.fontSize": 15,
  "core.followSystemColorScheme": false
}
```

Each key is an **override** on top of its built-in default — only list the ones
you want to change; deleting a key reverts it to the default. Values are coerced
and validated against the schema (e.g. an out-of-range number is clamped, the
string `"4"` becomes the integer `4`); a value that can't fit is ignored with a
warning. The file is **watched live**: saving it applies the changes without a
restart.

The application-wide schema is declared in [`src/quilx.ts`](src/quilx.ts);
subsystems contribute their own namespaced keys at load time (e.g. the Vim layer
registers under `vim-mode-plus.*` — see
[`src/ui/TextEditor/vim/settings.ts`](src/ui/TextEditor/vim/settings.ts)). The
baseline keys:

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
licensed GPL-3.0. Bundling them is why quilx as a whole is distributed under the
GPL.
