import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameReader, FrameWriter, makeFrameParser } from './codec.ts';
import { runProcess, runProcessStream } from './runner.ts';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- codec round-trips -------------------------------------------------------

test('FrameWriter/FrameReader round-trip every field type', () => {
  const payload = Buffer.from([0, 1, 2, 250, 255]);
  const w = new FrameWriter();
  w.u32(0xdeadbeef).u8(200).i32(-7).str('héllo · 世界').bytes(payload);
  const frame = w.frame();

  // The frame is length-prefixed; the body length matches.
  assert.equal(frame.readUInt32LE(0), frame.length - 4);

  const r = new FrameReader(frame.subarray(4));
  assert.equal(r.u32(), 0xdeadbeef);
  assert.equal(r.u8(), 200);
  assert.equal(r.i32(), -7);
  assert.equal(r.str(), 'héllo · 世界');
  assert.deepEqual([...r.bytes()], [...payload]);
});

test('makeFrameParser reassembles frames split across chunks and coalesced', () => {
  const frames = ['a', 'bb', 'ccc'].map((s) => new FrameWriter().str(s).frame());
  const whole = Buffer.concat(frames);

  const got: string[] = [];
  const feed = makeFrameParser((body) => got.push(new FrameReader(body).str()));

  // Feed one byte at a time — exercises the "partial frame" path on every offset.
  for (const byte of whole) feed(Buffer.from([byte]));
  assert.deepEqual(got, ['a', 'bb', 'ccc']);

  // And again, all at once — two frames coalesced into a single chunk.
  const got2: string[] = [];
  const feed2 = makeFrameParser((body) => got2.push(new FrameReader(body).str()));
  feed2(whole);
  assert.deepEqual(got2, ['a', 'bb', 'ccc']);
});

// --- runProcess (drives the real broker child) -------------------------------

const run = (file: string, args: string[], input?: string) =>
  new Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }>((resolve) =>
    runProcess({ file, args, input }, (r) =>
      resolve({ ok: r.ok, code: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8') }),
    ),
  );

test('runProcess returns stdout for a successful command', async () => {
  const r = await run('node', ['-e', 'process.stdout.write("hi")']);
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'hi');
});

test('runProcess reports a non-zero exit with stderr', async () => {
  const r = await run('node', ['-e', 'process.stderr.write("boom"); process.exit(3)']);
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
  assert.equal(r.stderr, 'boom');
});

test('runProcess feeds input to stdin', async () => {
  const r = await run('cat', [], 'piped-through');
  assert.equal(r.ok, true);
  assert.equal(r.stdout, 'piped-through');
});

test('runProcess passes binary stdout through unescaped', async () => {
  // 256 bytes 0x00..0xff — would need escaping under JSON; here it's raw.
  const r = await new Promise<Buffer>((resolve) =>
    runProcess(
      { file: 'node', args: ['-e', 'process.stdout.write(Buffer.from(Array.from({length:256},(_,i)=>i)))'] },
      (res) => resolve(res.stdout),
    ),
  );
  assert.equal(r.length, 256);
  assert.deepEqual([...r], Array.from({ length: 256 }, (_, i) => i));
});

test('runProcess runs many concurrent requests over one broker child', async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => run('node', ['-e', `process.stdout.write(String(${i} * 2))`])),
  );
  assert.deepEqual(
    results.map((r) => r.stdout),
    Array.from({ length: 20 }, (_, i) => String(i * 2)),
  );
});

// --- runProcessStream --------------------------------------------------------

test('runProcessStream streams stdout in chunks, then completes', async () => {
  const chunks: string[] = [];
  const res = await new Promise<{ ok: boolean; code: number | null }>((resolve) =>
    runProcessStream(
      { file: 'node', args: ['-e', "process.stdout.write('a'); setTimeout(()=>{process.stdout.write('b');process.exit(0)},20)"] },
      { onStdout: (c) => chunks.push(c.toString('utf8')), onDone: resolve },
    ),
  );
  assert.equal(res.ok, true);
  assert.equal(res.code, 0);
  assert.equal(chunks.join(''), 'ab');
});

test('runProcessStream reports stderr and a non-zero exit', async () => {
  let stderr = '';
  const res = await new Promise<{ ok: boolean; code: number | null }>((resolve) =>
    runProcessStream(
      { file: 'node', args: ['-e', "process.stderr.write('boom'); process.exit(2)"] },
      { onStderr: (c) => (stderr += c.toString('utf8')), onDone: resolve },
    ),
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 2);
  assert.equal(stderr, 'boom');
});

test('runProcessStream cancel kills the command and suppresses onDone', async () => {
  let done = false;
  let firstChunk = '';
  // Emits a chunk, then would exit after 5s; cancel must kill it well before.
  const handle = runProcessStream(
    { file: 'node', args: ['-e', "process.stdout.write('x'); setTimeout(()=>process.exit(0),5000)"] },
    { onStdout: (c) => (firstChunk += c.toString('utf8')), onDone: () => (done = true) },
  );
  await delay(80);
  handle.cancel();
  await delay(120);
  assert.equal(firstChunk, 'x'); // received the streamed chunk before cancelling
  assert.equal(done, false); // cancel dropped the END — no completion callback
});
