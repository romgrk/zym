/*
 * Tests for the TypeScript plugin's contributions (detection, grammars, LSP
 * server selection) — activated against a throwaway `LanguageRegistry` through a
 * minimal `PluginContext`. This exercises both the plugin's data and the
 * registry's per-project server-resolution logic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LanguageRegistry } from '../../src/lang/index.ts';
import type { PluginContext, PluginLanguages } from '../../src/plugin/types.ts';
import { typescriptPlugin } from './index.ts';

// A partial `PluginContext` backed by `reg` — the plugin only touches
// `ctx.languages` and `ctx.resolve`. `onRegister` lets a test collect the
// returned disposables (for the deactivation test).
function fakeContext(
  reg: LanguageRegistry,
  onRegister?: (d: { dispose(): void }) => void,
): PluginContext {
  const track = <T extends { dispose(): void }>(d: T): T => (onRegister?.(d), d);
  const languages: PluginLanguages = {
    registerLanguage: (def) => track(reg.registerLanguage(def)),
    registerGrammar: (id, def) => track(reg.registerGrammar(id, def)),
    registerServer: (id, def) => track(reg.registerServer(id, def)),
    registerInjection: (rule) => track(reg.registerInjection(rule)),
  };
  return {
    id: 'typescript',
    dir: '/plugins/typescript',
    resolve: (p: string) => `/plugins/typescript/${p}`,
    languages,
  } as unknown as PluginContext;
}

// Activate the plugin onto a fresh registry.
function builtins(): LanguageRegistry {
  const reg = new LanguageRegistry();
  typescriptPlugin.activate(fakeContext(reg));
  return reg;
}

// A fileExists that treats exactly the given absolute paths as present.
function present(...paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

function names(reg: LanguageRegistry, file: string, fileExists: (p: string) => boolean): string[] {
  return reg.activeServers(file, { fileExists }).map((a) => a.server.name).sort();
}

test('languageForPath matches by extension, else null', () => {
  const reg = builtins();
  assert.equal(reg.languageForPath('/p/a.ts'), 'typescript');
  assert.equal(reg.languageForPath('/p/a.mts'), 'typescript');
  assert.equal(reg.languageForPath('/p/a.tsx'), 'tsx');
  assert.equal(reg.languageForPath('/p/a.js'), 'tsx');
  assert.equal(reg.languageForPath('/p/a.zzz'), null);
});

test('lspLanguageId maps per-extension LSP ids (one grammar spans several)', () => {
  const reg = builtins();
  // typescript grammar id == LSP id for all its extensions.
  assert.equal(reg.lspLanguageId('/p/a.ts'), 'typescript');
  assert.equal(reg.lspLanguageId('/p/a.mts'), 'typescript');
  // tsx grammar id ("tsx") is not a valid LSP id → per-extension mapping.
  assert.equal(reg.lspLanguageId('/p/a.tsx'), 'typescriptreact');
  assert.equal(reg.lspLanguageId('/p/a.jsx'), 'javascriptreact');
  assert.equal(reg.lspLanguageId('/p/a.js'), 'javascript');
  assert.equal(reg.lspLanguageId('/p/a.cjs'), 'javascript');
  assert.equal(reg.lspLanguageId('/p/a.zzz'), null);
});

test('grammar binding is registered per language', () => {
  const reg = builtins();
  assert.match(reg.grammarFor('typescript')!.highlightsPath, /queries\/typescript\/highlights\.scm$/);
  assert.match(reg.grammarFor('tsx')!.wasm, /tree-sitter-tsx\.wasm$/);
  assert.equal(reg.grammarFor('nope'), null);
});

test('contributes CSS-in-JS injections (styled tag + css comment) for the TS/JS grammars', () => {
  const reg = builtins();
  const rules = reg.injectionRules();
  const styled = rules.find((r) => r.tag === 'styled');
  const comment = rules.find((r) => r.comment === 'css');
  assert.ok(styled && styled.language === 'css', 'a styled`…` → css rule is registered');
  assert.ok(comment && comment.language === 'css', 'a /* css */ → css rule is registered');
  // Both target the TS and JS (tsx) grammars.
  for (const rule of [styled!, comment!]) {
    assert.deepEqual([...rule.hosts].sort(), ['tsx', 'typescript']);
  }
});

test('Flow project: flow wins the js-types group over tsserver; eslint is additive', () => {
  const reg = builtins();
  const fe = present('/proj/.flowconfig', '/proj/package.json', '/proj/.eslintrc');
  assert.deepEqual(names(reg, '/proj/src/a.js', fe), ['eslint', 'flow']);
  const flow = reg.activeServers('/proj/src/a.js', { fileExists: fe }).find((a) => a.server.name === 'flow');
  assert.equal(flow?.rootDir, '/proj'); // resolved from the nearest ancestor marker
});

test('Plain TS project: only tsserver activates (flow/deno absent)', () => {
  const reg = builtins();
  assert.deepEqual(names(reg, '/proj/src/a.ts', present('/proj/tsconfig.json')), ['typescript-language-server']);
});

test('Deno project: deno wins js-types (highest priority) even with package.json present', () => {
  const reg = builtins();
  assert.deepEqual(names(reg, '/proj/a.ts', present('/proj/deno.json', '/proj/package.json')), ['deno']);
});

test('no project markers: nothing activates', () => {
  const reg = builtins();
  assert.deepEqual(reg.activeServers('/proj/a.ts', { fileExists: () => false }), []);
});

test('disabledLanguages: no servers activate, but detection still works', () => {
  const reg = builtins();
  reg.setOverrides({ disabledLanguages: ['typescript'] });
  assert.deepEqual(reg.effectiveServers('typescript'), []);
  assert.deepEqual(reg.activeServers('/proj/a.ts', { fileExists: present('/proj/tsconfig.json') }), []);
  // Detection/grammar are untouched — highlighting keeps working when LSP is off.
  assert.equal(reg.languageForPath('/proj/a.ts'), 'typescript');
  assert.match(reg.grammarFor('typescript')!.highlightsPath, /queries\/typescript\/highlights\.scm$/);
});

test('override can disable a single server, leaving the rest', () => {
  const reg = builtins();
  reg.setOverrides({ servers: { typescript: { deno: { disable: true } } } });
  const names = reg.effectiveServers('typescript').map((s) => s.name).sort();
  assert.deepEqual(names, ['eslint', 'typescript-language-server']);
});

test('override priority flips which server wins a group', () => {
  const reg = builtins();
  // Force tsserver over deno in a Deno project by lifting its priority above 30.
  reg.setOverrides({ servers: { typescript: { 'typescript-language-server': { priority: 99 } } } });
  assert.deepEqual(
    names(reg, '/proj/a.ts', present('/proj/deno.json', '/proj/tsconfig.json')),
    ['typescript-language-server'],
  );
});

test('override can change a server command/args', () => {
  const reg = builtins();
  reg.setOverrides({ servers: { typescript: { 'typescript-language-server': { command: '/custom/tsserver', args: ['--foo'] } } } });
  const ts = reg.effectiveServers('typescript').find((s) => s.name === 'typescript-language-server');
  assert.equal(ts?.command, '/custom/tsserver');
  assert.deepEqual(ts?.args, ['--foo']);
});

test('an unknown server name with a command adds a server (ignored without one)', () => {
  const reg = builtins();
  reg.setOverrides({
    servers: {
      typescript: {
        custom: { command: 'my-lsp', args: ['--stdio'], singleFile: true },
        noCommand: { priority: 5 }, // no command → not added
      },
    },
  });
  const effective = reg.effectiveServers('typescript');
  assert.ok(effective.some((s) => s.name === 'custom' && s.command === 'my-lsp'));
  assert.ok(!effective.some((s) => s.name === 'noCommand'));
  // The added singleFile server activates with no project markers.
  assert.ok(names(reg, '/proj/a.ts', () => false).includes('custom'));
});

test('setOverrides with empty config clears prior overrides', () => {
  const reg = builtins();
  reg.setOverrides({ disabledLanguages: ['typescript'] });
  reg.setOverrides({});
  assert.ok(reg.effectiveServers('typescript').length > 0);
});

test('installableServers lists servers with an install method, de-duplicated', () => {
  const reg = builtins();
  const names = reg.installableServers().map((s) => s.name).sort();
  // tsserver / eslint / flow declare npm installs; deno does not.
  assert.ok(names.includes('typescript-language-server'));
  assert.ok(names.includes('eslint'));
  assert.ok(names.includes('flow'));
  assert.ok(!names.includes('deno'));
  // tsserver is registered under both `typescript` and `tsx` — listed once.
  assert.equal(names.filter((n) => n === 'typescript-language-server').length, 1);
});

test('contributions are disposable: deactivating removes detection, grammar, and servers', () => {
  const reg = new LanguageRegistry();
  const disposables: Array<{ dispose(): void }> = [];
  typescriptPlugin.activate(fakeContext(reg, (d) => disposables.push(d)));
  assert.equal(reg.languageForPath('/x/a.ts'), 'typescript');
  assert.ok(reg.grammarFor('typescript'));
  assert.ok(reg.serversFor('typescript').length > 0);

  for (const d of disposables) d.dispose();
  assert.equal(reg.languageForPath('/x/a.ts'), null);
  assert.equal(reg.grammarFor('typescript'), null);
  assert.deepEqual(reg.serversFor('typescript'), []);
});
