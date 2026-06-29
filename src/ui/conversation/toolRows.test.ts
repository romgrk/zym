import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bashRowParts, permissionPromptParts, editDiffLines } from './toolRows.ts';

test('Bash with a description shows it on the header, command in the detail', () => {
  const p = bashRowParts({ command: 'git worktree add -b feat/x ../x master', description: 'Create new worktree' });
  assert.equal(p.headerText, 'Create new worktree');
  assert.equal(p.headerIsCommand, false);
  assert.equal(p.detailCommand, 'git worktree add -b feat/x ../x master');
});

test('Bash without a description falls back to the command on the header', () => {
  const p = bashRowParts({ command: 'ls -la' });
  assert.equal(p.headerText, 'ls -la');
  assert.equal(p.headerIsCommand, true);
  assert.equal(p.detailCommand, null);
});

test('a blank/whitespace description is treated as absent', () => {
  const p = bashRowParts({ command: 'pwd', description: '   ' });
  assert.equal(p.headerText, 'pwd');
  assert.equal(p.headerIsCommand, true);
  assert.equal(p.detailCommand, null);
});

test('the description is trimmed for the header', () => {
  const p = bashRowParts({ command: 'pwd', description: '  Show working dir  ' });
  assert.equal(p.headerText, 'Show working dir');
  assert.equal(p.detailCommand, 'pwd');
});

test('a multiline command is carried whole into the detail (header crops elsewhere)', () => {
  const cmd = 'set -e\ncd src\npnpm build';
  const p = bashRowParts({ command: cmd, description: 'Build' });
  assert.equal(p.headerText, 'Build');
  assert.equal(p.detailCommand, cmd);
});

test('a non-string command degrades to a compact summary on the header', () => {
  const p = bashRowParts({ command: { not: 'a string' } });
  assert.equal(p.headerIsCommand, true);
  assert.equal(p.headerText, '{"command":{"not":"a string"}}');
  assert.equal(p.detailCommand, null);
});

test('permission parts: Bash with a description puts it on the title, command in the body', () => {
  const p = permissionPromptParts('Bash', { command: 'git push origin HEAD', description: 'Push the branch' }, '/repo');
  assert.equal(p.title, 'Push the branch');
  assert.equal(p.description, 'git push origin HEAD');
});

test('permission parts: Bash with no description makes the command the title (no body)', () => {
  const p = permissionPromptParts('Bash', { command: 'ls -la' }, '/repo');
  assert.equal(p.title, 'ls -la');
  assert.equal(p.description, null);
});

test('permission parts: an edit tool puts the file path in the title, no description', () => {
  const p = permissionPromptParts('Write', { file_path: '/repo/src/x.ts', content: 'hi' }, '/repo');
  assert.match(p.title, /x\.ts$/); // the (shortened) file path
  assert.equal(p.description, null); // the change shows as a diff body, not a string
});

test('permission parts: a non-Bash, non-edit tool falls back to its describeTool title + detail', () => {
  const p = permissionPromptParts('Grep', { pattern: 'foo', path: 'src' }, '/repo');
  assert.equal(p.title, 'Grep');
  assert.ok(p.description && p.description.length > 0); // a non-empty detail line
});

test('editDiffLines: Edit yields context/removed/added signed lines', () => {
  const lines = editDiffLines('Edit', { old_string: 'a\nb', new_string: 'a\nc' });
  assert.deepEqual(lines, [{ sign: ' ', text: 'a' }, { sign: '-', text: 'b' }, { sign: '+', text: 'c' }]);
});

test('editDiffLines: Write is all additions (a fresh write)', () => {
  const lines = editDiffLines('Write', { content: 'x\ny' });
  assert.deepEqual(lines, [{ sign: '+', text: 'x' }, { sign: '+', text: 'y' }]);
});

test('editDiffLines: MultiEdit diffs each edit, blank-separated', () => {
  const lines = editDiffLines('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] });
  assert.deepEqual(lines, [
    { sign: '-', text: 'a' }, { sign: '+', text: 'b' },
    { sign: ' ', text: '' },
    { sign: '-', text: 'c' }, { sign: '+', text: 'd' },
  ]);
});
