/*
 * MonitorView — the UI for shell monitors (the `Monitor` tool). Like subagents:
 * an inline button in the main thread, a row in the agent header bar's terminal
 * count-button popover while running (with a Cancel button), and a pushed page to
 * inspect its output. Cancel uses the control protocol's stop_task (SdkSession.stopTask).
 */
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import * as Fs from 'node:fs';
import { CompositeDisposable } from '../../util/eventKit.ts';
import { theme } from '../../theme/theme.ts';
import { addStyles } from '../../styles.ts';
import { escapeMarkup, setMarkupSafe, clearChildren, wrappingLabel } from '../proseMarkup.ts';
import { iconSpan } from '../icons.ts';
import { NERDFONT } from '../nerdfont.ts';
import { truncateLines } from './format.ts';
import { HeaderCountButton } from './HeaderCountButton.ts';
import { ToolRow, toolHeaderLabel } from './ToolRow.ts';
import type { SdkSession } from '../../agents/claude-sdk/SdkSession.ts';
import type { PageNav } from './SubagentView.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

addStyles(`
  /* The inspect page renders a raw box (no Transcript), so it carries no gutter of
     its own — inset its content by the same 2×spacing the transcript entries use so
     the status + output don't sit flush against the page edges. */
  .monitor-page-body { padding: calc(2 * var(--t-spacing)); }
`);

export class MonitorView {
  /** The terminal count button for the agent header bar (icon + running count +
   *  popover list of running monitors); pack `headerButton.button` into the header. */
  readonly headerButton = new HeaderCountButton(NERDFONT.EDITOR.TERMINAL, 'Running monitors');
  private readonly ids = new Set<string>();
  private readonly session: Pick<SdkSession, 'getMonitor' | 'onMonitorUpdate' | 'stopTask'>;
  private readonly nav: PageNav;
  // View-lifetime bag (spawn ToolRows + open pages); disposed by AgentConversation.dispose().
  private readonly subs = new CompositeDisposable();
  // The running-panel button handlers, re-created on every `render()`; cleared per render
  // so they don't accumulate as monitors start/finish. node-gtk roots each closure (rule 2).
  private readonly renderSubs = new CompositeDisposable();

  constructor(session: Pick<SdkSession, 'getMonitor' | 'onMonitorUpdate' | 'stopTask'>, nav: PageNav) {
    this.session = session;
    this.nav = nav;
  }

  /** A `Monitor` spawn → an inline ToolRow (returned, to append to the transcript;
   *  shares the icon/alignment of tool rows) plus an entry in the running panel.
   *  Clicking the row opens the monitor's output page. */
  spawn(id: string, description: string): Widget {
    this.ids.add(id);
    const header = toolHeaderLabel();
    setMarkupSafe(header, `<b>Monitor</b>${description ? `  ${escapeMarkup(description)}` : ''}`, `Monitor ${description}`);
    const toolRow = new ToolRow({ icon: NERDFONT.TOOL.MONITOR, header, onActivate: () => this.pushPage(id), subs: this.subs });
    this.render();
    return toolRow.root;
  }

  /** A monitor's status changed (running → killed/stopped/completed). */
  update(_id: string): void {
    this.render();
  }

  private openButton(id: string, description: string, color?: string): InstanceType<typeof Gtk.Button> {
    const label = wrappingLabel({ xalign: 0, hexpand: true });
    setMarkupSafe(label, `${iconSpan(NERDFONT.TOOL.MONITOR, color)}  <b>Monitor</b>  ${escapeMarkup(description)}`, `Monitor ${description}`);
    const button = new Gtk.Button({ hexpand: true });
    button.addCssClass('flat');
    button.setChild(label);
    this.renderSubs.connect(button, 'clicked', () => { this.pushPage(id); this.headerButton.close(); });
    return button;
  }

  private render(): void {
    this.renderSubs.clear(); // sever the previous render's popover button handlers
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
      this.renderSubs.connect(cancel, 'clicked', () => { if (m.taskId) this.session.stopTask(m.taskId); });
      row.append(open);
      row.append(cancel);
      rows.push(row);
    }
    this.headerButton.setRows(rows);
  }

  // Inspect page: status + captured output (read from the monitor's output file).
  private pushPage(id: string): void {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
    box.addCssClass('monitor-page-body');
    const scroller = new Gtk.ScrolledWindow({ vexpand: true });
    scroller.setChild(box);

    const render = () => {
      clearChildren(box);
      const m = this.session.getMonitor(id);
      if (!m) return;
      const head = wrappingLabel({ xalign: 0, selectable: true });
      setMarkupSafe(head, `<b>${escapeMarkup(m.description)}</b>  <span alpha="55%">${escapeMarkup(m.status)}</span>`, `${m.description} (${m.status})`);
      box.append(head);
      let output = '';
      if (m.outputFile) { try { output = Fs.readFileSync(m.outputFile, 'utf8'); } catch { /* not readable yet */ } }
      const body = wrappingLabel({ xalign: 0, selectable: true, label: output.trim() ? truncateLines(output.trim(), 200, 8000) : 'No output captured yet.' });
      body.addCssClass('conversation-result');
      box.append(body);
    };
    render();
    // Page-scoped bag: severed when the page is popped ('hidden'), or with the view if it
    // is torn down while the page is still open. Holds the update sub + the back/hidden
    // handlers, whose closures node-gtk would otherwise root past the page's life.
    const pageSubs = this.subs.nest();
    pageSubs.use(this.session.onMonitorUpdate(({ id: uid }) => { if (uid === id) render(); }));

    const m = this.session.getMonitor(id);
    const title = m ? `Monitor — ${m.status}` : 'Monitor';
    const back = new Gtk.Button({ label: '‹ Back', halign: Gtk.Align.START });
    back.addCssClass('flat');
    pageSubs.connect(back, 'clicked', () => this.nav.pop());
    const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    header.addCssClass('conversation-page-header');
    header.append(back);
    header.append(new Gtk.Label({ label: title }));
    const page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    page.addCssClass('conversation-surface');
    page.append(header);
    page.append(scroller);

    const navPage = Adw.NavigationPage.new(page, title);
    pageSubs.connect(navPage, 'hidden', () => pageSubs.dispose()); // stop refreshing + sever once popped
    this.nav.push(navPage);
  }

  /** Sever the panel + page handlers so a closed conversation stops pinning this view. */
  dispose(): void {
    this.renderSubs.dispose();
    this.subs.dispose();
  }
}
