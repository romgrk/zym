/*
 * ActionsBar — the row of buttons for an agent's registered actions (set_actions),
 * shown just above the conversation input card. A Gtk.Box wrapping an Adw.WrapBox
 * (so a long row of actions wraps onto further lines instead of overflowing the
 * width); the bar hides when the agent has registered none.
 *
 * The first action is the default and reads as the accent "suggested" button. A
 * terminal-less action that is currently running gets a linked stop control. The
 * widget owns only the layout + buttons; the host supplies run/stop and the
 * running-state query.
 */
import { Gtk, Adw } from '../../gi.ts';
import { addStyles } from '../../styles.ts';
import { iconSpan } from '../icons.ts';
import { setMarkupSafe } from '../proseMarkup.ts';
import { NERDFONT } from '../nerdfont.ts';
import type { AgentAction } from '../../agents/actions.ts';

addStyles(/* css */`
  /* 0.5*spacing vertical, 2*spacing horizontal padding around the action buttons. */
  #ActionsBar { 
    padding: calc(1 * var(--t-spacing)) calc(2 * var(--t-spacing));
  }
`);

export interface ActionsBarOptions {
  /** Whether action `id` currently has a running background process. */
  isRunning: (id: string) => boolean;
  /** Run the action (terminal tab or background process). */
  onRun: (action: AgentAction) => void;
  /** Stop a terminal-less action's running process. */
  onStop: (id: string) => void;
}

export class ActionsBar {
  readonly root: InstanceType<typeof Gtk.Box>;
  private readonly wrap: InstanceType<typeof Adw.WrapBox>;
  private actions: AgentAction[] = [];
  private readonly isRunning: (id: string) => boolean;
  private readonly onRun: (action: AgentAction) => void;
  private readonly onStop: (id: string) => void;

  constructor(options: ActionsBarOptions) {
    this.isRunning = options.isRunning;
    this.onRun = options.onRun;
    this.onStop = options.onStop;

    // A WrapBox wrapped in a Box that carries the bar's padding (the WrapBox itself
    // can't be padded without eating into the wrap geometry).
    this.wrap = new Adw.WrapBox({ childSpacing: 6, lineSpacing: 6 });
    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.setName('ActionsBar');
    this.root.append(this.wrap);
    this.root.setVisible(false);
  }

  /** Replace the action set and rebuild the buttons (hides the bar when empty). */
  render(actions: AgentAction[]): void {
    this.actions = actions;
    this.rebuild();
  }

  /** Rebuild from the current set — e.g. when a running-state change toggles a
   *  running action's stop control. */
  refresh(): void {
    this.rebuild();
  }

  private rebuild(): void {
    this.wrap.removeAll();
    this.actions.forEach((action, index) => {
      const run = new Gtk.Button({ label: action.label });
      if (index === 0) run.addCssClass('suggested-action'); // the default action
      // Re-running terminates the previous process first (handled by the host).
      run.on('clicked', () => this.onRun(action));

      if (action.terminal) {
        run.setTooltipText(action.command);
        this.wrap.append(run);
        return;
      }

      // Terminal-less: the run button + a stop control, joined (`linked`). The stop
      // button shows only while the background process is running.
      const running = this.isRunning(action.id);
      run.setTooltipText(`${action.command}\n(background process${running ? ', running — click to restart' : ''})`);
      const group = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
      group.addCssClass('linked');
      group.append(run);
      if (running) {
        const stop = new Gtk.Button({ valign: Gtk.Align.CENTER });
        const stopLabel = new Gtk.Label();
        setMarkupSafe(stopLabel, iconSpan(NERDFONT.STATUS.CROSS, undefined, true), '✗');
        stop.setChild(stopLabel);
        stop.setTooltipText(`Stop ${action.label}`);
        stop.on('clicked', () => this.onStop(action.id));
        group.append(stop);
      }
      this.wrap.append(group);
    });
    this.root.setVisible(this.actions.length > 0);
  }
}
