import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import {
  parseActions,
  defaultAction,
  projectActionsPath,
  readProjectActions,
  ensureProjectActionsFile,
} from './actions.ts';
import { WorkbenchActions } from './ui/workbench/WorkbenchActions.ts';
import { tmpDir } from './util/testTmp.ts';

test('parseActions accepts both an array and a { actions } wrapper', () => {
  const list = [{ label: 'Run', command: 'npm start' }];
  assert.deepEqual(parseActions(list), parseActions({ actions: list }));
});

test('parseActions normalizes label/command and slugifies ids', () => {
  const actions = parseActions([{ label: '  Run Dev Server  ', command: '  npm run dev  ' }]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, 'run-dev-server');
  assert.equal(actions[0].label, 'Run Dev Server');
  assert.equal(actions[0].command, 'npm run dev');
});

test('parseActions defaults terminal to true, honoring an explicit false', () => {
  const actions = parseActions([
    { label: 'a', command: 'a' },
    { label: 'b', command: 'b', terminal: true },
    { label: 'c', command: 'c', terminal: false },
  ]);
  assert.deepEqual(actions.map((x) => x.terminal), [true, true, false]);
});

test('parseActions drops entries missing a label or command', () => {
  const actions = parseActions([
    { label: 'ok', command: 'echo ok' },
    { label: '', command: 'echo nope' },
    { label: 'no-cmd', command: '   ' },
    { command: 'echo missing-label' },
    'not-an-object',
    null,
  ]);
  assert.deepEqual(actions.map((a) => a.label), ['ok']);
});

test('parseActions dedupes colliding ids with a numeric suffix', () => {
  const actions = parseActions([
    { label: 'Run', command: 'a' },
    { label: 'run', command: 'b' },
    { label: 'RUN', command: 'c' },
  ]);
  assert.deepEqual(actions.map((a) => a.id), ['run', 'run-2', 'run-3']);
});

test('parseActions returns an empty list for malformed / empty input', () => {
  assert.deepEqual(parseActions(null), []);
  assert.deepEqual(parseActions('nonsense'), []);
  assert.deepEqual(parseActions({ actions: [] }), []);
});

test('defaultAction is the first action, or null when empty', () => {
  const actions = parseActions([
    { label: 'a', command: 'a' },
    { label: 'b', command: 'b' },
  ]);
  assert.equal(defaultAction(actions)?.label, 'a');
  assert.equal(defaultAction([]), null);
  assert.equal(defaultAction(undefined), null);
});

// --- Project file ----------------------------------------------------------

function writeProjectActions(cwd: string, json: string): void {
  const path = projectActionsPath(cwd);
  Fs.mkdirSync(Path.dirname(path), { recursive: true });
  Fs.writeFileSync(path, json);
}

test('readProjectActions reads + parses <cwd>/.zym/actions.json', () => {
  const cwd = tmpDir('actions-read');
  writeProjectActions(cwd, JSON.stringify([{ label: 'Dev', command: 'pnpm dev' }]));
  const actions = readProjectActions(cwd);
  assert.deepEqual(actions.map((a) => a.label), ['Dev']);
  assert.equal(actions[0].command, 'pnpm dev');
});

test('readProjectActions returns [] when the file is missing or malformed', () => {
  const missing = tmpDir('actions-missing');
  assert.deepEqual(readProjectActions(missing), []);
  const bad = tmpDir('actions-bad');
  writeProjectActions(bad, '{ not json');
  assert.deepEqual(readProjectActions(bad), []);
});

test('ensureProjectActionsFile seeds a new file but leaves an existing one', () => {
  const fresh = tmpDir('actions-seed');
  const path = ensureProjectActionsFile(fresh);
  assert.equal(path, projectActionsPath(fresh));
  assert.ok(Fs.existsSync(path));
  assert.ok(readProjectActions(fresh).length > 0); // the seed parses to at least one action

  const existing = tmpDir('actions-keep');
  writeProjectActions(existing, JSON.stringify([{ label: 'Mine', command: 'echo mine' }]));
  ensureProjectActionsFile(existing);
  assert.deepEqual(readProjectActions(existing).map((a) => a.label), ['Mine']); // untouched
});

// --- WorkbenchActions ------------------------------------------------------

test('WorkbenchActions seeds from the project file', () => {
  const cwd = tmpDir('wb-seed');
  writeProjectActions(cwd, JSON.stringify([{ label: 'Dev', command: 'pnpm dev' }]));
  const wb = new WorkbenchActions(() => cwd);
  try {
    assert.deepEqual(wb.actions.map((a) => a.label), ['Dev']);
  } finally {
    wb.dispose();
  }
});

test('setFromAgent overwrites the set, reset restores the project defaults', () => {
  const cwd = tmpDir('wb-overwrite');
  writeProjectActions(cwd, JSON.stringify([{ label: 'Dev', command: 'pnpm dev' }]));
  const wb = new WorkbenchActions(() => cwd);
  try {
    let changes = 0;
    void wb.onDidChange(() => { changes++; });

    wb.setFromAgent(parseActions([{ label: 'Agent', command: 'echo agent' }]));
    assert.deepEqual(wb.actions.map((a) => a.label), ['Agent']);
    assert.equal(changes, 1);

    wb.reset();
    assert.deepEqual(wb.actions.map((a) => a.label), ['Dev']);
    assert.equal(changes, 2);
  } finally {
    wb.dispose();
  }
});

test('restore replaces the set and serialize round-trips it', () => {
  const cwd = tmpDir('wb-restore');
  writeProjectActions(cwd, JSON.stringify([{ label: 'Dev', command: 'pnpm dev' }]));
  const wb = new WorkbenchActions(() => cwd);
  try {
    const saved = parseActions([{ label: 'Saved', command: 'echo saved' }]);
    wb.restore(saved);
    assert.deepEqual(wb.serialize().map((a) => a.label), ['Saved']);
    // reset always re-reads the project file, so it returns to the defaults.
    wb.reset();
    assert.deepEqual(wb.actions.map((a) => a.label), ['Dev']);
  } finally {
    wb.dispose();
  }
});
