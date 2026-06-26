import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOneShotEnvelope } from './oneshot.ts';

test('parseOneShotEnvelope extracts the result text and session id', () => {
  const raw = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hello', session_id: 'abc' });
  assert.deepEqual(parseOneShotEnvelope(raw), { ok: true, text: 'hello', sessionId: 'abc' });
});

test('parseOneShotEnvelope flags is_error', () => {
  const raw = JSON.stringify({ type: 'result', is_error: true, result: 'boom' });
  assert.deepEqual(parseOneShotEnvelope(raw), { ok: false, text: 'boom', sessionId: null });
});

test('parseOneShotEnvelope surfaces the session id even on an error envelope', () => {
  // so the caller can still discard the persisted transcript when the run failed
  const raw = JSON.stringify({ type: 'result', is_error: true, session_id: 'xyz' });
  assert.deepEqual(parseOneShotEnvelope(raw), { ok: false, text: '', sessionId: 'xyz' });
});

test('parseOneShotEnvelope rejects junk / missing result', () => {
  assert.deepEqual(parseOneShotEnvelope(''), { ok: false, text: '', sessionId: null });
  assert.deepEqual(parseOneShotEnvelope('not json'), { ok: false, text: '', sessionId: null });
  assert.deepEqual(parseOneShotEnvelope('{"type":"result"}'), { ok: false, text: '', sessionId: null });
});
