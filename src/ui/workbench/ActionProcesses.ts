/*
 * ActionProcesses — the running background processes of a workbench's terminal-less
 * actions (`terminal: false`), keyed by action id. Each `WorkbenchActions` owns
 * one; running such an action spawns its shell command without a terminal widget,
 * holding the process so the action's button can stop it.
 *
 * Semantics the feature needs:
 *   - re-running an action terminates its previous process first (one live
 *     process per action id);
 *   - `stop(id)` / the button's close control terminates it on demand;
 *   - `stopAll()` on workbench teardown so a closed workbench leaves nothing running.
 *
 * Spawned via `Gio.SubprocessLauncher` (GLib-level posix_spawn — the same family
 * VTE uses, not a Node fork of the big parent), so we get a killable handle and a
 * `waitAsync` completion without blocking. Output is inherited (no terminal to
 * capture it); an exit the user didn't trigger surfaces as a notification.
 */
import Gio from 'gi:Gio-2.0';
import { zym } from '../../zym.ts';
import type { Action } from '../../actions.ts';

type Subprocess = InstanceType<typeof Gio.Subprocess>;

export class ActionProcesses {
  // The live process per action id (id → its Gio.Subprocess).
  private readonly procs = new Map<string, Subprocess>();
  // Fires whenever the running set changes (start / stop / exit).
  private readonly onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  /** Whether action `id` has a live background process. */
  isRunning(id: string): boolean {
    return this.procs.has(id);
  }

  /**
   * Run `action`'s command as a background process in `cwd`, terminating any
   * previous process for the same action first (restart = replace). The command
   * runs through a login shell so PATH / profile match the terminal path.
   */
  run(action: Action, cwd: string): void {
    this.stop(action.id); // restart: terminate the previous process first
    const shell = process.env.SHELL || '/bin/bash';
    let proc: Subprocess;
    try {
      const launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.NONE);
      launcher.setCwd(cwd);
      proc = launcher.spawnv([shell, '-l', '-c', action.command]);
    } catch (error) {
      zym.notifications.addError(`Action “${action.label}” failed to start: ${describeError(error)}`);
      return;
    }
    this.procs.set(action.id, proc);
    this.onChange();
    // Resolve when the process exits. If it's still the tracked process (not one
    // we replaced via restart or killed via stop — both drop it from the map
    // first), drop it; a non-zero exit pops an error notification (a clean exit is
    // silent — the button returning to its idle state is feedback enough).
    proc.waitAsync(null, (_source, result) => {
      try { proc.waitFinish(result); } catch { /* cancelled / already reaped */ }
      if (this.procs.get(action.id) !== proc) return; // superseded / intentionally stopped
      this.procs.delete(action.id);
      this.onChange();
      const exitedClean = proc.getIfExited() && proc.getExitStatus() === 0;
      if (!exitedClean) {
        const code = proc.getIfExited() ? proc.getExitStatus() : null;
        zym.notifications.addError(
          code === null
            ? `Action “${action.label}” was terminated.`
            : `Action “${action.label}” exited with code ${code}.`,
        );
      }
    });
  }

  /** Terminate action `id`'s process if it's running (no-op otherwise). */
  stop(id: string): void {
    const proc = this.procs.get(id);
    if (!proc) return;
    this.procs.delete(id); // drop first so the waitAsync callback treats this as intentional
    try { proc.forceExit(); } catch { /* already gone */ }
    this.onChange();
  }

  /** Terminate every running process (host teardown). */
  stopAll(): void {
    for (const id of [...this.procs.keys()]) this.stop(id);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
