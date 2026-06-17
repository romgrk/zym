/*
 * agentSessions — enumerate resumable past `claude` conversations for a project.
 *
 * Claude Code stores each session as a JSONL transcript at
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where the directory name
 * is the cwd with every non-alphanumeric character replaced by `-` (one dash per
 * char — so `/`, `.` and `_` all map to `-`). We read that directory to list
 * sessions; the editor resumes one with `claude --resume <id>` (see AgentTerminal).
 *
 * The transcript format is Claude Code's internal one (subject to change), so all
 * parsing is isolated here: the filename is the session id, the file mtime is the
 * last activity, and the label is the best available name, in order:
 *   1. the `/rename` custom title (`custom-title` lines in the transcript);
 *   2. the terminal title (the terminal-title skill's, kept per id under
 *      `~/.claude/terminal_titles/`);
 *   3. Claude's auto-generated title (`ai-title` lines);
 *   4. the first `type:"user"` message.
 * The `*-title` transcript lines are re-emitted on nearly every snapshot, so the
 * file's tail reliably holds the latest values without reading it in full.
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';

export interface AgentSession {
  /** The claude session id (the transcript filename, sans `.jsonl`). */
  id: string;
  /** A human label: the `/rename` title, else the terminal title, else Claude's
   *  auto title, else the first user message. */
  label: string;
  /** Whether `label` is a real title (any of the three) rather than the
   *  first-message fallback — lets the picker de-emphasise untitled sessions. */
  titled: boolean;
  /** The cwd Claude ran in for this session (read from the transcript) — where
   *  `--resume` must be spawned and where a resumed agent's workbench should be
   *  rooted, so its branch/worktree is restored. Null when the transcript records
   *  none (then the caller falls back to the project cwd). */
  cwd: string | null;
  /** A worktree the agent moved into *dynamically* mid-session (announced via the
   *  set_worktree bridge tool), recorded by quilx as a sidecar — distinct from
   *  `cwd` (Claude's launch dir, where `--resume` must run). When it differs from
   *  `cwd`, resume nudges the agent to `cd` back here. Null when it never moved. */
  effectiveCwd: string | null;
  /** Last-activity time (the transcript's mtime), epoch ms. */
  modified: number;
}

// Only the head of a transcript is read for the label; the first user message is
// effectively always within this. Large transcripts aren't read in full.
const HEAD_BYTES = 64 * 1024;

// Where Claude Code persists each session's terminal title (one file per session
// id, contents being the title string, e.g. "quilx | Plan: Agents"). This is the
// terminal-title skill's title, distinct from the in-transcript `/rename` title.
const TITLES_DIR = Path.join(Os.homedir(), '.claude', 'terminal_titles');

/** Claude Code's transcript directory for `cwd`. Claude encodes the cwd into the
 *  dir name by replacing every non-alphanumeric character with `-`, one dash per
 *  char — so a worktree at `…/quilx/.claude/worktrees/x` becomes
 *  `-…-quilx--claude-worktrees-x` (note the `/.` → `--`). */
export function transcriptDir(cwd: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return Path.join(Os.homedir(), '.claude', 'projects', encoded);
}

/** Resumable sessions for `cwd`, most-recently-active first. */
export function listAgentSessions(cwd: string): AgentSession[] {
  const dir = transcriptDir(cwd);
  let entries: string[];
  try {
    entries = Fs.readdirSync(dir);
  } catch {
    return []; // no transcripts for this project
  }

  const project = Path.basename(cwd);
  const sessions: AgentSession[] = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const file = Path.join(dir, name);
    let stat: Fs.Stats;
    try {
      stat = Fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0) continue;
    const id = name.slice(0, -'.jsonl'.length);
    sessions.push({
      id,
      ...resolveLabel(file, id, project, stat.size),
      cwd: readSessionCwd(file),
      effectiveCwd: readWorktreeSidecar(dir, id),
      modified: stat.mtimeMs,
    });
  }
  sessions.sort((a, b) => b.modified - a.modified);
  return sessions;
}

/** Resumable sessions across several project roots (e.g. the repo's worktrees),
 *  most-recently-active first, deduped by id. Each transcript lives under the cwd
 *  Claude was launched in, so a worktree-launched conversation only appears when
 *  its worktree is among `roots` — hence the picker passes every worktree. */
export function listResumableSessions(roots: string[]): AgentSession[] {
  const byId = new Map<string, AgentSession>();
  for (const root of roots) {
    for (const session of listAgentSessions(root)) {
      const existing = byId.get(session.id);
      if (!existing || session.modified > existing.modified) byId.set(session.id, session);
    }
  }
  return [...byId.values()].sort((a, b) => b.modified - a.modified);
}

// Sidecar (next to the transcript) recording a worktree the agent moved into
// dynamically — Claude's own cwd doesn't change on a Bash-tool `cd`, so the
// transcript can't tell us; quilx writes it on the set_worktree announce.
function worktreeSidecar(dir: string, id: string): string {
  return Path.join(dir, `${id}.quilx-worktree`);
}

/** Record (or clear) the worktree an agent dynamically moved into, as a sidecar
 *  next to its transcript under `launchCwd`'s project dir, so a later resume can
 *  send it back. Pass `effectiveCwd === launchCwd` to clear (it's back home). */
export function recordSessionWorktree(launchCwd: string, sessionId: string, effectiveCwd: string): void {
  const file = worktreeSidecar(transcriptDir(launchCwd), sessionId);
  try {
    if (effectiveCwd === launchCwd) {
      Fs.rmSync(file, { force: true });
      return;
    }
    Fs.mkdirSync(transcriptDir(launchCwd), { recursive: true });
    Fs.writeFileSync(file, effectiveCwd);
  } catch {
    /* best effort — resume just won't restore the dynamic worktree */
  }
}

/** The worktree sidecar for a session (the dynamically-entered worktree), or null. */
function readWorktreeSidecar(dir: string, id: string): string | null {
  try {
    return Fs.readFileSync(worktreeSidecar(dir, id), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** The cwd Claude recorded for a session: the first transcript entry that carries
 *  a `cwd` (the launch dir). This is where `--resume` resolves the session and
 *  where the resumed agent's workbench should root. Null if none is found. */
function readSessionCwd(file: string): string | null {
  let fd: number;
  try {
    fd = Fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = Fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    const text = buffer.toString('utf8', 0, read);
    for (const line of text.split('\n')) {
      if (!line.includes('"cwd"')) continue; // cheap pre-filter before JSON.parse
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a final partial line, or noise
      }
      if (typeof entry?.cwd === 'string' && entry.cwd) return entry.cwd;
    }
  } finally {
    Fs.closeSync(fd);
  }
  return null;
}

/** Pick the best label for a session (see the priority in the file header), and
 *  whether it's a real title or the first-message fallback. */
function resolveLabel(
  file: string,
  id: string,
  project: string,
  size: number,
): { label: string; titled: boolean } {
  const titles = readTitlesFromTail(file, size);
  const title =
    titles.customTitle ?? // `/rename`
    sessionTitle(id, project) ?? // terminal-title skill
    titles.aiTitle; // Claude's auto title
  if (title) return { label: title, titled: true };
  return { label: firstUserMessage(file) ?? '(no prompt)', titled: false };
}

/**
 * The latest `/rename` (`customTitle`) and auto (`aiTitle`) titles from a
 * transcript. These lines are re-emitted on nearly every snapshot, so scanning
 * the file's tail finds the current values; the last occurrence of each wins.
 */
function readTitlesFromTail(file: string, size: number): { customTitle?: string; aiTitle?: string } {
  let fd: number;
  try {
    fd = Fs.openSync(file, 'r');
  } catch {
    return {};
  }
  try {
    const start = Math.max(0, size - HEAD_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const read = Fs.readSync(fd, buffer, 0, length, start);
    const text = buffer.toString('utf8', 0, read);
    let customTitle: string | undefined;
    let aiTitle: string | undefined;
    for (const line of text.split('\n')) {
      if (!line.includes('-title"')) continue; // cheap pre-filter before JSON.parse
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // partial leading line (the tail starts mid-record), or noise
      }
      if (entry?.type === 'custom-title' && typeof entry.customTitle === 'string') {
        customTitle = entry.customTitle.trim() || customTitle;
      } else if (entry?.type === 'ai-title' && typeof entry.aiTitle === 'string') {
        aiTitle = entry.aiTitle.trim() || aiTitle;
      }
    }
    return { customTitle, aiTitle };
  } finally {
    Fs.closeSync(fd);
  }
}

/**
 * The session's terminal title (its `/rename` name or skill-set title), or null
 * if it has none. The terminal-title skill prefixes titles with the project name
 * (`<project> | …`); that prefix is dropped since the resume picker is already
 * scoped to this project.
 */
function sessionTitle(id: string, project: string): string | null {
  let raw: string;
  try {
    raw = Fs.readFileSync(Path.join(TITLES_DIR, id), 'utf8').trim();
  } catch {
    return null; // no title recorded for this session
  }
  if (!raw) return null;
  const prefix = `${project} | `;
  const title = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw;
  return title || null;
}

/** The first user message in a transcript, single-lined; null if none found. */
function firstUserMessage(file: string): string | null {
  let fd: number;
  try {
    fd = Fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = Fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    const text = buffer.toString('utf8', 0, read);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a final partial line (truncated by the head read), or noise
      }
      if (entry?.type !== 'user') continue;
      const content = entry.message?.content ?? entry.content;
      const textValue =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.find((block: any) => block?.type === 'text')?.text
            : null;
      if (textValue) return singleLine(textValue);
    }
  } finally {
    Fs.closeSync(fd);
  }
  return null;
}

/** Collapse whitespace/newlines into a single trimmed line. */
function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A compact "time ago" for a past timestamp (epoch ms): 12s / 5m / 3h / 2d / 4w. */
export function relativeTime(epochMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  const units: [number, string][] = [
    [604800, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm'], [1, 's'],
  ];
  for (const [size, suffix] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${suffix} ago`;
  }
  return 'just now';
}
