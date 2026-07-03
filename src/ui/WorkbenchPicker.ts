/*
 * Workbench picker — a fuzzy quick-switcher over the open workbenches (the
 * "persons": the user, and each running agent), in one list. Selecting one
 * activates its workbench, swapping which one the window shows (see
 * AppWindow.activateWorkbench).
 *
 * It parallels the agent picker but switches *workbenches* rather than revealing
 * agents: it always lists the user's own workbench first (the agent picker never
 * shows the user) and marks the currently-active one. The list order matches the
 * WorkbenchList sidebar and the `workbench:next`/`previous` cycle ([user, …agents]).
 *
 * Each row carries its `WorkbenchInfo` on `data`, so colliding titles (two
 * `claude` agents read alike) need no disambiguation. State is snapshotted at open
 * (like the agent picker) — a short-lived switcher doesn't track live changes.
 */
import * as Os from 'node:os';
import * as Path from 'node:path';
import Gtk from 'gi:Gtk-4.0';
import { openPicker, HIGHLIGHT_COLOR, type PickerItem } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { iconSpan } from './icons.ts';
import { proseMarkup, escapeMarkup, PROSE_LINE_HEIGHT } from './proseMarkup.ts';
import { agentStatusMarkup, agentWorktreeMarkup } from './agentStatusIcon.ts';
import { NERDFONT } from './nerdfont.ts';
import { worktreeInfo } from '../git.ts';
import { type Owner, isProject } from './workbench/Owner.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

const USER_GLYPH = NERDFONT.SOCIAL.USER; // the user's own workbench (matches the sidebar)

export interface WorkbenchInfo {
  /** Who owns the workbench: a project, or an Agent. */
  owner: Owner;
  /** The workbench's current root directory (an agent may sit in a worktree). */
  cwd: string;
  /** Whether this is the currently-shown workbench. */
  active: boolean;
}

export interface WorkbenchPickerOptions {
  /** The open workbenches, in sidebar order ([…projects, …agents]). */
  workbenches: WorkbenchInfo[];
  /** Activate the chosen workbench (AppWindow.activateOwner). */
  onActivate: (owner: Owner) => void;
  /** Label for a project workbench. Defaults to the OS username (as the sidebar). */
  userName?: string;
}

export function openWorkbenchPicker(host: Overlay, options: WorkbenchPickerOptions): void {
  const userName = options.userName ?? Os.userInfo().username;

  // One item per workbench, keyed by index (titles can collide). The owner rides
  // on `data`; the matched `text` is the person's label (username / agent title).
  const items: PickerItem[] = options.workbenches.map((wb, i) => ({
    value: `workbench:${i}`,
    text: isProject(wb.owner) ? userName : wb.owner.title,
    data: wb,
  }));

  openPicker({
    host,
    placeholder: 'Switch to workbench…',
    proseEntry: true, // names/titles are prose, not paths/identifiers
    items,
    renderRow: (item, positions) => {
      const wb = item.data as WorkbenchInfo;
      // The leading glyph mirrors the sidebar: a person icon for the user, the
      // shared status indicator for an agent.
      const lead = isProject(wb.owner) ? iconSpan(USER_GLYPH) : agentStatusMarkup(wb.owner.status);
      return renderRowSingleLine({
        main: `${lead} ${proseMarkup(item.text, positions)}`,
        detail: workbenchDetail(wb),
        detailMuted: false, // each part sets its own emphasis (the "current" tag stays vivid)
      });
    },
    onSelect: (_value, item) => options.onActivate((item.data as WorkbenchInfo).owner),
  });
}

// The right-aligned detail: a vivid "current" tag on the active workbench, then
// where it's rooted — an agent's linked-worktree badge (git glyph + branch) when
// it has one, else the cwd's basename. Only "current" is highlighted (the location
// is muted), so the caller turns `detailMuted` off and each part carries its own
// markup.
function workbenchDetail(wb: WorkbenchInfo): string {
  const parts: string[] = [];
  if (wb.active) {
    parts.push(`<span foreground="${HIGHLIGHT_COLOR}" face="Sans" line_height="${PROSE_LINE_HEIGHT}">current</span>`);
  }
  // Compute the agent's worktree badge from its workbench cwd (the source of truth).
  const worktree = isProject(wb.owner) ? null : agentWorktreeMarkup(worktreeInfo(wb.cwd));
  parts.push(
    worktree ??
      `<span alpha="55%" face="Sans" line_height="${PROSE_LINE_HEIGHT}">${escapeMarkup(Path.basename(wb.cwd))}</span>`,
  );
  return parts.join('   ');
}
