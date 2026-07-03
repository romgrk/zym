/*
 * Session pickers — the quick-pick over saved (named) sessions for `session:open`
 * and `session:delete`, plus the prose name-prompt shared by save-as and rename.
 *
 * Mirrors WorkbenchPicker: each row carries its `SessionState` on `data` (labels can
 * collide), is labelled via `SessionManager.label`, and shows the last-saved relative
 * time — plus a vivid "current" tag on the active session. See
 * docs/session-management.md.
 */
import Gtk from 'gi:Gtk-4.0';
import { openPicker, HIGHLIGHT_COLOR, type PickerItem } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { proseMarkup, escapeMarkup, PROSE_LINE_HEIGHT } from './proseMarkup.ts';
import { relativeTime } from '../core/relativeTime.ts';
import { zym } from '../zym.ts';
import type { SessionState } from '../SessionManager.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

export interface SessionPickerOptions {
  /** The saved sessions to list (from `zym.session.list()`). */
  sessions: SessionState[];
  /** The active session's name, marked "current" in the list (null = unnamed). */
  activeName: string | null;
  placeholder: string;
  /** Message shown in place of the list when there are no saved sessions. */
  emptyMessage?: string;
  /** Chosen session (open it / delete it). */
  onSelect: (state: SessionState) => void;
}

/** A fuzzy quick-pick over saved sessions; newest first. */
export function openSessionPicker(host: Overlay, options: SessionPickerOptions): void {
  const { sessions, activeName } = options;
  // Newest first; each row keyed by index (labels can collide), state on `data`.
  const ordered = [...sessions].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  const items: PickerItem[] = ordered.map((state, i) => ({
    value: `session:${i}`,
    text: zym.session.label(state),
    data: state,
  }));

  openPicker({
    host,
    placeholder: options.placeholder,
    proseEntry: true, // session names are prose, not paths
    items,
    error: items.length === 0 ? (options.emptyMessage ?? 'No saved sessions') : undefined,
    renderRow: (item, positions) => {
      const state = item.data as SessionState;
      const active = state.name != null && state.name === activeName;
      return renderRowSingleLine({
        main: proseMarkup(item.text, positions),
        detail: sessionDetail(state, active),
        detailMuted: false, // "current" stays vivid; the timestamp sets its own dimming
      });
    },
    onSelect: (_value, item) => options.onSelect(item.data as SessionState),
  });
}

// The right-aligned detail: a vivid "current" tag on the active session, then the
// last-saved relative time (muted). A legacy no-name file (never re-saved) shows
// "unsaved" rather than a bogus epoch.
function sessionDetail(state: SessionState, active: boolean): string {
  const parts: string[] = [];
  if (active) {
    parts.push(`<span foreground="${HIGHLIGHT_COLOR}" face="Sans" line_height="${PROSE_LINE_HEIGHT}">current</span>`);
  }
  const when = state.savedAt ? relativeTime(Date.parse(state.savedAt) / 1000) : 'unsaved';
  parts.push(`<span alpha="55%" face="Sans" line_height="${PROSE_LINE_HEIGHT}">${escapeMarkup(when)}</span>`);
  return parts.join('   ');
}

export interface SessionNamePromptOptions {
  placeholder: string;
  /** Seed text (e.g. the current name when renaming). */
  initial?: string;
  /** The action row's label for the typed name. */
  actionLabel: (name: string) => string;
  /** Called with the trimmed, non-empty name on Enter. */
  onSubmit: (name: string) => void;
}

/** A bare prose prompt for a session name (save-as / rename). */
export function promptSessionName(host: Overlay, options: SessionNamePromptOptions): void {
  openPicker({
    host,
    placeholder: options.placeholder,
    proseEntry: true,
    query: options.initial ?? '',
    items: [],
    hideMatches: true, // a pure prompt — no candidate list, just the entry + action row
    onSelect: () => {},
    action: {
      label: (name) => options.actionLabel(name.trim()),
      visible: (name) => name.trim().length > 0,
      run: (name) => {
        const trimmed = name.trim();
        if (trimmed) options.onSubmit(trimmed);
      },
    },
  });
}
