# Commands & keymaps

The command/keymap layer ported from Atom/xedel and adapted to GTK. Commands are
named behaviors registered against widgets; keymaps bind keystroke sequences to
command names; both resolve along the focused widget's ancestor chain.

Core pieces:

- **`src/CommandManager.ts`** — `commands.add(selectorOrWidget, map)`; dispatch
  resolves up the focus chain (`dispatchAlongChain`); commands take **arguments**
  (`{ command, args }`) and **descriptions** (declared inline with the command,
  `{ didDispatch, description }`, indexed by name for name-only consumers via
  `descriptionFor()`); `getAvailableCommands()` powers the palette.
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
- **`src/ui/CommandPicker.ts`** — the command palette (fuzzy over name +
  description, muted `prefix:`, right-aligned description and primary keystroke).
  Built on the shared `ui/Picker.ts`; the command list is sorted alphabetically.

## Current state

- [x] CommandManager: selector + instance registration, focus-chain dispatch, args, descriptions
- [x] KeymapManager: sequences, priority, `unset!`, deferred full-matches
- [x] `#id` / tag / class selectors matched on `getName()` + CSS classes
- [x] Central `default.ts` keymap + user `keymap.json` override (priority) with load-time validation
- [x] Space leader; `.has-text-input` releases `space` in entries/terminal/insert mode
- [x] Command palette with descriptions, formatted labels, and a shortcut column (alphabetical order)
- [x] Palette search matches name **and** description, with name matches ranked first (`boostFrom`)
- [x] Picker matching (`src/ui/fuzzyMatch.ts`, fzy port) is **smartcase** by
  default: a lowercase query matches case-insensitively, but any uppercase
  letter in the query opts into a case-sensitive match. Toggle via the
  `smartcase` `FuzzyOptions` flag (completion sets it `false` to stay
  case-insensitive).
- [x] Command `when` predicate — the palette dims (and no-ops) commands not currently applicable
- [x] Window always in the active-element chain, so window-level bindings fire even with no focus

## Remaining work

- [x] **Keymap introspection** — `KeymapManager.keystrokesForCommand(name, elements)`
  + `getPendingBindings(elements, queue)` (reverse lookup over registered keymaps).
- [x] **Show the shortcut in the command palette** — each row shows its primary
  keystroke right-aligned beside the description (`CommandPicker`).
- [~] **which-key leader hints** — `ui/WhichKey.ts` is implemented (subscribes to
  `KeymapManager.onPendingChanged`, shows the continuations after a short delay,
  hides on completion/break) but **currently disabled**: its constructor leaves
  the `onPendingChanged` subscription commented out, so the hint card never shows.
  Re-enable by uncommenting that line. (The `KeymapPanel` below uses the same
  `onPendingChanged` signal and *is* live.)
- [x] **Live-reload `keymap.json`** — watched with a `Gio.FileMonitor`; edits
  re-register the user layer live (`keymaps/load.ts`, mirrors `config.json`).
- [x] **Conflict detection at load** — `KeymapManager.findConflicts()` reports
  keystrokes bound to multiple commands at the same selector + priority.
- [x] **Keymap reference panel** — `ui/KeymapPanel.ts`, a bottom-dock `Gtk.Grid`
  table of every binding with columns **keys · command · description · selector ·
  source** (source = `default` / `user` / layers like `vim-mode-plus`), with
  shadowed (overridden) bindings dimmed. While a multi-key sequence is in progress
  the table narrows to the bindings extending the queued prefix (subscribes to
  `onPendingChanged`, filters by `queuedKeystrokes`). Backed by
  `KeymapManager.getAllBindings()` + `onBindingsChanged` (`BindingInfo` carries
  `source` + `selector`), so a live `keymap.json` edit updates it. Toggled via
  `keymap:show` (`space ?`), docked in `AppWindow.toggleKeymapPanel`.
- [ ] **`when` keymap fall-through** — a disabled command currently still
  captures its keystroke (then no-ops); a future step would let the key fall
  through to the next match / the widget when `when` is false.
- [ ] **Keybinding customization UI** — the reference panel above now *views*
  bindings + their source; the remaining step is *editing* (rebind / unset from
  the panel, writing to `keymap.json`, like `ConfigEditor` for config). Lower
  priority; the JSON file already covers power users.

## Notes

- Descriptions are keyed by command **name** (global), so they can be declared in
  one place even for commands registered by different components — see
  `AppWindow.registerCommandDescriptions`.
- `when` is a predicate function on the command's object form
  (`{ didDispatch, description?, when? }`), a closure over live state
  (`when: () => this.activeEditor !== null`) — not a string DSL, since commands
  are declared in TS with the state in scope. Applied to `file:save`/`save-as`,
  `git:*`, and the `agent:*` commands (see `AppWindow`).
- The `:` ex-command line and richer search are tracked under
  [code-editing](code-editing/text-editor.md) (vim mode), not here — they consume
  this layer rather than extend it.
