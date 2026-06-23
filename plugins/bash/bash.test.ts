/*
 * Tests for the Bash plugin's contributions — activated against a throwaway
 * `LanguageRegistry` via a partial `PluginContext`, so the global singleton isn't
 * touched. (The real grammar binary is exercised in `grammar.test.ts`.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LanguageRegistry } from '../../src/lang/index.ts';
import { installInvocation } from '../../src/lsp/installer.ts';
import type { PluginContext, PluginLanguages } from '../../src/plugin/types.ts';
import { bashPlugin } from './index.ts';

function activate(): LanguageRegistry {
  const reg = new LanguageRegistry();
  const languages: PluginLanguages = {
    registerLanguage: (def) => reg.registerLanguage(def),
    registerGrammar: (id, def) => reg.registerGrammar(id, def),
    registerServer: (id, def) => reg.registerServer(id, def),
    registerInjection: (rule) => reg.registerInjection(rule),
  };
  const ctx = {
    id: 'bash',
    dir: '/plugins/bash',
    resolve: (p: string) => new URL(`./${p}`, import.meta.url).pathname,
    languages,
  } as unknown as PluginContext;
  bashPlugin.activate(ctx);
  return reg;
}

test('detects shell by extension and by filename; lspLanguageId is shellscript', () => {
  const reg = activate();
  assert.equal(reg.languageForPath('/d/deploy.sh'), 'bash');
  assert.equal(reg.languageForPath('/d/lib.bash'), 'bash');
  assert.equal(reg.languageForPath('/d/script.ksh'), 'bash');
  assert.equal(reg.languageForPath('/home/u/.bashrc'), 'bash');
  assert.equal(reg.languageForPath('/pkg/PKGBUILD'), 'bash');
  assert.equal(reg.languageForPath('/d/x.ts'), null); // not this plugin's concern
  // Grammar key is `bash`, but the LSP document languageId for shell is `shellscript`.
  assert.equal(reg.lspLanguageId('/d/deploy.sh'), 'shellscript');
});

test('bash-language-server activates at a .git project root', () => {
  const reg = activate();
  const servers = reg.activeServers('/proj/scripts/deploy.sh', {
    fileExists: (p) => p === '/proj/.git',
  });
  assert.deepEqual(servers.map((s) => s.server.name), ['bash-language-server']);
  assert.equal(servers[0].rootDir, '/proj');
});

test('bash-language-server still activates on a loose script (singleFile)', () => {
  const reg = activate();
  const servers = reg.activeServers('/loose/run.sh', { fileExists: () => false });
  assert.deepEqual(servers.map((s) => s.server.name), ['bash-language-server']);
});

test('Bash grammar is bundled', () => {
  const reg = activate();
  assert.ok(reg.grammarFor('bash'), 'bash grammar should be registered');
});

test('bash-language-server installs via npm (Install button works)', () => {
  const reg = activate();
  const server = reg.activeServers('/loose/run.sh', { fileExists: () => false })[0].server;
  assert.ok(server.install, 'bash-language-server should expose an install spec');
  assert.deepEqual(
    installInvocation(server.install!),
    { command: 'npm', args: ['install', '--no-save', '--no-fund', '--no-audit', 'bash-language-server'] },
  );
});
