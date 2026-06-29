/*
 * Per-file folding (`z o` / `z c`) caret recovery — docs/text-editor/diff.md "Per-file folding".
 * Toggling a file's fold re-flows the view (`reDiff`); the caret must re-land on that file's header
 * row. The LAST file is the regression: its header is the buffer's final, unterminated line, so the
 * expansion's splice appends at the caret and a right-gravity insert mark would ride to the end —
 * `reDiff` anchors a caret-on-header to its file path so it stays put.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Gtk from 'gi:Gtk-4.0';
import { zym } from '../zym.ts';
import { DiffView } from './DiffView.ts';

Gtk.init();
zym.lsp.configure({ enable: false });

const linesOf = (mbv: DiffView) => mbv.editor.getText().split('\n');
const caretRow = (mbv: DiffView) => mbv.editor.model.getCursorBufferPosition().row;
const headerRow = (mbv: DiffView, path: string): number =>
  (mbv as any).headerAnchors.find((h: { path: string }) => h.path === path).viewRow;
// The padded width of a gutter line-number column (all labels are padded to it) — what drives the
// rendered gutter width.
const gutterWidth = (mbv: DiffView, side: 'old' | 'new'): number => {
  const labels: string[] = (mbv as any).lineNumbers.renderer[side === 'old' ? 'oldLabels' : 'newLabels'];
  return labels.reduce((max, l) => Math.max(max, l.length), 0);
};

function open() {
  return new DiffView({
    files: [
      { path: 'a.ts', oldText: 'a1\na2\na3\n', newText: 'a1\nAA\na3\n' },
      { path: 'b.ts', oldText: 'b1\nb2\nb3\n', newText: 'b1\nBB\nb3\n' },
    ],
  });
}

test('folding: expanding the LAST file keeps the caret on its header (not dragged to the end)', () => {
  const mbv = open();
  mbv.collapseAllFiles(); // one header row per file
  mbv.editor.model.setCursorBufferPosition({ row: headerRow(mbv, 'b.ts'), column: 0 });

  mbv.expandFileAtCursor(); // `z o` on the last file

  assert.equal(caretRow(mbv), headerRow(mbv, 'b.ts'), 'caret stayed on the last file header');
  assert.ok(linesOf(mbv).length > headerRow(mbv, 'b.ts') + 1, 'the last file actually expanded below its header');
  mbv.dispose();
});

test('folding: expanding a NON-last file also keeps the caret on its header', () => {
  const mbv = open();
  mbv.collapseAllFiles();
  mbv.editor.model.setCursorBufferPosition({ row: headerRow(mbv, 'a.ts'), column: 0 });

  mbv.expandFileAtCursor();

  assert.equal(caretRow(mbv), headerRow(mbv, 'a.ts'), 'caret stayed on the first file header');
  mbv.dispose();
});

test('folding: the gutter column width stays constant across collapse/expand', () => {
  // A short file plus a long one (3-digit line numbers): the gutter is sized to the longest file,
  // so collapsing a file (which hides its numbers) must NOT shrink it and shift the layout.
  const longNew = Array.from({ length: 120 }, (_, i) => `n${i + 1}`).join('\n') + '\n';
  const longOld = longNew.replace('n2\n', 'OLD2\n'); // one change near the top so the file diffs
  const mbv = new DiffView({
    files: [
      { path: 'a.ts', oldText: 'a1\na2\n', newText: 'a1\nAA\n' },
      { path: 'b.ts', oldText: longOld, newText: longNew },
    ],
  });
  const wide = gutterWidth(mbv, 'new');
  assert.equal(wide, 3, 'sized to the longest file (120+ lines → 3 digits)');

  // Collapse the LONG file: only the short file's 1-digit numbers remain visible.
  mbv.editor.model.setCursorBufferPosition({ row: headerRow(mbv, 'b.ts'), column: 0 });
  mbv.collapseFileAtCursor();
  assert.equal(gutterWidth(mbv, 'new'), wide, 'collapsing the long file kept the wide gutter');

  mbv.collapseAllFiles();
  assert.equal(gutterWidth(mbv, 'new'), wide, 'collapsing every file kept the wide gutter');

  mbv.expandAllFiles();
  assert.equal(gutterWidth(mbv, 'new'), wide, 'expanding back kept the same width');
  mbv.dispose();
});

// Multi-file diff with controlled relative-path labels for `z x` glob collapse.
function openGlob() {
  const f = (label: string, marker: string) => ({
    path: `/r/${label}`,
    label,
    oldText: 'l1\nl2\n',
    newText: `l1\n${marker}\n`,
  });
  return new DiffView({ files: [f('a.ts', 'AA'), f('src/b.ts', 'BB'), f('README.md', 'MM'), f('a.test.ts', 'TT')] });
}

test('z x: collapseFilesMatching collapses exactly the glob-matched files', () => {
  const mbv = openGlob();
  // `*.ts, !*.test.ts` → every .ts (basename, any depth) except tests.
  assert.deepEqual(
    mbv.filesMatching('*.ts, !*.test.ts').map((f) => f.label),
    ['a.ts', 'src/b.ts'],
    'preview matches the right files',
  );

  const n = mbv.collapseFilesMatching('*.ts, !*.test.ts');
  assert.equal(n, 2, 'collapsed two files');

  // Collapsed files emit only their header (their changed content row is gone); others keep theirs.
  const lines = linesOf(mbv);
  assert.ok(!lines.includes('AA') && !lines.includes('BB'), 'matched .ts files collapsed away');
  assert.ok(lines.includes('MM') && lines.includes('TT'), 'the .md and the .test.ts file stay expanded');

  assert.equal(mbv.collapseFilesMatching('*.ts, !*.test.ts'), 0, 'idempotent — already collapsed');
  mbv.dispose();
});

test('z x: slash terms match the full path; a blank pattern is a no-op', () => {
  const mbv = openGlob();
  assert.deepEqual(mbv.filesMatching('src/**').map((f) => f.label), ['src/b.ts'], 'slash term = full path');
  assert.deepEqual(
    mbv.filesMatching('!*.md').map((f) => f.label),
    ['a.ts', 'src/b.ts', 'a.test.ts'],
    'only-negative = everything but the excluded',
  );
  assert.equal(mbv.collapseFilesMatching('   '), 0, 'blank pattern collapses nothing');
  assert.ok(linesOf(mbv).includes('AA'), 'nothing collapsed on a blank pattern');
  mbv.dispose();
});
