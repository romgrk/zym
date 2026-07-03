#!/usr/bin/env node
/*
 * POC: the real WorkbenchList sidebar populated with MOCK agents, so the
 * status-icon rework (dot / loading / circle-outline per state) can be eyeballed
 * with several agents at once WITHOUT launching real ones. Nothing is
 * reimplemented: it mounts the production `src/ui/WorkbenchList.ts` verbatim and
 * registers stub `Agent`s through the real `zym.agents.add(...)`, so whatever the
 * list/`agentStatusIcon` render in the app shows up here.
 *
 * Run:  node --import node-gtk/register src/poc/workbench-list-gallery.ts
 *   (or set POC_SHOT=/path.png to render-to-PNG and exit, for headless capture.)
 */
import GLib from 'gi:GLib-2.0';
import Gio from 'gi:Gio-2.0';
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import { installStyles } from '../styles.ts';
import { registerBundledFonts, fonts } from '../fonts.ts';
import { theme } from '../theme/theme.ts';
import { zym } from '../zym.ts';
import { WorkbenchList } from '../ui/WorkbenchList.ts';
import { createProject } from '../ui/workbench/Owner.ts';
import type { Agent } from '../agents/types.ts';
import type { AgentStatus } from '../ui/AgentTerminal.ts';

const SIDEBAR_WIDTH = 280; // matches AppWindow's expanded sidebar

// A fully-typed, inert `Agent` — enough for the list/status icon to render. The
// list only reads `title` / `status` (+ their change subscriptions); the rest are
// benign defaults so no cast is needed.
function mockAgent(title: string, status: AgentStatus): Agent {
  const sub = () => () => {};
  return {
    root: new Gtk.Box(),
    title,
    status,
    permissionMode: 'default',
    changedFiles: [],
    sessionId: null,
    renamed: false,
    exited: status === 'disconnected',
    needsAttention: false,
    unannouncedWorktree: null,
    onTitleChange: sub,
    onDidChangeStatus: sub,
    onDidChangePermissionMode: sub,
    onDidChangeFiles: sub,
    onDidChangeWorktree: sub,
    onDidChangeAttention: sub,
    start() {},
    setViewed() {},
    clearUnannouncedWorktree() {},
    rename() {},
    bindActions() {},
    resume() {},
    kill() {},
    focus() {},
    deliver() {},
    serialize() { return null; },
    isModified() { return false; },
    getModifiedLabel() { return ''; },
  };
}

// One agent per status — the user row is always present on top automatically.
// `error` is POC-only for now (no production path emits it yet).
const AGENTS: Array<[string, AgentStatus]> = [
  ['fix-flaky-test', 'idle'],
  ['auth-refactor', 'working'],
  ['write-api-docs', 'waiting'],
  ['db-migration', 'disconnected'],
  ['broken-build', 'error'],
];

const loop = GLib.MainLoop.new(null, false);
const app = new Adw.Application({ applicationId: 'com.github.romgrk.zym.poc.workbenchlist', flags: Gio.ApplicationFlags.NON_UNIQUE });

app.on('activate', () => {
  try {
    registerBundledFonts();
    installStyles();
    fonts.init();
    Adw.StyleManager.getDefault().setColorScheme(
      theme.appearance === 'light' ? Adw.ColorScheme.FORCE_LIGHT : Adw.ColorScheme.FORCE_DARK,
    );

    // Register the mock agents before building the list so its initial render
    // includes them (already revealed, no animation).
    for (const [title, status] of AGENTS) zym.agents.add(mockAgent(title, status));

    const list = new WorkbenchList({
      onActivate: (a) => process.stderr.write(`[POC] activate ${a.title}\n`),
      onActivateProject: (p) => process.stderr.write(`[POC] activate project ${p.title}\n`),
      getGroups: () => [{ project: createProject(process.cwd()), agents: zym.agents.getAgents() }],
    });
    list.root.setSizeRequest(SIDEBAR_WIDTH, -1);

    // A placeholder "editor" area to the right, so the sidebar sits in context.
    const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    content.setHexpand(true);
    content.setName('PocContent');
    const hint = new Gtk.Label({ label: 'mock WorkbenchList — agent status icons' });
    hint.setVexpand(true);
    hint.addCssClass('dim-label');
    content.append(hint);

    const split = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    split.append(list.root);
    split.append(Gtk.Separator.new(Gtk.Orientation.VERTICAL));
    split.append(content);

    const window = new Adw.ApplicationWindow({ application: app });
    window.setName('AppWindow'); // so the --t-* theme CSS variables resolve
    window.setTitle('zym POC — WorkbenchList');
    window.setDefaultSize(720, 460);
    window.setContent(split);
    window.on('close-request', () => { loop.quit(); app.quit(); return false; });
    window.present();

    // Headless capture: render the realized widget tree through the window's own
    // GSK renderer to a Gdk.Texture and save it (the desktop screenshot portal is
    // blocked in sandboxed runs).
    const out = process.env.POC_SHOT;
    if (out) {
      GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, 450, () => {
        const w = window.getWidth() || 720;
        const h = window.getHeight() || 460;
        const paintable = Gtk.WidgetPaintable.new(window);
        const snapshot = Gtk.Snapshot.new();
        paintable.snapshot(snapshot, w, h);
        const node = snapshot.toNode();
        const renderer = window.getRenderer();
        if (node && renderer) {
          renderer.renderTexture(node, null).saveToPng(out);
          process.stderr.write(`[POC] wrote ${out} (${w}x${h})\n`);
        }
        loop.quit();
        app.quit();
        return GLib.SOURCE_REMOVE;
      });
    }

    loop.run();
  } catch (e) {
    process.stderr.write('[POC] activate threw: ' + (e as Error)?.stack + '\n');
    loop.quit();
    app.quit();
  }
});

// node-gtk #442: defer app.run past the top-level module microtask, or activate
// never fires and the app exits 0.
await new Promise((res) => setTimeout(res, 0));
app.run([]);
