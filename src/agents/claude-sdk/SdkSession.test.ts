import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SdkSession } from './SdkSession.ts';
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
