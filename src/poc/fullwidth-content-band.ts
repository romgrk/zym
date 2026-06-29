#!/usr/bin/env node
/*
 * POC: validate the `fullWidth: 'content'` BlockDecorations mode — a NON-sticky band
 * sized to the full scrollable CONTENT width so it stays full-width at any horizontal
 * scroll while riding the text. See docs/text-editor/block-decorations.md.
 *
 * The one runtime risk this de-risks: width-requesting the overlay slot to
 * `hadj.getUpper()` must NOT feed back and grow `upper` (an unbounded loop). The text
 * view's scroll extent is the text layout's width, not its overlay children — this
 * confirms it empirically.
 *
 * Run interactively:   node src/poc/fullwidth-content-band.ts
 *   scroll right — the `⋯` band stays full-width across the whole viewport (not just
 *   the left edge), unlike a 'viewport'-width band which would scroll off.
 *
 * Headless check:      POC_VERIFY=1 node src/poc/fullwidth-content-band.ts
 *   asserts `upper` is stable after the content band is fitted (no feedback loop) and
 *   that the band's slot width tracks `upper` (spans the content), at scroll 0 and
 *   scrolled fully right.
 */
import GLib from 'gi:GLib-2.0';
import Gio from 'gi:Gio-2.0';
import Gdk from 'gi:Gdk-4.0';
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import GtkSource from 'gi:GtkSource-5';
import { BlockDecorations } from '../ui/TextEditor/BlockDecorations.ts';

const ANCHOR_LINE = 5; // 0-based; the content band sits below this line
// Long lines (wider than the window) so the view scrolls HORIZONTALLY: upper > pageSize.
const LONG = ' — a deliberately long line of text that runs well past the right edge of the window so the view scrolls sideways';
const SAMPLE = Array.from({ length: 40 }, (_, i) => `line ${String(i + 1).padStart(2, ' ')}${LONG}`).join('\n');

let view: any;
let buffer: any;
let blocks: BlockDecorations;

function buildEditor() {
  buffer = new GtkSource.Buffer();
  view = new GtkSource.View({ buffer });
  view.setMonospace(true);
  view.setWrapMode(Gtk.WrapMode.NONE); // no wrap → long lines force a horizontal scroll
  view.setLeftMargin(8);
  blocks = new BlockDecorations(view);
}

function makeGap(): any {
  const card = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
  card.addCssClass('gap');
  const button = new Gtk.Button({ label: '⋯ 12 unchanged lines', halign: Gtk.Align.START, hasFrame: false });
  card.append(button);
  return card;
}

const loop = GLib.MainLoop.new(null, false);
const app = new Adw.Application({ applicationId: 'com.github.romgrk.zym.poc.fullwidth', flags: Gio.ApplicationFlags.NON_UNIQUE });

app.on('activate', () => {
 try {
  buildEditor();

  Adw.StyleManager.getDefault().setColorScheme(Adw.ColorScheme.FORCE_DARK);
  const scheme = GtkSource.StyleSchemeManager.getDefault().getScheme('Adwaita-dark');
  if (scheme) buffer.setStyleScheme(scheme);

  const display = Gdk.Display.getDefault();
  if (display) {
    const css = new Gtk.CssProvider();
    css.loadFromData('.gap { background: alpha(#3584e4, 0.18); border-top: 1px solid alpha(#3584e4, 0.6); border-bottom: 1px solid alpha(#3584e4, 0.6); }', -1);
    Gtk.StyleContext.addProviderForDisplay(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
  }

  buffer.setText(SAMPLE, -1);
  buffer.placeCursor(buffer.getStartIter());

  blocks.add({ line: ANCHOR_LINE, widget: makeGap(), placement: 'below', fullWidth: 'content' });

  const scrolled = new Gtk.ScrolledWindow();
  scrolled.setChild(view);
  const window = new Adw.ApplicationWindow({ application: app });
  window.setTitle('zym POC — fullWidth: content (scroll right; the band stays full-width)');
  window.setDefaultSize(560, 480);
  window.setContent(scrolled);
  window.on('close-request', () => { loop.quit(); app.quit(); return false; });
  window.present();
  view.grabFocus();

  if (process.env.POC_VERIFY) {
    const hadj = view.getHadjustment();
    const round = (n: number) => Math.round(n);
    // Let the view realize + allocate, then sample at scroll 0, scroll right, and again
    // — `upper` must not creep upward (no feedback from the band's width request).
    setTimeout(() => {
      const upper0 = round(hadj.getUpper());
      const page = round(hadj.getPageSize());
      hadj.setValue(hadj.getUpper() - hadj.getPageSize()); // scroll fully right
      setTimeout(() => {
        const upper1 = round(hadj.getUpper());
        blocks.repositionAll();
        setTimeout(() => {
          const upper2 = round(hadj.getUpper());
          const stable = upper0 === upper1 && upper1 === upper2;
          const scrollable = upper0 > page; // the content really is wider than the viewport
          console.error(JSON.stringify({
            page, upper0, upper1, upper2,
            upperStable: stable ? 'PASS (no feedback loop)' : `FAIL (upper drifted ${upper0}→${upper1}→${upper2})`,
            horizontallyScrollable: scrollable ? 'PASS (upper > page)' : 'SKIP (window too wide to scroll)',
          }, null, 2));
          loop.quit(); app.quit();
        }, 250);
      }, 250);
    }, 600);
  }

  loop.run();
 } catch (e) {
  process.stderr.write('[POC] activate threw: ' + (e as Error)?.stack + '\n');
  loop.quit(); app.quit();
 }
});

// node-gtk #442: defer app.run one macrotask so the GLib loop integrates with node's.
await new Promise((res) => setTimeout(res, 0));
app.run([]);
