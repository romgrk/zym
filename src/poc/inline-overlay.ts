#!/usr/bin/env node
/*
 * POC: exercise the real `BlockDecorations` (gap-tag + text-view overlay).
 *
 * Throwaway harness (separate from the editor) that drives the actual controller
 * from src/ui/TextEditor/BlockDecorations.ts, so running it validates the
 * primitive itself — map-deferred placement, measure-to-fit gap, reposition, and
 * clean add/remove — not just raw GTK calls. See tasks/code-editing/inline-widgets.md.
 *
 * Run interactively:   pnpm poc:inline   (or: node src/poc/inline-overlay.ts)
 *   Ctrl+Space   add / remove the inline block at line 6
 *   the block is a clickable button — click it (label flips), confirming overlay
 *     input works; scroll to confirm it tracks its anchor line natively.
 *
 * Headless API check:  POC_VERIFY=1 node src/poc/inline-overlay.ts
 */
import { createRequire } from 'node:module';
import { Gtk, Gdk, Adw, GtkSource, GLib, Gio, startLoop } from '../gi.ts';
import { BlockDecorations, type BlockDecorationHandle } from '../ui/TextEditor/BlockDecorations.ts';

// (createRequire kept available for parity with other POCs; unused here.)
void createRequire(import.meta.url);

const ANCHOR_LINE = 5; // 0-based; the block sits below this line
const SAMPLE = Array.from({ length: 40 }, (_, i) => `line ${String(i + 1).padStart(2, ' ')}  — some text to scroll past`).join('\n');

let view: any;
let buffer: any;
let blocks: BlockDecorations;
let handle: BlockDecorationHandle | null = null;

function buildEditor() {
  buffer = new GtkSource.Buffer();
  view = new GtkSource.View({ buffer });
  view.setMonospace(true);
  view.setLeftMargin(8);
  view.setTopMargin(4);
  blocks = new BlockDecorations(view);
}

/** A clickable placeholder card — the fold-placeholder shape (no nested editor:
 *  add_overlay children can't host a focusable editor, see inline-widgets.md). */
function makeCard(): any {
  const card = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
  card.addCssClass('inline-card');
  let n = 0;
  const button = new Gtk.Button({ label: '⋯ 12 unchanged lines — click to "expand"' });
  button.on('clicked', () => button.setLabel(`clicked ${++n}× ✓ (overlay input works)`));
  card.append(button);
  return card;
}

function toggleBlock() {
  if (handle) {
    handle.remove();
    handle = null;
  } else {
    handle = blocks.add({ line: ANCHOR_LINE, widget: makeCard(), placement: 'below' });
  }
}

const loop = GLib.MainLoop.new(null, false);
const app = new Adw.Application({ applicationId: 'com.github.romgrk.quilx.poc.inline', flags: Gio.ApplicationFlags.NON_UNIQUE });

app.on('activate', () => {
 try {
  buildEditor();

  Adw.StyleManager.getDefault().setColorScheme(Adw.ColorScheme.FORCE_DARK);
  const scheme = GtkSource.StyleSchemeManager.getDefault().getScheme('Adwaita-dark');
  if (scheme) buffer.setStyleScheme(scheme);

  const display = Gdk.Display.getDefault();
  if (display) {
    const css = new Gtk.CssProvider();
    css.loadFromData('.inline-card { background: alpha(#3584e4, 0.15); border: 1px solid alpha(#3584e4, 0.6); border-radius: 6px; padding: 6px; }', -1);
    Gtk.StyleContext.addProviderForDisplay(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
  }

  buffer.setText(SAMPLE, -1);
  buffer.placeCursor(buffer.getStartIter());

  // Ctrl+Space toggles the block.
  const keys = new Gtk.EventControllerKey();
  keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
  keys.on('key-pressed', (keyval: number, _code: number, state: number) => {
    if ((state & Gdk.ModifierType.CONTROL_MASK) !== 0 && keyval === Gdk.KEY_space) { toggleBlock(); return true; }
    return false;
  });
  view.addController(keys);

  // The controller defers placement to `map`, so just add it now.
  handle = blocks.add({ line: ANCHOR_LINE, widget: makeCard(), placement: 'below' });

  const scrolled = new Gtk.ScrolledWindow();
  scrolled.setChild(view);
  const window = new Adw.ApplicationWindow({ application: app });
  window.setTitle('quilx POC — BlockDecorations (Ctrl+Space toggle, click the card)');
  window.setDefaultSize(640, 520);
  window.setContent(scrolled);
  window.on('close-request', () => { loop.quit(); app.quit(); return false; });
  window.present();
  view.grabFocus();

  // Headless: confirm the controller drives the API without throwing (rendering /
  // gap reservation need a realized view — run interactively).
  if (process.env.POC_VERIFY) {
    setTimeout(() => {
      let ok = true, err = '';
      try {
        handle?.remove();
        handle = blocks.add({ line: ANCHOR_LINE, widget: makeCard(), placement: 'below' });
        handle.invalidate();
        blocks.repositionAll();
      } catch (e) { ok = false; err = String((e as Error)?.stack ?? e); }
      console.error(JSON.stringify({ controllerApi: ok ? 'PASS (add/remove/invalidate/repositionAll no throw)' : `FAIL (${err})` }, null, 2));
      loop.quit(); app.quit();
    }, 500);
  }

  startLoop();
  loop.run();
 } catch (e) {
  process.stderr.write('[POC] activate threw: ' + (e as Error)?.stack + '\n');
  loop.quit(); app.quit();
 }
});

// node-gtk #442: `app.run` must NOT be the top-level module microtask, or the GLib
// loop never integrates with node's event loop and `activate` never fires (the app
// exits 0 immediately). A top-level await defers it one macrotask.
await new Promise((res) => setTimeout(res, 0));
app.run([]);
