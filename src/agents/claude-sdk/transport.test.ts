import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { ClaudeStreamTransport } from './transport.ts';
import { userTurn, isResult, isSystemInit, type StreamEvent } from './protocol.ts';

// A stand-in for `claude -p` stream-json: emits a system/init line (deliberately
// split across two writes to exercise partial-line reassembly), then echoes each
// user turn back as an assistant + result, and exits on a sentinel turn. Plain
// CommonJS so it runs as a bare `node <script>` regardless of the project's ESM.
const FAKE_CLAUDE = `
const readline = require('node:readline');
process.stdout.write('{"type":"system","subtype":"ini');           // split mid-object...
setTimeout(() => {
  process.stdout.write('t","session_id":"S1"}\\n');                // ...completed after a tick
}, 10);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const text = msg && msg.message && msg.message.content;
  if (text === '__exit__') { process.exit(0); }
  process.stdout.write(JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'echo: ' + text }] },
    session_id: 'S1',
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', result: 'echo: ' + text, session_id: 'S1',
  }) + '\\n');
});
`;

function writeFakeClaude(): string {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'quilx-claude-sdk-'));
  const file = Path.join(dir, 'fake-claude.cjs');
  Fs.writeFileSync(file, FAKE_CLAUDE);
  return file;
}

function makeTransport(script: string): ClaudeStreamTransport {
  return new ClaudeStreamTransport({ command: process.execPath, args: [script], cwd: Os.tmpdir() });
}

// Resolve once an event satisfying `match` arrives (with a timeout guard).
function waitForEvent(
  transport: ClaudeStreamTransport,
  match: (e: StreamEvent) => boolean,
  ms = 2000,
): Promise<StreamEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { sub.dispose(); reject(new Error('timeout waiting for event')); }, ms);
    const sub = transport.onEvent((e) => {
      if (!match(e)) return;
      clearTimeout(timer);
      sub.dispose();
      resolve(e);
    });
  });
}

test('reassembles a system/init line split across stdout chunks', async () => {
  const transport = makeTransport(writeFakeClaude());
  transport.start();
  try {
    const init = await waitForEvent(transport, isSystemInit);
    assert.ok(isSystemInit(init));
    assert.equal(init.session_id, 'S1');
  } finally {
    transport.dispose();
  }
});

test('a user turn round-trips to assistant + result over one persistent process', async () => {
  const transport = makeTransport(writeFakeClaude());
  transport.start();
  try {
    await waitForEvent(transport, isSystemInit);

    const gotAssistant = waitForEvent(transport, (e) => e.type === 'assistant');
    const gotResult = waitForEvent(transport, isResult);
    transport.send(userTurn('hello'));

    const assistant = await gotAssistant;
    assert.equal((assistant as any).message.content[0].text, 'echo: hello');
    const result = await gotResult;
    assert.ok(isResult(result) && result.result === 'echo: hello');

    // Second turn on the SAME process (persistent session, no respawn).
    const gotResult2 = waitForEvent(transport, isResult);
    transport.send(userTurn('again'));
    const result2 = await gotResult2;
    assert.ok(isResult(result2) && result2.result === 'echo: again');
  } finally {
    transport.dispose();
  }
});

test('onExit fires with the child exit code', async () => {
  const transport = makeTransport(writeFakeClaude());
  transport.start();
  try {
    const exited = new Promise<number | null>((resolve) => { transport.onExit(resolve); });
    transport.send(userTurn('__exit__'));
    assert.equal(await exited, 0);
  } finally {
    transport.dispose();
  }
});

test('send() is a no-op (not a throw) after the child has exited', async () => {
  const transport = makeTransport(writeFakeClaude());
  transport.start();
  const exited = new Promise<void>((resolve) => { transport.onExit(() => resolve()); });
  transport.send(userTurn('__exit__'));
  await exited;
  assert.doesNotThrow(() => transport.send(userTurn('after-exit')));
  transport.dispose();
});
