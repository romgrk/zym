/*
 * Tests for user-configured language injections (editor.languageInjections):
 *
 *  - Pure: parsing/normalizing config entries (defaults, validation, drop-the-bad),
 *    and the generated query shape — no tree-sitter, no GTK.
 *  - End-to-end against the REAL grammar registry: setting a comment-marker rule and
 *    a tagged-template rule actually makes `collectCaptures` resolve CSS captures
 *    inside a TS template literal — i.e. config → grammar.ts → injection engine,
 *    including that the generated queries compile (escaping) against the live grammar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInjectionRules, injectionDefsFor, injectionQueryFor, type InjectionRule,
} from './userInjections.ts';
import { registerBuiltinPlugins, plugins } from '../plugin/index.ts';
import { languages } from '../lang/index.ts';
import {
  preloadGrammars, getGrammar, createParser, setUserInjectionRules, refreshGrammarInjections,
} from './grammar.ts';
import { collectCaptures, type RawCapture } from './injection.ts';

// --- pure: parsing -----------------------------------------------------------

test('parseInjectionRules: non-array → empty', () => {
  assert.deepEqual(parseInjectionRules(undefined), []);
  assert.deepEqual(parseInjectionRules('nope'), []);
  assert.deepEqual(parseInjectionRules({}), []);
});

test('parseInjectionRules: comment form defaults language to the keyword; host is required', () => {
  const [rule] = parseInjectionRules([{ comment: 'css', host: 'tsx' }]);
  assert.deepEqual(rule, { hosts: ['tsx'], language: 'css', comment: 'css' });
  // No host → dropped (host is never defaulted).
  assert.deepEqual(parseInjectionRules([{ comment: 'css' }]), []);
});

test('parseInjectionRules: tag form, explicit language + single host (string)', () => {
  const [rule] = parseInjectionRules([{ tag: 'gql', language: 'graphql', host: 'tsx' }]);
  assert.deepEqual(rule, { hosts: ['tsx'], language: 'graphql', tag: 'gql' });
});

test('parseInjectionRules: host accepts a list (e.g. js & ts at once)', () => {
  const [rule] = parseInjectionRules([{ comment: 'css', host: ['typescript', 'tsx'] }]);
  assert.deepEqual(rule.hosts, ['typescript', 'tsx']);
});

test('parseInjectionRules: raw query form requires a host and a language', () => {
  // No host → dropped.
  assert.deepEqual(parseInjectionRules([{ query: '(x) @injection.content', language: 'sql' }]), []);
  // No language (query form can't default one) → dropped.
  assert.deepEqual(parseInjectionRules([{ query: '(x) @injection.content', host: 'python' }]), []);
  const [rule] = parseInjectionRules([{ query: '(string) @injection.content', language: 'sql', host: 'python' }]);
  assert.deepEqual(rule, { hosts: ['python'], language: 'sql', query: '(string) @injection.content' });
});

test('parseInjectionRules: a malformed entry is dropped, valid ones survive', () => {
  // Two matchers, no matcher, no host, wrong type — all invalid; the valid one remains.
  const rules = parseInjectionRules([
    { comment: 'css', tag: 'css', host: 'tsx' }, // two matchers
    { language: 'css', host: 'tsx' },            // no matcher
    { tag: 'css' },                              // no host
    'string',                                    // not an object
    { tag: 'styled', language: 'css', host: 'tsx' },
  ]);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].tag, 'styled');
});

// --- pure: query generation --------------------------------------------------

test('injectionQueryFor: comment form captures content + a marker predicate', () => {
  const q = injectionQueryFor({ hosts: ['tsx'], language: 'css', comment: 'css' });
  assert.match(q, /@injection\.content/);
  assert.match(q, /#match\? @_marker/);
  assert.match(q, /template_string/);
});

test('injectionQueryFor: tag form matches identifier or member-root via #eq?', () => {
  const q = injectionQueryFor({ hosts: ['tsx'], language: 'css', tag: 'styled' });
  assert.match(q, /#eq\? @_tag "styled"/);
  assert.match(q, /member_expression object: \(identifier\) @_tag/);
});

test('injectionDefsFor: only rules targeting the host are emitted, static language set', () => {
  const rules: InjectionRule[] = [
    { hosts: ['tsx'], language: 'css', comment: 'css' },
    { hosts: ['python'], language: 'sql', query: '(string) @injection.content' },
  ];
  const tsx = injectionDefsFor(rules, 'tsx');
  assert.equal(tsx.length, 1);
  assert.equal(tsx[0].language, 'css');
  assert.equal(injectionDefsFor(rules, 'python').length, 1);
  assert.equal(injectionDefsFor(rules, 'ruby').length, 0);
});

// --- end-to-end: real registry + injection engine ---------------------------

let setupDone = false;
async function setup(): Promise<void> {
  if (setupDone) return;
  setupDone = true;
  try { registerBuiltinPlugins(); } catch { /* already registered by another test file */ }
  await plugins.activateAll(); // contributes the typescript/tsx + css grammars
  await preloadGrammars();
}

// Captures named like a CSS selector / declaration that the TS grammar never emits
// *inside a string* — their presence within the template fragment proves the CSS
// guest grammar painted it.
const CSS_ONLY = new Set(['tag', 'property']);

function capturesIn(text: string, hostLangId: string): RawCapture[] {
  const host = getGrammar(hostLangId);
  assert.ok(host, `${hostLangId} grammar should be preloaded`);
  const parser = createParser(host!);
  const tree = parser.parse(text);
  const out: RawCapture[] = [];
  collectCaptures(host!, tree.rootNode, text, out, 0, null, (g) => createParser(g));
  return out;
}

// `body { color: red }` inside a template fragment, painted only if a guest CSS
// grammar reaches it. Returns the CSS-only captures within the fragment.
function cssInTemplate(src: string, hostLangId = 'tsx'): RawCapture[] {
  const start = src.indexOf('body');
  const end = src.indexOf('`', start); // the fragment ends at the closing backtick
  return capturesIn(src, hostLangId).filter((c) => CSS_ONLY.has(c.name) && c.start >= start && c.end <= end);
}

test('e2e: a comment-marker rule resolves CSS captures once the rule is set', async () => {
  await setup();
  // A keyword no plugin ships, so the "before" baseline is genuinely plain.
  const src = 'const styles = /* zinj */ `body { color: red }`\n';

  // Without the rule, nothing inside the template is CSS — it's a plain string.
  setUserInjectionRules([]);
  assert.equal(cssInTemplate(src).length, 0);

  // With the rule, the CSS grammar paints inside the fragment — for both the tsx
  // and typescript grammars (one rule, two hosts).
  setUserInjectionRules(parseInjectionRules([{ comment: 'zinj', language: 'css', host: ['typescript', 'tsx'] }]));
  assert.ok(cssInTemplate(src, 'tsx').length > 0, 'CSS captures should appear (tsx host)');
  assert.ok(cssInTemplate(src, 'typescript').length > 0, 'CSS captures should appear (typescript host)');

  setUserInjectionRules([]); // leave global state clean for other tests
});

test('e2e: a tagged-template rule resolves CSS captures', async () => {
  await setup();
  const src = 'const styles = zinjtag`body { color: red }`\n';

  setUserInjectionRules([]);
  assert.equal(cssInTemplate(src).length, 0);

  setUserInjectionRules(parseInjectionRules([{ tag: 'zinjtag', language: 'css', host: 'tsx' }]));
  assert.ok(cssInTemplate(src).length > 0, 'CSS captures should appear inside the tagged template');

  setUserInjectionRules([]);
});

test('e2e: a plugin-contributed injection (registerInjection) applies and disposes', async () => {
  await setup();
  setUserInjectionRules([]);
  const src = 'const x = zinjstyled.div`body { color: red }`\n';

  // A plugin contributes a rule (a tag no built-in plugin ships) into the JS/TS grammars.
  const sub = languages.registerInjection({ hosts: ['typescript', 'tsx'], tag: 'zinjstyled', language: 'css' });
  refreshGrammarInjections();
  assert.ok(cssInTemplate(src).length > 0, 'a plugin-contributed injection should resolve CSS');

  // Disposing the contribution removes it again.
  sub.dispose();
  refreshGrammarInjections();
  assert.equal(cssInTemplate(src).length, 0, 'disposing the contribution stops the injection');
});

test('e2e: the TypeScript plugin ships styled + css-comment injections by default', async () => {
  await setup();
  setUserInjectionRules([]); // rely on the plugin's defaults, NOT user config
  assert.ok(cssInTemplate('const x = styled.div`body { color: red }`\n').length > 0,
    'styled.div`…` → CSS out of the box');
  assert.ok(cssInTemplate('const x = /* css */ `body { color: red }`\n').length > 0,
    '/* css */ `…` → CSS out of the box');
});

test('e2e: a malformed user query is skipped without breaking host highlighting', async () => {
  await setup();
  // An unparsable tree-sitter query: compiling it against the host grammar throws,
  // which grammar.ts must catch — the host grammar's own captures still work.
  setUserInjectionRules(parseInjectionRules([
    { query: '(this is not a valid query', language: 'css', host: 'tsx' },
  ]));
  const src = 'const x = 1\n';
  const caps = capturesIn(src, 'tsx');
  assert.ok(caps.some((c) => c.name.startsWith('keyword')), 'host TS highlighting survives a bad user query');

  setUserInjectionRules([]);
});
