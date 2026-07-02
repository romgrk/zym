/*
 * git/cli.ts — a thin wrapper over the `git` command line, used by the Source
 * Control UI for status, staging, and committing.
 *
 * Why the CLI (not libgit2): it gives us exactly what `git status`/`git diff`
 * print without re-deriving it, and respects the user's hooks and config
 * (name/email, GPG, pre-commit/commit-msg) for free.
 *
 * I/O model: every `git` invocation is **asynchronous** (callback form) and runs
 * through the process runner (`../process/runner.ts`), so the big node-gtk parent
 * never forks and the UI thread never blocks on a spawn. The few facts we used to
 * read synchronously (the repo root, a directory's worktree, the worktree list)
 * are derived straight from the on-disk git layout instead — pure `fs` reads, no
 * subprocess at all (see `repoRoot` / `worktreeInfo` / `listWorktrees`).
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { type ProcResult, runProcess } from '../process/runner.ts';
import {
  COMMIT_LOG_FORMAT,
  COMMIT_FILES_FORMAT,
  parseCommitLog,
  parseCommitFiles,
  parseNameStatusZ,
  type ChangedFile,
  type CommitSummary,
} from './status.ts';

export type { ChangedFile, CommitSummary, CommitRef } from './status.ts';

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

function decode(r: ProcResult, onDone: GitDone): void {
  onDone(r.ok, r.stdout.toString('utf8'), r.stderr.toString('utf8'));
}

// Every invocation is `git --no-optional-locks <cmd>` so background reads never
// take `.git/index.lock` — see "Locking" in docs/git/index.md.
const GIT_FLAGS = ['--no-optional-locks'];

/** Run git asynchronously (callback form). Routed through the process runner so
 *  the big parent never forks; promises are starved under the GLib loop, so the
 *  whole git surface is callback-based. */
export function git(cwd: string, args: string[], onDone: GitDone): void {
  runProcess({ file: 'git', args: [...GIT_FLAGS, ...args], cwd }, (r) => decode(r, onDone));
}

// --- repo topology (derived from the on-disk layout — no subprocess) ----------

// repoRoot(cwd) is invariant for a fixed checkout, but it's on hot paths (every
// workbench switch rebinds the git chrome). It's also exactly the nearest
// ancestor of `cwd` containing a `.git` entry — what `git rev-parse
// --show-toplevel` reports — so we walk the filesystem for it directly, with no
// fork. Memoized by cwd; `invalidateRepoRoot` drops entries when a directory's
// git topology changes.
const repoRootCache = new Map<string, string | null>();

/** The repository top-level for `cwd`, or null when not inside a repo. Memoized. */
export function repoRoot(cwd: string): string | null {
  const cached = repoRootCache.get(cwd);
  if (cached !== undefined) return cached;
  let root: string | null = null;
  let dir = Path.resolve(cwd);
  for (;;) {
    if (Fs.existsSync(Path.join(dir, '.git'))) {
      root = dir;
      break;
    }
    const parent = Path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  if (root) {
    try { root = Fs.realpathSync(root); } catch { /* keep the walked path */ }
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

/** The git dir backing the worktree rooted at `root`: `<root>/.git` is either a
 *  directory (the main checkout) or a file "gitdir: <path>" (a linked worktree).
 *  Returns the resolved git-dir path, or null when there's no readable `.git`. */
function gitDirFor(root: string): string | null {
  const gp = Path.join(root, '.git');
  try {
    const st = Fs.statSync(gp);
    if (st.isDirectory()) return gp;
    if (st.isFile()) {
      const m = Fs.readFileSync(gp, 'utf8').match(/gitdir:\s*(.+)/);
      if (m) return Path.resolve(root, m[1].trim());
    }
  } catch { /* no .git */ }
  return null;
}

/** The *common* git dir for the worktree rooted at `root` — the main checkout's
 *  `.git`, shared by every linked worktree (where refs and `worktrees/` live). */
function commonDirFor(root: string): string | null {
  const gd = gitDirFor(root);
  if (!gd) return null;
  // A linked worktree's git dir (`<common>/worktrees/<name>`) carries a `commondir`
  // file pointing back (relative) to the common dir; the main checkout has none.
  try {
    const cdFile = Path.join(gd, 'commondir');
    if (Fs.existsSync(cdFile)) return Path.resolve(gd, Fs.readFileSync(cdFile, 'utf8').trim());
  } catch { /* fall through to the main-checkout case */ }
  return gd;
}

/** The branch checked out in `gitDir` (its HEAD), or null when detached. */
function readHeadBranch(gitDir: string): string | null {
  try {
    const head = Fs.readFileSync(Path.join(gitDir, 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** The HEAD commit OID for `gitDir` (refs resolved against `commonDir`), or null. */
function readHeadOid(gitDir: string, commonDir: string): string | null {
  try {
    const head = Fs.readFileSync(Path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40,64}$/i.test(head)) return head; // detached
    const m = head.match(/^ref:\s*(.+)$/);
    if (!m) return null;
    const ref = m[1].trim();
    const loose = Path.join(commonDir, ref);
    if (Fs.existsSync(loose)) return Fs.readFileSync(loose, 'utf8').trim();
    const packed = Path.join(commonDir, 'packed-refs');
    if (Fs.existsSync(packed)) {
      for (const line of Fs.readFileSync(packed, 'utf8').split('\n')) {
        const pm = line.match(/^([0-9a-f]{40,64})\s+(.+)$/i);
        if (pm && pm[2].trim() === ref) return pm[1];
      }
    }
  } catch { /* unreadable */ }
  return null;
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
  // A linked worktree's `.git` is a file; the main checkout's is a directory.
  let linked = false;
  try { linked = Fs.statSync(Path.join(root, '.git')).isFile(); } catch { /* leave false */ }
  const gd = gitDirFor(root);
  return { root, name: Path.basename(root), branch: gd ? readHeadBranch(gd) : null, linked };
}

/** One entry from the worktree list — a checkout (main or linked) of the repo. */
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

/** Every worktree of the repository containing `cwd`; the main checkout is first
 *  (`linked:false`). Empty outside a repo. Read straight from the git layout
 *  (`<common>/worktrees/*`), so it never forks. */
export function listWorktrees(cwd: string): WorktreeEntry[] {
  const root = repoRoot(cwd);
  if (!root) return [];
  const commonDir = commonDirFor(root);
  if (!commonDir) return [];

  // The common dir is `<main>/.git`; the main worktree is its parent.
  const mainRoot = Path.dirname(commonDir);
  const entries: WorktreeEntry[] = [
    {
      path: mainRoot,
      name: Path.basename(mainRoot),
      branch: readHeadBranch(commonDir),
      head: readHeadOid(commonDir, commonDir),
      linked: false,
    },
  ];

  let names: string[] = [];
  try { names = Fs.readdirSync(Path.join(commonDir, 'worktrees')).sort(); } catch { /* none */ }
  for (const name of names) {
    const adminDir = Path.join(commonDir, 'worktrees', name);
    let wtPath: string | null = null;
    try {
      // `gitdir` holds the path to the linked worktree's `.git` file; its parent
      // is the worktree root.
      wtPath = Path.dirname(Fs.readFileSync(Path.join(adminDir, 'gitdir'), 'utf8').trim());
    } catch { /* stale admin entry */ }
    if (!wtPath) continue;
    entries.push({
      path: wtPath,
      name: Path.basename(wtPath),
      branch: readHeadBranch(adminDir),
      head: readHeadOid(adminDir, commonDir),
      linked: true,
    });
  }
  return entries;
}

/** Absolute path of `.git/COMMIT_EDITMSG` (handles worktrees/submodules). Async:
 *  resolved via `git rev-parse --git-path`, falling back to `<root>/.git/…`. */
export function commitMsgPath(root: string, onDone: (path: string) => void): void {
  git(root, ['rev-parse', '--git-path', 'COMMIT_EDITMSG'], (ok, stdout) => {
    const p = stdout.trim();
    if (ok && p) onDone(Path.isAbsolute(p) ? p : Path.join(root, p));
    else onDone(Path.join(root, '.git', 'COMMIT_EDITMSG'));
  });
}

const STATUS_PORCELAIN_ARGS = ['status', '--porcelain=v2', '-z'];

/** Async `git status --porcelain=v2 -z` → a flat list of changes. Empties on error. */
export function getChangesAsync(root: string, onDone: (changes: GitChange[]) => void): void {
  git(root, STATUS_PORCELAIN_ARGS, (ok, stdout) => onDone(ok ? parseChanges(root, stdout) : []));
}

/** Parse `git status --porcelain=v2 -z` output into a flat list of changes. */
function parseChanges(root: string, out: string): GitChange[] {
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
  const args = [...GIT_FLAGS, 'apply', '--unidiff-zero', '--recount', '--whitespace=nowarn'];
  if (opts.cached) args.push('--cached');
  if (opts.reverse) args.push('--reverse');
  args.push('-');
  runProcess({ file: 'git', args, cwd: root, input: patch }, (r) => decode(r, onDone));
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
  // `-d` so an untracked *directory* is removed too (the explicit `--` pathspec
  // scopes it to just this entry; ignored files are still left alone without `-x`).
  git(root, ['clean', '-fd', '--', relPath], onDone);
}

export function stageAll(root: string, onDone: GitDone): void {
  git(root, ['add', '-A'], onDone);
}

export function unstageAll(root: string, onDone: GitDone): void {
  git(root, ['reset', '-q'], onDone);
}

/** Commit using a message file (`git commit -F`); `amend` rewrites HEAD. */
export function commit(root: string, messageFile: string, onDone: GitDone, amend = false): void {
  const args = ['commit', '-F', messageFile];
  if (amend) args.push('--amend');
  git(root, args, onDone);
}

/** Revert a commit: create a new commit that undoes `sha` (`git revert --no-edit`,
 *  so it uses git's default "Revert …" message rather than opening an editor). Like a
 *  merge, it may stop with conflicts (non-zero exit) for the user to resolve. */
export function revertCommit(root: string, sha: string, onDone: GitDone): void {
  git(root, ['revert', '--no-edit', sha], onDone);
}

/** Full message of HEAD (`git log -1 --format=%B`); empty string on an unborn
 *  branch or outside a repo. Used to prefill an amend's message. */
export function lastCommitMessage(root: string, onDone: (message: string) => void): void {
  git(root, ['log', '-1', '--format=%B'], (ok, stdout) => onDone(ok ? stdout : ''));
}

/** `git blame --line-porcelain` for `relPath`, blaming `contents` (the live buffer,
 *  fed on stdin via `--contents -`) so line numbers and uncommitted lines match what
 *  the user sees rather than the on-disk file. */
export function blame(root: string, relPath: string, contents: string, onDone: GitDone): void {
  const args = [...GIT_FLAGS, 'blame', '--line-porcelain', '--contents', '-', '--', relPath];
  runProcess({ file: 'git', args, cwd: root, input: contents }, (r) => decode(r, onDone));
}

/** `git blame` for a single 1-based `line` of `relPath` (blaming the live `contents`).
 *  The cheap path for "what commit touched this one line" — used by the commit popover
 *  and PR-for-line lookup, independent of whether inline blame is on. */
export function blameLine(root: string, relPath: string, line: number, contents: string, onDone: GitDone): void {
  const args = [...GIT_FLAGS, 'blame', '-L', `${line},${line}`, '--line-porcelain', '--contents', '-', '--', relPath];
  runProcess({ file: 'git', args, cwd: root, input: contents }, (r) => decode(r, onDone));
}

// --- branches ----------------------------------------------------------------

/** The current branch name, or null (detached HEAD / not a repo). Async. */
export function currentBranch(root: string, onDone: (branch: string | null) => void): void {
  git(root, ['branch', '--show-current'], (ok, stdout) => onDone(ok ? stdout.trim() || null : null));
}

/** The upstream tracking ref of the current branch (e.g. `origin/master`), or null
 *  when there is none (no upstream configured / detached HEAD / not a repo). Async. */
export function upstreamRef(root: string, onDone: (ref: string | null) => void): void {
  git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], (ok, stdout) =>
    onDone(ok ? stdout.trim() || null : null),
  );
}

/** Local branch names, most-recently-committed first. Async. */
export function listBranches(root: string, onDone: (branches: string[]) => void): void {
  git(root, ['branch', '--format=%(refname:short)', '--sort=-committerdate'], (ok, stdout) =>
    onDone(ok ? stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []),
  );
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

/** The stash entries, newest first. Async. */
export function listStashes(root: string, onDone: (stashes: Stash[]) => void): void {
  git(root, ['stash', 'list', '--format=%gd%x09%gs'], (ok, stdout) =>
    onDone(
      ok
        ? stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const tab = line.indexOf('\t');
              return tab === -1
                ? { ref: line, description: '' }
                : { ref: line.slice(0, tab), description: line.slice(tab + 1) };
            })
        : [],
    ),
  );
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

// --- history & diffs ----------------------------------------------------------
// Read-only helpers backing the commit and branch (PR-style) diff views: list
// commits for the picker, enumerate the files a commit/range touched, and read a
// blob at an arbitrary revision so the diff view can show old-vs-new content.

/** Recent commits reachable from `rev` (HEAD by default), newest first. Async. */
export function listCommits(
  root: string,
  rev: string,
  limit: number,
  onDone: (commits: CommitSummary[]) => void,
): void {
  git(
    root,
    // `--decorate=full` so `%D` (in COMMIT_LOG_FORMAT) emits fully-qualified ref names
    // for `parseRefNames` to classify into branch/remote/tag badges.
    ['log', '--decorate=full', `--max-count=${limit}`, '--date=relative', `--format=${COMMIT_LOG_FORMAT}`, rev, '--'],
    (ok, stdout) => onDone(ok ? parseCommitLog(stdout) : []),
  );
}

/** The changed paths of the recent commits reachable from `rev`, keyed by full sha —
 *  one `git log --name-only` pass, so the log viewer's `file:` filter can match files
 *  without a call per commit. Merge commits list no files (see `parseCommitFiles`). Async. */
export function listCommitFiles(
  root: string,
  rev: string,
  limit: number,
  onDone: (files: Map<string, string[]>) => void,
): void {
  git(
    root,
    ['log', `--max-count=${limit}`, '--name-only', `--format=${COMMIT_FILES_FORMAT}`, rev, '--'],
    (ok, stdout) => onDone(ok ? parseCommitFiles(stdout) : new Map()),
  );
}

/** The base branch for a PR-style diff: `master` if it exists locally, else `main`, else null.
 *  One call — `git branch --list` returns only whichever of the patterns actually exist. Async. */
export function defaultBaseBranch(root: string, onDone: (branch: string | null) => void): void {
  git(root, ['branch', '--list', '--format=%(refname:short)', 'master', 'main'], (ok, stdout) => {
    if (!ok) return onDone(null);
    const names = new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean));
    onDone(names.has('master') ? 'master' : names.has('main') ? 'main' : null);
  });
}

/** Resolve a revision to its full OID, or null when it doesn't exist. Async. */
export function resolveRef(root: string, ref: string, onDone: (oid: string | null) => void): void {
  git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], (ok, stdout) =>
    onDone(ok ? stdout.trim() || null : null),
  );
}

/** The merge base (common ancestor) of two revisions, or null when unrelated. Async. */
export function mergeBase(root: string, a: string, b: string, onDone: (base: string | null) => void): void {
  git(root, ['merge-base', a, b], (ok, stdout) => onDone(ok ? stdout.trim() || null : null));
}

/** Read a file's contents at a given revision, or null when absent there. Async. */
export function readFileAtRef(
  root: string,
  ref: string,
  relPath: string,
  onDone: (text: string | null) => void,
): void {
  git(root, ['show', `${ref}:${relPath}`], (ok, stdout) => onDone(ok ? stdout : null));
}

/** Files a commit changed vs its first parent (the root commit → vs the empty tree). Async. */
export function commitChangedFiles(root: string, commit: string, onDone: (files: ChangedFile[]) => void): void {
  // diff-tree against the first parent; --root makes the root commit diff vs the empty tree.
  // -M/-C detect renames/copies so the view pairs old and new paths. `-m --first-parent`
  // is what makes a *merge* commit report its first-parent diff (plain diff-tree emits
  // nothing for merges) — matching the `<sha>^` old side the diff view reads content from.
  git(
    root,
    ['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', '-C', '-m', '--first-parent', '-z', '--root', commit],
    (ok, stdout) => onDone(ok ? parseNameStatusZ(stdout) : []),
  );
}

/** Files changed between two revisions `a → b` (the PR-style three-dot view passes the merge base as `a`). Async. */
export function diffChangedFiles(root: string, a: string, b: string, onDone: (files: ChangedFile[]) => void): void {
  git(root, ['diff', '--name-status', '-M', '-C', '-z', a, b], (ok, stdout) =>
    onDone(ok ? parseNameStatusZ(stdout) : []),
  );
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
