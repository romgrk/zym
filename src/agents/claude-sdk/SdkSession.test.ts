import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SdkSession, parseQuestions } from './SdkSession.ts';
import { Disposable } from '../../util/eventKit.ts';
import type { Transport, TransportOptions } from './transport.ts';
import type { StreamEvent } from './protocol.ts';

// A fake transport: records sent turns and lets the test drive the event stream
// synchronously, so we exercise SdkSession's event→domain mapping without
// spawning claude (or running the GLib loop).
class FakeTransport implements Transport {
  writable = true;
  readonly sent: unknown[] = [];
  private eventHandler: ((e: StreamEvent) => void) | null = null;
  private exitHandler: ((code: number | null) => void) | null = null;
  start(): void {}
  send(message: unknown): void { this.sent.push(message); }
  onEvent(h: (e: StreamEvent) => void): Disposable { this.eventHandler = h; return new Disposable(() => { this.eventHandler = null; }); }
  onExit(h: (code: number | null) => void): Disposable { this.exitHandler = h; return new Disposable(() => { this.exitHandler = null; }); }
  dispose(): void { this.writable = false; }
  emit(event: StreamEvent): void { this.eventHandler?.(event); }
  emitExit(code: number | null): void { this.exitHandler?.(code); }
}

function makeSession(): { session: SdkSession; fake: FakeTransport } {
  const fake = new FakeTransport();
  const session = new SdkSession({ cwd: '/tmp', createTransport: (_spec: TransportOptions) => fake });
  return { session, fake };
}

test('maps the stream into status + transcript domain events', () => {
  const { session, fake } = makeSession();
  const log: string[] = [];
  session.onStatus(() => log.push(`status:${session.status}`));
  session.onUserMessage(({ text }) => log.push(`user:${text}`));
  session.onAssistantStart(() => log.push('assistant-start'));
  session.onAssistantText(({ delta }) => log.push(`text:${delta}`));
  session.onAssistantThinking(({ delta }) => log.push(`thinking:${delta}`));
  session.onToolUse(({ name }) => log.push(`tool:${name}`));

  session.start();

  // init carries the session id (no domain event, but captured).
  fake.emit({ type: 'system', subtype: 'init', session_id: 'sess-1' } as StreamEvent);
  assert.equal(session.sessionId, 'sess-1');

  // A user turn → user row + working + the turn written to the transport.
  session.prompt('hello');
  assert.deepEqual(fake.sent, [{ type: 'user', message: { role: 'user', content: 'hello' } }]);

  // Text + thinking stream as token-level deltas (stream_event); the tool_use
  // arrives in the complete assistant event.
  fake.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } } as unknown as StreamEvent);
  fake.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi there' } } } as unknown as StreamEvent);
  fake.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } } as StreamEvent);

  // Turn closes → idle.
  fake.emit({ type: 'result', subtype: 'success', result: 'hi there' } as StreamEvent);

  assert.deepEqual(log, [
    'user:hello',
    'status:working',
    'thinking:hmm',
    'assistant-start',
    'text:hi there',
    'tool:Bash',
    'status:idle',
  ]);
});

test('surfaces a non-streamed assistant reply (slash command) from the complete message', () => {
  // Slash-command replies (e.g. /context) arrive only as a complete `assistant`
  // event with NO preceding stream_event deltas — the text must still render.
  const { session, fake } = makeSession();
  const log: string[] = [];
  session.onAssistantStart(() => log.push('assistant-start'));
  session.onAssistantText(({ delta }) => log.push(`text:${delta}`));
  session.start();

  session.prompt('/context');
  // No deltas — just the complete assistant message, then the result.
  fake.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '## Context Usage' }] } } as StreamEvent);
  fake.emit({ type: 'result', subtype: 'success' } as StreamEvent);

  assert.deepEqual(log, ['assistant-start', 'text:## Context Usage']);
  session.dispose();
});

test('does not double-render text that already streamed', () => {
  const { session, fake } = makeSession();
  const log: string[] = [];
  session.onAssistantStart(() => log.push('assistant-start'));
  session.onAssistantText(({ delta }) => log.push(`text:${delta}`));
  session.start();

  session.prompt('hi');
  fake.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'streamed' } } } as unknown as StreamEvent);
  // The complete message echoes the same text — it must NOT be emitted again.
  fake.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'streamed' }] } } as StreamEvent);

  assert.deepEqual(log, ['assistant-start', 'text:streamed']);
  session.dispose();
});

test('replay re-emits a past transcript as the same domain events a live turn would', () => {
  // A resumed session rebuilds its rows by replaying the on-disk transcript through
  // the same emitter the live stream uses — so the widget's row handlers redraw it.
  const { session } = makeSession();
  const log: string[] = [];
  session.onUserMessage(({ text }) => log.push(`user:${text}`));
  session.onAssistantStart(() => log.push('assistant-start'));
  session.onAssistantText(({ delta }) => log.push(`text:${delta}`));
  session.onAssistantThinking(({ delta }) => log.push(`thinking:${delta}`));
  session.onToolUse(({ id, name }) => log.push(`tool:${name}:${id}`));
  session.onToolResult(({ id, isError, text }) => log.push(`result:${id}:${isError}:${text}`));

  session.replay([
    { kind: 'user', text: 'fix it' },
    { kind: 'thinking', text: 'mulling' },
    { kind: 'text', text: 'on it' },
    { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    { kind: 'tool_result', id: 't1', isError: false, text: 'a.txt' },
    { kind: 'text', text: 'done' }, // post-tool text opens its own bubble
  ]);

  assert.deepEqual(log, [
    'user:fix it',
    'thinking:mulling',
    'assistant-start',
    'text:on it',
    'tool:Bash:t1',
    'result:t1:false:a.txt',
    'assistant-start',
    'text:done',
  ]);
  session.dispose();
});

test('interrupt sends a control_request and the resulting error is treated as an intentional stop', () => {
  const { session, fake } = makeSession();
  const events: string[] = [];
  session.onError(({ message }) => events.push(`error:${message}`));
  session.onInterrupted(() => events.push('interrupted'));
  session.onStatus(() => events.push(`status:${session.status}`));
  session.start();

  session.prompt('do something long');
  fake.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'working' } } } as unknown as StreamEvent);

  // Interrupt mid-turn: returns true and writes a control_request.
  const sent = session.interrupt();
  assert.equal(sent, true);
  const ctrl = fake.sent[fake.sent.length - 1] as { type: string; request_id: string; request: { subtype: string } };
  assert.equal(ctrl.type, 'control_request');
  assert.equal(ctrl.request.subtype, 'interrupt');

  // The success ack flips the status to idle immediately, before the result.
  fake.emit({ type: 'control_response', response: { subtype: 'success', request_id: ctrl.request_id } } as unknown as StreamEvent);
  assert.equal(session.status, 'idle', 'status updated on interrupt ack');

  // The interrupt produces an error_during_execution result — surfaced as an
  // intentional stop (onInterrupted), NOT an error row.
  fake.emit({ type: 'result', subtype: 'error_during_execution', is_error: true } as StreamEvent);

  assert.ok(events.includes('interrupted'), 'fired onInterrupted');
  assert.ok(!events.some((e) => e.startsWith('error:')), 'no error surfaced');
  assert.equal(session.status, 'idle');
  session.dispose();
});

test('interrupt is a no-op when nothing is running', () => {
  const { session, fake } = makeSession();
  session.start();
  assert.equal(session.interrupt(), false); // idle → caller can fall back (ctrl-c copies)
  assert.equal(fake.sent.length, 0);
  session.dispose();
});

test('an unrecognised event type is surfaced via onUnhandled (not silently dropped)', () => {
  const { session, fake } = makeSession();
  const seen: unknown[] = [];
  session.onUnhandled(({ event }) => seen.push(event));
  session.start();

  // A known type is handled (no unhandled emission)...
  fake.emit({ type: 'result', subtype: 'success' } as StreamEvent);
  // ...an unmodeled top-level type (e.g. an incoming control_request) is surfaced.
  const mystery = { type: 'control_request', request: { subtype: 'mcp_message' } } as unknown as StreamEvent;
  fake.emit(mystery);

  assert.deepEqual(seen, [mystery]);
  session.dispose();
});

test('parseQuestions normalizes AskUserQuestion input and drops malformed questions', () => {
  const qs = parseQuestions({
    questions: [
      { question: 'Tabs or spaces?', header: 'Indentation', multiSelect: false,
        options: [{ label: 'Tabs', description: 'tab chars' }, { label: 'Spaces' }] },
      { question: 'no options here', options: [] }, // dropped (no options)
      { question: 'multi', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
    ],
  });
  assert.equal(qs.length, 2);
  assert.deepEqual(qs[0], {
    question: 'Tabs or spaces?', header: 'Indentation', multiSelect: false,
    options: [{ label: 'Tabs', description: 'tab chars' }, { label: 'Spaces', description: undefined }],
  });
  assert.equal(qs[1].multiSelect, true);
  assert.equal(qs[1].header, 'multi'); // falls back to the question text
});

test('parseQuestions returns [] for non-AskUserQuestion shapes', () => {
  assert.deepEqual(parseQuestions({ command: 'ls' }), []);
  assert.deepEqual(parseQuestions(null), []);
});

test('thinking_tokens and task_* system events are surfaced (not dropped as unhandled)', () => {
  const { session, fake } = makeSession();
  const log: unknown[][] = [];
  session.onThinkingTokens(({ tokens }) => log.push(['think', tokens]));
  session.onTaskProgress((p) => log.push(['task', p.id, p.lastTool, p.tokens, p.done]));
  session.onUnhandled(() => log.push(['unhandled']));
  session.start();

  fake.emit({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 150 } as unknown as StreamEvent);
  fake.emit({ type: 'system', subtype: 'task_progress', tool_use_id: 't1', description: 'Fetching',
    subagent_type: 'Explore', last_tool_name: 'WebFetch', usage: { total_tokens: 8652, tool_uses: 2, duration_ms: 4605 } } as unknown as StreamEvent);
  fake.emit({ type: 'system', subtype: 'task_notification', tool_use_id: 't1', status: 'completed',
    summary: 'done', usage: { total_tokens: 9287 } } as unknown as StreamEvent);

  assert.deepEqual(log[0], ['think', 150]);
  assert.deepEqual(log[1], ['task', 't1', 'WebFetch', 8652, false]);
  assert.deepEqual(log[2], ['task', 't1', undefined, 9287, true]); // notification → done
  assert.ok(!log.some((e) => e[0] === 'unhandled'), 'no unhandled');
  session.dispose();
});

test('subagent events are captured into a transcript, kept out of the main thread', () => {
  const { session, fake } = makeSession();
  const main: string[] = [];
  session.onToolUse(({ name }) => main.push(`tool:${name}`));
  session.onAssistantText(({ delta }) => main.push(`text:${delta}`));
  let started: string | undefined;
  let done = false;
  session.onSubagentStart(({ id }) => { started = id; });
  session.onSubagentDone(() => { done = true; });
  session.start();

  const P = 'toolu_agent1';
  // The Agent spawn (parent null) IS a main-thread tool row.
  fake.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: P, name: 'Agent', input: { subagent_type: 'general-purpose' } }] } } as StreamEvent);
  fake.emit({ type: 'system', subtype: 'task_started', tool_use_id: P, task_type: 'local_agent', subagent_type: 'general-purpose', description: 'demo' } as unknown as StreamEvent);

  // Subagent activity (parent set) → captured, NOT surfaced in the main thread.
  fake.emit({ type: 'assistant', parent_tool_use_id: P, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_inner', name: 'Bash', input: { command: 'pwd' } }] } } as unknown as StreamEvent);
  fake.emit({ type: 'user', parent_tool_use_id: P, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_inner', content: '/repo', is_error: false }] } } as unknown as StreamEvent);
  fake.emit({ type: 'system', subtype: 'task_notification', tool_use_id: P, status: 'completed' } as unknown as StreamEvent);
  // The Agent result (parent null) is the subagent's final answer — a separate
  // trailing agentId/usage metadata block must be stripped from the captured text.
  fake.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: P, content: [
    { type: 'text', text: 'final answer' },
    { type: 'text', text: "agentId: a49a92eb (use SendMessage with to: 'a49a92eb' to continue this agent)\n<usage>subagent_tokens: 11771\ntool_uses: 0\nduration_ms: 2689</usage>" },
  ] }] } } as unknown as StreamEvent);

  assert.equal(started, P);
  assert.equal(done, true);
  assert.deepEqual(main, ['tool:Agent'], 'only the Agent spawn reached the main thread');

  const info = session.getSubagent(P)!;
  assert.equal(info.status, 'completed');
  assert.equal(info.agentType, 'general-purpose');
  assert.deepEqual(info.messages, [
    { kind: 'tool', toolId: 'toolu_inner', name: 'Bash', input: { command: 'pwd' }, result: { isError: false, text: '/repo' } },
    { kind: 'text', text: 'final answer' },
  ]);
  session.dispose();
});

test('process exit flips to exited and fires onExit', () => {
  const { session, fake } = makeSession();
  let exitCode: number | null | undefined;
  session.onExit((code) => { exitCode = code; });
  session.start();
  fake.emitExit(3);
  assert.equal(session.status, 'exited');
  assert.equal(exitCode, 3);
  session.dispose();
});

test('a new turn re-opens a fresh assistant row', () => {
  const { session, fake } = makeSession();
  const starts: number[] = [];
  session.onAssistantStart(() => starts.push(1));
  session.start();

  session.prompt('one');
  fake.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } } } as unknown as StreamEvent);
  fake.emit({ type: 'result', subtype: 'success' } as StreamEvent);

  session.prompt('two');
  fake.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'b' } } } as unknown as StreamEvent);

  assert.equal(starts.length, 2); // one assistant-start per turn
  session.dispose();
});
