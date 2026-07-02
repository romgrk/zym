# Configuration

Settings live in `~/.config/zym/config.json` (or `$XDG_CONFIG_HOME/zym/`),
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
you want to change; deleting a key reverts it to the default. A value that's
out of range or the wrong type is ignored with a warning. Saving the file
applies the changes immediately, no restart needed.

## The preferences window

`space , ,` (or `config:open-editor` from the command palette) opens the
preferences window, which writes back to the same `config.json`. Its labels are
the config keys themselves (e.g. the `fileTree` group, the `hideHidden` row),
so they match exactly what you'd write by hand. To edit the JSON in a tab
instead, use `space , c` (`config:open-as-text`).

## Common keys

| Key                            | Type    | Default     | Description |
| ------------------------------ | ------- | ----------- | ----------- |
| `core.followSystemColorScheme` | boolean | `true`      | Follow the system light/dark preference |
| `editor.tabLength`             | integer | `2`         | Spaces a tab is rendered as (1–16) |
| `editor.fontFamily`            | string  | `""`        | Editor font family; empty uses the platform mono |
| `editor.fontSize`              | integer | `13`        | Editor font size in points (6–100) |
| `agent.command`                | array   | `["claude"]`| Command used to launch a new agent |

The preferences window (`space , ,`) lists every available key with its type,
range, and default — it is generated from the same schema that validates the
file, so it is always complete and current.

## Per-project settings

A project can carry a `.zym/settings.json` at its root (`space x e` opens it).
It holds the project's runnable actions (run with `space x x` / `space x 1`…`9`)
and named project-search presets.

## Keybindings

Key customization lives in a separate file, `~/.config/zym/keymap.json` — see
[Keybindings](keybindings.md#customizing).
