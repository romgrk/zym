/*
 * cssColor — resolve a CSS-variable *color* to a concrete `#rrggbb[aa]` string for
 * the consumers that can't read CSS: Pango markup (`<span foreground="…">`),
 * GtkTextTag, draw-func colors, and the GtkSourceView scheme XML. CSS itself reads
 * `var(--accent-color)` natively and never needs this. This module is the *mechanism*;
 * the color knowledge it reads (APP_COLORS, FALLBACK_COLORS) lives in theme.ts with
 * the rest of the design tokens.
 *
 * `lookupCSSColor(theme, '--accent-color')` resolves any CSS-variable name —
 * libadwaita's *or* one of ours (info / hint) — through one path, in three layers:
 *   1. the **app-color registry** (APP_COLORS) — first-class semantic tokens that
 *      libadwaita has no variable for (info / hint).
 *   2. GTK's **named-color registry** via `style_context.lookup_color` — reads
 *      libadwaita's `@define-color` names (underscore form: `accent_color`), kept
 *      alongside its CSS variables. (Validated against the catalog in poc/adwaita-probe.)
 *   3. the static **fallback** palette (FALLBACK_COLORS) — for headless / no-display
 *      runs (tests, offscreen snapshots) where layer 2 can't resolve.
 *
 * Everything is a `#rrggbb[aa]` string end to end: the registries hold strings, and
 * the one non-string input — the `Gdk.RGBA` from `lookup_color` — is stringified at
 * the boundary by `gdkRgbaToString`, so no `Gdk.RGBA` is ever passed around. The
 * light/dark **scheme comes from the passed `theme`** (`theme.appearance`); this
 * module reads it, never the live `Adw.StyleManager`. It registers no signal handlers
 * and owns no scheme state — callers listen for scheme changes themselves and pass a
 * fresh `theme`. Results are **cached** by `scheme:name` so a flip just routes to fresh
 * keys (layer-2 values are constant within a scheme); layer-3 results aren't cached,
 * since a display may appear after an early headless read and should then win.
 */
import { Gdk, Gtk } from '../gi.ts';
import { APP_COLORS, FALLBACK_COLORS, type Theme } from './theme.ts';

/** A `Gdk.RGBA` (0–1 doubles) as a `#rrggbb` string, or `#rrggbbaa` when not fully
 *  opaque. The single point where a `Gdk.RGBA` turns into the string the rest of the
 *  module passes around — call it the moment you get one (e.g. from a draw-func). */
export function gdkRgbaToString(rgba: { red: number; green: number; blue: number; alpha: number }): string {
  const byte = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255);
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  const a = byte(rgba.alpha);
  const rgb = `#${hex(byte(rgba.red))}${hex(byte(rgba.green))}${hex(byte(rgba.blue))}`;
  return a === 255 ? rgb : `${rgb}${hex(a)}`;
}

// --- Resolution (the single path) -----------------------------------------

const cache = new Map<string, string>();
// Cached once it exists; `??=` keeps retrying while null so an early headless read
// doesn't pin it. No display → no GTK widgets, so layer 2 is skipped (tests/offscreen).
let display: InstanceType<typeof Gdk.Display> | null = null;
// The style context backing `lookup_color`, from a throwaway widget; reused across calls.
let styleContext: InstanceType<typeof Gtk.StyleContext> | null = null;

/** Look up a libadwaita `@define-color` (live scheme) as a string, or `null` when the
 *  name isn't registered. Only called once a display is known to exist. */
function gtkLookup(cssName: string): string | null {
  if (!styleContext) styleContext = new Gtk.Label().getStyleContext();
  // CSS-variable name (`--accent-color`) → GTK named color (`accent_color`).
  const named = cssName.replace(/^--/, '').replace(/-/g, '_');
  // node-gtk returns `[ok, Gdk.RGBA]` for `gboolean lookup_color(name, out color)`.
  const [ok, rgba] = styleContext.lookupColor(named) as [boolean, any];
  return ok && rgba ? gdkRgbaToString(rgba) : null;
}

/**
 * Resolve a CSS-variable color to a `#rrggbb[aa]` string for interpolation into Pango
 * markup / GtkTextTag / scheme XML — the single path, in three layers: app registry →
 * GTK `lookup_color` → static fallback. The scheme is `theme.appearance`; the caller
 * keeps it in step with the live Adwaita scheme, so GTK (which always reports the live
 * scheme) agrees. Throws if the name resolves nowhere (an unknown variable).
 */
export function lookupCSSColor(theme: Theme, name: string): string {
  const scheme = theme.appearance;
  const key = `${scheme}:${name}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  // 1. app registry — scheme-keyed literal, display-independent, safe to cache.
  const app = APP_COLORS[name];
  if (app) {
    cache.set(key, app[scheme]);
    return app[scheme];
  }

  // 2. live libadwaita named color — only when there's a display to read it from.
  display ??= Gdk.Display.getDefault();
  if (display) {
    const color = gtkLookup(name);
    if (color !== null) {
      cache.set(key, color);
      return color;
    }
  }

  // 3. static fallback — used headless; NOT cached (a display may arrive later and
  //    should then win over this approximation).
  const fb = FALLBACK_COLORS[name];
  if (fb) return fb[scheme];

  throw new Error(`lookupCSSColor: cannot resolve "${name}"`);
}
