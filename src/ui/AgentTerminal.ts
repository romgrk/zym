/*
 * AgentTerminal — a Terminal that hosts a terminal-based coding agent (an agent
 * CLI) rather than a plain login shell. It behaves exactly like Terminal except:
 *
 *   - it paints with the theme's editor background/foreground instead of
 *     inheriting the Adwaita view colors, so an agent session blends with the
 *     editor surface;
 *   - it carries its own selector identity (`AgentTerminal`) for command/keymap
 *     and CSS rules;
 *   - its initial title is the agent's name (until the CLI reports its own);
 *   - when the agent process exits the widget is NOT torn down: a "process
 *     exited" notice is printed into the terminal and the agent stays listed,
 *     flipped to an `exited` status.
 *
 * This class is the tool-agnostic host: it owns the agent's status, edited-files
 * list, display name (`rename`) and serialization. Any tool-specific integration
 * — argv augmentation and the status / edited-files / session-name reporting —
 * lives behind an injected `AgentDriver` (see ../agents/types.ts); the host calls
 * `options.driverFactory` to build one. For `claude` that's `createClaudeTuiDriver`
 * (../agents/claude-tui/session.ts); a command with no driver runs plain.
 *
 * Status changes are surfaced via `status` / `onDidChangeStatus`.
 *
 * The agent's argv comes from the `agent.command` config (default `['claude']`)
 * unless an explicit `command` is passed.
 */
import * as Path from 'node:path';
import { Gdk } from '../gi.ts';
import { Terminal, type TerminalOptions } from './Terminal.ts';
import type { Agent, AgentDriver, AgentDriverFactory, AgentHost, AgentMode, AgentResume, AgentStatus } from '../agents/types.ts';
import { worktreeInfo, type WorktreeInfo } from '../git.ts';
import { theme } from '../theme/theme.ts';
import { quilx } from '../quilx.ts';
import type { TabState } from '../SessionManager.ts';

export type { AgentMode, AgentResume, AgentStatus } from '../agents/types.ts';
export type { WorktreeInfo } from '../git.ts';

export interface AgentTerminalOptions extends TerminalOptions {
  /** An initial prompt to launch the agent with (appended to its argv). */
  prompt?: string;
  /** Resume a past conversation rather than starting a new one. */
  resume?: AgentResume;
  /** The integration to attach (e.g. `createClaudeTuiDriver`). When it returns a
   *  driver, that driver's argv is spawned and it reports live state; when it
   *  returns null (or is absent) the base command runs plain (alive/exited only). */
  driverFactory?: AgentDriverFactory;
}

export class AgentTerminal extends Terminal implements Agent {
  private _status: AgentStatus = 'idle';
  private readonly statusHandlers: Array<() => void> = [];
  // Attention tracking for the sidebar's blinking status dot. `_viewed` is whether
  // the user is currently looking at this agent (its tab is the active one);
  // `_acknowledged` is whether they've viewed it since its current status began.
  // Together they gate `needsAttention` (see below). A fresh agent starts
  // acknowledged so an idle one doesn't blink before the user has done anything.
  private _viewed = false;
  private _acknowledged = true;
  private readonly attentionHandlers: Array<() => void> = [];
  // The agent's permission mode (claude's `shift-tab` cycle); `default` until the
  // driver reports otherwise.
  private _permissionMode: AgentMode = 'default';
  private readonly permissionModeHandlers: Array<() => void> = [];
  private _changedFiles: string[] = [];
  private readonly fileHandlers: Array<() => void> = [];
  // The agent's current working directory: its launch cwd, or a worktree it has
  // since moved into (reported via the set_worktree bridge tool).
  private _effectiveCwd: string = this.cwd;
  // The git worktree the agent is in, computed lazily from `_effectiveCwd` and
  // cached; recomputed on a cwd change. `null` = not inside a repo.
  private _worktree: WorktreeInfo | null | undefined;
  private readonly worktreeHandlers: Array<() => void> = [];
  // A worktree the Bash validator saw the agent create but which it hasn't yet
  // announced via set_worktree (cleared when it does); drives the warning toast.
  private _pendingWorktree: string | null = null;
  // A user-pinned display name (`agent:rename`); when set it overrides both the
  // driver-reported session name and the CLI's reported (OSC) title.
  private _displayName: string | null = null;
  // The session name the driver reports (claude's `/rename` command and
  // auto-summaries), surfaced via onSessionName.
  private _sessionName: string | null = null;
  // The integration driver (augments argv + reports status/files/name), or null
  // when the command runs plain (alive/exited only). Replaced on `resume()`.
  private driver: AgentDriver | null;
  // The factory that built `driver`, retained so `resume()` can build a fresh one.
  private readonly driverFactory?: AgentDriverFactory;
  // The agent's argv as the user requested it (before driver augmentation) and its
  // launch prompt — retained so the driver can relaunch the agent verbatim.
  private readonly baseCommand: string[];
  private readonly launchPrompt?: string;

  constructor(options: AgentTerminalOptions = {}) {
    const baseCommand = options.command ?? resolveAgentCommand();
    const driver = options.driverFactory?.(baseCommand, options.resume) ?? null;
    // A launch prompt rides along as a trailing argv element (e.g. `claude
    // "<prompt>"`), so the agent starts already working on it.
    const launchArgv = driver ? driver.command : baseCommand;
    const command = options.prompt ? [...launchArgv, options.prompt] : launchArgv;
    super({ ...options, command, title: options.title ?? agentName(baseCommand) });
    this.driver = driver;
    this.driverFactory = options.driverFactory;
    this.baseCommand = baseCommand;
    this.launchPrompt = options.prompt;
    this.root.setName('AgentTerminal'); // distinct identity from a plain Terminal
    this.applyThemeColors();

    // Track the live agent globally. On exit we keep it registered (so it stays
    // in the agent list as "exited") and leave the widget in place, printing a
    // notice instead. A second child-exited handler avoids touching `this` in the
    // super() call.
    quilx.agents.add(this);
    this.terminal.on('child-exited', () => this.onChildExited());
    this.driver?.watch(this.agentHost());
  }

  /** The agent session's current status. */
  get status(): AgentStatus {
    return this._status;
  }

  /**
   * Whether the agent should draw the user's eye (drives the sidebar's blinking
   * dot): it's blocked on the user (`waiting` / needs permission) and they aren't
   * looking at it, or it just went `idle` and they haven't viewed it since. Other
   * states (`working`, `exited`) never demand attention.
   */
  get needsAttention(): boolean {
    if (this._status === 'waiting') return !this._viewed;
    if (this._status === 'idle') return !this._acknowledged;
    return false;
  }

  /** Subscribe to needs-attention changes (drives the sidebar blink). Returns unsub. */
  onDidChangeAttention(callback: () => void): () => void {
    this.attentionHandlers.push(callback);
    return () => {
      const index = this.attentionHandlers.indexOf(callback);
      if (index !== -1) this.attentionHandlers.splice(index, 1);
    };
  }

  /** Mark whether the user is currently viewing this agent (its tab is the active
   *  one). Viewing acknowledges the current status, so a finished agent stops
   *  blinking once looked at and a waiting one stops blinking while it's on screen. */
  setViewed(viewed: boolean): void {
    const wasAttention = this.needsAttention;
    this._viewed = viewed;
    if (viewed) this._acknowledged = true;
    if (this.needsAttention !== wasAttention) this.emitAttentionChange();
  }

  private emitAttentionChange(): void {
    for (const handler of this.attentionHandlers) handler();
  }

  /** Claude's current permission mode (`default` until a hook reports otherwise). */
  get permissionMode(): AgentMode {
    return this._permissionMode;
  }

  /** Subscribe to permission-mode changes (plan/acceptEdits/auto/…). Returns unsub. */
  onDidChangePermissionMode(callback: () => void): () => void {
    this.permissionModeHandlers.push(callback);
    return () => {
      const index = this.permissionModeHandlers.indexOf(callback);
      if (index !== -1) this.permissionModeHandlers.splice(index, 1);
    };
  }

  /** The git worktree the agent runs in, or null when its cwd isn't in a repo. */
  get worktree(): WorktreeInfo | null {
    if (this._worktree === undefined) this._worktree = worktreeInfo(this._effectiveCwd);
    return this._worktree;
  }

  /** The agent's current working directory — its launch cwd, or a worktree it has
   *  since moved into (reported via the set_worktree bridge tool). */
  get effectiveCwd(): string {
    return this._effectiveCwd;
  }

  /** Subscribe to the agent moving into a different git worktree. Returns unsub. */
  onDidChangeWorktree(callback: () => void): () => void {
    this.worktreeHandlers.push(callback);
    return () => {
      const index = this.worktreeHandlers.indexOf(callback);
      if (index !== -1) this.worktreeHandlers.splice(index, 1);
    };
  }

  /** A worktree the validator saw the agent create but which it never announced via
   *  set_worktree, or null. `clearUnannouncedWorktree` consumes it after warning. */
  get unannouncedWorktree(): string | null {
    return this._pendingWorktree;
  }
  clearUnannouncedWorktree(): void {
    this._pendingWorktree = null;
  }

  // The agent moved into `cwd` (set_worktree): recompute the worktree, drop any
  // pending validator warning (it did announce), and notify.
  private setEffectiveCwd(cwd: string): void {
    if (cwd === this._effectiveCwd) return;
    this._effectiveCwd = cwd;
    this._worktree = worktreeInfo(cwd);
    this._pendingWorktree = null;
    for (const handler of this.worktreeHandlers) handler();
  }

  // A pinned name (`agent:rename`) wins, then Claude's own session name (its
  // `/rename`), then the live OSC title / argv basename from the base class.
  get title(): string {
    return this._displayName ?? this._sessionName ?? super.title;
  }

  /** Whether the user has pinned a custom name via `rename`. */
  get renamed(): boolean {
    return this._displayName !== null;
  }

  /** Pin a display name (empty clears it, reverting to the CLI title). */
  rename(name: string): void {
    this._displayName = name.trim() || null;
    this.emitTitleChange();
  }

  /** Whether the agent process has exited (the widget lingers afterward). */
  get exited(): boolean {
    return this._status === 'exited';
  }

  /**
   * Resume a stopped agent in place: respawn the agent process in this same
   * terminal (reusing the pane and its scrollback), resuming its conversation via
   * the driver (claude: `--resume <sessionId>`). A fresh driver is built (the
   * previous run's IPC files were torn down on exit). No-op while still running.
   */
  resume(): void {
    if (!this.exited) return;
    const sessionId = this.sessionId; // cached from the prior run before its files went
    this.driver = this.driverFactory?.(this.baseCommand, sessionId ? { sessionId } : undefined) ?? null;
    // New run → fresh edited-files log; revive the status out of `exited` (a
    // direct write: setStatus refuses to leave the terminal `exited` state).
    this._changedFiles = [];
    for (const handler of this.fileHandlers) handler();
    this._status = 'idle';
    this._acknowledged = true; // user-initiated resume — nothing unseen to flag
    for (const handler of this.statusHandlers) handler();
    this.terminal.feed(encode('\r\n\x1b[2m── resuming ──\x1b[0m\r\n'));
    this.respawn(this.driver ? this.driver.command : this.baseCommand);
    this.driver?.watch(this.agentHost());
  }

  /** No-op (Agent surface): a terminal agent already spawned its child in the
   *  constructor; nothing to defer to a post-mount start. */
  start(): void {}

  /** Push editor context into the agent (Agent surface): typed into the child as
   *  if at the keyboard, so the user can keep editing before submitting. */
  deliver(text: string): void {
    this.feedChild(text);
  }

  // --- Session integration ----------------------------------------------------

  /** The driver's session id once it has reported one (null until then). */
  get sessionId(): string | null {
    return this.driver?.sessionId ?? null;
  }

  /** Session state: base argv + cwd + prompt, plus the session id so a restore can
   *  resume the conversation rather than start over. */
  serialize(): TabState | null {
    return {
      kind: 'agent',
      command: this.baseCommand,
      cwd: this.cwd,
      prompt: this.launchPrompt,
      sessionId: this.sessionId ?? undefined,
    };
  }

  /** A running agent is live work — it blocks exit until confirmed. */
  isModified(): boolean {
    return !this.exited;
  }

  /** Exit-prompt label, e.g. "claude (running)". */
  getModifiedLabel(): string {
    return `${this.title} (running)`;
  }

  /** Subscribe to status changes (idle/working/waiting/exited). Returns unsub. */
  onDidChangeStatus(callback: () => void): () => void {
    this.statusHandlers.push(callback);
    return () => {
      const index = this.statusHandlers.indexOf(callback);
      if (index !== -1) this.statusHandlers.splice(index, 1);
    };
  }

  /** Absolute paths of files the agent has edited this session (deduped). */
  get changedFiles(): string[] {
    return this._changedFiles.slice();
  }

  /** Subscribe to the edited-files list growing. Returns unsub. */
  onDidChangeFiles(callback: () => void): () => void {
    this.fileHandlers.push(callback);
    return () => {
      const index = this.fileHandlers.indexOf(callback);
      if (index !== -1) this.fileHandlers.splice(index, 1);
    };
  }

  // --- Agent driver host -------------------------------------------------------

  // The callbacks the driver pushes live state through as its session progresses.
  private agentHost(): AgentHost {
    return {
      getPid: () => this.pid,
      onStatus: (status) => this.setStatus(status),
      onMode: (mode) => this.setPermissionMode(mode),
      onChangedFiles: (files) => {
        this._changedFiles = files;
        for (const handler of this.fileHandlers) handler();
      },
      onSessionName: (name) => {
        this._sessionName = name;
        this.emitTitleChange();
      },
      onCwd: (cwd) => this.setEffectiveCwd(cwd),
      onWorktreeCreated: (path) => { this._pendingWorktree = path; },
    };
  }

  private setStatus(status: AgentStatus): void {
    if (this._status === 'exited') return; // exit is terminal; ignore later writes
    if (status === this._status) return;
    const wasAttention = this.needsAttention;
    this._status = status;
    // A new status opens a fresh attention episode: it counts as acknowledged only
    // if the user is already looking at this agent — otherwise it should blink
    // until they do.
    this._acknowledged = this._viewed;
    for (const handler of this.statusHandlers) handler();
    if (this.needsAttention !== wasAttention) this.emitAttentionChange();
  }

  private setPermissionMode(mode: AgentMode): void {
    if (mode === this._permissionMode) return;
    this._permissionMode = mode;
    for (const handler of this.permissionModeHandlers) handler();
  }

  private onChildExited(): void {
    if (this._status === 'exited') return;
    this.setStatus('exited');
    // Print a notice into the (now child-less) terminal so the pane shows why it
    // went quiet, rather than closing or freezing on the last frame. The agent and
    // its workbench linger — the user restarts (`r`) or closes (`X`) it from the
    // workbench list when they're done reading the output.
    this.terminal.feed(encode('\r\n\x1b[2m── process exited ──\x1b[0m\r\n'));
    this.driver?.dispose();
  }

  // Vte inherits the Adwaita view colors by default (see Terminal); override the
  // background (and foreground) with the theme's editor colors. Themes without
  // their own background keep the inherited colors.
  private applyThemeColors() {
    const { background: bg, foreground: fg } = theme.ui.editor;
    if (!bg) return;
    this.terminal.setColors(parseColor(fg), parseColor(bg), null);
  }
}

/** A display name for the agent, from its argv (the program basename). */
function agentName(command: string[]): string {
  return command.length > 0 ? Path.basename(command[0]) : 'agent';
}

/** The configured agent argv (`agent.command`), falling back to `['claude']`. */
function resolveAgentCommand(): string[] {
  const value = quilx.config.get('agent.command');
  if (Array.isArray(value) && value.length > 0) return value.map(String);
  return ['claude'];
}

/** Encode a string to the byte array Vte.feed expects. */
function encode(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/** Parse a `#rrggbb` hex string into a Gdk.RGBA. */
function parseColor(hex: string): InstanceType<typeof Gdk.RGBA> {
  const rgba = new Gdk.RGBA();
  rgba.parse(hex);
  return rgba;
}
