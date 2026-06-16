/*
 * Agent picker — a quick-switcher over agents and conversations, in one fuzzy list:
 *   - the currently-open agents (`quilx.agents`), each with a status indicator
 *     (shared with the WorkbenchList sidebar) — selecting one reveals its terminal;
 *   - the project's resumable past conversations (newest first, excluding any
 *     already open) — selecting one resumes it as a fresh agent;
 *   - an action row that starts a NEW agent with the typed prompt.
 *
 * Past conversations are listed only when `onResume` is supplied; the "send to
 * agent" caller omits it (text can't be delivered to a dead conversation), so it
 * sees just the live agents.
 *
 * Items are keyed by a synthetic value and mapped back to their agent/session, so
 * colliding titles (two `claude` agents read alike) need no disambiguation.
 */
import { Gtk } from '../gi.ts';
import { openPicker, type PickerItem } from './Picker.ts';
import { proseMarkup, escapeMarkup, PROSE_LINE_HEIGHT } from './proseMarkup.ts';
import { agentStatusMarkup, agentModeMarkup, agentWorktreeMarkup } from './agentStatusIcon.ts';
import { listAgentSessions, relativeTime, type AgentSession } from '../agentSessions.ts';
import { quilx } from '../quilx.ts';
import type { AgentTerminal } from './AgentTerminal.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

export interface AgentPickerOptions {
  /** Reveal and focus an existing agent's terminal (or, for send-to, its target). */
  onActivate: (agent: AgentTerminal) => void;
  /** Launch a new agent with the typed prompt. */
  onStart: (prompt: string) => void;
  /** Resume a past conversation as a fresh agent. When supplied, the project's
   *  resumable conversations are listed alongside the open agents. */
  onResume?: (session: AgentSession) => void;
  /** Entry placeholder (e.g. "Send to agent…"). Defaults to "Open agent or conversation…". */
  placeholder?: string;
}

type Entry =
  | { kind: 'agent'; agent: AgentTerminal }
  | { kind: 'session'; session: AgentSession };

export function openAgentPicker(host: Overlay, options: AgentPickerOptions): void {
  const byValue = new Map<string, Entry>();
  const items: PickerItem[] = [];

  // Open agents first, in launch order. Track their session ids so a resumable
  // conversation that's already open isn't also listed below.
  const liveSessions = new Set<string>();
  quilx.agents.getAgents().forEach((agent, i) => {
    const value = `agent:${i}`;
    byValue.set(value, { kind: 'agent', agent });
    items.push({ value, text: agent.title });
    if (agent.sessionId) liveSessions.add(agent.sessionId);
  });

  // Then the resumable past conversations (newest first), if the caller handles them.
  if (options.onResume) {
    for (const session of listAgentSessions(process.cwd())) {
      if (liveSessions.has(session.id)) continue;
      const value = `session:${session.id}`;
      byValue.set(value, { kind: 'session', session });
      items.push({ value, text: session.label });
    }
  }

  openPicker({
    host,
    placeholder: options.placeholder ?? 'Open agent or conversation…',
    proseEntry: true, // titles/labels are prose, not paths/identifiers
    items,
    formatMain: (item, positions) => {
      const entry = byValue.get(item.value);
      if (entry?.kind === 'agent') {
        // The shared status indicator before the title (and a permission-mode
        // badge when not in `default`); the title can carry `backtick` spans
        // (claude reports them), rendered as prose. A linked-worktree badge, when
        // present, is shown right-aligned as the detail.
        const mode = agentModeMarkup(entry.agent.permissionMode);
        const worktree = agentWorktreeMarkup(entry.agent.worktree);
        const lead = mode ? `${agentStatusMarkup(entry.agent.status)} ${mode}` : agentStatusMarkup(entry.agent.status);
        return {
          main: `${lead} ${proseMarkup(item.text, positions)}`,
          ...(worktree ? { detail: `<span face="Sans" line_height="${PROSE_LINE_HEIGHT}">${worktree}</span>` } : {}),
        };
      }
      // A past conversation: prose label (untitled ones dimmed) + a muted, right-
      // aligned "time ago".
      const session = entry?.session;
      return {
        main: proseMarkup(item.text, positions, !session?.titled),
        detail: `<span face="Sans" line_height="${PROSE_LINE_HEIGHT}">${escapeMarkup(relativeTime(session?.modified ?? 0))}</span>`,
      };
    },
    onSelect: (value) => {
      const entry = byValue.get(value);
      if (!entry) return;
      if (entry.kind === 'agent') options.onActivate(entry.agent);
      else options.onResume?.(entry.session);
    },
    // Typing a prompt that isn't an existing agent/conversation starts a new agent.
    action: {
      label: (query) => `Start agent: ${query}`,
      run: (query) => options.onStart(query),
    },
  });
}
