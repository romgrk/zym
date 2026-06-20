import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeTool } from './toolDisplay.ts';

test('Bash shows the command', () => {
  const v = describeTool('Bash', { command: 'ls -la', description: 'list' });
  assert.equal(v.title, 'Bash');
  assert.equal(v.detail, 'ls -la');
  assert.ok(v.icon.length > 0);
});

test('Read/Edit relativize the path to cwd', () => {
  const v = describeTool('Edit', { file_path: '/home/me/proj/src/a.ts' }, '/home/me/proj');
  assert.equal(v.title, 'Edit');
  assert.equal(v.detail, 'src/a.ts');
});

test('MultiEdit notes the edit count', () => {
  const v = describeTool('MultiEdit', { file_path: '/p/x.ts', edits: [1, 2, 3] }, '/p');
  assert.equal(v.detail, 'x.ts  (3 edits)');
});

test('Grep shows the pattern and path', () => {
  const v = describeTool('Grep', { pattern: 'foo', path: '/p/src' }, '/p');
  assert.equal(v.detail, 'foo  in src');
});

test('Task labels the subagent and uses the description', () => {
  const v = describeTool('Task', { subagent_type: 'Explore', description: 'find the bug', prompt: '...' });
  assert.equal(v.title, 'Task · Explore');
  assert.equal(v.detail, 'find the bug');
});

test('MCP tool name is prettified', () => {
  const v = describeTool('mcp__quilx__set_worktree', { path: '/x' });
  assert.equal(v.title, 'quilx · set_worktree');
});

test('unknown tool falls back to compact JSON', () => {
  const v = describeTool('Mystery', { a: 1, b: 'two' });
  assert.equal(v.title, 'Mystery');
  assert.equal(v.detail, '{"a":1,"b":"two"}');
});
