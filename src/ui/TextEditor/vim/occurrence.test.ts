import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.ts';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.ts';
import './operator.ts';
import './operator-insert.ts';
import './operator-transform-string.ts';
import './text-object.ts';
import './motion.ts';

Gtk.init();

function setup(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  const vimState = new VimState(editor, new StatusBarManager());
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (row: number, col = 0) => editor.setCursorBufferPosition(new Point(row, col));
  return { editor, vimState, run, at };
}

const TEXT = 'foo bar foo\nbaz foo qux\n';

test('o operator-modifier: `d o p` deletes every occurrence of the cursor word in the paragraph', () => {
  const { editor, vimState, run, at } = setup(TEXT);
  at(0, 0); // on the first `foo`
  run('Delete');
  vimState.setOperatorModifier({ occurrence: true, occurrenceType: 'base' });
  run('InnerParagraph');
  assert.equal(editor.getText(), ' bar \nbaz  qux\n');
});

test('o operator-modifier: `g U o p` upcases every occurrence in the paragraph', () => {
  const { editor, vimState, run, at } = setup(TEXT);
  at(0, 0);
  run('UpperCase');
  vimState.setOperatorModifier({ occurrence: true, occurrenceType: 'base' });
  run('InnerParagraph');
  assert.equal(editor.getText(), 'FOO bar FOO\nbaz FOO qux\n');
});

test('the occurrence is bounded to its target — only `foo` inside the operated range changes', () => {
  // Two paragraphs; operate on the first only.
  const { editor, vimState, run, at } = setup('foo a foo\n\nfoo b foo\n');
  at(0, 0);
  run('Delete');
  vimState.setOperatorModifier({ occurrence: true, occurrenceType: 'base' });
  run('InnerParagraph');
  assert.equal(editor.getText(), ' a \n\nfoo b foo\n'); // second paragraph untouched
});

test('preset occurrence: `g o` marks the cursor word everywhere, toggles off on a marked word', () => {
  const { vimState, run, at } = setup(TEXT);
  at(0, 0);
  run('TogglePresetOccurrence');
  const om = vimState.occurrenceManager;
  assert.equal(om.hasMarkers(), true);
  assert.equal(om.getMarkerBufferRanges().length, 3); // three `foo`s

  // getMarkerAtPoint finds the marker covering a `foo` and nothing on `bar`.
  assert.ok(om.getMarkerAtPoint(new Point(0, 1))); // inside the first foo
  assert.equal(om.getMarkerAtPoint(new Point(0, 5)), undefined); // on `bar`

  at(0, 0);
  run('TogglePresetOccurrence'); // toggle the marker under the cursor off
  assert.equal(om.getMarkerBufferRanges().length, 2);
});

test('preset occurrence drives a later operator: `g o` then `d a p` deletes the marked words in the paragraph', () => {
  const { editor, run, at } = setup(TEXT);
  at(0, 0);
  run('TogglePresetOccurrence'); // preset markers on every `foo`
  run('Delete');
  run('AParagraph'); // operator picks up the preset occurrence automatically
  assert.equal(editor.getText(), ' bar \nbaz  qux\n');
});
