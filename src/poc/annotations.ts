#!/usr/bin/env node
/*
 * POC: GtkSourceAnnotations (5.18+) — native end-of-line virtual text per view.
 *
 * The A2 document-model gave each view its own buffer, which unblocks GtkSourceView's
 * native annotation API (a shared buffer would render annotations in every view). The
 * API binding is verified headless; this confirms the open risk from
 * tasks/code-editing/virtual-lines.md: does it actually *render* end-of-line text, and
 * do the styles (error/warning/accent) look right?
 *
 * Flow: `new GtkSource.AnnotationProvider()` → `provider.addAnnotation(annotation)` →
 * `view.getAnnotations().addProvider(provider)`. An annotation is
 * `GtkSource.Annotation.new(description, icon, line, style)`.
 *
 * Run:  node src/poc/annotations.ts
 *   You should see grey/red/yellow/blue trailing text after lines 2, 4, 6, 8.
 *   Ctrl+R re-adds them (tests removeAll + re-add); type to confirm they track the line.
 */
import { Gtk, Gdk, Adw, GtkSource, GLib, Gio, startLoop } from '../gi.ts';

const SAMPLE = [
  'function add(a, b) {',
  '  const result = a + b;          // accent: inferred type',
  '  return reslt;',
  '  // ^ error: cannot find name "reslt"',
  '  const unused = 42;',
  '  // ^ warning: unused variable',
  '}',
  '',
  'add(1, 2);',
  '// trailing note here',
].join('\n');

const loop = GLib.MainLoop.new(null, false);
const app = new Adw.Application({
  applicationId: 'com.github.romgrk.quilx.poc.annotations',
  flags: Gio.ApplicationFlags.NON_UNIQUE,
});

app.on('activate', () => {
  try {
    Adw.StyleManager.getDefault().setColorScheme(Adw.ColorScheme.FORCE_DARK);
    const scheme = GtkSource.StyleSchemeManager.getDefault().getScheme('Adwaita-dark');

    const buffer = new GtkSource.Buffer();
    buffer.setText(SAMPLE, -1);
    if (scheme) buffer.setStyleScheme(scheme);
    const lang = GtkSource.LanguageManager.getDefault().getLanguage('js');
    if (lang) buffer.setLanguage(lang);

    const view: any = new GtkSource.View({ buffer, monospace: true });
    view.setShowLineNumbers(true);

    const Style: any = (GtkSource as any).AnnotationStyle;
    const A: any = (GtkSource as any).Annotation;
    const provider: any = new (GtkSource as any).AnnotationProvider();

    // [line (0-based), text, style]
    const annotations: [number, string, number][] = [
      [1, 'number', Style.ACCENT],
      [2, 'cannot find name "reslt"', Style.ERROR],
      [4, 'unused variable', Style.WARNING],
      [8, '→ returns 3', Style.NONE],
    ];
    const populate = () => {
      provider.removeAll();
      for (const [line, text, style] of annotations) provider.addAnnotation(A.new(text, null, line, style));
    };
    populate();
    view.getAnnotations().addProvider(provider);

    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number, _c: number, state: number) => {
      if ((state & Gdk.ModifierType.CONTROL_MASK) !== 0 && keyval === Gdk.KEY_r) {
        populate();
        return true;
      }
      return false;
    });
    view.addController(keys);

    const scrolled = new Gtk.ScrolledWindow();
    scrolled.setChild(view);
    const window = new Adw.ApplicationWindow({ application: app });
    window.setTitle('quilx POC — GtkSourceAnnotations (end-of-line virtual text)');
    window.setDefaultSize(720, 420);
    window.setContent(scrolled);
    window.on('close-request', () => { loop.quit(); app.quit(); return false; });
    window.present();
    view.grabFocus();

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
