/*
 * diffViews.ts — read-only diff views over two git revisions: a single commit
 * (vs its first parent) and this branch vs its base (PR-style, like a GitHub PR).
 *
 * Both reuse DiffView — the same windowed multibuffer as
 * `git:diff-current-changes` — but with no editing / staging / review, since the
 * content is historical (old + new sides are both git blobs, not live documents).
 *
 * Invoked from the `git:diff-commit` / `git:diff-branch` command handlers. They
 * reach the active workbench (cwd / git / center) through `zym.workspace`, so the
 * whole feature lives here rather than in the AppWindow.
 */
import * as Path from 'node:path';
import { zym } from '../zym.ts';
import { Icons } from './icons.ts';
import { DiffView } from './DiffView.ts';
import { type DiffFile } from './multibuffer/diffMultiBuffer.ts';
import {
  repoRoot,
  listCommits,
  mergeBase,
  defaultBaseBranch,
  readFileAtRef,
  commitChangedFiles,
  diffChangedFiles,
  type ChangedFile,
  type CommitSummary,
} from '../git.ts';

/** `git:diff-commit` — open the last commit's changes (HEAD, against its parent) as a diff.
 *  (A commit picker can layer on top later — the diffing core takes any CommitSummary.) */
export async function openCommitDiff(): Promise<void> {
  const wb = zym.workspace.getActiveWorkbench();
  if (!wb) return;
  const root = repoRoot(wb.cwd);
  if (!root) {
    zym.notifications.addInfo('Not in a git repository');
    return;
  }
  const [commit] = await new Promise<CommitSummary[]>((resolve) => listCommits(root, 'HEAD', 1, resolve));
  if (!commit) {
    zym.notifications.addInfo('No commits yet');
    return;
  }
  const files = await new Promise<ChangedFile[]>((resolve) => commitChangedFiles(root, commit.sha, resolve));
  if (files.length === 0) {
    zym.notifications.addInfo('Commit has no file changes');
    return;
  }
  // OLD = the parent blob (`<sha>^`); for the root commit `<sha>^` doesn't resolve
  // and readFileAtRef yields '' — so an initial commit reads as all-added, as wanted.
  const diffFiles = await buildRefDiffFiles(root, files, `${commit.sha}^`, commit.sha);
  const subject = commit.subject.length > 50 ? `${commit.subject.slice(0, 50)}…` : commit.subject;
  presentReadonlyDiff(diffFiles, Icons.gitCommit, `${commit.shortSha}  ${subject}`, wb.cwd);
}

/** `git:diff-branch` — open this branch vs master/main (three-dot, like a GitHub PR). */
export async function openBranchDiff(): Promise<void> {
  const wb = zym.workspace.getActiveWorkbench();
  if (!wb) return;
  const root = repoRoot(wb.cwd);
  if (!root) {
    zym.notifications.addInfo('Not in a git repository');
    return;
  }
  // Pick the base: master if it exists, else main (one git call).
  const base = await new Promise<string | null>((resolve) => defaultBaseBranch(root, resolve));
  if (!base) {
    zym.notifications.addInfo('No master or main branch to diff against');
    return;
  }
  const branch = wb.git.getBranch();
  if (branch === base) {
    zym.notifications.addInfo(`Already on ${base} — nothing to compare`);
    return;
  }
  // Three-dot semantics (what a PR shows): diff the merge base → HEAD, so only this
  // branch's own changes show, not commits that landed on the base since it forked.
  const fork = await new Promise<string | null>((resolve) => mergeBase(root, base, 'HEAD', resolve));
  if (!fork) {
    zym.notifications.addInfo(`No common history with ${base}`);
    return;
  }
  const files = await new Promise<ChangedFile[]>((resolve) => diffChangedFiles(root, fork, 'HEAD', resolve));
  if (files.length === 0) {
    zym.notifications.addInfo(`No changes vs ${base}`);
    return;
  }
  const diffFiles = await buildRefDiffFiles(root, files, fork, 'HEAD');
  presentReadonlyDiff(diffFiles, Icons.gitPullRequest, `${branch ?? 'HEAD'} vs ${base}`, wb.cwd);
}

/** Build the DiffFile[] for a set of changed paths: OLD side from `oldRef`, NEW from `newRef`. */
async function buildRefDiffFiles(
  root: string,
  files: ChangedFile[],
  oldRef: string,
  newRef: string,
): Promise<DiffFile[]> {
  const read = (ref: string, rel: string): Promise<string> =>
    new Promise((resolve) => readFileAtRef(root, ref, rel, (text) => resolve(text ?? '')));
  return Promise.all(
    files.map(async (f) => {
      const oldRel = f.oldRelPath ?? f.relPath; // renames read the OLD content from the old path
      const oldText = f.status === 'A' ? '' : await read(oldRef, oldRel);
      const newText = f.status === 'D' ? '' : await read(newRef, f.relPath);
      // Surface renames in the header (old → new); plain changes keep the default label.
      const label = f.oldRelPath && f.oldRelPath !== f.relPath ? `${f.oldRelPath} → ${f.relPath}` : undefined;
      return { path: Path.join(root, f.relPath), oldText, newText, label };
    }),
  );
}

/** Open a read-only multibuffer diff in a center tab (no editing / staging / review).
 *  Hosted like the built-in continuous diff — selected, focused, disposed on close,
 *  and driven by the same `zo`/`zR`/`zm` fold commands. */
function presentReadonlyDiff(files: DiffFile[], icon: string, titleText: string, cwd: string): void {
  const view = new DiffView({
    files,
    cwd,
    editable: false, // historical content — both sides are git blobs, not live documents
    onActivate: ({ path, row }) => zym.workspace.openFile(path, { cursor: [row, 0] }),
  });
  zym.workspace.openTab(view.root, {
    title: `${icon}  ${titleText}`,
    requireTabBar: true,
    onClose: () => view.dispose(),
  });
  view.focus(); // focus the editor (openTab focuses the tab's root widget, not the inner editor)
}
