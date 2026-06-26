/*
 * Editable diff multibuffer — SURFACE proof (Phase 3b / G5, docs/text-editor/multibuffer.md).
 * `DiffView({ editable: true })` backs the NEW side with a live `Document`: editing a
 * context/added row writes through to the file's model, removed (phantom) rows reject edits, and
 * after the edit settles the diff is RE-COMPUTED and re-flowed via `Screen.retarget` —
 * phantom rows appear/disappear with a minimal splice (no whole-buffer re-materialize). Pins the
 * model-level behavior; the rendering (no flash / caret-stable) is verified in the app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { Gtk, Gdk, GLib } from '../gi.ts';
import { tmpDir as makeTmpDir } from '../util/testTmp.ts';
import { zym } from '../zym.ts';
import { DocumentRegistry } from './TextEditor/DocumentRegistry.ts';
import { DiffView } from './DiffView.ts';
import { Range } from '../text/Range.ts';
import { Point } from '../text/Point.ts';

Gtk.init();
zym.lsp.configure({ enable: false });

// Drive the GLib main loop (the ONLY loop the app runs) with BLOCKING iterations until `done()`
// or a frame budget elapses — so the frame clock actually dispatches its ticks (a non-blocking
// `iteration(false)` only catches a tick by luck, since ticks fire on wall-clock time). A
// `queueMicrotask`/`Promise`-scheduled re-diff is invisible to this loop entirely (Node drains
// microtasks only on a libuv turn), so it never satisfies `done()` — which is the bug under test.
const pumpUntil = (done: () => boolean, maxFrames = 90) => {
  const ctx = GLib.MainContext.default();
  for (let i = 0; i < maxFrames && !done(); i++) ctx.iteration(true);
};

function tmpFile(content: string): string {
  const dir = makeTmpDir('diffedit');
  const p = Path.join(dir, 'f.ts');
  Fs.writeFileSync(p, content);
  return p;
}

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);
const linesOf = (mbv: DiffView) => mbv.editor.getText().split('\n');
const flushReDiff = () => new Promise((r) => setTimeout(r, 200)); // > REDIFF_DEBOUNCE_MS

/** new (working/disk) differs from old (HEAD) at line 2: "line2" → "CHANGED". */
function setup() {
  const oldText = 'line1\nline2\nline3\n';
  const newText = 'line1\nCHANGED\nline3\n';
  const path = tmpFile(newText); // the live Document loads the NEW content from disk
  const registry = new DocumentRegistry();
  const mbv = new DiffView({ editable: true, documents: registry, files: [{ path, oldText, newText }] });
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
  const mbv = new DiffView({ editable: true, documents: registry, files: [{ path, oldText, newText: 'a\nc\n' }] });
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
  const mbv = new DiffView({ editable: true, documents: registry, files: [{ path, oldText, newText: 'a\nc\n' }] });
  const buf = mbv.editor.sourceView.getBuffer();

  const aRow = linesOf(mbv).indexOf('a');
  assert.ok(aRow >= 0, 'found the context row before the removed lines');
  // A decoration on the stable `a` row — survives a minimal splice, wiped by a whole-buffer setText.
  const tag = new Gtk.TextTag({ name: 'test:deco' });
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
  const mbv = new DiffView({ editable: true, documents: registry, files: [{ path, oldText, newText }] });
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
  const mbv = new DiffView({ editable: true, documents: registry, files: [{ path, oldText, newText }] });
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

test('editable diff: `O` on an excerpt-first line re-diffs under the GLib loop (caret follows, not stranded on the fold-marker row)', () => {
  // A leading `⋯` gap elides the file head, so the first SHOWN row sits right under the leading
  // fold marker. `O` inserts a blank above it; the re-diff reveals the elided leading context, so
  // the inserted (added) row shifts DOWN past the now-shown rows and the caret must follow.
  //
  // This is driven through a REALIZED view + GLib frame pumping because the bug only manifests
  // under the app's actual loop: the re-diff was scheduled on a `queueMicrotask`, which Node drains
  // only on a libuv turn — never during GLib iteration — so in the app it never ran. The frame
  // clock (a tick callback) is the only scheduler that fires here, so this test fails the moment
  // the re-diff goes back to a microtask/timeout.
  const oldText = '\naaaa\naaaa\naaaa\n\nxxxx\nxxxx\nxxxx\n\nbbbb\nbbbb\nbbbb\n';
  const newText = '\naaaa\naaaa\naaaa\n\nyyyy\nyyyy\nyyyy\n\nbbbb\nbbbb\nbbbb\n';
  const path = tmpFile(newText);
  const registry = new DocumentRegistry();
  const mbv = new DiffView({ editable: true, documents: registry, files: [{ path, oldText, newText }] });

  const win = new Gtk.Window({ defaultWidth: 600, defaultHeight: 400 });
  win.setChild(mbv.root);
  zym.window = win as never;
  win.present();
  mbv.editor.sourceView.grabFocus();
  pumpUntil(() => mbv.editor.sourceView.getMapped?.());
  assert.equal(linesOf(mbv)[0], 'aaaa', 'a leading gap elides the head — first shown row is the context `aaaa`');

  mbv.editor.model.setCursorBufferPosition({ row: 0, column: 0 });
  // `O` via the real key dispatch (vim insert-above-with-newline).
  zym.keymaps.onWindowKeyPressEvent(Gdk.unicodeToKeyval('O'.charCodeAt(0)), 0, 0);
  // Let the frame clock dispatch — the re-diff runs on a tick callback (it would NEVER run under a
  // microtask here). The caret leaves row 0 only once the re-diff reflows the view.
  pumpUntil(() => mbv.editor.model.getCursorBufferPosition().row >= 2);

  const caret = mbv.editor.model.getCursorBufferPosition();
  assert.equal(linesOf(mbv)[caret.row], '', 'caret sits on the just-inserted blank row');
  assert.ok(caret.row >= 2, `caret followed the reflow off the pre-reflow top row (row ${caret.row})`);
  win.destroy();
  mbv.dispose();
});

test('editable diff: re-diff reconciles the header/gap bands in place (no teardown → no flicker)', () => {
  // The re-flow moves the bands and changes their text (the leading `⋯` subtitle disappears, the
  // trailing gap shifts), but removing + re-adding each band collapses its reserved space and
  // re-expands it a frame later — the flicker. The bands must be REUSED in place: same handle
  // objects, zero add/remove churn across the re-diff.
  const oldText = '\naaaa\naaaa\naaaa\n\nxxxx\nxxxx\nxxxx\n\nbbbb\nbbbb\nbbbb\n';
  const newText = '\naaaa\naaaa\naaaa\n\nyyyy\nyyyy\nyyyy\n\nbbbb\nbbbb\nbbbb\n';
  const path = tmpFile(newText);
  const registry = new DocumentRegistry();
  const mbv = new DiffView({ editable: true, documents: registry, files: [{ path, oldText, newText }] });

  const win = new Gtk.Window({ defaultWidth: 600, defaultHeight: 400 });
  win.setChild(mbv.root);
  zym.window = win as never;
  win.present();
  mbv.editor.sourceView.grabFocus();
  pumpUntil(() => mbv.editor.sourceView.getMapped?.());

  // Spy on band churn: any add/remove across the re-diff would mean a teardown (the flicker).
  let adds = 0, removes = 0;
  const ib = mbv.editor.inlineBlocks;
  const origAdd = ib.add.bind(ib);
  ib.add = (o: any) => { adds++; return origAdd(o); };
  const entries = (mbv as any).bands.entries as Map<string, { handle: any }>;
  const header = entries.get('header:0')!.handle;
  const gap = entries.get('gap:0')!.handle;
  for (const h of [header, gap]) { const r = h.remove.bind(h); h.remove = () => { removes++; return r(); }; }

  mbv.editor.model.setCursorBufferPosition({ row: 0, column: 0 });
  zym.keymaps.onWindowKeyPressEvent(Gdk.unicodeToKeyval('O'.charCodeAt(0)), 0, 0);
  pumpUntil(() => mbv.editor.model.getCursorBufferPosition().row >= 2);

  assert.equal(adds, 0, 'no bands added across the re-diff (reused in place)');
  assert.equal(removes, 0, 'no bands removed across the re-diff (reused in place)');
  assert.equal(entries.get('header:0')!.handle, header, 'the header band handle is the same (reused, not recreated)');
  assert.equal(entries.get('gap:0')!.handle, gap, 'the gap band handle is the same (reused, not recreated)');
  win.destroy();
  mbv.dispose();
});

test('editable diff: the gutter bottom-aligns an excerpt-first row, top-aligns the rest', () => {
  // An excerpt's first row carries the filename-header band ABOVE it, so its gutter cell is taller;
  // the line number must bottom-align to sit on the text instead of floating up beside the header
  // widget. Every other row (incl. a row with a `⋯` gap band BELOW it) stays top-aligned.
  const oldText = '\naaaa\naaaa\naaaa\n\nxxxx\nxxxx\nxxxx\n\nbbbb\nbbbb\nbbbb\n';
  const newText = '\naaaa\naaaa\naaaa\n\nyyyy\nyyyy\nyyyy\n\nbbbb\nbbbb\nbbbb\n';
  const path = tmpFile(newText);
  const registry = new DocumentRegistry();
  const mbv = new DiffView({ editable: true, documents: registry, files: [{ path, oldText, newText }] });
  const win = new Gtk.Window({ defaultWidth: 600, defaultHeight: 400 });
  win.setChild(mbv.root);
  zym.window = win as never;
  win.present();
  mbv.editor.sourceView.grabFocus();
  pumpUntil(() => mbv.editor.sourceView.getMapped?.());

  const renderer = ((mbv as any).lineNumbers as any).renderer;
  assert.deepEqual([...renderer.headerRows], [0], 'view row 0 is the excerpt-first row (header band above)');
  renderer.queryData(null, 0);
  assert.equal(renderer.yalign, 1, 'excerpt-first row bottom-aligns the number onto the text line');
  renderer.queryData(null, 1);
  assert.equal(renderer.yalign, 0, 'a normal row top-aligns');
  win.destroy();
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
