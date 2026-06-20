/*
 * Editable diff multibuffer — SURFACE proof (Phase 3b / G5, tasks/code-editing/multibuffer.md).
 * `DiffMultiBufferView({ editable: true })` backs the NEW side with a live `Document`: editing a
 * context/added row writes through to the file's model, removed (phantom) rows reject edits, and
 * after the edit settles the diff is RE-COMPUTED and re-flowed via `ProjectionView.retarget` —
 * phantom rows appear/disappear with a minimal splice (no whole-buffer re-materialize). Pins the
 * model-level behavior; the rendering (no flash / caret-stable) is verified in the app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { Gtk } from '../../gi.ts';
import { quilx } from '../../quilx.ts';
import { DocumentRegistry } from '../TextEditor/DocumentRegistry.ts';
import { DiffMultiBufferView } from './DiffMultiBufferView.ts';
import { Range } from '../../text/Range.ts';
import { Point } from '../../text/Point.ts';

Gtk.init();
quilx.lsp.configure({ enable: false });

let tmpSeq = 0;
function tmpFile(content: string): string {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), `quilx-diffedit-${tmpSeq++}-`));
  const p = Path.join(dir, 'f.ts');
  Fs.writeFileSync(p, content);
  return p;
}

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);
const linesOf = (mbv: DiffMultiBufferView) => mbv.editor.getText().split('\n');
const flushReDiff = () => new Promise((r) => setTimeout(r, 200)); // > REDIFF_DEBOUNCE_MS

/** new (working/disk) differs from old (HEAD) at line 2: "line2" → "CHANGED". */
function setup() {
  const oldText = 'line1\nline2\nline3\n';
  const newText = 'line1\nCHANGED\nline3\n';
  const path = tmpFile(newText); // the live Document loads the NEW content from disk
  const registry = new DocumentRegistry();
  const mbv = new DiffMultiBufferView({ editable: true, documents: registry, files: [{ path, oldText, newText }] });
  return { path, registry, mbv };
}

test('editable diff: opens showing the removed (phantom) + added rows, caret at top', () => {
  const { mbv } = setup();
  // header, line1(ctx), line2(removed phantom), CHANGED(added), line3(ctx), ...
  const lines = linesOf(mbv);
  assert.ok(lines.includes('line2'), 'the removed line shows as a phantom row');
  assert.ok(lines.includes('CHANGED'), 'the added line shows');
  assert.deepEqual(mbv.editor.model.getCursorBufferPosition().toArray(), [0, 0]);
  mbv.dispose();
});

test('editable diff: filename headers are widgets — no header text row in the buffer', () => {
  const { mbv } = setup();
  assert.ok(!linesOf(mbv).some((l) => l.includes('f.ts')), 'the filename never appears as a buffer row');
  mbv.dispose();
});

test('editable diff: a re-diff that re-flows rows keeps the caret on its SOURCE line', async () => {
  // Insert a blank line before the removed lines; the re-diff re-aligns it past the removed block.
  // The caret must follow its source row (the blank), not stay at a stale view row (a phantom).
  const oldText = 'a\nB1\nB2\nc\n';
  const path = tmpFile('a\nc\n');
  const registry = new DocumentRegistry();
  const mbv = new DiffMultiBufferView({ editable: true, documents: registry, files: [{ path, oldText, newText: 'a\nc\n' }] });
  const aRow = linesOf(mbv).indexOf('a');
  // 'o'-like: open a line after `a`, caret on the new blank.
  mbv.editor.model.setTextInBufferRange(new Range(new Point(aRow, 1), new Point(aRow, 1)), '\n');
  mbv.editor.model.setCursorBufferPosition({ row: aRow + 1, column: 0 });
  await flushReDiff();
  const caret = mbv.editor.model.getCursorBufferPosition();
  assert.equal(linesOf(mbv)[caret.row], '', 'caret followed the reflow onto the blank line (not a phantom)');
  // And an edit at the caret lands on the right source row.
  mbv.editor.model.setTextInBufferRange(new Range(caret, caret), 'Z');
  assert.equal(registry.find(path)!.getText(), 'a\nZ\nc\n', 'the edit landed on the inserted line, not a shifted row');
  mbv.dispose();
});

test('editable diff: editing the added row writes through to the live new-side Document', () => {
  const { path, registry, mbv } = setup();
  const changedRow = linesOf(mbv).indexOf('CHANGED');
  assert.ok(changedRow > 0, 'found the added row');
  mbv.editor.model.setTextInBufferRange(new Range(new Point(changedRow, 0), new Point(changedRow, 0)), 'X');
  assert.equal(registry.find(path)!.getText(), 'line1\nXCHANGED\nline3\n', 'edit wrote through to the new-side model');
  mbv.dispose();
});

test('editable diff: editing a removed (phantom) row is rejected', () => {
  const { path, registry, mbv } = setup();
  const removedRow = linesOf(mbv).indexOf('line2'); // the phantom (old-side) removed line
  assert.ok(removedRow > 0, 'found the removed row');
  mbv.editor.model.setTextInBufferRange(new Range(new Point(removedRow, 0), new Point(removedRow, 0)), 'Z');
  assert.equal(registry.find(path)!.getText(), 'line1\nCHANGED\nline3\n', 'new side unchanged (phantom edit rejected)');
  mbv.dispose();
});

test('editable diff: re-diff re-flows the view — making new == old removes the phantom row', async () => {
  const { path, registry, mbv } = setup();
  const changedRow = linesOf(mbv).indexOf('CHANGED');
  // Replace "CHANGED" with "line2" so the new side once again equals the base → no diff.
  mbv.editor.model.setTextInBufferRange(new Range(new Point(changedRow, 0), new Point(changedRow, 7)), 'line2');
  assert.equal(registry.find(path)!.getText(), 'line1\nline2\nline3\n', 'new side now matches the base');
  await flushReDiff();
  const lines = linesOf(mbv);
  // With no remaining change, the windowed diff elides the whole file — the phantom `line2`
  // removed row and the `CHANGED` added row are both gone (the elision is a header-subtitle
  // widget now, not a buffer row).
  assert.ok(!lines.includes('CHANGED'), 're-diff re-flowed: the edited-away change no longer shows');
  assert.ok(!lines.includes('line2'), 'the removed phantom row is gone too');
  mbv.dispose();
});

test('editable diff: onModifiedChange fires on edit and on save (for the tab marker)', () => {
  const { mbv } = setup();
  let modified: boolean | null = null;
  mbv.onModifiedChange(() => { modified = mbv.isModified(); });
  assert.equal(mbv.isModified(), false, 'clean on open');

  const changedRow = linesOf(mbv).indexOf('CHANGED');
  mbv.editor.model.setTextInBufferRange(new Range(new Point(changedRow, 0), new Point(changedRow, 0)), 'Y');
  assert.equal(modified, true, 'fired with modified=true after the edit');

  mbv.save();
  assert.equal(modified, false, 'fired with modified=false after save');
  mbv.dispose();
});

test('editable diff: undo of an insert before removed lines splices (no whole-buffer flash)', async () => {
  // Removed lines (B1,B2) interleave the view, so a new-side undo isn't a contiguous view range
  // → the reverse-sync resync path. It must SPLICE, not setText (which flashed + jumped the caret).
  const oldText = 'a\nB1\nB2\nc\n';
  const path = tmpFile('a\nc\n'); // new side: B1,B2 removed
  const registry = new DocumentRegistry();
  const mbv = new DiffMultiBufferView({ editable: true, documents: registry, files: [{ path, oldText, newText: 'a\nc\n' }] });
  const buf = (mbv.editor.sourceView as any).getBuffer();

  const aRow = linesOf(mbv).indexOf('a');
  assert.ok(aRow >= 0, 'found the context row before the removed lines');
  // A decoration on the stable `a` row — survives a minimal splice, wiped by a whole-buffer setText.
  const tag = new Gtk.TextTag({ name: 'test:deco' } as any);
  buf.getTagTable().add(tag);
  buf.applyTag(tag, asIter(buf.getIterAtLine(aRow)), asIter(buf.getIterAtLineOffset(aRow, 1)));
  const hasDeco = () => asIter(buf.getIterAtLine(aRow)).hasTag(tag); // col 0, inside the [0,1) tag
  assert.equal(hasDeco(), true);

  // 'o'-like: open a line just after `a` (just before the removed lines).
  mbv.editor.model.setTextInBufferRange(new Range(new Point(aRow, 1), new Point(aRow, 1)), '\nNEW');
  await flushReDiff();
  assert.equal(registry.find(path)!.getText(), 'a\nNEW\nc\n', 'the insert wrote through');

  mbv.editor.model.undo();
  await flushReDiff();
  assert.equal(registry.find(path)!.getText(), 'a\nc\n', 'undo reverted the new side');
  assert.equal(hasDeco(), true, 'decoration survived undo — spliced, NOT re-materialized (no flash)');
  mbv.dispose();
});

test('editable diff: expand-context reveals elided lines; expand-all / collapse toggle', () => {
  // Two changes far apart so the unchanged middle (u0..u19) elides to a gap.
  const mid = Array.from({ length: 20 }, (_, i) => `u${i}`).join('\n');
  const oldText = `t0\nXXX\nt2\n${mid}\nb0\nYYY\nb2\n`;
  const newText = `t0\nAAA\nt2\n${mid}\nb0\nBBB\nb2\n`;
  const path = tmpFile(newText);
  const registry = new DocumentRegistry();
  const mbv = new DiffMultiBufferView({ editable: true, documents: registry, files: [{ path, oldText, newText }] });
  const windowed = linesOf(mbv).length;
  assert.ok(!linesOf(mbv).includes('u10'), 'the middle is elided initially');

  mbv.expandAll();
  const full = linesOf(mbv).length;
  assert.ok(linesOf(mbv).includes('u10') && full > windowed, 'expand-all reveals the whole file');

  mbv.collapseContext();
  assert.equal(linesOf(mbv).length, windowed, 'collapse returns to the windowed diff');
  assert.ok(!linesOf(mbv).includes('u10'));

  // From ABOVE the fold (caret on the last row of the upper window): reveal its top rows.
  mbv.editor.model.setCursorBufferPosition({ row: linesOf(mbv).indexOf('u1'), column: 0 });
  mbv.expandContextAtCursor();
  assert.ok(linesOf(mbv).includes('u2') && linesOf(mbv).length < full, 'revealed the next chunk from the top');

  // From BELOW the fold (caret on the first row of the lower window): reveal its BOTTOM rows.
  mbv.collapseContext();
  mbv.editor.model.setCursorBufferPosition({ row: linesOf(mbv).indexOf('u18'), column: 0 });
  mbv.expandContextAtCursor();
  assert.ok(linesOf(mbv).includes('u17') && !linesOf(mbv).includes('u2'), 'revealed the chunk above the caret (fold above)');
  mbv.dispose();
});

test('editable diff: undo of an `o` just before a trailing fold reverts the view', async () => {
  // bbbb is the last shown block before a trailing `⋯` fold (the elided tail).
  const oldText = 'a0\na1\na2\nx\na4\na5\na6\nb0\nb1\nb2\nb3\nb4\n';
  const newText = 'a0\na1\na2\ny\na4\na5\na6\nb0\nb1\nb2\nb3\nb4\n';
  const path = tmpFile(newText);
  const registry = new DocumentRegistry();
  const mbv = new DiffMultiBufferView({ editable: true, documents: registry, files: [{ path, oldText, newText }] });
  const before = linesOf(mbv);
  // Open a line after the last shown content row (just before the trailing fold).
  const last = before.length - 1;
  mbv.editor.model.setTextInBufferRange(new Range(new Point(last, before[last].length), new Point(last, before[last].length)), '\n');
  await flushReDiff();
  assert.notDeepEqual(linesOf(mbv), before, 'the inserted line shows');

  mbv.editor.model.undo();
  // The revert must be SYNCHRONOUS (no awaited microtask): in the GUI the paint happens before a
  // deferred re-diff would run, which left the view stale.
  assert.deepEqual(linesOf(mbv), before, 'undo reverted the view synchronously');
  assert.equal(registry.find(path)!.getText(), newText, 'and the document');
  mbv.dispose();
});

test('editable diff: save() persists the edited new-side file', () => {
  const { path, mbv } = setup();
  const changedRow = linesOf(mbv).indexOf('CHANGED');
  mbv.editor.model.setTextInBufferRange(new Range(new Point(changedRow, 0), new Point(changedRow, 0)), 'Y');
  assert.equal(mbv.isModified(), true);
  mbv.save();
  assert.equal(Fs.readFileSync(path, 'utf8'), 'line1\nYCHANGED\nline3\n', 'written to disk');
  assert.equal(mbv.isModified(), false, 'clean after save');
  mbv.dispose();
});
