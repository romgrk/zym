# Theming

How a zym theme is authored, loaded, and consumed. The format is **ours**
— a schema we own (`src/theme/theme.schema.json`). The loader
(`src/theme/theme.ts`) is the single boundary: it reads a theme file and
resolves it into the internal `Theme` shape every consumer reads via
`theme.ui.*` / `theme.syntax.*`. Nothing outside `src/theme/` knows the
on-disk format.

See also [styling.md](styling.md) (how components consume `theme.ui` tokens)
and [system-integration.md](system-integration.md) (following the OS
light/dark preference — the remaining gap).

Every `theme.ui.*` token is also exported as a CSS variable
(`themeUiCssVariables` in `theme.ts` → `--t-ui-<dashed-path>`, installed on
`#AppWindow` by `src/styles.ts`), so CSS reads a theme color as
`var(--t-ui-editor-background)` rather than interpolating the literal. The
when-to-use-which rule (CSS variable vs. `theme.ui.*` in markup / tags / keyed
sheets) lives in [styling.md](styling.md) → Colors.

## The file format

One theme per file, `src/theme/<name>.json`, loaded by name
(`loadTheme('zym')`). Shape:

```jsonc
{
  "$schema": "./theme.schema.json",
  "name": "zym",
  "appearance": "dark",          // light | dark
  "ui": {                        // concern-grouped nested colors (mirrors ThemeUi 1:1)
    "editor": { "foreground": "#f1f1f1", "background": "#2d2d2d", "lineNumber": "#888888" },
    "view":   { "fg": "--view-fg-color", "bg": "--view-bg-color" }, // Adwaita vars → resolved to RGB at load
    "card":   { "fg": "--card-fg-color", "bg": "--card-bg-color" }, // ditto
    "text":   { "muted": "#5b6268", "accent": "#c678dd" },
    "border": "#434346",
    "surface":{ "popover": "#383838", "selected": "#3f4b5b" },
    "status": { "success": "#98be65", "warning": "#ecbe7b", "error": "#ff6c6b", "info": "#51afef", "hint": "#4db5bd" },
    "search": { "match": "#e5a50a26", "matchCurrent": "#e5a50a59" },
    "diff":   { "added": "…", "addedWord": "…", "removed": "…", "removedWord": "…", "filler": "…", "fold": "…" },
    "flash":  "…",
    "pr":     { "open": "…", "merged": "…", "closed": "…" }
  },
  "syntax": { /* capture name → { color, bold?, italic?, scale?, … } */ }
}
```

The defining property: **`ui` mirrors the consumed `ThemeUi` shape 1:1**, so a
theme JSON's `ui.editor.background` is read in code as exactly
`theme.ui.editor.background`. The model is the JSON.

- **`appearance`** drives two things: the diff-tint derivation (dark
  *darkens* the status accents into recessed bands, light *lightens* them
  into pale ones — see `diffTones`) and, for a theme that omits
  `editor.background`, which system scheme the editor follows.
- **`ui`** — concern-grouped nested objects. Every field is optional and
  deep-merged over `DEFAULT_THEME.ui`. Values are CSS colors
  (`#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa` or `rgb()/rgba()`); `#rrggbbaa` for
  tints that compose over text (search/diff/flash). A value may also be an
  **Adwaita CSS-variable reference** (`--view-bg-color`, `--card-bg-color`, …),
  which the loader resolves to a concrete RGB color at load (via the
  `cssColor` bridge → `lookupCSSColor`) so non-CSS consumers get a literal —
  this is how `view.{fg,bg}` / `card.{fg,bg}` default to `--view-{fg,bg}-color`
  / `--card-{fg,bg}-color`. The dual cases
  use a camelCase sibling rather than a node that's both a leaf and a branch:
  `search.matchCurrent` (not `match.current`), `diff.addedWord` /
  `diff.removedWord`.
- **`syntax`** — tree-sitter capture name → a `color` plus optional
  per-capture font style
  (`bold`/`italic`/`underline`/`strikethrough`/`scale`/`background`/
  `lineBackground`). The loader splits each token into the internal
  `SyntaxColors` (color) and `SyntaxStyles` (style) maps.

The JSON Schema gives editors autocomplete + validation; it enumerates the
`ui` concern groups with descriptions and the syntax-token shape.

## How defaults work (`DEFAULT_THEME` + deep-merge)

`DEFAULT_THEME` (exported from `theme.ts`) is a **complete dark `Theme`** of
concrete RGB colors — no CSS variables, so any value is safe to interpolate
into Pango markup as well as CSS. Its `ui` is the merge base: the loader
deep-merges a theme file's `ui` over `DEFAULT_THEME.ui`, concern by concern,
so a theme only states what it overrides (a sibling left out keeps its
default). **The guarantee: every `theme.ui.*` field is always filled** —
consumers read them directly, never `?? fallback`. `DEFAULT_THEME` itself is
exported as a ready-to-use last-resort theme.

`editor.background` is the one field a theme may omit. Its absence does
**not** leave it undefined — the loader fills it (with `surface.popover`) and
records the omission as **`theme.followSystemScheme: true`**, the signal that
the editor should follow the system light/dark Adwaita scheme instead of a
theme-owned GtkSourceView scheme (read by
`TextEditor.followSystemColorScheme` / `createSourceScheme`).

Two within-concern fallbacks are kept explicitly (they're genuinely useful):
set only `search.match` and `matchCurrent` inherits it; set only `diff.added`
and `diff.addedWord` inherits the line. (`syntax` captures resolve by the
dotted longest-prefix `resolveByCaptureName`.)

## Resolution at load (`adaptTheme`)

`loadTheme(name)` → `adaptTheme(file)` does, in order:

1. **Validate** `appearance` ∈ {light, dark} (throws otherwise).
2. **Deep-merge** each `ui` concern over `DEFAULT_THEME.ui`
   (`{ ...DEFAULT_THEME.ui.status, ...file.ui.status }`, etc.).
   `editor.background` absent ⇒ filled with `surface.popover` and
   `followSystemScheme = true` (follow the system scheme).
3. **Derive the diff tints** from the resolved `status.success` /
   `status.error` per `appearance` (`diffTones`, using `color-bits`). An
   explicit `diff.*` value wins; `diff.addedWord`/`diff.removedWord` fall back
   to their line value.
4. **Split syntax tokens** into `syntax` (color, **key order preserved** — it
   drives GtkTextTag priority) and `syntaxStyle` (the style fields).
5. **`applyMarkupDefaults`** — fill `markup.*` colors/styles (headings bold +
   scaled, emphasis italic, code backgrounds) the theme doesn't define,
   reusing the loaded palette.

`adaptTheme` is exported so tests can feed synthetic theme objects
(`src/theme/theme.test.ts`).

## Diff tints

The diff line/word backgrounds are **not** authored per-theme by default —
they're derived so they always track the theme's success/error hue.
`diffTones` mutes the accent toward the editor (darken for dark themes,
lighten for light) and applies alpha; the word tint is less muted + more
opaque so changed words stand out within the line, kept calm enough that
diffed comments stay readable. Consumed by `TextDecorations`
(`theme.ui.diff.added` etc.). A theme can still override any `diff.*` value
explicitly.

## What's still Zed-derived (out of scope)

The theme *format* is fully ours. The tree-sitter **highlight queries**
(`*.scm`, vendored under each plugin's `queries/`) are still vendored from Zed
(GPL-3.0) and emit **Zed's capture names** — which is why `syntax` keys
(`string.escape`, `markup.heading.1`, …) use that vocabulary. Replacing that
is a separate, much larger effort (re-authoring highlight queries) and is not
part of owning the theme format.

## Future work

- **A light theme** — author `zym-light.json` (`appearance: "light"`) to
  exercise the lighten path and unblock OS light/dark following (see
  [system-integration.md](system-integration.md) → "Theme follows
  appearance").
- **Swappable active theme** — `theme` is a frozen `export const` today; a
  `theme:changed` event + re-emit of keyed stylesheets is the prerequisite
  for live theme switching and OS-appearance following.
- **Color-drift lint guardrail** — fail CI on a hex/`rgb()` literal outside
  `src/theme/**` so colors can't creep back inline (allowlist the known
  exceptions). Tracked in [system-integration.md](system-integration.md).
