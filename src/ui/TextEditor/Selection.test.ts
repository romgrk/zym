import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../gi.ts';
import { EditorModel } from './EditorModel.ts';
import { Point } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';

Gtk.init();

function model(text: string): EditorModel {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  return new EditorModel(view, buffer);
}

test('the single selection and cursor are surfaced as one-element arrays', () => {
  const m = model('hello\nworld\n');
  assert.equal(m.getSelections().length, 1);
  assert.equal(m.getCursors().length, 1);
  assert.equal(m.getSelections()[0], m.getLastSelection());
  assert.equal(m.getCursors()[0], m.getLastCursor());
  assert.equal(m.getLastCursor(), m.getLastSelection().cursor);
});

test('cursor reports position, row/column, and line predicates', () => {
  const m = model('  hello\nworld\n');
  const cursor = m.getLastCursor();
  cursor.setBufferPosition(new Point(0, 0));
  assert.ok(cursor.isAtBeginningOfLine());
  assert.equal(cursor.getBufferRow(), 0);

  cursor.moveToEndOfLine();
  assert.deepEqual(cursor.getBufferPosition().toArray(), [0, 7]);
  assert.ok(cursor.isAtEndOfLine());

  cursor.moveToFirstCharacterOfLine();
  assert.deepEqual(cursor.getBufferPosition().toArray(), [0, 2]); // past the two spaces
});

test('getCurrentLineBufferRange spans the cursor line', () => {
  const m = model('hello\nworld\n');
  m.getLastCursor().setBufferPosition(new Point(1, 3));
  const range = m.getLastCursor().getCurrentLineBufferRange();
  assert.deepEqual([range.start.toArray(), range.end.toArray()], [[1, 0], [1, 5]]);
});

test('selection range, head/tail, text, reversed', () => {
  const m = model('hello\nworld\n');
  const sel = m.getLastSelection();

  sel.setBufferRange(new Range([0, 1], [1, 3]));
  assert.deepEqual(sel.getBufferRange().start.toArray(), [0, 1]);
  assert.equal(sel.getText(), 'ello\nwor');
  assert.ok(!sel.isEmpty());
  assert.ok(!sel.isReversed()); // forward: head at end
  assert.deepEqual(sel.getHeadBufferPosition().toArray(), [1, 3]);
  assert.deepEqual(sel.getTailBufferPosition().toArray(), [0, 1]);

  sel.setBufferRange(new Range([0, 1], [1, 3]), { reversed: true });
  assert.ok(sel.isReversed()); // head now at start
  assert.deepEqual(sel.getHeadBufferPosition().toArray(), [0, 1]);
});

test('setTextInBufferRange replaces text and returns the new range', () => {
  const m = model('hello world\n');
  const range = m.setTextInBufferRange(new Range([0, 0], [0, 5]), 'goodbye');
  assert.equal(m.getText(), 'goodbye world\n');
  assert.deepEqual([range.start.toArray(), range.end.toArray()], [[0, 0], [0, 7]]);
});

test('insertText replaces the selection and leaves the cursor after it', () => {
  const m = model('hello world\n');
  m.getLastSelection().setBufferRange(new Range([0, 0], [0, 5]));
  m.insertText('hi');
  assert.equal(m.getText(), 'hi world\n');
  assert.deepEqual(m.getCursorBufferPosition().toArray(), [0, 2]);
});

test('deleteSelectedText removes the selected range', () => {
  const m = model('hello world\n');
  m.getLastSelection().setBufferRange(new Range([0, 5], [0, 11]));
  m.getLastSelection().deleteSelectedText();
  assert.equal(m.getText(), 'hello\n');
});

test('transact coalesces nested edits into a single undo step', () => {
  const m = model('hello\n');
  m.transact(() => {
    m.setTextInBufferRange(new Range([0, 0], [0, 0]), 'X');
    m.setTextInBufferRange(new Range([0, 0], [0, 0]), 'Y');
  });
  assert.equal(m.getText(), 'YXhello\n');
  m.undo();
  assert.equal(m.getText(), 'hello\n'); // both edits reverted together
  m.redo();
  assert.equal(m.getText(), 'YXhello\n');
});

test('a lone edit is its own undo step', () => {
  const m = model('hello\n');
  m.setTextInBufferRange(new Range([0, 0], [0, 5]), 'bye');
  assert.equal(m.getText(), 'bye\n');
  m.undo();
  assert.equal(m.getText(), 'hello\n');
});
