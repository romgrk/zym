# Theming

How a quilx theme is authored, loaded, and consumed. The format is **ours** — a
schema we own (`src/theme/theme.schema.json`), no longer Zed's. The loader
(`src/theme/theme.ts`) is the single boundary: it reads a theme file and resolves
it into the internal `Theme` shape every consumer reads via `theme.ui.*` /
`theme.syntax.*`. Nothing outside `src/theme/` knows the on-disk format.

See also [styling.md](styling.md) (how components consume `theme.ui` tokens) and
[system-integration.md](system-integration.md) (following the OS light/dark
preference — the remaining gap).

## The file format

One theme per file, `src/theme/<name>.json`, loaded by name
(`loadTheme('quilx')`). Shape:

```jsonc
{
  "$schema": "./theme.schema.json",
  "name": "quilx",
  "appearance": "dark",          // light | dark
  "ui": {                        // concern-grouped nested colors (mirrors ThemeUi 1:1)
    "editor": { "foreground": "#f1f1f1", "background": "#2d2d2d", "lineNumber": "#888888" },
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

- **`appearance`** drives two things: the diff-tint derivation (dark *darkens* the
  status accents into recessed bands, light *lightens* them into pale ones — see
  `diffTones`) and, for a theme that omits `editor.background`, which system scheme
  the editor follows.
- **`ui`** — concern-grouped nested objects. Every field is optional and
  deep-merged over `DEFAULT_THEME_UI`. Values are CSS colors
  (`#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa` or `rgb()/rgba()`); `#rrggbbaa` for tints
  that compose over text (search/diff/flash). The dual cases use a camelCase
  sibling rather than a node that's both a leaf and a branch: `search.matchCurrent`
  (not `match.current`), `diff.addedWord` / `diff.removedWord`.
- **`syntax`** — tree-sitter capture name → a `color` plus optional per-capture
  font style (`bold`/`italic`/`underline`/`strikethrough`/`scale`/`background`/
  `lineBackground`). The loader splits each token into the internal `SyntaxColors`
  (color) and `SyntaxStyles` (style) maps.

The JSON Schema gives editors autocomplete + validation; it enumerates the `ui`
concern groups with descriptions and the syntax-token shape.

## How defaults work (`DEFAULT_THEME_UI` + deep-merge)

`DEFAULT_THEME_UI` (in `theme.ts`) is a **complete dark `ThemeUi`** structured exactly
like a theme file's `ui` — the built-in fallback theme. The loader deep-merges a
theme file's `ui` over it, concern by concern, so a theme only states what it
overrides (a sibling left out keeps its default). `editor.background` is the one
field with no default — its absence is the signal to follow the system scheme.

Two within-concern fallbacks are kept explicitly (they're genuinely useful): set
only `search.match` and `matchCurrent` inherits it; set only `diff.added` and
`diff.addedWord` inherits the line. (`syntax` captures still resolve by the dotted
longest-prefix `resolveByCaptureName` — that's unchanged.)

## Resolution at load (`adaptTheme`)

`loadTheme(name)` → `adaptTheme(file)` does, in order:

1. **Validate** `appearance` ∈ {light, dark} (throws otherwise).
2. **Deep-merge** each `ui` concern over `DEFAULT_THEME_UI` (`{ ...DEFAULT_THEME_UI.status,
   ...file.ui.status }`, etc.). `editor.background` absent ⇒ undefined ⇒ follow the
   system scheme.
3. **Derive the diff tints** from the resolved `status.success` / `status.error`
   per `appearance` (`diffTones`, using `color-bits`). An explicit `diff.*` value
   wins; `diff.addedWord`/`diff.removedWord` fall back to their line value.
4. **Split syntax tokens** into `syntax` (color, **key order preserved** — it
   drives GtkTextTag priority) and `syntaxStyle` (the style fields).
5. **`applyMarkupDefaults`** — fill `markup.*` colors/styles (headings bold +
   scaled, emphasis italic, code backgrounds) the theme doesn't define, reusing
   the loaded palette.

`adaptTheme` is exported so tests can feed synthetic theme objects
(`src/theme/theme.test.ts`).

## Diff tints

The diff line/word backgrounds are **not** authored per-theme by default —
they're derived so they always track the theme's success/error hue. `diffTones`
mutes the accent toward the editor (darken for dark themes, lighten for light)
and applies alpha; the word tint is less muted + more opaque so changed words
stand out within the line, kept calm enough that diffed comments stay readable.
Consumed by `TextDecorations` (`theme.ui.diff.added` etc.). A theme can still
override any `diff.*` value explicitly.

## What's still Zed-derived (out of scope)

The theme *format* is fully ours. The tree-sitter **highlight queries**
(`*.scm`, vendored under each plugin's `queries/`) are still vendored from Zed
(GPL-3.0) and emit **Zed's capture names** — which is why `syntax` keys
(`string.escape`, `markup.heading.1`, …) use that vocabulary. Replacing that is a
separate, much larger effort (re-authoring highlight queries) and is not part of
owning the theme format.

## Status

- [x] **Own the theme format** — replaced the Zed theme-family adapter with a
  native loader + `theme.schema.json`. Per-capture `syntax` tokens (color + style),
  diff tints derived from `status.*`. Single shipped theme: `quilx.json` (dark).
  Loader unit-tested (`theme.test.ts`).
- [x] **Model mirrors the JSON** — `ThemeUi` is concern-grouped nested objects
  (`theme.ui.editor.background`, `theme.ui.status.error`, `theme.ui.diff.addedWord`)
  identical to the theme file's `ui`; `DEFAULT_THEME_UI` is a complete nested fallback
  theme the file deep-merges over.
- [ ] **A light theme** — author `quilx-light.json` (`appearance: "light"`) to
  exercise the lighten path and unblock OS light/dark following (see
  [system-integration.md](system-integration.md) → "Theme follows appearance").
- [ ] **Swappable active theme** — `theme` is a frozen `export const` today; a
  `theme:changed` event + re-emit of keyed stylesheets is the prerequisite for
  live theme switching and OS-appearance following.
- [ ] **Color-drift lint guardrail** — fail CI on a hex/`rgb()` literal outside
  `src/theme/**` so colors can't creep back inline (allowlist the known
  exceptions). Tracked in [system-integration.md](system-integration.md).
