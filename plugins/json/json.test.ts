/*
 * Tests for the JSON plugin's contributions — activated against a throwaway
 * `LanguageRegistry` via a partial `PluginContext`, so the global singleton isn't
 * touched. (The real grammar binary is exercised in `grammar.test.ts`.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LanguageRegistry } from '../../src/lang/index.ts';
import type { PluginContext, PluginLanguages } from '../../src/plugin/types.ts';
import { jsonPlugin } from './index.ts';

function activate(): LanguageRegistry {
  const reg = new LanguageRegistry();
  const languages: PluginLanguages = {
    registerLanguage: (def) => reg.registerLanguage(def),
    registerGrammar: (id, def) => reg.registerGrammar(id, def),
    registerServer: (id, def) => reg.registerServer(id, def),
    registerInjection: (rule) => reg.registerInjection(rule),
  };
  const ctx = {
    id: 'json',
    dir: '/plugins/json',
    resolve: (p: string) => new URL(`./${p}`, import.meta.url).pathname,
    languages,
  } as unknown as PluginContext;
  jsonPlugin.activate(ctx);
  return reg;
}

test('detects JSON / JSONC by extension; lspLanguageId matches', () => {
  const reg = activate();
  assert.equal(reg.languageForPath('/d/package.json'), 'json');
  assert.equal(reg.languageForPath('/d/tsconfig.jsonc'), 'jsonc');
  assert.equal(reg.languageForPath('/d/x.ts'), null); // not this plugin's concern
  assert.equal(reg.lspLanguageId('/d/package.json'), 'json');
  assert.equal(reg.lspLanguageId('/d/tsconfig.jsonc'), 'jsonc');
});

test('vscode-json serves json + jsonc', () => {
  const reg = activate();
  const json = reg.activeServers('/some/a.json', { fileExists: () => false });
  assert.deepEqual(json.map((s) => s.server.name), ['vscode-json-language-server']);
  const jsonc = reg.activeServers('/some/a.jsonc', { fileExists: () => false });
  assert.deepEqual(jsonc.map((s) => s.server.name), ['vscode-json-language-server']);
});

test('json server activates single-file and prefers a project root', () => {
  const reg = activate();
  // singleFile: activates with no markers, rooted at the file's directory.
  const loose = reg.activeServers('/some/where/a.json', { fileExists: () => false });
  assert.equal(loose[0].rootDir, '/some/where');
  // With a marker present, the root is the nearest ancestor holding it.
  const rooted = reg.activeServers('/proj/src/a.json', {
    fileExists: (p) => p === '/proj/package.json',
  });
  assert.equal(rooted[0].rootDir, '/proj');
});

test('JSON + JSONC grammars are bundled (same json grammar)', () => {
  const reg = activate();
  assert.ok(reg.grammarFor('json'), 'json grammar should be registered');
  assert.ok(reg.grammarFor('jsonc'), 'jsonc grammar should be registered');
});
