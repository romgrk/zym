/*
 * Tests for the Python plugin's contributions — activated against a throwaway
 * `LanguageRegistry` via a partial `PluginContext`, so the global singleton isn't
 * touched. (The real grammar binary is exercised in `grammar.test.ts`.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LanguageRegistry } from '../../src/lang/index.ts';
import { installInvocation } from '../../src/lsp/installer.ts';
import type { PluginContext, PluginLanguages } from '../../src/plugin/types.ts';
import { pythonPlugin } from './index.ts';

function activate(): LanguageRegistry {
  const reg = new LanguageRegistry();
  const languages: PluginLanguages = {
    registerLanguage: (def) => reg.registerLanguage(def),
    registerGrammar: (id, def) => reg.registerGrammar(id, def),
    registerServer: (id, def) => reg.registerServer(id, def),
    registerInjection: (rule) => reg.registerInjection(rule),
  };
  const ctx = {
    id: 'python',
    dir: '/plugins/python',
    resolve: (p: string) => new URL(`./${p}`, import.meta.url).pathname,
    languages,
  } as unknown as PluginContext;
  pythonPlugin.activate(ctx);
  return reg;
}

test('detects Python by extension; lspLanguageId matches', () => {
  const reg = activate();
  assert.equal(reg.languageForPath('/d/main.py'), 'python');
  assert.equal(reg.languageForPath('/d/stubs.pyi'), 'python');
  assert.equal(reg.languageForPath('/d/app.pyw'), 'python');
  assert.equal(reg.languageForPath('/d/x.ts'), null); // not this plugin's concern
  assert.equal(reg.lspLanguageId('/d/main.py'), 'python');
});

test('pyright + ruff activate at a project root; pylsp excluded by group', () => {
  const reg = activate();
  const servers = reg.activeServers('/proj/src/main.py', {
    fileExists: (p) => p === '/proj/pyproject.toml',
  });
  assert.deepEqual(servers.map((s) => s.server.name).sort(), ['pyright', 'ruff']);
  assert.equal(servers.find((s) => s.server.name === 'pyright')!.rootDir, '/proj');
});

test('pyright + ruff still activate on a loose file (singleFile)', () => {
  const reg = activate();
  const servers = reg.activeServers('/loose/script.py', { fileExists: () => false });
  assert.deepEqual(servers.map((s) => s.server.name).sort(), ['pyright', 'ruff']);
});

test('Python grammar is bundled', () => {
  const reg = activate();
  assert.ok(reg.grammarFor('python'), 'python grammar should be registered');
});

test('every Python server is installable (Install button works)', () => {
  const reg = activate();
  const servers = reg.activeServers('/loose/script.py', { fileExists: () => false });
  // pyright (npm) + ruff (venv); pylsp shares ruff's venv recipe but is group-excluded here.
  for (const { server } of servers) {
    assert.ok(server.install, `${server.name} should expose an install spec`);
  }
});

test('pyright installs via npm; ruff/pylsp build a managed venv', () => {
  // npm spec → `npm install … pyright`, landing pyright-langserver in node_modules/.bin.
  assert.deepEqual(
    installInvocation({ via: 'npm', package: 'pyright' }),
    { command: 'npm', args: ['install', '--no-save', '--no-fund', '--no-audit', 'pyright'] },
  );

  // The pip-only servers run a single shell command that creates a venv, installs
  // the package, and symlinks its console script into node_modules/.bin.
  const reg = activate();
  const ruff = reg.activeServers('/loose/script.py', { fileExists: () => false })
    .find((s) => s.server.name === 'ruff')!.server;
  const inv = installInvocation(ruff.install!);
  assert.equal(inv.command, 'sh');
  assert.equal(inv.args[0], '-c');
  assert.match(inv.args[1], /python3 -m venv venv/);
  assert.match(inv.args[1], /pip install --upgrade ruff/);
  assert.match(inv.args[1], /ln -sf \.\.\/\.\.\/venv\/bin\/ruff node_modules\/\.bin\/ruff/);
});
