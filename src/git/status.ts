/*
 * status.ts — pure parsers for the git CLI's machine-readable output, used by
 * the CLI-backed `GitRepo` (../git.ts). No I/O and no node-gtk: everything here
 * is string → data, so it is exhaustively unit-testable (see status.test.ts).
 *
 * `git status --porcelain=v2 --branch -z` is git's own stable machine format and
 * gives, in ONE call: the branch, ahead/behind vs upstream, conflict state, and
 * every changed path with its staged (X) / unstaged (Y) state. Per-line ± counts
 * come from `git diff --numstat -z HEAD`; the tracked set from `git ls-files -z`.
 */

/** One changed path from porcelain v2, with where the change lives. */
export interface StatusEntry {
  /** Repo-relative path (for renames, the new path). */
  relPath: string;
  /** Index differs from HEAD (the X column). */
  staged: boolean;
  /** Worktree differs from the index (the Y column). */
  unstaged: boolean;
  /** Untracked (`?`) — not in the index at all. */
  untracked: boolean;
  /** Unmerged (`u`) — a conflict. */
  conflicted: boolean;
}

export interface ParsedStatus {
  /** Branch name, a short SHA when detached, or null when there's no branch info. */
  branch: string | null;
  /** HEAD commit OID, or null on an unborn branch (no commits yet). */
  commit: string | null;
  /** Commits ahead of upstream, or null when there is no upstream. */
  ahead: number | null;
  /** Commits behind upstream, or null when there is no upstream. */
  behind: number | null;
  /** Any unmerged (conflicted) entries present. */
  conflicts: boolean;
  entries: StatusEntry[];
}

const H_HEAD = '# branch.head ';
const H_OID = '# branch.oid ';
const H_AB = '# branch.ab ';

/** Parse `git status --porcelain=v2 --branch -z` (NUL-separated records). */
export function parseStatus(out: string): ParsedStatus {
  let head: string | null = null;
  let oid: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let conflicts = false;
  const entries: StatusEntry[] = [];

  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;

    if (tok[0] === '#') {
      if (tok.startsWith(H_HEAD)) head = tok.slice(H_HEAD.length);
      else if (tok.startsWith(H_OID)) oid = tok.slice(H_OID.length);
      else if (tok.startsWith(H_AB)) {
        const m = tok.slice(H_AB.length).match(/^\+(-?\d+)\s+-(-?\d+)$/);
        if (m) {
          ahead = parseInt(m[1], 10);
          behind = parseInt(m[2], 10);
        }
      }
      continue;
    }

    const kind = tok[0];
    if (kind === '?') {
      // "? <path>"
      entries.push(entry(tok.slice(2), false, true, true, false));
    } else if (kind === '1') {
      // "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
      const f = tok.split(' ');
      const xy = f[1] ?? '..';
      entries.push(entry(f.slice(8).join(' '), xy[0] !== '.', xy[1] !== '.', false, false));
    } else if (kind === '2') {
      // "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\0<origPath>"
      const f = tok.split(' ');
      const xy = f[1] ?? '..';
      entries.push(entry(f.slice(9).join(' '), xy[0] !== '.', xy[1] !== '.', false, false));
      i++; // the next token is the rename's original path — consume it
    } else if (kind === 'u') {
      // "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
      conflicts = true;
      const f = tok.split(' ');
      entries.push(entry(f.slice(10).join(' '), true, true, false, true));
    }
    // '!' (ignored) and anything else: skip.
  }

  // branch.head is the literal "(detached)" when detached; branch.oid is
  // "(initial)" on an unborn branch (no commits yet). Match libgit2's shorthand:
  // the branch name normally, a short SHA when detached.
  const branch =
    head == null
      ? null
      : head === '(detached)'
        ? oid && oid !== '(initial)'
          ? oid.slice(0, 7)
          : null
        : head;

  const commit = oid && oid !== '(initial)' ? oid : null;
  return { branch, commit, ahead, behind, conflicts, entries };
}

function entry(
  relPath: string,
  staged: boolean,
  unstaged: boolean,
  untracked: boolean,
  conflicted: boolean,
): StatusEntry {
  return { relPath, staged, unstaged, untracked, conflicted };
}

/** Per-path inserted/deleted line counts. */
export interface LineDelta {
  added: number;
  removed: number;
}

/** Parse `git diff --numstat -z HEAD` → relPath → {added, removed}.
 *  Binary files (`-\t-`) count as zero; renames carry old\0new path tokens. */
export function parseNumstat(out: string): Map<string, LineDelta> {
  const map = new Map<string, LineDelta>();
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const t1 = tok.indexOf('\t');
    if (t1 < 0) continue;
    const t2 = tok.indexOf('\t', t1 + 1);
    if (t2 < 0) continue;
    const addedS = tok.slice(0, t1);
    const removedS = tok.slice(t1 + 1, t2);
    let path = tok.slice(t2 + 1);
    if (path === '') {
      // rename under -z: "<a>\t<r>\t" then the old and new paths as two tokens.
      i++; // old path
      path = tokens[++i] ?? '';
    }
    if (!path) continue;
    const added = addedS === '-' ? 0 : parseInt(addedS, 10) || 0;
    const removed = removedS === '-' ? 0 : parseInt(removedS, 10) || 0;
    map.set(path, { added, removed });
  }
  return map;
}

/** Parse `git ls-files -z` → repo-relative tracked paths. */
export function parseLsFiles(out: string): string[] {
  return out.split('\0').filter(Boolean);
}

/** A path changed between two trees (commit/range diff), with its status. */
export interface ChangedFile {
  /** Single-letter status: A(dded) M(odified) D(eleted) R(enamed) C(opied) T(ype) U(nmerged). */
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';
  /** Repo-relative path (the new path for renames/copies). */
  relPath: string;
  /** The original path for renames/copies (absent otherwise). */
  oldRelPath?: string;
}

/** Parse `git diff --name-status -z` (and `git diff-tree … --name-status -z`).
 *  Records are NUL-separated: `<status>\0<path>` normally, and
 *  `R<score>\0<old>\0<new>` / `C<score>\0<old>\0<new>` for renames/copies. */
export function parseNameStatusZ(out: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const status = tok[0] as ChangedFile['status'];
    // R/C carry a similarity score and two following path tokens (old, new).
    if (status === 'R' || status === 'C') {
      const oldRelPath = tokens[++i] ?? '';
      const relPath = tokens[++i] ?? '';
      if (relPath) files.push({ status, relPath, oldRelPath });
    } else {
      const relPath = tokens[++i] ?? '';
      if (relPath) files.push({ status, relPath });
    }
  }
  return files;
}

/** One commit summary for pickers / log views. */
export interface CommitSummary {
  /** Full commit OID. */
  sha: string;
  /** Abbreviated OID (as git chose it). */
  shortSha: string;
  /** First line of the commit message. */
  subject: string;
  /** Author name. */
  author: string;
  /** Author date, as formatted by `git log --date` (we ask for relative). */
  date: string;
  /** Author date as a UNIX timestamp (seconds), for absolute/friendly formatting. */
  timestamp: number;
}

const LOG_FIELD_SEP = '\x1f'; // ASCII unit separator — never appears in commit fields we read

/** The format string to pass to `git log --format=` so `parseCommitLog` can read it. */
export const COMMIT_LOG_FORMAT = ['%H', '%h', '%s', '%an', '%ad', '%at'].join(LOG_FIELD_SEP);

/** Parse `git log --format=COMMIT_LOG_FORMAT` (one unit-separated record per line). */
export function parseCommitLog(out: string): CommitSummary[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', shortSha = '', subject = '', author = '', date = '', at = ''] = line.split(LOG_FIELD_SEP);
      return { sha, shortSha, subject, author, date, timestamp: Number(at) || 0 };
    });
}

// --- commit → changed files (for the log viewer's `file:` filter) -------------
// A record per commit: an ASCII record separator (RS, 0x1e) then the full sha,
// then `--name-only` lists the changed paths one per line. Records are read in one
// `git log` pass so the filter can match against files without a call per commit.

/** RS-prefixed format begins each `git log --name-only` record (see `parseCommitFiles`). */
export const COMMIT_FILES_FORMAT = '\x1e%H';

/** Parse `git log --name-only --format=COMMIT_FILES_FORMAT` into sha → changed paths.
 *  Merge commits list no files (no `-m`), so they map to an empty array. */
export function parseCommitFiles(out: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const record of out.split('\x1e')) {
    if (!record.trim()) continue;
    const [sha = '', ...rest] = record.split('\n');
    const oid = sha.trim();
    if (oid) map.set(oid, rest.map((l) => l.trim()).filter(Boolean));
  }
  return map;
}
