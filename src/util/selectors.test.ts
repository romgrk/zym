import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSelector,
  elementMatchKeys,
  matchesRuleInChain,
  type ElementContext,
} from './selectors.ts';

// A selector parses to one Rule (single, comma-free selectors below).
const specificityOf = (selector: string) => parseSelector(selector)[0].specificity;

// A bare ElementContext — `matchesRuleInChain`/`elementMatchKeys` only read
// `name`/`classes`, so the matcher can be exercised without real GTK widgets.
// `widget` is only used as an identity token, so a unique object stands in.
const ctx = (name: string, classes: string[] = []): ElementContext =>
  ({ widget: {} as ElementContext['widget'], name, classes });

// Build a focus chain (focused element first, ancestors after) and test whether
// the selector matches the element at `index` (default: the focused element).
const matches = (selector: string, chain: ElementContext[], index = 0) =>
  matchesRuleInChain(chain, index, parseSelector(selector)[0]);

test('specificity orders id > class > tag', () => {
  const id = specificityOf('#Panel');
  const cls = specificityOf('.panel');
  const tag = specificityOf('GtkText');
  assert.ok(id > cls, 'an id outranks a class');
  assert.ok(cls > tag, 'a class outranks a tag');
});

test('specificity: a more specific compound selector outranks a plain one', () => {
  // `#Panel .foo` (id + class) beats `.foo` (class), so it wins an equal-priority tie.
  assert.ok(specificityOf('#Panel .foo') > specificityOf('.foo'));
  // Extra classes add up: `.a.b` beats `.a`.
  assert.ok(specificityOf('.a.b') > specificityOf('.a'));
});

test('specificity: a :not() argument counts as a class', () => {
  // `:not(.mini)` contributes its argument's class specificity, like CSS.
  assert.equal(specificityOf('TextEditor:not(.mini)'), specificityOf('TextEditor.mini'));
  assert.ok(specificityOf('TextEditor:not(.mini)') > specificityOf('TextEditor'));
});

test('specificity: many tags never carry into the class column', () => {
  // The encoding must keep an id strictly above any realistic pile of tags.
  assert.ok(specificityOf('#Panel') > specificityOf('a b c d e f g h i j'));
});

test('elementMatchKeys: name, each class, then the wildcard bucket', () => {
  assert.deepEqual(elementMatchKeys(ctx('Panel', ['a', 'b'])), ['Panel', 'a', 'b', '*']);
  // No classes still yields the name and the wildcard.
  assert.deepEqual(elementMatchKeys(ctx('GtkText')), ['GtkText', '*']);
});

test('matchesRuleInChain: tag and #id both match the element name', () => {
  const chain = [ctx('TextEditor')];
  assert.ok(matches('TextEditor', chain));
  assert.ok(matches('#TextEditor', chain));
  assert.ok(!matches('GtkText', chain));
  assert.ok(!matches('#Panel', chain));
});

test('matchesRuleInChain: class and :not() match against CSS classes', () => {
  const chain = [ctx('TextEditor', ['insert-mode'])];
  assert.ok(matches('TextEditor.insert-mode', chain));
  assert.ok(matches('.insert-mode', chain));
  assert.ok(!matches('TextEditor.mini', chain));
  assert.ok(matches('TextEditor:not(.mini)', chain));
  assert.ok(!matches('TextEditor:not(.insert-mode)', chain));
});

test('matchesRuleInChain: chained :not() requires every argument absent', () => {
  // `.GitPanel .TextEditor:not(.insert-mode):not(.GitCommitInput)` (keymaps/default.ts):
  // both :not() args must be absent for the ctrl-w h chord to bind, so the editor's
  // insert-mode ctrl-w (delete-word) isn't stalled and the commit box is excluded.
  const sel = '.GitPanel .TextEditor:not(.insert-mode):not(.GitCommitInput)';
  const diff = (mode: string) => [ctx('GtkSourceView', ['TextEditor', mode]), ctx('GitPanel', ['GitPanel'])];
  const commit = (mode: string) => [ctx('GtkSourceView', ['TextEditor', 'GitCommitInput', mode]), ctx('GitPanel', ['GitPanel'])];
  assert.ok(matches(sel, diff('normal-mode')), 'diff editor in normal mode binds ctrl-w h');
  assert.ok(matches(sel, diff('visual-mode')), 'diff editor in visual mode still binds it');
  assert.ok(!matches(sel, diff('insert-mode')), 'insert mode is excluded (first :not)');
  assert.ok(!matches(sel, commit('normal-mode')), 'commit editor is excluded (second :not)');
  assert.ok(!matches(sel, commit('insert-mode')), 'commit editor in insert mode is excluded by both');
});

test('matchesRuleInChain: descendant combinator walks the chain tail', () => {
  // Focused GtkText inside a Panel inside the window.
  const chain = [ctx('GtkText'), ctx('Panel'), ctx('AppWindow')];
  assert.ok(matches('Panel GtkText', chain), 'ancestor Panel found by climbing the chain');
  assert.ok(matches('#AppWindow GtkText', chain), 'a farther ancestor still matches');
  assert.ok(!matches('Other GtkText', chain), 'a missing ancestor fails');
});

test('matchesRuleInChain: child combinator requires the direct parent', () => {
  const direct = [ctx('GtkText'), ctx('Panel')];
  assert.ok(matches('Panel > GtkText', direct), 'Panel is the immediate parent');

  // Even a single intervening element breaks the direct-child relationship.
  const indirect = [ctx('GtkText'), ctx('Box'), ctx('Panel')];
  assert.ok(!matches('Panel > GtkText', indirect), 'Panel is a grandparent, not the direct parent');
  assert.ok(matches('Panel GtkText', indirect), 'but the descendant combinator accepts it');

  // Chained child combinators require a direct step at every link.
  const chained = [ctx('C'), ctx('B'), ctx('A')];
  assert.ok(matches('A > B > C', chained), 'each parent is direct');
  const chainedGap = [ctx('C'), ctx('B'), ctx('X'), ctx('A')];
  assert.ok(!matches('A > B > C', chainedGap), 'a gap above B breaks the chain');
});

test('matchesRuleInChain: matching starts at the given index', () => {
  // The same chain, asking about the Panel ancestor at index 1 rather than the
  // focused GtkText — the matcher must treat index 1 as the subject.
  const chain = [ctx('GtkText'), ctx('Panel'), ctx('AppWindow')];
  assert.ok(matches('#AppWindow Panel', chain, 1), 'Panel matches with AppWindow as ancestor');
  assert.ok(!matches('GtkText', chain, 1), 'the focused element is not the subject here');
});
