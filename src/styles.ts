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

const PRIORITY = Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION;

/** A handle to a keyed stylesheet, for replacing or removing it. */
export interface StyleSheet {
  update(css: string): void;
  remove(): void;
}

class StyleManager {
  private ready = false;
  // Static CSS queued before the display exists (module-init time).
  private readonly queued: string[] = [];
  // Live providers for keyed sheets, so each can be replaced or removed.
  private readonly byKey = new Map<string, InstanceType<typeof Gtk.CssProvider>>();

  /** Queue static CSS to install once the display is ready (module-init use). */
  add(css: string): void {
    if (this.ready) this.install(css, PRIORITY);
    else this.queued.push(css);
  }

  /** Flush queued static CSS and mark the display ready. Call once at activate. */
  flush(): void {
    this.ready = true;
    for (const css of this.queued) this.install(css, PRIORITY);
    this.queued.length = 0;
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

  private install(css: string, priority: number): void {
    const display = Gdk.Display.getDefault();
    if (!display) return;
    const provider = new Gtk.CssProvider();
    provider.loadFromString(css);
    Gtk.StyleContext.addProviderForDisplay(display, provider, priority);
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
addStyles(`
  window {
    --popover-radius: 15px;
    --popover-radius-small: 6px;
  }
`);
