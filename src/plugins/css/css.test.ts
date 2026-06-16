/*
 * Tests for the CSS plugin's contributions — activated against a throwaway
 * `LanguageRegistry` via a partial `PluginContext`, so the global singleton isn't
 * touched. (The real grammar binaries are exercised in `grammar.test.ts`.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LanguageRegistry } from '../../lang/index.ts';
import type { PluginContext, PluginLanguages } from '../../plugin/types.ts';
import { cssPlugin } from './index.ts';

function activate(): LanguageRegistry {
  const reg = new LanguageRegistry();
  const languages: PluginLanguages = {
    registerLanguage: (def) => reg.registerLanguage(def),
    registerGrammar: (id, def) => reg.registerGrammar(id, def),
    registerServer: (id, def) => reg.registerServer(id, def),
  };
  const ctx = {
    id: 'css',
    dir: '/plugins/css',
    // resolve against the real plugin dir so the grammar's existsSync guard sees
    // the vendored wasm and registers the SCSS grammar.
    resolve: (p: string) => new URL(`./${p}`, import.meta.url).pathname,
    languages,
  } as unknown as PluginContext;
  cssPlugin.activate(ctx);
  return reg;
}

test('detects CSS / SCSS / Sass by extension; lspLanguageId matches', () => {
  const reg = activate();
  assert.equal(reg.languageForPath('/d/main.css'), 'css');
  assert.equal(reg.languageForPath('/d/_vars.scss'), 'scss');
  assert.equal(reg.languageForPath('/d/style.sass'), 'sass');
  assert.equal(reg.languageForPath('/d/x.ts'), null); // not this plugin's concern
  assert.equal(reg.lspLanguageId('/d/main.css'), 'css');
  assert.equal(reg.lspLanguageId('/d/_vars.scss'), 'scss');
  assert.equal(reg.lspLanguageId('/d/style.sass'), 'sass');
});

test('vscode-css serves css + scss; SomeSass serves sass', () => {
  const reg = activate();
  const css = reg.activeServers('/some/a.css', { fileExists: () => false });
  assert.deepEqual(css.map((s) => s.server.name), ['vscode-css-language-server']);
  const scss = reg.activeServers('/some/a.scss', { fileExists: () => false });
  assert.deepEqual(scss.map((s) => s.server.name), ['vscode-css-language-server']);
  const sass = reg.activeServers('/some/a.sass', { fileExists: () => false });
  assert.deepEqual(sass.map((s) => s.server.name), ['some-sass-language-server']);
});

test('css server activates single-file and prefers a project root', () => {
  const reg = activate();
  // singleFile: activates with no markers, rooted at the file's directory.
  const loose = reg.activeServers('/some/where/a.css', { fileExists: () => false });
  assert.equal(loose[0].rootDir, '/some/where');
  // With a marker present, the root is the nearest ancestor holding it.
  const rooted = reg.activeServers('/proj/src/a.scss', {
    fileExists: (p) => p === '/proj/package.json',
  });
  assert.equal(rooted[0].rootDir, '/proj');
});

test('CSS grammar is bundled; SCSS grammar is vendored', () => {
  const reg = activate();
  // CSS grammar comes from tree-sitter-wasms (a module specifier).
  assert.ok(reg.grammarFor('css'), 'css grammar should be registered');
  // SCSS grammar is vendored — registered when the wasm is present (it is, in-repo).
  assert.ok(reg.grammarFor('scss'), 'scss grammar should be registered');
});
