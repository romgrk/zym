/*
 * cards.ts — the permission prompt the agent surfaces while it waits for approval.
 * (AskUserQuestion lives in QuestionCard.ts.) A factory returning the widget; the
 * conversation wires the decision to the session. The prompt REPLACES the input
 * (it isn't embedded in the tool row) — see AgentConversation's interaction slot.
 */
import Gtk from 'gi:Gtk-4.0';
import { theme } from '../../theme/theme.ts';
import { wrappingLabel, escapeMarkup, setMarkupSafe } from '../proseMarkup.ts';
import type { CompositeDisposable } from '../../util/eventKit.ts';
import type { DiffLine } from './toolRows.ts';

type Box = InstanceType<typeof Gtk.Box>;
type Widget = InstanceType<typeof Gtk.Widget>;

/** The user's response to a permission prompt:
 *  - `accept` / `deny` — allow or refuse this one call;
 *  - `acceptEdits` / `auto` — allow it AND switch the session into that permission
 *    mode (so the like calls that follow stop prompting). */
export type PermissionChoice = 'accept' | 'deny' | 'acceptEdits' | 'auto';

/** The text shown above the buttons: a `title` (for Bash, the command's description)
 *  and an optional `description` (for Bash, the command itself). */
export interface PermissionPromptParts {
  title: string;
  /** A plain command/detail line (Bash). Omitted when `body` carries a richer view. */
  description: string | null;
  /** A richer body widget shown instead of `description` (e.g. an edit-tool diff). */
  body?: Widget;
}

const ACTION_LABELS: Readonly<Record<PermissionChoice, string>> = {
  accept: 'Accept',
  deny: 'Deny',
  acceptEdits: 'Allow edits',
  auto: 'Switch to auto',
};

/** A permission prompt: a title, an optional command/detail line, and a row of equal,
 *  raised action buttons in `choices` order (none is the suggested/primary — the
 *  caller drops `acceptEdits` for non-edit tools). `decide` gets the chosen action;
 *  the caller responds to the session and restores the input. The `clicked` handlers
 *  are registered in `subs` (node-gtk roots them — rule 2). */
export function permissionPrompt(
  subs: CompositeDisposable,
  parts: PermissionPromptParts,
  choices: readonly PermissionChoice[],
  decide: (choice: PermissionChoice) => void,
): Box {
  const root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
  root.addCssClass('conversation-perm-prompt');

  const title = wrappingLabel({ xalign: 0 });
  title.addCssClass('conversation-perm-title');
  setMarkupSafe(title, `<b>${escapeMarkup(parts.title)}</b>`, parts.title);
  root.append(title);

  if (parts.body) {
    root.append(parts.body); // a richer body (e.g. an edit-tool diff)
  } else if (parts.description) {
    const detail = wrappingLabel({ xalign: 0, selectable: true, label: parts.description });
    detail.addCssClass('conversation-perm-command');
    root.append(detail);
  }

  const actions = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
  actions.addCssClass('conversation-perm-actions');
  for (const choice of choices) {
    const button = new Gtk.Button({ label: ACTION_LABELS[choice] });
    button.addCssClass('raised'); // raised (not flat); none is the suggested/primary
    subs.connect(button, 'clicked', () => decide(choice));
    actions.append(button);
  }
  root.append(actions);

  return root;
}

/** A scrollable, height-capped diff view for an edit-tool permission body: signed,
 *  colour-coded monospace lines (added green, removed red, context dimmed). Caps tall
 *  diffs at a comfortable height and scrolls past it. */
export function permissionDiffView(lines: DiffLine[]): Widget {
  const shown = lines.slice(0, 600); // bound the markup/labels for a pathological diff
  const label = wrappingLabel({ xalign: 0, selectable: true });
  label.addCssClass('conversation-perm-diff-body');
  const markup = shown.map((line) => {
    const text = escapeMarkup(`${line.sign} ${line.text}`);
    if (line.sign === '+') return `<span foreground="${theme.ui.status.success}">${text}</span>`;
    if (line.sign === '-') return `<span foreground="${theme.ui.status.error}">${text}</span>`;
    return `<span alpha="55%">${text}</span>`; // unchanged context line, dimmed
  }).join('\n');
  setMarkupSafe(label, markup, shown.map((line) => `${line.sign} ${line.text}`).join('\n'));

  const scroller = new Gtk.ScrolledWindow();
  scroller.addCssClass('conversation-perm-diff');
  scroller.setPolicy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
  scroller.setMaxContentHeight(220); // comfortable max — scroll past it
  scroller.setPropagateNaturalHeight(true);
  scroller.setOverflow(Gtk.Overflow.HIDDEN); // clip to the rounded frame
  scroller.setChild(label);
  return scroller;
}
