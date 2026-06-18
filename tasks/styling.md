# Styling

How UI styling is done across the app, and the shared tokens components should
reuse so the chrome stays visually consistent.

## Mechanisms

Styling comes from two places, and which one you use depends on the widget:

- **GTK CSS** — installed via `addStyles(css)` (static, queued at module-init,
  flushed once by `installStyles()` after the display exists) or
  `styles.set(css, { key })` (dynamic/theme-derived, replaceable in place by key)
  from `src/styles.ts`. Selectors target a widget's `setName(...)` identity
  (`#WorkbenchStatus`) and CSS classes (`.quilx-status-count`). Default for
  component look. Plugin stylesheets use `styles.addRemovable(css)`, which returns
  a `Disposable` for teardown on deactivation.
- **Pango markup** — inline `<span ...>` runs inside a single `Gtk.Label` with
  `useMarkup: true`. Used when one label mixes styles across its text — e.g. a
  full-size branch name with a smaller, coloured count after it
  (`GitBranchButton`), or an icon-font glyph beside normal text
  (`WorkbenchStatus`). CSS can't style a sub-run of a label; markup can.

## Shared CSS custom properties

Defined once on `window { … }` in `src/styles.ts` and inherited by every widget.
Prefer these over hard-coded literals so a change lands everywhere:

| Variable                  | Value     | Use                                                        |
| ------------------------- | --------- | ---------------------------------------------------------- |
| `--popover-radius`        | `15px`    | Corner radius for floating chrome (pickers, which-key, search bar). Stays rounded when maximised, unlike libadwaita's `--window-radius`. |
| `--popover-radius-small`  | `6px`     | Tighter radius for compact in-text chrome (completion popup). |
| `--font-size-small`       | `0.85em`  | Secondary text that sits beside full-size text — metadata, counts, list detail columns. |

libadwaita also exposes its own variables (`--border-color`, `--accent-color`,
`--window-bg-color`, `--popover-bg-color`, …) which we use directly; see
<https://gnome.pages.gitlab.gnome.org/libadwaita/doc/1-latest/css-variables.html>.

## Font sizes

There is **one** secondary-text size. Source it consistently:

- **CSS-styled widget** (its own label/box): apply a class with
  `font-size: var(--font-size-small)`. Example: the diagnostics counts in
  `WorkbenchStatus` (`.quilx-status-count`) and the per-row file count in
  `WorkbenchList`.
- **Inline sub-span** inside a larger markup label: use Pango `size="smaller"`
  (≈ 0.83×, the closest markup equivalent — markup can't read CSS variables).
  Example: the `+N/-M/↑/↓` counts in `GitBranchButton`, picker detail columns.

Both render at essentially the same size; the split exists only because the two
mechanisms can't share a literal. Don't introduce new ad-hoc sizes (`0.9em`,
`size="85%"`, …) — extend the table above with a named variable instead.

## Colors

Semantic UI colors come from the active theme via `theme.ui` (`src/theme/theme.ts`):
`fg`, `textMuted`, `textAccent`, `success`, `warning`, `error`, `info`, `hint`,
… Interpolate these into CSS/markup rather than hard-coding hex. These resolved
`theme.ui.*` fields are authored in the theme file under concern-first keys
(`status.error`, `search.match`, `diff.added`); the loader + format are documented
in [theming.md](theming.md). Severity
glyph+color pairs (diagnostics) come from `severityStyle()` in
`src/lsp/diagnostics/severity.ts`, the single source shared by the gutter and
squiggle (`DiagnosticsView`), the Diagnostics panel (`DiagnosticsPanel`), and the
status-bar counts (`WorkbenchStatus`).

## Icons

All icons are Nerd Font glyphs (bundled "Symbols Nerd Font Mono"), rendered as
text via `iconLabel()` / `Icons` in `src/ui/icons.ts` — never
`Gio.ThemedIcon` / `Gtk.Image(iconName)`. In Pango markup, set the icon font on
the span with `font_family="${ICON_FONT_FAMILY}"`. (Adw tab icons are the one
exception — the glyph is embedded in the tab title text.)

## Grouped buttons

Adjacent header controls that form one logical control are joined with the GTK
`.linked` class on their container `Gtk.Box` (spacing 0): `GithubButtons` (PR +
CI) and `WorkbenchStatus` (diagnostics + LSP).
