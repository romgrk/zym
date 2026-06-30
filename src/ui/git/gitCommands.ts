/*
 * GitCommands — the window-level git repo-operation commands: staging (current file /
 * everything), fetch/pull/push, branch switch/delete/merge/rename, and the stash
 * actions. Split out of AppWindow so git orchestration isn't tangled into the shell;
 * the GitHub-specific `github:*` commands are chained in from `githubCommands.ts`.
 *
 * The diff/log/commit *views* (git:diff-*, git:log, git:start-commit) live with the
 * panel-tree code that hosts them — these are the operations that just shell out to git
 * and refresh. The active workbench's cwd/git and the active editor are injected as
 * getters (the workbench switches), per the registerGithubCommands idiom.
 */
import * as Path from 'node:path';
import Gtk from 'gi:Gtk-4.0';
import { zym } from '../../zym.ts';
import {
  repoRoot,
  stage,
  unstage,
  stageAll,
  unstageAll,
  type GitDone,
  type GitRepo,
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
import type { TextEditor } from '../TextEditor/index.ts';
import type { Disposable } from '../../util/eventKit.ts';

export interface GitCommandsDeps {
  overlay: InstanceType<typeof Gtk.Overlay>;
  /** The active workbench's root directory. */
  getCwd: () => string;
  /** The active workbench's pooled git repo. */
  getGit: () => GitRepo;
  /** The text editor backing the focused tab, if any (for the current-file staging). */
  activeEditor: () => TextEditor | null;
  /** The header's GitHub service — push schedules a CI refresh, and `github:*` chain in. */
  github: GithubService;
  toast: (message: string) => void;
}

/** Register the window-level git repo-operation (+ chained `github:*`) commands on `.AppWindow`. */
export function registerGitCommands(d: GitCommandsDeps): Disposable {
  const inRepo = () => d.getGit().getBranch() !== null;
  const onEditorFile = () => d.activeEditor()?.currentFile != null;
  const commands = zym.commands.add('.AppWindow', {
    // Staging from anywhere (not just the Source Control panel): the current
    // editor file, or the whole tree. These shell out to git directly — like the
    // panel's row actions — then refresh the cached repo so the gutter and branch
    // indicator update at once.
    'git:stage-current': {
      didDispatch: () => stageCurrentFile(d, true),
      description: 'Stage the current file (git add)',
      when: onEditorFile,
    },
    'git:unstage-current': {
      didDispatch: () => stageCurrentFile(d, false),
      description: 'Unstage the current file',
      when: onEditorFile,
    },
    'git:stage-all': {
      didDispatch: () => stageEverything(d, true),
      description: 'Stage all changes (git add -A)',
      when: inRepo,
    },
    'git:unstage-all': {
      didDispatch: () => stageEverything(d, false),
      description: 'Unstage all changes',
      when: inRepo,
    },
    // Git commands only apply inside a repository (a resolvable branch).
    'git:fetch': { didDispatch: () => runGit(() => d.getGit().fetch(), 'Fetch'), description: 'Fetch from the remote', when: inRepo },
    'git:pull': { didDispatch: () => runGit(() => d.getGit().pull(), 'Pull'), description: 'Pull from upstream (fast-forward)', when: inRepo },
    'git:push': {
      // After a successful push, GitHub re-runs the PR's checks; schedule a CI
      // refresh ~10s out. The service stays busy until then, so the CI segment
      // shows the in-progress (loading) look in the meantime. The first push of a
      // new branch sets its upstream to this remote (the fork's), per `git.remotes.origin`.
      didDispatch: () => {
        const remote = (zym.config.get('git.remotes.origin') as string) || 'origin';
        runGit(() => d.getGit().push(remote), 'Push', () => d.github.scheduleRefresh(10000));
      },
      description: 'Push to the remote (sets the upstream on a new branch)',
      when: inRepo,
    },
    'git:branch-switch': {
      didDispatch: () => openBranchPicker(d.overlay, d.getCwd(), d.getGit()),
      description: 'Switch or create a branch…',
      when: inRepo,
    },
    'git:branch-delete': {
      didDispatch: () => openDeleteBranchPicker(d.overlay, d.getCwd(), d.getGit()),
      description: 'Delete a branch…',
      when: inRepo,
    },
    'git:branch-merge': {
      didDispatch: () => openMergeBranchPicker(d.overlay, d.getCwd(), d.getGit()),
      description: 'Merge a branch into current…',
      when: inRepo,
    },
    'git:branch-rename': {
      didDispatch: () => openRenameBranchPicker(d.overlay, d.getCwd(), d.getGit()),
      description: 'Rename the current branch…',
      when: inRepo,
    },
    'git:stash-push': {
      didDispatch: () => stashChanges(d),
      description: 'Stash changes',
      when: inRepo,
    },
    'git:stash-pop': {
      didDispatch: () => openStashPicker(d.overlay, d.getCwd(), 'pop', d.getGit()),
      description: 'Pop a stash…',
      when: inRepo,
    },
    'git:stash-apply': {
      didDispatch: () => openStashPicker(d.overlay, d.getCwd(), 'apply', d.getGit()),
      description: 'Apply a stash…',
      when: inRepo,
    },
    'git:stash-drop': {
      didDispatch: () => openStashPicker(d.overlay, d.getCwd(), 'drop', d.getGit()),
      description: 'Drop a stash…',
      when: inRepo,
    },
  });
  // GitHub-specific commands (pickers + open-on-web) live in their own module.
  registerGithubCommands({
    overlay: d.overlay,
    github: d.github,
    cwd: () => d.getCwd(),
    git: () => d.getGit(),
    toast: (message) => d.toast(message),
  });
  return commands;
}

// Stage / unstage the active editor's file. `git add -- <path>` when staging,
// `git restore --staged -- <path>` when unstaging; the repo root is resolved
// from the file itself (the active editor may belong to a nested repo).
function stageCurrentFile(d: GitCommandsDeps, staging: boolean): void {
  const path = d.activeEditor()?.currentFile;
  if (!path) return;
  const root = repoRoot(Path.dirname(path));
  if (!root) {
    d.toast('Not in a git repository');
    return;
  }
  const rel = Path.relative(root, path);
  const name = Path.basename(path);
  const verb = staging ? 'Stage' : 'Unstage';
  const op = staging ? stage : unstage;
  op(root, rel, gitStageDone(d, `${verb} ${name}`));
}

// Stage / unstage the whole working tree: `git add -A` / `git reset -q`.
function stageEverything(d: GitCommandsDeps, staging: boolean): void {
  const root = repoRoot(d.getCwd());
  if (!root) {
    d.toast('Not in a git repository');
    return;
  }
  const op = staging ? stageAll : unstageAll;
  op(root, gitStageDone(d, staging ? 'Stage all' : 'Unstage all'));
}

// Refresh the cached repo so the gutter, Source Control panel, and branch
// indicator update immediately; report only failures (success is silent).
function gitStageDone(d: GitCommandsDeps, label: string): GitDone {
  return (ok, _out, err) => {
    if (!ok) zym.notifications.addError(`${label} failed`, { detail: err.trim() });
    d.getGit().refresh();
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
async function stashChanges(d: GitCommandsDeps) {
  const result = await d.getGit().stash();
  if (result.isOk()) zym.notifications.addSuccess('Stashed changes');
  else zym.notifications.addError('Stash failed', { detail: result.unwrapErr().message.trim() });
}
