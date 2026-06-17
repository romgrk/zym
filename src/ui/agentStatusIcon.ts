/*
 * agentStatusIcon — the shared agent status indicator. The same dot/cog the
 * WorkbenchList sidebar shows on each agent row is reused by the agent picker, so
 * the two stay in lockstep: a colored dot (●) for idle/waiting/exited, or the
 * nf-md-cog-sync glyph while the agent is working.
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
import { escapeMarkup } from './proseMarkup.ts';
import type { AgentStatus, AgentTerminal, WorktreeInfo } from './AgentTerminal.ts';

export const STATUS_DOT = '●';
export const WORKING_GLYPH = String.fromCodePoint(0xf1978); // nf-md-cog-sync

// Status → indicator color: working (muted cog), waiting on the user (warning/
// amber), idle/ready (success/green), exited (muted).
const STATUS_COLOR: Record<AgentStatus, string> = {
  working: theme.ui.textMuted,
  waiting: theme.ui.warning,
  idle: theme.ui.success,
  exited: theme.ui.textMuted,
};

const DOT_CLASSES = ['quilx-agent-working', 'quilx-agent-waiting', 'quilx-agent-idle', 'quilx-agent-exited'];
// Slow fade in/out applied while an agent needs attention (waiting on the user, or
// finished but unseen) — see AgentTerminal.needsAttention.
const BLINK_CLASS = 'quilx-agent-blink';
addStyles(`
  .quilx-agent-working { color: ${STATUS_COLOR.working}; }
  .quilx-agent-waiting { color: ${STATUS_COLOR.waiting}; }
  .quilx-agent-idle    { color: ${STATUS_COLOR.idle}; }
  .quilx-agent-exited  { color: ${STATUS_COLOR.exited}; }
  /* Hold full visibility ~0.6s (88%→12% across the wrap), fade down, hold fully
     invisible ~0.2s (46%→54%), fade back up — all linear, over 2.4s. */
  @keyframes quilx-agent-blink-kf {
    0%   { opacity: 1; }
    12%  { opacity: 1; }
    46%  { opacity: 0; }
    54%  { opacity: 0; }
    88%  { opacity: 1; }
    100% { opacity: 1; }
  }
  .${BLINK_CLASS} {
    animation-name: quilx-agent-blink-kf;
    animation-duration: 2.4s;
    animation-timing-function: linear;
    animation-iteration-count: infinite;
  }
`);

// The working cog is rendered in the icon font; the plain dot uses the default
// font. Built lazily and shared across every icon.
let iconAttrs: InstanceType<typeof Pango.AttrList> | null = null;
function iconFontAttrs(): InstanceType<typeof Pango.AttrList> {
  if (!iconAttrs) {
    iconAttrs = Pango.AttrList.new();
    iconAttrs.insert(Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)));
  }
  return iconAttrs;
}

/** Set `label` to reflect `status`: the colored dot, or the cog glyph while working. */
export function applyAgentStatus(label: InstanceType<typeof Gtk.Label>, status: AgentStatus): void {
  for (const cls of DOT_CLASSES) label.removeCssClass(cls);
  label.addCssClass(`quilx-agent-${status}`); // idle | working | waiting | exited
  if (status === 'working') {
    label.setText(WORKING_GLYPH);
    label.setAttributes(iconFontAttrs());
  } else {
    label.setText(STATUS_DOT);
    label.setAttributes(null);
  }
}

/** Toggle the slow fade in/out blink that flags an agent needing attention. */
export function applyAgentBlink(label: InstanceType<typeof Gtk.Label>, blink: boolean): void {
  if (blink) label.addCssClass(BLINK_CLASS);
  else label.removeCssClass(BLINK_CLASS);
}

/**
 * A live status indicator for `agent`: a Gtk.Label that re-renders as the agent's
 * status changes. Call `dispose` to unsubscribe (e.g. when a row is rebuilt).
 */
export function createAgentStatusIcon(agent: AgentTerminal): {
  widget: InstanceType<typeof Gtk.Label>;
  dispose: () => void;
} {
  const label = new Gtk.Label({ label: STATUS_DOT });
  const update = () => {
    applyAgentStatus(label, agent.status);
    applyAgentBlink(label, agent.needsAttention);
  };
  update();
  // Status drives the dot/colour; attention drives the blink — either can change
  // independently (e.g. viewing a still-`waiting` agent stops its blink).
  const unsubStatus = agent.onDidChangeStatus(update);
  const unsubAttention = agent.onDidChangeAttention(update);
  return { widget: label, dispose: () => { unsubStatus(); unsubAttention(); } };
}

/**
 * Pango markup for an agent's status glyph — the same indicator as
 * `createAgentStatusIcon`, for contexts that render markup, not widgets (picker
 * rows). The color is inlined since a markup row carries no CSS class.
 */
export function agentStatusMarkup(status: AgentStatus): string {
  const color = STATUS_COLOR[status];
  if (status === 'working') {
    return `<span foreground="${color}" font_family="${ICON_FONT_FAMILY}">${WORKING_GLYPH}</span>`;
  }
  return `<span foreground="${color}">${STATUS_DOT}</span>`;
}

// --- Worktree ---------------------------------------------------------------

/** Pango markup for a linked-worktree badge (git glyph + branch/worktree name),
 *  or null when the agent isn't in a linked worktree (the common case). */
export function agentWorktreeMarkup(worktree: WorktreeInfo | null): string | null {
  if (!worktree?.linked) return null;
  const name = worktree.branch ?? worktree.name;
  return (
    `<span foreground="${theme.ui.textMuted}">` +
    `<span font_family="${ICON_FONT_FAMILY}">${Icons.git}</span> ${escapeMarkup(name)}</span>`
  );
}
