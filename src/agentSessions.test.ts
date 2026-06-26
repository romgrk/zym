import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { tmpDir } from './util/testTmp.ts';
import type { AgentSession } from './agentSessions.ts';

// transcriptDir() resolves under os.homedir(), which honours $HOME on POSIX; point
// it at a throwaway dir so the round-trip never touches the real ~/.claude. Safe
// because `node --test` runs each test file in its own process.
process.env.HOME = tmpDir('agent-sessions-home');
const { transcriptDir, writeCustomTitle, readSessionName, listResumableSessions, resolveResumeCwd } =
  await import('./agentSessions.ts');

// Seed a one-line transcript whose recorded `cwd` is `cwd`, under its project dir.
function seedAt(cwd: string, sid: string): string {
  const dir = transcriptDir(cwd);
  Fs.mkdirSync(dir, { recursive: true });
  const file = Path.join(dir, `${sid}.jsonl`);
  Fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'task' } }) + '\n');
  return file;
}

const CWD = '/home/u/proj';
const SID = '11111111-2222-3333-4444-555555555555';

function seedTranscript(lines: object[]): string {
  const dir = transcriptDir(CWD);
  Fs.mkdirSync(dir, { recursive: true });
  const file = Path.join(dir, `${SID}.jsonl`);
  Fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('writeCustomTitle appends a record readSessionName reads back', () => {
  seedTranscript([{ type: 'user', message: { role: 'user', content: 'hi' } }]);
  assert.equal(readSessionName(CWD, SID), null); // no title yet
  writeCustomTitle(CWD, SID, 'my session');
  assert.equal(readSessionName(CWD, SID), 'my session');
});

test('writeCustomTitle no-ops when the transcript does not exist', () => {
  writeCustomTitle(CWD, 'no-such-session', 'ignored'); // must not throw or create a file
  assert.equal(readSessionName(CWD, 'no-such-session'), null);
});

test('the latest custom title wins; custom title beats ai-title', () => {
  seedTranscript([{ type: 'ai-title', aiTitle: 'auto name' }]);
  assert.equal(readSessionName(CWD, SID), 'auto name'); // falls back to the auto title
  writeCustomTitle(CWD, SID, 'first');
  writeCustomTitle(CWD, SID, 'second');
  assert.equal(readSessionName(CWD, SID), 'second'); // custom title overrides, last wins
});

test('listResumableSessions recovers a removed-worktree transcript via the main-root prefix', () => {
  const main = '/home/u/repo';
  const removed = '/home/u/repo-feature-x'; // a sibling worktree, since deleted
  const decoy = '/home/u/reposter'; // shares the leading chars but is NOT this repo
  const sid = 'aaaaaaaa-0000-0000-0000-000000000001';
  const decoySid = 'bbbbbbbb-0000-0000-0000-000000000002';
  seedAt(removed, sid);
  seedAt(decoy, decoySid);

  // Pass ONLY the main root — the removed worktree is no longer a live root to pass,
  // yet its transcript must still be discovered (the user's lost-conversation case).
  const ids = listResumableSessions([main]).map((s) => s.id);
  assert.ok(ids.includes(sid), 'removed-worktree session recovered by prefix');
  assert.ok(!ids.includes(decoySid), 'a same-prefix-but-different dir is not matched (separator guard)');

  const recovered = listResumableSessions([main]).find((s) => s.id === sid)!;
  assert.equal(recovered.cwd, removed); // its real (now-gone) cwd, from the transcript
});

test('resolveResumeCwd keeps an existing cwd but relocates a gone one to the main root', () => {
  const main = tmpDir('resume-main'); // a real, existing dir

  // Existing cwd → spawn right there, nothing relocated.
  const liveCwd = tmpDir('resume-live');
  const liveSid = 'cccccccc-0000-0000-0000-000000000003';
  const live: AgentSession = { id: liveSid, label: 'x', titled: false, cwd: liveCwd, effectiveCwd: null, transcript: seedAt(liveCwd, liveSid), modified: 0 };
  assert.equal(resolveResumeCwd(live, main), liveCwd);

  // Gone cwd → transcript copied under main's project dir, resume resolves there.
  const goneSid = 'dddddddd-0000-0000-0000-000000000004';
  const goneCwd = '/home/u/repo-gone-worktree'; // never created → does not exist
  const gone: AgentSession = { id: goneSid, label: 'y', titled: false, cwd: goneCwd, effectiveCwd: null, transcript: seedAt(goneCwd, goneSid), modified: 0 };
  assert.equal(resolveResumeCwd(gone, main), main);
  assert.ok(Fs.existsSync(Path.join(transcriptDir(main), `${goneSid}.jsonl`)), 'transcript relocated under main root');
});
