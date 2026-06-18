/*
 * git/cli.ts — a thin wrapper over the `git` command line, used by the Source
 * Control UI for status, staging, and committing.
 *
 * Why the CLI (not the libgit2 `GitRepo` in ../git.ts): it gives us exactly what
 * `git status`/`git diff` print without re-deriving it, and respects the user's
 * hooks and config (name/email, GPG, pre-commit/commit-msg) for free. node I/O
 * is fine here — a probe under the live GLib loop confirmed `execFileSync` and
 * `execFile` callbacks work; only promise/microtask resolution is starved, so we
 * use the callback form and avoid promise wrappers.
 */
import { execFile, execFileSync } from 'node:child_process';
import * as Path from 'node:path';

export type GitFileState =
  | 'new'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'conflicted'
  | 'untracked';

/** One changed path, with where the change lives (index vs worktree). */
export interface GitChange {
  /** Absolute path. */
  path: string;
  /** Repo-relative path (display + git pathspec). */
  relPath: string;
  state: GitFileState;
  staged: boolean;
  unstaged: boolean;
}

export type GitDone = (ok: boolean, stdout: string, stderr: string) => void;

const MAX_BUFFER = 64 * 1024 * 1024;

/** Run git synchronously and return stdout. Throws on non-zero exit. */
export function gitSync(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
}

/** Run git asynchronously (callback form — promises are starved under the loop). */
export function git(cwd: string, args: string[], onDone: GitDone): void {
  execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
    onDone(!err, stdout ?? '', stderr ?? '');
  });
}

// repoRoot(cwd) is invariant for a fixed directory over the life of its checkout,
// but it's on hot paths — every workbench switch rebinds the git chrome, which
// forks `git rev-parse --show-toplevel`. fork() cost scales with this process's
// RSS, so under the long-lived node-gtk process (which accrues native memory)
// these synchronous spawns grow to tens of ms each and stall the UI. Memoize by
// cwd; `invalidateRepoRoot` drops entries when a directory's git topology changes.
const repoRootCache = new Map<string, string | null>();

/** The repository top-level for `cwd`, or null when not inside a repo. Memoized. */
export function repoRoot(cwd: string): string | null {
  const cached = repoRootCache.get(cwd);
  if (cached !== undefined) return cached;
  let root: string | null;
  try {
    root = gitSync(cwd, ['rev-parse', '--show-toplevel']).trim() || null;
  } catch {
    root = null;
  }
  repoRootCache.set(cwd, root);
  return root;
}

/** Drop memoized repoRoot results after git topology changes (e.g. a worktree is
 *  created at a path previously probed as non-repo). Clears `cwd` only, or all. */
export function invalidateRepoRoot(cwd?: string): void {
  if (cwd === undefined) repoRootCache.clear();
  else repoRootCache.delete(cwd);
}

/** Where a directory sits in git: its worktree root, branch, and whether it's a
 *  linked worktree (a `git worktree add` checkout) rather than the main one. */
export interface WorktreeInfo {
  /** The worktree's top-level directory. */
  root: string;
  /** The display name — the worktree root's basename. */
  name: string;
  /** The checked-out branch, or null when detached. */
  branch: string | null;
  /** True for a linked worktree (`.git/worktrees/<name>`), false for the main checkout. */
  linked: boolean;
}

/** The git worktree `cwd` lives in, or null when `cwd` isn't inside a repo. */
export function worktreeInfo(cwd: string): WorktreeInfo | null {
  const root = repoRoot(cwd);
  if (!root) return null;
  let linked = false;
  try {
    // A linked worktree's git dir is `<common>/worktrees/<name>`; the main
    // checkout's is the plain `<root>/.git`.
    linked = gitSync(cwd, ['rev-parse', '--git-dir']).includes('/worktrees/');
  } catch {
    /* leave linked=false on any git error */
  }
  return { root, name: Path.basename(root), branch: currentBranch(root), linked };
}

/** One entry from `git worktree list` — a checkout (main or linked) of the repo. */
export interface WorktreeEntry {
  /** The worktree's top-level directory (absolute). */
  path: string;
  /** Display name — the path's basename. */
  name: string;
  /** Checked-out branch (short name), or null when detached / bare. */
  branch: string | null;
  /** HEAD commit OID, or null for a bare entry. */
  head: string | null;
  /** True for a linked worktree, false for the main checkout. */
  linked: boolean;
}

/** Every worktree of the repository containing `cwd` (`git worktree list
 *  --porcelain`); the main checkout is first (`linked:false`). Empty outside a
 *  repo. */
export function listWorktrees(cwd: string): WorktreeEntry[] {
  let out: string;
  try {
    out = gitSync(cwd, ['worktree', 'list', '--porcelain', '-z']);
  } catch {
    return [];
  }
  // Porcelain records are blank-line separated; with -z lines are NUL-joined and
  // records are double-NUL separated. Parse defensively for both forms.
  const entries: WorktreeEntry[] = [];
  for (const block of out.split(/\0\0|\n\n/)) {
    let path: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;
    for (const line of block.split(/\0|\n/)) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length) || null;
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '') || null;
    }
    if (!path) continue;
    entries.push({ path, name: Path.basename(path), branch, head, linked: entries.length > 0 });
  }
  return entries;
}

/** Absolute path of `.git/COMMIT_EDITMSG` (handles worktrees/submodules). */
export function commitMsgPath(root: string): string {
  const p = gitSync(root, ['rev-parse', '--git-path', 'COMMIT_EDITMSG']).trim();
  return Path.isAbsolute(p) ? p : Path.join(root, p);
}

/** Parse `git status --porcelain=v2 -z` into a flat list of changes. */
export function getChanges(root: string): GitChange[] {
  let out: string;
  try {
    out = gitSync(root, ['status', '--porcelain=v2', '-z']);
  } catch {
    return [];
  }

  const changes: GitChange[] = [];
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const kind = tok[0];

    if (kind === '?') {
      changes.push(mk(root, tok.slice(2), 'untracked', false, true));
    } else if (kind === '1') {
      // 1 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const f = tok.split(' ');
      pushTracked(changes, root, f[1], f.slice(8).join(' '));
    } else if (kind === '2') {
      // 2 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\0<origPath>
      const f = tok.split(' ');
      pushTracked(changes, root, f[1], f.slice(9).join(' '));
      i++; // the next token is the rename's original path — consume it
    } else if (kind === 'u') {
      // u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const f = tok.split(' ');
      changes.push(mk(root, f.slice(10).join(' '), 'conflicted', true, true));
    }
    // '!' (ignored) and anything else: skip.
  }
  return changes;
}

// --- Mutations (callback form; refresh on completion) ------------------------

export function stage(root: string, relPath: string, onDone: GitDone): void {
  git(root, ['add', '--', relPath], onDone);
}

/**
 * Apply a unified-diff `patch` (fed on stdin) with `git apply` — the primitive
 * behind hunk-level staging. `cached` targets the index (stage/unstage); `reverse`
 * applies it backwards (unstage / discard). `--unidiff-zero --recount` lets git
 * accept the zero-context patches `formatHunkPatch` synthesizes.
 */
export function applyPatch(
  root: string,
  patch: string,
  opts: { cached?: boolean; reverse?: boolean },
  onDone: GitDone,
): void {
  const args = ['apply', '--unidiff-zero', '--recount', '--whitespace=nowarn'];
  if (opts.cached) args.push('--cached');
  if (opts.reverse) args.push('--reverse');
  args.push('-');
  const child = execFile('git', args, { cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
    onDone(!err, stdout ?? '', stderr ?? '');
  });
  child.stdin?.end(patch);
}

export function unstage(root: string, relPath: string, onDone: GitDone): void {
  git(root, ['restore', '--staged', '--', relPath], onDone);
}

/** Discard working-tree changes to a tracked file (destructive). */
export function discard(root: string, relPath: string, onDone: GitDone): void {
  git(root, ['restore', '--', relPath], onDone);
}

/** Remove an untracked file (destructive). */
export function clean(root: string, relPath: string, onDone: GitDone): void {
  git(root, ['clean', '-f', '--', relPath], onDone);
}

export function stageAll(root: string, onDone: GitDone): void {
  git(root, ['add', '-A'], onDone);
}

export function unstageAll(root: string, onDone: GitDone): void {
  git(root, ['reset', '-q'], onDone);
}

/** Commit using a message file (`git commit -F`). */
export function commit(root: string, messageFile: string, onDone: GitDone): void {
  git(root, ['commit', '-F', messageFile], onDone);
}

// --- branches ----------------------------------------------------------------

/** The current branch name, or null (detached HEAD / not a repo). */
export function currentBranch(root: string): string | null {
  try {
    return gitSync(root, ['branch', '--show-current']).trim() || null;
  } catch {
    return null;
  }
}

/** Local branch names, most-recently-committed first. */
export function listBranches(root: string): string[] {
  try {
    return gitSync(root, ['branch', '--format=%(refname:short)', '--sort=-committerdate'])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Switch to an existing branch. */
export function switchBranch(root: string, branch: string, onDone: GitDone): void {
  git(root, ['switch', branch], onDone);
}

/** Create a new branch off HEAD and switch to it. */
export function createBranch(root: string, name: string, onDone: GitDone): void {
  git(root, ['switch', '-c', name], onDone);
}

/** Delete a branch (safe: refuses unmerged branches). */
export function deleteBranch(root: string, name: string, onDone: GitDone): void {
  git(root, ['branch', '-d', name], onDone);
}

/** Merge a branch into the current one. */
export function mergeBranch(root: string, name: string, onDone: GitDone): void {
  git(root, ['merge', name], onDone);
}

/** Rename the current branch. */
export function renameBranch(root: string, name: string, onDone: GitDone): void {
  git(root, ['branch', '-m', name], onDone);
}

// --- stash -------------------------------------------------------------------

export interface Stash {
  ref: string; // e.g. "stash@{0}"
  description: string; // e.g. "WIP on master: 1a2b3c …"
}

/** The stash entries, newest first. */
export function listStashes(root: string): Stash[] {
  try {
    return gitSync(root, ['stash', 'list', '--format=%gd%x09%gs'])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        return tab === -1
          ? { ref: line, description: '' }
          : { ref: line.slice(0, tab), description: line.slice(tab + 1) };
      });
  } catch {
    return [];
  }
}

/** Stash the working-tree changes. */
export function stashPush(root: string, onDone: GitDone): void {
  git(root, ['stash', 'push'], onDone);
}

/** Apply a stash and drop it. */
export function stashPop(root: string, ref: string, onDone: GitDone): void {
  git(root, ['stash', 'pop', ref], onDone);
}

/** Apply a stash, keeping it in the list. */
export function stashApply(root: string, ref: string, onDone: GitDone): void {
  git(root, ['stash', 'apply', ref], onDone);
}

/** Discard a stash. */
export function stashDrop(root: string, ref: string, onDone: GitDone): void {
  git(root, ['stash', 'drop', ref], onDone);
}

// --- internals ---------------------------------------------------------------

function pushTracked(changes: GitChange[], root: string, xy: string, rel: string): void {
  const staged = xy[0] !== '.';
  const unstaged = xy[1] !== '.';
  changes.push(mk(root, rel, mapState(staged ? xy[0] : xy[1]), staged, unstaged));
}

function mapState(ch: string): GitFileState {
  switch (ch) {
    case 'A':
      return 'new';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'U':
      return 'conflicted';
    default:
      return 'modified'; // M, T (type change), C (copy)
  }
}

function mk(
  root: string,
  rel: string,
  state: GitFileState,
  staged: boolean,
  unstaged: boolean,
): GitChange {
  return { path: Path.join(root, rel), relPath: rel, state, staged, unstaged };
}
