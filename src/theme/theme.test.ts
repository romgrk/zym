/*
 * Tests for the theme loader — `adaptTheme` deep-merges the file's nested `ui` over
 * `DEFAULT_THEME_UI`, derives the diff tints from the status colors per appearance, and
 * splits each per-capture syntax token into the color + style maps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptTheme, loadTheme } from './theme.ts';

/** A minimal dark theme; pass `ui`/`syntax` overrides in per-test. */
const base = (over: { ui?: unknown; syntax?: unknown } = {}) =>
  adaptTheme({ name: 't', appearance: 'dark', ui: over.ui as never, syntax: over.syntax as never });

test('loadTheme("quilx") resolves the shipped palette into the nested model', () => {
  const t = loadTheme('quilx');
  assert.equal(t.appearance, 'dark');
  assert.equal(t.ui.editor.foreground, '#f1f1f1');
  assert.equal(t.ui.editor.background, '#2d2d2d');
  assert.equal(t.ui.surface.popover, '#383838');
  assert.equal(t.ui.surface.selected, '#3f4b5b');
  assert.equal(t.ui.status.success, '#98be65');
  assert.equal(t.ui.search.matchCurrent, '#e5a50a59');
  assert.equal(t.syntax.keyword, '#5ab9f9');
});

test('missing UI keys fall back to DEFAULT_THEME_UI; editor.background stays undefined', () => {
  const t = base();
  assert.equal(t.ui.editor.foreground, '#ffffff'); // DEFAULT_THEME_UI
  assert.equal(t.ui.editor.background, undefined); // absent ⇒ follow system scheme
  assert.equal(t.ui.status.success, '#2ec27e'); // DEFAULT_THEME_UI
  assert.equal(t.ui.pr.open, '#3fb950'); // DEFAULT_THEME_UI
});

test('a partial concern deep-merges over the default concern', () => {
  const t = base({ ui: { status: { error: '#ff0000' } } });
  assert.equal(t.ui.status.error, '#ff0000'); // overridden
  assert.equal(t.ui.status.success, '#2ec27e'); // sibling kept from DEFAULT_THEME_UI
});

test('search.matchCurrent falls back to search.match within the concern', () => {
  const t = base({ ui: { search: { match: '#abcabc' } } });
  assert.equal(t.ui.search.match, '#abcabc');
  assert.equal(t.ui.search.matchCurrent, '#abcabc');
});

test('diff tints derive from status colors when diff is unset', () => {
  const t = base({ ui: { status: { success: '#00ff00', error: '#ff0000' } } });
  assert.match(t.ui.diff.added, /^#00[0-9a-f]{2}00[0-9a-f]{2}$/); // darkened green + alpha
  assert.match(t.ui.diff.removed, /^#[0-9a-f]{2}0000[0-9a-f]{2}$/); // darkened red + alpha
  assert.notEqual(t.ui.diff.addedWord, t.ui.diff.added); // word tint is stronger than line
});

test('explicit diff.added wins; diff.addedWord falls back to it', () => {
  const t = base({ ui: { diff: { added: '#112233' } } });
  assert.equal(t.ui.diff.added, '#112233');
  assert.equal(t.ui.diff.addedWord, '#112233'); // within-concern fallback (word ← line)
  assert.equal(t.ui.diff.filler, '#88888820'); // neutral default kept
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
  assert.deepEqual(Object.keys(t.syntax).slice(0, 3), ['string', 'keyword', 'heading']);
});

test('invalid appearance throws', () => {
  assert.throws(() => adaptTheme({ name: 'x', appearance: 'twilight' as never }), /appearance must be/);
});
