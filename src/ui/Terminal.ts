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
import GLib from 'gi:GLib-2.0';
import Gtk from 'gi:Gtk-4.0';
import Vte from 'gi:Vte-3.91';
type VteTerminal = InstanceType<typeof Vte.Terminal>;
import { fonts } from '../fonts.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import { addStyles } from '../styles.ts';
import { zym } from '../zym.ts';
import { Icons } from './icons.ts';
import type { Key } from '../keymap/Key.ts';
import type { TabState } from '../SessionManager.ts';

const SCROLLBACK_LINES = 10_000;
const DEFAULT_SHELL = '/bin/bash';
// The xterm window-title termprop (VTE_TERMPROP_XTERM_TITLE), set by OSC 0/2.
const XTERM_TITLE = 'xterm.title';

/** Terminal input modes (vim-like): `insert` types into the child; `normal`
 *  releases the keyboard to the app's leader / window-navigation commands. */
export type TerminalMode = 'normal' | 'insert';

// A terminal in normal mode gets a thin selection-colored frame while focused so
// the mode is visible (the keyboard is acting on the app, not the child). `:focus`
// (not `-within`) because normal mode focuses the container itself, not the Vte.
addStyles(`
  .zym-terminal.terminal-normal:focus {
    outline: 1px solid var(--t-ui-surface-selected);
    outline-offset: -1px;
  }
`);

export interface TerminalOptions {
  /** Directory to start the shell in (defaults to the user's home directory). */
  cwd?: string;
  /** Shell to launch (defaults to `$SHELL`, then `/bin/bash`). */
  shell?: string;
  /**
   * Full argv to spawn instead of a login shell (e.g. an agent CLI). When set,
   * `shell` is ignored. Defaults to `[shell, '-l']`.
   */
  command?: string[];
  /** Initial title, shown until the child reports its own (OSC 0/2). */
  title?: string;
  /** Fired when the shell process exits, with its exit status. */
  onExit?: (status: number) => void;
  /** Fired whenever the child's running state changes — it spawns or exits — so a
   *  host can reflect "is the command running" (e.g. a run/stop action button). Fires
   *  even with `keepOpenOnExit` (where `onExit` is suppressed). */
  onRunningChange?: () => void;
  /**
   * Keep the terminal open (and silent) when its child exits instead of firing
   * `onExit`: the pane stays on the command's final output with a dim notice, and
   * no new process is started. Used by one-shot command tabs (e.g. agent actions)
   * that a host re-runs in place via `run()`. (`onExit` still fires on a spawn
   * failure, which never produces output worth lingering on.)
   */
  keepOpenOnExit?: boolean;
  /**
   * Skip session persistence: `serialize()` returns null, so this terminal is left
   * out of the saved layout and the reopen-last history. For tabs too transient to
   * restore as a bare shell (e.g. a one-shot agent-action command tab).
   */
  transient?: boolean;
}

export class Terminal {
  // A focusable container wrapping the Vte child. `root` (not the Vte) is the
  // selector identity and the keyboard-focus target in normal mode: focusing it
  // *steals* focus from the Vte so the child's cursor goes idle (un-focused, no
  // blink) and the child receives no keystrokes — there's no need to swallow keys.
  // Insert mode focuses the Vte directly.
  readonly root: InstanceType<typeof Gtk.Box>;
  protected readonly terminal: VteTerminal;

  private readonly onExit: (status: number) => void;
  private readonly onRunningChange: () => void;
  private readonly keepOpenOnExit: boolean;
  private readonly transient: boolean;
  // A command staged by `run()` while the previous child is still being killed; it
  // is spawned from the next `child-exited`, so the pty never hosts two children.
  private pendingRerun: string[] | null = null;
  // The launch directory, retained for session serialization. (The shell may cd
  // elsewhere; tracking the live cwd would need OSC 7 — out of scope for now.)
  protected readonly cwd: string;
  private _title: string;
  private _pid: number | null = null;
  private readonly titleHandlers: Array<() => void> = [];
  // Input mode. Insert (the default) types into the child as a normal terminal;
  // normal releases the keyboard so the app's `space` leader / `ctrl-w` window
  // navigation work. Escape ↔ `i` switch; `ctrl-[` still sends a literal Escape.
  private _mode: TerminalMode = 'insert';
  private readonly modeHandlers: Array<() => void> = [];
  protected readonly disposables = new CompositeDisposable();

  constructor(options: TerminalOptions = {}) {
    this.onExit = options.onExit ?? (() => {});
    this.onRunningChange = options.onRunningChange ?? (() => {});
    this.keepOpenOnExit = options.keepOpenOnExit ?? false;
    this.transient = options.transient ?? false;
    this.cwd = options.cwd ?? Os.homedir();
    this._title = options.title ?? 'Terminal';

    this.terminal = this.createTerminal();
    this.root = this.createContainer(this.terminal);
    this.followSystemColorScheme();
    this.spawnShell(options);
    this.setupModalInput();
  }

  // --- Terminal widget -------------------------------------------------------

  // The focusable container hosting the Vte. It carries the selector identity
  // (name + `.zym-terminal`) and the mode classes, and is what the keymap
  // manager / window focus see (the Vte is its only child).
  private createContainer(terminal: VteTerminal): InstanceType<typeof Gtk.Box> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    box.addCssClass('Terminal');
    box.addCssClass('zym-terminal'); // shared selector for both Terminal & AgentTerminal
    box.setFocusable(true); // so normal mode can hold focus instead of the Vte
    box.append(terminal);
    return box;
  }

  private createTerminal(): VteTerminal {
    const terminal = new Vte.Terminal();
    terminal.setVexpand(true);
    terminal.setHexpand(true);
    terminal.setScrollbackLines(SCROLLBACK_LINES);
    terminal.setScrollOnOutput(false);
    terminal.setScrollOnKeystroke(true);
    terminal.setMouseAutohide(true);
    terminal.setFont(fonts.monospaceDescription());
    // Follow the app monospace font live (VTE takes a description, not CSS). A closed
    // terminal tab UNPARENTS the Vte (no `destroy` — see dispose()), so the drop must hang
    // off `disposables`, not a `destroy` handler that never fires.
    this.disposables.defer(fonts.onChange(() => terminal.setFont(fonts.monospaceDescription())));

    // The shell/agent's reported title (xterm OSC 0/2). VTE 0.78+ deprecated the
    // `window-title-changed` signal in favor of termprops, so the title arrives as
    // the `xterm.title` termprop via the detailed `termprop-changed` signal.
    this.disposables.connect(terminal, 'termprop-changed', (name: string) => {
      if (name !== XTERM_TITLE) return;
      const value = terminal.getTermpropString(XTERM_TITLE) as string | string[] | null;
      this._title = (Array.isArray(value) ? value[0] : value) || 'Terminal';
      this.emitTitleChange();
    });
    this.disposables.connect(terminal, 'child-exited', (status: number) => this.handleChildExit(status));
    return terminal;
  }

  // The child exited. If a re-run was staged (run() while the old child was still
  // alive), spawn it now into the freed pty. With `keepOpenOnExit`, stay on the
  // output with a dim notice rather than firing `onExit` (which would close the
  // tab) or respawning a shell. Otherwise hand the exit to the host.
  private handleChildExit(status: number): void {
    this.setPid(null); // the child is gone — so a later run() respawns instead of staging
    if (this.pendingRerun) {
      const command = this.pendingRerun;
      this.pendingRerun = null;
      this.respawn(command);
      return;
    }
    if (this.keepOpenOnExit) {
      this.terminal.feed(Array.from(new TextEncoder().encode('\r\n\x1b[2m── process exited ──\x1b[0m\r\n')));
      return;
    }
    this.onExit(status);
  }

  /** Run `command` in this terminal, reusing its pty and scrollback. A still-running
   *  child is terminated first and the command spawned once it exits, so the pty
   *  never hosts two children. Lets a host re-run a one-shot tab in place. */
  run(command: string[]): void {
    if (this._pid !== null) {
      this.pendingRerun = command;
      this.kill('SIGTERM');
      return;
    }
    this.respawn(command);
  }

  // --- Shell process ---------------------------------------------------------

  private spawnShell(options: TerminalOptions) {
    // A custom command (e.g. an agent CLI) runs verbatim; otherwise a login
    // shell, so the user's profile (PATH, prompt, aliases) is sourced.
    const shell = options.shell ?? process.env.SHELL ?? DEFAULT_SHELL;
    this.spawn(options.command ?? [shell, '-l']);
  }

  /** (Re)spawn a child in this terminal's pty. The pty (and so the scrollback)
   *  is reused, so it's safe to call again after the previous child exited — e.g.
   *  to resume a stopped agent in place. */
  protected respawn(command: string[]): void {
    this.spawn(command);
  }

  private spawn(argv: string[]) {
    this.setPid(null); // cleared until the (re)spawn reports a new child
    const envv = Object.entries(process.env).map(([key, value]) => `${key}=${value}`);

    this.terminal.spawnAsync(
      Vte.PtyFlags.DEFAULT,
      this.cwd,
      argv,
      envv,
      GLib.SpawnFlags.SEARCH_PATH,
      // child setup MUST be null: node-gtk would run a JS callback inside the
      // forked child (between fork and exec), where re-entering V8 segfaults the
      // child — VTE then fires `child-exited` immediately and the tab vanishes.
      null as any,
      -1, // no spawn timeout
      null, // no cancellable
      (_terminal: unknown, pid: number, error: { message: string } | null) => {
        // A spawn failure never starts a child, so `child-exited` won't fire;
        // report it explicitly instead of leaving a silent, empty terminal.
        if (error || pid === -1) {
          this.onExit(127);
          console.error(`Terminal: failed to spawn ${argv[0]}: ${error?.message ?? 'unknown error'}`);
        } else {
          this.setPid(pid); // captured so `kill()` can signal the child
        }
      },
    );
  }

  // --- Style scheme: follow the system light/dark preference -----------------

  private followSystemColorScheme() {
    // Vte reads its colors from the widget's CSS context, which libadwaita
    // already flips with the system scheme; clearing any explicit override lets
    // it inherit the themed foreground/background.
    this.terminal.setColors(null, null, null);
  }

  // --- Identity --------------------------------------------------------------

  /** The tab/window title for this terminal (the shell's reported title). */
  get title(): string {
    return this._title;
  }

  /** The spawned child's process id while it runs (null before spawn, on failure,
   *  and after the child exits). */
  get pid(): number | null {
    return this._pid;
  }

  // Update the child pid and notify on a real transition (spawn ⇄ exit), so a host
  // tracking "is the command running" stays in sync. The sole writer of `_pid`.
  private setPid(pid: number | null): void {
    if (this._pid === pid) return;
    this._pid = pid;
    this.onRunningChange();
  }

  focus() {
    // Insert focuses the Vte (typing); normal focuses the container (keys go to
    // the app, the Vte cursor idles). So focusing respects the current mode.
    (this._mode === 'insert' ? this.terminal : this.root).grabFocus();
  }

  // Whether keyboard focus is currently inside this terminal (the container or
  // the Vte). Used so a mode switch only moves focus when we already have it.
  private containsFocus(): boolean {
    let widget = this.root.getRoot()?.getFocus?.() ?? null;
    while (widget) {
      if (widget === this.root) return true;
      widget = widget.getParent();
    }
    return false;
  }

  // --- Input mode (vim-like normal/insert) -----------------------------------

  /** The current input mode. */
  get mode(): TerminalMode {
    return this._mode;
  }

  /** Switch input mode. Insert hands the keyboard to the child (and releases the
   *  `space` leader); normal hands it back to the app's leader/window commands. */
  setMode(mode: TerminalMode): void {
    if (mode === this._mode) return;
    const hadFocus = this.containsFocus();
    this._mode = mode;
    this.applyMode();
    // Move focus to the mode's target (Vte in insert, container in normal) so the
    // child cursor activates/idles accordingly — but only if we already held focus.
    if (hadFocus) this.focus();
    for (const handler of this.modeHandlers) handler();
  }

  /** Subscribe to mode changes (normal ↔ insert). Returns an unsubscribe fn. */
  onDidChangeMode(callback: () => void): () => void {
    this.modeHandlers.push(callback);
    return () => {
      const index = this.modeHandlers.indexOf(callback);
      if (index !== -1) this.modeHandlers.splice(index, 1);
    };
  }

  // Wire the modal behaviour: register the mode commands, apply the initial mode,
  // and keep the mode in lockstep with where focus actually sits.
  private setupModalInput(): void {
    zym.commands.add(this.root, {
      'terminal:insert-mode': { didDispatch: () => this.setMode('insert'), description: 'Terminal: enter insert mode (type into the child)' },
      'terminal:normal-mode': { didDispatch: () => this.setMode('normal'), description: 'Terminal: enter normal mode (app shortcuts)' },
      'terminal:send-escape': { didDispatch: () => this.feedChild('\x1b'), description: 'Terminal: send Escape to the child' },
      'terminal:copy': { didDispatch: () => this.copySelection(), description: 'Terminal: copy the selection' },
      'terminal:paste': { didDispatch: () => this.terminal.pasteClipboard(), description: 'Terminal: paste the clipboard' },
    });
    this.applyMode();

    // When a chord prefix on this terminal times out unfinished (e.g. a single
    // `ctrl-d` of the `ctrl-d ctrl-d` close binding), the keymap held the key
    // back instead of sending it. Deliver it to the child now — but only while
    // we're the focused terminal in insert mode, so normal-mode keys stay with
    // the app and a background terminal never steals the keystroke.
    // A closed terminal tab unparents (no `destroy`), so the fallthrough sub must hang off
    // `disposables` directly — a `destroy` handler would never fire to drop it.
    this.disposables.add(zym.keymaps.onFallthrough((keys) => this.handleFallthrough(keys)));

    // Whenever the Vte actually holds the keyboard, we are in insert mode — keeping
    // the "focus target == mode" invariant the modal design relies on. This covers
    // every path that focuses the Vte: a click, Tab navigation, and crucially a
    // *programmatic* focus such as a tab restoring its last-focused widget. Without
    // it the Vte could hold focus while the app still treats keys as normal-mode
    // (so the `space` leader fires), and typing into a visibly-focused terminal
    // would mysteriously trigger app commands. Entering normal mode focuses the
    // container instead, which moves focus *off* the Vte (a `leave`, not an
    // `enter`), so this never spuriously flips back to insert.
    const focus = new Gtk.EventControllerFocus();
    focus.on('enter', () => this.setMode('insert'));
    this.disposables.addController(this.terminal, focus);
  }

  /** Sever the Vte focus controller node-gtk roots; idempotent. A closed terminal
   *  tab unparents (no `destroy`), so this must run from the owner (disposeChild /
   *  closeAgent). Subclasses overriding this must call `super.dispose()`. */
  dispose(): void {
    this.disposables.dispose();
  }

  // Reflect the mode onto the widget's CSS classes: `.has-text-input` (which
  // releases the `space` leader) is present only in insert mode, and the
  // `.terminal-insert` / `.terminal-normal` classes drive the mode keymaps + cue.
  private applyMode(): void {
    const insert = this._mode === 'insert';
    if (insert) this.root.addCssClass('has-text-input');
    else this.root.removeCssClass('has-text-input');
    if (insert) this.root.addCssClass('terminal-insert');
    else this.root.removeCssClass('terminal-insert');
    if (insert) this.root.removeCssClass('terminal-normal');
    else this.root.addCssClass('terminal-normal');
  }

  // --- Session integration ---------------------------------------------------

  /** Session state for this tab, or null when `transient` (left out of the saved
   *  layout / reopen history). Overridden by AgentTerminal for `kind: 'agent'`. */
  serialize(): TabState | null {
    if (this.transient) return null;
    return { kind: 'terminal', cwd: this.cwd };
  }

  /**
   * Signal the child process (default SIGTERM). A direct kill(2) syscall — safe
   * under the GLib loop (unlike node async). No-op before spawn / after exit; the
   * resulting `child-exited` drives the rest (status, exit notice).
   */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this._pid === null) return;
    try {
      process.kill(this._pid, signal);
    } catch {
      /* already gone */
    }
  }

  /**
   * Write `text` to the child as if typed at the keyboard — used to push editor
   * context (a selection, a file path) into an agent's input. No trailing newline
   * is added, so the recipient can keep editing before submitting.
   */
  feedChild(text: string): void {
    this.terminal.feedChild(Array.from(new TextEncoder().encode(text)));
  }

  // Copy the current selection to the clipboard as plain text. No-op when nothing
  // is selected (so the keybinding doesn't clobber the clipboard with an empty
  // copy). VTE 0.78+ deprecated `copyClipboard` in favour of the format variant.
  private copySelection(): void {
    if (!this.terminal.getHasSelection()) return;
    this.terminal.copyClipboardFormat(Vte.Format.TEXT);
  }

  // Deliver a timed-out chord prefix (from the keymap manager) to the child as
  // raw input. Only acts when this terminal is the focused one in insert mode;
  // otherwise it declines so the keystroke is dropped (normal mode) or offered
  // to another terminal. Returns whether it consumed the keys.
  private handleFallthrough(keys: Key[]): boolean {
    if (this._mode !== 'insert' || !this.containsFocus()) return false;
    let bytes = '';
    for (const key of keys) {
      const encoded = encodeKeyForChild(key);
      if (encoded === null) return false; // unencodable key — leave the chord dropped
      bytes += encoded;
    }
    if (bytes === '') return false;
    this.feedChild(bytes);
    return true;
  }

  /** Subscribe to title changes; returns an unsubscribe function. */
  onTitleChange(callback: () => void): () => void {
    this.titleHandlers.push(callback);
    return () => {
      const index = this.titleHandlers.indexOf(callback);
      if (index !== -1) this.titleHandlers.splice(index, 1);
    };
  }

  /** Notify title subscribers. Protected so subclasses (AgentTerminal's rename)
   *  can surface a title override through the same channel. */
  protected emitTitleChange() {
    for (const callback of this.titleHandlers) callback();
  }
}

// Translate a keystroke the keymap declined into the bytes a terminal sends for
// it. Covers what can realistically start a chord here: a `ctrl`+letter maps to
// its C0 control byte (`ctrl-a` ⇒ 0x01 … `ctrl-z` ⇒ 0x1a, `ctrl-d` ⇒ 0x04), and
// a plain printable key passes through as its character. Returns null for keys
// without a simple byte encoding (the chord is then dropped rather than guessed).
function encodeKeyForChild(key: Key): string | null {
  const name = key.name ?? '';
  if (key.ctrl && !key.alt && !key.super && /^[a-z]$/i.test(name)) {
    return String.fromCharCode(name.toUpperCase().charCodeAt(0) & 0x1f);
  }
  if (!key.ctrl && !key.alt && !key.super && name.length === 1 && key.string) {
    return key.string;
  }
  return null;
}

// A terminal tab is prefixed with the shell glyph (the Adw tab-icon convention is
// a glyph embedded in the title; see icons.ts), mirroring how editor/agent tabs
// carry their own marker.
export function terminalTabTitle(terminal: Terminal): string {
  return `${Icons.terminal} ${terminal.title}`;
}
