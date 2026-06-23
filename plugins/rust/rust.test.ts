/*
 * Tests for the Rust plugin's contributions — activated against a throwaway
 * `LanguageRegistry` via a partial `PluginContext`, so the global singleton isn't
 * touched. (The real grammar binary is exercised in `grammar.test.ts`.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LanguageRegistry } from '../../src/lang/index.ts';
import type { PluginContext, PluginLanguages } from '../../src/plugin/types.ts';
import { rustPlugin } from './index.ts';

function activate(): LanguageRegistry {
  const reg = new LanguageRegistry();
  const languages: PluginLanguages = {
    registerLanguage: (def) => reg.registerLanguage(def),
    registerGrammar: (id, def) => reg.registerGrammar(id, def),
    registerServer: (id, def) => reg.registerServer(id, def),
    registerInjection: (rule) => reg.registerInjection(rule),
  };
  const ctx = {
    id: 'rust',
    dir: '/plugins/rust',
    resolve: (p: string) => new URL(`./${p}`, import.meta.url).pathname,
    languages,
  } as unknown as PluginContext;
  rustPlugin.activate(ctx);
  return reg;
}

test('detects Rust by extension; lspLanguageId matches', () => {
  const reg = activate();
  assert.equal(reg.languageForPath('/d/main.rs'), 'rust');
  assert.equal(reg.languageForPath('/d/x.ts'), null); // not this plugin's concern
  assert.equal(reg.lspLanguageId('/d/main.rs'), 'rust');
});

test('rust-analyzer activates at a Cargo workspace root', () => {
  const reg = activate();
  const servers = reg.activeServers('/proj/src/main.rs', {
    fileExists: (p) => p === '/proj/Cargo.toml',
  });
  assert.deepEqual(servers.map((s) => s.server.name), ['rust-analyzer']);
  assert.equal(servers[0].rootDir, '/proj');
});

test('rust-analyzer does not activate without a workspace root (no singleFile)', () => {
  const reg = activate();
  const servers = reg.activeServers('/loose/main.rs', { fileExists: () => false });
  assert.deepEqual(servers.map((s) => s.server.name), []);
});

test('Rust grammar is bundled', () => {
  const reg = activate();
  assert.ok(reg.grammarFor('rust'), 'rust grammar should be registered');
});
