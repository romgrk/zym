import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../gi.ts';
import { EditorModel } from './EditorModel.ts';
import { Point } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';
import { handleAutoPairInsert, handleAutoPairBackspace } from './autoPair.ts';

Gtk.init();

function editor(text: string, col: number) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const e = new EditorModel(view, buffer);
  e.setCursorBufferPosition(new Point(0, col));
  return e;
}
const at = (e: EditorModel) => e.getCursorBufferPosition().column;

/** An editor with a cursor at every point in `points` (first is the primary). */
function multiCursor(text: string, points: [number, number][]) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const e = new EditorModel(view, buffer);
  e.setCursorBufferPosition(new Point(points[0][0], points[0][1]));
  for (let i = 1; i < points.length; i++) {
    e.addSelectionForBufferRange(new Range(points[i], points[i]));
  }
  return e;
}
const cursorColumns = (e: EditorModel) =>
  e.getCursorsOrderedByBufferPosition().map((c) => c.getBufferPosition().column);

test('typing an opener inserts the closer and sits between', () => {
  const e = editor('', 0);
  assert.equal(handleAutoPairInsert(e, '('), true);
  assert.equal(e.getText(), '()');
  assert.equal(at(e), 1);
});

test('each bracket/quote pairs', () => {
  for (const [open, close] of [['[', ']'], ['{', '}'], ['"', '"'], ['`', '`']]) {
    const e = editor('', 0);
    handleAutoPairInsert(e, open);
    assert.equal(e.getText(), open + close);
  }
});

test('typing a closer over an existing one steps over it', () => {
  const e = editor('()', 1);
  assert.equal(handleAutoPairInsert(e, ')'), true);
  assert.equal(e.getText(), '()'); // no duplicate
  assert.equal(at(e), 2);
});

test('backspace inside an empty pair deletes both halves', () => {
  const e = editor('()', 1);
  assert.equal(handleAutoPairBackspace(e), true);
  assert.equal(e.getText(), '');
});

test('brackets do not wrap a following word', () => {
  const e = editor('foo', 0);
  assert.equal(handleAutoPairInsert(e, '('), false);
  assert.equal(e.getText(), 'foo'); // caller inserts the bare "("
});

test('quotes stay literal after a word (apostrophes) and at string ends', () => {
  assert.equal(handleAutoPairInsert(editor('dont', 4), "'"), false); // apostrophe
  assert.equal(handleAutoPairInsert(editor('"x', 2), '"'), false); // closing after a word
});

test('non-pair characters and plain backspace are not handled', () => {
  assert.equal(handleAutoPairInsert(editor('', 0), 'a'), false);
  assert.equal(handleAutoPairBackspace(editor('ab', 1)), false);
});

test('multi-cursor: an opener pairs and sits between at every cursor', () => {
  const e = multiCursor('a\nb\n', [[0, 1], [1, 1]]);
  assert.equal(handleAutoPairInsert(e, '('), true);
  assert.equal(e.getText(), 'a()\nb()\n');
  assert.deepEqual(cursorColumns(e), [2, 2]); // each cursor between its own pair
});

test('multi-cursor: type-over steps every cursor over its closer', () => {
  const e = multiCursor('()\n()\n', [[0, 1], [1, 1]]);
  assert.equal(handleAutoPairInsert(e, ')'), true);
  assert.equal(e.getText(), '()\n()\n'); // no duplicates inserted
  assert.deepEqual(cursorColumns(e), [2, 2]);
});

test('multi-cursor: backspace deletes the empty pair at every cursor', () => {
  const e = multiCursor('()\n()\n', [[0, 1], [1, 1]]);
  assert.equal(handleAutoPairBackspace(e), true);
  assert.equal(e.getText(), '\n\n'); // both pairs gone
});

test('multi-cursor: an extra cursor that would not pair still gets the bare char', () => {
  // primary pairs (empty line), the extra sits before a word so it stays literal.
  const e = multiCursor('\nx\n', [[0, 0], [1, 0]]);
  assert.equal(handleAutoPairInsert(e, '('), true);
  assert.equal(e.getText(), '()\n(x\n');
});

test('multi-cursor: live replication does not double-insert the pair', async () => {
  // The real insert-mode flow runs with replication on; auto-pair must edit each
  // cursor itself and hold replication off, or the extra cursor gets the pair twice.
  const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve)); // let the deferred replication flush run
  const e = multiCursor('a\nb\n', [[0, 1], [1, 1]]);
  e.beginMultiCursorEditReplication();
  assert.equal(handleAutoPairInsert(e, '('), true);
  await tick();
  e.endMultiCursorEditReplication();
  assert.equal(e.getText(), 'a()\nb()\n'); // not 'a()\nb()()\n'
});
