/*
 * WorkbenchActions — the runtime, mutable set of one workbench's actions, the
 * first-class home of the "actions" concept (docs/workbench.md).
 *
 * Owned + constructed by its `Workbench`, which passes a `cwd` accessor so this
 * never snapshots the root (a workbench re-roots into a worktree by reassigning
 * `Workbench.cwd`; reading it live keeps the project-file path and an action's spawn
 * dir correct after a move). The set is:
 *   - seeded from the project settings file `<cwd>/.zym/settings.json` (`actions`
 *     section, via `projectSettings.ts`) on construction;
 *   - overwritten when an agent calls the `set_actions` bridge tool (`setFromAgent`,
 *     replace — not merge), which AppWindow forwards from `agent.onDidChangeActions`;
 *   - reset back to the project defaults on demand (`reset`, re-reads the file);
 *   - every set-replacing path (`setFromAgent`/`reset`/`restore`) routes through
 *     `replaceWith`, which stops any running action the new set drops so a replaced
 *     action's process/terminal command can't leak with no button left to stop it;
 *   - persisted into the session and restored (`serialize` / `restore`) so a
 *     workbench's set survives an editor restart — but not beyond (a closed
 *     workbench discards it).
 *
 * It also runs the actions, tracking which are live so a button can toggle run/stop:
 *   - a `terminal: false` action runs as a background process (`ActionProcesses`);
 *   - a `terminal: true` action runs in a terminal tab via the injected
 *     `TerminalActionRunner` (AppWindow — hosting a tab needs the Workbench), which
 *     also reports that action's running state so it's stoppable too.
 * `onDidChangeRunning` fires for both kinds.
 */
import { Emitter } from '../../util/eventKit.ts';
import { ActionProcesses } from './ActionProcesses.ts';
import { type Action } from '../../actions.ts';
import { readProjectActions } from '../../projectSettings.ts';

/** Runs `terminal: true` actions in a tab and reports their live state, so the
 *  controller can run / stop / status them like background ones. AppWindow supplies
 *  it (it owns the terminal tabs); see `setTerminalRunner`. */
export interface TerminalActionRunner {
  /** Run the action in a terminal tab (open or reuse). */
  run(action: Action): void;
  /** Stop the action's terminal command (no-op if not running). */
  stop(actionId: string): void;
  /** Whether the action's terminal command is currently executing. */
  isRunning(actionId: string): boolean;
  /** Subscribe to any terminal-action running-state change. Returns unsub. */
  onDidChangeRunning(cb: () => void): () => void;
}

export class WorkbenchActions {
  // The owning workbench's live root — read on every use, never snapshotted, so a
  // re-root is reflected without a separate update call.
  private readonly cwd: () => string;
  private list: Action[];
  private terminalRunner: TerminalActionRunner | null = null;
  private terminalRunnerUnsub: (() => void) | null = null;
  private readonly procs: ActionProcesses;
  private readonly emitter = new Emitter();
  private disposed = false;

  constructor(cwd: () => string) {
    this.cwd = cwd;
    this.procs = new ActionProcesses(() => this.emitter.emit('running'));
    this.list = readProjectActions(cwd()); // seed from the project defaults
  }

  /** The effective action set (defensive copy). */
  get actions(): Action[] {
    return this.list.slice();
  }

  /** Wire (or replace) the terminal-action runner — AppWindow injects this once the
   *  owning workbench exists, so a `terminal` action can host its tab there and report
   *  its running state. Its running changes feed `onDidChangeRunning`. */
  setTerminalRunner(runner: TerminalActionRunner): void {
    this.terminalRunnerUnsub?.();
    this.terminalRunner = runner;
    this.terminalRunnerUnsub = runner.onDidChangeRunning(() => this.emitter.emit('running'));
  }

  /** Subscribe to the action set changing. Returns an unsubscribe. */
  onDidChange(cb: () => void): () => void {
    const sub = this.emitter.on('change', cb);
    return () => sub.dispose();
  }

  /** Subscribe to the running-actions set changing (background or terminal). Returns unsub. */
  onDidChangeRunning(cb: () => void): () => void {
    const sub = this.emitter.on('running', cb);
    return () => sub.dispose();
  }

  /** Overwrite the set from an agent's `set_actions` (replace, not merge); any
   *  running action the new set drops is stopped (see `replaceWith`). */
  setFromAgent(actions: Action[]): void {
    this.replaceWith(actions);
  }

  /** Reset back to the project defaults (re-read `<cwd>/.zym/settings.json`); any
   *  running action the defaults drop is stopped (see `replaceWith`). */
  reset(): void {
    this.replaceWith(readProjectActions(this.cwd()));
  }

  /** Restore a set persisted in the session. */
  restore(actions: Action[]): void {
    this.replaceWith(actions);
  }

  /** Swap in a new action set, first stopping any currently-running action the new
   *  set no longer contains — otherwise a dropped action's background process /
   *  terminal command keeps running with no button left to stop it (the running set
   *  is kept a subset of the live action ids). Survivors (same id) keep running.
   *  Every set-replacing path routes through here. */
  private replaceWith(next: Action[]): void {
    const kept = new Set(next.map((a) => a.id));
    for (const prev of this.list) {
      if (!kept.has(prev.id) && this.isRunning(prev.id)) this.stop(prev.id);
    }
    this.list = next;
    this.emitter.emit('change');
  }

  /** The set to persist in the session (a copy). */
  serialize(): Action[] {
    return this.list.slice();
  }

  /** Run an action: a `terminal` one in a terminal tab (the runner), a terminal-less
   *  one as a background process. Re-running either restarts it. */
  run(action: Action): void {
    if (action.terminal) this.terminalRunner?.run(action);
    else this.procs.run(action, this.cwd());
  }

  /** Stop an action by id, whichever kind it is (terminal command or background
   *  process). The non-matching side is a no-op. */
  stop(id: string): void {
    this.procs.stop(id);
    this.terminalRunner?.stop(id);
  }

  /** Whether action `id` is currently running — its background process is alive, or
   *  its terminal command is executing. */
  isRunning(id: string): boolean {
    return this.procs.isRunning(id) || (this.terminalRunner?.isRunning(id) ?? false);
  }

  /** Terminate background processes + drop the terminal-runner subscription. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.procs.stopAll();
    this.terminalRunnerUnsub?.();
  }
}
