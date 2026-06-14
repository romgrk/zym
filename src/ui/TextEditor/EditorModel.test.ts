import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../gi.ts';
import { EditorModel } from './EditorModel.ts';
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
