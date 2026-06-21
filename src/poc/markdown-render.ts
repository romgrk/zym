#!/usr/bin/env node
/*
 * POC: render the markdown fixture through MarkdownView in a faux conversation
 * transcript, so the message typography can be iterated on WITHOUT spawning an
 * agent. It mirrors AgentConversation's transcript chrome (the Adw.Clamp column,
 * the assistant/user bubbles, the larger transcript font) but owns none of the
 * session machinery — just MarkdownView + static markdown.
 *
 * The markdown-specific styles (.zym-md-*, line height, block gaps, code blocks,
 * the inline-code tint) come for free: importing MarkdownView runs its module-level
 * addStyles. Only the conversation wrapper CSS is replicated below; if you change
 * those values in AgentConversation, mirror them here to keep the preview honest.
 *
 * Run:  node src/poc/markdown-render.ts
 *       node src/poc/markdown-render.ts path/to/other.md
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gtk, Adw, Gio, GLib, startLoop } from '../gi.ts';
import { addStyles, installStyles } from '../styles.ts';
import { registerBundledFonts, fonts } from '../fonts.ts';
import { theme } from '../theme/theme.ts';
import { MarkdownView } from '../ui/markdown/MarkdownView.ts';
import { registerBuiltinPlugins } from '../plugin/index.ts';
import { plugins } from '../plugin/index.ts';
import { preloadGrammars } from '../syntax/grammar.ts';

// The conversation wrapper CSS, copied from AgentConversation so the preview reads
// like a real transcript. (MarkdownView's own .zym-md-* styles arrive via import.)
addStyles(`
  .zym-conversation { background: var(--t-ui-editor-background); color: var(--t-ui-editor-foreground); }
  .zym-conversation-transcript { padding: 16px; font-size: 1.05em; }
  .zym-conversation-user, .zym-conversation-assistant {
    padding: 14px 18px;
    margin: 10px 0;
    border-radius: 10px;
  }
  .zym-conversation-user { background: var(--t-ui-surface-selected); }
  .zym-conversation-assistant { background: var(--t-ui-surface-popover); }
`);

const here = Path.dirname(fileURLToPath(import.meta.url));
const fixturePath = process.argv[2] ? Path.resolve(process.argv[2]) : Path.join(here, 'markdown-sample.md');

function bubble(cssClass: string, align: number, md: string): InstanceType<typeof Gtk.Box> {
  const view = new MarkdownView();
  view.setMarkdown(md);
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  box.addCssClass(cssClass);
  box.setHalign(align);
  box.append(view.root);
  return box;
}

const loop = GLib.MainLoop.new(null, false);
const app = new Adw.Application({ applicationId: 'com.github.romgrk.zym.poc.markdown', flags: Gio.ApplicationFlags.NON_UNIQUE });

app.on('activate', () => {
  try {
    registerBundledFonts();
    installStyles();
    fonts.init();
    Adw.StyleManager.getDefault().setColorScheme(
      theme.appearance === 'light' ? Adw.ColorScheme.FORCE_LIGHT : Adw.ColorScheme.FORCE_DARK,
    );

    const md = Fs.readFileSync(fixturePath, 'utf8');

    const messages = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    messages.addCssClass('zym-conversation-transcript');
    messages.append(bubble('zym-conversation-user', Gtk.Align.END, 'Render every markdown construct so I can check the typography.'));
    messages.append(bubble('zym-conversation-assistant', Gtk.Align.START, md));

    // Same column cap as the real transcript: an Adw.Clamp pinned to the left.
    const clamp = new Adw.Clamp();
    clamp.setMaximumSize(820);
    clamp.setTighteningThreshold(820);
    clamp.setHalign(Gtk.Align.START);
    clamp.setChild(messages);

    const scroller = new Gtk.ScrolledWindow({ vexpand: true });
    scroller.setChild(clamp);

    const root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    root.addCssClass('zym-conversation');
    root.append(scroller);

    const window = new Adw.ApplicationWindow({ application: app });
    window.setName('AppWindow'); // so the --t-* theme CSS variables resolve
    window.setTitle('zym POC — MarkdownView typography');
    window.setDefaultSize(1000, 800);
    window.setContent(root);
    window.on('close-request', () => { loop.quit(); app.quit(); return false; });
    window.present();

    startLoop();
    loop.run();
  } catch (e) {
    process.stderr.write('[POC] activate threw: ' + (e as Error)?.stack + '\n');
    loop.quit();
    app.quit();
  }
});

// Register grammars before the loop so fenced code blocks syntax-highlight (the TS
// plugin contributes the ts/js grammar; unsupported langs fall back to plain mono).
registerBuiltinPlugins();
await plugins.activateAll();
await preloadGrammars();

// node-gtk #442: defer app.run past the top-level module microtask, or activate
// never fires and the app exits 0.
await new Promise((res) => setTimeout(res, 0));
app.run([]);
