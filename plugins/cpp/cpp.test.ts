/*
 * Tests for the C / C++ plugin's contributions — activated against a throwaway
 * `LanguageRegistry` via a partial `PluginContext`, so the global singleton isn't
 * touched. (The real grammar binaries are exercised in `grammar.test.ts`.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LanguageRegistry } from '../../src/lang/index.ts';
import type { PluginContext, PluginLanguages } from '../../src/plugin/types.ts';
import { cppPlugin } from './index.ts';

function activate(): LanguageRegistry {
  const reg = new LanguageRegistry();
  const languages: PluginLanguages = {
    registerLanguage: (def) => reg.registerLanguage(def),
    registerGrammar: (id, def) => reg.registerGrammar(id, def),
    registerServer: (id, def) => reg.registerServer(id, def),
    registerInjection: (rule) => reg.registerInjection(rule),
  };
  const ctx = {
    id: 'cpp',
    dir: '/plugins/cpp',
    resolve: (p: string) => new URL(`./${p}`, import.meta.url).pathname,
    languages,
  } as unknown as PluginContext;
  cppPlugin.activate(ctx);
  return reg;
}

test('detects C / C++ by extension; .h maps to C; lspLanguageId matches', () => {
  const reg = activate();
  assert.equal(reg.languageForPath('/d/main.c'), 'c');
  assert.equal(reg.languageForPath('/d/util.h'), 'c'); // header → C by convention
  assert.equal(reg.languageForPath('/d/app.cpp'), 'cpp');
  assert.equal(reg.languageForPath('/d/app.cc'), 'cpp');
  assert.equal(reg.languageForPath('/d/widget.hpp'), 'cpp');
  assert.equal(reg.languageForPath('/d/x.ts'), null); // not this plugin's concern
  assert.equal(reg.lspLanguageId('/d/main.c'), 'c');
  assert.equal(reg.lspLanguageId('/d/app.cpp'), 'cpp');
});

test('clangd serves both C and C++', () => {
  const reg = activate();
  const c = reg.activeServers('/some/a.c', { fileExists: () => false });
  assert.deepEqual(c.map((s) => s.server.name), ['clangd']);
  const cpp = reg.activeServers('/some/a.cpp', { fileExists: () => false });
  assert.deepEqual(cpp.map((s) => s.server.name), ['clangd']);
});

test('clangd activates single-file and prefers a compilation-database root', () => {
  const reg = activate();
  // singleFile: activates with no markers, rooted at the file's directory.
  const loose = reg.activeServers('/some/where/a.cpp', { fileExists: () => false });
  assert.equal(loose[0].rootDir, '/some/where');
  // With compile_commands.json present, the root is the nearest ancestor holding it.
  const rooted = reg.activeServers('/proj/src/a.cpp', {
    fileExists: (p) => p === '/proj/compile_commands.json',
  });
  assert.equal(rooted[0].rootDir, '/proj');
});

test('C + C++ grammars are registered', () => {
  const reg = activate();
  assert.ok(reg.grammarFor('c'), 'c grammar should be registered');
  assert.ok(reg.grammarFor('cpp'), 'cpp grammar should be registered');
});
