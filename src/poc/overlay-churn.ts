#!/usr/bin/env node
/*
 * POC: reproduce the overlay-child parenting warnings the markdown image preview
 * surfaced — `GtkPicture is not a child of GtkSourceView` (from view.remove) and
 * `gtk_widget_snapshot_child: assertion '_gtk_widget_get_parent (child) == widget'
 * failed` (a dangling overlay child during snapshot).
 *
 * It drives the real BlockDecorations: place several blocks in a realized
 * view, then remove some and force a redraw (scroll + queue_draw) — the add/remove
 * churn the image preview does. Run and watch stderr:
 *
 *   node src/poc/overlay-churn.ts 2>&1 | grep -iE 'CRITICAL|WARNING|not a child'
 *
 * Clean run prints nothing.
 */
import { Gtk, Adw, GtkSource, GLib, Gio, startLoop } from '../gi.ts';
import { BlockDecorations, type BlockDecorationHandle } from '../ui/TextEditor/BlockDecorations.ts';

const SAMPLE = Array.from({ length: 60 }, (_, i) => `line ${String(i + 1).padStart(2, ' ')}  — text to scroll past`).join('\n');
const LINES = [4, 8, 12, 16, 20]; // anchor lines for the blocks

const loop = GLib.MainLoop.new(null, false);
const app = new Adw.Application({ applicationId: 'com.github.romgrk.quilx.poc.churn', flags: Gio.ApplicationFlags.NON_UNIQUE });

function makeCard(label: string): any {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
  box.append(new Gtk.Label({ label }));
  box.setSizeRequest(200, 40);
  return box;
}

app.on('activate', () => {
  try {
    const buffer = new GtkSource.Buffer();
    const view: any = new GtkSource.View({ buffer });
    view.setMonospace(true);
    buffer.setText(SAMPLE, -1);
    const blocks = new BlockDecorations(view);

    const scrolled = new Gtk.ScrolledWindow();
    scrolled.setChild(view);
    const window = new Adw.ApplicationWindow({ application: app });
    window.setDefaultSize(640, 480);
    window.setContent(scrolled);
    window.on('close-request', () => { loop.quit(); app.quit(); return false; });
    window.present();

    const handles: BlockDecorationHandle[] = LINES.map((line) => blocks.add({ line, widget: makeCard(`block @${line}`), placement: 'below' }));

    // After the view is realized + blocks placed: remove half, force redraws, scroll.
    setTimeout(() => {
      handles[1].remove();
      handles[3].remove();
      view.queueDraw();
      blocks.repositionAll();
      // Scroll to force the view to re-snapshot its (now churned) overlay children.
      const vadj = view.getVadjustment();
      if (vadj) vadj.setValue(120);
      view.queueDraw();
    }, 400);

    // A second churn round (re-add at a removed slot), then quit.
    setTimeout(() => {
      blocks.add({ line: 8, widget: makeCard('re-added @8'), placement: 'below' });
      view.queueDraw();
    }, 800);
    setTimeout(() => {
      process.stderr.write('[POC] done\n');
      loop.quit();
      app.quit();
    }, 1400);

    startLoop();
    loop.run();
  } catch (e) {
    process.stderr.write('[POC] activate threw: ' + (e as Error)?.stack + '\n');
    loop.quit();
    app.quit();
  }
});

await new Promise((res) => setTimeout(res, 0));
app.run([]);
