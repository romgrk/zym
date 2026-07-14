#!/usr/bin/env node
/*
 * BENCH: type into the REAL app and measure per-keystroke cost.
 *
 * Same bootstrap as scroll-real.ts (real Application → AppWindow → TextEditor on a
 * real file); after the window settles it places the cursor mid-file, enters vim
 * insert mode, and types through the editor model (the same buffer-insert entry
 * the IM commit path drives) in BURSTS separated by pauses — real typing pauses
 * constantly, and the pauses are what let debounced work (git gutter re-diff,
 * completion query, reparse) fire and stall the next keystroke. It times:
 *   - the synchronous cost of each insert (every buffer-change subscriber that
 *     runs in the signal handlers), and
 *   - each keystroke's lateness vs its planned time (catches debounced work +
 *     GC pauses that stall the loop between keystrokes).
 *
 *   node --import node-gtk/register src/poc/typing-bench.ts <file>
 *   TYPE_PROF=/tmp/typing.cpuprofile node --import node-gtk/register src/poc/typing-bench.ts <file>
 */
import * as Path from 'node:path';
import * as Fs from 'node:fs';
import * as inspector from 'node:inspector';
import { Application } from '../application.ts';
import { preloadGrammars } from '../syntax/grammar.ts';
import { plugins, registerBuiltinPlugins, loadUserPlugins, disabledPluginIds } from '../plugin/index.ts';
import { installGitBlame } from '../ui/TextEditor/GitBlameController.ts';
import { zym } from '../zym.ts';

const COUNT = Number(process.env.TYPE_COUNT || 600);
const INTERVAL_MS = Number(process.env.TYPE_INTERVAL || 45);
const BURST = Number(process.env.TYPE_BURST || 12); // keystrokes per burst
const PAUSE_MS = Number(process.env.TYPE_PAUSE || 250); // gap between bursts
const PROF_OUT = process.env.TYPE_PROF;

// Realistic code-ish keystrokes, including newlines and trigger-prone chars.
const TEXT = 'const value = compute(index) + offset; // note\n';

process.on('unhandledRejection', (reason) => {
  if ((reason as { code?: string } | null)?.code === 'ERR_STREAM_DESTROYED') return;
  console.error('Unhandled promise rejection:', reason);
});

const arg = process.argv[2];
if (!arg) { console.error('usage: typing-bench.ts <file>'); process.exit(1); }
const initialFile = Path.resolve(arg);

registerBuiltinPlugins();
await loadUserPlugins();
await plugins.activateAll(disabledPluginIds());
installGitBlame();
await preloadGrammars();

new Application(initialFile).run();

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
  try {
    const w = zym.window as any;
    w?.present?.();
    view.grabFocus?.();
  } catch { /* best-effort */ }

  const model = (editor as any).model;
  const targetRow = Number(process.env.TYPE_LINE || Math.floor(model.getLineCount() / 3));
  model.setCursorBufferPosition({ row: targetRow, column: 0 });
  view.scrollToMark?.(view.getBuffer().getInsert(), 0, true, 0.0, 0.5);
  zym.commands.dispatch(view, 'vim-mode-plus:activate-insert-mode');
  setTimeout(() => drive(model), 300); // let the mode switch + scroll settle
}, 100);
setTimeout(() => { if (!started) { console.error('editor never became ready'); process.exit(2); } }, 15000);

function drive(model: any): void {
  const session = PROF_OUT ? new inspector.Session() : null;
  if (session) {
    session.connect();
    session.post('Profiler.enable');
    session.post('Profiler.setSamplingInterval', { interval: 200 }); // µs
    session.post('Profiler.start');
  }

  const syncMs: number[] = [];
  const lateMs: number[] = []; // keystroke lateness vs planned time (loop stalls)
  const startCpu = process.cpuUsage();
  const startWall = nowMs();
  let i = 0;

  const step = () => {
    const planned = INTERVAL_MS + (i > 0 && i % BURST === 0 ? PAUSE_MS : 0);
    const scheduledAt = nowMs();
    setTimeout(() => {
      lateMs.push(nowMs() - scheduledAt - planned);

      const ch = TEXT[i % TEXT.length];
      const s0 = nowMs();
      model.insertText(ch);
      const s1 = nowMs();
      syncMs.push(s1 - s0);

      if (++i >= COUNT) {
        report(syncMs, lateMs, process.cpuUsage(startCpu), nowMs() - startWall, session);
      } else {
        step();
      }
    }, planned);
  };
  step();
}

function report(syncMs: number[], lateMs: number[], cpu: NodeJS.CpuUsage, wall: number, session: inspector.Session | null): void {
  const sorted = [...syncMs].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const over = (arr: number[], ms: number) => arr.filter(v => v > ms).length;
  console.log('TYPE_BENCH ' + JSON.stringify({
    file: initialFile,
    keystrokes: syncMs.length,
    intervalMs: INTERVAL_MS,
    burst: BURST,
    pauseMs: PAUSE_MS,
    syncAvgMs: +(syncMs.reduce((a, b) => a + b, 0) / syncMs.length).toFixed(3),
    syncP50Ms: +q(0.5).toFixed(3),
    syncP95Ms: +q(0.95).toFixed(3),
    syncMaxMs: +Math.max(...syncMs).toFixed(1),
    syncOver25ms: over(syncMs, 25),
    syncOver100ms: over(syncMs, 100),
    syncOver250ms: over(syncMs, 250),
    lateMaxMs: +Math.max(...lateMs).toFixed(1),
    lateOver25ms: over(lateMs, 25),
    lateOver100ms: over(lateMs, 100),
    lateOver250ms: over(lateMs, 250),
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

function nowMs(): number { const [s, ns] = process.hrtime(); return s * 1000 + ns / 1e6; }
