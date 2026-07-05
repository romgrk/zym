/*
 * AcpTerminalRegistry — the client side of ACP terminal/*: real child
 * processes, in-memory output with head-truncation at UTF-8 boundaries,
 * kill/release semantics. Plain node (the module chain is runtime-pure).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpTerminalRegistry, clampOutputHead } from './terminals.ts';

const sh = (script: string) => ({ command: 'sh', args: ['-c', script] });

test('clampOutputHead: under the limit is untouched', () => {
  assert.deepEqual(clampOutputHead('hello', 10), { text: 'hello', truncated: false });
});

test('clampOutputHead: keeps the tail, at a character boundary', () => {
  assert.deepEqual(clampOutputHead('abcdef', 3), { text: 'def', truncated: true });
  // 日本語 is 3×3 bytes; a 4-byte limit lands mid-本 and must advance to 語.
  assert.deepEqual(clampOutputHead('日本語', 4), { text: '語', truncated: true });
});

test('captures stdout and resolves the exit', async () => {
  const registry = new AcpTerminalRegistry();
  const t = registry.create(sh('printf hello'), process.cwd());
  assert.deepEqual(await t.waitForExit(), { exitCode: 0, signal: null });
  assert.deepEqual(t.currentOutput(), { output: 'hello', truncated: false, exitStatus: { exitCode: 0, signal: null } });
  assert.equal(t.status, 'exited');
  registry.dispose();
});

test('captures stderr and nonzero exit codes', async () => {
  const registry = new AcpTerminalRegistry();
  const t = registry.create(sh('echo err >&2; exit 3'), process.cwd());
  assert.equal((await t.waitForExit()).exitCode, 3);
  assert.equal(t.currentOutput().output, 'err\n');
  registry.dispose();
});

test('applies outputByteLimit from the head', async () => {
  const registry = new AcpTerminalRegistry();
  const t = registry.create({ ...sh('printf %0100d 0'), outputByteLimit: 10 }, process.cwd());
  await t.waitForExit();
  const current = t.currentOutput();
  assert.equal(current.output, '0'.repeat(10));
  assert.equal(current.truncated, true);
  registry.dispose();
});

test('passes env and cwd through', async () => {
  const registry = new AcpTerminalRegistry();
  const t = registry.create({ ...sh('printf "$ZYM_TEST_VAR:$PWD"'), env: [{ name: 'ZYM_TEST_VAR', value: 'v1' }], cwd: '/tmp' }, process.cwd());
  await t.waitForExit();
  assert.equal(t.currentOutput().output, 'v1:/tmp');
  registry.dispose();
});

test('kill terminates a running command; output stays retrievable', async () => {
  const registry = new AcpTerminalRegistry();
  const t = registry.create(sh('echo started; sleep 30'), process.cwd());
  // Let the first output land before killing, so the capture is provable.
  await new Promise((resolve) => { const sub = t.onUpdate(() => { sub.dispose(); resolve(null); }); });
  t.kill();
  const exit = await t.waitForExit();
  assert.equal(exit.signal, 'SIGTERM');
  assert.equal(t.status, 'killed');
  assert.equal(t.currentOutput().output, 'started\n');
  registry.dispose();
});

test('a spawn failure settles with the error message as output', async () => {
  const registry = new AcpTerminalRegistry();
  const t = registry.create({ command: 'zym-no-such-binary-xyz' }, process.cwd());
  const exit = await t.waitForExit();
  assert.equal(exit.exitCode, null);
  assert.match(t.currentOutput().output, /ENOENT/);
  registry.dispose();
});

test('release forgets the terminal', async () => {
  const registry = new AcpTerminalRegistry();
  const t = registry.create(sh('printf x'), process.cwd());
  await t.waitForExit();
  registry.release(t.id);
  assert.equal(registry.get(t.id), undefined);
  registry.dispose();
});

test('registry.dispose kills whatever is still running', async () => {
  const registry = new AcpTerminalRegistry();
  const t = registry.create(sh('sleep 30'), process.cwd());
  registry.dispose();
  const exit = await t.waitForExit();
  assert.equal(exit.signal, 'SIGTERM');
});
