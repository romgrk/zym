/*
 * Tests for the theme loader — `adaptTheme` deep-merges the file's nested `ui` over
 * `DEFAULT_THEME`, derives the diff tints from the status colors per appearance, and
 * splits each per-capture syntax token into the color + style maps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeThemeName, adaptTheme, APP_COLORS, appColorVariables, availableThemes, DEFAULT_THEME_NAME, loadTheme } from './theme.ts';

/** A minimal dark theme; pass `ui`/`syntax` overrides in per-test. */
const base = (over: { ui?: unknown; syntax?: unknown } = {}) =>
  adaptTheme({ name: 't', appearance: 'dark', ui: over.ui as never, syntax: over.syntax as never });

test('loadTheme("adwaita") resolves the libadwaita-derived palette', () => {
  const t = loadTheme('adwaita');
  assert.equal(t.appearance, 'dark');
  assert.equal(t.ui.editor.background, '#1d1d20'); // Adwaita dark view_bg_color
  assert.equal(t.followSystemScheme, false); // theme pins editor.background to view_bg
  assert.equal(t.ui.surface.popover, '#36363a'); // popover_bg_color
  assert.equal(t.ui.surface.selected, 'rgba(53, 132, 228, 0.25)'); // view_selected_color (accent @ 25%)
  assert.equal(t.ui.text.accent, '#81d0ff'); // standalone accent_color (oklab max(l,0.85))
  assert.equal(t.ui.status.error, '#ff938c'); // standalone error_color
});

test('availableThemes lists the shipped theme files, excluding the schema', () => {
  const names = availableThemes();
  assert.ok(names.includes('adwaita'));
  assert.ok(names.includes('zym'));
  assert.ok(!names.includes('theme.schema'));
});

test('activeThemeName: ZYM_THEME overrides; unknown env falls back to default', () => {
  const savedEnv = process.env.ZYM_THEME;
  const savedXdg = process.env.XDG_CONFIG_HOME;
  // Point config at an empty dir so the file lookup misses and the default applies.
  process.env.XDG_CONFIG_HOME = '/nonexistent-zym-test-config';
  try {
    process.env.ZYM_THEME = 'zym';
    assert.equal(activeThemeName(), 'zym'); // valid env wins

    process.env.ZYM_THEME = 'does-not-exist';
    assert.equal(activeThemeName(), DEFAULT_THEME_NAME); // unknown env ignored → default
  } finally {
    if (savedEnv === undefined) delete process.env.ZYM_THEME; else process.env.ZYM_THEME = savedEnv;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
  }
});

test('missing UI keys fall back to DEFAULT_THEME; omitted editor.background fills + follows system', () => {
  const t = base();
  assert.equal(t.ui.editor.foreground, '#ffffff'); // DEFAULT_THEME
  assert.equal(t.ui.editor.background, '#1e1e1e'); // filled from surface.popover (never undefined)
  assert.equal(t.followSystemScheme, true); // file omitted editor.background ⇒ follow system scheme
  assert.equal(t.ui.status.success, '#2ec27e'); // DEFAULT_THEME
  assert.equal(t.ui.pr.open, '#3fb950'); // DEFAULT_THEME
});

test('a partial concern deep-merges over the default concern', () => {
  const t = base({ ui: { status: { error: '#ff0000' } } });
  assert.equal(t.ui.status.error, '#ff0000'); // overridden
  assert.equal(t.ui.status.success, '#2ec27e'); // sibling kept from DEFAULT_THEME
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

test('appColorVariables emits one declaration per APP_COLORS entry for the scheme', () => {
  const css = appColorVariables('dark');
  const lines = css.split('\n');
  assert.equal(lines.length, Object.keys(APP_COLORS).length);
  assert.ok(lines.includes('--info-color: #78aeff;'));
  assert.ok(css.includes('--hint-fg-color: #ffffff;'));
});
