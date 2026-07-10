/*
 * Editable diff multibuffer — HUNK STAGING (Phase G5, docs/text-editor/multibuffer.md, task #17).
 * Over a real temp git repo, `DiffView({ editable, live, cwd })` reads each file's index blob
 * and classifies every changed row as staged / unstaged (the gutter marker). `stageHunkAtCursor`
 * builds the index→worktree hunk patch and `git apply --cached`s it; `unstageHunkAtCursor` reverses
 * the HEAD→index hunk out of the index. After each op the index is re-read and the markers flip.
 *
 * Driven with real `git` (the staging primitives shell out) + `await` polling: the index reads run
 * through the process runner (Node child_process / libuv), so a yielding `await` lets their
 * callbacks land — a GLib-only pump would not service them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir as makeTmpDir } from '../util/testTmp.ts';
import Gtk from 'gi:Gtk-4.0';
import { zym } from '../zym.ts';
import { DocumentRegistry } from './TextEditor/DocumentRegistry.ts';
import { DiffView } from './DiffView.ts';
import { invalidateRepoRoot, type GitRepo } from '../git.ts';

Gtk.init();
zym.lsp.configure({ enable: false });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, tries = 150, ms = 20): Promise<boolean> {
  for (let i = 0; i < tries && !cond(); i++) await sleep(ms);
  return cond();
}

/** A fresh git repo with one committed file, then `worktree` written over it (the unstaged edit). */
function gitRepo(committed: string, worktree: string): { repo: string; file: string } {
  const repo = makeTmpDir('stage');
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  run('init', '-q');
  run('config', 'user.email', 't@t');
  run('config', 'user.name', 'tester');
  run('config', 'commit.gpgsign', 'false');
  const file = Path.join(repo, 'f.ts');
  Fs.writeFileSync(file, committed);
  run('add', 'f.ts');
  run('commit', '-q', '-m', 'init');
  Fs.writeFileSync(file, worktree);
  invalidateRepoRoot(); // a previous test may have cached this path as non-repo
  return { repo, file };
}

const stagedState = (mbv: DiffView): (string | null)[] => (mbv as any).dmb.stagedState;
const rowKinds = (mbv: DiffView): string[] => (mbv as any).dmb.rowKinds;
const indexBlob = (repo: string): string => execFileSync('git', ['show', ':f.ts'], { cwd: repo }).toString('utf8');
const stateOf = (mbv: DiffView, kind: string): (string | null)[] =>
  stagedState(mbv).filter((_s, i) => rowKinds(mbv)[i] === kind);

function open(committed: string, worktree: string) {
  const { repo, file } = gitRepo(committed, worktree);
  const registry = new DocumentRegistry();
  const mbv = new DiffView({
    editable: true,
    live: true, // staging (index reads + markers) is gated on a live diff
    documents: registry,
    cwd: repo,
    files: [{ path: file, oldText: committed, newText: worktree }],
  });
  const caretOnKind = (kind: string) => {
    const row = rowKinds(mbv).indexOf(kind);
    mbv.editor.model.setCursorBufferPosition({ row, column: 0 });
  };
  return { repo, file, registry, mbv, caretOnKind };
}

/** A live DiffView wired to a controllable HEAD (the staging path only reads getHead/onChange/
 *  refresh). `head` lets a test advance HEAD and then drive `onGitChange` like the real onChange. */
function openWithHead(committed: string, worktree: string) {
  const { repo, file } = gitRepo(committed, worktree);
  const registry = new DocumentRegistry();
  let head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
  const advanceHead = () => (head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim());
  const git = { getHead: () => head, onChange: () => () => {}, refresh: () => {} } as unknown as GitRepo;
  const mbv = new DiffView({
    editable: true,
    live: true,
    documents: registry,
    cwd: repo,
    git,
    files: [{ path: file, oldText: committed, newText: worktree }],
  });
  return { repo, file, mbv, advanceHead, gitChange: () => (mbv as any).onGitChange() };
}

test('commit: a HEAD move re-bases the diff so a fully-committed view empties', async () => {
  const { repo, mbv, advanceHead, gitChange } = openWithHead('a\nb\nc\n', 'a\nCHANGED\nc\n');
  assert.ok(await waitFor(() => rowKinds(mbv).includes('added')), 'the change shows before the commit');

  // Commit the whole worktree, advance HEAD, then signal the repo change like onChange would.
  execFileSync('git', ['add', 'f.ts'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'change'], { cwd: repo });
  advanceHead();
  gitChange();

  // The re-fetched HEAD blob now equals the worktree, so the file drops out of the diff entirely.
  assert.ok(
    await waitFor(() => !rowKinds(mbv).includes('added') && !rowKinds(mbv).includes('removed')),
    'after committing every change the live diff is empty',
  );
  assert.deepEqual(rowKinds(mbv), [], 'no rows remain');
  mbv.dispose();
});

test('commit: a partial commit re-bases to only the remaining changes', async () => {
  // HEAD a,c,e; worktree adds X (after a) and Y (after c) — two separate hunks.
  const { repo, mbv, advanceHead, gitChange } = openWithHead('a\nc\ne\n', 'a\nX\nc\nY\ne\n');
  await waitFor(() => stagedState(mbv).some((s) => s !== null));
  assert.deepEqual(stateOf(mbv, 'added'), ['unstaged', 'unstaged'], 'both hunks show before the commit');

  // Stage + commit only the first hunk (X); Y stays in the worktree.
  mbv.editor.model.setCursorBufferPosition({ row: rowKinds(mbv).indexOf('added'), column: 0 });
  mbv.stageHunkAtCursor();
  assert.ok(await waitFor(() => indexBlob(repo) === 'a\nX\nc\ne\n'), 'X is staged');
  execFileSync('git', ['commit', '-q', '-m', 'commit X'], { cwd: repo });
  advanceHead();
  gitChange();

  // X is now in HEAD, so only Y remains — and reads unstaged against the new HEAD/index.
  assert.ok(await waitFor(() => stateOf(mbv, 'added').length === 1), 'only one hunk remains after the commit');
  assert.deepEqual(stateOf(mbv, 'added'), ['unstaged'], 'the remaining hunk (Y) is unstaged vs the new HEAD');
  mbv.dispose();
});

test('staging: changed rows read unstaged until the index catches up', async () => {
  const { repo, mbv } = open('a\nb\nc\n', 'a\nCHANGED\nc\n');
  // The index loads asynchronously; before it does there's nothing to classify against.
  assert.ok(await waitFor(() => stagedState(mbv).some((s) => s !== null)), 'index loaded → classification ran');
  // Index == HEAD (nothing staged), so the added + removed rows are unstaged.
  assert.deepEqual(stateOf(mbv, 'added'), ['unstaged']);
  assert.deepEqual(stateOf(mbv, 'removed'), ['unstaged']);
  assert.equal(indexBlob(repo), 'a\nb\nc\n', 'sanity: nothing staged yet');
  mbv.dispose();
});

test('staging: stageHunkAtCursor stages the hunk; markers flip to staged', async () => {
  const { repo, mbv, caretOnKind } = open('a\nb\nc\n', 'a\nCHANGED\nc\n');
  await waitFor(() => stagedState(mbv).some((s) => s !== null));

  caretOnKind('added'); // caret on the CHANGED row
  mbv.stageHunkAtCursor();
  // git apply --cached + the index re-read are async; wait for the index to carry the edit.
  assert.ok(await waitFor(() => indexBlob(repo) === 'a\nCHANGED\nc\n'), 'the hunk was staged into the index');
  // And the markers re-read the index and flipped.
  assert.ok(await waitFor(() => stateOf(mbv, 'added')[0] === 'staged'), 'added row now reads staged');
  assert.deepEqual(stateOf(mbv, 'added'), ['staged']);
  assert.deepEqual(stateOf(mbv, 'removed'), ['staged']);
  mbv.dispose();
});

test('staging: unstageHunkAtCursor reverts the hunk out of the index; markers flip back', async () => {
  const { repo, file, mbv, caretOnKind } = open('a\nb\nc\n', 'a\nCHANGED\nc\n');
  await waitFor(() => stagedState(mbv).some((s) => s !== null));
  // Pre-stage the whole file so there's a staged hunk to unstage.
  execFileSync('git', ['add', 'f.ts'], { cwd: Path.dirname(file) });
  // Re-read the index into the view (constructor only fetched the pre-stage blob).
  (mbv as any).fetchIndexText([file], () => (mbv as any).refreshMarkers());
  assert.ok(await waitFor(() => stateOf(mbv, 'added')[0] === 'staged'), 'starts staged');

  caretOnKind('added');
  mbv.unstageHunkAtCursor();
  assert.ok(await waitFor(() => indexBlob(repo) === 'a\nb\nc\n'), 'the hunk was reverted out of the index');
  assert.ok(await waitFor(() => stateOf(mbv, 'added')[0] === 'unstaged'), 'added row reads unstaged again');
  mbv.dispose();
});

test('revert: revertHunkAtCursor discards the unstaged hunk; the file returns to the index version', async () => {
  const { file, mbv, caretOnKind } = open('a\nb\nc\n', 'a\nCHANGED\nc\n');
  await waitFor(() => stagedState(mbv).some((s) => s !== null));

  caretOnKind('added'); // caret on the CHANGED row
  mbv.revertHunkAtCursor();
  // The new-side Document is edited + saved, so the worktree returns to the index (== HEAD here).
  assert.ok(
    await waitFor(() => Fs.readFileSync(file, 'utf8') === 'a\nb\nc\n'),
    'the working tree was reverted to the index version',
  );
  // The model edit re-diffs the view, so the reverted hunk's changed rows are gone.
  assert.ok(
    await waitFor(() => !rowKinds(mbv).includes('added') && !rowKinds(mbv).includes('removed')),
    'the reverted hunk no longer shows as a change',
  );
  mbv.dispose();
});

test('revert: reverting one of two hunks leaves the other (partial file)', async () => {
  // HEAD: a,c,e. Worktree adds X (after a) and Y (after c) — two SEPARATE added hunks. Reverting the
  // hunk under the caret (X) must leave Y in the file.
  const { file, mbv } = open('a\nc\ne\n', 'a\nX\nc\nY\ne\n');
  await waitFor(() => stagedState(mbv).some((s) => s !== null));

  // Caret on the FIRST added row (X) and revert just its hunk.
  mbv.editor.model.setCursorBufferPosition({ row: rowKinds(mbv).indexOf('added'), column: 0 });
  mbv.revertHunkAtCursor();
  assert.ok(
    await waitFor(() => Fs.readFileSync(file, 'utf8') === 'a\nc\nY\ne\n'),
    'only X was reverted; Y is kept',
  );
  mbv.dispose();
});

test('staging: staging one of two hunks leaves the other unstaged (partial file)', async () => {
  // HEAD: a,c,e. Worktree adds X (after a) and Y (after c) — two SEPARATE added hunks. Staging the
  // hunk under the caret (X) must leave Y unstaged, so the surface shows both states at once.
  const { repo, mbv } = open('a\nc\ne\n', 'a\nX\nc\nY\ne\n');
  await waitFor(() => stagedState(mbv).some((s) => s !== null));
  assert.deepEqual(stateOf(mbv, 'added'), ['unstaged', 'unstaged'], 'both added rows start unstaged');

  // Caret on the FIRST added row (X) and stage just its hunk.
  mbv.editor.model.setCursorBufferPosition({ row: rowKinds(mbv).indexOf('added'), column: 0 });
  mbv.stageHunkAtCursor();
  assert.ok(await waitFor(() => indexBlob(repo) === 'a\nX\nc\ne\n'), 'only X is staged into the index');

  assert.ok(await waitFor(() => stateOf(mbv, 'added').includes('staged')), 'a row flipped to staged');
  assert.deepEqual(stateOf(mbv, 'added'), ['staged', 'unstaged'], 'X staged, Y still unstaged');
  mbv.dispose();
});

test('setFiles: re-syncing folds a newly-changed file into an already-open live diff', async () => {
  // Two committed files; only a.ts is changed when the diff opens (its file set is a snapshot).
  const repo = makeTmpDir('setfiles');
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  run('init', '-q');
  run('config', 'user.email', 't@t');
  run('config', 'user.name', 'tester');
  run('config', 'commit.gpgsign', 'false');
  const fileA = Path.join(repo, 'a.ts');
  const fileB = Path.join(repo, 'b.ts');
  Fs.writeFileSync(fileA, 'a\nb\nc\n');
  Fs.writeFileSync(fileB, 'x\ny\nz\n');
  run('add', '.');
  run('commit', '-q', '-m', 'init');
  Fs.writeFileSync(fileA, 'a\nCHANGED\nc\n');
  invalidateRepoRoot();

  const registry = new DocumentRegistry();
  const mbv = new DiffView({
    editable: true,
    live: true,
    documents: registry,
    cwd: repo,
    files: [{ path: fileA, oldText: 'a\nb\nc\n', newText: 'a\nCHANGED\nc\n' }],
  });
  assert.deepEqual(mbv.fileList().map((f) => f.path), [fileA], 'opens with only the file changed at build time');

  // b.ts changes AFTER open; re-syncing the set (what openLiveDiff does on reopen) must fold it in.
  Fs.writeFileSync(fileB, 'x\nDIFFERENT\nz\n');
  mbv.setFiles([
    { path: fileA, oldText: 'a\nb\nc\n', newText: 'a\nCHANGED\nc\n', deleted: false },
    { path: fileB, oldText: 'x\ny\nz\n', newText: 'x\nDIFFERENT\nz\n', deleted: false },
  ]);
  assert.deepEqual(
    mbv.fileList().map((f) => f.path).sort(),
    [fileA, fileB].sort(),
    'the newly-changed file is now shown alongside the original',
  );

  // A no-op re-sync (nothing new) leaves the set untouched.
  mbv.setFiles([{ path: fileA, oldText: 'a\nb\nc\n', newText: 'a\nCHANGED\nc\n', deleted: false }]);
  assert.equal(mbv.fileList().length, 2, 're-syncing with no new files keeps the existing set');
  mbv.dispose();
});

test('live: a file changed after open is folded in on the next git change', async () => {
  const repo = makeTmpDir('livefold');
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  run('init', '-q');
  run('config', 'user.email', 't@t');
  run('config', 'user.name', 'tester');
  run('config', 'commit.gpgsign', 'false');
  const fileA = Path.join(repo, 'a.ts');
  const fileB = Path.join(repo, 'b.ts');
  Fs.writeFileSync(fileA, 'a\nb\nc\n');
  Fs.writeFileSync(fileB, 'x\ny\nz\n');
  run('add', '.');
  run('commit', '-q', '-m', 'init');
  Fs.writeFileSync(fileA, 'a\nCHANGED\nc\n');
  invalidateRepoRoot();

  // The working-tree change set the (faked) repo model reports — only a.ts at first.
  const changed = new Set<string>([fileA]);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
  const showHead = (abs: string) =>
    execFileSync('git', ['show', `HEAD:${Path.relative(repo, abs)}`], { cwd: repo }).toString('utf8');
  const buildFiles = async () =>
    [...changed].sort().map((abs) => ({ path: abs, oldText: showHead(abs), newText: Fs.readFileSync(abs, 'utf8'), deleted: false }));
  const git = {
    getHead: () => head,
    onChange: () => () => {},
    refresh: () => {},
    getFileStatuses: () => new Map([...changed].map((p) => [p, { kind: 'modified', added: 0, removed: 0 }])),
  } as unknown as GitRepo;

  const registry = new DocumentRegistry();
  const mbv = new DiffView({ editable: true, live: true, documents: registry, cwd: repo, git, refreshFiles: buildFiles, files: await buildFiles() });
  assert.deepEqual(mbv.fileList().map((f) => f.path), [fileA], 'opens tracking only the file changed at build time');

  // b.ts changes on disk; the repo model now reports it and a git change fires (as onChange would).
  Fs.writeFileSync(fileB, 'x\nDIFFERENT\nz\n');
  changed.add(fileB);
  (mbv as any).onGitChange();

  assert.ok(await waitFor(() => mbv.fileList().some((f) => f.path === fileB)), 'the newly-changed file is folded into the live diff');
  assert.deepEqual(mbv.fileList().map((f) => f.path).sort(), [fileA, fileB].sort(), 'both files now tracked');

  // A git change that did NOT grow the set folds nothing new in (the common content-only case).
  (mbv as any).onGitChange();
  assert.equal(mbv.fileList().length, 2, 'no phantom duplicate files on a non-growing change');
  mbv.dispose();
});
