/*
 * Tests for the HTML plugin's contributions — activated against a throwaway
 * `LanguageRegistry` via a partial `PluginContext`, so the global singletons
 * aren't touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LanguageRegistry } from '../../src/lang/index.ts';
import type { PluginContext, PluginLanguages } from '../../src/plugin/types.ts';
import { htmlPlugin } from './index.ts';

function activate(): LanguageRegistry {
  const reg = new LanguageRegistry();
  const languages: PluginLanguages = {
    registerLanguage: (def) => reg.registerLanguage(def),
    registerGrammar: (id, def) => reg.registerGrammar(id, def),
    registerServer: (id, def) => reg.registerServer(id, def),
    registerInjection: (rule) => reg.registerInjection(rule),
  };
  const ctx = {
    id: 'html',
    dir: '/plugins/html',
    resolve: (p: string) => `/plugins/html/${p}`,
    languages,
  } as unknown as PluginContext;
  htmlPlugin.activate(ctx);
  return reg;
}

test('detects HTML by extension; lspLanguageId is html', () => {
  const reg = activate();
  assert.equal(reg.languageForPath('/d/index.html'), 'html');
  assert.equal(reg.languageForPath('/d/page.htm'), 'html');
  assert.equal(reg.languageForPath('/d/x.xhtml'), 'html');
  assert.equal(reg.languageForPath('/d/x.ts'), null); // not this plugin's concern
  assert.equal(reg.lspLanguageId('/d/index.html'), 'html');
});

test('registers an html grammar with <script>/<style> injections', () => {
  const reg = activate();
  const grammar = reg.grammarFor('html');
  assert.ok(grammar, 'html grammar registered');
  assert.equal(grammar!.foldsPath, '/plugins/html/queries/html/folds.scm');
  const langs = (grammar!.injections ?? []).map((i) => i.language).sort();
  assert.deepEqual(langs, ['css', 'js']);
});

test('registers css as an injection-only grammar (no .css detection)', () => {
  const reg = activate();
  assert.ok(reg.grammarFor('css'), 'css grammar registered for <style> injection');
  // No language detection is contributed for CSS — that is a future CSS plugin.
  assert.equal(reg.languageForPath('/d/styles.css'), null);
});

test('vscode-html-language-server activates single-file (no project markers)', () => {
  const reg = activate();
  const active = reg.activeServers('/some/where/index.html', { fileExists: () => false });
  assert.deepEqual(active.map((a) => a.server.name), ['vscode-html-language-server']);
  assert.equal(active[0].rootDir, '/some/where');
});
