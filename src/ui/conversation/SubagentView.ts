/*
 * SubagentView — the UI for spawned subagents (the `Agent` tool). A subagent's
 * activity is captured into its own transcript (see SdkSession); here it surfaces
 * as a single inline button in the main thread, an entry in a sticky "running"
 * panel, and a pushed NavigationView page showing the full transcript.
 */
import { Gtk, Adw } from '../../gi.ts';
import { theme } from '../../theme/theme.ts';
import { fonts } from '../../fonts.ts';
import { MarkdownView } from '../markdown/MarkdownView.ts';
import { toolMarkup } from '../toolDisplay.ts';
import { escapeMarkup, setMarkupSafe, clearChildren } from '../proseMarkup.ts';
import { iconSpan } from '../icons.ts';
import { NERDFONT } from '../nerdfont.ts';
import { summarizeInput, truncateLines } from './format.ts';
import { StickyListPanel } from './StickyListPanel.ts';
import type { SdkSession } from '../../agents/claude-sdk/SdkSession.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

/** Navigation surface the subagent page is pushed onto (the conversation's view). */
export interface PageNav {
  push(page: InstanceType<typeof Adw.NavigationPage>): void;
  pop(): void;
}

export class SubagentView {
  /** The running-subagents panel; mount `panel.root` in the layout. */
  readonly panel = new StickyListPanel('Subagents', 'quilx-conversation-subagents');
  private readonly running = new Map<string, { agentType: string; description: string; status: 'running' | 'completed' }>();

  private readonly session: Pick<SdkSession, 'getSubagent' | 'onSubagentUpdate'>;
  private readonly nav: PageNav;
  private readonly cwd: string;

  constructor(session: Pick<SdkSession, 'getSubagent' | 'onSubagentUpdate'>, nav: PageNav, cwd: string) {
    this.session = session;
    this.nav = nav;
    this.cwd = cwd;
  }

  /** The `Agent` spawn → an inline button (returned, to append to the transcript)
   *  plus an entry in the running panel. */
  spawn(id: string, input: unknown): Widget {
    const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const type = typeof i.subagent_type === 'string' ? i.subagent_type : 'agent';
    const desc = typeof i.description === 'string' ? i.description : '';
    const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    row.addCssClass('quilx-conversation-row');
    row.append(this.linkButton(id, NERDFONT.TOOL.SUBAGENT, type, desc));
    // Show it in the running panel right away (driven by the spawn, not the later
    // task_started, so it's robust); hidden again on completion.
    this.running.set(id, { agentType: type, description: desc, status: 'running' });
    this.render();
    return row;
  }

  /** Mark a subagent finished (hides it from the running panel). */
  done(id: string): void {
    const s = this.running.get(id);
    if (s) s.status = 'completed';
    this.render();
  }

  // A flat link-button "<icon> <type>  <description>" that opens the subagent page.
  private linkButton(id: string, glyph: string, type: string, desc: string, color?: string): InstanceType<typeof Gtk.Button> {
    const label = new Gtk.Label({ xalign: 0, wrap: true });
    setMarkupSafe(label, `${iconSpan(glyph, color)}  <b>${escapeMarkup(type)}</b>${desc ? `  ${escapeMarkup(desc)}` : ''}`, `${type} ${desc}`);
    const button = new Gtk.Button({ halign: Gtk.Align.START });
    button.addCssClass('flat');
    button.addCssClass('quilx-conversation-subagent-link');
    button.setChild(label);
    button.on('clicked', () => this.pushPage(id));
    return button;
  }

  private render(): void {
    const rows: Widget[] = [];
    for (const [id, s] of this.running) {
      if (s.status !== 'running') continue;
      rows.push(this.linkButton(id, NERDFONT.STATUS.SYNC, s.agentType, s.description, theme.ui.status.warning));
    }
    this.panel.render(rows);
  }

  // Push a page rendering the subagent's captured transcript; live-updates while running.
  private pushPage(id: string): void {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
    box.addCssClass('quilx-conversation-transcript');
    const scroller = new Gtk.ScrolledWindow({ vexpand: true });
    scroller.setChild(box);

    const render = () => {
      clearChildren(box);
      const info = this.session.getSubagent(id);
      if (!info) return;
      // The instruction the main agent gave the subagent, at the top (a user turn).
      if (info.prompt) {
        const promptView = new MarkdownView();
        promptView.root.addCssClass('quilx-conversation-user');
        box.append(promptView.root);
        promptView.setMarkdown(info.prompt);
      }
      for (const m of info.messages) {
        if (m.kind === 'text') {
          const view = new MarkdownView();
          view.root.addCssClass('quilx-conversation-assistant');
          box.append(view.root);
          view.setMarkdown(m.text);
        } else {
          const label = new Gtk.Label({ xalign: 0, wrap: true, selectable: true });
          label.addCssClass('quilx-conversation-toolrow');
          setMarkupSafe(label, toolMarkup(m.name, m.input, { cwd: this.cwd, monoFamily: fonts.monospaceFamily }), `${m.name} ${summarizeInput(m.input)}`);
          box.append(label);
          if (m.result && m.result.text.trim()) {
            const out = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, label: truncateLines(m.result.text.trim(), 12, 1200) });
            out.addCssClass('quilx-conversation-result');
            out.setMarginStart(22);
            box.append(out);
          }
        }
      }
    };
    render();
    const sub = this.session.onSubagentUpdate(({ id: uid }) => { if (uid === id) render(); });

    const info = this.session.getSubagent(id);
    const title = info ? `${info.agentType}${info.status === 'running' ? ' (running)' : ''}` : 'Subagent';
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
    navPage.on('hidden', () => sub.dispose()); // stop refreshing once popped
    this.nav.push(navPage);
  }
}
