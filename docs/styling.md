# Styling

How UI styling is done across the app, and the shared tokens components
should reuse so the chrome stays visually consistent.

## Mechanisms

Two mechanisms, picked per widget:

- **GTK CSS** — the default for component look. Install via `addStyles(css)`
  (static), `styles.set(css, { key })` (theme-derived, replaceable), or
  `styles.addRemovable(css)` (plugins; returns a `Disposable`) — all from
  `src/styles.ts`. Selectors follow the convention below.
- **Pango markup** — inline `<span ...>` runs in one `Gtk.Label`
  (`useMarkup: true`), for a single label mixing styles across its text
  (`GitBranchButton`). CSS can't style a label sub-run; markup can.

## Selectors & classes

A component's styling identity is `setName('WidgetName')` → `#WidgetName`
(PascalCase, mirrors the file/class name). Everything hangs off that id;
**never prefix classes with `zym-`** — the id scope already namespaces
them. Four patterns, in preference order:

- **`#WidgetName`** — the component's own root; the primary hook for its
  look.
- **`#WidgetName tagName`** — a GTK-rendered sub-node by its CSS node name
  (`label`, `button`, `image`, `tabbar`, …), when the tag uniquely
  identifies it.
- **`#WidgetName .part`** — a sub-node a tag *can't* single out (a widget
  with several `label`s). Give it a short, unprefixed element class, scoped
  under the id: `#MultiBufferHeader .icon`, `#FileTree .header`.
- **`.is-…` / `.has-…`** — boolean state classes toggled at runtime, read
  off any of the above: `#Panel.is-active`, `#Picker.has-prompt`,
  `#Terminal .view.is-normal`. Adjectives only — no value-bearing classes
  (`.is-mode-normal`, not `.mode2`).

Reuse GTK/libadwaita's own utility classes directly (`flat`, `linked`,
`circular`, `dim-label`, `heading`, `activatable`, …); don't reinvent them
under our names.

## CSS variables, never legacy named colors

Always use modern CSS variables. Four families, all `var(--…)`:

- **libadwaita's** ([full
  catalog](https://gnome.pages.gitlab.gnome.org/libadwaita/doc/1-latest/css-variables.html)) —
  `--accent-bg-color`, `--window-bg-color`, `--border-color`, …
- **our shared chrome props** — `--popover-radius`, `--popover-radius-small`, …
  (below).
- **our theme color tokens** — `--t-ui-<dashed-path>`, one per `theme.ui.*`
  token (`--t-ui-editor-background`, `--t-ui-status-error`, …). See
  [Colors](#colors).
- **our font tokens** — `--t-font-monospace`, `--t-font-ui-family`, … from
  the font store. See [Fonts](#fonts-families).

**Never** the legacy GTK named-color syntax (`@theme_selected_bg_color`,
`@define-color`): those don't read `var()` and ignore theme overrides. Map
legacy → modern (`@theme_selected_bg_color` → `var(--accent-bg-color)`)
wherever you'd reach for one, including string fallbacks you interpolate.

## Shared CSS custom properties

Defined once on `window { … }` in `src/styles.ts` and inherited by every
widget. Prefer these over hard-coded literals so a change lands everywhere:

| Variable                  | Value     | Use                                                        |
| ------------------------- | --------- | ---------------------------------------------------------- |
| `--popover-radius`        | `15px`    | Corner radius for floating chrome (pickers, which-key, search bar). Stays rounded when maximised, unlike libadwaita's `--window-radius`. |
| `--popover-radius-small`  | `6px`     | Tighter radius for compact in-text chrome (completion popup). |

Font sizes are **not** here — they come from the font store (see [Fonts](#fonts-families)).

## Fonts (families)

The font store `src/fonts.ts` (`fonts`) is the single source of the app's
UI and monospace fonts. Each is the `core.uiFont` / `core.monospaceFont`
config value (a Pango description) when set, else the live GNOME interface
font — the store follows both. It publishes them as **reactive CSS
variables on `#AppWindow`** (re-set on every change). A root
`#AppWindow { font-family: var(--t-font-ui-family) }` baseline makes **all
UI text follow the UI font by inheritance** — so only monospace surfaces
need a rule.

The picked font supplies the **medium** size; **small** (×0.85) and
**large** (×1.2) are derived, rounded to the nearest half-point. Both
roles — `ui` and `monospace` — publish the **same full set**
(`<role>` = `ui` | `monospace`, `<size>` = `small` | `large`):

| Variable                                  | Use                                                              |
| ----------------------------------------- | --------------------------------------------------------------- |
| `--t-font-<role>`                         | The `font:` shorthand (style + weight + size + family) at the medium size. For surfaces that want the **whole** font: the editor, code, mono inputs. |
| `--t-font-<role>-<size>`                  | The `font:` shorthand at the small/large size — smaller secondary text, larger headings. |
| `--t-font-<role>-family`                  | Family only — when the selector sets its own weight/size (e.g. a bold leap mark that inherits the editor size). The root baseline uses `--t-font-ui-family`. |
| `--t-font-<role>-{weight,style}`          | The individual shared properties, for finer control. |
| `--t-font-<role>-size`, `--t-font-<role>-size-<size>` | The point size alone — medium, or the small/large step. |

Which form:

- **Whole font** (editor, code, mono inputs) →
  `font: var(--t-font-monospace)`. The shorthand **resets**
  weight/size/line-height — not where the selector sets its own. Use
  `var(--t-font-monospace-small)` / `-large` for a different size.
- **Family only** (keep own weight/size) →
  `font-family: var(--t-font-monospace-family)`.
- **Pango markup** (no CSS vars) → `fonts.monospaceFamily` /
  `fonts.uiFamily` for `face=` / `font_family=`.
- **Font-description widgets** (VTE) → `fonts.monospaceDescription()` +
  `fonts.onChange(...)`.

Never use GTK's `.monospace` class or `GtkTextView.setMonospace(true)` —
they pull the *system* monospace directly, bypassing the store.

## Font sizes

Sizes come from the font store (`src/fonts.ts`) as a small / medium / large
step per role — there is no separate size token. Reuse the role variables in
a **CSS-styled widget** (its own label/box):

- `font-size: var(--t-font-ui-size-small)` (or `-large`;
  `--t-font-monospace-size-*` for mono surfaces). Examples: the diagnostics
  counts in `WorkbenchStatus` (`.zym-status-count`) and the per-row file count
  in `WorkbenchList`.

The store always publishes these (a font description with no size of its own
falls back to a default point size — see `DEFAULT_FONT_SIZE_PT`), so they
resolve unconditionally. Don't introduce ad-hoc sizes — add a step to
`FONT_SIZE_SCALE` in `fonts.ts` if you need one.

## Colors

Semantic UI colors come from the active theme's `theme.ui`
(`src/theme/theme.ts`), a concern-grouped nested object:
`theme.ui.editor.foreground`, `theme.ui.text.muted`, `theme.ui.text.accent`,
`theme.ui.status.{success,warning,error,info,hint}`,
`theme.ui.surface.{popover,selected}`, … **Every `theme.ui.*` field is
guaranteed filled** (the loader deep-merges over `DEFAULT_THEME`), so read
them directly — no `?? fallback`. `theme.ui` mirrors the theme JSON's `ui`
1:1; the loader + format are documented in [theming.md](theming.md).

Each `theme.ui.*` token is **also a CSS variable** on the root `#AppWindow`,
named `--t-ui-<dashed-path>`: `theme.ui.editor.background` →
`var(--t-ui-editor-background)`, `theme.ui.search.matchCurrent` →
`var(--t-ui-search-match-current)` (camelCase keys dashed). They're
generated by `themeUiCssVariables` (`theme.ts`) and installed in
`src/styles.ts`, and resolve inside color functions too
(`alpha(var(--t-ui-surface-selected), 0.4)`, `mix(…)`, `shade(…)`). Which
form to use:

- **Static `addStyles` CSS** → `var(--t-ui-…)`. Don't interpolate
  `theme.ui.*` into a static stylesheet — the variable keeps the value in
  one place (and, once live theme-switching lands, updates without
  rebuilding the sheet).
- **Pango markup** (`<span foreground="…">`) → interpolate `theme.ui.*`
  directly; markup can't read CSS variables. Same for **GtkTextTag /
  draw-func colors** — those are JS values, not CSS.
- **The dynamic theme-chrome / notification keyed sheets** (`styles.set` in
  `AppWindow.ts`) interpolate concrete `theme.ui.*`; they're rebuilt per
  theme.

Severity glyph+color pairs (diagnostics) come from `severityStyle()` in
`src/lsp/diagnostics/severity.ts`, the single source shared by the gutter
and squiggle (`DiagnosticsView`), the Diagnostics panel (`DiagnosticsPanel`),
and the status-bar counts (`WorkbenchStatus`).

## Icons

All icons are Nerd Font glyphs (bundled "Symbols Nerd Font Mono"), rendered
as text via `iconLabel()` / `Icons` in `src/ui/icons.ts` — never
`Gio.ThemedIcon` / `Gtk.Image(iconName)`. In Pango markup, set the icon font
on the span with `font_family="${ICON_FONT_FAMILY}"`. (Adw tab icons are the
one exception — the glyph is embedded in the tab title text.)

Glyphs live in `src/ui/nerdfont.ts` (`NERDFONT`, a curated catalog grouped
by purpose); `Icons` are named UI roles aliased onto it. File-tree icons are
the separate `fileIcons.ts` table.

The one real-image exception is a **bundled symbolic SVG**: a monochrome
`*-symbolic.svg` shipped under `assets/`, turned into a recoloring `Gtk.Image`
by `symbolicImage(file, size)` (`icons.ts`). It loads as a `Gtk.IconPaintable`,
so GTK tints it to the widget's `color` like any symbolic icon — it follows the
theme and state classes (`.is-active`, …). Reserve it for art a glyph can't
supply (the empty-panel sleeping cat, `cat-sleeping-symbolic.svg`); still never
pull named icons from the *system* theme (`Gtk.Image(iconName)`).

## Keybinding badges

Render a keybinding as a chip with `keycap(keys)` (`src/ui/Keycap.ts`): a
monospace `.keycap` pill labelled with the binding in **canonical form** — the
keymap's keystroke string verbatim (`space f f`, `ctrl-w v`). Its border and
background derive from `currentColor`, so it adopts whatever text color its
context sets. Used by the empty-panel welcome cheatsheet.

## Grouped buttons

Adjacent header controls that form one logical control are joined with the
GTK `.linked` class on their container `Gtk.Box` (spacing 0): `GithubButtons`
(PR + CI) and `WorkbenchStatus` (diagnostics + LSP).
