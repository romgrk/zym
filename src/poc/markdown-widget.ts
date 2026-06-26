#!/usr/bin/env node
/*
 * POC: render the markdown fixture through the native MarkdownRenderer widget
 * (src/ui/markdown/MarkdownRenderer.ts) — the single Gtk.Widget that draws the
 * whole document via the GSK render-node scene graph. Unlike the MarkdownView POC
 * (poc:md, which stitches Gtk.Labels), here selection / copy / link-clicking span
 * the ENTIRE document: drag from a heading through a code block into a table.
 *
 * Try it:
 *   - drag to select across blocks; double-click a word; triple-click a block
 *   - Ctrl+A select all, Ctrl+C copy
 *   - click a link (opens in the default browser); hover shows the pointer cursor
 *
 * Run:  node src/poc/markdown-widget.ts [path/to/other.md]
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gtk, Adw, Gio, GLib, startLoop } from '../gi.ts';
import { installStyles } from '../styles.ts';
import { registerBundledFonts, fonts } from '../fonts.ts';
import { theme } from '../theme/theme.ts';
import { registerBuiltinPlugins, plugins } from '../plugin/index.ts';
import { preloadGrammars } from '../syntax/grammar.ts';

const here = Path.dirname(fileURLToPath(import.meta.url));
const fixturePath = process.argv[2] ? Path.resolve(process.argv[2]) : Path.join(here, 'markdown-sample.md');

const loop = GLib.MainLoop.new(null, false);
const app = new Adw.Application({ applicationId: 'com.github.romgrk.zym.poc.mdwidget', flags: Gio.ApplicationFlags.NON_UNIQUE });

app.on('activate', async () => {
  try {
    registerBundledFonts();
    installStyles();
    fonts.init();
    Adw.StyleManager.getDefault().setColorScheme(
      theme.appearance === 'light' ? Adw.ColorScheme.FORCE_LIGHT : Adw.ColorScheme.FORCE_DARK,
    );

    // Import AFTER GTK init: the module's factory does the one-time registerClass.
    const { createMarkdownRenderer } = await import('../ui/markdown/MarkdownRenderer.ts');

    const md = Fs.readFileSync(fixturePath, 'utf8');
    const renderer = createMarkdownRenderer();
    renderer.setMarkdown(md);
    renderer.setHexpand(true);

    // Cap the column like the real transcript so wrapping is exercised.
    const clamp = new Adw.Clamp();
    clamp.setMaximumSize(820);
    clamp.setTighteningThreshold(820);
    clamp.setChild(renderer);
    clamp.marginTop = 16;
    clamp.marginBottom = 16;
    clamp.marginStart = 16;
    clamp.marginEnd = 16;

    const scroller = new Gtk.ScrolledWindow({ vexpand: true });
    scroller.setPolicy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
    scroller.setChild(clamp);

    const window = new Adw.ApplicationWindow({ application: app });
    window.setName('AppWindow');
    window.addCssClass('AppWindow'); // the font vars (--t-font-*) are published on the .AppWindow CLASS (see src/ui/AppWindow.ts), not #AppWindow
    window.setTitle('zym POC — MarkdownRenderer (native render-node widget)');
    window.setDefaultSize(1000, 800);
    window.setContent(scroller);
    window.on('close-request', () => {
      renderer.teardown();
      loop.quit();
      app.quit();
      return false;
    });
    window.present();

    startLoop();
    loop.run();
  } catch (e) {
    process.stderr.write('[POC] activate threw: ' + (e as Error)?.stack + '\n');
    loop.quit();
    app.quit();
  }
});

// Register grammars before the loop so fenced code blocks syntax-highlight.
registerBuiltinPlugins();
await plugins.activateAll();
await preloadGrammars();

// node-gtk #442: defer app.run past the top-level module microtask, or activate
// never fires and the app exits 0.
await new Promise((res) => setTimeout(res, 0));
app.run([]);
