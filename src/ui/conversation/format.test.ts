import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate, truncateLines, summarizeInput, formatCount, formatElapsed, progressLine, parseLocalCommand, wrapEditorInstructions, parseEditorInstructions } from './format.ts';

test('truncate adds an ellipsis past max', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello world', 5), 'hello…');
});

test('truncateLines caps lines and chars', () => {
  assert.equal(truncateLines('a\nb\nc\nd', 2, 100), 'a\nb …');
  assert.equal(truncateLines('', 3, 100), '');
  assert.equal(truncateLines('short', 3, 100), 'short');
});

test('summarizeInput stringifies + caps at 200 chars', () => {
  assert.equal(summarizeInput({ a: 1 }), '{"a":1}');
  assert.equal(summarizeInput('plain'), 'plain');
  assert.equal(summarizeInput(null), '');
  assert.equal(summarizeInput('x'.repeat(300)).length, 201); // 200 + ellipsis
});

test('formatCount compacts thousands', () => {
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1500), '1.5k');
});

test('formatElapsed reads whole seconds, then m ss', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(12_000), '12s');
  assert.equal(formatElapsed(59_900), '59s');
  assert.equal(formatElapsed(60_000), '1m 00s');
  assert.equal(formatElapsed(75_000), '1m 15s');
  assert.equal(formatElapsed(-5), '0s'); // never negative
});

test('progressLine composes head + meta', () => {
  assert.equal(
    progressLine({ id: 't', description: 'Fetching', subagentType: 'x', lastTool: 'WebFetch', tokens: 8652, toolUses: 2, durationMs: 4605, status: 'running', done: false }),
    '⋯ Fetching  ·  WebFetch  ·  8.7k tokens  ·  4.6s',
  );
  assert.equal(
    progressLine({ id: 't', description: 'done', tokens: 0, toolUses: 0, durationMs: 0, status: 'completed', done: true }),
    '✓ done',
  );
});

test('parseLocalCommand recognizes /rename and its argument', () => {
  assert.deepEqual(parseLocalCommand('/rename my session'), { command: 'rename', name: 'my session' });
  assert.deepEqual(parseLocalCommand('  /rename  spaced  '), { command: 'rename', name: 'spaced' });
  assert.deepEqual(parseLocalCommand('/rename'), { command: 'rename', name: '' }); // bare → no arg
  assert.equal(parseLocalCommand('/clear'), null); // a real CLI command, not local
  assert.equal(parseLocalCommand('rename without slash'), null);
  assert.equal(parseLocalCommand('please /rename this'), null); // only at line start
});

test('wrapEditorInstructions round-trips through parseEditorInstructions', () => {
  const wrapped = wrapEditorInstructions('Creating a new worktree', 'Before anything else, create a worktree.');
  const turn = `${wrapped}\n\nFix the failing test`;
  const { instructions, userText } = parseEditorInstructions(turn);
  assert.deepEqual(instructions, { label: 'Creating a new worktree', body: 'Before anything else, create a worktree.' });
  assert.equal(userText, 'Fix the failing test');
});

test('parseEditorInstructions leaves an ordinary turn untouched', () => {
  const { instructions, userText } = parseEditorInstructions('just a normal prompt');
  assert.equal(instructions, null);
  assert.equal(userText, 'just a normal prompt');
});

test('parseEditorInstructions handles instructions with no trailing user text', () => {
  const { instructions, userText } = parseEditorInstructions(wrapEditorInstructions('Creating a new worktree', 'body'));
  assert.deepEqual(instructions, { label: 'Creating a new worktree', body: 'body' });
  assert.equal(userText, '');
});

test('parseEditorInstructions falls back to a default label when the attribute is absent', () => {
  const { instructions } = parseEditorInstructions('<zym-editor-instructions>do a thing</zym-editor-instructions>');
  assert.deepEqual(instructions, { label: 'Editor setup', body: 'do a thing' });
});

test('wrapEditorInstructions sanitizes quotes/newlines in the label', () => {
  const wrapped = wrapEditorInstructions('weird "label"\nsecond line', 'body');
  const { instructions } = parseEditorInstructions(wrapped);
  assert.equal(instructions?.label, 'weird  label second line'); // quotes/newlines → spaces, no attribute break
});
