/*
 * Styles — a thin adapter over `node-gtk/styles` (the StyleManager, originally
 * extracted from this file and upstreamed). It owns CSS install + hot-reload; we
 * only re-export its singleton and name the two helpers the app uses. See
 * docs/styling.md → Hot-reload.
 *
 *  - `addStyles(css)` — static/component CSS, queued until the display exists and
 *    hot-reloaded by re-importing the calling module. Bound straight to
 *    `styles.add` (no wrapper frame) so node-gtk attributes the sheet to the
 *    component, not to this file.
 *  - `installStyles()` — flush queued styles and start the watcher; call once
 *    after activation (the display must exist).
 *
 * For dynamic, state-derived sheets pass a `() => string` render function to
 * `styles.add` and call the returned handle's `refresh()` when the state changes
 * (the font sheet in fonts.ts, the chrome sheet in chromeStyles.ts). For
 * programmatic sheets whose module can't be re-imported safely, pass
 * `{ watch: false }` (plugin styles in PluginContext.ts). See docs/styling.md.
 */
import { styles } from 'node-gtk/styles';
import { theme, themeUiCssVariables } from './theme/theme.ts';

export type { StyleSheet } from 'node-gtk/styles';
export { styles };

/** Queue static/component CSS; hot-reloaded by re-importing the calling module. */
export const addStyles = styles.add.bind(styles);

/** Install all queued static CSS into the default display + start the watcher.
 *  Call once after activation (the display must exist). */
export const installStyles = styles.install.bind(styles);

// App-wide UI custom properties, inherited by every widget under the window.
// `--popover-radius` is the corner radius for floating chrome (the picker,
// which-key, the editor search bar). It deliberately does NOT reuse
// libadwaita's `--window-radius`, which collapses to 0 when the window is
// fullscreen/maximised — these surfaces should stay rounded regardless.
// `--popover-radius-small` is the tighter radius for compact, in-text chrome
// (the autocompletion popup) that sits flush against the cursor.
// `--popover-shadow` is the drop shadow shared by the editor's in-text cards
// (autocompletion, LSP hover, signature help) so they read as one surface.
// `--card-radius` is the radius for bordered content cards that sit inside the
// content area (the agent input card, the diff comment box) — softer than a
// floating popover.
//
// `--selection-bg` / `--selection-bg-focus` are the shared row-like selection
// highlight, defined once so every list selection (git panels, the git log, the
// location list) and the focused option in a Question card read identically:
// the unfocused row gets a neutral translucent wash of its own foreground, the
// focused (`:focus-within`) row an accent tint.
//
// Font sizes are NOT defined here — they come from the font store (fonts.ts) as
// `--t-font-<role>-size-{small,large}` (role = `ui` | `monospace`). See docs/styling.md → Fonts.
addStyles(`
  window {
    --popover-radius: 15px;
    --popover-radius-small: 6px;
    --popover-shadow: 0px 6px 20px 8px var(--t-ui-shadow);
    --card-radius: 12px;
    --selection-bg: alpha(currentColor, 0.15);
    --selection-bg-focus: alpha(var(--accent-bg-color), 0.15);
  }
`);

// Active-theme color tokens as CSS variables, on `window` so they reach every top-level
// (the main window + its overlays/popovers/FloatingCards, and separate windows like the
// preferences editor). `themeUiCssVariables` splits them (see ADWAITA_ALIASES): the
// libadwaita-aliased surfaces are emitted under their `--…-color` name — and only when the
// theme defines them, so unset ones fall through to libadwaita and keep following the OS —
// while every custom token is emitted as `--t-ui-<path>` for our own widgets. (Markup /
// GtkTextTag consumers can't read CSS vars and still use `theme.ui.*` directly.) Static
// today because `theme` is load-constant; when live theme-switching lands this becomes a
// render function re-applied on theme change.
addStyles(`
  window {
    --t-spacing: ${theme.spacing}px;
    ${themeUiCssVariables(theme).replace(/\n/g, '\n    ')}
  }
`);
