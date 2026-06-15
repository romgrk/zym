/*
 * diff-demo — a standalone window to eyeball the diff viewer (DiffView /
 * SideBySideDiffView), which aren't wired into the app yet.
 *
 *   node scripts/diff-demo.ts                 # built-in sample diff
 *   node scripts/diff-demo.ts OLD NEW         # diff two files
 *
 * A header-bar switcher flips between the unified and side-by-side renderers.
 */
import * as Fs from 'node:fs';
import { Adw, Gio, GLib, Gtk, startLoop } from '../src/gi.ts';
import { registerBundledFonts } from '../src/fonts.ts';
import { installStyles } from '../src/styles.ts';
import { computeDiff } from '../src/util/DiffModel.ts';
import { DiffView } from '../src/ui/TextEditor/DiffView.ts';
import { SideBySideDiffView } from '../src/ui/TextEditor/SideBySideDiffView.ts';

const SAMPLE_OLD = `function greet(name) {
  const msg = "hi, " + name;
  console.log(msg);
  return msg;
}

const removedLine = true;
const shared = 42;`;

const SAMPLE_NEW = `function greet(name, loud) {
  const msg = "hello, " + name;
  if (loud) console.log(msg.toUpperCase());
  console.log(msg);
  return msg;
}

const shared = 42;`;

const [oldPath, newPath] = process.argv.slice(2);
const oldText = oldPath ? Fs.readFileSync(oldPath, 'utf8') : SAMPLE_OLD;
const newText = newPath ? Fs.readFileSync(newPath, 'utf8') : SAMPLE_NEW;

const loop = GLib.MainLoop.new(null, false);
const app = new Adw.Application({ applicationId: 'dev.quilx.diffdemo', flags: Gio.ApplicationFlags.NON_UNIQUE });

app.on('activate', () => {
  registerBundledFonts();
  installStyles();

  const model = computeDiff(oldText, newText);
  const unified = new DiffView(model);
  const sideBySide = new SideBySideDiffView(model);

  const stack = new Gtk.Stack();
  stack.addTitled(unified.root, 'unified', 'Unified');
  stack.addTitled(sideBySide.root, 'sbs', 'Side by side');

  const switcher = new Gtk.StackSwitcher();
  switcher.setStack(stack);
  const header = new Adw.HeaderBar();
  header.setTitleWidget(switcher);

  const toolbar = new Adw.ToolbarView();
  toolbar.addTopBar(header);
  toolbar.setContent(stack);

  const win = new Adw.ApplicationWindow({ application: app, defaultWidth: 1000, defaultHeight: 600 });
  (win as any).setContent(toolbar);
  win.present();

  startLoop();
  loop.run();
});

app.run([]);
