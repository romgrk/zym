/*
 * Editable diff multibuffer — HUNK STAGING (Phase G5, tasks/code-editing/multibuffer.md, task #17).
 * Over a real temp git repo, `DiffMultiBufferView({ editable, cwd })` reads each file's index blob
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
import * as Os from 'node:os';
import * as Path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Gtk } from '../../gi.ts';
import { quilx } from '../../quilx.ts';
import { DocumentRegistry } from '../TextEditor/DocumentRegistry.ts';
import { DiffMultiBufferView } from './DiffMultiBufferView.ts';
import { invalidateRepoRoot } from '../../git.ts';

Gtk.init();
quilx.lsp.configure({ enable: false });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, tries = 150, ms = 20): Promise<boolean> {
  for (let i = 0; i < tries && !cond(); i++) await sleep(ms);
  return cond();
}

let seq = 0;
/** A fresh git repo with one committed file, then `worktree` written over it (the unstaged edit). */
function gitRepo(committed: string, worktree: string): { repo: string; file: string } {
  const repo = Fs.realpathSync(Fs.mkdtempSync(Path.join(Os.tmpdir(), `quilx-stage-${seq++}-`)));
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

const stagedState = (mbv: DiffMultiBufferView): (string | null)[] => (mbv as any).dmb.stagedState;
const rowKinds = (mbv: DiffMultiBufferView): string[] => (mbv as any).dmb.rowKinds;
const indexBlob = (repo: string): string => execFileSync('git', ['show', ':f.ts'], { cwd: repo }).toString('utf8');
const stateOf = (mbv: DiffMultiBufferView, kind: string): (string | null)[] =>
  stagedState(mbv).filter((_s, i) => rowKinds(mbv)[i] === kind);

function open(committed: string, worktree: string) {
  const { repo, file } = gitRepo(committed, worktree);
  const registry = new DocumentRegistry();
  const mbv = new DiffMultiBufferView({
    editable: true,
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
