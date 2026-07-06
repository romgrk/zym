/*
 * optionsCache: the argv-keyed disk cache of advertised ACP options. Pure fs
 * plumbing — no GTK, no agent. Isolated by pointing XDG_STATE_HOME at a temp dir.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { readAcpOptionsCache, writeAcpOptionsCache, type CachedAgentOptions } from './optionsCache.ts';

let dir: string;
let prevXdg: string | undefined;

before(() => {
  prevXdg = process.env.XDG_STATE_HOME;
  dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'zym-optcache-'));
  process.env.XDG_STATE_HOME = dir;
});
after(() => {
  if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = prevXdg;
  Fs.rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  // Clear the cache file between tests (each starts from "never seen").
  Fs.rmSync(Path.join(dir, 'zym', 'acp-options.json'), { force: true });
});

test('an unseen agent has no cache entry', () => {
  assert.equal(readAcpOptionsCache(['gemini', '--acp']), undefined);
});

test('write then read round-trips the advertised options, keyed by argv', () => {
  const opts: CachedAgentOptions = {
    modes: [{ id: 'default', name: 'Default' }, { id: 'yolo', name: 'YOLO', description: 'all' }],
    currentModeId: 'default',
    configOptions: [
      { id: 'model', name: 'Model', category: 'model', kind: 'select', current: 'opus', choices: [{ value: 'opus', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet' }] },
      { id: 'fast', name: 'Fast mode', category: 'model_config', kind: 'boolean', current: false },
    ],
  };
  writeAcpOptionsCache(['gemini', '--acp'], opts);
  assert.deepEqual(readAcpOptionsCache(['gemini', '--acp']), opts);
  // A different argv is a different key.
  assert.equal(readAcpOptionsCache(['gemini']), undefined);
});

test('a second write replaces the previous entry; other agents are untouched', () => {
  writeAcpOptionsCache(['a'], { currentModeId: 'x' });
  writeAcpOptionsCache(['b'], { currentModeId: 'y' });
  writeAcpOptionsCache(['a'], { currentModeId: 'z' });
  assert.deepEqual(readAcpOptionsCache(['a']), { currentModeId: 'z' });
  assert.deepEqual(readAcpOptionsCache(['b']), { currentModeId: 'y' });
});

test('a corrupt cache file reads as no cache', () => {
  const path = Path.join(dir, 'zym', 'acp-options.json');
  Fs.mkdirSync(Path.dirname(path), { recursive: true });
  Fs.writeFileSync(path, '{ not json');
  assert.equal(readAcpOptionsCache(['gemini', '--acp']), undefined);
});
