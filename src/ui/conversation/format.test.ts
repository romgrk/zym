import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate, truncateLines, summarizeInput, formatCount, progressLine } from './format.ts';

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
