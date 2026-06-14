/*
 * Git integration, isolated behind a small abstraction.
 *
 * The implementation uses Ggit (libgit2 via GObject introspection) — in-process,
 * synchronous, no subprocess. (We started with simple-git, but node's
 * child_process is starved while node-gtk's GLib main loop runs, so its promises
 * never settled; Gio-native / in-process APIs are required here.) Callers only
 * ever see the `GitRepo` interface, so the backend can still be swapped.
 *
 * `onChange` watches the repo's `HEAD` file (via a Gio file monitor) so a branch
 * switch / checkout pushes an update rather than the UI having to poll.
 */
import { Gio, Ggit } from './gi.ts';

type FileMonitor = InstanceType<typeof Gio.FileMonitor>;
type GioFile = ReturnType<typeof Gio.File.newForPath>;

// node-gtk quirk: Gio.File instance methods are undefined on the concrete
// wrapper (and on GFiles handed back from Ggit), so we reach them through the
// interface prototype. Same workaround as FileTree.
const FileProto = (Gio.File as any).prototype;

export interface GitRepo {
  /**
   * Current branch name, a short SHA when detached, or null outside a repo.
   *
   * Synchronous by design: node's async primitives (promises, child_process)
   * are starved while node-gtk's GLib main loop is running, so a Promise-based
   * API would never settle on screen. A backend swapped in later must likewise
   * resolve synchronously (e.g. libgit2) or via GLib-native async, not node I/O.
   */
  getBranch(): string | null;
  /** Subscribe to ref changes (checkout/branch switch). Returns an unsubscribe fn. */
  onChange(callback: () => void): () => void;
  /** Stop watching and release resources. */
  dispose(): void;
}

let initialized = false;
function ensureGgitInit(): void {
  if (initialized) return;
  Ggit.init(); // ref-counted libgit2 init; safe to pair with later shutdowns
  initialized = true;
}

/** Open the repository containing `cwd` (resolved lazily; non-repos are fine). */
export function openGitRepo(cwd: string): GitRepo {
  return new GgitRepo(cwd);
}

class GgitRepo implements GitRepo {
  // The repo's `.git` location, used both to (re)open for fresh reads and to
  // monitor HEAD. Null when `cwd` is not inside a git repository.
  private readonly gitDir: GioFile | null;
  private readonly listeners = new Set<() => void>();
  private monitor: FileMonitor | null = null;

  constructor(cwd: string) {
    ensureGgitInit();
    this.gitDir = discoverGitDir(cwd);
  }

  getBranch(): string | null {
    if (!this.gitDir) return null;
    try {
      // Open fresh each read: libgit2 caches the ref db, so reusing a Repository
      // could miss an external checkout that just rewrote HEAD.
      const repo = Ggit.Repository.open(this.gitDir);
      const head = repo?.getHead();
      return head?.getShorthand() ?? null;
    } catch {
      // Unborn branch (empty repo), unreadable HEAD, etc.
      return null;
    }
  }

  onChange(callback: () => void): () => void {
    this.listeners.add(callback);
    this.ensureMonitor();
    return () => this.listeners.delete(callback);
  }

  dispose(): void {
    this.listeners.clear();
    this.monitor?.cancel();
    this.monitor = null;
  }

  // Watch `<git-dir>/HEAD`; it is rewritten on checkout, which is exactly when
  // the branch label needs to refresh.
  private ensureMonitor(): void {
    const gitDir = this.gitDir;
    if (this.monitor || !gitDir) return;
    const head = FileProto.getChild.call(gitDir, 'HEAD');
    this.monitor = FileProto.monitorFile.call(head, Gio.FileMonitorFlags.WATCH_MOVES, null);
    this.monitor!.on('changed', () => this.emit());
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The `.git` location for `cwd`, or null when it is not inside a repository. */
function discoverGitDir(cwd: string): GioFile | null {
  try {
    return Ggit.Repository.discover(Gio.File.newForPath(cwd));
  } catch {
    return null;
  }
}
