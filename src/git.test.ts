import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { openGitRepo, type GitRepo } from './git.ts';

// Integration test: drive a throwaway repo with the real `git` CLI and assert the
// CLI-backed GitRepo's cached reads. State is populated by an async warm-up poll
// (git runs off-thread through the process runner), so `settled()` awaits the
// first poll landing before the synchronous getters are asserted.

const G = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** Resolve once the repo's async warm-up has populated its cached state. */
function settled(repo: GitRepo): Promise<void> {
  return new Promise<void>((resolve) => {
    const ready = () => repo.getBranch() !== null || repo.getStatus() !== null;
    if (ready()) return resolve();
    const un = repo.onChange(() => {
      if (ready()) {
        un();
        resolve();
      }
    });
    setTimeout(() => {
      un();
      resolve();
    }, 5000).unref?.(); // safety net so a stuck poll can't hang the suite
  });
}

/** Trigger a refresh and resolve once `pred` holds (or a safety timeout). Used to
 *  drive the event-driven repo from a test without relying on FS-watch timing. */
function waitFor(repo: GitRepo, pred: () => boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    if (pred()) return resolve();
    const un = repo.onChange(() => {
      if (pred()) {
        un();
        resolve();
      }
    });
    repo.refresh();
    setTimeout(() => {
      un();
      resolve();
    }, 5000).unref?.();
  });
}

let dir: string;
let bare: string;
let repo: GitRepo;

before(async () => {
  dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'zym-git-'));
  bare = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'zym-git-bare-'));
  execFileSync('git', ['init', '--bare'], { cwd: bare });

  G(dir, 'init', '-b', 'main');
  G(dir, 'config', 'user.email', 'test@example.com');
  G(dir, 'config', 'user.name', 'Test');
  G(dir, 'config', 'commit.gpgsign', 'false');

  Fs.writeFileSync(Path.join(dir, 'a.txt'), '1\n2\n3\n');
  Fs.writeFileSync(Path.join(dir, 'keep.txt'), 'x\n');
  G(dir, 'add', '-A');
  G(dir, 'commit', '-m', 'init');

  // Publish to the bare remote, then make a local-only commit → ahead by 1.
  G(dir, 'remote', 'add', 'origin', bare);
  G(dir, 'push', '-u', 'origin', 'main');
  Fs.appendFileSync(Path.join(dir, 'keep.txt'), 'y\n');
  G(dir, 'commit', '-am', 'second');

  // Working tree: modify a tracked file (+1 line) and add an untracked file.
  Fs.writeFileSync(Path.join(dir, 'a.txt'), '1\n2\n3\n4\n');
  Fs.writeFileSync(Path.join(dir, 'untracked.txt'), 'hello\n');

  repo = openGitRepo(dir);
  await settled(repo);
});

after(() => {
  repo?.dispose();
  Fs.rmSync(dir, { recursive: true, force: true });
  Fs.rmSync(bare, { recursive: true, force: true });
});

test('getBranch returns the current branch', () => {
  assert.equal(repo.getBranch(), 'main');
});

test('getStatus counts tracked changes plus untracked files as insertions', () => {
  // a.txt: +1 tracked line; untracked.txt: 1 new line counted as an insertion.
  assert.deepEqual(repo.getStatus(), { added: 2, removed: 0 });
});

test('getAheadBehind reflects the upstream', () => {
  assert.deepEqual(repo.getAheadBehind(), { ahead: 1, behind: 0 });
});

test('hasConflicts is false on a clean merge state', () => {
  assert.equal(repo.hasConflicts(), false);
});

test('getFileStatuses: tracked modified vs untracked', () => {
  const statuses = repo.getFileStatuses();
  const byName = new Map([...statuses].map(([abs, s]) => [Path.basename(abs), s]));
  assert.deepEqual(byName.get('a.txt'), { kind: 'modified', added: 1, removed: 0 });
  assert.deepEqual(byName.get('untracked.txt'), { kind: 'untracked' });
});

test('isRepo is true inside a repository', () => {
  assert.equal(repo.isRepo(), true);
});

test('getTrackedPaths lists tracked files only (absolute)', () => {
  const names = new Set([...repo.getTrackedPaths()].map((p) => Path.basename(p)));
  assert.ok(names.has('a.txt'));
  assert.ok(names.has('keep.txt'));
  assert.ok(!names.has('untracked.txt'));
  for (const p of repo.getTrackedPaths()) assert.ok(Path.isAbsolute(p));
});

test('untracked insertions: text counted (incl. no trailing newline), binary → 0', async () => {
  const d = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'zym-git-u-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: d });
    Fs.writeFileSync(Path.join(d, 'multi.txt'), 'a\nb\nc'); // 3 lines, no trailing \n
    Fs.writeFileSync(Path.join(d, 'bin.dat'), Buffer.from([1, 2, 0, 3, 4])); // NUL → binary
    const r = openGitRepo(d);
    await settled(r);
    // 3 from multi.txt, 0 from the binary file
    assert.deepEqual(r.getStatus(), { added: 3, removed: 0 });
    r.dispose();
  } finally {
    Fs.rmSync(d, { recursive: true, force: true });
  }
});

test('untracked insertions re-count when the file changes (memo keyed on mtime+size)', async () => {
  const d = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'zym-git-memo-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: d });
    Fs.writeFileSync(Path.join(d, 'note.txt'), 'a\nb\n'); // 2 lines, untracked
    const r = openGitRepo(d);
    await settled(r);
    assert.deepEqual(r.getStatus(), { added: 2, removed: 0 });

    // Grow the file: its size moved, so the (mtime, size) memo is invalidated and
    // refresh() must re-read it rather than serve the cached count.
    Fs.writeFileSync(Path.join(d, 'note.txt'), 'a\nb\nc\nd\n'); // 4 lines
    await waitFor(r, () => r.getStatus()?.added === 4);
    assert.deepEqual(r.getStatus(), { added: 4, removed: 0 });

    // Staging it drops it from the untracked set → no longer counted as insertions
    // here (and the memo entry is pruned).
    execFileSync('git', ['add', 'note.txt'], { cwd: d });
    await waitFor(r, () => r.getFileStatuses().size === 1 &&
      [...r.getFileStatuses().values()].every((s) => s.kind !== 'untracked'));
    assert.equal([...r.getFileStatuses().values()].some((s) => s.kind === 'untracked'), false);
    r.dispose();
  } finally {
    Fs.rmSync(d, { recursive: true, force: true });
  }
});

test('a coordinated mutation sets busy synchronously, clears + notifies + applies on completion', async () => {
  const d = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'zym-git-op-'));
  try {
    const g = (...args: string[]) => execFileSync('git', args, { cwd: d, encoding: 'utf8' });
    g('init', '-b', 'main');
    g('config', 'user.email', 't@e.x');
    g('config', 'user.name', 'T');
    g('config', 'commit.gpgsign', 'false');
    Fs.writeFileSync(Path.join(d, 'a.txt'), 'x\n');
    g('add', '-A');
    g('commit', '-m', 'init');

    const r = openGitRepo(d);
    let notifications = 0;
    const unsub = r.onChange(() => notifications++);

    assert.equal(r.isBusy(), false);
    await new Promise<void>((resolve, reject) => {
      r.createBranch('feature').then((result) => {
        try {
          assert.ok(result.isOk(), 'createBranch succeeded');
          assert.equal(r.isBusy(), false, 'busy cleared on completion');
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      });
      assert.equal(r.isBusy(), true, 'busy set synchronously when the op starts');
    });

    assert.ok(notifications >= 1, 'onChange fired (busy transition + refresh)');
    assert.equal(g('branch', '--show-current').trim(), 'feature', 'the branch actually switched');

    unsub();
    r.dispose();
  } finally {
    Fs.rmSync(d, { recursive: true, force: true });
  }
});

test('outside a repo: null/empty, never throws', () => {
  const plain = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'zym-nogit-'));
  try {
    const r = openGitRepo(plain);
    assert.equal(r.isRepo(), false);
    assert.equal(r.getBranch(), null);
    assert.equal(r.getStatus(), null);
    assert.equal(r.getAheadBehind(), null);
    assert.equal(r.hasConflicts(), false);
    assert.equal(r.getFileStatuses().size, 0);
    assert.equal(r.getTrackedPaths().size, 0);
    r.dispose();
  } finally {
    Fs.rmSync(plain, { recursive: true, force: true });
  }
});
