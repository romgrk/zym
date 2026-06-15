# System integration

How quilx tracks the host desktop's settings — light/dark appearance, accent,
and fonts — and keeps the running UI in sync when the user changes them. The
guiding rule: **OS appearance and font changes must be followed through at
runtime**, without a restart.

Today most of these are read **once** at startup, so changing the desktop
monospace font, the UI font, or the light/dark preference while quilx is running
has no effect (or only a partial one). This page records what already reacts,
where the gaps are, and the plan to close them.

## Goal

When the user changes a relevant desktop setting, the corresponding quilx surface
updates live:

- **Light ⇄ dark** → editor scheme, syntax colors, chrome (header/status/tree),
  pickers/popovers, terminal — and, ideally, the active theme variant.
- **Monospace font / size** (`org.gnome.desktop.interface monospace-font-name`)
  → editor, terminal, pickers, anything monospace.
- **UI font** (`…interface font-name`) → proportional text (e.g. command-picker
  descriptions, labels).
- **Accent color** (where we honor it) → match highlight, action rows.

## Current state

What exists, and whether it reacts to a live change:

- **Editor color scheme** — `TextEditor.followSystemColorScheme` subscribes to
  `Adw.StyleManager` `notify::dark` and re-applies the GtkSource scheme +
  re-runs syntax restyle. ✅ *reacts* — **but only when the theme defines no
  `ui.bg`** (a theme with its own background owns a fixed scheme that does not
  follow the OS; built once).
- **Terminal colors** — `Terminal.followSystemColorScheme` clears explicit colors
  so VTE inherits libadwaita's themed fg/bg, which flip with the system scheme.
  ✅ *reacts passively* (no explicit handler).
- **Active theme** — `theme = loadTheme('quilx')` picks a **fixed** Zed variant
  (the first in the family) at module load. The whole `theme.ui.*` / `theme.syntax.*`
  palette is static. ❌ does **not** follow OS light/dark; there is no light↔dark
  variant swap.
- **`core.followSystemColorScheme` config** — declared in the schema
  (`src/quilx.ts`) but **not consumed anywhere**. ❌ dead setting; should gate the
  follow-the-OS behavior once it exists.
- **Fonts** — `fonts.ts` reads gsettings each call (`monospaceFontName` /
  `font-name`), but callers read **once**: `Picker` caches `monospaceFontCss()`
  in a module-level `const MONOSPACE`; `Terminal` calls `setFont(...)` at
  construction; `CommandPicker` reads `uiFontFamily()` per-open (so a *new* picker
  picks up a change, but open ones and the editor/terminals do not). ❌ no live
  re-apply; **no `Gio.Settings` `changed` subscription** on the interface schema.
- **Match-highlight / accent** — `Picker.HIGHLIGHT_COLOR = theme.ui.textAccent`
  is a module-load constant baked into row markup. ❌ static (follows neither a
  theme change nor the OS accent).

## Gaps (the "not followed through" list)

1. Desktop **monospace font** change → editor / terminal / pickers keep the old
   font until restart.
2. Desktop **UI font** change → open pickers/labels keep the old font.
3. OS **light ⇄ dark** change → the quilx theme palette (chrome, syntax, picker
   colors) does not switch; only the Adwaita-fallback editor scheme + terminal
   do.
4. **Accent** change → match highlight unchanged.
5. `core.followSystemColorScheme` does nothing.

## Plan

A single owner for desktop-settings signals, plus making the consumers
re-appliable.

- [ ] **`SystemSettings` watcher** — one module that holds the relevant
  `Gio.Settings` (`org.gnome.desktop.interface`) and `Adw.StyleManager`,
  subscribes to their `changed::monospace-font-name`, `changed::font-name`,
  `changed::color-scheme` (+ accent) / `notify::dark`, and emits coarse signals:
  `onFontsChanged`, `onAppearanceChanged`. Lives under `quilx.system` (global).
- [ ] **Make fonts reactive** — drop the cached `MONOSPACE` const / one-shot
  `setFont`; have font consumers re-read on `onFontsChanged`. Options: a small
  CSS-variable layer for monospace (so a single re-emit restyles all CSS users),
  plus `terminal.setFont(...)` / editor font re-apply on the signal.
- [ ] **Theme follows appearance** — load the quilx theme **family** (it already
  has light + dark variants) and select the variant from `StyleManager.getDark()`;
  re-pick + re-emit a `theme:changed` on appearance change. Gate on
  `core.followSystemColorScheme`; when off, keep the user's chosen variant.
  Requires `theme` to become swappable (today it's a frozen `export const`) —
  a `theme:changed` event the chrome/pickers/syntax subscribe to (mirrors how
  `notify::dark` already drives the editor scheme).
- [ ] **Restyle on theme change** — the chrome styles (`AppWindow.applyChromeStyles`,
  already keyed/replaceable), picker highlight color, syntax controller, and
  diagnostics colors re-apply from the new palette.
- [ ] **Wire `core.followSystemColorScheme`** — when false, ignore OS appearance
  and hold the configured variant; when true (default), follow it.

## Notes / decisions

- Prefer driving as much as possible through **CSS variables + a single
  `Gtk.CssProvider` reload** (see `src/styles.ts`, which already supports keyed,
  replaceable stylesheets) so one re-emit updates every CSS consumer, rather than
  per-widget imperative re-styling. Colors baked into Pango markup at row-build
  time (picker highlight) can't be CSS vars — those callers must rebuild on the
  signal instead.
- The editor already proves the pattern (`notify::dark` → re-apply). Generalize
  it rather than scattering per-widget subscriptions.
