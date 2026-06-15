import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LanguageRegistry } from './LanguageRegistry.ts';
import { registerBuiltins } from './builtin.ts';

function builtins(): LanguageRegistry {
  const reg = new LanguageRegistry();
  registerBuiltins(reg);
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

test('grammar binding is registered per language', () => {
  const reg = builtins();
  assert.equal(reg.grammarFor('typescript')?.query, 'typescript');
  assert.match(reg.grammarFor('tsx')!.wasm, /tree-sitter-tsx\.wasm$/);
  assert.equal(reg.grammarFor('nope'), null);
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
  assert.equal(reg.grammarFor('typescript')?.query, 'typescript');
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

test('singleFile server activates without a root (root = file dir)', () => {
  const reg = new LanguageRegistry();
  reg.registerLanguage({ id: 'x', fileTypes: ['x'] });
  reg.registerServer('x', { name: 's', command: 's', singleFile: true });
  const active = reg.activeServers('/a/b/c.x', { fileExists: () => false });
  assert.equal(active.length, 1);
  assert.equal(active[0].rootDir, '/a/b');
});
