import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs/promises';
import * as Os from 'node:os';
import * as Path from 'node:path';
import {
  matchesToExcerptInputs,
  byteToColumn,
  buildRipgrepArgs,
  parseRgMatch,
  groupMatches,
  searchProject,
  type RgMatch,
} from './projectSearch.ts';

// rg --json `match` record helper (the fields parseRgMatch reads).
const rgMatch = (path: string, lineNumber: number, lineText: string, subs: Array<[number, number]>) =>
  JSON.stringify({
    type: 'match',
    data: {
      path: { text: path },
      lines: { text: lineText },
      line_number: lineNumber,
      submatches: subs.map(([start, end]) => ({ start, end })),
    },
  });

// Pure region-merge math — no rg, no GTK.

test('a single match becomes one context-padded region', () => {
  const out = matchesToExcerptInputs([{ path: 'a.ts', rows: [10] }], { context: 2 });
  assert.deepEqual(out, [{ path: 'a.ts', regions: [{ startRow: 8, endRow: 12 }] }]);
});

test('nearby matches merge into one region; far ones stay separate', () => {
  // rows 10 and 13 with context 2 → [8,12] and [11,15] overlap → merge to [8,15].
  // row 30 is far → its own [28,32].
  const out = matchesToExcerptInputs([{ path: 'a.ts', rows: [10, 13, 30] }], { context: 2 });
  assert.deepEqual(out, [{ path: 'a.ts', regions: [{ startRow: 8, endRow: 15 }, { startRow: 28, endRow: 32 }] }]);
});

test('regions that merely touch (gap of 1) still merge', () => {
  // rows 5 and 9 with context 1 → [4,6] and [8,10]; 8 <= 6+1+1? touching rule is start<=prevEnd+1
  // → 8 <= 7 is false, so they DON'T merge. rows 5 and 8 → [4,6],[7,9]: 7<=7 → merge to [4,9].
  assert.deepEqual(
    matchesToExcerptInputs([{ path: 'a.ts', rows: [5, 9] }], { context: 1 }),
    [{ path: 'a.ts', regions: [{ startRow: 4, endRow: 6 }, { startRow: 8, endRow: 10 }] }],
    'one blank line between regions keeps them separate',
  );
  assert.deepEqual(
    matchesToExcerptInputs([{ path: 'a.ts', rows: [5, 8] }], { context: 1 }),
    [{ path: 'a.ts', regions: [{ startRow: 4, endRow: 9 }] }],
    'touching regions merge',
  );
});

test('unsorted, duplicate rows are normalized', () => {
  const out = matchesToExcerptInputs([{ path: 'a.ts', rows: [13, 10, 10] }], { context: 2 });
  assert.deepEqual(out, [{ path: 'a.ts', regions: [{ startRow: 8, endRow: 15 }] }]);
});

test('context is clamped to the file bounds when a line count is known', () => {
  const out = matchesToExcerptInputs([{ path: 'a.ts', rows: [0, 20] }], {
    context: 3,
    lineCount: () => 22, // last row = 21
  });
  assert.deepEqual(out, [{ path: 'a.ts', regions: [{ startRow: 0, endRow: 3 }, { startRow: 17, endRow: 21 }] }]);
});

test('multiple files keep their first-seen order', () => {
  const out = matchesToExcerptInputs(
    [{ path: 'b.ts', rows: [1] }, { path: 'a.ts', rows: [1] }],
    { context: 0 },
  );
  assert.deepEqual(out.map((e) => e.path), ['b.ts', 'a.ts']);
});

test('match column spans are carried onto the excerpt input (for highlighting)', () => {
  const out = matchesToExcerptInputs(
    [{ path: 'a.ts', rows: [10], matches: [{ row: 10, startCol: 4, endCol: 7 }] }],
    { context: 2 },
  );
  assert.deepEqual(out, [
    { path: 'a.ts', regions: [{ startRow: 8, endRow: 12 }], matches: [{ row: 10, startCol: 4, endCol: 7 }] },
  ]);
});

test('byteToColumn converts rg byte offsets to codepoint columns (multibyte safe)', () => {
  assert.equal(byteToColumn('foo bar', 0), 0);
  assert.equal(byteToColumn('foo bar', 4), 4, 'ASCII: byte == column');
  // 'café ' is 6 bytes (é = 2), 5 codepoints — so byte 6 ("f" of foo) is column 5.
  assert.equal(byteToColumn('café foo', 6), 5, 'multibyte: byte offset > column');
});

// --- buildRipgrepArgs: flag → ripgrep argument mapping ----------------------

test('default flags: smart-case + literal (fixed-strings), query + path after `--`', () => {
  assert.deepEqual(buildRipgrepArgs('foo'), ['--json', '--smart-case', '--fixed-strings', '--', 'foo', '.']);
});

test('case-sensitive replaces smart-case', () => {
  assert.deepEqual(
    buildRipgrepArgs('foo', { caseSensitive: true }),
    ['--json', '--case-sensitive', '--fixed-strings', '--', 'foo', '.'],
  );
});

test('regex on drops --fixed-strings; whole-word adds --word-regexp', () => {
  assert.deepEqual(
    buildRipgrepArgs('fo+', { regex: true, wholeWord: true }),
    ['--json', '--smart-case', '--word-regexp', '--', 'fo+', '.'],
  );
});

test('globs map to --glob in one field; a leading ! excludes, blanks dropped', () => {
  assert.deepEqual(
    buildRipgrepArgs('foo', { globs: ['*.ts', ' ', '!*.test.ts'] }),
    ['--json', '--smart-case', '--fixed-strings', '--glob', '*.ts', '--glob', '!*.test.ts', '--', 'foo', '.'],
  );
});

test('includeIgnored adds --no-ignore --hidden', () => {
  assert.deepEqual(
    buildRipgrepArgs('foo', { includeIgnored: true }),
    ['--json', '--smart-case', '--fixed-strings', '--no-ignore', '--hidden', '--', 'foo', '.'],
  );
});

test('a query starting with `-` is protected by the `--` separator, before the `.` path', () => {
  assert.deepEqual(buildRipgrepArgs('-n', { regex: true }).slice(-3), ['--', '-n', '.']);
});

// --- parseRgMatch: one rg --json line → a normalized RgMatch ------------------

test('parseRgMatch maps a match record (abs path, 0-based row, codepoint spans)', () => {
  const m = parseRgMatch(rgMatch('src/a.ts', 10, '  const foo = 1\n', [[8, 11]]), '/root');
  assert.deepEqual(m, {
    file: '/root/src/a.ts',
    relPath: 'src/a.ts',
    row: 9, // rg is 1-based
    lineText: '  const foo = 1',
    spans: [{ startCol: 8, endCol: 11 }],
  });
});

test('parseRgMatch converts multibyte byte offsets to codepoint columns', () => {
  // 'café ' = 6 bytes (é=2); a match on 'foo' at bytes 6..9 is codepoints 5..8.
  const m = parseRgMatch(rgMatch('a.ts', 1, 'café foo\n', [[6, 9]]), '/r');
  assert.deepEqual(m?.spans, [{ startCol: 5, endCol: 8 }]);
});

test('parseRgMatch returns null for non-match records and garbage', () => {
  assert.equal(parseRgMatch(JSON.stringify({ type: 'begin', data: {} }), '/r'), null);
  assert.equal(parseRgMatch(JSON.stringify({ type: 'summary', data: {} }), '/r'), null);
  assert.equal(parseRgMatch('not json', '/r'), null);
  assert.equal(parseRgMatch('', '/r'), null);
});

// --- groupMatches: flat stream → per-file rows + spans ------------------------

test('groupMatches groups by file in first-seen order, collecting rows and spans', () => {
  const matches: RgMatch[] = [
    { file: '/r/b.ts', relPath: 'b.ts', row: 0, lineText: 'x', spans: [{ startCol: 0, endCol: 1 }] },
    { file: '/r/a.ts', relPath: 'a.ts', row: 4, lineText: 'y', spans: [] },
    { file: '/r/b.ts', relPath: 'b.ts', row: 7, lineText: 'z', spans: [{ startCol: 2, endCol: 3 }] },
  ];
  assert.deepEqual(groupMatches(matches), [
    { path: '/r/b.ts', rows: [0, 7], matches: [
      { row: 0, startCol: 0, endCol: 1 },
      { row: 7, startCol: 2, endCol: 3 },
    ] },
    { path: '/r/a.ts', rows: [4], matches: [] },
  ]);
});

// --- searchProject: streaming end-to-end over a real rg ----------------------

test('searchProject streams matches from rg and signals done', async () => {
  const dir = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'zym-search-'));
  try {
    await Fs.writeFile(Path.join(dir, 'a.ts'), 'alpha\nNEEDLE here\nbeta\n');
    await Fs.writeFile(Path.join(dir, 'b.ts'), 'NEEDLE again\n');
    const matches: RgMatch[] = [];
    const info = await new Promise<{ capped: boolean }>((resolve, reject) =>
      searchProject(dir, 'NEEDLE', {}, {
        onMatches: (m) => matches.push(...m),
        onDone: resolve,
        onError: reject,
      }),
    );
    assert.equal(info.capped, false);
    const grouped = groupMatches(matches);
    assert.deepEqual(grouped.map((g) => Path.basename(g.path)).sort(), ['a.ts', 'b.ts']);
  } finally {
    await Fs.rm(dir, { recursive: true, force: true });
  }
});
