/*
 * SessionManager — persists and restores the working state of a project root.
 *
 * Exposed as `zym.session`. A *session* is everything that makes up "where I
 * was": the split layout, the open files/terminals/agents, cursors, and file-tree
 * expansion — as opposed to `zym.config`, which is global app settings. See
 * docs/session-management.md for the full design.
 *
 * This module is the storage + format spine. It is deliberately free of any GTK
 * import so it can be unit-tested under `node --test`; the widget walk that
 * produces a `SessionState` and the deserializers that rebuild widgets live in the
 * UI layer (AppWindow), which registers them here.
 *
 * Storage: one JSON file per session under the XDG state dir
 * (`$XDG_STATE_HOME/zym/sessions/`, falling back to `~/.local/state`). Sessions
 * are **named-only** — the file name is a slug of the name, and `save()` refuses
 * an unnamed state (the ephemeral default session never persists). `label()`
 * resolves a display string as `name ?? basename(primaryRoot)`, the fallback
 * covering legacy per-root files from the old autosave model (still readable via
 * `load(root)` / listed for migration). Writes are atomic (temp + rename), and
 * reads never throw: a missing/corrupt/old-version file yields `null`, mirroring
 * the config loader's "warn and skip" posture.
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { createHash } from 'node:crypto';
import { Disposable } from './util/eventKit.ts';
import type { Action } from './actions.ts';

/** Current on-disk format version. Bumped only on an incompatible change. (v2: nested
 *  `projects[]` — was a flat `workspaces[]`; older files fall to "warn and ignore".) */
export const SESSION_VERSION = 2;

// --- State shapes (see docs/session-management.md) --------------------------

/** One tab's restorable state — a discriminated union over the tab kinds. */
export type TabState =
  | { kind: 'file'; path: string; cursor?: [number, number]; scroll?: number; dirty?: boolean }
  | { kind: 'terminal'; cwd: string }
  | { kind: 'agent'; command: string[]; cwd: string; prompt?: string; sessionId?: string; agentKind?: 'claude-tui' | 'claude-sdk' };

/** The split tree of one workbench: `leaf` tab strips joined by `split` panes. */
export type PanelNode =
  | { type: 'leaf'; tabs: TabState[]; activeIndex: number; active?: boolean }
  | {
      type: 'split';
      orientation: 'horizontal' | 'vertical';
      position: number;
      start: PanelNode;
      end: PanelNode;
    };

/** The `agent` variant of TabState — an agent workbench's relaunch identity. */
export type AgentTabState = Extract<TabState, { kind: 'agent' }>;

/**
 * A workbench's restorable content — the split layout, file-tree expansion, and the
 * runnable action set (docs/workbench.md). Shared by a project's default workbench and
 * by each of its agents. `actions` is omitted when empty.
 */
export interface WorkbenchState {
  layout: PanelNode;
  fileTree?: { expanded: string[] };
  actions?: Action[];
}

/** An agent workbench's restore record: where it roots (its worktree), its content,
 *  and its relaunch identity (resumed to its conversation on restore). */
export interface AgentState {
  root: string;
  workbench: WorkbenchState;
  agent: AgentTabState;
}

/** One open project: its root, its default ("you") workbench, and the agents launched
 *  under it. A window switches its active owner (a project default or an agent) from
 *  the rail — see docs/session-management.md "Multi-root". */
export interface ProjectState {
  root: string;
  workbench: WorkbenchState;
  agents: AgentState[];
}

export interface SessionState {
  version: number;
  /** Persisted iff named; absent only on legacy no-name files. */
  name?: string;
  /** ISO timestamp, stamped by `save`. */
  savedAt: string;
  /** The open projects; `projects[0]` is the primary (label source). At least one. */
  projects: ProjectState[];
  /** The focused owner: a project index, plus an agent index within it when one of the
   *  project's agent workbenches is active (absent → the project's default workbench). */
  active: { project: number; agent?: number };
  /** Window-level, shared across workspaces. `visible` is the per-side dock-
   *  visibility toggle (left/right/top/bottom); absent in pre-existing sessions,
   *  treated as all-shown on restore. `sizes` holds each side's resized extent
   *  (width for left/right, height for top/bottom), so a dragged Gtk.Paned handle
   *  is restored; absent sides fall back to their default size. */
  docks?: {
    notificationLog: boolean;
    visible?: { left: boolean; right: boolean; top: boolean; bottom: boolean };
    sizes?: { left?: number; right?: number; top?: number; bottom?: number };
  };
  /** Window geometry, restored with the session. */
  window?: { width: number; height: number; maximized: boolean };
}

/**
 * A fresh, unnamed session: one empty project rooted at `root`, no agents, no open
 * tabs, default docks/geometry. `session:close` applies this to reset the window to a
 * clean slate; being unnamed (no `name`), applying it drops the window back to the
 * ephemeral default session. `root` is the launch dir (`process.cwd()`) — the one
 * legitimate use of cwd is seeding a fresh default project/session.
 */
export function emptySessionState(root: string): SessionState {
  return {
    version: SESSION_VERSION,
    savedAt: '',
    projects: [{ root, workbench: { layout: { type: 'leaf', tabs: [], activeIndex: 0, active: true } }, agents: [] }],
    active: { project: 0 },
  };
}

/** The owner recorded in a session's cross-instance lock file (see `SessionManager`
 *  "Cross-instance lock"). `host` guards against PID collisions across machines
 *  sharing the state dir; `since` is when the lock was taken (for display/debug). */
export interface SessionLock {
  pid: number;
  host: string;
  since: string;
}

// --- Serialization seams -----------------------------------------------------

/** A widget that can persist itself into session state (`null` = "skip me"). */
export interface Serializable<T = unknown> {
  serialize(): T | null;
}

/**
 * A widget that holds at-risk data and wants a say in the exit prompt. Reported
 * via the modified-status hook; consulted by AppWindow's close path.
 */
export interface SessionParticipant {
  /** True when the widget holds unsaved / live work. */
  isModified(): boolean;
  /** A short label for the exit prompt, e.g. "foo.ts (unsaved)". */
  getModifiedLabel?(): string;
  /** Flush the work, if it can be flushed (editors); absent for e.g. agents. */
  saveModified?(): void | Promise<void>;
}

/** Rebuilds a widget from its serialized tab state. Returns `null` to skip. */
export type Deserializer = (state: TabState) => unknown | null;

export class SessionManager {
  private readonly stateDir: string;
  private readonly deserializers = new Map<string, Deserializer>();
  private readonly participants = new Set<SessionParticipant>();

  /**
   * @param stateDir override for the XDG state base (tests pass a temp dir);
   *   defaults to `$XDG_STATE_HOME` or `~/.local/state`.
   */
  constructor(stateDir?: string) {
    const base = stateDir ?? process.env.XDG_STATE_HOME ?? Path.join(Os.homedir(), '.local', 'state');
    this.stateDir = Path.join(base, 'zym', 'sessions');
  }

  // --- Deserializer registry -------------------------------------------------

  /**
   * Register a builder for a tab `kind` (e.g. `file`, `terminal`, `agent`).
   * AppWindow registers one per kind that knows how to construct and wire the
   * widget. Returns a Disposable that unregisters it.
   */
  registerDeserializer(kind: string, build: Deserializer): Disposable {
    this.deserializers.set(kind, build);
    return new Disposable(() => {
      if (this.deserializers.get(kind) === build) this.deserializers.delete(kind);
    });
  }

  /** Rebuild a widget from one tab state, or `null` if no deserializer/skip. */
  deserialize(state: TabState): unknown | null {
    const build = this.deserializers.get(state.kind);
    return build ? build(state) : null;
  }

  // --- Modified-status registry ----------------------------------------------

  /**
   * Register a participant whose modified state should be consulted before exit
   * (an editor with unsaved edits, a running agent…). Returns a Disposable that
   * deregisters it — the host disposes it when the widget's tab closes.
   */
  registerParticipant(participant: SessionParticipant): Disposable {
    this.participants.add(participant);
    return new Disposable(() => {
      this.participants.delete(participant);
    });
  }

  /** The registered participants that currently report unsaved/live work. */
  collectModified(): SessionParticipant[] {
    return [...this.participants].filter((p) => p.isModified());
  }

  // --- Paths & identity ------------------------------------------------------

  /** The directory holding all session files. */
  sessionsDir(): string {
    return this.stateDir;
  }

  /** The primary root of a session — the hash/label source. */
  primaryRoot(state: SessionState): string {
    return state.projects[0]?.root ?? '';
  }

  /** A short, stable, filesystem-safe hash of a root path. */
  hashRoot(root: string): string {
    return createHash('sha1').update(root).digest('hex').slice(0, 16);
  }

  /** The basename used as the default (no-name) display label. */
  private basename(root: string): string {
    return Path.basename(root) || root;
  }

  /** A filesystem-safe slug of a user-given name; empty → `null`. */
  private slug(name: string): string | null {
    const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s.length > 0 ? s : null;
  }

  /** The on-disk file name for a session: name-slug if named, else root hash. */
  private fileName(name: string | undefined, primaryRoot: string): string {
    const named = name ? this.slug(name) : null;
    return `${named ?? this.hashRoot(primaryRoot)}.json`;
  }

  /** Absolute path of the file backing `state`. */
  pathFor(state: SessionState): string {
    return Path.join(this.stateDir, this.fileName(state.name, this.primaryRoot(state)));
  }

  // --- Unsaved-buffer cache --------------------------------------------------
  //
  // A per-session directory beside the json (<file>.buffers/<sha1(path)>) holding
  // the *unsaved* contents of modified editors, so a restore can bring back edits
  // that were never written to disk. Keyed by sha1 of the absolute path.

  private bufferDir(state: SessionState): string {
    return this.pathFor(state).replace(/\.json$/, '.buffers');
  }
  private bufferName(path: string): string {
    return createHash('sha1').update(path).digest('hex');
  }

  /** Persist the unsaved contents of `entries`; drops any cached buffer whose path
   *  isn't listed (no longer modified). Best-effort; never throws. */
  writeBuffers(state: SessionState, entries: { path: string; text: string }[]): void {
    const dir = this.bufferDir(state);
    try {
      if (entries.length === 0) {
        Fs.rmSync(dir, { recursive: true, force: true });
        return;
      }
      Fs.mkdirSync(dir, { recursive: true });
      const keep = new Set(entries.map((e) => this.bufferName(e.path)));
      for (const name of Fs.readdirSync(dir)) if (!keep.has(name)) Fs.rmSync(Path.join(dir, name), { force: true });
      for (const e of entries) Fs.writeFileSync(Path.join(dir, this.bufferName(e.path)), e.text);
    } catch {
      /* best effort */
    }
  }

  /** The cached unsaved content for `path` in `state`'s session, or null. */
  readBuffer(state: SessionState, path: string): string | null {
    try {
      return Fs.readFileSync(Path.join(this.bufferDir(state), this.bufferName(path)), 'utf8');
    } catch {
      return null;
    }
  }

  // --- Cross-instance lock ---------------------------------------------------
  //
  // A named session open in one window autosaves to its json; if a second window
  // opens the same name, both autosave and clobber each other. A best-effort lock
  // file beside the json (`<slug(name)>.lock`) records the owning process so
  // `session:open` can warn before entering a session another live instance holds.
  // Liveness is a PID check on the same host — a crashed owner leaves a stale lock,
  // treated as free. This is a UX guard, not a hard mutex (a TOCTOU race between two
  // simultaneous opens is possible); see docs/session-management.md.

  private lockPathForName(name: string): string {
    const slug = this.slug(name);
    return Path.join(this.stateDir, `${slug ?? this.hashRoot(name)}.lock`);
  }

  private readLock(name: string): SessionLock | null {
    try {
      const raw = JSON.parse(Fs.readFileSync(this.lockPathForName(name), 'utf8'));
      if (typeof raw?.pid === 'number' && typeof raw?.host === 'string') {
        return { pid: raw.pid, host: raw.host, since: typeof raw.since === 'string' ? raw.since : '' };
      }
    } catch {
      /* missing or corrupt → unlocked */
    }
    return null;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0); // signal 0 = existence check, kills nothing
      return true;
    } catch (error) {
      // ESRCH → no such process (stale lock); EPERM → alive but owned by another user.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  /** Claim `name` for this process (best-effort; overwrites a stale/foreign lock).
   *  Called by the SessionController when a window adopts a named session. */
  acquireLock(name: string): void {
    try {
      Fs.mkdirSync(this.stateDir, { recursive: true });
      const lock: SessionLock = { pid: process.pid, host: Os.hostname(), since: new Date().toISOString() };
      Fs.writeFileSync(this.lockPathForName(name), JSON.stringify(lock));
    } catch {
      /* best effort — a missing lock only weakens the open-elsewhere warning */
    }
  }

  /** Release `name`'s lock iff this process holds it (never removes another owner's). */
  releaseLock(name: string): void {
    const lock = this.readLock(name);
    if (lock && lock.pid === process.pid && lock.host === Os.hostname()) {
      try {
        Fs.rmSync(this.lockPathForName(name), { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  /** The *other* live instance holding `name`, or null when it is free — unlocked, a
   *  stale (dead-PID) lock, or held by this process. A lock from another host can't be
   *  liveness-checked, so it is treated as held (a spurious prompt beats a silent clobber).
   *  Consulted before opening a session another running window may already have open. */
  lockHolder(name: string): SessionLock | null {
    const lock = this.readLock(name);
    if (!lock) return null;
    if (lock.pid === process.pid && lock.host === Os.hostname()) return null; // our own lock
    if (lock.host !== Os.hostname()) return lock; // foreign host — assume live
    return this.isProcessAlive(lock.pid) ? lock : null;
  }

  /** Absolute path of the (legacy) per-root autosave file. Reads/deletes only —
   *  the named-only model never *writes* here (see `save`). */
  pathForRoot(root: string): string {
    return Path.join(this.stateDir, this.fileName(undefined, root));
  }

  /** Absolute path of the file backing the named session `name`. */
  pathForName(name: string): string {
    return Path.join(this.stateDir, this.fileName(name, ''));
  }

  /** The user-facing label for a session: its name, else the primary basename. */
  label(state: SessionState): string {
    return state.name ?? this.basename(this.primaryRoot(state));
  }

  // --- Read / write ----------------------------------------------------------

  /**
   * Atomically write `state` (stamping `savedAt` and `version`). Creates the
   * sessions dir if needed. Throws only on a genuine filesystem failure.
   */
  save(state: SessionState): void {
    // Named-only persistence: an unnamed/default session is ephemeral and must
    // never reach disk (see docs/session-management.md "Session identity"). The
    // SessionController gates on `currentName`; this is the backstop.
    if (!state.name) throw new Error('[session] refusing to persist an unnamed session (a name is required)');
    Fs.mkdirSync(this.stateDir, { recursive: true });
    const stamped: SessionState = {
      ...state,
      version: SESSION_VERSION,
      savedAt: new Date().toISOString(),
    };
    const path = this.pathFor(stamped);
    const tmp = `${path}.tmp`;
    Fs.writeFileSync(tmp, JSON.stringify(stamped, null, 2) + '\n');
    Fs.renameSync(tmp, path);
  }

  /** Load the named session `name`, or `null`. */
  loadByName(name: string): SessionState | null {
    return this.loadPath(this.pathForName(name));
  }

  /** Load the legacy per-root autosave file for `root`, or `null`. Retained so
   *  old (pre-named-only) files can still be read/migrated; nothing writes here. */
  load(root: string): SessionState | null {
    return this.loadPath(this.pathForRoot(root));
  }

  /**
   * Load and validate a session file. Returns `null` (warning, never throwing)
   * for a missing, unparseable, malformed, or wrong-version file — the same
   * forgiving posture as the config loader, so a bad file never blocks anything.
   */
  loadPath(path: string): SessionState | null {
    let text: string;
    try {
      text = Fs.readFileSync(path, 'utf8');
    } catch {
      return null; // missing
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      console.warn(`[session] failed to parse ${path}: ${(error as Error).message}`);
      return null;
    }
    if (!isSessionState(parsed)) {
      console.warn(`[session] ${path} is not a valid session`);
      return null;
    }
    if (parsed.version !== SESSION_VERSION) {
      console.warn(`[session] ${path} has unsupported version ${parsed.version}`);
      return null;
    }
    return parsed;
  }

  /** Every session file on disk (for a future "open session" picker). */
  list(): SessionState[] {
    let names: string[];
    try {
      names = Fs.readdirSync(this.stateDir);
    } catch {
      return []; // dir not created yet
    }
    const out: SessionState[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const state = this.loadPath(Path.join(this.stateDir, name));
      if (state) out.push(state);
    }
    return out;
  }

  /** Delete a session — its json **and** its unsaved-buffer cache (e.g. on an
   *  explicit "forget session"). */
  delete(state: SessionState): void {
    try {
      Fs.rmSync(this.pathFor(state));
    } catch {
      // already gone — nothing to do
    }
    try {
      Fs.rmSync(this.bufferDir(state), { recursive: true, force: true });
    } catch {
      // no cached buffers — nothing to do
    }
    // Forget any lock too — the session is gone, so its `.lock` (ours or a stale one) is orphaned.
    if (state.name) {
      try {
        Fs.rmSync(this.lockPathForName(state.name), { force: true });
      } catch {
        // no lock file — nothing to do
      }
    }
  }

  /**
   * Rename a persisted session: write it under `newName`, move its unsaved-buffer
   * cache to follow the new filename, and remove the old file. Returns the renamed
   * state (the caller adopts it as the new active identity). Also promotes a legacy
   * no-name file to a named one.
   */
  rename(state: SessionState, newName: string): SessionState {
    const oldPath = this.pathFor(state);
    const oldBuffers = this.bufferDir(state);
    const renamed: SessionState = { ...state, name: newName };
    const newPath = this.pathFor(renamed);
    this.save(renamed);
    if (newPath !== oldPath) {
      const newBuffers = this.bufferDir(renamed);
      try {
        if (Fs.existsSync(oldBuffers)) {
          Fs.rmSync(newBuffers, { recursive: true, force: true });
          Fs.renameSync(oldBuffers, newBuffers);
        }
      } catch {
        // best effort — a lost buffer cache only costs unsaved-edit restoration
      }
      try {
        Fs.rmSync(oldPath);
      } catch {
        // old file already gone
      }
    }
    return renamed;
  }
}

/** The `file` tabs in a saved center layout, depth-first — used to reopen an agent
 *  workbench's reviewed files on restore (the agent leaf is recreated separately). */
export function fileTabsOf(node: PanelNode): Extract<TabState, { kind: 'file' }>[] {
  if (node.type === 'leaf') {
    return node.tabs.filter((t): t is Extract<TabState, { kind: 'file' }> => t.kind === 'file');
  }
  return [...fileTabsOf(node.start), ...fileTabsOf(node.end)];
}

/** Structural guard: enough shape to trust the file as a session. */
function isSessionState(value: unknown): value is SessionState {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== 'number') return false;
  if (v.active === null || typeof v.active !== 'object') return false;
  if (!Array.isArray(v.projects) || v.projects.length === 0) return false;
  return v.projects.every(
    (p) => p !== null && typeof p === 'object' && typeof (p as ProjectState).root === 'string',
  );
}
