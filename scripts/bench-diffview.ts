/*
 * bench-diffview — headless timing of DiffView open + navigation on a many-file diff.
 * Run: node --import node-gtk/register scripts/bench-diffview.ts [fileCount]
 */
import Gtk from 'gi:Gtk-4.0';
import { zym } from '../src/zym.ts';
import { DiffView } from '../src/ui/DiffView.ts';
import type { DiffFile } from '../src/ui/multibuffer/diffMultiBuffer.ts';

Gtk.init();
zym.lsp.configure({ enable: false });

const FILE_COUNT = Number(process.argv[2] ?? 100);
const LINES_PER_FILE = 300;
const HUNKS_PER_FILE = 6;

function makeFile(i: number): DiffFile {
  const oldLines = Array.from({ length: LINES_PER_FILE }, (_, r) => `const value_${i}_${r} = compute(${r});`);
  const newLines = [...oldLines];
  // Scatter HUNKS_PER_FILE small changes through the file (1 modified + 1 inserted line each).
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

const files = Array.from({ length: FILE_COUNT }, (_, i) => makeFile(i));

function time(label: string, fn: () => void): void {
  const t0 = performance.now();
  fn();
  const ms = performance.now() - t0;
  console.log(`${label.padEnd(38)} ${ms.toFixed(1)} ms`);
}

let view!: DiffView;
time(`open (${FILE_COUNT} files)`, () => {
  view = new DiffView({ files });
});
console.log(`  rows: ${view.editor.getText().split('\n').length}`);

const middle = files[Math.floor(FILE_COUNT / 2)].path;
time('collapse one file (reDiff)', () => view.toggleFileCollapse(middle));
time('expand it back (reDiff)', () => view.toggleFileCollapse(middle));
time('expand context at cursor (reDiff)', () => view.expandContextAtCursor());
time('collapse all files', () => view.collapseAllFiles());
time('expand all files', () => view.expandAllFiles());
time('next file x10', () => { for (let k = 0; k < 10; k++) view.nextFile(); });
time('next hunk x10', () => { for (let k = 0; k < 10; k++) view.nextHunk(); });
time('dispose', () => view.dispose());
