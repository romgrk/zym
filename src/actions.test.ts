import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { parseActions, defaultAction } from './actions.ts';
import { projectSettingsPath } from './projectSettings.ts';
import { WorkbenchActions, type TerminalActionRunner } from './ui/workbench/WorkbenchActions.ts';
import type { Action } from './actions.ts';
import { tmpDir } from './util/testTmp.ts';

/** A deterministic terminal-action runner for tests: tracks which action ids are
 *  "running" and records every stop, so the orphan-stopping logic can be asserted
 *  without spawning real processes. */
class FakeTerminalRunner implements TerminalActionRunner {
  readonly running = new Set<string>();
  readonly stopped: string[] = [];
  private readonly cbs: (() => void)[] = [];
  run(action: Action): void {
    this.running.add(action.id);
    this.cbs.forEach((cb) => cb());
  }
  stop(actionId: string): void {
    if (!this.running.delete(actionId)) return;
    this.stopped.push(actionId);
    this.cbs.forEach((cb) => cb());
  }
  isRunning(actionId: string): boolean {
    return this.running.has(actionId);
  }
  onDidChangeRunning(cb: () => void): () => void {
    this.cbs.push(cb);
    return () => {};
  }
}

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

// --- WorkbenchActions ------------------------------------------------------

/** Seed the project settings file's `actions` section (file I/O is covered in
 *  projectSettings.test.ts; here it just feeds WorkbenchActions). */
function writeProjectActions(cwd: string, actions: unknown[]): void {
  const path = projectSettingsPath(cwd);
  Fs.mkdirSync(Path.dirname(path), { recursive: true });
  Fs.writeFileSync(path, JSON.stringify({ actions }));
}

test('WorkbenchActions seeds from the project file', () => {
  const cwd = tmpDir('wb-seed');
  writeProjectActions(cwd, [{ label: 'Dev', command: 'pnpm dev' }]);
  const wb = new WorkbenchActions(() => cwd);
  try {
    assert.deepEqual(wb.actions.map((a) => a.label), ['Dev']);
  } finally {
    wb.dispose();
  }
});

test('setFromAgent overwrites the set, reset restores the project defaults', () => {
  const cwd = tmpDir('wb-overwrite');
  writeProjectActions(cwd, [{ label: 'Dev', command: 'pnpm dev' }]);
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

test('replacing the set stops a running action it drops, keeps a survivor running', () => {
  const cwd = tmpDir('wb-replace-stop');
  const wb = new WorkbenchActions(() => cwd);
  const runner = new FakeTerminalRunner();
  wb.setTerminalRunner(runner);
  try {
    wb.setFromAgent(parseActions([
      { label: 'Dev', command: 'pnpm dev' },
      { label: 'Test', command: 'pnpm test' },
    ]));
    for (const action of wb.actions) wb.run(action);
    assert.deepEqual([...runner.running].sort(), ['dev', 'test']);

    // Replace with a set that keeps Dev but drops Test: Test must be stopped, Dev kept.
    wb.setFromAgent(parseActions([{ label: 'Dev', command: 'pnpm dev' }]));
    assert.deepEqual(runner.stopped, ['test']);
    assert.equal(wb.isRunning('dev'), true);
    assert.equal(wb.isRunning('test'), false);
  } finally {
    wb.dispose();
  }
});

test('reset stops a running action absent from the project defaults', () => {
  const cwd = tmpDir('wb-reset-stop');
  writeProjectActions(cwd, [{ label: 'Dev', command: 'pnpm dev' }]);
  const wb = new WorkbenchActions(() => cwd);
  const runner = new FakeTerminalRunner();
  wb.setTerminalRunner(runner);
  try {
    wb.setFromAgent(parseActions([{ label: 'Agent', command: 'echo agent' }]));
    for (const action of wb.actions) wb.run(action);
    assert.equal(wb.isRunning('agent'), true);

    wb.reset(); // project defaults have no 'Agent' action → it is stopped
    assert.deepEqual(runner.stopped, ['agent']);
    assert.equal(wb.isRunning('agent'), false);
  } finally {
    wb.dispose();
  }
});

test('restore replaces the set and serialize round-trips it', () => {
  const cwd = tmpDir('wb-restore');
  writeProjectActions(cwd, [{ label: 'Dev', command: 'pnpm dev' }]);
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
