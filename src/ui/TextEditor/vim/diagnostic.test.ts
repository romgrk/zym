import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.ts';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.ts';
import './motion.ts';

Gtk.init();

// Diagnostics are owned by DiagnosticsView in the app; headless we inject the
// diagnostic start positions directly so the `]d` / `[d` motions are testable.
function setup(text: string, positions: Point[]) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  editor.setDiagnosticProvider(() => positions);
  const vimState = new VimState(editor, new StatusBarManager());
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (point: Point) => editor.setCursorBufferPosition(point);
  const pos = () => editor.getCursorBufferPosition();
  return { editor, run, at, pos };
}

const LINES = Array.from({ length: 11 }, (_, i) => `line ${i} text`).join('\n') + '\n';

test(']d / [d move to the next / previous diagnostic, landing on its exact column', () => {
  const diags = [new Point(2, 5), new Point(5, 0), new Point(5, 7), new Point(9, 2)];
  const { run, at, pos } = setup(LINES, diags);

  at(new Point(0, 0));
  run('MoveToNextDiagnostic'); // ]d
  assert.deepEqual(pos(), new Point(2, 5));
  run('MoveToNextDiagnostic');
  assert.deepEqual(pos(), new Point(5, 0));
  run('MoveToNextDiagnostic'); // same line, later column
  assert.deepEqual(pos(), new Point(5, 7));

  at(new Point(10, 0));
  run('MoveToPreviousDiagnostic'); // [d
  assert.deepEqual(pos(), new Point(9, 2));
  run('MoveToPreviousDiagnostic');
  assert.deepEqual(pos(), new Point(5, 7));
});

test(']d / [d from on a diagnostic go to the adjacent one, not the current position', () => {
  const diags = [new Point(2, 5), new Point(5, 0), new Point(9, 2)];
  const { run, at, pos } = setup(LINES, diags);

  at(new Point(5, 0)); // on a diagnostic
  run('MoveToNextDiagnostic');
  assert.deepEqual(pos(), new Point(9, 2));
  at(new Point(5, 0));
  run('MoveToPreviousDiagnostic');
  assert.deepEqual(pos(), new Point(2, 5));
});

test(']d / [d no-op at the last / first diagnostic and with none', () => {
  const diags = [new Point(2, 5), new Point(5, 0), new Point(9, 2)];
  const present = setup(LINES, diags);
  present.at(new Point(9, 2)); // already at the last diagnostic
  present.run('MoveToNextDiagnostic');
  assert.deepEqual(present.pos(), new Point(9, 2));
  present.at(new Point(2, 5)); // already at the first diagnostic
  present.run('MoveToPreviousDiagnostic');
  assert.deepEqual(present.pos(), new Point(2, 5));

  const none = setup(LINES, []);
  none.at(new Point(4, 0));
  none.run('MoveToNextDiagnostic');
  assert.deepEqual(none.pos(), new Point(4, 0));
  none.run('MoveToPreviousDiagnostic');
  assert.deepEqual(none.pos(), new Point(4, 0));
});
