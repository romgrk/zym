/*
 * Action runner — a picker over the runnable actions an agent has registered
 * (via the set_actions bridge tool). Each action is a two-column row (the label
 * on the left, its shell command muted on the right); the chosen action is handed
 * back to the caller, which runs it in a terminal tab. The default action sorts
 * first and is tagged so it reads as the recommended choice.
 */
import { openPicker, highlightSegment, type PickerItem } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { Icons } from './icons.ts';
import { Gtk } from '../gi.ts';
import { defaultAction, type AgentAction } from '../agents/actions.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

/**
 * Open the action runner over `actions`. `onRun` is called with the chosen action;
 * the caller runs its command. The default action is listed first.
 */
export function openActionRunner(host: Overlay, actions: AgentAction[], onRun: (action: AgentAction) => void): void {
  const fallback = defaultAction(actions);
  // Default first, then launch order.
  const ordered = [...actions].sort((a, b) => Number(b === fallback) - Number(a === fallback));
  const byId = new Map(ordered.map((a) => [a.id, a]));

  const items: PickerItem[] = ordered.map((action) => {
    const label = action === fallback ? `${action.label}  (default)` : action.label;
    const text = `${label}  ${action.command}`;
    // Carry the label length so the row can split label (left) from command
    // (right) — the label may itself contain a double space, so it can't be
    // recovered from `text` by searching for the separator.
    return { value: action.id, text, data: label.length };
  });

  openPicker({
    host,
    placeholder: 'Run agent action…',
    promptIcon: Icons.terminal,
    items,
    error: items.length === 0 ? 'This agent has registered no actions' : undefined,
    // Label on the left, its shell command muted on the right.
    renderRow: (item, positions) => {
      const split = item.data as number;
      return renderRowSingleLine({
        main: highlightSegment(item.text, 0, split, positions),
        detail: highlightSegment(item.text, split + 2, item.text.length, positions),
      });
    },
    onSelect: (id) => {
      const action = byId.get(id);
      if (action) onRun(action);
    },
  });
}
