/*
 * Tests for `resolveGuestLangId` — the pure resolver that maps an injection's
 * guest-language name (a fenced-code info string, an extension, or a grammar
 * langId) to a registered grammar's langId. No wasm: it reads only the registry's
 * detection + grammar registrations, so we build a throwaway registry of dummy
 * grammar bindings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LanguageRegistry } from '../lang/index.ts';
import { resolveGuestLangId } from './grammar.ts';

const DUMMY = { wasm: 'x', highlightsPath: 'x', foldTypes: [] };

function registry(): LanguageRegistry {
  const reg = new LanguageRegistry();
  reg.registerLanguage({ id: 'typescript', fileTypes: ['ts', 'mts', 'cts'] });
  reg.registerGrammar('typescript', DUMMY);
  reg.registerLanguage({ id: 'tsx', fileTypes: ['tsx', 'jsx', 'js', 'mjs', 'cjs'] });
  reg.registerGrammar('tsx', DUMMY);
  // An injection-only grammar: registered, but with no file detection.
  reg.registerGrammar('markdown-inline', DUMMY);
  return reg;
}

test('resolves a langId that has a grammar directly', () => {
  const reg = registry();
  assert.equal(resolveGuestLangId('tsx', reg), 'tsx');
  // injection-only grammar (no detection) still resolves by id
  assert.equal(resolveGuestLangId('markdown-inline', reg), 'markdown-inline');
});

test('resolves a file extension via the registry', () => {
  const reg = registry();
  assert.equal(resolveGuestLangId('ts', reg), 'typescript'); // x.ts → typescript
  assert.equal(resolveGuestLangId('js', reg), 'tsx'); // x.js → tsx (the superset grammar)
  assert.equal(resolveGuestLangId('jsx', reg), 'tsx');
});

test('resolves common fenced-code aliases (full names) to a grammar', () => {
  const reg = registry();
  assert.equal(resolveGuestLangId('typescript', reg), 'typescript');
  assert.equal(resolveGuestLangId('javascript', reg), 'tsx');
  assert.equal(resolveGuestLangId('node', reg), 'tsx');
});

test('trims and lowercases the name', () => {
  const reg = registry();
  assert.equal(resolveGuestLangId('  TS  ', reg), 'typescript');
  assert.equal(resolveGuestLangId('TypeScript', reg), 'typescript');
});

test('returns null for an unknown or empty language', () => {
  const reg = registry();
  assert.equal(resolveGuestLangId('python', reg), null); // alias maps to py, but no grammar
  assert.equal(resolveGuestLangId('', reg), null);
  assert.equal(resolveGuestLangId('   ', reg), null);
});
