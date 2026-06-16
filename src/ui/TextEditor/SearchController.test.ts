import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../gi.ts';
import { EditorModel } from './EditorModel.ts';
import { DecorationController } from './DecorationController.ts';
import { SearchController } from './SearchController.ts';
import { Point } from '../../text/Point.ts';
import type { PointLike } from '../../text/Point.ts';

// SearchController drives a live buffer (regex scan, cursor moves) and paints via
// DecorationController, so these are headless integration tests. Gtk.init is idempotent.
Gtk.init();

function setup(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  editor.setCursorBufferPosition(new Point(0, 0));
  const search = new SearchController(editor, new DecorationController(editor));
  return { editor, search };
}

function hasTag(editor: EditorModel, point: PointLike, tagName: string): boolean {
  const tag = editor.buffer.getTagTable().lookup(tagName);
  return tag ? (editor.iterAtPoint(point) as any).hasTag(tag) : false;
}

test('literal search finds all matches and seats on the first from the origin', () => {
  const { editor, search } = setup('foo bar foo baz foo\n');
  search.start();
  const state = search.setQuery('foo');
  assert.equal(state.count, 3);
  assert.equal(state.current, 1);
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 0]); // first match
  // every match highlighted; the current one strongly
  assert.ok(hasTag(editor, [0, 0], 'deco:search:highlight-strong'));
  assert.ok(hasTag(editor, [0, 8], 'deco:search:highlight'));
});

test('next wraps around; previous goes back', () => {
  const { editor, search } = setup('foo foo foo\n');
  search.start();
  search.setQuery('foo');
  assert.equal(search.next().current, 2);
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 4]);
  assert.equal(search.next().current, 3);
  assert.equal(search.next().current, 1); // wrap
  assert.equal(search.previous().current, 3); // wrap back
});

test('next is relative to the current cursor, not the last match', () => {
  const { editor, search } = setup('foo .. foo .. foo\n'); // matches at cols 0, 7, 14
  search.start();
  search.setQuery('foo'); // seats on the first match (cursor at 0,0)
  editor.setCursorBufferPosition(new Point(0, 10)); // move past the 2nd match by hand
  const state = search.next(); // → the 3rd match (after col 10), not the 2nd
  assert.equal(state.current, 3);
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 14]);
});

test('case modes: smart (default), sensitive, insensitive', () => {
  const { search } = setup('Foo foo FOO\n');
  search.start();
  // smartcase default: a lowercase query is insensitive...
  assert.equal(search.setQuery('foo').count, 3);
  // ...but an uppercase letter in the query makes it sensitive.
  assert.equal(search.setQuery('Foo').count, 1);
  // forced sensitive: 'foo' matches only the exact-case occurrence
  assert.equal(search.setOptions({ caseMode: 'sensitive' }).count, 1);
  search.setQuery('foo'); // re-evaluate under sensitive
  assert.equal(search.state.count, 1);
  // forced insensitive: all three regardless of case
  assert.equal(search.setOptions({ caseMode: 'insensitive' }).count, 3);
});

test('regex mode vs literal mode', () => {
  const { search } = setup('a1 b2 c3\n');
  search.start();
  assert.equal(search.setQuery('.').count, 0); // literal dot: no match
  assert.equal(search.setOptions({ useRegex: true }).count, 8); // 8 non-newline chars
});

test('invalid regex is reported, not thrown', () => {
  const { search } = setup('abc\n');
  search.start();
  search.setOptions({ useRegex: true });
  const state = search.setQuery('(');
  assert.equal(state.invalid, true);
  assert.equal(state.count, 0);
});

test('cancel restores the origin cursor and clears highlights', () => {
  const { editor, search } = setup('xx foo xx\n');
  editor.setCursorBufferPosition(new Point(0, 1));
  search.start();
  search.setQuery('foo'); // moves cursor to the match
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 3]);
  search.cancel();
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 1]); // back to origin
  assert.ok(!hasTag(editor, [0, 3], 'deco:search:highlight-strong'));
});

test('replaceAll replaces every match in one pass', () => {
  const { editor, search } = setup('foo foo foo\n');
  search.start();
  search.setQuery('foo');
  const n = search.replaceAll('bar');
  assert.equal(n, 3);
  assert.equal(editor.lineTextForBufferRow(0), 'bar bar bar');
});

test('regex replace expands capture groups', () => {
  const { editor, search } = setup('key=val\n');
  search.start();
  search.setOptions({ useRegex: true });
  search.setQuery('(\\w+)=(\\w+)');
  search.replaceAll('$2=$1');
  assert.equal(editor.lineTextForBufferRow(0), 'val=key');
});

test('replaceCurrent replaces only the current match and advances', () => {
  const { editor, search } = setup('foo foo\n');
  search.start();
  search.setQuery('foo');
  search.replaceCurrent('X');
  assert.equal(editor.lineTextForBufferRow(0), 'X foo');
  assert.equal(search.state.count, 1); // one match left
});

test('backward search seats on the last match at/before the origin', () => {
  const { editor, search } = setup('foo foo foo\n');
  editor.setCursorBufferPosition(new Point(0, 5)); // inside the 2nd "foo"
  search.start(true); // reverse
  const state = search.setQuery('foo');
  assert.equal(state.current, 2);
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 4]);
});
test('searchWord (*) steps forward off the word under the cursor and arms n/N', () => {
  const { editor, search } = setup('foo bar foo baz foo\nfoo\n');
  editor.setCursorBufferPosition(new Point(0, 0)); // on the first "foo"
  const state = search.searchWord('foo', false); // *
  assert.equal(state.count, 4);
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 8]); // next, not current
  search.next(); // n
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 16]);
  search.next(); // n wraps to the next line
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [1, 0]);
});

test('searchWord matches whole words only (skips substrings)', () => {
  const { editor, search } = setup('foo foobar barfoo foo\n');
  editor.setCursorBufferPosition(new Point(0, 0));
  const state = search.searchWord('foo', false); // *
  assert.equal(state.count, 2); // only the two standalone "foo"s
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 18]);
});

test('searchWord (#) steps backward', () => {
  const { editor, search } = setup('foo bar foo baz foo\n');
  editor.setCursorBufferPosition(new Point(0, 16)); // on the last "foo"
  search.searchWord('foo', true); // #
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 8]);
});

test('a bar query after a word search drops the whole-word constraint', () => {
  const { editor, search } = setup('foo foobar\n');
  editor.setCursorBufferPosition(new Point(0, 0));
  search.searchWord('foo', false); // whole-word; only 1 other... wraps to itself
  const state = search.setQuery('foo'); // plain bar search
  assert.equal(state.count, 2); // now matches inside "foobar" too
});

test('searchWord(wholeWord=false) — g* matches substrings too', () => {
  const { editor, search } = setup('foo foobar foo\n');
  editor.setCursorBufferPosition(new Point(0, 0));
  const state = search.searchWord('foo', false, false); // g*
  assert.equal(state.count, 3); // foo, the foo in foobar, foo
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 4]); // into "foobar"
});

test('setPatternListener publishes the active regex on each search', () => {
  const { search } = setup('foo bar foo\n');
  const captured: RegExp[] = [];
  search.setPatternListener((r) => captured.push(r));
  search.setQuery('foo');
  const pattern = captured[captured.length - 1];
  assert.ok(pattern instanceof RegExp);
  assert.ok(pattern.test('foo'));
  assert.ok(!pattern.test('xyz'));
});
