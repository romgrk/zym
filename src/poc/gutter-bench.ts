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
 *   plain-ln       a markup-free (setText) number layout      (≈ floor for one column)
 *   custom-ln      our LineNumberRenderer alone               (1 markup layout/line)
 *   custom-4       line-number + chevron + git + diag         (the original 4 renderers)
 *   composite-1    one renderer composing all four as markup  (the PREVIOUS setMarkup gutter)
 *   composite-snap snapshot renderer: setText number + markup ONLY on non-empty cells (NEW)
 *
 * Two deltas: custom-4 -> composite-1 is the already-shipped 4->1 collapse; the new
 * lever is composite-1 -> composite-snap, which drops the per-line markup PARSE for the
 * line-number column (setText instead of setMarkup) and builds a layout for the git /
 * chevron / diagnostic cells only on the few lines that have one (the old composite paid
 * a space-layout on every clean line). Markup strings are copied from the real renderers.
 *
 * CAVEAT — this bench measures ONLY Pango layout cost (setMarkup/setText + shaping). It
 * does NOT count the FFI the snapshot renderer adds: composite-1 (GtkSourceGutterRenderer-
 * Text) draws in C with one JS callback/line (queryData); composite-snap draws from JS, so
 * each line crosses JS->C ~6x (alignCell + save + translate + appendLayout + restore, plus
 * the Point alloc). Measured separately, that draw sequence is ~165-210 us/frame for the
 * number column alone (~3.7-4.7 us/line) — which OUTWEIGHS composite-snap's ~51 us layout
 * saving. So composite-snap is a net perf REGRESSION; its justification is control (custom
 * drawing beside decorations, future clickability), not speed.
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

// Snapshot-renderer per-line work: a plain-TEXT number every line (no markup parse),
// plus a markup layout ONLY on the lines carrying a git bar / chevron / diagnostic —
// `null` means draw nothing (the old composite paid a space-layout on every clean line).
const gitOrNull = (line: number) => { const c = gitColor(line); return c ? `<span foreground="${c}">${BAR}</span>` : null; };
const chevronOrNull = (line: number) =>
  isFoldHeader(line) ? `<span face="${ICON_FONT_FAMILY}" size="75%" foreground="${LINE_NUMBER_COLOR}">▾</span>` : null;
const diagOrNull = (line: number) =>
  hasDiag(line) ? `<span face="${ICON_FONT_FAMILY}" size="85%" foreground="${DIAG_COLOR}">${DIAG_GLYPH}</span>` : null;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const VISIBLE_LINES = 45; // a typical viewport
const FRAMES = 4000;
const WARMUP = 400;
const SCROLL_STEP = 3; // lines advanced per "frame"

// A column either builds Pango MARKUP (parsed per draw) or plain TEXT (no parse);
// `build` returning null means the cell is empty and draws nothing at all.
type Col = { build: (line: number) => string | null; markup: boolean };
const mk = (build: (line: number) => string | null): Col => ({ build, markup: true });
const txt = (build: (line: number) => string | null): Col => ({ build, markup: false });

type Config = { name: string; note: string; cols: Col[] };
const CONFIGS: Config[] = [
  { name: 'plain-ln', note: 'markup-free number layout (~1-column floor)', cols: [txt(plainNumber)] },
  { name: 'custom-ln', note: 'our LineNumberRenderer alone (1 layout/line)', cols: [mk(numberMarkup)] },
  { name: 'custom-4', note: 'line-number + chevron + git + diag (the original 4 renderers)', cols: [mk(numberMarkup), mk(chevronMarkup), mk(gitMarkup), mk(diagMarkup)] },
  { name: 'composite-1', note: 'one markup composite (the setMarkup gutter, PREVIOUS)', cols: [mk(compositeMarkup)] },
  { name: 'composite-snap', note: 'snapshot renderer: text number + markup only on non-empty cells (NEW)', cols: [txt(plainNumber), mk(gitOrNull), mk(chevronOrNull), mk(diagOrNull)] },
];

function runConfig(cfg: Config): { cpuUsPerFrame: number; cpuUsPerLineLayout: number } {
  const layouts = cfg.cols.map(() => makeLayout());
  let built = 0;
  const oneFrame = (f: number) => {
    const base = (f * SCROLL_STEP) % (BUFFER_LINES - VISIBLE_LINES);
    for (let row = 0; row < VISIBLE_LINES; row++) {
      const line = base + row;
      for (let i = 0; i < layouts.length; i++) {
        const s = cfg.cols[i].build(line);
        if (s === null) continue; // empty cell — no layout built (snapshot renderer)
        if (cfg.cols[i].markup) layouts[i].setMarkup(s, -1);
        else layouts[i].setText(s, -1);
        layouts[i].getSize(); // force (markup parse +) shaping
        built++;
      }
    }
  };
  for (let f = 0; f < WARMUP; f++) oneFrame(f);
  built = 0;
  const c0 = process.cpuUsage();
  for (let f = 0; f < FRAMES; f++) oneFrame(f);
  const c = process.cpuUsage(c0); // microseconds (user+system)
  const total = c.user + c.system;
  return {
    cpuUsPerFrame: total / FRAMES,
    cpuUsPerLineLayout: built ? total / built : 0, // per layout ACTUALLY built
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

const four = results.find((r) => r.cfg.name === 'custom-4')!;
const composite = results.find((r) => r.cfg.name === 'composite-1')!;
const snap = results.find((r) => r.cfg.name === 'composite-snap')!;
const delta = (from: number, to: number) => `${(from - to).toFixed(1)} µs/frame (${((from - to) / from * 100).toFixed(0)}%)`;
const budget = (us: number) => `${(us / 16667 * 100).toFixed(2)}%`;

emit('\n  4 renderers -> 1 markup composite (already shipped):');
emit(`    custom-4          : ${four.cpuUsPerFrame.toFixed(1)} µs/frame`);
emit(`    composite-1       : ${composite.cpuUsPerFrame.toFixed(1)} µs/frame   saved ${delta(four.cpuUsPerFrame, composite.cpuUsPerFrame)}`);

emit('\n  markup composite -> snapshot renderer (THIS change):');
emit(`    composite-1       : ${composite.cpuUsPerFrame.toFixed(1)} µs/frame   (setMarkup every line)`);
emit(`    composite-snap    : ${snap.cpuUsPerFrame.toFixed(1)} µs/frame   saved ${delta(composite.cpuUsPerFrame, snap.cpuUsPerFrame)}`);

emit(`\n  cumulative custom-4 -> snapshot: saved ${delta(four.cpuUsPerFrame, snap.cpuUsPerFrame)}`);
emit(`\n  @60Hz frame budget = 16667 µs (per ${VISIBLE_LINES}-line viewport):`);
emit(`    custom-4 ${budget(four.cpuUsPerFrame)}  ->  composite-1 ${budget(composite.cpuUsPerFrame)}  ->  snapshot ${budget(snap.cpuUsPerFrame)}`);
emit('');
try { Fs.writeFileSync('/tmp/gutter-bench.txt', out); } catch {}
