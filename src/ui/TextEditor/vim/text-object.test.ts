import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.ts';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.ts';
import './motion.ts';
import './operator.ts';
import './operator-insert.ts';
import './text-object.ts';

Gtk.init();

function setup(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  const vimState = new VimState(editor, new StatusBarManager());
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (row: number, col: number) => editor.setCursorBufferPosition(new Point(row, col));
  return { editor, vimState, run, at };
}

test('diw deletes the inner word under the cursor', () => {
  const { editor, run, at } = setup('foo bar baz\n');
  at(0, 5); // inside "bar"
  run('Delete');
  run('InnerWord');
  assert.equal(editor.getText(), 'foo  baz\n'); // "bar" gone, surrounding spaces kept
});

test('daw deletes a word including its trailing space', () => {
  const { editor, run, at } = setup('foo bar baz\n');
  at(0, 4); // start of "bar"
  run('Delete');
  run('AWord');
  assert.equal(editor.getText(), 'foo baz\n');
});

test('ciw changes the inner word and enters insert mode', () => {
  const { editor, vimState, run, at } = setup('foo bar baz\n');
  at(0, 5);
  run('Change');
  run('InnerWord');
  assert.equal(editor.getText(), 'foo  baz\n');
  assert.equal(vimState.mode, 'insert');
  // typing now inserts where "bar" was
  editor.insertText('X');
  assert.equal(editor.getText(), 'foo X baz\n');
});

test('di( deletes inside parentheses', () => {
  const { editor, run, at } = setup('call(a, b)\n');
  at(0, 6); // inside the parens
  run('Delete');
  run('InnerParenthesis');
  assert.equal(editor.getText(), 'call()\n');
});

test('ca( deletes the parentheses too', () => {
  const { editor, run, at } = setup('call(a, b)\n');
  at(0, 6);
  run('Change');
  run('AParenthesis');
  assert.equal(editor.getText(), 'call\n');
  assert.equal(editor.getText().includes('('), false);
});

test('dip / dap operate on the paragraph', () => {
  const inner = setup('a\nb\n\nc\n');
  inner.at(0, 0);
  inner.run('Delete');
  inner.run('InnerParagraph');
  assert.equal(inner.editor.getText(), '\nc\n'); // the a/b block gone, blank line kept

  const around = setup('a\nb\n\nc\n');
  around.at(0, 0);
  around.run('Delete');
  around.run('AParagraph');
  assert.equal(around.editor.getText(), 'c\n'); // block + its trailing blank gone
});

test('bracket text objects seek forward on the line (targets.vim)', () => {
  // cursor BEFORE the pair — default vim would do nothing; AllowForwarding seeks.
  const paren = setup('foo(bar)baz\n');
  paren.at(0, 0);
  paren.run('Delete');
  paren.run('InnerParenthesisAllowForwarding');
  assert.equal(paren.editor.getText(), 'foo()baz\n');

  const angle = setup('a<b>c\n');
  angle.at(0, 0);
  angle.run('Delete');
  angle.run('InnerAngleBracketAllowForwarding');
  assert.equal(angle.editor.getText(), 'a<>c\n');
});

test('bracket seeking still prefers the enclosing pair when inside one', () => {
  const { editor, run, at } = setup('(a(b)c)\n');
  at(0, 3); // on "b", inside the inner pair
  run('Delete');
  run('InnerParenthesisAllowForwarding');
  assert.equal(editor.getText(), '(a()c)\n'); // inner enclosing pair, not the outer
});

test('quote / backtick text objects seek to the next pair on the line', () => {
  const dq = setup('x = "hi"\n');
  dq.at(0, 0);
  dq.run('Delete');
  dq.run('InnerDoubleQuote');
  assert.equal(dq.editor.getText(), 'x = ""\n');

  const bt = setup('use `code` now\n');
  bt.at(0, 0);
  bt.run('Delete');
  bt.run('InnerBackTick');
  assert.equal(bt.editor.getText(), 'use `` now\n');
});

test('inner quote in the gap between strings seeks the next string (not the gap)', () => {
  // Cursor on the comma between two complete strings used to select the `, `
  // gap; it should seek forward to the next string instead.
  const sq = setup("const x = [['string1', 'string2'], ['string3']]\n");
  sq.at(0, 21); // on the first ','
  sq.run('Delete');
  sq.run('InnerSingleQuote');
  assert.equal(sq.editor.getText(), "const x = [['string1', ''], ['string3']]\n");
});

test('iW selects the WHITESPACE-delimited word', () => {
  const { editor, run, at } = setup('foo-bar baz\n');
  at(0, 0); // inside "foo-bar"
  run('Delete');
  run('InnerWholeWord');
  assert.equal(editor.getText(), ' baz\n'); // the whole "foo-bar" (not just "foo")
});

test('it / at operate on the tag contents and the tag', () => {
  const inner = setup('<a>hi</a>\n');
  inner.at(0, 4); // inside the tag
  inner.run('Delete');
  inner.run('InnerTag');
  assert.equal(inner.editor.getText(), '<a></a>\n');

  const around = setup('<a>hi</a>\n');
  around.at(0, 4);
  around.run('Delete');
  around.run('ATag');
  assert.equal(around.editor.getText(), '\n');
});

test('ia / aa operate on a function argument (with separator)', () => {
  const inner = setup('fn(a, b, c)\n');
  inner.at(0, 6); // on "b"
  inner.run('Delete');
  inner.run('InnerArguments');
  assert.equal(inner.editor.getText(), 'fn(a, , c)\n');

  const around = setup('fn(a, b, c)\n');
  around.at(0, 6);
  around.run('Delete');
  around.run('AArguments');
  assert.equal(around.editor.getText(), 'fn(a, c)\n'); // arg + its separator
});

test('ii selects the indentation block', () => {
  const { editor, run, at } = setup('def f():\n    a\n    b\nc\n');
  at(1, 5); // inside the indented body
  run('Delete');
  run('InnerIndentation');
  assert.equal(editor.getText(), 'def f():\nc\n');
});

test('ie selects the entire buffer', () => {
  const { editor, run, at } = setup('a\nb\nc\n');
  at(1, 0);
  run('Delete');
  run('InnerEntire');
  assert.equal(editor.getText(), '');
});

test('is / as operate on the sentence under the cursor', () => {
  const inner = setup('One two. Three four. Five.\n');
  inner.at(0, 10); // inside "Three four."
  inner.run('Delete');
  inner.run('InnerSentence');
  assert.equal(inner.editor.getText(), 'One two.  Five.\n'); // content+punctuation, gap kept

  const around = setup('One two. Three four. Five.\n');
  around.at(0, 10);
  around.run('Delete');
  around.run('ASentence');
  assert.equal(around.editor.getText(), 'One two. Five.\n'); // includes the trailing gap
});

test('cc changes the whole line, keeping it as one (linewise) edit', () => {
  const { editor, vimState, run, at } = setup('one\ntwo\nthree\n');
  at(1, 1);
  run('Change');
  run('Change'); // cc — repeated operator becomes linewise target
  assert.equal(vimState.mode, 'insert');
  assert.equal(editor.lineTextForBufferRow(1), ''); // line content cleared
  assert.equal(editor.getLineCount(), 4); // line still exists (one\n<empty>\nthree\n)
});

test('dih deletes the inner LHS of an assignment', () => {
  const { editor, run, at } = setup('const value = [1, 2]\n');
  at(0, 16); // anywhere on the line (in the RHS)
  run('Delete');
  run('InnerLhs');
  assert.equal(editor.getText(), ' = [1, 2]\n'); // "const value" gone
});

test('dil deletes the inner RHS, leaving a trailing semicolon', () => {
  const { editor, run, at } = setup('let a = foo();\n');
  at(0, 2);
  run('Delete');
  run('InnerRhs');
  assert.equal(editor.getText(), 'let a = ;\n'); // "foo()" gone, ";" kept
});

test('dal deletes the separator and the RHS', () => {
  const { editor, run, at } = setup('let a = foo()\n');
  at(0, 2);
  run('Delete');
  run('ARhs');
  assert.equal(editor.getText(), 'let a \n'); // "= foo()" gone
});

test('dah deletes the LHS through the separator', () => {
  const { editor, run, at } = setup('key: value\n');
  at(0, 6);
  run('Delete');
  run('ALhs');
  assert.equal(editor.getText(), ' value\n'); // "key:" gone
});

test('dgn deletes the search match at/after the cursor (uses lastSearchPattern)', () => {
  const { editor, vimState, run, at } = setup('foo bar foo baz\n');
  vimState.globalState.set('lastSearchPattern', /foo/g);
  at(0, 8); // on the 2nd "foo"
  run('Delete');
  run('SearchMatchForward');
  assert.equal(editor.getText(), 'foo bar  baz\n'); // 2nd "foo" gone
});

test('dgN deletes the previous search match', () => {
  const { editor, vimState, run, at } = setup('foo bar foo baz\n');
  vimState.globalState.set('lastSearchPattern', /foo/g);
  at(0, 8); // on the 2nd "foo"
  run('Delete');
  run('SearchMatchBackward');
  assert.equal(editor.getText(), ' bar foo baz\n'); // 1st "foo" gone
});

test('gn is inert without a search pattern', () => {
  const { editor, vimState, run, at } = setup('foo bar\n');
  vimState.globalState.set('lastSearchPattern', null); // globalState is a singleton
  at(0, 0);
  run('Delete');
  run('SearchMatchForward');
  assert.equal(editor.getText(), 'foo bar\n'); // nothing to match → no-op
});
