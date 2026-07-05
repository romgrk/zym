/*
 * SubagentView — the UI for spawned subagents (the `Agent` tool). A subagent's
 * activity is captured into its own transcript (see SdkSession); here it surfaces
 * as a single inline button in the main thread, a row in the agent header bar's
 * robot count-button popover (running ones), and a pushed NavigationView page
 * showing the full transcript.
 */
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import { CompositeDisposable } from '../../util/eventKit.ts';
import { Message } from './Message.ts';
import { escapeMarkup, setMarkupSafe, wrappingLabel } from '../proseMarkup.ts';
import { NERDFONT } from '../nerdfont.ts';
import { agentStatusMarkup } from '../agentStatusIcon.ts';
import { HeaderCountButton } from './HeaderCountButton.ts';
import { Transcript } from './Transcript.ts';
import { appendToolRow } from './toolRows.ts';
import type { AgentStatus } from '../../agents/types.ts';
import type { ConversationSession } from '../../agents/session.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

/** The transcript group key + icon + head a run of subagent spawns collapses under,
 *  mirroring how Read groups (see Transcript.appendGroupItem). Exported so the
 *  conversation host appends spawns into the same group. */
export const SUBAGENT_GROUP = { key: 'Agent', icon: NERDFONT.TOOL.SUBAGENT, head: 'Agent' } as const;

/** Navigation surface the subagent page is pushed onto (the conversation's view). */
export interface PageNav {
  push(page: InstanceType<typeof Adw.NavigationPage>): void;
  pop(): void;
}

export class SubagentView {
  /** The robot count button for the agent header bar (icon + running count + popover
   *  list of running subagents); pack `headerButton.button` into the header. */
  readonly headerButton = new HeaderCountButton(NERDFONT.TOOL.ROBOT, 'Running subagents');
  private readonly running = new Map<string, { agentType: string; description: string; status: 'running' | 'completed' }>();

  private readonly session: Pick<ConversationSession, 'getSubagent' | 'onSubagentUpdate'>;
  private readonly nav: PageNav;
  private readonly cwd: string;
  private readonly onOpenFile?: (path: string) => void;
  // View-lifetime bag (the inline spawn buttons + open pages); disposed by AgentConversation.dispose().
  private readonly subs = new CompositeDisposable();
  // The running-panel link-button handlers, re-created on every `render()`; cleared per
  // render so they don't accumulate as subagents start/finish (node-gtk roots each).
  private readonly renderSubs = new CompositeDisposable();

  constructor(session: Pick<ConversationSession, 'getSubagent' | 'onSubagentUpdate'>, nav: PageNav, cwd: string, onOpenFile?: (path: string) => void) {
    this.session = session;
    this.nav = nav;
    this.cwd = cwd;
    this.onOpenFile = onOpenFile;
  }

  /** The `Agent` spawn → a clickable inline item (returned, to append into the
   *  transcript's subagent group via SUBAGENT_GROUP — a run of spawns collapses into
   *  one entry, like Read) plus an entry in the running panel. Clicking the item
   *  opens the subagent's transcript page. */
  spawn(id: string, input: unknown): Widget {
    const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const type = typeof i.subagent_type === 'string' ? i.subagent_type : 'agent';
    const desc = typeof i.description === 'string' ? i.description : '';
    // A flat item "<type>  <description>" stacked under the group's single subagent
    // icon (no per-item glyph — the group head carries it, like file-path rows). The
    // click handler routes through `subs` so it's severed when the view is torn down.
    const label = wrappingLabel({ xalign: 0, hexpand: true });
    label.addCssClass('conversation-tool-header');
    setMarkupSafe(label, `<b>${escapeMarkup(type)}</b>${desc ? `  ${escapeMarkup(desc)}` : ''}`, `${type} ${desc}`);
    const item = new Gtk.Button({ halign: Gtk.Align.START });
    item.addCssClass('flat'); // a flat button → shares the grouped head/item padding so it lines up
    item.setChild(label);
    this.subs.connect(item, 'clicked', () => this.pushPage(id));
    // Show it in the running panel right away (driven by the spawn, not the later
    // task_started, so it's robust); hidden again on completion.
    this.running.set(id, { agentType: type, description: desc, status: 'running' });
    this.render();
    return item;
  }

  /** Mark a subagent finished (hides it from the running panel). */
  done(id: string): void {
    const s = this.running.get(id);
    if (s) s.status = 'completed';
    this.render();
  }

  // A flat full-width popover row "<status> <type>  <description>" that opens the
  // subagent page (and closes the popover). The leading glyph is the shared agent
  // status indicator — `working` shows the ellipsis glyph, like a top-level agent.
  private linkButton(id: string, status: AgentStatus, type: string, desc: string): InstanceType<typeof Gtk.Button> {
    const label = wrappingLabel({ xalign: 0, hexpand: true });
    setMarkupSafe(label, `${agentStatusMarkup(status)}  <b>${escapeMarkup(type)}</b>${desc ? `  ${escapeMarkup(desc)}` : ''}`, `${type} ${desc}`);
    const button = new Gtk.Button({ hexpand: true });
    button.addCssClass('flat');
    button.setChild(label);
    this.renderSubs.connect(button, 'clicked', () => { this.pushPage(id); this.headerButton.close(); });
    return button;
  }

  private render(): void {
    this.renderSubs.clear(); // sever the previous render's popover link handlers
    const rows: Widget[] = [];
    for (const [id, s] of this.running) {
      if (s.status !== 'running') continue;
      rows.push(this.linkButton(id, 'working', s.agentType, s.description));
    }
    this.headerButton.setRows(rows);
  }

  // Push a page rendering the subagent's captured transcript; live-updates while running.
  private pushPage(id: string): void {
    // The same shared Transcript widget the main conversation uses — it owns the
    // entries box, the inter-entry spacing (its `.transcript-entry` class), and
    // stick-to-bottom; this code only builds the entries.
    const transcript = new Transcript();
    // Page-scoped bag: severed when the page is popped ('hidden'), or with the view if torn
    // down while still open. Owns the per-page transcript (its autoscroll vadjustment
    // handlers), the update sub, and the back/hidden handlers — all node-gtk-rooted (rule 2).
    const pageSubs = this.subs.nest();
    pageSubs.use(transcript);
    // The page rebuilds on every subagent update; its tool rows carry node-gtk-rooted
    // click handlers, so they ride a render-scoped bag cleared on each rebuild.
    const rowSubs = pageSubs.nest();
    const render = () => {
      rowSubs.clear();
      transcript.clear();
      const info = this.session.getSubagent(id);
      if (!info) return;
      // The instruction the main agent gave the subagent, at the top (a user turn).
      if (info.prompt) {
        const prompt = new Message('user');
        transcript.appendEntry(prompt.root);
        prompt.setMarkdown(info.prompt);
      }
      for (const m of info.messages) {
        if (m.kind === 'text') {
          const message = new Message('assistant');
          transcript.appendEntry(message.root);
          message.setMarkdown(m.text);
        } else {
          // The SAME shared builder the main transcript uses (Bash row, collapsed
          // file-tool group, generic toggle row), so a subagent's tools render
          // identically. We hold the full call+result, so wire the result at once.
          const entry = appendToolRow(transcript, m.name, m.input, { cwd: this.cwd, onOpenFile: this.onOpenFile, subs: rowSubs });
          if (m.result) entry.onResult(m.result.isError, m.result.text);
        }
      }
    };
    render();
    pageSubs.use(this.session.onSubagentUpdate(({ id: uid }) => { if (uid === id) render(); }));

    const info = this.session.getSubagent(id);
    const title = info ? `${info.agentType}${info.status === 'running' ? ' (running)' : ''}` : 'Subagent';
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
    page.append(transcript.root);

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
