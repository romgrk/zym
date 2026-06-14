/*
 * Terminal — an interactive shell embedded in the editor: a Vte.Terminal that
 * spawns the user's login shell (`$SHELL`, falling back to `/bin/bash`) in a
 * pseudo-terminal and follows the system light/dark scheme. One Terminal per
 * panel/tab. The Vte widget owns its own scrollback and scrollbar, so the
 * widget is exposed directly via `root`.
 *
 * The shell process is launched in the constructor. When it exits, `onExit` is
 * fired (the host decides whether to close the tab or respawn). The shell's
 * reported title (OSC 0/2) is surfaced through `title` / `onTitleChange`, so a
 * tab can mirror e.g. the running command or current directory.
 */
import * as Os from 'node:os';
import {
  GLib,
  Gtk,
  Pango,
  Vte,
  type VteTerminal,
} from '../gi.ts';

const SCROLLBACK_LINES = 10_000;
const DEFAULT_SHELL = '/bin/bash';

export interface TerminalOptions {
  /** Directory to start the shell in (defaults to the user's home directory). */
  cwd?: string;
  /** Shell to launch (defaults to `$SHELL`, then `/bin/bash`). */
  shell?: string;
  /** Fired when the shell process exits, with its exit status. */
  onExit?: (status: number) => void;
}

export class Terminal {
  readonly root: VteTerminal;

  private readonly onExit: (status: number) => void;
  private _title = 'Terminal';
  private readonly titleHandlers: Array<() => void> = [];

  constructor(options: TerminalOptions = {}) {
    this.onExit = options.onExit ?? (() => {});

    this.root = this.createTerminal();
    this.followSystemColorScheme();
    this.spawnShell(options);
  }

  // --- Terminal widget -------------------------------------------------------

  private createTerminal(): VteTerminal {
    const terminal = new Vte.Terminal();
    terminal.setVexpand(true);
    terminal.setHexpand(true);
    terminal.setScrollbackLines(SCROLLBACK_LINES);
    terminal.setScrollOnOutput(false);
    terminal.setScrollOnKeystroke(true);
    terminal.setMouseAutohide(true);
    terminal.setFont(Pango.FontDescription.fromString('monospace 11'));

    // OSC 0/2 title sequences — let a host mirror the shell's reported title.
    terminal.on('window-title-changed', () => {
      this._title = terminal.getWindowTitle() || 'Terminal';
      this.emitTitleChange();
    });
    terminal.on('child-exited', (status: number) => this.onExit(status));
    return terminal;
  }

  // --- Shell process ---------------------------------------------------------

  private spawnShell(options: TerminalOptions) {
    const shell = options.shell ?? process.env.SHELL ?? DEFAULT_SHELL;
    const cwd = options.cwd ?? Os.homedir();
    // A login shell, so the user's profile (PATH, prompt, aliases) is sourced.
    const argv = [shell, '-l'];
    const envv = Object.entries(process.env).map(([key, value]) => `${key}=${value}`);

    this.root.spawnAsync(
      Vte.PtyFlags.DEFAULT,
      cwd,
      argv,
      envv,
      GLib.SpawnFlags.SEARCH_PATH,
      () => {}, // child setup — nothing to do in the forked child
      -1, // no spawn timeout
      null, // no cancellable
      () => {}, // spawn-complete callback — failures surface via `child-exited`
    );
  }

  // --- Style scheme: follow the system light/dark preference -----------------

  private followSystemColorScheme() {
    // Vte reads its colors from the widget's CSS context, which libadwaita
    // already flips with the system scheme; clearing any explicit override lets
    // it inherit the themed foreground/background.
    this.root.setColors(null, null, null);
  }

  // --- Identity --------------------------------------------------------------

  /** The tab/window title for this terminal (the shell's reported title). */
  get title(): string {
    return this._title;
  }

  focus() {
    this.root.grabFocus();
  }

  /** Subscribe to title changes (fired when the shell reports a new title). */
  onTitleChange(callback: () => void) {
    this.titleHandlers.push(callback);
  }

  private emitTitleChange() {
    for (const callback of this.titleHandlers) callback();
  }
}
