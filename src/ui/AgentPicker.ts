/*
 * Agent picker — a quick-switcher over agents and conversations, in one fuzzy list:
 *   - the currently-open agents (`zym.agents`), each with a status indicator
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
import Gtk from 'gi:Gtk-4.0';
import { openPicker, HIGHLIGHT_COLOR, type PickerItem } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { Icons } from './icons.ts';
import { proseMarkup, escapeMarkup, PROSE_LINE_HEIGHT } from './proseMarkup.ts';
import * as Path from 'node:path';
import { agentStatusMarkup, agentWorktreeMarkup } from './agentStatusIcon.ts';
import { listResumableSessions, relativeTime, type AgentSession } from '../agentSessions.ts';
import { zym } from '../zym.ts';
import type { WorktreeInfo } from '../git.ts';
import type { Agent } from '../agents/types.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

export interface AgentPickerOptions {
  /** Reveal and focus an existing agent's terminal (or, for send-to, its target). */
  onActivate: (agent: Agent) => void;
  /** Launch a new agent with the typed prompt. When omitted, the type-a-prompt action row is
   *  not offered (use `newAgent` for a "start one" entry that opens the launcher instead). */
  onStart?: (prompt: string) => void;
  /** A persistent, highlighted entry (shown last, named by `label`) for starting a brand-new agent
   *  — e.g. "Send to new agent". Selecting it runs `run` (typically opening the AgentLauncher so the
   *  user picks model/worktree). Present immediately, even with no running agents. */
  newAgent?: { label: string; run: () => void };
  /** Resume a past conversation as a fresh agent. When supplied, the project's
   *  resumable conversations are listed alongside the open agents. */
  onResume?: (session: AgentSession) => void;
  /** Project roots to list resumable conversations from — the repo's worktrees, so
   *  a worktree-launched conversation appears too. Defaults to `[process.cwd()]`. */
  sessionRoots?: string[];
  /** Entry placeholder (e.g. "Send to agent…"). Defaults to "Open agent or conversation…". */
  placeholder?: string;
  /** A live agent's worktree (for the right-aligned branch badge), computed from its
   *  workbench cwd by the caller (the agent no longer stores it). */
  agentWorktree?: (agent: Agent) => WorktreeInfo | null;
}

type Entry =
  | { kind: 'agent'; agent: Agent; worktree: WorktreeInfo | null }
  | { kind: 'session'; session: AgentSession }
  | { kind: 'new' };

export function openAgentPicker(host: Overlay, options: AgentPickerOptions): void {
  const items: PickerItem[] = [];

  // Open agents first, in launch order. Track their session ids so a resumable
  // conversation that's already open isn't also listed below. Each item carries
  // its `Entry` on `data`, so the row and selection read it straight off the item.
  const liveSessions = new Set<string>();
  zym.agents.getAgents().forEach((agent, i) => {
    // Resolve the worktree badge once here (a git/FS call) rather than per row per keystroke.
    const worktree = options.agentWorktree?.(agent) ?? null;
    items.push({ value: `agent:${i}`, text: agent.title, data: { kind: 'agent', agent, worktree } satisfies Entry });
    if (agent.sessionId) liveSessions.add(agent.sessionId);
  });

  // Then the resumable past conversations (newest first), if the caller handles them.
  if (options.onResume) {
    for (const session of listResumableSessions(options.sessionRoots ?? [process.cwd()])) {
      if (liveSessions.has(session.id)) continue;
      items.push({ value: `session:${session.id}`, text: session.label, data: { kind: 'session', session } satisfies Entry });
    }
  }

  // Last: a persistent "start a new agent" entry (when the caller supplies one), highlighted so it
  // reads as the special action rather than another agent to send to.
  if (options.newAgent) {
    items.push({ value: '\0new-agent', text: options.newAgent.label, data: { kind: 'new' } satisfies Entry });
  }

  openPicker({
    host,
    placeholder: options.placeholder ?? 'Open agent or conversation…',
    proseEntry: true, // titles/labels are prose, not paths/identifiers
    items,
    renderRow: (item, positions) => {
      const entry = item.data as Entry;
      if (entry.kind === 'agent') {
        // The shared status indicator before the title; the title can carry
        // `backtick` spans (claude reports them), rendered as prose. A linked-
        // worktree badge, when present, is shown right-aligned as the detail.
        const worktree = agentWorktreeMarkup(entry.worktree);
        const lead = agentStatusMarkup(entry.agent.status);
        return renderRowSingleLine({
          main: `${lead} ${proseMarkup(item.text, positions)}`,
          detail: worktree ? `<span face="Sans" line_height="${PROSE_LINE_HEIGHT}">${worktree}</span>` : undefined,
        });
      }
      // The "start a new agent" action: an accent-coloured glyph + label, set apart from the agent
      // rows above it.
      if (entry.kind === 'new') {
        return renderRowSingleLine({
          icon: Icons.newAgent,
          iconColor: HIGHLIGHT_COLOR,
          main: `<span foreground="${HIGHLIGHT_COLOR}">${proseMarkup(item.text, positions)}</span>`,
        });
      }
      // A past conversation: prose label (untitled ones dimmed) + a muted, right-
      // aligned "time ago", prefixed with the worktree name when the conversation
      // ran outside the main project cwd (so it resumes there — branch/worktree).
      const session = entry.session;
      const ranElsewhere = session.cwd && session.cwd !== process.cwd();
      const where = ranElsewhere ? `${escapeMarkup(Path.basename(session.cwd!))} · ` : '';
      return renderRowSingleLine({
        main: proseMarkup(item.text, positions, !session.titled),
        detail: `<span face="Sans" line_height="${PROSE_LINE_HEIGHT}">${where}${escapeMarkup(relativeTime(session.modified ?? 0))}</span>`,
      });
    },
    onSelect: (_value, item) => {
      const entry = item.data as Entry;
      if (entry.kind === 'agent') options.onActivate(entry.agent);
      else if (entry.kind === 'new') options.newAgent?.run();
      else options.onResume?.(entry.session);
    },
    // Typing a prompt that isn't an existing agent/conversation starts a new agent (when the
    // caller wires `onStart`; the review flow uses the `newAgent` entry + launcher instead).
    action: options.onStart
      ? { label: (query) => `Start agent: ${query}`, run: (query) => options.onStart!(query) }
      : undefined,
  });
}
