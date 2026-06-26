/*
 * Headless check for the SyntaxController integration: parse a JS buffer,
 * confirm highlighting captures + fold regions, exercise the vim `za` key path,
 * and prove folding shrinks the rendered height. Uses a unique app id so it
 * isn't deduped into an already-running zym instance.
 *
 *   node src/syntax/verify.ts
 */
import { createRequire } from 'node:module';
import { Adw, GLib, Gtk, GtkSource } from '../gi.ts';
import { SyntaxController } from './SyntaxController.ts';
import { preloadGrammars } from './grammar.ts';

await preloadGrammars(); // before the GLib loop, like the real entry point

const SAMPLE = `import { readFile } from 'node:fs/promises';
const CONFIG = { name: 'zym', features: ['highlight', 'fold'] };
async function loadDocument(path) {
  const text = await readFile(path, 'utf8');
  if (text.length === 0) {
    throw new Error('empty');
  }
  return { path, text };
}
class Editor {
  constructor(config) {
    this.config = config;
    this.docs = new Map();
  }
}
`;

const loop = GLib.MainLoop.new(null, false);
const app = new Adw.Application({ applicationId: 'com.github.romgrk.zym.verify' });

app.on('activate', () => {
  const buffer = new GtkSource.Buffer();
  const view = new GtkSource.View({ buffer });
  const syntax = new SyntaxController(view, buffer);

  const win = new Adw.ApplicationWindow({ application: app });
  win.setDefaultSize(600, 500);
  const scrolled = new Gtk.ScrolledWindow();
  scrolled.setChild(view);
  win.setContent(scrolled);
  win.present();

  buffer.setText(SAMPLE, -1);
  buffer.placeCursor(buffer.getStartIter());

  const handled = syntax.setLanguageForPath('/tmp/sample.js');
  const natHeight = () => view.measure(Gtk.Orientation.VERTICAL, -1)[1];

  {
    setTimeout(() => {
      const before = natHeight();
      const regions = syntax.foldsByHeaderLine.size;
      const captureBefore = syntax.captureCounts();

      // Exercise the fold path: cursor into loadDocument's body, then za (toggle
      // fold at cursor). The vim keymap's z-prefix dispatches this method.
      buffer.placeCursor(buffer.getIterAtLine(3)[1]);
      syntax.toggleFoldAtCursor();

      // Live edit: insert a line. This fires insert-text → the controller records
      // a tree edit → 'changed' → a debounced incremental reparse. The new
      // `42` literal should appear as an extra @number capture.
      buffer.insert(buffer.getEndIter(), '\nconst answer = 42;\n', -1);

      setTimeout(() => {
        const afterZa = natHeight();
        const captureAfterEdit = syntax.captureCounts();
        syntax.foldAll();
        setTimeout(() => {
          const afterAll = natHeight();
          console.log(JSON.stringify({
            grammarHandled: handled,
            foldRegions: regions,
            captureBefore,
            captureAfterEdit,
            incrementalEditPickedUpNumber:
              (captureAfterEdit.number ?? 0) > (captureBefore.number ?? 0),
            zaShrankHeight: afterZa < before,
            foldAllShrankHeight: afterAll < afterZa,
            heights: { before, afterZa, afterAll },
          }, null, 2));
          loop.quit();
          app.quit();
        }, 400);
      }, 400);
    }, 400);
  }

  setTimeout(() => { loop.quit(); app.quit(); }, 5000);

  createRequire(import.meta.url)('node-gtk').startLoop();
  loop.run();
});

process.exit(app.run([]));
