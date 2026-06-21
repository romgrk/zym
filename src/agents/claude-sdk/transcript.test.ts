import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { readTranscript } from './transcript.ts';
import { transcriptDir } from '../../agentSessions.ts';

// Write `lines` (objects, one per JSONL line) as the transcript for `sessionId`
// under a throwaway HOME, so readTranscript resolves it the way it does in app.
function withTranscript(lines: unknown[], run: (cwd: string, id: string) => void): void {
  const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'zym-transcript-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cwd = '/work/repo';
    const id = 'sess-1';
    const dir = transcriptDir(cwd);
    Fs.mkdirSync(dir, { recursive: true });
    Fs.writeFileSync(Path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    run(cwd, id);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    Fs.rmSync(home, { recursive: true, force: true });
  }
}

test('maps human turns, assistant blocks, and tool results in order', () => {
  withTranscript([
    { type: 'user', promptSource: 'sdk', message: { role: 'user', content: 'fix the bug' } },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'let me look', signature: 'x' },
        { type: 'text', text: 'Looking into it.' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ] },
    },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'a.txt\nb.txt' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ], (cwd, id) => {
    assert.deepEqual(readTranscript(cwd, id), [
      { kind: 'user', text: 'fix the bug' },
      { kind: 'thinking', text: 'let me look' },
      { kind: 'text', text: 'Looking into it.' },
      { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool_result', id: 't1', isError: false, text: 'a.txt\nb.txt' },
      { kind: 'text', text: 'Done.' },
    ]);
  });
});

test('skips meta, system-injected, and subagent lines (not human turns)', () => {
  withTranscript([
    { type: 'user', promptSource: 'typed', message: { role: 'user', content: 'real turn' } },
    // A system-injected string (e.g. a task notification) — not a human turn.
    { type: 'user', promptSource: 'system', message: { role: 'user', content: '<task-notification>...' } },
    // A meta line (injected context) — skipped.
    { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>' }] } },
    // A subagent's own transcript line — not part of the main thread (v1).
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent thought' }] } },
    // Empty thinking (signature-only, content not persisted) — nothing to show.
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: 'reply' }] } },
  ], (cwd, id) => {
    assert.deepEqual(readTranscript(cwd, id), [
      { kind: 'user', text: 'real turn' },
      { kind: 'text', text: 'reply' },
    ]);
  });
});

test('flattens array-form tool_result content and returns [] for a missing transcript', () => {
  withTranscript([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'Read', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', is_error: true, content: [{ type: 'text', text: 'boom' }] }] } },
  ], (cwd, id) => {
    assert.deepEqual(readTranscript(cwd, id), [
      { kind: 'tool_use', id: 't9', name: 'Read', input: {} },
      { kind: 'tool_result', id: 't9', isError: true, text: 'boom' },
    ]);
    assert.deepEqual(readTranscript(cwd, 'no-such-session'), []);
  });
});
