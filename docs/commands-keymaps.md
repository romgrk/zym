# Commands & keymaps

The command/keymap layer ported from Atom and adapted to GTK. Commands
are named behaviors registered against widgets; keymaps bind keystroke
sequences to command names; both resolve along the focused widget's
ancestor chain.

## Canonical form

Write every keystroke exactly as the keymap data spells it
(`Key.fromDescription`): lowercase, presses space-separated, a modifier joined to
its key with `-` (combined order `super-ctrl-alt-shift`), named keys as their
lowercase keyval name (`space`, `enter`, `escape`, `tab`, `up`/`down`,
`kp_enter`) — e.g. `space ctrl-w g s`, `ctrl-]`, `alt-1`. This one form is used
everywhere a binding appears: `keymaps/default.ts`, the app's UI (`keycap()`,
keymap panel, command palette, which-key — all render it verbatim), and these
docs. Never `Ctrl+W`, `<space>`, `C-w`, or `SPC`.

Core pieces:

- **`src/CommandManager.ts`** — `commands.add(selectorOrWidget, map)`;
  dispatch resolves up the focus chain (`dispatchAlongChain`); commands
  take **arguments** (`{ command, args }`) and **descriptions** (declared
  inline with the command, `{ didDispatch, description }`, indexed by name
  for name-only consumers via `descriptionFor()`); `getAvailableCommands()`
  powers the palette.
- **`src/KeymapManager.ts`** — multi-key sequences, **priority** layering,
  `unset!` (release a key to the widget), deferred full-matches (a prefix
  that is also a complete binding, e.g. `y` vs `y s`), CAPTURE-phase
  controller on the window.
- **`src/util/selectors.ts`** — selectors match the widget's GTK name
  (`getName()` — a type tag like `GtkText`) and its CSS classes
  (`getCssClasses()`): a zym component is targeted by its class
  (`.Component`), with `.class` / `:not(.class)` fragments; `#id` still
  matches the name for any raw GTK widget that sets one.
- **`src/keymaps/default.ts`** + **`load.ts`** — the built-in keymap as
  data, plus an optional user `~/.config/zym/keymap.json` layered at
  higher priority, validated at load.
- **`src/ui/CommandPicker.ts`** — the command palette (fuzzy over name +
  description, muted `prefix:`, right-aligned description and primary
  keystroke). Built on the shared `ui/Picker.ts`; the command list is
  sorted alphabetically.

## Behavior

- `space` is the leader key; `.has-text-input` releases `space` in entries,
  the terminal, and insert mode.
- The window is always in the active-element chain, so window-level
  bindings fire even when nothing is focused.
- The command palette shows descriptions, formatted labels, and a
  right-aligned shortcut column (alphabetical order). Search matches name
  **and** description, with name matches ranked first (`boostFrom`).
- Picker matching (`src/ui/fuzzyMatch.ts`, fzy port) is **smartcase** by
  default: a lowercase query matches case-insensitively, but any uppercase
  letter in the query opts into a case-sensitive match. Toggle via the
  `smartcase` `FuzzyOptions` flag (completion sets it `false` to stay
  case-insensitive).
- **Binding resolution** — when several bindings match the same keystroke, the
  winner is chosen by, in order: (1) **priority** (a user keymap layered over the
  defaults); (2) **focus-chain proximity** — the *nearest scope wins*, so a
  binding on the focused widget beats one on a farther ancestor (e.g.
  `.AppWindow`) even if the ancestor's selector is more specific; (3) **selector
  specificity**, which only disambiguates bindings on the *same* element (e.g.
  `.TextEditor.continuous-diff.normal-mode` over `.TextEditor.normal-mode`). This
  is the same "nearest scope wins" rule the chord-preemption logic uses
  (`preemptsChord`); see `KeymapManager.compareFullMatches`.
- A command `when` predicate controls applicability: the palette dims (and
  no-ops) commands not currently applicable.
- Keymap introspection: `KeymapManager.keystrokesForCommand(name, elements)`
  + `getPendingBindings(elements, queue)` do reverse lookup over registered
  keymaps.
- `keymap.json` live-reloads via a `Gio.FileMonitor`; edits re-register the
  user layer live (`keymaps/load.ts`, mirrors `config.json`).
- **Partial-match timeout** — an incomplete multi-key chord prefix is held for
  `keymap.partialMatchTimeoutMs` (config, default 1000ms) before it's abandoned
  and the keys fall through to the focused widget (or a shorter binding fires).
  Read live at schedule time in `KeymapManager.schedulePartialMatchTimeout`
  (`DEFAULT_PARTIAL_MATCH_TIMEOUT_MS` is the fallback).
- Conflict detection at load: `KeymapManager.findConflicts()` reports
  keystrokes bound to multiple commands at the same selector + priority.
- **Transient key grabs** — `KeymapManager.addListener(fn)` registers a listener
  that sees every keystroke *before* binding dispatch; returning `true` claims the
  key (the returned disposable releases the grab). This is the modal
  "read the next key" primitive — use it (never an EventController or a temporary
  keymap layer) for leap/readChar-style interactions: vim's `readChar` (`f`/`t`/
  `r`, registers) and the workbench jump (`workbench:jump`) are the precedents.

## UI surfaces

- **Keymap reference panel** — `ui/KeymapPanel.ts`, a bottom-dock
  `Gtk.Grid` table of every binding with columns **keys · command ·
  description · selector · source** (source = `default` / `user` / layers
  like `vim-mode-plus`), with shadowed (overridden) bindings dimmed. While
  a multi-key sequence is in progress the table narrows to the bindings
  extending the queued prefix (subscribes to `onPendingChanged`, filters by
  `queuedKeystrokes`). Backed by `KeymapManager.getAllBindings()` +
  `onBindingsChanged` (`BindingInfo` carries `source` + `selector`), so a
  live `keymap.json` edit updates it. Toggled via `keymap:show` (`space ?`),
  docked in `AppWindow.toggleKeymapPanel`.
- **which-key leader hints** — `ui/WhichKey.ts` subscribes to
  `KeymapManager.onPendingChanged`, shows the continuations after a short
  delay, and hides on completion/break. Currently **disabled**: its
  constructor leaves the `onPendingChanged` subscription commented out, so
  the hint card never shows. Re-enable by uncommenting that line.
  (`KeymapPanel` uses the same `onPendingChanged` signal and *is* live.)

## Remaining / planned

- [ ] **`when` keymap fall-through** — a disabled command currently still
  captures its keystroke (then no-ops); a future step would let the key
  fall through to the next match / the widget when `when` is false.
- [ ] **Keybinding customization UI** — the reference panel above *views*
  bindings + their source; the remaining step is *editing* (rebind / unset
  from the panel, writing to `keymap.json`, like `ConfigEditor` for config).
  Lower priority; the JSON file already covers power users.
- [~] **Re-enable which-key hints** — see UI surfaces above; the component
  exists but its subscription is commented out.

## Notes

- Descriptions are keyed by command **name** (global), so they can be
  declared in one place even for commands registered by different
  components — see `AppWindow.registerCommandDescriptions`.
- `when` is a predicate function on the command's object form
  (`{ didDispatch, description?, when? }`), a closure over live state
  (`when: () => this.activeEditor !== null`) — not a string DSL, since
  commands are declared in TS with the state in scope. Applied to
  `file:save`/`save-as`, `git:*`, and the `agent:*` commands (see
  `AppWindow`).
- The `:` ex-command line and richer search are tracked under
  [text-editor](text-editor/index.md) (vim mode), not here — they consume
  this layer rather than extend it.
