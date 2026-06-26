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
 *
 * Hot-reload (on by default, ZYM_STYLE_HOT_RELOAD=0 to opt out): each file that
 * installs static CSS via `addStyles` is watched (chokidar). Editing it re-runs
 * that one module so its `addStyles` calls reinstall the new CSS, then the
 * providers from the previous run are dropped — styles update live, no restart.
 * See docs/styling.md → Hot-reload.
 */
import * as Path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FSWatcher } from 'chokidar';
import { Gdk, Gtk } from './gi.ts';
import { Disposable } from './util/eventKit.ts';
import { theme, themeUiCssVariables } from './theme/theme.ts';

const PRIORITY = Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION;

type CssProvider = InstanceType<typeof Gtk.CssProvider>;

// Hot-reload is on by default; set ZYM_STYLE_HOT_RELOAD to a falsy value
// (0/false/no/off) to opt out. The watcher is only ever created at `flush()`
// (display ready), so test files that never activate install no watchers.
// `OWN_FILE` lets caller detection skip this module's own frames when
// attributing an `addStyles` call to a source file.
const HOT_RELOAD = !/^(0|false|no|off)$/i.test(process.env.ZYM_STYLE_HOT_RELOAD ?? '');
const OWN_FILE = Path.resolve(fileURLToPath(import.meta.url));

/** Absolute path of the first source file above this module on the stack. */
function callerFile(): string | null {
  const stack = new Error().stack;
  if (!stack) return null;
  for (const line of stack.split('\n').slice(1)) {
    const file = frameFile(line);
    if (file && file !== OWN_FILE) return file;
  }
  return null;
}

/** Pull the absolute file path out of one V8 stack frame, or null. */
function frameFile(frame: string): string | null {
  // "  at fn (file:///p/x.ts:1:2)"  or  "  at file:///p/x.ts:1:2"
  const m = frame.match(/\(([^()]+):\d+:\d+\)\s*$/) ?? frame.match(/\bat\s+([^()\s]+):\d+:\d+\s*$/);
  if (!m) return null;
  let loc = m[1];
  const q = loc.indexOf('?'); // strip the `?style-hot-reload=N` cache-buster, if any
  if (q !== -1) loc = loc.slice(0, q);
  if (loc.startsWith('file://')) {
    try { return Path.resolve(fileURLToPath(loc)); } catch { return null; }
  }
  if (loc.startsWith('node:') || loc.includes('node_modules')) return null;
  return Path.resolve(loc);
}

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
  // Static CSS queued before the display exists (module-init time). Each entry
  // carries the source file (or null) so hot-reload can key its provider once
  // the queue is flushed.
  private readonly queued: { css: string; file: string | null }[] = [];
  // Removable static sheets queued before the display exists (plugin styles).
  private readonly queuedRemovable: QueuedRemovable[] = [];
  // Live providers for keyed sheets, so each can be replaced or removed.
  private readonly byKey = new Map<string, InstanceType<typeof Gtk.CssProvider>>();

  // --- Hot-reload state (only populated when HOT_RELOAD is on) ---
  // Providers installed by each source file, so a reload can drop the old ones.
  private readonly fileProviders = new Map<string, Set<CssProvider>>();
  private readonly watchedFiles = new Set<string>();
  private watcher: FSWatcher | null = null;
  private reloadSeq = 0;
  private readonly reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reloading = new Set<string>();
  private readonly reloadPending = new Set<string>();

  /** Queue static CSS to install once the display is ready (module-init use). */
  add(css: string): void {
    const file = HOT_RELOAD ? callerFile() : null;
    if (this.ready) this.track(file, this.install(css, PRIORITY));
    else this.queued.push({ css, file });
    if (file) this.watch(file);
  }

  /**
   * Install static CSS that is never hot-reloaded — for stylesheets defined
   * inside this module. Re-importing styles.ts (what hot-reload does) would fork
   * the StyleManager singleton, so its own sheets must opt out.
   */
  addStatic(css: string): void {
    if (this.ready) this.install(css, PRIORITY);
    else this.queued.push({ css, file: null });
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
    for (const { css, file } of this.queued) this.track(file, this.install(css, PRIORITY));
    this.queued.length = 0;
    for (const entry of this.queuedRemovable) {
      if (!entry.cancelled) entry.provider = this.install(entry.css, PRIORITY);
    }
    this.queuedRemovable.length = 0;
    if (HOT_RELOAD) void this.startWatcher();
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

  // ---- Hot-reload (dev only, behind ZYM_STYLE_HOT_RELOAD) --------------------

  /** Record that `provider` came from `file`, so a reload can later remove it. */
  private track(file: string | null, provider: CssProvider): void {
    if (!file) return;
    let set = this.fileProviders.get(file);
    if (!set) this.fileProviders.set(file, (set = new Set()));
    set.add(provider);
  }

  /** Watch `file` for edits. The chokidar watcher is created lazily at flush. */
  private watch(file: string): void {
    if (this.watchedFiles.has(file)) return;
    this.watchedFiles.add(file);
    this.watcher?.add(file); // null before flush; startWatcher picks it up then
  }

  private async startWatcher(): Promise<void> {
    if (this.watcher) return;
    const { watch } = await import('chokidar');
    if (this.watcher) return; // another flush won the race during the await
    // Snapshot after the await so files watched during the import are included;
    // files added later go straight to the live watcher via `watch()`.
    this.watcher = watch([...this.watchedFiles], { ignoreInitial: true });
    this.watcher.on('change', (path) => this.onFileChanged(Path.resolve(path)));
    this.watcher.on('error', () => {}); // transient FS error — the next edit recovers
  }

  // Coalesce the burst of events an editor's atomic save emits, then reload once.
  private onFileChanged(file: string): void {
    clearTimeout(this.reloadTimers.get(file));
    this.reloadTimers.set(file, setTimeout(() => {
      this.reloadTimers.delete(file);
      void this.reloadFile(file);
    }, 40));
  }

  /** Stop watching and clear pending reloads (teardown / tests). */
  stopHotReload(): void {
    void this.watcher?.close();
    this.watcher = null;
    for (const timer of this.reloadTimers.values()) clearTimeout(timer);
    this.reloadTimers.clear();
    this.watchedFiles.clear();
  }

  /**
   * Re-run `file`'s module (cache-busted query so Node re-evaluates it) so its
   * `addStyles` calls reinstall the new CSS, then drop the providers from the
   * previous run. New sheets go up before the old come down (no unstyled flash);
   * a module load/eval error (e.g. a syntax error mid-edit) rolls back to the
   * previously working sheets instead of installing nothing.
   */
  private async reloadFile(file: string): Promise<void> {
    if (this.reloading.has(file)) { this.reloadPending.add(file); return; }
    this.reloading.add(file);

    const previous = this.fileProviders.get(file) ?? new Set<CssProvider>();
    const fresh = new Set<CssProvider>();
    this.fileProviders.set(file, fresh); // the re-run's track() collects into here
    try {
      await import(`${pathToFileURL(file).href}?style-hot-reload=${++this.reloadSeq}`);
      for (const provider of previous) this.removeProvider(provider);
      console.info(`[styles] reloaded ${Path.relative(process.cwd(), file)}`);
    } catch (error) {
      for (const provider of fresh) this.removeProvider(provider);
      this.fileProviders.set(file, previous); // keep the working sheets installed
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[styles] hot-reload failed for ${Path.relative(process.cwd(), file)}: ${message}`);
    } finally {
      this.reloading.delete(file);
      if (this.reloadPending.delete(file)) void this.reloadFile(file);
    }
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
// `spacing` token, emitted as `--t-spacing` on `.AppWindow` below.
//
// Font sizes are NOT defined here — they come from the font store (fonts.ts) as
// `--t-font-<role>-size-{small,large}` (role = `ui` | `monospace`). See docs/styling.md → Fonts.
//
// `addStatic` (not `addStyles`): these sheets live in this module, so they opt
// out of hot-reload — re-importing styles.ts would fork the StyleManager.
styles.addStatic(`
  window {
    --popover-radius: 15px;
    --popover-radius-small: 6px;
    --card-radius: 12px;
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
// keyed sheet re-set on theme change.
styles.addStatic(`
  window {
    --t-spacing: ${theme.spacing}px;
    ${themeUiCssVariables(theme).replace(/\n/g, '\n    ')}
  }
`);
