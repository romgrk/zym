/*
 * MonitorView — the UI for shell monitors (the `Monitor` tool). Like subagents:
 * an inline button in the main thread, an entry in a sticky "Monitors" panel
 * while running (with a Cancel button), and a pushed page to inspect its output.
 * Cancel uses the control protocol's stop_task (SdkSession.stopTask).
 */
import { Gtk, Adw } from '../../gi.ts';
import * as Fs from 'node:fs';
import { theme } from '../../theme/theme.ts';
import { escapeMarkup, setMarkupSafe, clearChildren } from '../proseMarkup.ts';
import { iconSpan } from '../icons.ts';
import { NERDFONT } from '../nerdfont.ts';
import { truncateLines } from './format.ts';
import { StickyListPanel } from './StickyListPanel.ts';
import type { SdkSession } from '../../agents/claude-sdk/SdkSession.ts';
import type { PageNav } from './SubagentView.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

export class MonitorView {
  readonly panel = new StickyListPanel('Monitors', 'quilx-conversation-subagents');
  private readonly ids = new Set<string>();
  private readonly session: Pick<SdkSession, 'getMonitor' | 'onMonitorUpdate' | 'stopTask'>;
  private readonly nav: PageNav;

  constructor(session: Pick<SdkSession, 'getMonitor' | 'onMonitorUpdate' | 'stopTask'>, nav: PageNav) {
    this.session = session;
    this.nav = nav;
  }

  /** A `Monitor` spawn → an inline button (returned, to append to the transcript)
   *  plus an entry in the running-monitors panel. */
  spawn(id: string, description: string): Widget {
    this.ids.add(id);
    const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    row.addCssClass('quilx-conversation-row');
    row.append(this.openButton(id, description));
    this.render();
    return row;
  }

  /** A monitor's status changed (running → killed/stopped/completed). */
  update(_id: string): void {
    this.render();
  }

  private openButton(id: string, description: string, color?: string): InstanceType<typeof Gtk.Button> {
    const label = new Gtk.Label({ xalign: 0, wrap: true });
    setMarkupSafe(label, `${iconSpan(NERDFONT.TOOL.MONITOR, color)}  <b>Monitor</b>  ${escapeMarkup(description)}`, `Monitor ${description}`);
    const button = new Gtk.Button({ halign: Gtk.Align.START, hexpand: true });
    button.addCssClass('flat');
    button.addCssClass('quilx-conversation-subagent-link');
    button.setChild(label);
    button.on('clicked', () => this.pushPage(id));
    return button;
  }

  private render(): void {
    const rows: Widget[] = [];
    for (const id of this.ids) {
      const m = this.session.getMonitor(id);
      if (!m || m.status !== 'running') continue;
      const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
      const open = this.openButton(id, m.description, theme.ui.status.warning);
      const cancel = new Gtk.Button({ valign: Gtk.Align.CENTER });
      cancel.addCssClass('flat');
      const cancelLabel = new Gtk.Label();
      setMarkupSafe(cancelLabel, iconSpan(NERDFONT.STATUS.CROSS, theme.ui.status.error), '✗');
      cancel.setChild(cancelLabel);
      cancel.setTooltipText('Cancel monitor');
      cancel.on('clicked', () => { if (m.taskId) this.session.stopTask(m.taskId); });
      row.append(open);
      row.append(cancel);
      rows.push(row);
    }
    this.panel.render(rows);
  }

  // Inspect page: status + captured output (read from the monitor's output file).
  private pushPage(id: string): void {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
    box.addCssClass('quilx-conversation-transcript');
    const scroller = new Gtk.ScrolledWindow({ vexpand: true });
    scroller.setChild(box);

    const render = () => {
      clearChildren(box);
      const m = this.session.getMonitor(id);
      if (!m) return;
      const head = new Gtk.Label({ xalign: 0, wrap: true, selectable: true });
      setMarkupSafe(head, `<b>${escapeMarkup(m.description)}</b>  <span foreground="${theme.ui.text.muted}">${escapeMarkup(m.status)}</span>`, `${m.description} (${m.status})`);
      box.append(head);
      let output = '';
      if (m.outputFile) { try { output = Fs.readFileSync(m.outputFile, 'utf8'); } catch { /* not readable yet */ } }
      const body = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, label: output.trim() ? truncateLines(output.trim(), 200, 8000) : 'No output captured yet.' });
      body.addCssClass('quilx-conversation-result');
      box.append(body);
    };
    render();
    const sub = this.session.onMonitorUpdate(({ id: uid }) => { if (uid === id) render(); });

    const m = this.session.getMonitor(id);
    const title = m ? `Monitor — ${m.status}` : 'Monitor';
    const back = new Gtk.Button({ label: '‹ Back', halign: Gtk.Align.START });
    back.addCssClass('flat');
    back.on('clicked', () => this.nav.pop());
    const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    header.addCssClass('quilx-conversation-subagent-header');
    header.append(back);
    header.append(new Gtk.Label({ label: title }));
    const page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    page.addCssClass('quilx-conversation');
    page.append(header);
    page.append(scroller);

    const navPage = Adw.NavigationPage.new(page, title);
    navPage.on('hidden', () => sub.dispose());
    this.nav.push(navPage);
  }
}
