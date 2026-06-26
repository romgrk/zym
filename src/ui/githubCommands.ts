/*
 * GithubCommands — the window-level `github:*` commands (the pickers and the open-on-web
 * actions), split out of AppWindow so GitHub-specific orchestration isn't tangled into the
 * shell. The header-button commands stay in `GithubButtons` (they render from that widget's
 * state); the active editor comes from `zym.workspace.getActiveTextEditor()`, and the
 * overlay + active workbench's cwd/git are injected as getters (the workbench switches).
 */
import * as Path from 'node:path';
import { Gtk } from '../gi.ts';
import { zym } from '../zym.ts';
import { repoRoot, type GitRepo } from '../git.ts';
import { lineWebUrl, fetchCommitPullRequestUrl, type GithubService } from '../github.ts';
import { openUrl } from './openUrl.ts';
import { openGithubIssuePicker } from './GithubIssuePicker.ts';
import { openGithubFailedCIPicker } from './GithubFailedCIPicker.ts';
import { openGithubCIChecksPicker } from './GithubCIChecksPicker.ts';
import { switchToGithubPrPicker } from './GithubPrPicker.ts';
import { blameCommitAtCursor, isUncommitted } from './TextEditor/GitBlameController.ts';
import type { Disposable } from '../util/eventKit.ts';

export interface GithubCommandsDeps {
  overlay: InstanceType<typeof Gtk.Overlay>;
  github: GithubService;
  cwd: () => string;
  git: () => GitRepo;
  toast: (message: string) => void;
}

/** Register the window-level `github:*` commands on `.AppWindow`. */
export function registerGithubCommands(d: GithubCommandsDeps): Disposable {
  const inRepo = () => d.git().getBranch() !== null;
  const onEditorInRepo = () =>
    zym.workspace.getActiveTextEditor()?.currentFile != null && d.github.getRepo() !== null;
  return zym.commands.add('.AppWindow', {
    'github:issue-picker': { didDispatch: () => openGithubIssuePicker(d.overlay, d.cwd()), description: 'Open a GitHub issue…', when: inRepo },
    'github:failed-ci-picker': { didDispatch: () => openGithubFailedCIPicker(d.overlay, d.cwd()), description: 'Open a failed CI check…', when: inRepo },
    'github:ci-checks': { didDispatch: () => openGithubCIChecksPicker(d.overlay, d.cwd()), description: 'Show CI checks for this branch…', when: inRepo },
    'github:pull-request-checkout': { didDispatch: () => switchToGithubPrPicker(d.overlay, d.cwd(), d.git()), description: 'Check out a pull request…', when: inRepo },
    'github:open-line': { didDispatch: () => openLine(d), description: 'Open the current line on GitHub', when: onEditorInRepo },
    'github:open-pr-for-line': { didDispatch: () => openPrForLine(d), description: 'Open the pull request that introduced the current line', when: onEditorInRepo },
  });
}

// Open the active editor's current line on GitHub, pinned to the HEAD commit so the link
// stays valid even if the line later moves (falling back to the branch name when HEAD is
// unborn). 404s if HEAD isn't pushed yet — inherent to a local-first link.
function openLine(d: GithubCommandsDeps): void {
  const editor = zym.workspace.getActiveTextEditor();
  const path = editor?.currentFile;
  if (!editor || !path) return;
  const repo = d.github.getRepo();
  if (!repo) return d.toast('No GitHub remote for this repository');
  const root = repoRoot(Path.dirname(path));
  if (!root) return d.toast('Not in a git repository');
  const ref = d.git().getHead() ?? d.git().getBranch();
  if (!ref) return d.toast('No commit to link to');
  const rel = Path.relative(root, path).split(Path.sep).join('/');
  openUrl(lineWebUrl(repo, ref, rel, editor.lspCursor().row + 1)); // model line, 1-based
}

// Open the PR that introduced the current line: blame the line for its commit, then ask
// GitHub which PR carried that commit. Toasts when the line is uncommitted or the commit
// reached the branch outside a PR (a direct push).
function openPrForLine(d: GithubCommandsDeps): void {
  const editor = zym.workspace.getActiveTextEditor();
  if (!editor?.currentFile) return;
  if (!d.github.getRepo()) return d.toast('No GitHub remote for this repository');
  blameCommitAtCursor(editor, (info) => {
    if (!info) return d.toast('No blame for this line');
    if (isUncommitted(info.sha)) return d.toast('Line is not committed yet');
    fetchCommitPullRequestUrl(d.cwd(), info.sha, (url) => {
      if (url) openUrl(url);
      else d.toast('No pull request found for this commit');
    });
  });
}
