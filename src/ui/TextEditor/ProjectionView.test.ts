/*
 * ProjectionView tests (Phase 2b/2c, docs/text-editor/multibuffer.md). The IDENTITY case
 * (single full-file source) must reproduce Document's view↔model sync byte-for-byte — these
 * mirror Document.test.ts's sync contract, but through the new projection-backed materializer
 * (the substrate that Phase 2e swaps Document onto). Plus: multi-source materialization,
 * non-editable gating, and reverse-sync re-materialization.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource, type SourceBuffer } from '../../gi.ts';
import { ProjectionView } from './ProjectionView.ts';
import type { Item } from './ViewProjection.ts';
import { diffSegments } from '../multibuffer/diffSegments.ts';
import { Point } from '../../text/Point.ts';

// ProjectionView owns GtkSource buffers, so this needs GTK.
Gtk.init();

const asIter = (res: any): any => (Array.isArray(res) ? res[res.length - 1] : res);
const insertAt = (buf: any, off: number, text: string) => buf.insert(asIter(buf.getIterAtOffset(off)), text, -1);
const deleteRange = (buf: any, a: number, b: number) =>
  buf.delete(asIter(buf.getIterAtOffset(a)), asIter(buf.getIterAtOffset(b)));
const textOf = (buf: any): string => buf.getText(buf.getStartIter(), buf.getEndIter(), true);

function srcBuffer(text: string): SourceBuffer {
  const b = new GtkSource.Buffer();
  b.setText(text, -1);
  return b;
}
const fileItem = (key: string, lastRow: number): Item =>
  ({ type: 'segment', segment: { documentKey: key, startRow: 0, endRow: lastRow, editable: true, kind: 'real' } });

function identitySetup(text: string) {
  const src = srcBuffer(text);
  const pv = new ProjectionView([fileItem('f', src.getLineCount() - 1)], new Map([['f', src]]));
  const synced = () => textOf(pv.buffer) === textOf(src);
  return { src, pv, synced };
}

// --- identity (single full-file source) = today's Document sync ---------------

test('materializes the view buffer from the source', () => {
  const { pv, src } = identitySetup('hello\nworld\n');
  assert.equal(textOf(pv.buffer), 'hello\nworld\n');
  assert.equal(textOf(src), 'hello\nworld\n');
  assert.equal(pv.view.isIdentity, true);
});

test('a view edit writes through to the source', () => {
  const { pv, src, synced } = identitySetup('abc\n');
  insertAt(pv.buffer, 0, 'X'); // like typing in the view
  assert.ok(synced(), 'view + source equal after a view insert');
  assert.equal(textOf(src), 'Xabc\n');

  deleteRange(pv.buffer, 0, 1); // delete the X
  assert.ok(synced());
  assert.equal(textOf(src), 'abc\n');
});

test('a source edit mirrors into the view (reverse-sync)', () => {
  const { pv, src, synced } = identitySetup('abc\n');
  insertAt(src, 0, 'Z'); // a change from elsewhere (another view / undo / reload)
  assert.ok(synced(), 'view mirrored the source insert');
  assert.equal(textOf(pv.buffer), 'Zabc\n');

  deleteRange(src, 0, 1);
  assert.ok(synced());
  assert.equal(textOf(pv.buffer), 'abc\n');
});

test('500 deterministic-random edits across both directions never desync', () => {
  const { pv, src, synced } = identitySetup('the quick brown fox\n');
  let ok = true;
  for (let i = 0; i < 500 && ok; i++) {
    const buf = i % 2 === 0 ? (pv.buffer) : (src); // alternate view / source origin
    const len = textOf(buf).length;
    const off = (i * 7919) % Math.max(1, len);
    if (i % 3 === 0 && len > 4) {
      const s = Math.min(off, len - 2);
      deleteRange(buf, s, s + 1);
    } else {
      insertAt(buf, Math.min(off, len), String.fromCharCode(97 + (i % 26)));
    }
    ok = synced();
  }
  assert.ok(ok, 'view + source stayed equal across 500 edits from both sides');
});

// --- multi-source -------------------------------------------------------------

function multiSetup() {
  const a = srcBuffer('// a\nconst aaa = 1;\nfunction fa() {}\n');
  const b = srcBuffer('const bbb = 2;\nlet ccc = 3;\n');
  // Editable segments so the gating distinction (block = readonly, segment = editable) is
  // meaningful; screenText / reverse-sync are unaffected by the flag.
  const items: Item[] = [
    { type: 'block', block: { kind: 'header', text: 'a.ts' } },
    { type: 'segment', segment: { documentKey: 'a.ts', startRow: 1, endRow: 2, editable: true, kind: 'real' } },
    { type: 'block', block: { kind: 'blank', text: '' } },
    { type: 'block', block: { kind: 'header', text: 'b.ts' } },
    { type: 'segment', segment: { documentKey: 'b.ts', startRow: 0, endRow: 1, editable: true, kind: 'real' } },
  ];
  const pv = new ProjectionView(items, new Map([['a.ts', a], ['b.ts', b]]));
  return { a, b, pv };
}

test('materializes a multi-source projection with headers', () => {
  const { pv } = multiSetup();
  assert.equal(pv.view.isIdentity, false);
  assert.equal(textOf(pv.buffer), 'a.ts\nconst aaa = 1;\nfunction fa() {}\n\nb.ts\nconst bbb = 2;\nlet ccc = 3;');
});

test('non-editable rows (headers) carry the readonly tag; segment rows do not', () => {
  const { pv } = multiSetup();
  const tag = pv.buffer.getTagTable().lookup('vp:readonly');
  assert.ok(tag, 'readonly tag exists');
  assert.equal(asIter(pv.buffer.getIterAtLineOffset(0, 1)).hasTag(tag), true, 'header row 0 is readonly');
  assert.equal(asIter(pv.buffer.getIterAtLineOffset(3, 0)).hasTag(tag), true, 'blank row 3 is readonly');
  assert.equal(asIter(pv.buffer.getIterAtLineOffset(1, 1)).hasTag(tag), false, 'segment row 1 is editable');
});

test('multi-source: an in-place edit routes to the right source, leaving others intact', () => {
  const { a, b, pv } = multiSetup();
  // View rows: 0:a.ts 1:"const aaa = 1;" 2:"function fa() {}" 3:<blank> 4:b.ts 5:"const bbb = 2;" 6:"let ccc = 3;"
  // Insert "export " at the start of view row 1 → source a.ts row 1.
  const row1Start = asIter(pv.buffer.getIterAtLine(1)).getOffset();
  insertAt(pv.buffer, row1Start, 'export ');
  assert.equal(textOf(a), '// a\nexport const aaa = 1;\nfunction fa() {}\n', 'wrote through to source a.ts');
  assert.equal(textOf(b), 'const bbb = 2;\nlet ccc = 3;\n', 'source b.ts untouched');
  // The view row matches the edited source row.
  const view = textOf(pv.buffer) as string;
  assert.equal(view.split('\n')[1], 'export const aaa = 1;');

  // A second in-place edit, into source b.ts (proves the row-direct map stayed valid).
  const row6Start = asIter(pv.buffer.getIterAtLine(6)).getOffset();
  insertAt(pv.buffer, row6Start, 'const ');
  assert.equal(textOf(b), 'const bbb = 2;\nconst let ccc = 3;\n', 'second edit routed to b.ts');
});

test('multi-source: an edit on a header row does not write through to any source', () => {
  const { a, b, pv } = multiSetup();
  insertAt(pv.buffer, 0, 'X'); // view row 0 is the "a.ts" header (a block)
  assert.equal(textOf(a), '// a\nconst aaa = 1;\nfunction fa() {}\n', 'a.ts unchanged');
  assert.equal(textOf(b), 'const bbb = 2;\nlet ccc = 3;\n', 'b.ts unchanged');
});

test('multi-source: a delete spanning two sources is rejected (boundary clamp)', () => {
  const { a, b, pv } = multiSetup();
  // Delete from inside a.ts's excerpt (view row 2) across the blank/header into b.ts (row 5).
  const from = asIter(pv.buffer.getIterAtLine(2)).getOffset();
  const to = asIter(pv.buffer.getIterAtLineOffset(5, 3)).getOffset();
  deleteRange(pv.buffer, from, to);
  assert.equal(textOf(a), '// a\nconst aaa = 1;\nfunction fa() {}\n', 'a.ts unchanged (cross-source delete rejected)');
  assert.equal(textOf(b), 'const bbb = 2;\nlet ccc = 3;\n', 'b.ts unchanged');
});

test('a source change re-materializes the multi-source view (reverse-sync rebuild)', async () => {
  const { a, pv } = multiSetup();
  // Change a projected row of source A (row 1 = "const aaa = 1;").
  const lineStart = asIter(a.getIterAtLine(1)).getOffset();
  insertAt(a, lineStart, 'export ');
  await Promise.resolve(); // flush the deferred rebuild microtask
  assert.equal(
    textOf(pv.buffer),
    'a.ts\nexport const aaa = 1;\nfunction fa() {}\n\nb.ts\nconst bbb = 2;\nlet ccc = 3;',
    'the view re-materialized with the edited source row',
  );
});

// --- multi-source in-place reverse-sync + cross-source undo (Phase 3a/3c) -----------------

function editableMulti() {
  const a = srcBuffer('a0\na1\n');
  const b = srcBuffer('b0\nb1\n');
  a.setEnableUndo(true);
  b.setEnableUndo(true);
  const items: Item[] = [
    { type: 'segment', segment: { documentKey: 'a', startRow: 0, endRow: 1, editable: true, kind: 'real' } },
    { type: 'segment', segment: { documentKey: 'b', startRow: 0, endRow: 1, editable: true, kind: 'real' } },
  ];
  const pv = new ProjectionView(items, new Map([['a', a], ['b', b]]));
  return { a, b, pv }; // view rows: 0:a0 1:a1 2:b0 3:b1
}

test('multi-source: an external in-place source edit mirrors into the view', () => {
  const { a, pv } = editableMulti();
  insertAt(a, 0, 'X'); // a change to source a from elsewhere (not via the multibuffer)
  assert.equal(textOf(a), 'Xa0\na1\n');
  assert.equal(textOf(pv.buffer), 'Xa0\na1\nb0\nb1', 'the view mirrored the in-place edit at the right row');
});

test('cross-source undo: a view edit routes + undoes on the right source', () => {
  const { a, b, pv } = editableMulti();
  pv.beginUserAction();
  insertAt(pv.buffer, 0, 'X'); // view row 0 → source a
  pv.endUserAction();
  assert.equal(textOf(a), 'Xa0\na1\n', 'wrote through to source a');
  assert.equal(pv.canUndo(), true);

  pv.undo();
  assert.equal(textOf(a), 'a0\na1\n', 'undo reverted source a');
  assert.equal(textOf(pv.buffer), 'a0\na1\nb0\nb1', 'view reflects the undo');
  assert.equal(textOf(b), 'b0\nb1\n', 'source b untouched');

  pv.redo();
  assert.equal(textOf(a), 'Xa0\na1\n', 'redo re-applied');
});

test('cross-source undo: a multi-file transaction undoes both sources as one step', () => {
  const { a, b, pv } = editableMulti();
  pv.beginUserAction();
  insertAt(pv.buffer, 0, 'X'); // edits source a (view row 0)
  const b0Start = asIter(pv.buffer.getIterAtLine(2)).getOffset(); // view row 2 = b0
  insertAt(pv.buffer, b0Start, 'Y'); // edits source b (view row 2)
  pv.endUserAction();
  assert.equal(textOf(a), 'Xa0\na1\n');
  assert.equal(textOf(b), 'Yb0\nb1\n');

  pv.undo(); // ONE step reverts both files
  assert.equal(textOf(a), 'a0\na1\n');
  assert.equal(textOf(b), 'b0\nb1\n');
  assert.equal(pv.canUndo(), false, 'the multi-file edit was a single undo step');
});

// --- multi-source re-segmentation (row-count-changing write-through, 3d/G6) ---------------
// A multi-line insert/delete WITHIN one editable segment must grow/shrink that segment's
// window, shift later same-source segments, and rebuild the coordinate map — WITHOUT
// re-materializing the view (GTK applies the same edit). Two excerpts of the SAME file pin
// the shift; the row-direct map staying valid after the rebuild pins map↔buffer consistency.

const lineTextOf = (buf: any, row: number): string => {
  const s = asIter(buf.getIterAtLine(row));
  const e = s.copy();
  if (!e.endsLine()) e.forwardToLineEnd();
  return buf.getText(s, e, true);
};

// One file, two excerpts (rows 1..3 and 6..8) separated by a header + blank.
function twoExcerptsOfOneFile() {
  const f = srcBuffer('l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n'); // rows 0..9 (row 9 empty)
  f.setEnableUndo(true);
  const items: Item[] = [
    { type: 'block', block: { kind: 'header', text: 'F' } },
    { type: 'segment', segment: { documentKey: 'f', startRow: 1, endRow: 3, editable: true, kind: 'real' } },
    { type: 'block', block: { kind: 'blank', text: '' } },
    { type: 'segment', segment: { documentKey: 'f', startRow: 6, endRow: 8, editable: true, kind: 'real' } },
  ];
  const pv = new ProjectionView(items, new Map([['f', f]]));
  // view rows: 0:F 1:l1 2:l2 3:l3 4:<blank> 5:l6 6:l7 7:l8
  return { f, pv };
}

test('re-segment: a multi-line insert grows its segment and shifts the later same-source one', () => {
  const { f, pv } = twoExcerptsOfOneFile();
  const row2 = asIter(pv.buffer.getIterAtLine(2)).getOffset(); // view row 2 = source f row 2 ("l2")
  insertAt(pv.buffer, row2, 'NEW\n'); // splits f row 2 into "NEW" + "l2"
  assert.equal(textOf(f), 'l0\nl1\nNEW\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n', 'wrote through, growing the source');
  assert.equal(
    textOf(pv.buffer),
    'F\nl1\nNEW\nl2\nl3\n\nl6\nl7\nl8',
    'first excerpt grew (l1,NEW,l2,l3); the second still shows l6,l7,l8',
  );
  // The map rebuilt: an in-place edit on a row BELOW the insert now routes to the right source row.
  const lastBody = asIter(pv.buffer.getIterAtLine(8)).getOffset(); // view row 8 = "l8"
  insertAt(pv.buffer, lastBody, 'Z');
  assert.equal(lineTextOf(f, 9), 'Zl8', 'in-place edit after a re-segment routed to the correct (shifted) source row');
});

test('re-segment: a multi-line delete shrinks its segment and shifts the later one up', () => {
  const { f, pv } = twoExcerptsOfOneFile();
  const from = asIter(pv.buffer.getIterAtLine(2)).getOffset(); // view row 2 = "l2"
  const to = asIter(pv.buffer.getIterAtLine(3)).getOffset(); // view row 3 = "l3"
  deleteRange(pv.buffer, from, to); // remove the whole "l2\n" line
  assert.equal(textOf(f), 'l0\nl1\nl3\nl4\nl5\nl6\nl7\nl8\n', 'the line was removed from the source');
  assert.equal(
    textOf(pv.buffer),
    'F\nl1\nl3\n\nl6\nl7\nl8',
    'first excerpt shrank (l1,l3); the second still shows l6,l7,l8',
  );
});

test('re-segment: a multi-line edit is one cross-source undo step (view + source restored)', async () => {
  const { f, pv } = twoExcerptsOfOneFile();
  const row1 = asIter(pv.buffer.getIterAtLine(1)).getOffset(); // view row 1 = "l1"
  pv.beginUserAction();
  insertAt(pv.buffer, row1, 'A\nB\n'); // two new rows (write-through re-segments, no flash)
  pv.endUserAction();
  assert.equal(textOf(pv.buffer), 'F\nA\nB\nl1\nl2\nl3\n\nl6\nl7\nl8');
  pv.undo(); // replays the source's undo → the row-count reverse-sync mirrors incrementally
  await Promise.resolve(); // flush the deferred remap
  assert.equal(textOf(f), 'l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n', 'source fully restored');
  assert.equal(textOf(pv.buffer), 'F\nl1\nl2\nl3\n\nl6\nl7\nl8', 'view restored to the original projection');
});

test('re-segment undo mirrors incrementally — no whole-buffer re-materialize (decorations survive)', async () => {
  const { pv } = twoExcerptsOfOneFile();
  const buf = pv.buffer;
  // A decoration tag on a stable row above the edit (view row 1 = "l1"). A full re-materialize
  // (setText) on undo would wipe it; the incremental mirror leaves it in place.
  const tag = new Gtk.TextTag({ name: 'test:deco' });
  buf.getTagTable().add(tag);
  buf.applyTag(tag, asIter(buf.getIterAtLine(1)), asIter(buf.getIterAtLineOffset(1, 2)));
  const hasDeco = () => asIter(buf.getIterAtLineOffset(1, 1)).hasTag(tag);
  assert.equal(hasDeco(), true, 'decoration applied');

  const row3 = asIter(buf.getIterAtLine(3)).getOffset(); // view row 3 = "l3" (below the tagged row)
  pv.beginUserAction();
  insertAt(buf, row3, 'A\nB\n'); // multi-line write-through (re-segments)
  pv.endUserAction();
  assert.equal(hasDeco(), true, 'decoration survives the write-through (no re-materialize)');
  pv.undo();
  await Promise.resolve(); // flush the deferred remap
  assert.equal(textOf(buf), 'F\nl1\nl2\nl3\n\nl6\nl7\nl8', 'view restored');
  assert.equal(hasDeco(), true, 'decoration SURVIVED the undo — proves no whole-buffer re-materialize');
});

test('300 row-count-changing edits within editable segments never desync map↔buffer↔source', () => {
  const { f, pv } = twoExcerptsOfOneFile();
  const buf = pv.buffer;
  // Consistency: the view buffer's line count matches the map, and every source-mapped view
  // row shows exactly its source row's text (block rows are left to the materializer).
  const consistent = (): string => {
    const n = pv.view.screenRowCount;
    if (buf.getLineCount() !== n) return `line count ${buf.getLineCount()} != map ${n}`;
    for (let r = 0; r < n; r++) {
      const t = pv.view.screenToDocument(r, 0);
      if (t.kind !== 'document') continue;
      const want = lineTextOf(f, t.row);
      const got = lineTextOf(buf, r);
      if (want !== got) return `row ${r} → src ${t.row}: "${got}" != "${want}"`;
    }
    return '';
  };
  // Editable view rows (those mapping to a source row), recomputed each iteration.
  const editableRows = (): number[] => {
    const out: number[] = [];
    for (let r = 0; r < pv.view.screenRowCount; r++) if (pv.view.screenToDocument(r, 0).kind === 'document') out.push(r);
    return out;
  };
  let why = '';
  for (let i = 0; i < 300 && !why; i++) {
    const rows = editableRows();
    const r = rows[(i * 7919) % rows.length];
    const lineLen = lineTextOf(buf, r).length;
    const op = i % 4;
    if (op === 0) {
      insertAt(buf, asIter(buf.getIterAtLineOffset(r, Math.min(i % 3, lineLen))).getOffset(), 'c'); // in-place insert
    } else if (op === 1) {
      insertAt(buf, asIter(buf.getIterAtLine(r)).getOffset(), 'P\nQ\n'); // multi-line insert (grows segment)
    } else if (op === 2 && lineLen > 0) {
      const at = asIter(buf.getIterAtLine(r)).getOffset();
      deleteRange(buf, at, at + 1); // in-place delete
    } else {
      // Line-merge delete only when row r+1 is in the SAME segment (else the write-through
      // rejects but GTK would still apply the view delete — not a valid interactive edit).
      const here = pv.view.screenToDocument(r, 0);
      const next = pv.view.screenToDocument(r + 1, 0);
      if (here.kind === 'document' && next.kind === 'document' && here.segmentIndex === next.segmentIndex) {
        deleteRange(buf, asIter(buf.getIterAtLine(r)).getOffset(), asIter(buf.getIterAtLine(r + 1)).getOffset());
      }
    }
    why = consistent();
  }
  assert.equal(why, '', 'map, view buffer, and source stayed consistent across 300 re-segmenting edits');
});

// --- retarget (minimal-churn projection swap — the re-diff-on-edit engine) -----------------
// A re-diff produces a NEW item list (phantom rows appear/disappear). `retarget` applies only
// the line-level delta vs the current view, so unchanged rows keep their caret + decorations
// (no whole-buffer setText flash). The key properties: the result equals a fresh build, and
// tags on untouched rows survive.

test('retarget: minimal-churn item swap keeps unchanged rows (decorations survive)', () => {
  const f = srcBuffer('l0\nl1\nl2\nl3\nl4\n');
  const seg = (a: number, b: number): Item =>
    ({ type: 'segment', segment: { documentKey: 'f', startRow: a, endRow: b, editable: true, kind: 'real' } });
  const gap: Item = { type: 'block', block: { kind: 'gap', text: '⋯' } };
  const pv = new ProjectionView([seg(0, 2)], new Map([['f', f]]));
  assert.equal(textOf(pv.buffer), 'l0\nl1\nl2');

  // A decoration on view row 0; it must survive both a grow and a shrink.
  const buf = pv.buffer;
  const tag = new Gtk.TextTag({ name: 'test:deco' });
  buf.getTagTable().add(tag);
  buf.applyTag(tag, asIter(buf.getIterAtLine(0)), asIter(buf.getIterAtLineOffset(0, 2)));
  const hasDeco = () => asIter(buf.getIterAtLineOffset(0, 1)).hasTag(tag);
  assert.equal(hasDeco(), true);

  pv.retarget([seg(0, 2), gap, seg(4, 4)]); // append a gap + a second window
  assert.equal(textOf(pv.buffer), 'l0\nl1\nl2\n⋯\nl4', 'rows appended at the bottom');
  assert.equal(pv.view.screenRowCount, 5);
  assert.equal(hasDeco(), true, 'row 0 decoration survived the append (no full re-materialize)');
  // The appended gap row is re-locked read-only.
  const ro = buf.getTagTable().lookup('vp:readonly');
  assert.equal(asIter(buf.getIterAtLineOffset(3, 0)).hasTag(ro), true, 'gap row read-only after retarget');

  pv.retarget([seg(0, 2)]); // shrink back
  assert.equal(textOf(pv.buffer), 'l0\nl1\nl2');
  assert.equal(hasDeco(), true, 'survived the shrink too');
});

test('retarget to a recomputed diff matches a fresh build (re-diff on edit)', () => {
  const newBuf = srcBuffer('a\nb\nc\n');
  const oldBuf = srcBuffer('a\nb\nc\n');
  const keys = () => new Map([['new:f', newBuf], ['old:f', oldBuf]] as const);
  const items0 = diffSegments(['a', 'b', 'c', ''], ['a', 'b', 'c', ''], 'new:f', 'old:f').items;
  const pv = new ProjectionView(items0, keys());
  assert.equal(textOf(pv.buffer), 'a\nb\nc\n', 'no diff yet → just the new side (trailing empty row)');

  // The new side was edited (b→B): update the source as a write-through would, then re-diff.
  pv.suspend();
  newBuf.setText('a\nB\nc\n', -1);
  pv.resume();
  const items1 = diffSegments(['a', 'b', 'c', ''], ['a', 'B', 'c', ''], 'new:f', 'old:f').items;
  pv.retarget(items1);

  // Retarget must produce exactly what a fresh materialization of the same items would (the
  // removed `b` now shows as a phantom old-side row; `B` is the added new-side row).
  const fresh = new ProjectionView(items1, keys());
  assert.equal(textOf(pv.buffer), textOf(fresh.buffer), 'retarget result == fresh build');
  assert.ok((textOf(pv.buffer) as string).includes('b'), 'the removed line reappeared as a phantom row');
  fresh.dispose();
});

test('dispose stops syncing', () => {
  const { pv, src } = identitySetup('abc\n');
  pv.dispose();
  insertAt(src, 0, 'Z');
  assert.equal(textOf(pv.buffer), 'abc\n', 'disposed view no longer mirrors the source');
});

// --- folds (the analytic transform, ported from Document.test.ts's fold contract) ---------
// Single source = the model. "Editing another view" = editing the source buffer directly
// (reverse-sync); "editing the folded view" = editing pv.buffer (write-through).

const SAMPLE = "import {\n  X,\n} from './git.ts';\n";
const FOLD = [8, 14] as const; // collapse `\n  X,\n` (after `{`, up to `}`)
const cpSlice = (s: string, a: number, b?: number): string => [...s].slice(a, b).join('');

test('fold collapses the view and leaves the source intact', () => {
  const { pv, src } = identitySetup(SAMPLE);
  pv.fold(FOLD[0], FOLD[1], '[...]');
  assert.equal(textOf(pv.buffer), "import {[...]} from './git.ts';\n", 'view collapsed to one line');
  assert.equal(textOf(src), SAMPLE, 'source untouched');
});

test('unfold restores the collapsed text exactly', () => {
  const { pv } = identitySetup(SAMPLE);
  const fold = pv.fold(FOLD[0], FOLD[1], '[...]');
  pv.unfold(fold!);
  assert.equal(textOf(pv.buffer), SAMPLE);
});

test('an edit before a fold (write-through) maps to the right source offset', () => {
  const { pv, src } = identitySetup(SAMPLE);
  pv.fold(FOLD[0], FOLD[1], '[...]');
  insertAt(pv.buffer, 0, 'Q');
  assert.equal(textOf(src), 'Q' + SAMPLE);
  assert.equal(textOf(pv.buffer), "Qimport {[...]} from './git.ts';\n");
});

test('an edit after a fold (write-through) maps past the collapsed body', () => {
  const { pv, src } = identitySetup(SAMPLE);
  pv.fold(FOLD[0], FOLD[1], '[...]');
  insertAt(pv.buffer, textOf(pv.buffer).length - 1, '!'); // just before the trailing newline
  assert.equal(textOf(pv.buffer), "import {[...]} from './git.ts';!\n");
  assert.equal(textOf(src), "import {\n  X,\n} from './git.ts';!\n");
});

test('an external source edit propagates into a folded view, kept collapsed', () => {
  const { pv, src } = identitySetup(SAMPLE);
  pv.fold(FOLD[0], FOLD[1], '[...]');
  insertAt(src, 0, 'Z'); // a change from elsewhere, before the fold
  assert.equal(textOf(src), 'Z' + SAMPLE);
  assert.equal(textOf(pv.buffer), "Zimport {[...]} from './git.ts';\n");
});

test('an external edit inside the fold is absorbed; unfold restores it', () => {
  const { pv, src } = identitySetup(SAMPLE);
  const fold = pv.fold(FOLD[0], FOLD[1], '[...]');
  insertAt(src, 11, 'YY'); // inside the collapsed body (around the `X`)
  assert.equal(textOf(pv.buffer), "import {[...]} from './git.ts';\n", 'view stays collapsed (absorbed)');
  assert.equal(textOf(src), "import {\n  YYX,\n} from './git.ts';\n");
  pv.unfold(fold!);
  assert.equal(textOf(pv.buffer), textOf(src), 'unfold restores the grown body');
});

test('nested folds: an outer fold subsumes an inner one; model intact, unfold restores', () => {
  const { pv, src } = identitySetup('out {\n in {\n  x\n }\n}\n');
  const t = () => textOf(pv.buffer);
  pv.fold(t().indexOf('in {') + 4, t().indexOf('}'), '[3]'); // fold inner
  assert.equal(t(), 'out {\n in {[3]}\n}\n');
  const outer = pv.fold(t().indexOf('out {') + 5, t().lastIndexOf('}'), '[5]'); // fold outer (subsumes inner)
  assert.equal(t(), 'out {[5]}\n', 'outer collapses, subsuming the inner fold');
  assert.equal(textOf(src), 'out {\n in {\n  x\n }\n}\n', 'source never corrupted by nesting');
  insertAt(pv.buffer, 0, 'Z'); // edit before the nested fold still translates
  assert.equal(textOf(src), 'Zout {\n in {\n  x\n }\n}\n');
  pv.unfold(outer!);
  assert.equal(t(), 'Zout {\n in {\n  x\n }\n}\n', 'unfolding the outer restores the full body');
});

test('view↔source line + point translation across a fold', () => {
  const { pv } = identitySetup(SAMPLE);
  const fold = pv.fold(FOLD[0], FOLD[1], '[...]')!;
  // view line 0 = "import {[...]} from './git.ts';"; view line 1 (after the fold) = source line 3.
  assert.equal(pv.documentLineForScreenLine(0), 0);
  assert.equal(pv.documentLineForScreenLine(1), 3);
  assert.equal(pv.screenLineForDocumentLine(3), 1);
  // the `}` is at view column 13 on line 0, and is column 0 on source line 2.
  const mp = pv.documentPointFromScreen(new Point(0, 13));
  assert.equal(mp.row, 2);
  assert.equal(mp.column, 0);
  // round-trip a source point below the fold.
  const vp = pv.screenPointFromDocument(new Point(3, 0));
  assert.deepEqual(pv.documentPointFromScreen(vp).toArray(), [3, 0]);
  // fold introspection
  assert.deepEqual(pv.foldPlaceholderRange(fold), [8, 13]);
  assert.equal(pv.foldDocumentText(fold), "\n  X,\n");
  assert.equal(pv.isFoldAlive(fold), true);
  pv.unfold(fold);
  assert.equal(pv.isFoldAlive(fold), false);
});

test('600 edits around a fold never desync the source or the collapsed view', () => {
  const base = 'the quick brown fox jumps over the lazy dog\n';
  const { pv, src } = identitySetup(base);
  const fold = pv.fold(4, 16, '[...]')!; // collapse "quick brown "
  const collapsed = () => cpSlice(textOf(src), 0, fold.start) + fold.placeholder + cpSlice(textOf(src), fold.end);
  let ok = true;
  let why = '';
  for (let i = 0; i < 600 && ok; i++) {
    if (i % 2 === 1) {
      insertAt(pv.buffer, 0, '.'); // write-through, before the fold
    } else {
      const len = textOf(src).length;
      if (i % 3 === 0 && len > fold.end + 3) {
        const at = fold.end + 1; // delete a char safely after the fold
        deleteRange(src, at, at + 1);
      } else {
        insertAt(src, len - 1, String.fromCharCode(97 + (i % 26))); // insert after the fold
      }
    }
    if (textOf(pv.buffer) !== collapsed()) { ok = false; why = `collapsed view desync @${i}`; }
  }
  assert.ok(ok, why || 'view stayed collapsed-consistent across 600 edits');
  pv.unfold(fold);
  assert.equal(textOf(pv.buffer), textOf(src), 'unfolds to the live source after the fuzz');
});
