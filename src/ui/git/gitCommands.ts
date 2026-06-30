/*
 * GitCommands — the window-level git repo-operation commands: staging (current file /
 * everything), fetch/pull/push, branch switch/delete/merge/rename, and the stash
 * actions. Split out of AppWindow so git orchestration isn't tangled into the shell;
 * the GitHub-specific `github:*` commands are chained in from `githubCommands.ts`.
 *
 * Atom-style, the active workbench (cwd / git), the active editor, the picker host, and
 * notifications are read straight off the `zym` globals; only the header's `GithubService`
 * (header-owned, not a workspace concept) is injected.
 */
import * as Path from 'node:path';
import { zym } from '../../zym.ts';
import {
  repoRoot,
  stage,
  unstage,
  stageAll,
  unstageAll,
  type GitDone,
  type GitOpResult,
} from '../../git.ts';
import {
  openBranchPicker,
  openDeleteBranchPicker,
  openMergeBranchPicker,
  openRenameBranchPicker,
} from './BranchPicker.ts';
import { openStashPicker } from './StashPicker.ts';
import { registerGithubCommands } from '../githubCommands.ts';
import type { GithubService } from '../../github.ts';
import { Disposable } from '../../util/eventKit.ts';

export interface GitCommandsDeps {
  /** The header's GitHub service — push schedules a CI refresh, and `github:*` chain in. */
  github: GithubService;
}

const workbench = () => zym.workspace.getActiveWorkbench()!;
const host = () => zym.workspace.getPickerHost();

/** Register the window-level git repo-operation (+ chained `github:*`) commands on `.AppWindow`. */
export function registerGitCommands(d: GitCommandsDeps): Disposable {
  const inRepo = () => workbench().git.getBranch() !== null;
  const onEditorFile = () => zym.workspace.getActiveTextEditor()?.currentFile != null;
  const commands = zym.commands.add('.AppWindow', {
    // Staging from anywhere (not just the Source Control panel): the current
    // editor file, or the whole tree. These shell out to git directly — like the
    // panel's row actions — then refresh the cached repo so the gutter and branch
    // indicator update at once.
    'git:stage-current': { didDispatch: () => stageCurrentFile(true), description: 'Stage the current file (git add)', when: onEditorFile },
    'git:unstage-current': { didDispatch: () => stageCurrentFile(false), description: 'Unstage the current file', when: onEditorFile },
    'git:stage-all': { didDispatch: () => stageEverything(true), description: 'Stage all changes (git add -A)', when: inRepo },
    'git:unstage-all': { didDispatch: () => stageEverything(false), description: 'Unstage all changes', when: inRepo },
    // Git commands only apply inside a repository (a resolvable branch).
    'git:fetch': { didDispatch: () => runGit(() => workbench().git.fetch(), 'Fetch'), description: 'Fetch from the remote', when: inRepo },
    'git:pull': { didDispatch: () => runGit(() => workbench().git.pull(), 'Pull'), description: 'Pull from upstream (fast-forward)', when: inRepo },
    'git:push': {
      // After a successful push, GitHub re-runs the PR's checks; schedule a CI
      // refresh ~10s out. The service stays busy until then, so the CI segment
      // shows the in-progress (loading) look in the meantime. The first push of a
      // new branch sets its upstream to this remote (the fork's), per `git.remotes.origin`.
      didDispatch: () => {
        const remote = (zym.config.get('git.remotes.origin') as string) || 'origin';
        runGit(() => workbench().git.push(remote), 'Push', () => d.github.scheduleRefresh(10000));
      },
      description: 'Push to the remote (sets the upstream on a new branch)',
      when: inRepo,
    },
    'git:branch-switch': { didDispatch: () => openBranchPicker(host(), workbench().cwd, workbench().git), description: 'Switch or create a branch…', when: inRepo },
    'git:branch-delete': { didDispatch: () => openDeleteBranchPicker(host(), workbench().cwd, workbench().git), description: 'Delete a branch…', when: inRepo },
    'git:branch-merge': { didDispatch: () => openMergeBranchPicker(host(), workbench().cwd, workbench().git), description: 'Merge a branch into current…', when: inRepo },
    'git:branch-rename': { didDispatch: () => openRenameBranchPicker(host(), workbench().cwd, workbench().git), description: 'Rename the current branch…', when: inRepo },
    'git:stash-push': { didDispatch: () => stashChanges(), description: 'Stash changes', when: inRepo },
    'git:stash-pop': { didDispatch: () => openStashPicker(host(), workbench().cwd, 'pop', workbench().git), description: 'Pop a stash…', when: inRepo },
    'git:stash-apply': { didDispatch: () => openStashPicker(host(), workbench().cwd, 'apply', workbench().git), description: 'Apply a stash…', when: inRepo },
    'git:stash-drop': { didDispatch: () => openStashPicker(host(), workbench().cwd, 'drop', workbench().git), description: 'Drop a stash…', when: inRepo },
  });
  // GitHub-specific commands (pickers + open-on-web) live in their own module;
  // chain their teardown into the returned Disposable so disposing this module
  // also drains the `github:*` commands it registered.
  const github = registerGithubCommands({
    overlay: host(),
    github: d.github,
    cwd: () => workbench().cwd,
    git: () => workbench().git,
    toast: (message) => zym.notifications.addInfo(message),
  });
  return new Disposable(() => {
    commands.dispose();
    github.dispose();
  });
}

// Stage / unstage the active editor's file. `git add -- <path>` when staging,
// `git restore --staged -- <path>` when unstaging; the repo root is resolved
// from the file itself (the active editor may belong to a nested repo).
function stageCurrentFile(staging: boolean): void {
  const path = zym.workspace.getActiveTextEditor()?.currentFile;
  if (!path) return;
  const root = repoRoot(Path.dirname(path));
  if (!root) {
    zym.notifications.addInfo('Not in a git repository');
    return;
  }
  const rel = Path.relative(root, path);
  const name = Path.basename(path);
  const verb = staging ? 'Stage' : 'Unstage';
  const op = staging ? stage : unstage;
  op(root, rel, gitStageDone(`${verb} ${name}`));
}

// Stage / unstage the whole working tree: `git add -A` / `git reset -q`.
function stageEverything(staging: boolean): void {
  const root = repoRoot(workbench().cwd);
  if (!root) {
    zym.notifications.addInfo('Not in a git repository');
    return;
  }
  const op = staging ? stageAll : unstageAll;
  op(root, gitStageDone(staging ? 'Stage all' : 'Unstage all'));
}

// Refresh the cached repo so the gutter, Source Control panel, and branch
// indicator update immediately; report only failures (success is silent).
function gitStageDone(label: string): GitDone {
  return (ok, _out, err) => {
    if (!ok) zym.notifications.addError(`${label} failed`, { detail: err.trim() });
    workbench().git.refresh();
  };
}

// Run a coordinated git operation (e.g. `() => git.fetch()`) and report. Success
// is quiet (a trace, recorded in the log only); failures pop a toast.
async function runGit(op: () => Promise<GitOpResult>, label: string, onSuccess?: () => void) {
  const result = await op();
  if (result.isOk()) {
    zym.notifications.addTrace(`${label} succeeded`);
    onSuccess?.();
  } else zym.notifications.addError(`${label} failed`);
}

// Stash the working-tree changes (visible success, since it's a manual action).
async function stashChanges() {
  const result = await workbench().git.stash();
  if (result.isOk()) zym.notifications.addSuccess('Stashed changes');
  else zym.notifications.addError('Stash failed', { detail: result.unwrapErr().message.trim() });
}
