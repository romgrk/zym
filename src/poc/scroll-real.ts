#!/usr/bin/env node
/*
 * BENCH: drive a continuous scroll through the REAL app and measure per-frame cost.
 *
 * This is `src/index.ts` verbatim (same plugin/grammar/git bootstrap, same real
 * Application → AppWindow → TextEditor on a real file) plus a scroll driver: after
 * the window settles it grabs the active editor's GtkSourceView and advances its
 * vadjustment one step per frame-clock tick, timing the work, then prints stats.
 *
 *   node --import node-gtk/register src/poc/scroll-real.ts <file>
 *   node --cpu-prof --cpu-prof-dir=/tmp/zym-prof --import node-gtk/register src/poc/scroll-real.ts <file>
 */
import * as Path from 'node:path';
import * as Fs from 'node:fs';
import * as inspector from 'node:inspector';
import Gtk from 'gi:Gtk-4.0';
import Graphene from 'gi:Graphene-1.0';
import { Application } from '../application.ts';
import { preloadGrammars } from '../syntax/grammar.ts';
import { plugins, registerBuiltinPlugins, loadUserPlugins, disabledPluginIds } from '../plugin/index.ts';
import { installGitBlame } from '../ui/TextEditor/GitBlameController.ts';
import { zym } from '../zym.ts';

const STEP_PX = Number(process.env.SCROLL_STEP || 6);
const FRAMES = Number(process.env.SCROLL_FRAMES || 1200);

process.on('unhandledRejection', (reason) => {
  if ((reason as { code?: string } | null)?.code === 'ERR_STREAM_DESTROYED') return;
  console.error('Unhandled promise rejection:', reason);
});

const arg = process.argv[2];
if (!arg) { console.error('usage: scroll-real.ts <file>'); process.exit(1); }
const initialFile = Path.resolve(arg);

registerBuiltinPlugins();
await loadUserPlugins();
await plugins.activateAll(disabledPluginIds());
installGitBlame();
await preloadGrammars();

new Application(initialFile).run();

// Scroll driver. A background window's frame clock is throttled to ~0 ticks, so
// addTickCallback can't drive this; use a timer (fires regardless of mapping) and
// queueDraw each step so the view still validates/lays out the scrolled lines
// (the painter's visibleRange depends on real line geometry). Poll until the
// editor exists AND its content is laid out (upper > page) before starting.
let started = false;
const ready = setInterval(() => {
  const editor = zym.workspace.getActiveTextEditor();
  const view = editor?.sourceView as any;
  const vadj = view?.getVadjustment?.();
  if (!vadj) return;
  if (vadj.getUpper() <= vadj.getPageSize() + 1) return; // not laid out yet
  if (started) return;
  started = true;
  clearInterval(ready);
  if (process.env.SCROLL_NO_INDENT) zym.config.set('editor.indentGuides', false);
  if (process.env.SCROLL_SHOT) { shoot(view, String(process.env.SCROLL_SHOT)); return; }
  if (process.env.SCROLL_HOLD) {
    const win: any = zym.window;
    try { win?.fullscreen?.(); win?.present?.(); view.grabFocus?.(); } catch { /* best-effort */ }
    const a = view.getVadjustment();
    a.setValue(Math.min(a.getUpper() / 3, a.getUpper() - a.getPageSize()));
    view.queueDraw();
    return; // keep running; a screenshot is taken externally
  }
  try {
    const w = zym.window as any;
    if (process.env.SCROLL_FULLSCREEN) w?.fullscreen?.();
    w?.present?.();
    view.grabFocus?.();
  } catch { /* best-effort */ }
  drive(view, vadj);
}, 100);
setTimeout(() => { if (!started) { console.error('editor never became ready'); process.exit(2); } }, 15000);

const PROF_OUT = process.env.SCROLL_PROF; // path to write an isolated scroll-only cpuprofile
function drive(view: any, vadj: any): void {
  const session = PROF_OUT ? new inspector.Session() : null;
  if (session) {
    session.connect();
    session.post('Profiler.enable');
    session.post('Profiler.setSamplingInterval', { interval: 200 }); // µs
    session.post('Profiler.start');
  }
  let syncTotalMs = 0, syncMax = 0, syncSamples = 0;
  const startCpu = process.cpuUsage();
  const startWall = nowMs();
  let frames = 0, lastFrameWall = nowMs(), frameTotal = 0, frameMax = 0, dir = 1, slow = 0;
  // Count real frame-clock ticks in parallel: if >0, the window is actually
  // rendering (not throttled), so native render cost is being exercised.
  let clockTicks = 0;
  view.addTickCallback(() => { clockTicks++; return true; });

  const tick = setInterval(() => {
    const t = nowMs();
    if (frames > 0) {
      const gap = t - lastFrameWall;
      frameTotal += gap; if (gap > frameMax) frameMax = gap; if (gap > 25) slow++;
    }
    lastFrameWall = t;

    const upper = vadj.getUpper() - vadj.getPageSize();
    let v = vadj.getValue() + dir * STEP_PX;
    if (v >= upper) { v = upper; dir = -1; } else if (v <= 0) { v = 0; dir = 1; }

    const s0 = nowMs();
    vadj.setValue(v);        // value-changed → all scroll handlers (synchronous)
    // Default: rely on setValue's NATURAL invalidation (real scrolling translates
    // cached line nodes + repaints only newly-exposed lines/gutter/overlays).
    // SCROLL_FORCE_DRAW forces a full-viewport repaint (worst case / upper bound).
    if (process.env.SCROLL_FORCE_DRAW) view.queueDraw();
    const s1 = nowMs();
    syncTotalMs += s1 - s0; if (s1 - s0 > syncMax) syncMax = s1 - s0; syncSamples++;

    if (++frames >= FRAMES) {
      clearInterval(tick);
      const cpu = process.cpuUsage(startCpu);
      const wall = nowMs() - startWall;
      console.log('SCROLL_BENCH ' + JSON.stringify({
        file: initialFile,
        frames, stepPx: STEP_PX,
        frameClockTicks: clockTicks,
        frameClockFps: +(clockTicks / (wall / 1000)).toFixed(1),
        timerStepsPerSec: +(frames / (wall / 1000)).toFixed(1),
        stepGapAvgMs: +(frameTotal / (frames - 1)).toFixed(3),
        stepGapMaxMs: +frameMax.toFixed(1),
        slowStepsGt25ms: slow,
        syncValueChangedAvgMs: +(syncTotalMs / syncSamples).toFixed(4),
        syncValueChangedMaxMs: +syncMax.toFixed(4),
        cpuUserMs: +(cpu.user / 1000).toFixed(1),
        cpuSystemMs: +(cpu.system / 1000).toFixed(1),
        cpuPctOfWall: +(((cpu.user + cpu.system) / 1000 / wall) * 100).toFixed(1),
      }));
      if (session) {
        session.post('Profiler.stop', (err, { profile }) => {
          if (!err) Fs.writeFileSync(PROF_OUT!, JSON.stringify(profile));
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    }
  }, 16);
}

function nowMs(): number { const [s, ns] = process.hrtime(); return s * 1000 + ns / 1e6; }

// Render the live view to a PNG (WidgetPaintable, like gutter-visual.ts) so the
// indent guides / squiggles / current-line highlight can be eyeballed.
function shoot(view: any, path: string): void {
  const win: any = zym.window;
  try { win?.fullscreen?.(); win?.present?.(); view.grabFocus?.(); } catch { /* best-effort */ }
  const target = process.env.SCROLL_SHOT_WIN ? win : view;
  // Create the paintable up front so it caches the widget's rendered frames.
  const paintable: any = Gtk.WidgetPaintable.new(target);
  const frac = Number(process.env.SCROLL_SHOT_FRAC || 0.5);
  let ticks = 0;
  view.addTickCallback(() => {
    if (view.getHeight() <= 0) return true;
    const adj = view.getVadjustment();
    view.queueDraw();
    ticks++;
    // Apply the scroll only once the full content height has settled (the view lays
    // out lazily, so `upper` grows over the first frames), then put the cursor on a
    // visible line so the current-line highlight is in frame; render a few more frames
    // so the paintable caches the scrolled content.
    if (ticks === 30) {
      try {
        const buffer = view.getBuffer();
        if (process.env.SCROLL_SHOT_LINE) {
          const line = Number(process.env.SCROLL_SHOT_LINE);
          const r = buffer.getIterAtLine(line);
          const iter = Array.isArray(r) ? r[r.length - 1] : r;
          buffer.placeCursor(iter);
          view.scrollToIter(iter, 0, true, 0.0, 0.5); // center the line
        } else {
          adj.setValue(Math.min(adj.getUpper() * frac, adj.getUpper() - adj.getPageSize()));
          const r = view.getLineAtY(view.getVisibleRect().y + view.getVisibleRect().height / 2);
          buffer.placeCursor(Array.isArray(r) ? r[0] : r);
        }
      } catch { /* best-effort */ }
    }
    if (ticks < 45) return true;
    try {
      process.stderr.write(`[shot] final value=${adj.getValue().toFixed(0)} upper=${adj.getUpper().toFixed(0)}\n`);
      const w = target.getWidth() || 1000, h = target.getHeight() || 900;
      const snapshot: any = Gtk.Snapshot.new();
      paintable.snapshot(snapshot, w, h);
      const node = snapshot.toNode();
      process.stderr.write(`[shot] mapped=${target.getMapped?.()} ${w}x${h} node=${!!node} intrinsic=${paintable.getIntrinsicWidth?.()}x${paintable.getIntrinsicHeight?.()}\n`);
      if (node) {
        const rect: any = new Graphene.Rect(); rect.init(0, 0, w, h);
        win.getRenderer().renderTexture(node, rect).saveToPng(path);
        process.stderr.write(`[shot] wrote ${path} (${w}x${h})\n`);
      }
    } catch (e) { process.stderr.write('[shot] failed: ' + (e as Error).stack + '\n'); }
    process.exit(0);
    return false;
  });
}
