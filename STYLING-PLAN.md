# Adwaita styling migration — plan & findings

A plan to make zym's theming follow **libadwaita's design language** (its CSS
variables) instead of our own bespoke palette, plus the reusable scaffolding that
was built and kept for it. The original full migration was **not** landed: the
invasive consumer/CSS/theme-JSON changes were reverted, and only the self-contained,
dormant bridge below remains in the tree. This document is the handoff for picking it
up again.

See also `docs/styling.md` (current `--t-ui-*` token model) and `docs/theming.md`
(owned theme format). Those still describe the **current** bespoke model, which is
what ships today.

> **Status — pick up at [Handoff](#handoff--current-status-pick-up-here) (end of doc).**
> The resolver mechanism is now **validated** (probe + `gtk_widget_get_color`, not
> `lookup_color`) and work is mid-flight in a worktree (uncommitted): doc corrections
> landed here, a Slice-5 CSS migration is half-done, and three code tasks + the
> resolver swap remain. The Handoff section has the validated design, the WIP state,
> and the exact next steps.

## Goal

- Chrome colors (surfaces, borders, status, accent, shadows, selection) come from
  **libadwaita** at runtime, so zym tracks the system light/dark Adwaita theme.
- The theme **JSON on disk** carries only what Adwaita can't express: editor **syntax**
  highlighting plus editor-domain tints (`search` / `diff` / `flash` / `pr`).
- The runtime **`theme` object** stays the single source consumers read (plain
  property access); chrome fields are filled at load by resolving Adwaita's variables.
- On-disk theme format mirrors the runtime `Theme` object 1:1 — every field optional;
  omitted chrome is filled from Adwaita.

## What's in the tree now (the kept, reusable scaffolding)

All of this is **dormant** — nothing in the app imports the bridge, so it changes no
rendering. It is the mechanism only; the migration that would wire it up was reverted.

- **`src/theme/cssColor.ts`** — the bridge. Resolves a CSS-variable color name
  (`--accent-color`, `--error-color`, …) to a concrete `#rrggbb[aa]` string for the
  consumers that *can't* read CSS: Pango markup (`<span foreground=…>`), `GtkTextTag`,
  draw-func colors, and the GtkSourceView scheme XML. Exports:
  - `lookupCSSColor(theme, name)` — resolve a color name. Three layers:
    1. **app registry** (`APP_COLORS`) — our first-class tokens libadwaita lacks
       (`--info-*`, `--hint-*`).
    2. **GTK named-color registry** via `StyleContext.lookup_color` — reads
       libadwaita's `@define-color` names (underscore form: `accent_color`), which
       libadwaita keeps alongside its CSS variables. Deprecated in GTK4 and limited:
       it can't evaluate CSS-only colors like `--border-color`. The resolver should
       move to a probe + `gtk_widget_get_color` (see Key findings).
    3. **static fallback** (`FALLBACK_COLORS`) — for headless / no-display runs.
    Scheme comes from `theme.appearance`; cached by `scheme:name`. No `Gdk.RGBA` or
    `color-bits` leaks — everything is `#rrggbb[aa]` strings end to end.
  - `lookupCSSColorAlpha(theme, name, factor)` — same, scaling alpha (the non-CSS
    analogue of CSS `alpha(var(--…), f)`).
  - `gdkRgbaToString(rgba)` — the single `Gdk.RGBA` → string boundary.
- **`src/theme/theme.ts`** — the color tables the bridge reads (design-language
  knowledge lives with the other design tokens):
  - `APP_COLORS` — `--info-*` / `--hint-*` (`-color`/`-bg-color`/`-fg-color` triplets,
    light + dark) — the semantic tokens libadwaita has no variable for.
  - `FALLBACK_COLORS` — a static snapshot of the libadwaita colors we map onto, per
    scheme, for headless / no-display runs. **Incomplete for the loader-fills model:**
    it carries the standalone `--{success,warning,error}-color` but not the `-bg-color`
    / `-fg-color` pairs (nor any `--destructive-*`) the `filled` states need, and its
    dark `--card-bg-color` (`#36363a`) disagrees with libadwaita's translucent
    `rgb(255 255 255 / 8%)` (≈ `#ffffff14`). Fill the triplets and fix the card value
    before Slice 1 / Slice 4.
  - `appColorVariables(scheme)` — emits `APP_COLORS` as CSS declarations (the CSS-side
    half of the bridge). **Not wired into any stylesheet** in the current tree.
  - `export type Scheme = 'light' | 'dark'`.
- **`src/theme/cssColor.test.ts`** — headless tests for the display-free layers
  (app-registry resolution, static fallback, `gdkRgbaToString`).
- **`src/poc/adwaita-probe.ts`** — the validation probe (see below). Standalone; not
  imported by the app.

## Key findings

The non-CSS sinks need to resolve a CSS color to a concrete `#rrggbb[aa]`. Two mechanisms
exist; **prefer the probe** (runtime is GTK 4.22 / libadwaita 1.9.1):

- **Probe widget + `gtk_widget_get_color()`** (GTK ≥ 4.10, non-deprecated) — style a probe
  with `color: var(--X)` and read back the resolved color via `widget.getColor()`. This
  runs GTK's full CSS engine, so it resolves **everything**: `var()`, `color-mix()`,
  `alpha()`, `shade()`, the CSS-only `--border-color`, and the named accent palette
  (`--accent-blue …`). The GIR flags this as the replacement for the deprecated APIs.
  Returns one color (the `color` property) per probe, so use one tiny `Gtk.Label` per
  variable. **Validated on GTK 4.22 (see Handoff):** a *fresh, unrooted* label resolves
  synchronously against the display's providers — no window / realize / present needed —
  but a *reused* label freezes at the scheme it first computed, so create a fresh label
  per resolve (the `scheme:name` cache then handles light/dark flips). Headless (no
  display) falls through to `FALLBACK_COLORS`.
- **`StyleContext.lookup_color`** (what `cssColor.ts` does today) — reads only libadwaita's
  `@define-color` registry, **can't evaluate `var()` / `color-mix()`**, and is deprecated
  in GTK4. It misses `--border-color` and the named accent palette, and resolves fewer
  names over time as libadwaita migrates colors from `@define-color` to CSS-variable-only.
  A legacy path; swap it for the probe.

Facts that hold for either resolver:

- `--border-color` = `color-mix(in srgb, currentColor var(--border-opacity), transparent)`;
  `--border-opacity` is 15% (regular) / 50% (high contrast). The probe resolves it; a
  non-CSS hard-code (window-fg @ 15%) ignores high-contrast mode.
- the named accent palette (`--accent-blue …`) equals the numbered palette (`--blue-3 …`).
- opacity / radius vars (`--dim-opacity` 55% / 90% HC, `--window-radius` 15px, …) are not
  colors — read them in CSS directly (the probe only returns a color).

GTK CSS reads all Adwaita variables natively (`var()`, `alpha(var(--x), f)`, `mix(...)`,
`shade(...)`), so the CSS side never needs the bridge — it's only for the non-CSS sinks.

## Token → Adwaita mapping reference

| our token | Adwaita | notes |
| --- | --- | --- |
| `editor.foreground` / `background` | `--view-fg-color` / `--view-bg-color` | Slice 5 |
| `editor.lineNumber` | `--view-fg-color @ --dim-opacity` | derive |
| `text.muted` | `--window-fg-color @ --dim-opacity` / `.dimmed` / Pango `alpha="55%"` | native idiom; `--dim-opacity` is 55% / 90% HC (`.dim-label` is deprecated since 1.7 — use `.dimmed`) |
| `text.accent` | `--accent-color` | Slice 2 |
| `border` | `--border-color` (CSS, or probe `get_color`) | probe resolves the `color-mix`; `--border-opacity` 15% / 50% HC. Slice 3 |
| `shadow` | `--shade-color` (generic) — or the per-context shade: `--{card,popover,headerbar,sidebar}-shade-color` | libadwaita has no dedicated drop-shadow var; `--shade-color` is transparent black for separators/undershoots. Slice 4 |
| `surface.popover` | `--popover-bg-color` (floating) / `--card-bg-color` (cards) | per-context |
| `surface.selected` | `alpha(var(--accent-bg-color), 0.25)` (focused) / `0.1` (unfocused) | Slice 4 |
| `status.{success,warning,error}` | `--{success,warning,error}-color` | Slice 1 |
| `status.info` / `hint` | `APP_COLORS` `--info-*` / `--hint-*` (first-class, ours) | Slice 1 |
| `search` / `diff` / `flash` / `pr` / `syntax` | — no Adwaita equivalent — | **keep in theme JSON** |

Selection-background idiom (from `LocationList`): unfocused row
`alpha(var(--accent-bg-color), 0.1)`, focused (`:focus-within`)
`alpha(var(--accent-bg-color), 0.25)`. Tool status (warning/error) is best expressed
with Adwaita's semantic style classes (`.warning` / `.error`) rather than inline color.

## The architecture (decided, not yet built): loader fills `theme`

Consumers must **not** call `lookupCSSColor(theme, …)` directly. Instead the **loader
fills concrete values into `theme`** and consumers read plain properties. Two confirmed
decisions:

1. **Live, rebuilt post-display.** The loader fills via the bridge; a `refillTheme()`
   re-resolves in place once the display exists and on `Adw.StyleManager::notify::dark`.
2. The on-disk `ui` block mirrors the runtime `Theme.ui` 1:1; every field optional;
   omitted chrome filled from Adwaita.

Reify `theme.ui.state` as a `Record<StateName, SemanticState>`:

```ts
type StateName = 'accent' | 'success' | 'warning' | 'error' | 'info' | 'hint' | 'destructive';
interface SemanticState {
  flat:   { foreground: string; background: string };  // standalone; bg = 'transparent'
  filled: { foreground: string; background: string };
}
// theme.ui.state: Record<StateName, SemanticState>
```

Filled at load by resolving Adwaita vars:

| field | source (CSS var) |
| --- | --- |
| `state.error.flat.foreground` | `--error-color` |
| `state.error.flat.background` | `transparent` |
| `state.error.filled.foreground` | `--error-fg-color` |
| `state.error.filled.background` | `--error-bg-color` |

(Same pattern for the other states; `info`/`hint` resolve from `APP_COLORS`, the rest
from libadwaita. Note `--warning-fg-color` is dark — `rgb(0 0 0 / 80%)`, both schemes —
not white like the others, so `state.warning.filled.foreground` is near-black.)
`text.accent` becomes `state.accent.flat.foreground`; `status.*` becomes `state.*`. Surfaces come back as resolved runtime fields (not in JSON):
`theme.ui.surface.popover` ← `--popover-bg-color`, `surface.selected` ←
`--accent-bg-color @ 25%`.

### Loader plan (`src/theme/theme.ts`)

- Make `lookupCSSColor` callable with just `(scheme, name)` (the loader is mid-build and
  has no full `theme`). **Watch the import cycle** `theme.ts` ↔ `cssColor.ts` (cssColor
  imports `APP_COLORS`/`FALLBACK_COLORS`/`Scheme` from theme.ts): ES live-bindings make a
  function-only cycle safe, but the team avoids cycles — consider a third tiny module
  (`adwaitaColors.ts`) imported by both, or merge the resolver into theme.ts.
- Build `theme.ui.state` + resolved `theme.ui.surface.*` (+ later `editor`, `border`,
  `text`) by resolving Adwaita vars; deep-merge on-disk overrides over them.
- `refillTheme()` mutates the existing `theme` object in place, so render-time readers
  see live values.

### Liveness caveat

`const C = theme.ui.state.error.flat.foreground` at module-init captures the *string*; a
later `refillTheme()` won't update it. Many consumers are module-init consts. To make
them live, **defer the `AppWindow` import into `onActivate`** so UI-module consts
evaluate *after* the first post-display refill (do that first refill in `onActivate`
before constructing AppWindow). Without this, "live" only covers render-time reads — a
pre-existing limitation (the theme was always load-constant), so not a regression.

## Migration slices (incremental; the order chosen previously)

Each slice: migrate CSS + non-CSS consumers → fill the value in `theme` at load → delete
the on-disk/schema field if chrome-owned → `tsc` (it enumerates missed consumers) → test
→ runtime-smoke → commit.

- **Slice 1 — status** (`status.{success,warning,error,info,hint}`). CSS →
  `var(--{success,warning,error}-color)` / `var(--info-color)`; non-CSS →
  `state.*`. Diff tints derive from Adwaita success/error per scheme.
- **Slice 2 — accent + muted** (`text.accent`, `text.muted`). accent → `state.accent`;
  muted → native idiom (CSS `opacity: var(--dim-opacity)` / `.dimmed`; Pango
  `alpha="55%"`; tag/draw sinks resolve `--window-fg-color @ dim-opacity` at load).
- **Slice 3 — border** (`border`). CSS → `var(--border-color)`; non-CSS → resolve
  `--border-color` via the probe (`get_color` evaluates the `color-mix`). A hard-coded
  fallback (window-fg @ `--border-opacity`, 15% / 50% HC) ignores high-contrast mode, so
  prefer the probe. `lookup_color` can't resolve `--border-color` at all.
- **Slice 4 — surfaces + shadow** (`surface.{popover,selected}`, `shadow`). CSS →
  `var(--popover-bg-color)` / `var(--card-bg-color)` /
  `alpha(var(--accent-bg-color), 0.25)` / `var(--shade-color)`.
- **Slice 5 — editor** (`editor.{foreground,background,lineNumber}`) → `--view-fg-color`
  / `--view-bg-color` / `--view-fg-color @ dim`. **Riskiest:** reworks
  `createSourceScheme.ts` + the `followSystemScheme` logic. After this the theme JSON
  retains only `syntax` + `search`/`diff`/`flash`/`pr`.
- **Final** — update `docs/styling.md` + `docs/theming.md` (reduced token set, the
  `theme.ui.state` model, the bridge); verify against system Adwaita **light AND dark**;
  remove `src/poc/adwaita-probe.ts`.

> Build everything on the loader-fills model from the start: consumers read `theme.*`
> (filled at load), never call the resolver directly.

## Gotchas

- **`tsc` is the completeness check.** Deleting a `ThemeUi` field makes the compiler list
  every remaining consumer. CSS-string consumers (`var(--t-ui-…)` in template literals)
  are **not** type-checked — grep for them: `rg 't-ui-<token>' src --type ts`.
- **Probe scheme-tracking (settled by the spike):** a *reused* `Gtk.Label` freezes at the
  scheme it first computed and does NOT update on `Adw.StyleManager::notify::dark`; a
  *freshly-created* label reads the current scheme synchronously. So the resolver must
  build a new label per resolve, and `refillTheme` re-resolves under fresh `scheme:name`
  cache keys. `realize()` without `present()` fails in a nested/headless session (no frame
  clock) — the bare-label path sidesteps it entirely. See Handoff for the design.
- libadwaita real vars include `--popover-bg-color`, `--card-bg-color`, `--shade-color`,
  `--accent-bg-color`, `--{success,warning,error}-color`. `--info-color` / `--hint-color`
  are **ours** (emitted via `appColorVariables`).
- Commands per the worktree's tooling: typecheck `node_modules/.bin/tsc --noEmit`; tests
  `node --test 'src/theme/*.test.ts'` (glob form — a *directory* run hits a harmless
  node-gtk at-exit SIGSEGV); lint `node_modules/.bin/eslint <files>`.
- Leak / GC behavior is **not observable under `node --test`** — WeakRef-style leak
  checks need the live app / CDP, not the unit harness.

## Handoff / current status (pick up here)

Mid-flight in worktree `chore/styling-plan-review` (`/home/romgrk/src/zym-styling-plan-review`),
**all uncommitted**. The resolver mechanism was validated against live libadwaita 1.9.1 /
GTK 4.22 via throwaway spikes (now deleted); findings are baked in below.

### Validated resolver (replaces `cssColor.ts` layer 2)

Resolve a CSS color via a probe widget's computed `color`, NOT `lookup_color`. A **fresh,
unrooted** `Gtk.Label` resolves synchronously against the display's CSS providers — it runs
the full engine, so `--border-color` (`color-mix`), the named palette (`--accent-blue`),
surfaces, everything resolves. A *reused* label freezes at its first scheme, so build one
per resolve. Spike-confirmed values: `--border-color` dark `#ffffff26` / light `#0000061f`
(light folds in the 80%-alpha `currentColor`), `--accent-blue` `#3584e4`, `--card-bg-color`
dark `#ffffff14`, `--warning-fg-color` `#000000cc`, `--view-bg-color` dark `#1d1d20` / light
`#ffffff`. Sketch:

```ts
let display: InstanceType<typeof Gdk.Display> | null = null;
let probeProvider: InstanceType<typeof Gtk.CssProvider> | null = null;
const probeIds = new Map<string, string>(); // cssName -> probe element id

function probeResolve(name: string): string | null {
  display ??= Gdk.Display.getDefault();
  if (!display) return null;                 // headless → caller falls through to FALLBACK
  let id = probeIds.get(name);
  if (id === undefined) {
    id = 'zymColorProbe_' + name.replace(/^--/, '').replace(/[^a-z0-9]/gi, '_');
    probeIds.set(name, id);
    if (!probeProvider) {
      probeProvider = new Gtk.CssProvider();
      Gtk.StyleContext.addProviderForDisplay(display, probeProvider, Gtk.STYLE_PROVIDER_PRIORITY_USER);
    }
    probeProvider.loadFromString([...probeIds].map(([n, i]) => `#${i} { color: var(${n}); }`).join('\n'));
  }
  const label = new Gtk.Label();             // FRESH per resolve — tracks the live scheme
  label.setName(id);
  const rgba = label.getColor();             // node-gtk returns the out GdkRGBA directly
  return rgba ? gdkRgbaToString(rgba) : null;
}
```

Keep layer 1 (`APP_COLORS`) and layer 3 (`FALLBACK_COLORS`); drop the `lookup_color` /
`styleContext` machinery; update the module header. `cssColor.test.ts` covers layers 1+3
only and should still pass (layer 2 needs a display).

### WIP in the tree (the user's Slice-5-in-CSS, half-done)

`var(--t-ui-editor-background)` → `var(--view-bg-color)` (and some `--t-ui-editor-foreground`
→ `--view-fg-color`) across: `markdown-render.ts`, `AgentConversation.ts`, `AgentLauncher.ts`,
`CompletionPopup.ts`, `LocationBar.ts`, `TextEditor.ts`, `WorkbenchList.ts`, `MarkdownView.ts`.
Resolve before committing:

- **Inconsistent pairs:** several places switched `background` to `--view-bg-color` but left
  `color: var(--t-ui-editor-foreground)`. Decide whether to also move fg → `--view-fg-color`
  (TextEditor's carets already did).
- **`CompletionPopup.ts`:** dropped the `POPUP_BG` / `SELECTED_BG` consts + the `row:selected`
  background + the icon color (now `opacity: 0.4`). `DETAIL_COLOR` (and maybe the `theme`
  import) is likely now unused → **will fail typecheck**; remove it or re-use it. Confirm the
  removed selected-row background is intended (relying on libadwaita's default selection).
- **Two accidental comment regressions** (find-replace collateral — the code is unaffected,
  the comments now lie): `src/theme/theme.ts` (`themeUiCssVariables` doc-comment example) and
  `src/styles.ts` (~line 170) both rewrote a `--t-ui-editor-background` *example* to
  `--view-bg-color`, but `themeUiCssVariables` still emits `--t-ui-…`. **Revert both.**

### Next steps

1. **`.dim-label` → `.dimmed`** (libadwaita ≥ 1.7; runtime is 1.9.1): `docs/styling.md` (the
   "libadwaita's `.dim-label` class" mention) + `GitPanel.ts:373`, `NotificationLog.ts:68` &
   `:74`, `NotificationToasts.ts:146`.
2. **`FALLBACK_COLORS` (`theme.ts`):** add the `filled` triplets and fix the card value —
   `--success-bg-color` L `#2ec27e` / D `#26a269`, `--success-fg-color` `#ffffff`;
   `--warning-bg-color` L `#e5a50a` / D `#cd9309`, `--warning-fg-color` `#000000cc`;
   `--error-bg-color` L `#e01b24` / D `#c01c28`, `--error-fg-color` `#ffffff`;
   `--destructive-color` L `#c30000` / D `#ff938c`, `--destructive-bg-color` L `#e01b24` /
   D `#c01c28`, `--destructive-fg-color` `#ffffff`; and **`--card-bg-color` dark
   `#36363a` → `#ffffff14`**.
3. **`cssColor.ts`:** swap layer 2 to the probe resolver above; update header comment.
4. `pnpm run typecheck` + `node --test 'src/theme/*.test.ts'`.
5. Resolve the WIP issues above; revert the two comment regressions.
6. **Cleanup:** delete any leftover `src/poc/_getcolor_*.mjs` spike files.
7. Commit everything; merge `chore/styling-plan-review` into `master` `--ff-only`; remove the
   worktree + delete the branch.
