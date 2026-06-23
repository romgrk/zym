import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../gi.ts';
import { EditorModel } from './EditorModel.ts';
import { Document } from './Document.ts';
import { Point } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';

// EditorModel wraps a live GtkSource buffer, so these are integration tests:
// they need GTK initialized (and a display). Gtk.init is idempotent.
Gtk.init();

function model(text: string): EditorModel {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  return new EditorModel(view, buffer);
}

test('reports buffer shape including the trailing empty line', () => {
  const m = model('hello\nworld\n');
  assert.equal(m.getText(), 'hello\nworld\n');
  assert.equal(m.getLineCount(), 3);
  assert.equal(m.getLastBufferRow(), 2);
  assert.deepEqual(m.getEofBufferPosition().toArray(), [2, 0]);
});

test('lineTextForBufferRow excludes the newline', () => {
  const m = model('hello\nworld\n');
  assert.equal(m.lineTextForBufferRow(0), 'hello');
  assert.equal(m.lineTextForBufferRow(1), 'world');
  assert.equal(m.lineTextForBufferRow(2), '');
});

test('clipBufferPosition clamps rows and columns into the buffer', () => {
  const m = model('hello\nworld\n');
  assert.deepEqual(m.clipBufferPosition(new Point(1, 99)).toArray(), [1, 5]); // past line end
  assert.deepEqual(m.clipBufferPosition(new Point(99, 0)).toArray(), [2, 0]); // past last row
  assert.deepEqual(m.clipBufferPosition(new Point(-1, -5)).toArray(), [0, 0]); // before start
});

test('getTextInBufferRange returns the spanned text', () => {
  const m = model('hello\nworld\n');
  assert.equal(m.getTextInBufferRange(new Range([0, 1], [1, 3])), 'ello\nwor');
});

test('bufferRangeForBufferRow with and without the newline', () => {
  const m = model('hello\nworld\n');
  assert.deepEqual(
    [m.bufferRangeForBufferRow(0).start.toArray(), m.bufferRangeForBufferRow(0).end.toArray()],
    [[0, 0], [0, 5]],
  );
  const withNl = m.bufferRangeForBufferRow(0, { includeNewline: true });
  assert.deepEqual([withNl.start.toArray(), withNl.end.toArray()], [[0, 0], [1, 0]]);
});

test('cursor position round-trips through the insert mark', () => {
  const m = model('hello\nworld\n');
  m.setCursorBufferPosition(new Point(1, 2));
  assert.deepEqual(m.getCursorBufferPosition().toArray(), [1, 2]);
  // clamped on the way in
  m.setCursorBufferPosition(new Point(1, 99));
  assert.deepEqual(m.getCursorBufferPosition().toArray(), [1, 5]);
});

test('empty lines have a single valid column', () => {
  const m = model('a\n\nb');
  assert.equal(m.lineTextForBufferRow(1), '');
  assert.ok(m.isBufferRowBlank(1));
  assert.ok(!m.isBufferRowBlank(0));
  assert.deepEqual(m.clipBufferPosition(new Point(1, 5)).toArray(), [1, 0]);
  const r = m.bufferRangeForBufferRow(1);
  assert.ok(r.isEmpty());
});

test('onDidChangeText reports an insertion with its new range and text', () => {
  const m = model('hello\nworld\n');
  const events: any[] = [];
  m.onDidChangeText((e) => events.push(e));
  m.setTextInBufferRange(new Range([0, 5], [0, 5]), ' there');
  assert.equal(events.length, 1);
  const [change] = events[0].changes;
  assert.equal(change.newText, ' there');
  assert.equal(change.oldText, '');
  assert.ok(change.oldRange.isEmpty());
  assert.deepEqual([change.newRange.start.toArray(), change.newRange.end.toArray()], [[0, 5], [0, 11]]);
});

test('onDidChangeText reports a deletion with an empty new range and the removed text', () => {
  const m = model('hello world\n');
  const events: any[] = [];
  m.onDidChangeText((e) => events.push(e));
  m.setTextInBufferRange(new Range([0, 5], [0, 11]), ''); // delete " world"
  assert.equal(events.length, 1);
  const [change] = events[0].changes;
  assert.equal(change.oldText, ' world');
  assert.equal(change.newText, '');
  assert.ok(change.newRange.isEmpty());
  assert.deepEqual([change.oldRange.start.toArray(), change.oldRange.end.toArray()], [[0, 5], [0, 11]]);
});

test('onDidChangeText spans multi-line inserts', () => {
  const m = model('ab\n');
  const events: any[] = [];
  m.onDidChangeText((e) => events.push(e));
  m.setTextInBufferRange(new Range([0, 1], [0, 1]), 'X\nYZ'); // a|X⏎YZ|b
  const [change] = events[0].changes;
  assert.deepEqual([change.newRange.start.toArray(), change.newRange.end.toArray()], [[0, 1], [1, 2]]);
});

test('onDidChangeText fires during undo/redo (the Undo command path)', () => {
  const m = model('hello\n');
  m.setTextInBufferRange(new Range([0, 5], [0, 5]), '!'); // "hello!"
  const events: any[] = [];
  const sub = m.onDidChangeText((e) => events.push(e));
  m.undo(); // removes the "!" — a deletion
  assert.equal(events.length, 1);
  assert.ok(events[0].changes[0].newRange.isEmpty());
  assert.equal(events[0].changes[0].oldText, '!');
  sub.dispose();
  m.redo();
  assert.equal(events.length, 1); // unsubscribed: no further events
});

test('viewport geometry falls back to the whole buffer when the view is unrealized', () => {
  const m = model('a\nb\nc\nd\n');
  // Headless tests never realize the view, so geometry takes the fallback paths.
  assert.equal(m.getFirstVisibleScreenRow(), 0);
  assert.equal(m.getLastVisibleScreenRow(), m.getLastBufferRow());
  assert.equal(m.pixelRectForBufferPosition(new Point(1, 0)), null);
});

test('scan produces codepoint columns across non-BMP characters (round-trips)', () => {
  // '😀' (U+1F600) is one codepoint but two UTF-16 units. So the two "foo"s start
  // at codepoint columns 1 and 6 — not the UTF-16 indices 2 and 8.
  const m = model('😀foo 😀foo\n');
  const ranges: Range[] = [];
  m.scan(/foo/, ({ range }) => ranges.push(range));
  assert.equal(ranges.length, 2);
  assert.deepEqual(ranges[0].start.toArray(), [0, 1]);
  assert.deepEqual(ranges[1].start.toArray(), [0, 6]);
  // The codepoint ranges round-trip through iterAtPoint back to the matched text.
  assert.equal(m.getTextInBufferRange(ranges[0]), 'foo');
  assert.equal(m.getTextInBufferRange(ranges[1]), 'foo');
});

test('scan columns are codepoints across multiple non-BMP chars and lines', () => {
  const m = model('a\n😀😀x\n');
  const ranges: Range[] = [];
  m.scan(/x/, ({ range }) => ranges.push(range));
  assert.deepEqual(ranges[0].start.toArray(), [1, 2]); // after two emoji on row 1
  assert.equal(m.getTextInBufferRange(ranges[0]), 'x');
});

test('lineLength is the codepoint length (not UTF-16) on non-BMP lines', () => {
  const m = model('😀ab\nx\n'); // 😀(1 codepoint) a b → length 3, not 4
  assert.equal(m.lineLength(0), 3);
  assert.equal(m.lineLength(1), 1);
});

test('cursor end-of-line uses codepoint columns on non-BMP lines', () => {
  const m = model('😀ab\n');
  m.setCursorBufferPosition(new Point(0, 0));
  const cursor = m.getLastCursor();
  cursor.moveToEndOfLine();
  assert.deepEqual(m.getCursorBufferPosition().toArray(), [0, 3]); // codepoint EOL, not 4
  assert.ok(cursor.isAtEndOfLine());
});

// --- Fold awareness: the [...] placeholder is atomic + non-editable ----------

// A stub FoldAccess: the view text is `ab[...]cd`, placeholder at offsets [2,7).
function modelWithFold() {
  const buffer = new GtkSource.Buffer();
  buffer.setText('ab[...]cd', -1);
  const view = new GtkSource.View({ buffer });
  const m = new EditorModel(view, buffer);
  const unfolded: number[] = [];
  m.setFoldAccess({
    placeholderRanges: () => [[2, 7]],
    unfoldAt: (off) => { unfolded.push(off); return true; },
    unfoldAll: () => {},
    screenPointFromDocument: (p) => p,
    documentLineText: () => '',
    revealFoldsMatching: () => {},
  });
  return { m, buffer, unfolded };
}

test('a motion landing inside a placeholder snaps to its far edge (rightward)', () => {
  const { m } = modelWithFold();
  m.setCursorBufferPosition(new Point(0, 0));   // before the placeholder
  m.setCursorBufferPosition(new Point(0, 4));   // would land inside `[...]`
  assert.equal(m.getCursorBufferPosition().column, 7, 'snapped past the placeholder');
});

test('a leftward motion into a placeholder snaps to its near edge', () => {
  const { m } = modelWithFold();
  m.setCursorBufferPosition(new Point(0, 8));   // after the placeholder
  m.setCursorBufferPosition(new Point(0, 5));   // would land inside `[...]`
  assert.equal(m.getCursorBufferPosition().column, 2, 'snapped before the placeholder');
});

test('read-only editor: edits no-op and input stays disabled across vim modes', () => {
  const buffer = new GtkSource.Buffer();
  buffer.setText('abc\n', -1);
  const view = new GtkSource.View({ buffer });
  const m = new EditorModel(view, buffer);
  m.setReadOnly(true);
  // A vim operator (x / dd / p / change) routes through setTextInBufferRange.
  m.setTextInBufferRange(new Range(new Point(0, 0), new Point(0, 1)), 'XYZ');
  assert.equal(m.getText(), 'abc\n', 'programmatic (vim) edit rejected in read-only');
  // Entering insert mode would call setInputEnabled(true); read-only must keep input off.
  m.setInputEnabled(true);
  assert.equal(view.getEditable(), false, 'native input stays disabled in read-only');
  assert.equal(m.isReadOnly(), true);
});

test('setEditableCheck rejects edits on non-editable rows (diff phantom/header rows)', () => {
  const buffer = new GtkSource.Buffer();
  buffer.setText('a\nb\nc\n', -1);
  const view = new GtkSource.View({ buffer });
  const m = new EditorModel(view, buffer);
  m.setEditableCheck((startRow, endRow) => startRow === 1 && endRow === 1); // only row 1 editable
  m.setTextInBufferRange(new Range(new Point(0, 0), new Point(0, 0)), 'X'); // a vim op on row 0
  assert.equal(m.getText(), 'a\nb\nc\n', 'edit on a non-editable row is rejected');
  m.setTextInBufferRange(new Range(new Point(1, 0), new Point(1, 0)), 'Y'); // row 1 is editable
  assert.equal(m.getText(), 'a\nYb\nc\n', 'edit on an editable row applies');
});

test('editing across a fold reveals it and edits the real (former-folded) text', () => {
  const doc = new Document();
  doc.setText('abXYZcd\n');
  const buffer = doc.createView();
  const view = new GtkSource.View({ buffer });
  const m = new EditorModel(view, buffer);
  const fold = doc.foldScreenRange(buffer, 2, 5, '[...]'); // collapse "XYZ" → view "ab[...]cd"
  let folded = true;
  m.setFoldAccess({
    placeholderRanges: () => (folded ? [doc.foldPlaceholderRange(buffer, fold!)] : []),
    unfoldAt: () => { doc.unfoldScreen(buffer, fold!); folded = false; return true; },
    unfoldAll: () => {},
    screenPointFromDocument: (p) => p,
    documentLineText: () => '',
    revealFoldsMatching: () => {},
  });
  // Delete a range crossing the placeholder → reveal + delete the real content.
  m.setTextInBufferRange(new Range(new Point(0, 2), new Point(0, 3)), '');
  assert.equal(doc.getText(), 'abcd\n', 'the former-folded XYZ was deleted from the model');
});

test('duplicateLineBelow copies the line and moves the cursor onto the copy', () => {
  const m = model('one\ntwo\nthree\n');
  m.setCursorBufferPosition(new Point(1, 2)); // on "two"
  m.duplicateLineBelow();
  assert.equal(m.getText(), 'one\ntwo\ntwo\nthree\n');
  assert.deepEqual(m.getCursorBufferPosition().toArray(), [2, 2]); // moved down, column kept
});

test('duplicateLineAbove copies the line and keeps the cursor on the upper copy', () => {
  const m = model('one\ntwo\nthree\n');
  m.setCursorBufferPosition(new Point(1, 2)); // on "two"
  m.duplicateLineAbove();
  assert.equal(m.getText(), 'one\ntwo\ntwo\nthree\n');
  assert.deepEqual(m.getCursorBufferPosition().toArray(), [1, 2]); // stays on the upper copy
});

test('duplicateLine* are a single undo step', () => {
  const m = model('one\ntwo\n');
  m.setCursorBufferPosition(new Point(0, 0));
  m.duplicateLineBelow();
  assert.equal(m.getText(), 'one\none\ntwo\n');
  m.undo();
  assert.equal(m.getText(), 'one\ntwo\n');
});
