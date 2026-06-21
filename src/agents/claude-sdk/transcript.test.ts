import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { readTranscript, readContextSeed } from './transcript.ts';
import { transcriptDir } from '../../agentSessions.ts';

// Write `lines` (objects, one per JSONL line) as the transcript for `sessionId`
// under a throwaway HOME, so readTranscript resolves it the way it does in app.
function withTranscript(
  lines: unknown[],
  run: (cwd: string, id: string) => void,
  subagents?: Array<{ base: string; meta: object; lines: unknown[] }>,
): void {
  const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'zym-transcript-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cwd = '/work/repo';
    const id = 'sess-1';
    const dir = transcriptDir(cwd);
    Fs.mkdirSync(dir, { recursive: true });
    Fs.writeFileSync(Path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    if (subagents?.length) {
      const subDir = Path.join(dir, id, 'subagents');
      Fs.mkdirSync(subDir, { recursive: true });
      for (const s of subagents) {
        Fs.writeFileSync(Path.join(subDir, `${s.base}.meta.json`), JSON.stringify(s.meta));
        Fs.writeFileSync(Path.join(subDir, `${s.base}.jsonl`), s.lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      }
    }
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

test('reconstructs a subagent transcript and attaches it to its Agent tool call', () => {
  withTranscript(
    [
      { type: 'user', promptSource: 'sdk', message: { role: 'user', content: 'investigate' } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_agent1', name: 'Agent', input: { subagent_type: 'Explore', description: 'find it' } },
      ] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent1', content: 'found' }] } },
    ],
    (cwd, id) => {
      const entries = readTranscript(cwd, id);
      const agent = entries.find((e) => e.kind === 'tool_use' && e.name === 'Agent');
      assert.ok(agent && agent.kind === 'tool_use' && agent.subagent, 'subagent attached to Agent tool call');
      const sub = agent.subagent!;
      assert.equal(sub.id, 'toolu_agent1');
      assert.equal(sub.agentType, 'Explore');
      assert.equal(sub.status, 'completed');
      assert.equal(sub.prompt, 'Look at the foo module.');
      assert.deepEqual(sub.messages, [
        { kind: 'text', text: 'Scanning.' },
        { kind: 'tool', toolId: 'st1', name: 'Grep', input: { pattern: 'foo' }, result: { isError: false, text: 'foo.ts' } },
        { kind: 'text', text: 'It is in foo.ts.' },
      ]);
    },
    [{
      base: 'agent-deadbeef',
      meta: { agentType: 'Explore', description: 'find it', toolUseId: 'toolu_agent1' },
      lines: [
        { type: 'user', isSidechain: true, message: { role: 'user', content: 'Look at the foo module.' } },
        { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [
          { type: 'text', text: 'Scanning.' },
          { type: 'tool_use', id: 'st1', name: 'Grep', input: { pattern: 'foo' } },
        ] } },
        { type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'st1', is_error: false, content: 'foo.ts' }] } },
        { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'It is in foo.ts.' }] } },
      ],
    }],
  );
});

test('seeds model + context occupancy from the latest assistant usage', () => {
  withTranscript([
    { type: 'user', promptSource: 'sdk', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'a' }],
      usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50 } } },
    // The latest assistant usage wins (most recent context occupancy).
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'b' }],
      usage: { input_tokens: 3, cache_read_input_tokens: 1500, cache_creation_input_tokens: 100, output_tokens: 20 } } },
  ], (cwd, id) => {
    assert.deepEqual(readContextSeed(cwd, id), {
      model: 'claude-opus-4-8',
      usage: { tokens: 1603, input: 3, cacheRead: 1500, cacheCreation: 100, output: 20 },
    });
  });
});

test('context seed is null/empty when the transcript has no usage or is missing', () => {
  withTranscript([
    { type: 'user', promptSource: 'sdk', message: { role: 'user', content: 'hi' } },
  ], (cwd, id) => {
    assert.deepEqual(readContextSeed(cwd, id), { model: null, usage: null });
    assert.deepEqual(readContextSeed(cwd, 'no-such-session'), { model: null, usage: null });
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
