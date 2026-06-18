/*
 * SessionManager — persists and restores the working state of a project root.
 *
 * Exposed as `quilx.session`. A *session* is everything that makes up "where I
 * was": the split layout, the open files/terminals/agents, cursors, and file-tree
 * expansion — as opposed to `quilx.config`, which is global app settings. See
 * tasks/session-management.md for the full design.
 *
 * This module is the storage + format spine. It is deliberately free of any GTK
 * import so it can be unit-tested under `node --test`; the widget walk that
 * produces a `SessionState` and the deserializers that rebuild widgets live in the
 * UI layer (AppWindow), which registers them here.
 *
 * Storage: one JSON file per session under the XDG state dir
 * (`$XDG_STATE_HOME/quilx/sessions/`, falling back to `~/.local/state`). The file
 * name is a hash of the primary root, unless the session is explicitly named (then
 * a slug of the name). The raw hash is never user-visible — `label()` resolves a
 * display string as `name ?? basename(primaryRoot)`. Writes are atomic
 * (temp + rename), and reads never throw: a missing/corrupt/old-version file
 * yields `null`, mirroring the config loader's "warn and skip" posture.
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { createHash } from 'node:crypto';
import { Disposable } from './util/eventKit.ts';

/** Current on-disk format version. Bumped only on an incompatible change. */
export const SESSION_VERSION = 1;

// --- State shapes (see tasks/session-management.md) --------------------------

/** One tab's restorable state — a discriminated union over the tab kinds. */
export type TabState =
  | { kind: 'file'; path: string; cursor?: [number, number] }
  | { kind: 'terminal'; cwd: string }
  | { kind: 'agent'; command: string[]; cwd: string; prompt?: string; sessionId?: string };

/** The split tree of one workspace: `leaf` tab strips joined by `split` panes. */
export type PanelNode =
  | { type: 'leaf'; tabs: TabState[]; activeIndex: number }
  | {
      type: 'split';
      orientation: 'horizontal' | 'vertical';
      position: number;
      start: PanelNode;
      end: PanelNode;
    };

/**
 * One root's working state. A window switches its active root by swapping which
 * WorkspaceState is live (re-rooting FileTree/GitRepo/title). The MVP runtime
 * only ever has one, but the format carries a list so multi-root is a later
 * runtime change rather than a format migration.
 */
export interface WorkspaceState {
  root: string;
  layout: PanelNode;
  fileTree?: { expanded: string[] };
  /** Present → this workspace is an agent's workbench (relaunch the agent on
   *  restore, resumed to its conversation/worktree). Absent → the user workbench. */
  agent?: AgentTabState;
}

/** The `agent` variant of TabState — an agent workbench's relaunch identity. */
export type AgentTabState = Extract<TabState, { kind: 'agent' }>;

export interface SessionState {
  version: number;
  /** User-given name; absent → labelled by the primary root's basename. */
  name?: string;
  /** ISO timestamp, stamped by `save`. */
  savedAt: string;
  /** At least one; `workspaces[0]` is the primary root (hash/label source). */
  workspaces: WorkspaceState[];
  /** Index into `workspaces` of the active root. MVP: always 0. */
  activeWorkspace: number;
  /** Window-level, shared across workspaces. */
  docks?: { notificationLog: boolean; leftSplit?: number };
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
    this.stateDir = Path.join(base, 'quilx', 'sessions');
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
    return state.workspaces[0]?.root ?? '';
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

  /** Absolute path of the (unnamed) autosave session for a given root. */
  pathForRoot(root: string): string {
    return Path.join(this.stateDir, this.fileName(undefined, root));
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

  /** Load the unnamed autosave session for `root`, or `null`. */
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

  /** Delete a session file (e.g. on explicit "forget session"). */
  delete(state: SessionState): void {
    try {
      Fs.rmSync(this.pathFor(state));
    } catch {
      // already gone — nothing to do
    }
  }
}

/** Structural guard: enough shape to trust the file as a session. */
function isSessionState(value: unknown): value is SessionState {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== 'number') return false;
  if (typeof v.activeWorkspace !== 'number') return false;
  if (!Array.isArray(v.workspaces) || v.workspaces.length === 0) return false;
  return v.workspaces.every(
    (w) => w !== null && typeof w === 'object' && typeof (w as WorkspaceState).root === 'string',
  );
}
