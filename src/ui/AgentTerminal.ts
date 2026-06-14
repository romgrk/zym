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
 *     flipped to an `exited` status;
 *   - for a `claude` agent it observes the session's live status (idle / working
 *     / waiting-for-permission) via Claude Code hooks: it spawns claude with a
 *     per-session `--settings` block whose hooks write a status word to a file
 *     this terminal watches (a Gio file monitor). See assets/hooks/agent-status.sh.
 *
 * Status changes are surfaced via `status` / `onDidChangeStatus`.
 *
 * The agent's argv comes from the `agent.command` config (default `['claude']`)
 * unless an explicit `command` is passed.
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Gdk, Gio, Gtk } from '../gi.ts';
import { Terminal, type TerminalOptions } from './Terminal.ts';
import { theme } from '../theme/theme.ts';
import { quilx } from '../quilx.ts';

/** Live status of an agent session. */
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'exited';

// node-gtk quirk: Gio.File instance methods are undefined on the concrete
// wrapper, so we reach them through the interface prototype (see git.ts/FileTree).
const FileProto = (Gio.File as any).prototype;

// The bundled hook reporter (assets/hooks/agent-status.sh), invoked by claude's
// hooks to write the session status to QUILX_STATUS_FILE.
const HOOK_SCRIPT = Path.join(
  Path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'hooks', 'agent-status.sh',
);

export interface AgentTerminalOptions extends TerminalOptions {
  /** Fired when the user presses Enter after the agent process has exited. */
  onCloseRequest?: () => void;
  /** An initial prompt to launch the agent with (appended to its argv). */
  prompt?: string;
}

export class AgentTerminal extends Terminal {
  private _status: AgentStatus = 'idle';
  private readonly statusHandlers: Array<() => void> = [];
  private readonly onCloseRequest?: () => void;
  private readonly statusFile: string | null;
  private statusMonitor: InstanceType<typeof Gio.FileMonitor> | null = null;

  constructor(options: AgentTerminalOptions = {}) {
    const baseCommand = options.command ?? resolveAgentCommand();
    const integration = buildStatusIntegration(baseCommand);
    // A launch prompt rides along as a trailing argv element (e.g. `claude
    // "<prompt>"`), so the agent starts already working on it.
    const command = options.prompt
      ? [...integration.command, options.prompt]
      : integration.command;
    super({ ...options, command, title: options.title ?? agentName(baseCommand) });
    this.onCloseRequest = options.onCloseRequest;
    this.statusFile = integration.statusFile;
    this.root.setName('AgentTerminal'); // distinct identity from a plain Terminal
    this.applyThemeColors();

    // Track the live agent globally. On exit we keep it registered (so it stays
    // in the agent list as "exited") and leave the widget in place, printing a
    // notice instead. A second child-exited handler avoids touching `this` in the
    // super() call.
    quilx.agents.add(this);
    this.root.on('child-exited', () => this.onChildExited());
    if (this.statusFile) this.watchStatus(this.statusFile);
  }

  /** The agent session's current status. */
  get status(): AgentStatus {
    return this._status;
  }

  /** Whether the agent process has exited (the widget lingers afterward). */
  get exited(): boolean {
    return this._status === 'exited';
  }

  /** Subscribe to status changes (idle/working/waiting/exited). Returns unsub. */
  onDidChangeStatus(callback: () => void): () => void {
    this.statusHandlers.push(callback);
    return () => {
      const index = this.statusHandlers.indexOf(callback);
      if (index !== -1) this.statusHandlers.splice(index, 1);
    };
  }

  // --- Hook-driven status -----------------------------------------------------

  // Watch the per-session status file the hooks write (atomically, via rename —
  // hence WATCH_MOVES) and reflect each new value as a status change.
  private watchStatus(statusFile: string): void {
    const file = Gio.File.newForPath(statusFile);
    this.statusMonitor = FileProto.monitorFile.call(file, Gio.FileMonitorFlags.WATCH_MOVES, null);
    this.statusMonitor!.on('changed', () => this.readStatus(statusFile));
  }

  private readStatus(statusFile: string): void {
    if (this._status === 'exited') return; // exit is terminal; ignore late writes
    let raw: string;
    try {
      raw = Fs.readFileSync(statusFile, 'utf8').trim();
    } catch {
      return; // mid-rename / removed
    }
    if (raw === 'working' || raw === 'waiting' || raw === 'idle') this.setStatus(raw);
  }

  private setStatus(status: AgentStatus): void {
    if (status === this._status) return;
    this._status = status;
    for (const handler of this.statusHandlers) handler();
  }

  private onChildExited(): void {
    if (this._status === 'exited') return;
    this.setStatus('exited');
    // Print a notice into the (now child-less) terminal so the pane shows why it
    // went quiet, rather than closing or freezing on the last frame.
    this.root.feed(encode('\r\n\x1b[2m── process exited (press enter to close) ──\x1b[0m\r\n'));
    this.installCloseOnEnter();
    this.statusMonitor?.cancel();
    this.statusMonitor = null;
    if (this.statusFile) {
      try { Fs.rmSync(this.statusFile, { force: true }); } catch { /* best effort */ }
    }
  }

  // After exit there is no child to consume input, so Enter requests closing the
  // (now-dead) widget. Capture phase so it fires before Vte swallows the key.
  private installCloseOnEnter(): void {
    if (!this.onCloseRequest) return;
    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number) => {
      if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
        this.onCloseRequest?.();
        return true;
      }
      return false;
    });
    this.root.addController(keys);
  }

  // Vte inherits the Adwaita view colors by default (see Terminal); override the
  // background (and foreground) with the theme's editor colors. Themes without
  // their own background keep the inherited colors.
  private applyThemeColors() {
    const { bg, fg } = theme.ui;
    if (!bg) return;
    this.root.setColors(parseColor(fg), parseColor(bg), null);
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

/**
 * For a `claude` agent, inject a per-session `--settings` block whose hooks
 * report status to a freshly-created status file; returns the augmented argv and
 * that file's path. For any other command, status integration is skipped.
 */
function buildStatusIntegration(command: string[]): { command: string[]; statusFile: string | null } {
  if (command.length === 0 || Path.basename(command[0]) !== 'claude') {
    return { command, statusFile: null };
  }
  const id = randomUUID();
  const dir = Path.join(process.env.XDG_RUNTIME_DIR || Os.tmpdir(), 'quilx', 'agents');
  const statusFile = Path.join(dir, id);
  try {
    Fs.mkdirSync(dir, { recursive: true });
    Fs.writeFileSync(statusFile, 'idle'); // exists up front so the monitor tracks it
  } catch {
    return { command, statusFile: null }; // can't set up IPC — run plain
  }

  const run = (state: string) => `sh ${shellQuote(HOOK_SCRIPT)} ${state}`;
  const settings = {
    env: { QUILX_AGENT_ID: id, QUILX_STATUS_FILE: statusFile },
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: run('idle') }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: run('working') }] }],
      PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: run('working') }] }],
      Stop: [{ hooks: [{ type: 'command', command: run('idle') }] }],
      Notification: [{ hooks: [{ type: 'command', command: run('notification') }] }],
    },
  };
  // `--settings` is a single argv element (VTE spawns via execv, no shell), so the
  // JSON needs no shell-escaping; only the hook command strings (run by claude's
  // shell) are quoted.
  return {
    command: [command[0], '--settings', JSON.stringify(settings), ...command.slice(1)],
    statusFile,
  };
}

/** Single-quote a string for embedding in a POSIX shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
