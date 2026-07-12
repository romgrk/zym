/*
 * bench-diffview-phases — per-phase timing inside DiffView.reDiff on a many-file diff.
 * Run: node --import node-gtk/register scripts/bench-diffview-phases.ts [fileCount]
 */
import Gtk from 'gi:Gtk-4.0';
import { zym } from '../src/zym.ts';
import { DiffView } from '../src/ui/DiffView.ts';
import { Screen } from '../src/ui/TextEditor/Screen.ts';
import type { DiffFile } from '../src/ui/multibuffer/diffMultiBuffer.ts';

Gtk.init();
zym.lsp.configure({ enable: false });

const FILE_COUNT = Number(process.argv[2] ?? 100);
const LINES_PER_FILE = 300;
const HUNKS_PER_FILE = 6;

function makeFile(i: number): DiffFile {
  const oldLines = Array.from({ length: LINES_PER_FILE }, (_, r) => `const value_${i}_${r} = compute(${r});`);
  const newLines = [...oldLines];
  for (let h = 0; h < HUNKS_PER_FILE; h++) {
    const at = Math.floor(((h + 1) * LINES_PER_FILE) / (HUNKS_PER_FILE + 2));
    newLines[at] = `const value_${i}_${at} = computeChanged(${at});`;
    newLines.splice(at + 1, 0, `const extra_${i}_${h} = inserted(${h});`);
  }
  return {
    path: `/bench/file_${String(i).padStart(3, '0')}.ts`,
    oldText: oldLines.join('\n') + '\n',
    newText: newLines.join('\n') + '\n',
  };
}

const totals = new Map<string, number>();
function wrap(obj: any, name: string, label = name): void {
  const orig = obj[name];
  obj[name] = function (...args: any[]) {
    const t0 = performance.now();
    const r = orig.apply(this, args);
    totals.set(label, (totals.get(label) ?? 0) + (performance.now() - t0));
    return r;
  };
}

wrap(DiffView.prototype as any, 'buildDiff');
wrap(DiffView.prototype as any, 'applyDecorations');
wrap(DiffView.prototype as any, 'installOverlays');
wrap(Screen.prototype as any, 'retarget');
wrap(Screen.prototype as any, 'spliceTo');
wrap(Screen.prototype as any, 'relockReadonly');

const files = Array.from({ length: FILE_COUNT }, (_, i) => makeFile(i));

function time(label: string, fn: () => void): void {
  totals.clear();
  const t0 = performance.now();
  fn();
  const ms = performance.now() - t0;
  const parts = [...totals.entries()].map(([k, v]) => `${k}=${v.toFixed(0)}`).join(' ');
  console.log(`${label.padEnd(30)} ${ms.toFixed(1).padStart(7)} ms   ${parts}`);
}

let view!: DiffView;
time(`open (${FILE_COUNT} files)`, () => {
  view = new DiffView({ files });
});

const middle = files[Math.floor(FILE_COUNT / 2)].path;
time('collapse one file', () => view.toggleFileCollapse(middle));
time('expand it back', () => view.toggleFileCollapse(middle));
time('expand context 1', () => view.expandContextAtCursor());
time('expand context 2', () => view.expandContextAtCursor());
time('collapse all', () => view.collapseAllFiles());
time('expand all', () => view.expandAllFiles());
view.dispose();
