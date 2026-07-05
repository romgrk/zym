/*
 * First-touch baseline capture (AcpSession.captureBaseline): the OLD side of
 * the Agent Changes review diff. Captured when an edit-kind tool_call streams
 * in, read through the fs host (buffer-aware) or disk, first touch wins,
 * skipped during history replay. Plain node — the module chain is runtime-pure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { AcpSession, type AcpFsHost } from './AcpSession.ts';

// Feed a session/update notification through the private handler (runtime
// access; the protocol wiring normally calls it from the SDK connection).
function push(session: AcpSession, update: Record<string, unknown>): void {
  (session as unknown as { onSessionUpdate(u: unknown): void }).onSessionUpdate({ sessionId: 's1', update });
}

function editCall(id: string, path: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionUpdate: 'tool_call', toolCallId: id, title: `Edit ${path}`, kind: 'edit', status: 'pending', locations: [{ path }], ...extra };
}

function makeSession(fs?: AcpFsHost): AcpSession {
  return new AcpSession({ command: ['true'], cwd: '/tmp', fs });
}

test('captures through the fs host on first touch; first touch wins', () => {
  let content = 'original';
  const session = makeSession({ readTextFile: () => content, writeTextFile: () => {} });
  push(session, editCall('t1', '/p/a.ts'));
  content = 'already edited'; // a later read must not overwrite the baseline
  push(session, editCall('t2', '/p/a.ts'));
  assert.equal(session.getBaseline('/p/a.ts'), 'original');
  assert.equal(session.getBaseline('/p/other.ts'), undefined); // never touched
});

test('a missing file baselines as null (created)', () => {
  const session = makeSession({
    readTextFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    writeTextFile: () => {},
  });
  push(session, editCall('t1', '/p/new.ts'));
  assert.equal(session.getBaseline('/p/new.ts'), null);
});

test('an async fs host resolves the baseline', async () => {
  const session = makeSession({ readTextFile: async () => 'async content', writeTextFile: () => {} });
  push(session, editCall('t1', '/p/a.ts'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.getBaseline('/p/a.ts'), 'async content');
});

test('falls back to disk without an fs host', () => {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'zym-baseline-'));
  const path = Path.join(dir, 'on-disk.txt');
  Fs.writeFileSync(path, 'disk content');
  try {
    const session = makeSession();
    push(session, editCall('t1', path));
    assert.equal(session.getBaseline(path), 'disk content');
  } finally {
    Fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('paths named only by diff content are captured too', () => {
  const session = makeSession({ readTextFile: () => 'from diff path', writeTextFile: () => {} });
  push(session, editCall('t1', '/p/a.ts', {
    locations: [],
    content: [{ type: 'diff', path: '/p/from-diff.ts', oldText: 'x', newText: 'y' }],
  }));
  assert.equal(session.getBaseline('/p/from-diff.ts'), 'from diff path');
});

test('non-edit kinds do not capture', () => {
  const session = makeSession({ readTextFile: () => 'nope', writeTextFile: () => {} });
  push(session, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read', status: 'pending', locations: [{ path: '/p/read.ts' }] });
  assert.equal(session.getBaseline('/p/read.ts'), undefined);
});

test('history replay does not capture (the file already holds the edits)', () => {
  const session = makeSession({ readTextFile: () => 'post-edit state', writeTextFile: () => {} });
  (session as unknown as { replaying: boolean }).replaying = true;
  push(session, editCall('t1', '/p/a.ts'));
  assert.equal(session.getBaseline('/p/a.ts'), undefined);
});
