/*
 * StyleManager — installs CSS into the default Gdk.Display via Gtk.CssProvider
 * (adapted from xedel's style-manager for GTK). Two kinds of styles:
 *
 *  - Static, anonymous CSS queued at module-init time with `addStyles` and
 *    flushed once after activation by `installStyles` (the display doesn't exist
 *    yet at import time). Used by components for their fixed look.
 *  - Dynamic, *keyed* stylesheets added with `styles.set(css, { key })`, which
 *    can be replaced in place (call again with the same key) or removed. Used for
 *    theme-derived chrome that changes when the active theme changes.
 *
 * Keyed sheets must be set after `installStyles()` (i.e. once the display
 * exists); that holds for anything built during/after AppWindow construction.
 */
import { Gdk, Gtk } from './gi.ts';
import { Disposable } from './util/eventKit.ts';
import { theme, themeUiCssVariables } from './theme/theme.ts';

const PRIORITY = Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION;

/** A handle to a keyed stylesheet, for replacing or removing it. */
export interface StyleSheet {
  update(css: string): void;
  remove(): void;
}

// A removable static sheet queued before the display exists: `flush` back-fills
// `provider` once installed, so a later dispose can remove it either way.
interface QueuedRemovable {
  css: string;
  provider: InstanceType<typeof Gtk.CssProvider> | null;
  cancelled: boolean;
}

class StyleManager {
  private ready = false;
  // Static CSS queued before the display exists (module-init time).
  private readonly queued: string[] = [];
  // Removable static sheets queued before the display exists (plugin styles).
  private readonly queuedRemovable: QueuedRemovable[] = [];
  // Live providers for keyed sheets, so each can be replaced or removed.
  private readonly byKey = new Map<string, InstanceType<typeof Gtk.CssProvider>>();

  /** Queue static CSS to install once the display is ready (module-init use). */
  add(css: string): void {
    if (this.ready) this.install(css, PRIORITY);
    else this.queued.push(css);
  }

  /**
   * Add static CSS that can later be removed — for plugin stylesheets, which are
   * contributed at activation (possibly before the display exists) and torn down
   * on deactivation. Returns a Disposable that removes the sheet whether it was
   * installed immediately or is still queued.
   */
  addRemovable(css: string): Disposable {
    if (this.ready) {
      const provider = this.install(css, PRIORITY);
      return new Disposable(() => this.removeProvider(provider));
    }
    const entry: QueuedRemovable = { css, provider: null, cancelled: false };
    this.queuedRemovable.push(entry);
    return new Disposable(() => {
      entry.cancelled = true;
      if (entry.provider) this.removeProvider(entry.provider);
    });
  }

  /** Flush queued static CSS and mark the display ready. Call once at activate. */
  flush(): void {
    this.ready = true;
    for (const css of this.queued) this.install(css, PRIORITY);
    this.queued.length = 0;
    for (const entry of this.queuedRemovable) {
      if (!entry.cancelled) entry.provider = this.install(entry.css, PRIORITY);
    }
    this.queuedRemovable.length = 0;
  }

  /**
   * Add — or, when `key` matches an existing sheet, replace in place — a dynamic
   * stylesheet, returning a handle to update or remove it. Requires the display
   * (call after `flush`).
   */
  set(css: string, options: { key?: string; priority?: number } = {}): StyleSheet {
    const display = Gdk.Display.getDefault();
    if (!display) throw new Error('styles.set called before the display is ready');

    const { key } = options;
    let provider = key ? this.byKey.get(key) : undefined;
    if (!provider) {
      provider = new Gtk.CssProvider();
      Gtk.StyleContext.addProviderForDisplay(display, provider, options.priority ?? PRIORITY);
      if (key) this.byKey.set(key, provider);
    }
    provider.loadFromString(css);

    const sheet = provider;
    return {
      update: (next: string) => sheet.loadFromString(next),
      remove: () => {
        Gtk.StyleContext.removeProviderForDisplay(display, sheet);
        if (key) this.byKey.delete(key);
      },
    };
  }

  /** Remove a keyed stylesheet if present; a no-op otherwise. */
  remove(key: string): void {
    const provider = this.byKey.get(key);
    if (!provider) return;
    const display = Gdk.Display.getDefault();
    if (display) Gtk.StyleContext.removeProviderForDisplay(display, provider);
    this.byKey.delete(key);
  }

  private install(css: string, priority: number): InstanceType<typeof Gtk.CssProvider> {
    const provider = new Gtk.CssProvider();
    provider.loadFromString(css);
    const display = Gdk.Display.getDefault();
    if (display) Gtk.StyleContext.addProviderForDisplay(display, provider, priority);
    return provider;
  }

  private removeProvider(provider: InstanceType<typeof Gtk.CssProvider>): void {
    const display = Gdk.Display.getDefault();
    if (display) Gtk.StyleContext.removeProviderForDisplay(display, provider);
  }
}

/** The application's single StyleManager. */
export const styles = new StyleManager();

/** Queue static CSS for installation. Safe to call at module init time. */
export function addStyles(css: string): void {
  styles.add(css);
}

/** Install all queued static CSS into the default display. Call once after activation. */
export function installStyles(): void {
  styles.flush();
}

// App-wide UI custom properties, inherited by every widget under the window.
// `--popover-radius` is the corner radius for floating chrome (the picker,
// which-key, the editor search bar). It deliberately does NOT reuse
// libadwaita's `--window-radius`, which collapses to 0 when the window is
// fullscreen/maximised — these surfaces should stay rounded regardless.
// `--popover-radius-small` is the tighter radius for compact, in-text chrome
// (the autocompletion popup) that sits flush against the cursor.
// `--card-radius` is the radius for bordered content cards that sit inside the
// content area (the agent input card, the diff comment box) — softer than a
// floating popover.
//
// The base spacing unit (margins / gaps between content chrome) is the theme's
// `spacing` token, emitted as `--t-spacing` on `#AppWindow` below.
//
// Font sizes are NOT defined here — they come from the font store (fonts.ts) as
// `--t-font-<role>-size-{small,large}` (role = `ui` | `monospace`). See docs/styling.md → Fonts.
addStyles(`
  window {
    --popover-radius: 15px;
    --popover-radius-small: 6px;
    --card-radius: 12px;
  }
`);

// Active-theme color tokens as CSS variables on the root window. Every `theme.ui.*`
// leaf becomes `--t-ui-<dashed-path>` (e.g. `theme.ui.editor.background` →
// `--t-ui-editor-background`), so CSS under `#AppWindow` reads a theme color as
// `var(--t-ui-…)` instead of interpolating the literal. See themeUiCssVariables and
// docs/styling.md. (Markup / GtkTextTag consumers can't read CSS vars and still use
// `theme.ui.*` directly.) Static today because `theme` is load-constant; when live
// theme-switching lands this becomes a keyed sheet re-set on theme change.
addStyles(`
  #AppWindow {
    --t-spacing: ${theme.spacing}px;
    ${themeUiCssVariables(theme).replace(/\n/g, '\n    ')}
  }
`);
