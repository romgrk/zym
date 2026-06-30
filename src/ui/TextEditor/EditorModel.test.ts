import { test } from 'node:test';
import assert from 'node:assert/strict';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
import { EditorModel, type FoldAccess } from './EditorModel.ts';
import { Document } from './Document.ts';
import type { Screen } from './Screen.ts';
import { unwrapIter } from './iter.ts';
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

/** Text of `buffer` row `row` (no trailing newline). */
function viewLine(buffer: InstanceType<typeof GtkSource.Buffer>, row: number): string {
  const start = unwrapIter(buffer.getIterAtLine(row));
  const end = start.copy();
  if (!end.endsLine()) end.forwardToLineEnd();
  return buffer.getText(start, end, true);
}

/** An IDENTITY FoldAccess over `buffer` (screen == buffer == document), for fold tests that
 *  fabricate the collapsed view directly — `overrides` supply the fold-specific bits. */
function identityFoldAccess(
  buffer: InstanceType<typeof GtkSource.Buffer>,
  overrides: Partial<FoldAccess>,
): FoldAccess {
  return {
    placeholderRanges: () => [],
    unfoldAt: () => false,
    unfoldAll: () => {},
    screenPointFromDocument: (p) => p,
    documentPointFromScreen: (p) => p,
    documentLineForScreenLine: (row) => row,
    screenLineForDocumentLine: (row) => row,
    documentLineText: (row) => viewLine(buffer, row),
    documentLineCount: () => buffer.getLineCount(),
    documentTextInRange: (a, b) =>
      buffer.getText(unwrapIter(buffer.getIterAtLineOffset(a.row, a.column)), unwrapIter(buffer.getIterAtLineOffset(b.row, b.column)), true),
    documentText: () => buffer.getText(buffer.getStartIter(), buffer.getEndIter(), true),
    revealFoldsMatching: () => {},
    ...overrides,
  };
}

/** A FoldAccess wired to a real folded `Document` + its view `Screen` — the true buffer↔screen
 *  transform (`document == buffer` for a single file). `overrides` supply the reveal hooks. */
function documentFoldAccess(
  doc: Document,
  screen: Screen,
  overrides: Partial<FoldAccess>,
): FoldAccess {
  return {
    placeholderRanges: () => [],
    unfoldAt: () => false,
    unfoldAll: () => {},
    screenPointFromDocument: (p) => screen.screenPointFromDocument(p),
    documentPointFromScreen: (p) => screen.documentPointFromScreen(p),
    documentLineForScreenLine: (row) => screen.documentLineForScreenLine(row),
    screenLineForDocumentLine: (row) => screen.screenLineForDocumentLine(row),
    documentLineText: (row) => doc.documentLineText(row),
    documentLineCount: () => doc.documentLineCount(),
    documentTextInRange: (a, b) => doc.documentTextInRange(a, b),
    documentText: () => doc.getText(),
    revealFoldsMatching: () => {},
    ...overrides,
  };
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
  m.setFoldAccess(identityFoldAccess(buffer, {
    placeholderRanges: () => [[2, 7]],
    unfoldAt: (off) => { unfolded.push(off); return true; },
  }));
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
  const screen = doc.createView();
  const buffer = screen.buffer;
  const view = new GtkSource.View({ buffer });
  const m = new EditorModel(view, buffer);
  const fold = screen.fold(2, 5, '[...]'); // collapse "XYZ" → view "ab[...]cd"
  let folded = true;
  m.setFoldAccess(documentFoldAccess(doc, screen, {
    placeholderRanges: () => (folded ? [screen.foldPlaceholderRange(fold!)] : []),
    unfoldAt: () => { screen.unfold(fold!); folded = false; return true; },
  }));
  // A BUFFER-space delete spanning the fold's source range ("XYZ", document cols 2–5) reveals it
  // and deletes the real (former-folded) text — the cursor/vim layer speaks buffer coordinates.
  m.setTextInBufferRange(new Range(new Point(0, 2), new Point(0, 5)), '');
  assert.equal(doc.getText(), 'abcd\n', 'the former-folded XYZ was deleted from the model');
});

// --- buffer ↔ screen is real once a fold is active (docs/text-editor/coordinates.md) --------
//
// A multi-line fold: collapse view offsets 11–23 ("\nline2\nline3") of 'line0\nline1\nline2\n
// line3\nline4\n' → the screen buffer 'line0\nline1[2]\nline4\n' (4 screen rows over 6 buffer rows).
function modelWithMultilineFold() {
  const doc = new Document();
  doc.setText('line0\nline1\nline2\nline3\nline4\n');
  const screen = doc.createView();
  const buffer = screen.buffer;
  const view = new GtkSource.View({ buffer });
  const m = new EditorModel(view, buffer);
  const fold = screen.fold(11, 23, '[2]');
  m.setFoldAccess(documentFoldAccess(doc, screen, {
    placeholderRanges: () => [screen.foldPlaceholderRange(fold!)],
  }));
  return { m, buffer, doc, screen };
}

test('a fold makes buffer-space reads see the unfolded source, not the collapsed screen', () => {
  const { m, buffer } = modelWithMultilineFold();
  assert.equal(m.getLineCount(), 6, 'buffer line count is the document, not the 4 screen rows');
  assert.equal(buffer.getLineCount(), 4, 'the view buffer IS the (collapsed) screen');
  assert.equal(m.lineTextForBufferRow(2), 'line2', 'a folded (hidden) row reads its real source');
  assert.equal(m.lineTextForBufferRow(4), 'line4', 'a buffer row past the fold');
  assert.deepEqual(m.getEofBufferPosition().toArray(), [5, 0]);
  assert.equal(m.getTextInBufferRange(new Range(new Point(2, 0), new Point(3, 5))), 'line2\nline3');
});

test('a fold makes buffer↔screen row/point conversions go through the transform', () => {
  const { m } = modelWithMultilineFold();
  // 'line4' is buffer row 4 but screen row 2 (rows 2–3 collapsed onto row 1).
  assert.equal(m.screenRowForBufferRow(4), 2);
  assert.equal(m.bufferRowForScreenRow(2), 4);
  assert.deepEqual(m.screenPositionForBufferPosition(new Point(4, 3)).toArray(), [2, 3]);
  assert.deepEqual(m.bufferPositionForScreenPosition(new Point(2, 3)).toArray(), [4, 3]);

  // The cursor speaks buffer coordinates; its screen position folds down.
  m.setCursorBufferPosition(new Point(4, 2));
  assert.deepEqual(m.getCursorBufferPosition().toArray(), [4, 2]);
  assert.deepEqual(m.getCursorScreenPosition().toArray(), [2, 2]);
  assert.deepEqual(m.getLastCursor().getScreenPosition().toArray(), [2, 2]);
});

test('the LSP cursor maps a folded caret to its true document position (TextEditor.lspCursor)', () => {
  const { m, screen } = modelWithMultilineFold();
  // Caret on 'line4' — buffer row 4, but screen row 2 (rows 2–3 are collapsed onto row 1).
  m.setCursorBufferPosition(new Point(4, 2));
  // TextEditor.lspCursor() = documentPointFromScreen(screen cursor). `document == buffer` for a
  // single file, so it must recover the file position the caret actually sits on.
  const lspCursor = screen.documentPointFromScreen(m.getCursorScreenPosition());
  assert.deepEqual(lspCursor.toArray(), [4, 2], 'LSP sees the file line, not the folded screen row');
  // Regression: feeding the *buffer* point (the pre-fix bug) treats screen row 4 — past the
  // 4-row collapsed view — as a screen coordinate, overshooting past the fold.
  const buggy = screen.documentPointFromScreen(m.getCursorBufferPosition());
  assert.notDeepEqual(buggy.toArray(), [4, 2], 'feeding the buffer point overshoots past the fold');
});

test('a marker (vim mark) set past a fold round-trips in buffer space', () => {
  const { m } = modelWithMultilineFold();
  // The GTK mark lives in screen space (rides edits), but the marker API translates buffer↔screen.
  const marker = m.markBufferPosition(new Point(4, 2));
  assert.deepEqual(marker.getStartBufferPosition().toArray(), [4, 2]);
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
