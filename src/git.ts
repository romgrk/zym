/*
 * Git integration, isolated behind a small abstraction.
 *
 * Backed by the `git` CLI (`./git/cli.ts`) — the same layer the Source Control
 * panel and mutations already use. We previously read via libgit2/Ggit, but
 * node-gtk never frees the GObjects GI hands back from `<Type>.new()` /
 * transfer-full returns (romgrk/node-gtk#446), so the old per-refresh
 * Repository/Diff/Tree/Ref churn grew the heap without bound and GC pauses became
 * increasingly long UI hangs. The CLI has zero GObject churn, and git is the
 * source of truth (it honours the user's hooks/config).
 *
 * The `GitRepo` reads are synchronous by contract — command `when:` predicates and
 * the status widgets read them on the render path and cannot await. We satisfy
 * that with async background refreshes that update cached state and fire
 * `onChange`; the getters then return those cached fields with no I/O. The cache
 * is warmed up asynchronously at construction (empty until the first status
 * lands), so construction never blocks the UI thread.
 *
 * Refreshes are mostly event-driven: a chokidar watch on the git dir's `HEAD` +
 * `index` catches branch switches, commits, staging, resets, and merges the
 * instant they land, and the editor calls `refresh()` directly after the edits
 * and mutations it drives (text edits, hunk staging, agent file writes). The one
 * thing those miss is an *external* tool editing a tracked file without staging it
 * (no `index`/`HEAD` move, no editor event); a slow 60s heartbeat poll backstops
 * that case, so it self-corrects within a minute even with nothing else watching
 * the working tree's content. At ~1 git status/min the heartbeat is negligible.
 */
import * as Path from 'node:path';
import * as Fs from 'node:fs';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import * as cli from './git/cli.ts';
import { checkoutPullRequest as ghCheckoutPullRequest } from './github.ts';
import { parseStatus, parseNumstat, parseLsFiles, type LineDelta, type ParsedStatus } from './git/status.ts';
import { Result } from './core/Result.ts';

// Public facade: `src/git/` is internal (cli.ts, status.ts) — the rest of the
// codebase imports git operations from here, never from `git/cli.ts` directly.
// Re-export the CLI surface (status/staging/branch/stash/commit helpers + types)
// alongside the `GitRepo` reactive layer below.
export * from './git/cli.ts';
export { Result } from './core/Result.ts';

/**
 * The outcome of a coordinated mutation: `Ok` on success, or `Err` carrying an
 * `Error` whose message is git/gh's stderr. Callers must narrow (`isOk()`/
 * `isErr()`) to read it, so the failure path can't be silently dropped.
 */
export type GitOpResult = Result<void>;

// Slow heartbeat backstop for changes no watch/`refresh()` catches — an external
// tool editing a tracked file without staging it. Long enough to be negligible
// (~1 git status/min), short enough that such edits self-correct within a minute.
const HEARTBEAT_INTERVAL_MS = 60_000;

/** Working-tree line delta vs HEAD (tracked changes, `git diff --numstat HEAD`). */
export interface GitStatus {
  added: number;
  removed: number;
}

/** Commit counts of the current branch relative to its upstream. */
export interface AheadBehind {
  ahead: number;
  behind: number;
}

/** A single file's working-tree status: untracked, or tracked-and-modified
 *  with its inserted/deleted line counts. */
export type FileGitStatus =
  | { kind: 'untracked' }
  | { kind: 'modified'; added: number; removed: number };

export interface GitRepo {
  /**
   * Current branch name, a short SHA when detached, or null outside a repo.
   * Synchronous by design (read on command-`when:` / render paths); served from
   * the cached poll state, not a live git call.
   */
  getBranch(): string | null;
  /**
   * HEAD commit OID (full SHA), or null outside a repo / on an unborn branch.
   * Moves on any HEAD change (commit, amend, reset, checkout, external push).
   * Served from the cached poll state.
   */
  getHead(): string | null;
  /**
   * Inserted/deleted line counts of the working tree vs HEAD — `git diff HEAD
   * --numstat` for tracked changes, plus untracked files counted as insertions
   * (matching the old libgit2 `SHOW_UNTRACKED_CONTENT` behaviour, which the branch
   * indicator's `+` count relies on). Null outside a repo.
   */
  getStatus(): GitStatus | null;
  /**
   * Commits the current branch is ahead/behind its upstream tracking branch.
   * Null outside a repo, on a detached HEAD, or when there is no upstream.
   */
  getAheadBehind(): AheadBehind | null;
  /** Whether the index has unmerged (conflicted) entries — a merge/rebase/etc.
   *  in progress with conflicts. False outside a repo. */
  hasConflicts(): boolean;
  /**
   * Per-file working-tree status keyed by absolute path: untracked files, and
   * tracked files with their insert/delete line counts (matching `git diff
   * HEAD`). Empty map outside a repo.
   */
  getFileStatuses(): Map<string, FileGitStatus>;
  /**
   * Absolute paths of every file tracked by git (present in the index — staged
   * or committed). Empty outside a repo.
   */
  getTrackedPaths(): Set<string>;
  /** Whether `cwd` is inside a git repository. False for a plain directory, in
   *  which case the repo is dormant (no poll/watch) and every getter above stays
   *  at its empty value — callers must not treat that emptiness as "a repo with
   *  nothing tracked". */
  isRepo(): boolean;
  /** Whether a git operation (run via `run`) is currently in flight. */
  isBusy(): boolean;

  // Coordinated mutations. Each marks the repo busy (the branch indicator spins),
  // runs the git/gh command, then refreshes and resolves to a `GitOpResult` (`Ok`
  // on success, `Err` carrying git's stderr on failure). These are the only
  // mutation entry points — the busy/refresh primitives behind them are private to
  // the implementation.
  /** `git fetch`. */
  fetch(): Promise<GitOpResult>;
  /** `git pull --ff-only`. */
  pull(): Promise<GitOpResult>;
  /** `git push`. */
  push(): Promise<GitOpResult>;
  /** Commit the message in `messageFile` (`git commit -F`); `amend` rewrites HEAD. */
  commit(messageFile: string, amend?: boolean): Promise<GitOpResult>;
  /** Stash the working-tree changes (`git stash push`). */
  stash(): Promise<GitOpResult>;
  /** Pop / apply / drop a stash by ref ("stash@{N}"). */
  stashPop(ref: string): Promise<GitOpResult>;
  stashApply(ref: string): Promise<GitOpResult>;
  stashDrop(ref: string): Promise<GitOpResult>;
  /** Switch to an existing branch (`git switch`). */
  switchBranch(name: string): Promise<GitOpResult>;
  /** Create a branch off HEAD and switch to it (`git switch -c`). */
  createBranch(name: string): Promise<GitOpResult>;
  /** Delete a branch (`git branch -d`). */
  deleteBranch(name: string): Promise<GitOpResult>;
  /** Merge a branch into the current one (`git merge`). */
  mergeBranch(name: string): Promise<GitOpResult>;
  /** Rename the current branch (`git branch -m`). */
  renameBranch(name: string): Promise<GitOpResult>;
  /** Check out a pull request's branch (`gh pr checkout`). */
  checkoutPullRequest(number: number): Promise<GitOpResult>;
  /** Subscribe to branch / working-tree / busy changes. Returns an unsubscribe fn. */
  onChange(callback: () => void): () => void;
  /** Re-check the working tree now (and fire `onChange` if it moved) — e.g. right
   *  after an agent or the editor edits files, instead of waiting up to 60s for the
   *  heartbeat poll to notice content changes. */
  refresh(): void;
  /** Stop watching and release resources. */
  dispose(): void;
}

/** Open the repository containing `cwd` (resolved lazily; non-repos are fine).
 *  Standalone (un-pooled) — callers own its `dispose`. Prefer `acquireGitRepo`
 *  for workbench roots, which shares one instance across the same repo root. */
export function openGitRepo(cwd: string): GitRepo {
  return new CliGitRepo(cwd);
}

// Ref-counted GitRepo pool keyed by repository root. Workbenches sharing a root
// (the common N agents : 1 worktree case, and every agent that stays in the main
// checkout) share one CliGitRepo instead of each running its own HEAD/index watch.
// A linked worktree has its *own* top-level, so it keys separately from the main
// checkout — exactly the per-worktree git we want.
interface RepoEntry {
  repo: GitRepo;
  count: number;
}
const repoPool = new Map<string, RepoEntry>();

/** Acquire a shared `GitRepo` for the repository containing `cwd`; cwds resolving
 *  to the same repo root return the same instance. Pair with `releaseGitRepo`. */
export function acquireGitRepo(cwd: string): GitRepo {
  // Key by repo root so different cwds in one worktree share; fall back to the
  // cwd itself when not in a repo (each non-repo dir gets its own dormant repo).
  const key = cli.repoRoot(cwd) ?? cwd;
  const existing = repoPool.get(key);
  if (existing) {
    existing.count++;
    return existing.repo;
  }
  const repo = new CliGitRepo(cwd);
  repoPool.set(key, { repo, count: 1 });
  return repo;
}

/** Release a `GitRepo` acquired via `acquireGitRepo`; disposes it when the last
 *  holder releases. A repo not in the pool (e.g. from `openGitRepo`) is disposed
 *  directly, so this is always a safe release. */
export function releaseGitRepo(repo: GitRepo): void {
  for (const [key, entry] of repoPool) {
    if (entry.repo !== repo) continue;
    if (--entry.count <= 0) {
      repoPool.delete(key);
      entry.repo.dispose();
    }
    return;
  }
  repo.dispose(); // not pooled — caller-owned
}

/** Cached snapshot the synchronous getters read from. */
interface State {
  branch: string | null;
  commit: string | null;
  status: GitStatus | null;
  ahead: AheadBehind | null;
  conflicts: boolean;
  fileStatuses: Map<string, FileGitStatus>;
  tracked: Set<string>;
}

function emptyState(): State {
  return {
    branch: null,
    commit: null,
    status: null,
    ahead: null,
    conflicts: false,
    fileStatuses: new Map(),
    tracked: new Set(),
  };
}

class CliGitRepo implements GitRepo {
  private readonly cwd: string;
  // Worktree root, or null when `cwd` is not inside a repository.
  private readonly root: string | null;
  // Absolute `.git` directory (for the HEAD monitor); resolved at construction.
  private gitDir: string | null = null;

  private state: State = emptyState();
  private lastSignature = '';

  private readonly listeners = new Set<() => void>();
  private watcher: FSWatcher | null = null;
  private pollId: NodeJS.Timeout | null = null; // 60s heartbeat backstop
  private watching = false;
  private reading = false; // a refresh's git calls are in flight — don't overlap
  private pendingPoll = false; // an event arrived mid-read — re-run once it finishes
  private busyCount = 0;
  private disposed = false; // drop async warm-up/refresh callbacks that land post-dispose
  // Untracked line-count memo, keyed by path → (mtime, size, lines). Skips re-reading
  // unchanged untracked files on every refresh (see `countNewLinesCached`).
  private readonly untrackedCache = new Map<string, { mtimeMs: number; size: number; lines: number }>();

  constructor(cwd: string) {
    this.cwd = cwd;
    this.root = cli.repoRoot(cwd);
    if (this.root) this.warmUp();
  }

  // --- synchronous reads (served from cache) ---------------------------------

  getBranch(): string | null {
    return this.state.branch;
  }
  getHead(): string | null {
    return this.state.commit;
  }
  getStatus(): GitStatus | null {
    return this.state.status;
  }
  getAheadBehind(): AheadBehind | null {
    return this.state.ahead;
  }
  hasConflicts(): boolean {
    return this.state.conflicts;
  }
  getFileStatuses(): Map<string, FileGitStatus> {
    return this.state.fileStatuses;
  }
  getTrackedPaths(): Set<string> {
    return this.state.tracked;
  }
  isRepo(): boolean {
    return this.root !== null;
  }
  isBusy(): boolean {
    return this.busyCount > 0;
  }

  // --- mutations (coordinated: busy + refresh; see `mutate`) -----------------

  fetch(): Promise<GitOpResult> {
    return this.mutate((root, done) => cli.git(root, ['fetch'], done));
  }
  pull(): Promise<GitOpResult> {
    return this.mutate((root, done) => cli.git(root, ['pull', '--ff-only'], done));
  }
  push(): Promise<GitOpResult> {
    return this.mutate((root, done) => cli.git(root, ['push'], done));
  }
  commit(messageFile: string, amend = false): Promise<GitOpResult> {
    return this.mutate((root, done) => cli.commit(root, messageFile, done, amend));
  }
  stash(): Promise<GitOpResult> {
    return this.mutate((root, done) => cli.stashPush(root, done));
  }
  stashPop(ref: string): Promise<GitOpResult> {
    return this.mutate((root, done) => cli.stashPop(root, ref, done));
  }
  stashApply(ref: string): Promise<GitOpResult> {
    return this.mutate((root, done) => cli.stashApply(root, ref, done));
  }
  stashDrop(ref: string): Promise<GitOpResult> {
    return this.mutate((root, done) => cli.stashDrop(root, ref, done));
  }
  switchBranch(name: string): Promise<GitOpResult> {
    return this.mutate((root, done) => cli.switchBranch(root, name, done));
  }
  createBranch(name: string): Promise<GitOpResult> {
    return this.mutate((root, done) => cli.createBranch(root, name, done));
  }
  deleteBranch(name: string): Promise<GitOpResult> {
    return this.mutate((root, done) => cli.deleteBranch(root, name, done));
  }
  mergeBranch(name: string): Promise<GitOpResult> {
    return this.mutate((root, done) => cli.mergeBranch(root, name, done));
  }
  renameBranch(name: string): Promise<GitOpResult> {
    return this.mutate((root, done) => cli.renameBranch(root, name, done));
  }
  checkoutPullRequest(number: number): Promise<GitOpResult> {
    // `gh pr checkout` reports (ok, stderr); adapt to the cli `GitDone` shape.
    return this.mutate((root, done) => ghCheckoutPullRequest(root, number, (ok, stderr) => done(ok, '', stderr)));
  }

  // --- subscription + lifecycle ----------------------------------------------

  onChange(callback: () => void): () => void {
    this.listeners.add(callback);
    this.ensureWatching();
    return () => this.listeners.delete(callback);
  }

  refresh(): void {
    this.requestPoll();
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    void this.watcher?.close();
    this.watcher = null;
    if (this.pollId) {
      clearInterval(this.pollId);
      this.pollId = null;
    }
  }

  // --- internals -------------------------------------------------------------

  /** Async warm-up: resolve the git dir (for the file watch) and prime the
   *  cached state, both off the UI thread, so constructing a repo never blocks.
   *  Until they land the getters return the empty state; the warm-up refresh's
   *  notify fills the UI in (subscribers are added on the same tick as the
   *  acquire, so they're registered before the async status returns). */
  private warmUp(): void {
    // Resolve the git dir and prime the cached state concurrently — neither blocks
    // the other, so the first status lands as early as it can.
    void this.resolveGitDir();
    void this.pollOnce(); // initial status/numstat/ls-files → populates state + notifies
  }

  /** Resolve the absolute git dir (for the file watch) off the UI thread. */
  private async resolveGitDir(): Promise<void> {
    const result = await runGit(this.root!, ['rev-parse', '--absolute-git-dir']);
    if (this.disposed || result.isErr()) return;
    this.gitDir = result.unwrap().trim() || null;
    if (this.watching) this.startWatch(); // subscribed before the git dir landed
  }

  private ensureWatching(): void {
    if (this.watching || !this.root) return;
    this.watching = true;
    this.startWatch(); // no-op until the async warm-up resolves the git dir

    // Slow heartbeat: backstops external working-tree edits the HEAD/index watch
    // and `refresh()` don't see. `requestPoll` coalesces with in-flight reads, and
    // `pollOnce` no-ops when the signature hasn't moved, so an idle tick is one
    // `git status`/`diff` and no repaint.
    this.pollId = setInterval(() => this.requestPoll(), HEARTBEAT_INTERVAL_MS);
    this.pollId.unref?.();
  }

  // Watch the git dir's `HEAD` + `index` (via chokidar, which handles the atomic
  // renames git does) so branch switches, commits, staging, resets, and merges
  // refresh the instant they land, rather than waiting up to 60s for the heartbeat.
  // The git dir is resolved asynchronously by the warm-up, so this is safe to call
  // before then (no-op) — the warm-up calls it once the dir lands.
  private startWatch(): void {
    if (this.disposed || this.watcher || !this.gitDir) return;
    // `HEAD`: branch/commit moves. `index`: staging, reset, merge/conflict state,
    // and external `git add`. Watching the files (not the dir) skips `index.lock`
    // churn; chokidar follows git's atomic replace of each.
    this.watcher = chokidarWatch(
      [Path.join(this.gitDir, 'HEAD'), Path.join(this.gitDir, 'index')],
      { ignoreInitial: true },
    );
    this.watcher.on('all', () => {
      this.lastSignature = ''; // HEAD/index moved — branch/ahead-behind/staging may differ
      this.requestPoll();
    });
    this.watcher.on('error', () => {}); // transient FS error — recovered by the next refresh()
  }

  /** Request a refresh, coalescing with any in-flight one. With no periodic timer,
   *  an event that lands while a read is running must not be dropped — record it
   *  and re-run once the current read finishes (see `pollOnce`'s `finally`). */
  private requestPoll(): void {
    if (this.reading) {
      this.pendingPoll = true;
      return;
    }
    void this.pollOnce();
  }

  /** Async refresh: status + numstat; on a signature change, also refresh the
   *  tracked set, swap in the new state, and notify. Never blocks the UI. The
   *  `reading` guard (cleared in `finally`) keeps overlapping polls from racing. */
  private async pollOnce(): Promise<void> {
    if (!this.root || this.reading) return;
    this.reading = true;
    try {
      const status = await runGit(this.root, STATUS_ARGS);
      if (this.disposed || status.isErr()) return; // transient failure — keep the last good state

      const numstatResult = await runGit(this.root, NUMSTAT_ARGS);
      if (this.disposed) return;
      const parsed = parseStatus(status.unwrap());
      const numstat = numstatResult.isOk() ? parseNumstat(numstatResult.unwrap()) : new Map<string, LineDelta>();
      const untrackedAdded = await this.untrackedInsertions(parsed);
      if (this.disposed) return;
      const sig = signature(parsed, numstat, untrackedAdded);
      if (sig === this.lastSignature) return; // nothing moved

      // Something changed — the tracked set may have too (add/rm/commit), so
      // refresh ls-files before rebuilding. (Plain working-tree edits don't
      // change the set, but they're cheap relative to the rebuild + repaint.)
      const lsFiles = await runGit(this.root, LSFILES_ARGS);
      if (this.disposed) return;
      // Fresh ls-files output is repo-relative (join with root); the carried-over
      // set is already absolute (`trackedAbs`, so don't re-prefix it).
      const tracked = lsFiles.isOk() ? parseLsFiles(lsFiles.unwrap()) : [...this.state.tracked];
      this.state = this.buildState(parsed, numstat, tracked, untrackedAdded, lsFiles.isErr());
      this.lastSignature = sig;
      this.notify();
    } finally {
      this.reading = false;
      // An event that arrived mid-read was deferred — service it now.
      if (this.pendingPoll && !this.disposed) {
        this.pendingPoll = false;
        this.requestPoll();
      }
    }
  }

  /** Assemble the cached snapshot from parsed git output. `untrackedAdded` is the
   *  total insertions from untracked files (folded into `status.added`, matching
   *  the old SHOW_UNTRACKED_CONTENT behaviour). `trackedAbs` is true when `tracked`
   *  is already absolute (the fallback reuse of prior state). */
  private buildState(
    parsed: ParsedStatus,
    numstat: Map<string, LineDelta>,
    tracked: string[],
    untrackedAdded: number,
    trackedAbs = false,
  ): State {
    const root = this.root!;
    const fileStatuses = new Map<string, FileGitStatus>();
    let added = untrackedAdded;
    let removed = 0;
    for (const e of parsed.entries) {
      const abs = Path.join(root, e.relPath);
      if (e.untracked) {
        // Surfaced as untracked (no per-file ±); its lines are in `untrackedAdded`.
        fileStatuses.set(abs, { kind: 'untracked' });
        continue;
      }
      const n = numstat.get(e.relPath) ?? { added: 0, removed: 0 };
      added += n.added;
      removed += n.removed;
      fileStatuses.set(abs, { kind: 'modified', added: n.added, removed: n.removed });
    }
    const trackedSet = new Set<string>();
    for (const p of tracked) trackedSet.add(trackedAbs ? p : Path.join(root, p));
    return {
      branch: parsed.branch,
      commit: parsed.commit,
      status: { added, removed },
      ahead:
        parsed.ahead != null && parsed.behind != null
          ? { ahead: parsed.ahead, behind: parsed.behind }
          : null,
      conflicts: parsed.conflicts,
      fileStatuses,
      tracked: trackedSet,
    };
  }

  /** Total insertions contributed by untracked files (counted as all-new lines,
   *  like `git diff` with SHOW_UNTRACKED_CONTENT). Read once per refresh and fed to
   *  both the change-signature and the state, so editing an untracked file still
   *  ticks the branch indicator's `+` count. Binary files and very large files
   *  count as zero. Reads are async (off the UI thread) and memoized by
   *  (path, mtime, size), so an unchanged untracked file is never re-read. */
  private async untrackedInsertions(parsed: ParsedStatus): Promise<number> {
    let total = 0;
    const live = new Set<string>();
    for (const e of parsed.entries) {
      if (!e.untracked) continue;
      const abs = Path.join(this.root!, e.relPath);
      live.add(abs);
      total += await this.countNewLinesCached(abs);
    }
    // Drop memo entries for files that are no longer untracked (staged, removed,
    // or committed) so the cache tracks the live untracked set, not all-time.
    for (const key of this.untrackedCache.keys()) {
      if (!live.has(key)) this.untrackedCache.delete(key);
    }
    return total;
  }

  /** `countNewLines` behind an (mtime, size) memo: a cache hit skips the read+scan
   *  entirely, so re-counting only happens when the file actually changed. */
  private async countNewLinesCached(abs: string): Promise<number> {
    let st: Fs.Stats;
    try {
      st = await Fs.promises.stat(abs);
    } catch {
      this.untrackedCache.delete(abs);
      return 0; // vanished between `git status` and the stat
    }
    const hit = this.untrackedCache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.lines;
    const lines = await countNewLines(abs, st);
    this.untrackedCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, lines });
    return lines;
  }

  // Coordinate a repo-mutating operation: mark busy (spinner on), run the actual
  // git/gh CLI call against the repo root, then end — clearing busy and forcing a
  // refresh (the op may have moved HEAD/refs/index even if the working-tree
  // signature is unchanged, e.g. a fetch). The single internal entry point behind
  // every public mutation method; `run`/`beginOperation` are deliberately NOT on
  // the public interface so callers can't bypass this coordination.
  private mutate(op: (root: string, done: cli.GitDone) => void): Promise<GitOpResult> {
    if (!this.root) {
      return Promise.resolve(Result.Err(new Error('not a git repository')));
    }
    // Enter the busy state *synchronously* (before awaiting), so the spinner is up
    // the moment the caller invokes the mutation.
    const end = this.begin();
    return new Promise<GitOpResult>((resolve) => {
      op(this.root!, (ok, _stdout, stderr) => {
        end();
        resolve(ok ? Result.Ok<void>(undefined) : Result.Err(new Error(stderr || 'git operation failed')));
      });
    });
  }

  /** Enter the busy state; the returned `end()` (idempotent) leaves it and refreshes. */
  private begin(): () => void {
    this.enterBusy();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.lastSignature = ''; // the op may have moved anything — force a rebuild
      this.requestPoll();
      this.leaveBusy();
    };
  }

  // Busy is reference-counted so overlapping operations stay busy until the last
  // one finishes; listeners fire on the 0↔1 transitions (spinner on/off).
  private enterBusy(): void {
    if (this.busyCount++ === 0) this.notify();
  }
  private leaveBusy(): void {
    if (--this.busyCount === 0) this.notify();
  }
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Promise-returning bridge over the callback-based `cli.git`: resolves to `Ok`
 *  with stdout on success, or `Err` carrying stderr on a non-zero exit. Never
 *  rejects — the failure is in the `Result`, so callers branch instead of catch. */
function runGit(cwd: string, args: string[]): Promise<Result<string>> {
  return new Promise((resolve) => {
    cli.git(cwd, args, (ok, stdout, stderr) =>
      resolve(ok ? Result.Ok(stdout) : Result.Err(new Error(stderr || 'git failed'))),
    );
  });
}

// `--untracked-files=all` lists individual untracked files (matching the old
// RECURSE_UNTRACKED_DIRS behaviour) so FileTree marks each one.
const STATUS_ARGS = ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'];
const NUMSTAT_ARGS = ['diff', '--numstat', '-z', 'HEAD'];
const LSFILES_ARGS = ['ls-files', '-z'];

/** Change-detection key: branch + HEAD commit + ahead/behind + conflicts + per-file
 *  staged/unstaged/untracked state + tracked line totals + untracked insertions.
 *  Moves on edits (tracked numstat or untracked line counts), staging, branch/
 *  upstream changes, and any HEAD move — commit/amend/reset/external push (the
 *  commit + ahead/behind parts let listeners catch a push made outside the editor).
 *  (The staging part fixes the old libgit2 gap where an external `git add` didn't
 *  refresh.) */
function signature(parsed: ParsedStatus, numstat: Map<string, LineDelta>, untrackedAdded: number): string {
  let added = 0;
  let removed = 0;
  for (const e of parsed.entries) {
    if (e.untracked) continue;
    const n = numstat.get(e.relPath);
    if (n) {
      added += n.added;
      removed += n.removed;
    }
  }
  const files = parsed.entries
    .map((e) => `${e.relPath}:${e.staged ? 'S' : ''}${e.unstaged ? 'U' : ''}${e.untracked ? '?' : ''}${e.conflicted ? '!' : ''}`)
    .sort()
    .join(',');
  return [parsed.branch, parsed.commit, parsed.ahead, parsed.behind, parsed.conflicts, added, removed, untrackedAdded, files].join('|');
}

// Cap per-file untracked reads so a huge new file can't stall a refresh; larger
// files (and binaries) contribute 0 — git would treat binaries as 0 lines too.
const UNTRACKED_MAX_BYTES = 10 * 1024 * 1024;

/** Count an untracked file's lines (insertions), matching `git diff`: a final
 *  line without a trailing newline still counts; binary files count as 0. Async
 *  (off the UI thread); the caller passes the `stat` it already took. */
async function countNewLines(abs: string, st: Fs.Stats): Promise<number> {
  try {
    if (!st.isFile() || st.size === 0 || st.size > UNTRACKED_MAX_BYTES) return 0;
    const buf = await Fs.promises.readFile(abs);
    const scan = Math.min(buf.length, 8000);
    for (let i = 0; i < scan; i++) if (buf[i] === 0) return 0; // NUL → binary
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    if (buf[buf.length - 1] !== 10) n++; // last line lacks a trailing newline
    return n;
  } catch {
    return 0;
  }
}
