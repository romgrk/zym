/*
 * claudeAgent — the Claude-Code-specific integration for an agent terminal,
 * isolated from the tool-agnostic AgentTerminal host.
 *
 * `ClaudeSession.create(command, resume)` decides whether a command is a `claude`
 * agent; for one it builds the augmented argv (a per-session `--settings` block
 * whose hooks report to IPC files) and returns a session that, once `watch()`n,
 * translates Claude's file-based signals into host callbacks:
 *
 *   - status (idle | working | waiting) from the hook status file;
 *   - the permission mode (plan | acceptEdits | auto | …) from the `.mode` file;
 *   - edited files from the PostToolUse `.files` log;
 *   - the session name (`/rename`) from `~/.claude/sessions/<pid>.json`.
 *
 * For any non-claude command `create` returns null and the host runs it plain.
 * Reporter script: assets/hooks/agent-status.sh.
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Gio } from '../gi.ts';

/** Live status of an agent session. */
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'exited';

/** Claude's permission mode, as reported by the hooks (`shift-tab` cycles it).
 *  `default` asks; the rest auto-allow to varying degrees, `plan` only plans. */
export type AgentMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions';

const AGENT_MODES = new Set<AgentMode>([
  'default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions',
]);

/** Resume a past `claude` conversation rather than starting fresh. */
export interface AgentResume {
  /** Resume a specific session id (`claude --resume <id>`). */
  sessionId?: string;
  /** Continue the most recent conversation in the cwd (`claude --continue`). */
  continue?: boolean;
  /** Branch a copy instead of appending to the original (`--fork-session`). */
  fork?: boolean;
}

/** Callbacks a ClaudeSession drives as Claude's IPC files change. */
export interface ClaudeHost {
  /** The spawned child's pid, or null before it has spawned. */
  getPid(): number | null;
  /** A new session status was reported by a hook. */
  onStatus(status: AgentStatus): void;
  /** The permission mode changed (`shift-tab` cycles plan/acceptEdits/auto/…). */
  onMode(mode: AgentMode): void;
  /** The edited-files list grew (deduped, launch order). */
  onChangedFiles(files: string[]): void;
  /** The session name changed (`/rename` / auto-summary), or null when cleared. */
  onSessionName(name: string | null): void;
}

// node-gtk quirk: Gio.File instance methods are undefined on the concrete
// wrapper, so we reach them through the interface prototype (see git.ts/FileTree).
const FileProto = (Gio.File as any).prototype;

// The bundled hook reporter (assets/hooks/agent-status.sh), invoked by claude's
// hooks to write the session status to QUILX_STATUS_FILE.
const HOOK_SCRIPT = Path.join(
  Path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'hooks', 'agent-status.sh',
);

export class ClaudeSession {
  /** The augmented argv to spawn (base argv + resume flags + `--settings`). */
  readonly command: string[];
  private readonly statusFile: string;
  private host: ClaudeHost | null = null;
  private statusMonitor: InstanceType<typeof Gio.FileMonitor> | null = null;
  private filesMonitor: InstanceType<typeof Gio.FileMonitor> | null = null;
  private modeMonitor: InstanceType<typeof Gio.FileMonitor> | null = null;
  private nameMonitor: InstanceType<typeof Gio.FileMonitor> | null = null;
  // Last values emitted, so a re-read that changed nothing stays silent (the
  // session file in particular is rewritten on every status tick).
  private files: string[] = [];
  private lastName: string | null = null;
  private lastMode: AgentMode | null = null;
  // The claude session id, captured from the hooks (via `<statusFile>.session`).
  private _sessionId: string | null = null;

  private constructor(command: string[], statusFile: string) {
    this.command = command;
    this.statusFile = statusFile;
  }

  /**
   * Build a Claude integration for `baseCommand`, or return null when it isn't a
   * `claude` agent (or the IPC files can't be set up) — in which case the host
   * should run `baseCommand` plain, without status/resume.
   */
  static create(baseCommand: string[], resume?: AgentResume): ClaudeSession | null {
    if (baseCommand.length === 0 || Path.basename(baseCommand[0]) !== 'claude') {
      return null; // resume + status hooks are claude-only
    }
    const id = randomUUID();
    const dir = Path.join(process.env.XDG_RUNTIME_DIR || Os.tmpdir(), 'quilx', 'agents');
    const statusFile = Path.join(dir, id);
    try {
      Fs.mkdirSync(dir, { recursive: true });
      Fs.writeFileSync(statusFile, 'idle'); // exists up front so the monitor tracks it
      Fs.writeFileSync(`${statusFile}.files`, ''); // edited-files log (one path per line)
      Fs.writeFileSync(`${statusFile}.mode`, ''); // permission mode (plan/acceptEdits/…)
    } catch {
      return null; // can't set up IPC — run plain
    }

    const run = (state: string) => `sh ${shellQuote(HOOK_SCRIPT)} ${state}`;
    const settings = {
      env: { QUILX_AGENT_ID: id, QUILX_STATUS_FILE: statusFile },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: run('idle') }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: run('working') }] }],
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: run('working') }] }],
        // Record which files the agent edits, for change-awareness in the UI.
        PostToolUse: [{
          matcher: 'Edit|Write|MultiEdit|NotebookEdit',
          hooks: [{ type: 'command', command: run('files') }],
        }],
        Stop: [{ hooks: [{ type: 'command', command: run('idle') }] }],
        Notification: [{ hooks: [{ type: 'command', command: run('notification') }] }],
      },
    };
    // `--settings` is a single argv element (VTE spawns via execv, no shell), so the
    // JSON needs no shell-escaping; only the hook command strings (run by claude's
    // shell) are quoted.
    const command = [
      baseCommand[0], ...resumeFlags(resume), '--settings', JSON.stringify(settings),
      ...baseCommand.slice(1),
    ];
    return new ClaudeSession(command, statusFile);
  }

  /** Start watching the IPC files; changes are reported through `host`. */
  watch(host: ClaudeHost): void {
    this.host = host;
    this.statusMonitor = this.monitor(this.statusFile, Gio.FileMonitorFlags.WATCH_MOVES,
      () => this.readStatus());
    this.filesMonitor = this.monitor(`${this.statusFile}.files`, Gio.FileMonitorFlags.NONE,
      () => this.readChangedFiles());
    this.modeMonitor = this.monitor(`${this.statusFile}.mode`, Gio.FileMonitorFlags.WATCH_MOVES,
      () => this.readMode());
  }

  /** The claude session id once a hook has reported it (null until then). */
  get sessionId(): string | null {
    if (this._sessionId) return this._sessionId;
    try {
      this._sessionId = Fs.readFileSync(`${this.statusFile}.session`, 'utf8').trim() || null;
    } catch {
      /* not written yet */
    }
    return this._sessionId;
  }

  /** Stop watching and remove the IPC files (Claude's own `sessions/` file is
   *  left alone — Claude owns it). Call when the agent process exits. */
  dispose(): void {
    void this.sessionId; // cache the id before its file is removed (restart resumes it)
    this.statusMonitor?.cancel();
    this.statusMonitor = null;
    this.filesMonitor?.cancel();
    this.filesMonitor = null;
    this.modeMonitor?.cancel();
    this.modeMonitor = null;
    this.nameMonitor?.cancel();
    this.nameMonitor = null;
    this.host = null;
    try { Fs.rmSync(this.statusFile, { force: true }); } catch { /* best effort */ }
    try { Fs.rmSync(`${this.statusFile}.session`, { force: true }); } catch { /* best effort */ }
    try { Fs.rmSync(`${this.statusFile}.files`, { force: true }); } catch { /* best effort */ }
    try { Fs.rmSync(`${this.statusFile}.mode`, { force: true }); } catch { /* best effort */ }
  }

  // --- Watchers ---------------------------------------------------------------

  // The hooks write the status file atomically (tmp + rename — hence WATCH_MOVES).
  private readStatus(): void {
    // The session id is written before the status word, and by the first status
    // write the child has spawned — so start the name watch lazily from here.
    this.ensureNameWatch();
    let raw: string;
    try {
      raw = Fs.readFileSync(this.statusFile, 'utf8').trim();
    } catch {
      return; // mid-rename / removed
    }
    if (raw === 'working' || raw === 'waiting' || raw === 'idle') this.host?.onStatus(raw);
  }

  // The PostToolUse hook appends one edited path per line to `<statusFile>.files`.
  private readChangedFiles(): void {
    let raw: string;
    try {
      raw = Fs.readFileSync(`${this.statusFile}.files`, 'utf8');
    } catch {
      return; // not written yet / removed on exit
    }
    // Dedupe, preserving first-seen order.
    const seen = new Set<string>();
    const files: string[] = [];
    for (const line of raw.split('\n')) {
      const path = line.trim();
      if (path && !seen.has(path)) {
        seen.add(path);
        files.push(path);
      }
    }
    if (files.length === this.files.length) return; // nothing new
    this.files = files;
    this.host?.onChangedFiles(files.slice());
  }

  // The hooks write the current permission mode atomically (tmp + rename) to
  // `<statusFile>.mode` whenever a payload carries it.
  private readMode(): void {
    let raw: string;
    try {
      raw = Fs.readFileSync(`${this.statusFile}.mode`, 'utf8').trim();
    } catch {
      return; // mid-rename / removed
    }
    if (!AGENT_MODES.has(raw as AgentMode)) return; // empty (pre-report) or unknown
    const mode = raw as AgentMode;
    if (mode === this.lastMode) return;
    this.lastMode = mode;
    this.host?.onMode(mode);
  }

  // Watch `~/.claude/sessions/<pid>.json`, whose `.name` Claude (re)writes on
  // `/rename` and auto-summaries — the rename never reaches the PTY as a title,
  // so this file is the only signal. No-op until the child's pid is known (after
  // spawn) and idempotent thereafter.
  private ensureNameWatch(): void {
    if (this.nameMonitor) return; // already watching
    const pid = this.host?.getPid() ?? null;
    if (pid === null) return; // not spawned yet — retried on the next status write
    const file = claudeSessionFile(pid);
    this.readSessionName(file); // pick up an existing name now
    this.nameMonitor = this.monitor(file, Gio.FileMonitorFlags.WATCH_MOVES,
      () => this.readSessionName(file));
  }

  private readSessionName(file: string): void {
    let name: unknown;
    try {
      name = JSON.parse(Fs.readFileSync(file, 'utf8')).name;
    } catch {
      return; // not written yet / mid-write / malformed
    }
    const value = (typeof name === 'string' ? name.trim() : '') || null;
    if (value === this.lastName) return;
    this.lastName = value;
    this.host?.onSessionName(value);
  }

  private monitor(
    path: string,
    flags: number,
    onChange: () => void,
  ): InstanceType<typeof Gio.FileMonitor> {
    const gfile = Gio.File.newForPath(path);
    const m = FileProto.monitorFile.call(gfile, flags, null);
    m.on('changed', onChange);
    return m;
  }
}

/** Path to Claude's per-session state file (carries `.name` from `/rename`). */
function claudeSessionFile(pid: number): string {
  const base = process.env.CLAUDE_CONFIG_DIR || Path.join(Os.homedir(), '.claude');
  return Path.join(base, 'sessions', `${pid}.json`);
}

/** The claude resume flags for a resume request (empty when starting fresh). */
function resumeFlags(resume?: AgentResume): string[] {
  if (!resume) return [];
  const base = resume.continue
    ? ['--continue']
    : resume.sessionId
      ? ['--resume', resume.sessionId]
      : [];
  if (base.length && resume.fork) base.push('--fork-session');
  return base;
}

/** Single-quote a string for embedding in a POSIX shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
