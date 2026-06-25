import { test } from 'node:test';
import assert from 'node:assert/strict';
// zym.ts instantiates a KeymapManager at load; import it first so the class is
// defined before that runs (KeymapManager ↔ zym is a circular import).
import './zym.ts';
import { KeymapManager, preemptsChord, compareFullMatches } from './KeymapManager.ts';

// Best-match-first ordering: lower chainIndex = nearer the focused widget.
const m = (chainIndex: number, specificity: number, priority = 0) => ({ priority, chainIndex, specificity });
const bestOf = (...ms: ReturnType<typeof m>[]) => [...ms].sort(compareFullMatches)[0];

test('getAllBindings flattens registered bindings with source, selector and priority', () => {
  const km = new KeymapManager();
  km.add('default-keymap', { '#AppWindow': { 'space n': 'notifications:toggle-log' } }, 0);
  km.add('user-keymap', { '#AppWindow': { 'space n': 'custom:thing' } }, 100);

  const rows = km.getAllBindings().filter((b) => b.keystroke === 'space n');
  assert.equal(rows.length, 2, 'one row per source for the same keystroke');

  const def = rows.find((b) => b.source === 'default-keymap')!;
  const usr = rows.find((b) => b.source === 'user-keymap')!;
  assert.equal(def.command, 'notifications:toggle-log');
  assert.equal(def.priority, 0);
  assert.equal(def.selector, '#AppWindow');
  assert.equal(usr.command, 'custom:thing');
  assert.equal(usr.priority, 100);
});

test('getAllBindings dedupes a selector that expands to multiple rules', () => {
  const km = new KeymapManager();
  // A compound selector parses into several rules; the binding should appear once.
  km.add('s', { '#A, #B': { x: 'cmd:x' } });
  const xs = km.getAllBindings().filter((b) => b.keystroke === 'x' && b.source === 's');
  assert.equal(xs.length, 1);
});

test('onBindingsChanged fires on add and remove, and stops after dispose', () => {
  const km = new KeymapManager();
  let count = 0;
  const sub = km.onBindingsChanged(() => { count++; });

  const binding = km.add('s', { '#AppWindow': { a: 'cmd:a' } });
  assert.equal(count, 1, 'add notifies');

  binding.dispose();
  assert.equal(count, 2, 'remove notifies');

  sub.dispose();
  km.add('s2', { '#AppWindow': { b: 'cmd:b' } });
  assert.equal(count, 2, 'no notification after unsubscribe');
});

test('compareFullMatches: the nearest scope wins over a more specific ancestor', () => {
  // The bug: alt-o on `#AppWindow` (a far ancestor) vs alt-o on the focused
  // `#TextEditor.normal-mode`. The focused widget (chainIndex 0) must win even
  // though the ancestor could carry the more specific selector.
  const focused = m(0, /* #TextEditor */ 1_000_000);
  const ancestor = m(5, /* #AppWindow.a.b — more specific */ 1_002_000);
  assert.deepEqual(bestOf(focused, ancestor), focused);
  // Order in the input must not matter.
  assert.deepEqual(bestOf(ancestor, focused), focused);
});

test('compareFullMatches: specificity only breaks ties on the same element', () => {
  // Two bindings on the same focused element (same chainIndex): the more specific
  // selector wins — e.g. `#TextEditor.continuous-diff.normal-mode` over the plain
  // `#TextEditor.normal-mode` vim binding.
  const specific = m(0, 1_002_000);
  const plain = m(0, 1_001_000);
  assert.deepEqual(bestOf(plain, specific), specific);
});

test('compareFullMatches: priority outranks both proximity and specificity', () => {
  // A higher-priority ancestor (e.g. a user keymap) still wins over a lower-
  // priority, nearer, more specific default binding.
  const userAncestor = m(5, 1_000_000, 100);
  const defaultFocused = m(0, 1_002_000, 0);
  assert.deepEqual(bestOf(defaultFocused, userAncestor), userAncestor);
});

test('preemptsChord: a nearer complete binding beats a farther chord', () => {
  // Focus chain indices: 0 = focused entry, 5 = the window ancestor.
  // readline `ctrl-w` (complete, index 0) vs window `ctrl-w …` (partial, index 5).
  assert.equal(preemptsChord([0], [5]), true);
});

test('preemptsChord: a same-or-nearer chord still defers', () => {
  // vim `y` (complete) and `y s` (partial) on the same element → defer.
  assert.equal(preemptsChord([2], [2]), false);
  // A chord nearer than the complete binding also blocks.
  assert.equal(preemptsChord([4], [1]), false);
});

test('preemptsChord: nothing to preempt with when there is no complete match', () => {
  // A pure multi-key prefix (e.g. `space` of `space …`) must keep deferring.
  assert.equal(preemptsChord([], [3]), false);
});

test('preemptsChord: uses the NEAREST complete match against all partials', () => {
  // Complete bindings at indices 0 and 6; the nearest (0) is closer than the
  // lone partial at 5 → preempt.
  assert.equal(preemptsChord([6, 0], [5]), true);
  // But if any partial is at/nearer than the nearest complete, defer.
  assert.equal(preemptsChord([6, 3], [3]), false);
});
