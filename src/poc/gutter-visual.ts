#!/usr/bin/env node
/*
 * POC: visually verify the single composite GutterRenderer (gutterRenderers.ts).
 *
 * Builds a GtkSource.View with the REAL composite renderer and a stub GutterHost
 * exercising all four columns (line number + fold chevron ▾/▸ + git bar ▏ + Nerd
 * Font diagnostic glyph), then snapshots the view to a PNG (WidgetPaintable ->
 * GskRenderer.render_texture -> save_to_png) so the rendering can be eyeballed
 * without a live Wayland frame. Writes /tmp/gutter-visual.png and quits.
 *
 *   node src/poc/gutter-visual.ts
 */
import { createRequire } from 'node:module';
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const gi = require_('node-gtk') as typeof import('node-gtk');
const GLib = gi.require('GLib', '2.0');
const Gtk = gi.require('Gtk', '4.0');
const Adw = gi.require('Adw', '1');
const GtkSource = gi.require('GtkSource', '5');
const PangoCairo = gi.require('PangoCairo', '1.0');
const Graphene = gi.require('Graphene', '1.0');

const fontDir = Path.join(Path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'fonts');

const loop = GLib.MainLoop.new(null, false);
const app = new Adw.Application({ applicationId: 'com.github.romgrk.quilx.guttervisual' });

app.on('activate', async () => {
  // Register the bundled Nerd Font AFTER GTK init (like registerBundledFonts) so the
  // diagnostic glyph shapes from the display's fontmap instead of rendering blank.
  const ok = PangoCairo.FontMap.getDefault().addFontFile(Path.join(fontDir, 'SymbolsNerdFontMono-Regular.ttf'));
  process.stderr.write(`[visual] addFontFile -> ${ok}\n`);

  const { GutterRenderer } = await import('../syntax/gutterRenderers.ts');

  const buffer = new GtkSource.Buffer();
  const view: any = new GtkSource.View({ buffer });
  view.setMonospace(true);
  const lines = Array.from({ length: 24 }, (_, i) => `function compute_${i}(a, b) { return a + b; }`);
  buffer.setText(lines.join('\n'), -1);

  Adw.StyleManager.getDefault().setColorScheme(Adw.ColorScheme.FORCE_DARK);
  const scheme = GtkSource.StyleSchemeManager.getDefault().getScheme('Adwaita-dark');
  if (scheme) buffer.setStyleScheme(scheme);

  // Stub GutterHost exercising every column. Lines 3 & 10 are fold headers (one
  // open ▾, one folded ▸); a few lines carry git bars and diagnostic glyphs.
  const foldsByHeaderLine = new Map<number, { folded: boolean }>([
    [3, { folded: false }],
    [10, { folded: true }],
  ]);
  const gitColor: Record<number, string> = { 2: '#98c379', 5: '#e5c07b', 6: '#e5c07b', 14: '#e06c75' };
  const COD_WARNING = String.fromCodePoint(0xea6c); // nf-cod-warning, the real severity glyph
  const diag: Record<number, { glyph: string; color: string }> = {
    5: { glyph: COD_WARNING, color: '#e06c75' },
    12: { glyph: COD_WARNING, color: '#e5c07b' },
  };
  const controller = {
    foldsByHeaderLine,
    lineNumberWidth: () => 2,
    modelLineFor: (line: number) => line,
    wantLineNumbers: true,
    foldingEnabled: true,
    hasGitColumn: true,
    hasDiagColumn: true,
    gitCellFor: (line: number) => (gitColor[line] ? `<span foreground="${gitColor[line]}">▏</span>` : ''),
    diagCellFor: (line: number) =>
      diag[line] ? `<span face="Symbols Nerd Font Mono" size="85%" foreground="${diag[line].color}">${diag[line].glyph}</span>` : '',
  };

  const renderer: any = new GutterRenderer();
  renderer.controller = controller;
  renderer.setXpad(3);
  renderer.setText('00000', -1); // prime width like primeGutter does
  view.getGutter(Gtk.TextWindowType.LEFT).insert(renderer, 0);

  const scrolled = new Gtk.ScrolledWindow();
  scrolled.setChild(view);
  const window = new Adw.ApplicationWindow({ application: app });
  window.setDefaultSize(560, 480);
  window.setContent(scrolled);
  window.on('close-request', () => { loop.quit(); app.quit(); return false; });
  window.present();

  // After realize + allocation AND a few real paints (WidgetPaintable reflects the
  // last rendered frame — snapshotting too early yields an empty node): snapshot to PNG.
  let frames = 0;
  let painted = 0;
  view.addTickCallback((): boolean => {
    if (view.getHeight() <= 0) { return ++frames < 240; }
    if (++painted < 15) return true; // let it actually paint a few frames first
    try {
      const paintable: any = Gtk.WidgetPaintable.new(view);
      const w = view.getWidth() || 560;
      const h = view.getHeight() || 480;
      const snapshot: any = Gtk.Snapshot.new();
      paintable.snapshot(snapshot, w, h);
      const node = snapshot.toNode();
      if (node) {
        const gskRenderer: any = (window as any).getRenderer();
        const rect: any = (new Graphene.Rect() as any).init(0, 0, w, h);
        const texture: any = gskRenderer.renderTexture(node, rect);
        texture.saveToPng('/tmp/gutter-visual.png');
        process.stderr.write(`[visual] wrote /tmp/gutter-visual.png (${w}x${h})\n`);
      } else {
        process.stderr.write('[visual] snapshot produced no node\n');
      }
    } catch (e) {
      process.stderr.write('[visual] snapshot failed: ' + (e as Error).stack + '\n');
    }
    loop.quit(); app.quit();
    return false;
  });

  gi.startLoop();
  loop.run();
});

await new Promise((res) => setTimeout(res, 0));
app.run([]);
