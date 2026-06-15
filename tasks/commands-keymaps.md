# Commands & keymaps

The command/keymap layer ported from Atom/xedel and adapted to GTK. Commands are
named behaviors registered against widgets; keymaps bind keystroke sequences to
command names; both resolve along the focused widget's ancestor chain.

Core pieces:

- **`src/CommandManager.ts`** — `commands.add(selectorOrWidget, map)`; dispatch
  resolves up the focus chain (`dispatchAlongChain`); commands take **arguments**
  (`{ command, args }`) and **descriptions** (`describe()` or `{ didDispatch,
  description }`); `getAvailableCommands()` powers the palette.
- **`src/KeymapManager.ts`** — multi-key sequences, **priority** layering,
  `unset!` (release a key to the widget), deferred full-matches (a prefix that is
  also a complete binding, e.g. `y` vs `y s`), CAPTURE-phase controller on the
  window.
- **`src/util/selectors.ts`** — selectors match the widget's GTK name
  (`getName()`): `#Component` (a quilx component), a type tag (`GtkText`), and
  `.class` / `:not(.class)` fragments.
- **`src/keymaps/default.ts`** + **`load.ts`** — the built-in keymap as data,
  plus an optional user `~/.config/quilx/keymap.json` layered at higher priority,
  validated at load.
- **`src/ui/CommandPicker.ts`** — the command palette (fuzzy, muted `prefix:`,
  right-aligned descriptions).

## Current state

- [x] CommandManager: selector + instance registration, focus-chain dispatch, args, descriptions
- [x] KeymapManager: sequences, priority, `unset!`, deferred full-matches
- [x] `#id` / tag / class selectors matched on `getName()` + CSS classes
- [x] Central `default.ts` keymap + user `keymap.json` override (priority) with load-time validation
- [x] Space leader; `.has-text-input` releases `space` in entries/terminal/insert mode
- [x] Command palette with descriptions and formatted labels
- [x] Window always in the active-element chain, so window-level bindings fire even with no focus

## Remaining work

Roughly by value. Most build on **keymap introspection**, which doesn't exist yet.

- [ ] **Keymap introspection** — `KeymapManager.keystrokesForCommand(name, elements)`
  (reverse lookup over registered keymaps). Foundation for the two items below.
- [ ] **Show the shortcut in the command palette** — display each command's bound
  keystroke (right-aligned, by the description). Needs introspection.
- [ ] **which-key leader hints** — after a partial match (e.g. `space`), pop up the
  available continuations and their commands. Big win for a leader-first editor;
  hook the partial-match branch in `processKeystroke`.
- [ ] **Live-reload `keymap.json`** — watch it with a `Gio.FileMonitor` and
  re-register on change, mirroring how `config.json` is watched (`config/load.ts`).
  Today the user keymap is read once at startup.
- [ ] **Conflict detection at load** — `validateKeymap` flags unparseable
  selectors/keys and empty commands, but not two bindings competing for the same
  keystroke+selector. Warn (or report) on conflicts.
- [ ] **Keybinding customization UI** — view/override bindings from a settings
  surface (like `ConfigEditor` for config), writing to `keymap.json`. Lower
  priority; the JSON file already covers power users.

## Notes

- Descriptions are keyed by command **name** (global), so they can be declared in
  one place even for commands registered by different components — see
  `AppWindow.registerCommandDescriptions`.
- The `:` ex-command line and richer search are tracked under
  [code-editing](code-editing/text-editor.md) (vim mode), not here — they consume
  this layer rather than extend it.
