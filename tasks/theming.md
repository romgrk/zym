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
  "ui":     { /* concern-first dotted color keys → color */ },
  "syntax": { /* capture name → { color, bold?, italic?, scale?, … } */ }
}
```

- **`appearance`** drives two things: the diff-tint derivation (dark *darkens* the
  status accents into recessed bands, light *lightens* them into pale ones — see
  `diffTones`) and, for a theme that omits `editor.background`, which system scheme
  the editor follows.
- **`ui`** — a flat map of **concern-first** dotted keys (`status.error`,
  `search.match`, `diff.added.word`). Values are CSS colors
  (`#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa` or `rgb()/rgba()`); `#rrggbbaa` for tints
  that compose over text (search/diff/flash).
- **`syntax`** — tree-sitter capture name → a `color` plus optional per-capture
  font style (`bold`/`italic`/`underline`/`strikethrough`/`scale`/`background`/
  `lineBackground`). The loader splits each token into the internal `SyntaxColors`
  (color) and `SyntaxStyles` (style) maps.

The JSON Schema gives editors autocomplete + validation; it enumerates the known
`ui` keys with descriptions and allows additional dotted keys for forward-compat.

## Why concern-first (and how fallback works)

`ui` keys resolve by **longest-prefix fallback**, reusing the exact
`resolveByCaptureName` the syntax map uses: `resolveUi('search.match.current')`
tries `search.match.current` → `search.match` → `search`, then the loader falls
back to a built-in default (`DEFAULT_UI`).

Concern-first (`diff.added`, not `background.diff.added`) is the deliberate choice
over primitive-first because it makes the fallback chain **semantically sound**:

- `search.match.current` → `search.match` → `search` → `DEFAULT_UI.searchMatchCurrent`
- `diff.added.word` → `diff.added` → `diff` → derived/`DEFAULT_UI`

The chain never leaves the concern, so an unset key lands on a **designed
default**, never a wrong primitive. Primitive-first would let
`background.searchMatch` fall back to `background` (the opaque editor bg → match
invisible) — concern-first can't. It also keeps the within-concern fallbacks that
are genuinely useful: set only `search.match` and the current match inherits it;
set only `diff.added` and the word tint inherits the line.

Tree-sitter capture names are themselves role/concern-first (`keyword.control`,
`markup.heading.1`), so this also makes `ui` and `syntax` resolve the same way.

## Resolution at load (`adaptTheme`)

`loadTheme(name)` → `adaptTheme(file)` does, in order:

1. **Validate** `appearance` ∈ {light, dark} (throws otherwise).
2. **Resolve each `UiColors` field** from the `ui` map via longest-prefix
   fallback, coalescing with `DEFAULT_UI`. `editor.background` is the one optional
   field — absent ⇒ `ui.bg` undefined ⇒ follow the system scheme.
3. **Derive the diff tints** from `status.success` / `status.error` per
   `appearance` (`diffTones`, using `color-bits`). An explicit `diff.*` key wins;
   `diff.added.word`/`diff.removed.word` fall back to their line key.
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
Consumed by `TextDecorations` (`theme.ui.diffAddedBg` etc.). A theme can still
override any `diff.*` key explicitly.

## What's still Zed-derived (out of scope)

The theme *format* is fully ours. The tree-sitter **highlight queries**
(`*.scm`, vendored under each plugin's `queries/`) are still vendored from Zed
(GPL-3.0) and emit **Zed's capture names** — which is why `syntax` keys
(`string.escape`, `markup.heading.1`, …) use that vocabulary. Replacing that is a
separate, much larger effort (re-authoring highlight queries) and is not part of
owning the theme format.

## Status

- [x] **Own the theme format** — replaced the Zed theme-family adapter with a
  native loader + `theme.schema.json`. Concern-first `ui` keys with
  longest-prefix fallback (shared `resolveByCaptureName`), per-capture `syntax`
  tokens (color + style), diff tints derived from `status.*`. Single shipped
  theme: `quilx.json` (dark). Loader unit-tested (`theme.test.ts`).
- [ ] **A light theme** — author `quilx-light.json` (`appearance: "light"`) to
  exercise the lighten path and unblock OS light/dark following (see
  [system-integration.md](system-integration.md) → "Theme follows appearance").
- [ ] **Swappable active theme** — `theme` is a frozen `export const` today; a
  `theme:changed` event + re-emit of keyed stylesheets is the prerequisite for
  live theme switching and OS-appearance following.
- [ ] **Color-drift lint guardrail** — fail CI on a hex/`rgb()` literal outside
  `src/theme/**` so colors can't creep back inline (allowlist the known
  exceptions). Tracked in [system-integration.md](system-integration.md).
