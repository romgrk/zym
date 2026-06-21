#!/usr/bin/env node
/*
 * POC / GATE: measure the native per-line cost of the editor's gutter renderers.
 *
 * The text-editor doc (tasks/code-editing/text-editor.md → "Gutter rendering")
 * says the next native scroll lever is collapsing our FOUR GtkSourceGutterRenderer
 * subclasses (line-number + fold-chevron + git-bar + diagnostic-glyph) into fewer,
 * but gates it behind *measuring the gutter's native cost first*, because "the
 * PangoLayout cost is native + unmeasured" — it's the part the GtkSourceView
 * "Faster Numbers" work removed.
 *
 * Every GtkSourceGutterRendererText, per visible line per frame, sets markup on a
 * PangoLayout and renders it. The dominant CPU is the markup parse + glyph shaping
 * of that layout. This bench isolates exactly that, headless (no window / frame
 * clock — a background Wayland window gets throttled to zero frames, which makes a
 * live-scroll bench unreliable here): for each gutter configuration it rebuilds
 * the per-line PangoLayouts the way GtkSourceGutterRendererText does (one reused
 * layout per renderer, re-`setMarkup` per line, force layout via getSize) across a
 * simulated scroll, and reports CPU-per-frame.
 *
 *   custom-ln    our LineNumberRenderer alone               (1 layout/line)
 *   plain-ln     a markup-free number layout                (≈ floor for one column)
 *   custom-4     line-number + chevron + git + diag         (CURRENT: 4 layouts/line)
 *   composite-1  one renderer composing all four            (PROPOSED 4->1, display-only)
 *
 * The delta custom-4 -> composite-1 is the prize the collapse buys; per-line work
 * drops from 4 markup-parse+shape passes to 1. Markup strings are copied verbatim
 * from the real renderers (same <span>s, same ' ' on clean lines — the real
 * git/diag renderers emit a space per visible line, paying a layout regardless).
 *
 *   node src/poc/gutter-bench.ts
 */
import { createRequire } from 'node:module';
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const gi = require_('node-gtk') as typeof import('node-gtk');
const Pango = gi.require('Pango', '1.0');
const PangoCairo = gi.require('PangoCairo', '1.0');

// ---------------------------------------------------------------------------
// Pango setup — a monospace layout context, plus the bundled Nerd Font so the
// diagnostic glyph shapes the same as in-app (tofu would shape differently).
// ---------------------------------------------------------------------------
const fontMap: any = PangoCairo.FontMap.getDefault();
const fontDir = Path.join(Path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'fonts');
fontMap.addFontFile(Path.join(fontDir, 'SymbolsNerdFontMono-Regular.ttf'));
const ctx: any = fontMap.createContext();
const FONT = Pango.FontDescription.fromString('Monospace 11');
ctx.setFontDescription(FONT);
const makeLayout = (): any => { const l = (Pango.Layout as any).new(ctx); l.setFontDescription(FONT); return l; };

// ---------------------------------------------------------------------------
// Markup constants + per-line builders — copied verbatim from the real renderers.
// ---------------------------------------------------------------------------
const LINE_NUMBER_COLOR = '#636d83';
const GIT = ['#98c379', '#e5c07b', '#e06c75'];
const DIAG_COLOR = '#e06c75';
const ICON_FONT_FAMILY = 'Symbols Nerd Font Mono';
const BAR = '▏';
const DIAG_GLYPH = '';

const BUFFER_LINES = 6000;
const WIDTH = String(BUFFER_LINES).length;

const isFoldHeader = (line: number) => line % 15 === 0;
const gitColor = (line: number): string | null => {
  const m = line % 17;
  if (m === 0) return GIT[0];
  if (m === 3) return GIT[1];
  if (m === 11) return GIT[2];
  return null;
};
const hasDiag = (line: number) => line % 67 === 0;

const numStr = (line: number) => String(line + 1).padStart(WIDTH, ' ');
const numberMarkup = (line: number) => `<span foreground="${LINE_NUMBER_COLOR}">${numStr(line)}</span>`;
const plainNumber = (line: number) => numStr(line);
const chevronMarkup = (line: number) => (isFoldHeader(line) ? '▾' : ' ');
const gitMarkup = (line: number) => { const c = gitColor(line); return c ? `<span foreground="${c}">${BAR}</span>` : ' '; };
const diagMarkup = (line: number) =>
  hasDiag(line) ? `<span face="${ICON_FONT_FAMILY}" size="85%" foreground="${DIAG_COLOR}">${DIAG_GLYPH}</span>` : ' ';
const compositeMarkup = (line: number) =>
  `${gitMarkup(line)}<span foreground="${LINE_NUMBER_COLOR}">${numStr(line)}</span>${chevronMarkup(line)}${diagMarkup(line)}`;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const VISIBLE_LINES = 45; // a typical viewport
const FRAMES = 4000;
const WARMUP = 400;
const SCROLL_STEP = 3; // lines advanced per "frame"

type Config = { name: string; note: string; cols: ((line: number) => string)[] };
const CONFIGS: Config[] = [
  { name: 'plain-ln', note: 'markup-free number layout (~1-column floor)', cols: [plainNumber] },
  { name: 'custom-ln', note: 'our LineNumberRenderer alone (1 layout/line)', cols: [numberMarkup] },
  { name: 'custom-4', note: 'line-number + chevron + git + diag (CURRENT)', cols: [numberMarkup, chevronMarkup, gitMarkup, diagMarkup] },
  { name: 'composite-1', note: 'one composite renderer (PROPOSED 4->1)', cols: [compositeMarkup] },
];

function runConfig(cfg: Config): { cpuUsPerFrame: number; cpuUsPerLineLayout: number } {
  const layouts = cfg.cols.map(() => makeLayout());
  const oneFrame = (f: number) => {
    const base = (f * SCROLL_STEP) % (BUFFER_LINES - VISIBLE_LINES);
    for (let row = 0; row < VISIBLE_LINES; row++) {
      const line = base + row;
      for (let i = 0; i < layouts.length; i++) {
        layouts[i].setMarkup(cfg.cols[i](line), -1);
        layouts[i].getSize(); // force markup parse + shaping
      }
    }
  };
  for (let f = 0; f < WARMUP; f++) oneFrame(f);
  const c0 = process.cpuUsage();
  for (let f = 0; f < FRAMES; f++) oneFrame(f);
  const c = process.cpuUsage(c0); // microseconds (user+system)
  const total = c.user + c.system;
  return {
    cpuUsPerFrame: total / FRAMES,
    cpuUsPerLineLayout: total / (FRAMES * VISIBLE_LINES * layouts.length),
  };
}

// Run each config several times and keep the MIN (least perturbed by GC / CPU
// frequency ramp — the cleanest estimate of the pure layout cost).
const REPS = 5;
const results = CONFIGS.map((cfg) => {
  let best = { cpuUsPerFrame: Infinity, cpuUsPerLineLayout: Infinity };
  for (let r = 0; r < REPS; r++) {
    const m = runConfig(cfg);
    if (m.cpuUsPerFrame < best.cpuUsPerFrame) best = m;
  }
  return { cfg, ...best };
});

const pad = (s: string, n: number) => s.padEnd(n);
let out = '';
const emit = (s: string) => { out += s + '\n'; console.log(s); };

emit('\n=== gutter-bench (headless Pango layout cost) ===');
emit(`buffer=${BUFFER_LINES} visible=${VISIBLE_LINES} frames=${FRAMES} warmup=${WARMUP}\n`);
emit([pad('config', 13), pad('cpu µs/frame', 14), pad('µs/line·layout', 16), 'note'].join(' '));
for (const r of results)
  emit([pad(r.cfg.name, 13), pad(r.cpuUsPerFrame.toFixed(1), 14), pad(r.cpuUsPerLineLayout.toFixed(3), 16), r.cfg.note].join(' '));

const cur = results.find((r) => r.cfg.name === 'custom-4')!;
const prop = results.find((r) => r.cfg.name === 'composite-1')!;
const saved = cur.cpuUsPerFrame - prop.cpuUsPerFrame;
const pct = (saved / cur.cpuUsPerFrame) * 100;
emit('\n  4->1 collapse (display-only):');
emit(`    current 4-renderer : ${cur.cpuUsPerFrame.toFixed(1)} µs/frame`);
emit(`    composite 1        : ${prop.cpuUsPerFrame.toFixed(1)} µs/frame`);
emit(`    saved              : ${saved.toFixed(1)} µs/frame (${pct.toFixed(0)}%)`);
emit(`\n  @60Hz frame budget = 16667 µs; gutter layout is ${(cur.cpuUsPerFrame / 16667 * 100).toFixed(2)}% today,`);
emit(`  ${(prop.cpuUsPerFrame / 16667 * 100).toFixed(2)}% after the collapse (per ${VISIBLE_LINES}-line viewport).`);
emit('');
try { Fs.writeFileSync('/tmp/gutter-bench.txt', out); } catch { /* best-effort */ }
