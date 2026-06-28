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
import Gtk from 'gi:Gtk-4.0';
import { zym } from '../zym.ts';
import { Icons } from './icons.ts';
import { DiffView } from './DiffView.ts';
import { openPicker, highlightMarkup, escapeMarkup } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
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

type Overlay = InstanceType<typeof Gtk.Overlay>;

// How many recent commits the picker lists to choose from (newest first).
const PICKER_COMMIT_LIMIT = 200;

/** `git:diff-commit` — open a commit's changes (against its parent) as a read-only diff.
 *  `rev` is any revision git understands (a sha, `HEAD~2`, a tag, …); defaults to `HEAD`.
 *  Dispatch the command without an argument to pick a commit instead — see `openCommitPicker`. */
export async function openCommitDiff(rev = 'HEAD'): Promise<void> {
  const wb = zym.workspace.getActiveWorkbench();
  if (!wb) return;
  const root = repoRoot(wb.cwd);
  if (!root) {
    zym.notifications.addInfo('Not in a git repository');
    return;
  }
  // Resolve the revision to a concrete commit (`git log --max-count=1 <rev>`), so a
  // ref/short-sha/`HEAD~n` gives us the full sha + subject the rest of the flow needs.
  const [commit] = await new Promise<CommitSummary[]>((resolve) => listCommits(root, rev, 1, resolve));
  if (!commit) {
    zym.notifications.addInfo(`No commit found for '${rev}'`);
    return;
  }
  const built = await buildCommitDiffView(root, commit, wb.cwd);
  if (!built) {
    zym.notifications.addInfo('Commit has no file changes');
    return;
  }
  // Consult the diff on window close so unsent review comments aren't silently lost.
  const participant = zym.session.registerParticipant(built.view);
  zym.workspace.openTab(built.view.root, {
    title: built.title,
    requireTabBar: true,
    onClose: () => (participant.dispose(), built.view.dispose()),
  });
  built.view.focus(); // focus the editor (openTab focuses the tab's root widget, not the inner editor)
}

/** A built, not-yet-hosted read-only diff of a single commit (vs its first parent),
 *  with the tab title it should carry. The git log viewer hosts this in a side split;
 *  `openCommitDiff` hosts it as a center tab. */
export interface BuiltCommitDiff {
  view: DiffView;
  title: string;
}

/** Build a read-only DiffView for `commit` (its changes vs its first parent), or null
 *  when it touched no files. The shared core behind `openCommitDiff` and the git log
 *  viewer — the caller decides where to host the returned view. */
export async function buildCommitDiffView(
  root: string,
  commit: CommitSummary,
  cwd: string,
): Promise<BuiltCommitDiff | null> {
  const files = await new Promise<ChangedFile[]>((resolve) => commitChangedFiles(root, commit.sha, resolve));
  if (files.length === 0) return null;
  // OLD = the parent blob (`<sha>^`); for the root commit `<sha>^` doesn't resolve
  // and readFileAtRef yields '' — so an initial commit reads as all-added, as wanted.
  const diffFiles = await buildRefDiffFiles(root, files, `${commit.sha}^`, commit.sha);
  const view = new DiffView({
    files: diffFiles,
    cwd,
    editable: false, // historical content — both sides are git blobs, not live documents
    onActivate: ({ path, row }) => zym.workspace.openFile(path, { cursor: [row, 0] }),
    // Review a historical diff: the view formats each comment; the workspace routes it to an agent
    // (the current one, or one chosen/started from the picker). Enabled on read-only diffs too.
    onSend: (message) => zym.workspace.sendReviewToAgent(message),
    // Tell the agent which commit these lines belong to (they may differ from the working tree).
    reviewContext: `Review of commit \`${commit.shortSha}\` (${commit.subject})`,
  });
  const subject = commit.subject.length > 50 ? `${commit.subject.slice(0, 50)}…` : commit.subject;
  return { view, title: `${Icons.gitCommit}  ${commit.shortSha}  ${subject}` };
}

/** `git:diff-commit` with no argument — pick a recent commit, then diff it (via `openCommitDiff`).
 *  Lists the newest `PICKER_COMMIT_LIMIT` commits; matches against "<shortSha> <subject>". */
export function openCommitPicker(host: Overlay): void {
  const wb = zym.workspace.getActiveWorkbench();
  if (!wb) return;
  const root = repoRoot(wb.cwd);
  if (!root) {
    openPicker({ host, placeholder: 'Commit to diff…', promptIcon: Icons.gitCommit, onSelect: () => {}, error: 'Not a git repository' });
    return;
  }
  // Open immediately in a loading state; fill in once `git log` returns (it's async).
  const picker = openPicker({
    host,
    placeholder: 'Commit to diff…',
    promptIcon: Icons.gitCommit,
    loading: true,
    // value = full sha (what `openCommitDiff` resolves); text = "<shortSha> <subject>"
    // so typing either the hash or words in the message narrows the list.
    renderRow: (item, positions) => {
      const commit = item.data as CommitSummary;
      return renderRowSingleLine({
        main: highlightMarkup(item.text, positions),
        detail: escapeMarkup(`${commit.author} · ${commit.date}`),
      });
    },
    onSelect: (sha) => void openCommitDiff(sha),
  });
  listCommits(root, 'HEAD', PICKER_COMMIT_LIMIT, (commits) => {
    if (commits.length === 0) {
      zym.notifications.addInfo('No commits yet');
      picker.close();
      return;
    }
    picker.setItems(
      commits.map((commit) => ({ value: commit.sha, text: `${commit.shortSha}  ${commit.subject}`, data: commit })),
    );
  });
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
  openReadonlyDiff(diffFiles, Icons.gitPullRequest, `${branch ?? 'HEAD'} vs ${base}`, wb.cwd, `Review of \`${branch ?? 'HEAD'}\` vs \`${base}\``);
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
      return { path: Path.join(root, f.relPath), oldText, newText, label, deleted: f.status === 'D' };
    }),
  );
}

/** Open a read-only multibuffer diff in a center tab (no editing / staging, but commenting IS on).
 *  Hosted like the built-in continuous diff — selected, focused, disposed on close, and driven by
 *  the same `zo`/`zR`/`zm` fold commands. `reviewContext` names the revision for review messages. */
function openReadonlyDiff(files: DiffFile[], icon: string, titleText: string, cwd: string, reviewContext: string): void {
  const view = new DiffView({
    files,
    cwd,
    editable: false, // historical content — both sides are git blobs, not live documents
    onActivate: ({ path, row }) => zym.workspace.openFile(path, { cursor: [row, 0] }),
    // Review a historical diff: the view formats each comment; the workspace routes it to an agent.
    onSend: (message) => zym.workspace.sendReviewToAgent(message),
    reviewContext, // tells the agent which branch/base these lines belong to
  });
  // Consult the diff on window close so unsent review comments aren't silently lost.
  const participant = zym.session.registerParticipant(view);
  zym.workspace.openTab(view.root, {
    title: `${icon}  ${titleText}`,
    requireTabBar: true,
    onClose: () => (participant.dispose(), view.dispose()),
  });
  view.focus(); // focus the editor (openTab focuses the tab's root widget, not the inner editor)
}
