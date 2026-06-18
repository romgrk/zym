/*
 * Tests for the theme loader — `adaptTheme` normalizes our owned theme format into
 * the internal `Theme`: concern-first UI keys resolved by longest-prefix fallback,
 * diff tints derived from status colors per appearance, and per-capture syntax
 * tokens split into the color + style maps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptTheme, loadTheme } from './theme.ts';

/** A minimal dark theme; spread `ui`/`syntax` overrides in per-test. */
const base = (over: { ui?: Record<string, string>; syntax?: Record<string, unknown> } = {}) =>
  adaptTheme({ name: 't', appearance: 'dark', ui: over.ui ?? {}, syntax: (over.syntax ?? {}) as never });

test('loadTheme("quilx") resolves the shipped palette', () => {
  const t = loadTheme('quilx');
  assert.equal(t.appearance, 'dark');
  assert.equal(t.ui.fg, '#f1f1f1');
  assert.equal(t.ui.bg, '#2d2d2d');
  assert.equal(t.ui.popoverBg, '#383838'); // surface.popover
  assert.equal(t.ui.selectedBg, '#3f4b5b'); // surface.selected
  assert.equal(t.ui.success, '#98be65'); // status.success
  assert.equal(t.ui.searchMatchCurrent, '#e5a50a59');
  assert.equal(t.syntax.keyword, '#5ab9f9');
});

test('missing UI keys fall back to DEFAULT_UI; bg stays undefined', () => {
  const t = base();
  assert.equal(t.ui.fg, '#ffffff'); // DEFAULT_UI.fg
  assert.equal(t.ui.bg, undefined); // absent ⇒ follow system scheme
  assert.equal(t.ui.success, '#2ec27e'); // DEFAULT_UI.success
});

test('concern-first fallback: search.match.current ← search.match', () => {
  const t = base({ ui: { 'search.match': '#abcabc' } });
  assert.equal(t.ui.searchMatch, '#abcabc');
  assert.equal(t.ui.searchMatchCurrent, '#abcabc'); // inherits within the search concern
});

test('diff tints derive from status colors when diff.* is unset', () => {
  const t = base({ ui: { 'status.success': '#00ff00', 'status.error': '#ff0000' } });
  // dark ⇒ darkened accent + alpha; greener channel dominates for added, red for removed
  assert.match(t.ui.diffAddedBg, /^#00[0-9a-f]{2}00[0-9a-f]{2}$/);
  assert.match(t.ui.diffRemovedBg, /^#[0-9a-f]{2}0000[0-9a-f]{2}$/);
  assert.notEqual(t.ui.diffAddedWordBg, t.ui.diffAddedBg); // word tint is stronger than line
});

test('explicit diff.added wins; diff.added.word falls back to it', () => {
  const t = base({ ui: { 'diff.added': '#112233' } });
  assert.equal(t.ui.diffAddedBg, '#112233');
  assert.equal(t.ui.diffAddedWordBg, '#112233'); // within-concern fallback (word ← line)
});

test('syntax token splits into color + style; preserves key order', () => {
  const t = base({
    syntax: {
      string: { color: '#aaa' },
      keyword: { color: '#bbb', bold: true, italic: true },
      heading: { color: '#ccc', scale: 1.5, underline: true },
    },
  });
  assert.equal(t.syntax.keyword, '#bbb');
  assert.deepEqual(t.syntaxStyle.keyword, { bold: true, italic: true });
  assert.deepEqual(t.syntaxStyle.heading, { underline: true, scale: 1.5 });
  assert.equal(t.syntaxStyle.string, undefined); // no style fields ⇒ no entry
  // key order (tag priority) preserved from the JSON
  assert.deepEqual(Object.keys(t.syntax).slice(0, 3), ['string', 'keyword', 'heading']);
});

test('invalid appearance throws', () => {
  assert.throws(() => adaptTheme({ name: 'x', appearance: 'twilight' as never }), /appearance must be/);
});
