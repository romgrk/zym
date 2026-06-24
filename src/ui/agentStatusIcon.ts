/*
 * agentStatusIcon — the shared agent status indicator. The same glyph the
 * WorkbenchList sidebar shows on each agent row is reused by the agent picker, so
 * the two stay in lockstep: a colored dot (●) for idle/waiting/exited, or the
 * nf-fa-ellipsis_h glyph (…) while the agent is working.
 *
 * `createAgentStatusIcon` returns a live, self-updating Gtk.Label — for contexts
 * that hold real widgets (the sidebar list). `agentStatusMarkup` returns the
 * equivalent Pango markup — for contexts that render markup rather than widgets
 * (the picker rows, which are markup-only labels).
 */
import { Gtk, Pango } from '../gi.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { Icons } from './icons.ts';
import { NERDFONT } from './nerdfont.ts';
import { escapeMarkup } from './proseMarkup.ts';
import type { AgentStatus, WorktreeInfo } from './AgentTerminal.ts';
import type { Agent } from '../agents/types.ts';

export const STATUS_DOT = '●';
export const DISCONNECTED_DOT = '○'; // hollow: resumed but not reconnected
export const WORKING_GLYPH = NERDFONT.STATUS.WORKING;

// Status → indicator color for the *colored* states (waiting on the user →
// warning/amber, idle/ready → success/green), used by the *markup* path only —
// markup can't read CSS variables, so it interpolates the literal. The CSS path
// uses the matching var(--t-ui-status-*) directly. The muted states — working
// (ellipsis), exited, and disconnected (resumed-not-reconnected) — carry no color;
// they dim the inherited foreground (Adwaita's muted idiom: `--dim-opacity` in
// CSS, `alpha="55%"` in markup) rather than picking a grey.
const STATUS_COLOR: Partial<Record<AgentStatus, string>> = {
  waiting: theme.ui.status.warning,
  idle: theme.ui.status.success,
};

const DOT_CLASSES = ['zym-agent-working', 'zym-agent-waiting', 'zym-agent-idle', 'zym-agent-exited', 'zym-agent-disconnected'];
addStyles(`
  .zym-agent-working { color: var(--t-ui-text-muted); }
  .zym-agent-waiting { color: var(--t-ui-status-warning); }
  .zym-agent-idle    { color: var(--t-ui-status-success); }
  .zym-agent-exited  { opacity: var(--dim-opacity); }
  .zym-agent-disconnected { opacity: var(--dim-opacity); }
`);

// The working ellipsis is rendered in the icon font; the plain dot uses the default
// font. Built lazily and shared across every icon.
let iconAttrs: InstanceType<typeof Pango.AttrList> | null = null;
function iconFontAttrs(): InstanceType<typeof Pango.AttrList> {
  if (!iconAttrs) {
    iconAttrs = Pango.AttrList.new();
    iconAttrs.insert(Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)));
  }
  return iconAttrs;
}

/** Set `label` to reflect `status`: the colored dot, or the ellipsis glyph while working. */
export function applyAgentStatus(label: InstanceType<typeof Gtk.Label>, status: AgentStatus): void {
  for (const cls of DOT_CLASSES) label.removeCssClass(cls);
  label.addCssClass(`zym-agent-${status}`); // idle | working | waiting | exited
  if (status === 'working') {
    label.setText(WORKING_GLYPH);
    label.setAttributes(iconFontAttrs());
  } else {
    label.setText(status === 'disconnected' ? DISCONNECTED_DOT : STATUS_DOT);
    label.setAttributes(null);
  }
}

/**
 * A live status indicator for `agent`: a Gtk.Label that re-renders as the agent's
 * status changes. Call `dispose` to unsubscribe (e.g. when a row is rebuilt).
 */
export function createAgentStatusIcon(agent: Agent): {
  widget: InstanceType<typeof Gtk.Label>;
  dispose: () => void;
} {
  const label = new Gtk.Label({ label: STATUS_DOT });
  const update = () => applyAgentStatus(label, agent.status);
  update();
  const unsubStatus = agent.onDidChangeStatus(update);
  return { widget: label, dispose: unsubStatus };
}

/**
 * Pango markup for an agent's status glyph — the same indicator as
 * `createAgentStatusIcon`, for contexts that render markup, not widgets (picker
 * rows). The color is inlined since a markup row carries no CSS class.
 */
export function agentStatusMarkup(status: AgentStatus): string {
  const color = STATUS_COLOR[status];
  // Colored states carry an explicit foreground; the muted states dim the
  // inherited foreground (alpha="55%") instead — see STATUS_COLOR.
  const fg = color ? `foreground="${color}"` : `alpha="55%"`;
  if (status === 'working') {
    return `<span ${fg} font_family="${ICON_FONT_FAMILY}">${WORKING_GLYPH}</span>`;
  }
  return `<span ${fg}>${status === 'disconnected' ? DISCONNECTED_DOT : STATUS_DOT}</span>`;
}

/**
 * An agent tab's title: the status glyph prefixed to the agent's name. Adw tab
 * titles are plain text (no markup, no colour), so the dot can't be colour-coded
 * like the sidebar — the waiting state instead drives Adw's native
 * `needs-attention` tab highlight (see AppWindow.updateAgentTab).
 */
export function agentTabTitle(agent: Agent): string {
  const glyph = agent.status === 'working' ? WORKING_GLYPH : STATUS_DOT;
  return `${glyph} ${agent.title}`;
}

// --- Worktree ---------------------------------------------------------------

/** Pango markup for a linked-worktree badge (git glyph + branch/worktree name),
 *  or null when the agent isn't in a linked worktree (the common case). */
export function agentWorktreeMarkup(worktree: WorktreeInfo | null): string | null {
  if (!worktree?.linked) return null;
  const name = worktree.branch ?? worktree.name;
  return (
    `<span alpha="55%">` +
    `<span font_family="${ICON_FONT_FAMILY}">${Icons.git}</span> ${escapeMarkup(name)}</span>`
  );
}

