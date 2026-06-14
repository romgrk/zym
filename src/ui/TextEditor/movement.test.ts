import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../gi.ts';
import { EditorModel } from './EditorModel.ts';
import { Point } from '../../text/Point.ts';

Gtk.init();

function model(text: string): EditorModel {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  return new EditorModel(view, buffer);
}

test('moveLeft/moveRight stop at line ends without wrap', () => {
  const m = model('ab\ncd\n');
  const cursor = m.getLastCursor();

  cursor.setBufferPosition(new Point(0, 0));
  cursor.moveLeft();
  assert.deepEqual(cursor.getBufferPosition().toArray(), [0, 0]); // clamped at column 0

  cursor.setBufferPosition(new Point(0, 2));
  cursor.moveRight();
  assert.deepEqual(cursor.getBufferPosition().toArray(), [0, 2]); // clamped at line end
});

test('moveLeft/moveRight wrap across lines when allowed', () => {
  const m = model('ab\ncd\n');
  const cursor = m.getLastCursor();

  cursor.setBufferPosition(new Point(1, 0));
  cursor.moveLeft(1, { allowWrap: true });
  assert.deepEqual(cursor.getBufferPosition().toArray(), [0, 2]); // end of previous line

  cursor.moveRight(1, { allowWrap: true });
  assert.deepEqual(cursor.getBufferPosition().toArray(), [1, 0]); // start of next line
});

test('moveRight honors a count', () => {
  const m = model('abcdef\n');
  const cursor = m.getLastCursor();
  cursor.setBufferPosition(new Point(0, 0));
  cursor.moveRight(3);
  assert.deepEqual(cursor.getBufferPosition().toArray(), [0, 3]);
});

test('vertical motion remembers the goal column across short lines', () => {
  const m = model('hello world\nx\nhello again\n');
  const cursor = m.getLastCursor();
  cursor.setBufferPosition(new Point(0, 10));

  cursor.moveDown();
  // row 1 ("x") is shorter — cursor clamps to its end but remembers column 10
  assert.deepEqual(cursor.getBufferPosition().toArray(), [1, 1]);
  assert.equal(cursor.goalColumn, 10);

  cursor.moveDown();
  // row 2 is long again — cursor returns to the remembered column
  assert.deepEqual(cursor.getBufferPosition().toArray(), [2, 10]);
});

test('an explicit horizontal move clears the goal column', () => {
  const m = model('hello world\nx\nhello again\n');
  const cursor = m.getLastCursor();
  cursor.setBufferPosition(new Point(0, 10));
  cursor.moveDown(); // sets goalColumn = 10
  cursor.moveLeft(); // horizontal move resets the goal
  assert.equal(cursor.goalColumn, null);
  cursor.moveDown();
  // goal was cleared, so it tracks the current column (0 on "x") downward
  assert.deepEqual(cursor.getBufferPosition().toArray(), [2, 0]);
});
