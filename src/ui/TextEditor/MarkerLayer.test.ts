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

test('a position marker shifts when text is inserted before it', () => {
  const m = model('abcdef\n');
  const layer = m.addMarkerLayer();
  const marker = layer.markBufferPosition(new Point(0, 3));
  assert.deepEqual(marker.getStartBufferPosition().toArray(), [0, 3]);

  m.setTextInBufferRange(new Range([0, 0], [0, 0]), 'XX'); // insert before the marker
  assert.deepEqual(marker.getStartBufferPosition().toArray(), [0, 5]);
});

test('a range marker tracks edits and grows around inserts inside it', () => {
  const m = model('abcdef\n');
  const layer = m.addMarkerLayer();
  const marker = layer.markBufferRange(new Range([0, 1], [0, 3])); // "bc"
  assert.equal(m.getTextInBufferRange(marker.getRange()), 'bc');

  m.setTextInBufferRange(new Range([0, 2], [0, 2]), 'XX'); // insert inside the range
  assert.deepEqual([marker.getRange().start.toArray(), marker.getRange().end.toArray()], [[0, 1], [0, 5]]);
  assert.equal(m.getTextInBufferRange(marker.getRange()), 'bXXc');
});

test('layer enumeration, destroy, and clear', () => {
  const m = model('abcdef\n');
  const layer = m.addMarkerLayer();
  const a = layer.markBufferPosition(new Point(0, 1));
  layer.markBufferPosition(new Point(0, 2));
  assert.equal(layer.getMarkerCount(), 2);

  a.destroy();
  assert.ok(a.isDestroyed());
  assert.equal(layer.getMarkerCount(), 1);

  layer.clear();
  assert.equal(layer.getMarkerCount(), 0);
});

test('findMarkers filters by contained position', () => {
  const m = model('abcdef\n');
  const layer = m.addMarkerLayer();
  layer.markBufferRange(new Range([0, 0], [0, 2]));
  layer.markBufferRange(new Range([0, 4], [0, 6]));
  const found = layer.findMarkers({ containsBufferPosition: new Point(0, 1) });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].getRange().start.toArray(), [0, 0]);
});

test('onDidUpdate fires on add and remove', () => {
  const m = model('abcdef\n');
  const layer = m.addMarkerLayer();
  let updates = 0;
  layer.onDidUpdate(() => updates++);
  const marker = layer.markBufferPosition(new Point(0, 1));
  marker.destroy();
  assert.equal(updates, 2);
});

test('view surface: css classes, input gating, cursor type', () => {
  const m = model('abc\n');
  m.addCssClass('normal-mode');
  assert.ok(m.hasCssClass('normal-mode'));
  m.toggleCssClass('normal-mode', false);
  assert.ok(!m.hasCssClass('normal-mode'));

  m.setInputEnabled(false);
  assert.equal(m.view.getEditable(), false);
  m.setInputEnabled(true);
  assert.equal(m.view.getEditable(), true);

  m.setBlockCursor(true);
  assert.equal(m.view.getOverwrite(), true);
});
