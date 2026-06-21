/*
 * clipboard — synchronous text views onto the GTK selections.
 *
 * The register manager reads and writes synchronously (`read()` / `write()`),
 * but GTK4's `Gdk.Clipboard` only exposes an *async* text read. We bridge the
 * two by writing through to the system selection immediately and keeping a cache
 * that is refreshed asynchronously whenever the selection changes (including our
 * own writes). A read returns the cache — the last value we observed — which is
 * exact right after our own write and best-effort for changes made by other
 * applications.
 *
 * Two selections are exposed: `clipboard` is the regular CLIPBOARD (vim's `"+`
 * and the default-register target) and `primaryClipboard` is the X11/Wayland
 * PRIMARY selection (vim's `"*`, middle-click paste).
 *
 * With no display (headless test runs) each degrades to a plain in-memory cache.
 */
import { Gdk, GObject } from '../../../gi.ts';

// node-gtk's generated types omit a few GTK4 clipboard members that exist at
// runtime (Display.getClipboard / getPrimaryClipboard, GObject.TYPE_STRING) —
// reach them through `any`, the same escape hatch the rest of the codebase uses.
 

export interface Clipboard {
  read(): string;
  write(text: string): void;
}

type Selection = 'clipboard' | 'primary';

function createClipboard(selection: Selection): Clipboard {
  let gtkClipboard: any = null;
  let initialized = false;
  let cache = '';

  function refreshCache(): void {
    const cb = gtkClipboard;
    if (!cb) return;
    // Needs the GLib main loop spinning (true in the running app) to complete.
    cb.readTextAsync(null, (_src: unknown, result: unknown) => {
      try {
        const text = cb.readTextFinish(result);
        if (text != null) cache = text;
      } catch {
        // Empty selection or non-text content — keep the last known text.
      }
    });
  }

  function ensure(): any {
    if (initialized) return gtkClipboard;
    initialized = true;
    const display = Gdk.Display.getDefault() as any;
    if (!display) return null; // headless: in-memory only
    gtkClipboard = selection === 'primary' ? display.getPrimaryClipboard() : display.getClipboard();
    gtkClipboard.on('changed', refreshCache);
    refreshCache(); // prime from whatever is already on the selection
    return gtkClipboard;
  }

  return {
    read(): string {
      ensure();
      return cache;
    },

    write(text: string): void {
      cache = text; // write-through, so an immediate read is exact
      const cb = ensure();
      if (!cb) return;
      const value = new GObject.Value();
      value.init((GObject as any).TYPE_STRING);
      value.setString(text);
      cb.setContent(Gdk.ContentProvider.newForValue(value));
    },
  };
}

/** The regular CLIPBOARD selection (vim `"+`, default register). */
export const clipboard = createClipboard('clipboard');

/** The PRIMARY selection (vim `"*`, middle-click paste). */
export const primaryClipboard = createClipboard('primary');

export default clipboard;
