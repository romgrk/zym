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
 * list, display name (`rename`) and serialization. All Claude-Code-specific
 * integration — argv/`--settings` injection, the hook IPC files, and the status /
 * edited-files / session-name watchers — lives behind `ClaudeSession`
 * (see claudeAgent.ts); a non-claude command simply runs with no session.
 *
 * Status changes are surfaced via `status` / `onDidChangeStatus`.
 *
 * The agent's argv comes from the `agent.command` config (default `['claude']`)
 * unless an explicit `command` is passed.
 */
import * as Path from 'node:path';
import { Gdk } from '../gi.ts';
import { Terminal, type TerminalOptions } from './Terminal.ts';
import { ClaudeSession, type AgentMode, type AgentResume, type AgentStatus, type ClaudeHost } from './claudeAgent.ts';
import { worktreeInfo, type WorktreeInfo } from '../git.ts';
import { theme } from '../theme/theme.ts';
import { quilx } from '../quilx.ts';
import type { TabState } from '../SessionManager.ts';

export type { AgentMode, AgentResume, AgentStatus } from './claudeAgent.ts';
export type { WorktreeInfo } from '../git.ts';

export interface AgentTerminalOptions extends TerminalOptions {
  /** An initial prompt to launch the agent with (appended to its argv). */
  prompt?: string;
  /** Resume a past conversation rather than starting a new one (claude only). */
  resume?: AgentResume;
}

export class AgentTerminal extends Terminal {
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
  // Claude's permission mode (`shift-tab` cycles it); `default` until a hook reports.
  private _permissionMode: AgentMode = 'default';
  private readonly permissionModeHandlers: Array<() => void> = [];
  private _changedFiles: string[] = [];
  private readonly fileHandlers: Array<() => void> = [];
  // The git worktree the agent launched in, computed lazily from its cwd and cached
  // (the worktree root is fixed for the session). `null` = not inside a repo.
  private _worktree: WorktreeInfo | null | undefined;
  // A user-pinned display name (`agent:rename`); when set it overrides both the
  // claude-reported session name and the CLI's reported (OSC) title.
  private _displayName: string | null = null;
  // The session name Claude reports via its session file (its `/rename` command
  // and auto-summaries), surfaced by the ClaudeSession.
  private _sessionName: string | null = null;
  // The Claude integration (argv/`--settings` + status/files/name watchers), or
  // null for a non-claude command (which then runs plain, alive/exited only).
  // Replaced on `resume()` (each run gets fresh IPC files).
  private session: ClaudeSession | null;
  // The agent's argv as the user requested it (before `--settings` injection) and
  // its launch prompt — retained so a session can relaunch the agent verbatim.
  private readonly baseCommand: string[];
  private readonly launchPrompt?: string;

  constructor(options: AgentTerminalOptions = {}) {
    const baseCommand = options.command ?? resolveAgentCommand();
    const session = ClaudeSession.create(baseCommand, options.resume);
    // A launch prompt rides along as a trailing argv element (e.g. `claude
    // "<prompt>"`), so the agent starts already working on it.
    const launchArgv = session ? session.command : baseCommand;
    const command = options.prompt ? [...launchArgv, options.prompt] : launchArgv;
    super({ ...options, command, title: options.title ?? agentName(baseCommand) });
    this.session = session;
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
    this.session?.watch(this.claudeHost());
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
    if (this._worktree === undefined) this._worktree = worktreeInfo(this.cwd);
    return this._worktree;
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
   * terminal (reusing the pane and its scrollback), resuming its Claude
   * conversation via `--resume <sessionId>`. A fresh ClaudeSession is built (the
   * previous run's IPC files were torn down on exit). No-op while still running.
   */
  resume(): void {
    if (!this.exited) return;
    const sessionId = this.sessionId; // cached from the prior run before its files went
    this.session = ClaudeSession.create(this.baseCommand, sessionId ? { sessionId } : undefined);
    // New run → fresh edited-files log; revive the status out of `exited` (a
    // direct write: setStatus refuses to leave the terminal `exited` state).
    this._changedFiles = [];
    for (const handler of this.fileHandlers) handler();
    this._status = 'idle';
    this._acknowledged = true; // user-initiated resume — nothing unseen to flag
    for (const handler of this.statusHandlers) handler();
    this.terminal.feed(encode('\r\n\x1b[2m── resuming ──\x1b[0m\r\n'));
    this.respawn(this.session ? this.session.command : this.baseCommand);
    this.session?.watch(this.claudeHost());
  }

  // --- Session integration ----------------------------------------------------

  /** The claude session id once a hook has reported it (null until then). */
  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
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

  // --- ClaudeSession host ------------------------------------------------------

  // The callbacks the ClaudeSession drives as Claude's IPC files change.
  private claudeHost(): ClaudeHost {
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
    this.session?.dispose();
  }

  // Vte inherits the Adwaita view colors by default (see Terminal); override the
  // background (and foreground) with the theme's editor colors. Themes without
  // their own background keep the inherited colors.
  private applyThemeColors() {
    const { bg, fg } = theme.ui;
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
