import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeTool } from './toolDisplay.ts';

test('Bash shows the command, no label', () => {
  const v = describeTool('Bash', { command: 'ls -la', description: 'list' });
  assert.equal(v.title, ''); // icon-only
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

test('Skill shows the skill name and args', () => {
  const v = describeTool('Skill', { skill: 'code-review', args: 'high' });
  assert.equal(v.title, 'Skill');
  assert.equal(v.detail, 'code-review  high');
});

test('ToolSearch shows the query', () => {
  assert.equal(describeTool('ToolSearch', { query: 'slack send', max_results: 5 }).detail, 'slack send');
});

test('AskUserQuestion shows the first question header', () => {
  const v = describeTool('AskUserQuestion', { questions: [{ header: 'Auth method', question: 'Which auth?' }] });
  assert.equal(v.title, 'AskUserQuestion');
  assert.equal(v.detail, 'Auth method');
});

test('ScheduleWakeup shows the delay and reason', () => {
  assert.equal(describeTool('ScheduleWakeup', { delaySeconds: 270, reason: 'watch CI', prompt: '/loop' }).detail, '270s  watch CI');
});

test('CronCreate shows the cron expression; "(once)" for non-recurring', () => {
  assert.equal(describeTool('CronCreate', { cron: '0 9 * * *', prompt: 'x', recurring: true }).detail, '0 9 * * *');
  assert.equal(describeTool('CronCreate', { cron: '30 14 1 1 *', prompt: 'x', recurring: false }).detail, '30 14 1 1 *  (once)');
});

test('TaskUpdate shows the id and status', () => {
  assert.equal(describeTool('TaskUpdate', { taskId: '3', status: 'completed' }).detail, '#3  → completed');
});

test('EnterWorktree shows the name', () => {
  assert.equal(describeTool('EnterWorktree', { name: 'feat/x' }).detail, 'feat/x');
});

test('a previously-generic tool now has a non-cog icon', () => {
  const monitor = describeTool('Monitor', { description: 'errors in log', command: 'tail -f' });
  assert.equal(monitor.detail, 'errors in log');
  assert.notEqual(monitor.icon, String.fromCodePoint(0xf013)); // not the default cog
});

test('unknown tool falls back to compact JSON', () => {
  const v = describeTool('Mystery', { a: 1, b: 'two' });
  assert.equal(v.title, 'Mystery');
  assert.equal(v.detail, '{"a":1,"b":"two"}');
});
