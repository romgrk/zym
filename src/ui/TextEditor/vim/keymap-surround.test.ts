import { test } from 'node:test';
import assert from 'node:assert/strict';
import Gdk from 'gi:Gdk-4.0';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
import { zym } from '../../../zym.ts';
import { EditorModel } from '../EditorModel.ts';
import { attachVim } from './index.ts';
import clipboard from './clipboard.ts';

Gtk.init();

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Build an editor whose view is the focused widget of `zym.window`, so the
// KeymapManager's `getActiveElements()` resolves to it and real keystrokes
// (driven through `onWindowKeyPressEvent`) dispatch against its VimState.
function focusedEditor(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  view.setTabWidth(4); // match the real editor (bare GtkSourceView defaults to 8)
  const editor = new EditorModel(view, buffer);
  attachVim(editor);

  editor.setCursorBufferPosition({ row: 0, column: 0 }); // setText leaves it at EOF

  const win = new Gtk.Window();
  win.setChild(view);
  zym.window = win as never;
  win.present();
  view.grabFocus();

  const press = (char: string) => {
    const keyval = Gdk.unicodeToKeyval(char.charCodeAt(0));
    zym.keymaps.onWindowKeyPressEvent(keyval, 0, 0);
  };
  const ctrl = (char: string) => {
    const keyval = Gdk.unicodeToKeyval(char.charCodeAt(0));
    zym.keymaps.onWindowKeyPressEvent(keyval, 0, Gdk.ModifierType.CONTROL_MASK);
  };
  const type = (chars: string) => {
    for (const ch of chars) press(ch);
  };
  const line = (row = 0) => editor.lineTextForBufferRow(row);
  return { editor, view, press, ctrl, type, line };
}

test('ysiw( surrounds the inner word (deferral + input capture)', async () => {
  const { type, line } = focusedEditor('hello world\n');
  type('ysiw(');
  await tick();
  assert.equal(line(), '(hello) world');
});

test('ysiw reads the pair char without selecting the target first', async () => {
  const { editor, type, line } = focusedEditor('hello world\n');
  type('ysiw'); // target motion typed; surround now awaits the pair char
  await tick();
  // The word must NOT be visually selected while we wait for the char.
  assert.equal(editor.getLastSelection().getText(), '');
  // Finish the surround so the pending focusInput doesn't leak into later tests.
  type('(');
  await tick();
  assert.equal(line(), '(hello) world');
});

test('ctrl-j splits the line at the cursor (inverse of J)', () => {
  const { editor, ctrl, line } = focusedEditor('hello world\n');
  editor.setCursorBufferPosition({ row: 0, column: 6 }); // on 'w'
  ctrl('j');
  assert.equal(line(0), 'hello ');
  assert.equal(line(1), 'world');
  // cursor rests at the end of the new first line (like i<CR><Esc>)
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 5]);
});

test('dw still deletes a word (y/d deferral falls back to the operator)', () => {
  const { type, line } = focusedEditor('hello world\n');
  type('dw');
  assert.equal(line(), 'world');
});

test('yw still yanks a word (deferral fallback to Yank)', () => {
  const { type } = focusedEditor('hello world\n');
  type('yw');
  assert.equal(clipboard.read(), 'hello ');
});

test('ds( deletes the surrounding pair', async () => {
  const { editor, type, line } = focusedEditor('(hello) world\n');
  editor.setCursorBufferPosition({ row: 0, column: 3 }); // inside the parens
  type('ds(');
  await tick();
  assert.equal(line(), 'hello world');
});

// --- `r` (square) / `k` (curly) pair aliases, shared by surround + text objects ----

test('ysiwr wraps the inner word in square brackets (r alias)', async () => {
  const { type, line } = focusedEditor('hello world\n');
  type('ysiwr');
  await tick();
  assert.equal(line(), '[hello] world');
});

test('ysiwk wraps the inner word in curly braces (k alias)', async () => {
  const { type, line } = focusedEditor('hello world\n');
  type('ysiwk');
  await tick();
  assert.equal(line(), '{hello} world');
});

test('dsk deletes a surrounding curly pair (k alias, not a literal k)', async () => {
  const { editor, type, line } = focusedEditor('{hello} world\n');
  editor.setCursorBufferPosition({ row: 0, column: 3 });
  type('dsk');
  await tick();
  assert.equal(line(), 'hello world');
});

test('cs(k changes a paren pair to curly braces (k alias as the "to" char)', async () => {
  const { editor, type, line } = focusedEditor('(hello) world\n');
  editor.setCursorBufferPosition({ row: 0, column: 3 });
  type('cs(k');
  await tick();
  assert.equal(line(), '{hello} world');
});

test('dir / dak operate on the square/curly text-object aliases', async () => {
  const sq = focusedEditor('[abc] world\n');
  sq.editor.setCursorBufferPosition({ row: 0, column: 2 }); // inside [ ]
  sq.type('dir');
  await tick();
  assert.equal(sq.line(), '[] world');

  const cu = focusedEditor('{abc} world\n');
  cu.editor.setCursorBufferPosition({ row: 0, column: 2 }); // inside { }
  cu.type('dak');
  await tick();
  assert.equal(cu.line(), ' world');
});

// --- `f` (function) surround target: dsf / csf / ysf ------------------------

test('dsf deletes the surrounding function call (fn(x) -> x)', async () => {
  const { editor, type, line } = focusedEditor('fn(x)\n');
  editor.setCursorBufferPosition({ row: 0, column: 3 }); // on 'x', inside the call
  type('dsf');
  await tick();
  assert.equal(line(), 'x');
});

test('dsf deletes a method call including its receiver (obj.fn(x) -> x)', async () => {
  const { editor, type, line } = focusedEditor('obj.fn(x)\n');
  editor.setCursorBufferPosition({ row: 0, column: 7 }); // inside the parens
  type('dsf');
  await tick();
  assert.equal(line(), 'x');
});

test('dsf works with the cursor on the function name (forwarding)', async () => {
  const { editor, type, line } = focusedEditor('fn(x)\n');
  editor.setCursorBufferPosition({ row: 0, column: 0 }); // on 'f' of the name
  type('dsf');
  await tick();
  assert.equal(line(), 'x');
});

test('csf strips the function name and enters insert before "(" (fn(x) -> |(x))', async () => {
  const { editor, view, type, line } = focusedEditor('fn(x)\n');
  editor.setCursorBufferPosition({ row: 0, column: 3 }); // inside the call
  type('csf');
  await tick();
  assert.equal(line(), '(x)');
  assert.equal(view.getEditable(), true); // insert mode
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 0]); // before '('
});

test('ysiwf wraps the inner word in a call and enters insert before "(" (x -> |(x))', async () => {
  const { editor, view, type, line } = focusedEditor('x\n');
  type('ysiwf');
  await tick();
  assert.equal(line(), '(x)');
  assert.equal(view.getEditable(), true); // insert mode
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 0]); // before '('
});

test('yswf surrounds the word with a function (x -> |(x))', async () => {
  const { editor, view, type, line } = focusedEditor('x\n');
  type('yswf');
  await tick();
  assert.equal(line(), '(x)');
  assert.equal(view.getEditable(), true); // insert mode
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 0]); // before '('
});

test('g~iw toggles case (Key ~ fix + g~ binding through the keymap)', () => {
  const { type, line } = focusedEditor('Hello world\n');
  type('g~iw');
  assert.equal(line(), 'hELLO world');
});

// --- Preserved KeymapManager behaviors (no deferral conflict) ---------------

test('i enters insert mode immediately (full match, no partial)', () => {
  const { view, press } = focusedEditor('hello\n');
  press('i');
  assert.equal(view.getEditable(), true); // insert mode enables editing
});

test('gg jumps to the first line (plain key sequence)', () => {
  const { editor, type } = focusedEditor('one\ntwo\nthree\n');
  editor.setCursorBufferPosition({ row: 2, column: 1 });
  type('gg');
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 0]);
});

test('dd deletes a line (d deferral, then d resolves in operator-pending)', () => {
  const { type, line } = focusedEditor('one\ntwo\nthree\n');
  type('dd');
  assert.equal(line(0), 'two');
});

// --- New bindings, exercised through the keymap ------------------------------

test('D deletes to end of line (single-key operator)', () => {
  const { editor, type, line } = focusedEditor('abcdef\n');
  editor.setCursorBufferPosition({ row: 0, column: 2 });
  type('D');
  assert.equal(line(), 'ab');
});

test('~ toggles case via the keymap (shifted backtick resolves)', () => {
  const { type, line } = focusedEditor('aBc\n');
  type('~');
  assert.equal(line(), 'ABc');
});

test('o opens a line below via the keymap', () => {
  const { editor, view, type } = focusedEditor('one\ntwo\n');
  type('o');
  assert.equal(view.getEditable(), true); // insert mode
  assert.equal(editor.getLineCount(), 4); // one, (new), two, trailing
});

test('} moves to the next paragraph via the keymap', () => {
  const { editor, type } = focusedEditor('a\n\nb\n');
  type('}');
  assert.equal(editor.getCursorBufferPosition().toArray()[0], 1);
});

test('gI enters insert at column 0 (g-prefixed sequence)', () => {
  const { editor, view, type } = focusedEditor('  abc\n');
  editor.setCursorBufferPosition({ row: 0, column: 4 });
  type('gI');
  assert.equal(view.getEditable(), true);
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 0]);
});

test('>> indents the current line (same-operator repeat via keymap)', () => {
  const { type, line } = focusedEditor('abc\n');
  type('>>');
  assert.equal(line(0), '    abc');
});

test('J joins lines via the keymap', () => {
  const { type, line } = focusedEditor('hello\nworld\n');
  type('J');
  assert.equal(line(0), 'hello world');
});

test('"ayy then "ap round-trips a named register through the keymap', () => {
  const { editor, type } = focusedEditor('hello\nworld\n');
  type('"ayy'); // select register a, yank the line
  editor.setCursorBufferPosition({ row: 1, column: 0 });
  type('"ap'); // select register a, put after
  assert.equal(editor.getText(), 'hello\nworld\nhello\n');
});

test('a count applies through the keymap (3l, 2dw)', () => {
  const m = focusedEditor('one two three four\n');
  m.type('3l');
  assert.deepEqual(m.editor.getCursorBufferPosition().toArray(), [0, 3]);

  const d = focusedEditor('one two three four\n');
  d.type('2dw'); // delete two words
  assert.equal(d.line(0), 'three four');
});

// --- `y d` / `y u` duplicate-line bindings (y-prefix deferral, like `y s`) ---
//
// The real wiring lives in TextEditor (registerEditingKeymapsOnce + the
// `editor:duplicate-line-*` commands). This harness only runs `attachVim`, so we
// mirror that wiring here against the same view to exercise the deferral against
// the live Yank operator.
function withDuplicateLineBindings(m: ReturnType<typeof focusedEditor>) {
  zym.keymaps.add('editor-editing-test', {
    '.TextEditor.normal-mode': {
      'y d': 'editor:duplicate-line-below',
      'y u': 'editor:duplicate-line-above',
    },
  });
  zym.commands.add(m.view, {
    'editor:duplicate-line-below': { didDispatch: () => m.editor.duplicateLineBelow() },
    'editor:duplicate-line-above': { didDispatch: () => m.editor.duplicateLineAbove() },
  });
  return m;
}

test('y d duplicates the line below via the keymap (y-prefix deferral)', () => {
  const m = withDuplicateLineBindings(focusedEditor('one\ntwo\n'));
  m.editor.setCursorBufferPosition({ row: 0, column: 1 });
  m.type('yd');
  assert.equal(m.editor.getText(), 'one\none\ntwo\n');
  assert.deepEqual(m.editor.getCursorBufferPosition().toArray(), [1, 1]);
});

test('y u duplicates the line above via the keymap', () => {
  const m = withDuplicateLineBindings(focusedEditor('one\ntwo\n'));
  m.editor.setCursorBufferPosition({ row: 1, column: 0 });
  m.type('yu');
  assert.equal(m.editor.getText(), 'one\ntwo\ntwo\n');
  assert.deepEqual(m.editor.getCursorBufferPosition().toArray(), [1, 0]);
});

test('yw still yanks a word when the duplicate-line bindings are present', () => {
  const m = withDuplicateLineBindings(focusedEditor('hello world\n'));
  m.type('yw');
  assert.equal(clipboard.read(), 'hello ');
});

// --- `g c` / `g c c` toggle-line-comments (g c-prefix deferral) --------------

function withCommentSpec(m: ReturnType<typeof focusedEditor>) {
  m.editor.setCommentSpecSource(() => ({ line: '//' }));
  return m;
}

test('g c c toggles the current line comment via the keymap', () => {
  const m = withCommentSpec(focusedEditor('one\ntwo\n'));
  m.type('gcc');
  assert.equal(m.line(0), '// one');
  assert.equal(m.line(1), 'two');
  m.type('gcc');
  assert.equal(m.line(0), 'one');
});

test('g c j toggles the current and next line (g c falls back to the operator)', () => {
  const m = withCommentSpec(focusedEditor('one\ntwo\nthree\n'));
  m.type('gcj');
  assert.equal(m.editor.getText(), '// one\n// two\nthree\n');
});

// Single-row only: extending with `j` here would go through the display-line
// motion, which overshoots by a row on this unrealized view (same for `Vj>`).
// The multi-row visual case runs on buffer-line MoveDown in extra-ops.test.ts.
test('visual g c toggles the selected row', () => {
  const m = withCommentSpec(focusedEditor('one\ntwo\n'));
  m.type('Vgc');
  assert.equal(m.editor.getText(), '// one\ntwo\n');
});
