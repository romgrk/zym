/*
 * cards.ts — interactive cards the agent injects into the conversation flow: an
 * allow/deny permission prompt, and the AskUserQuestion split (choice list +
 * detail pane). Factory functions returning the card widget; the conversation
 * wires the decision back to the session.
 */
import { Gtk } from '../../gi.ts';
import { theme } from '../../theme/theme.ts';
import { escapeMarkup, setMarkupSafe, clearChildren } from '../proseMarkup.ts';
import { iconSpan } from '../icons.ts';
import { NERDFONT } from '../nerdfont.ts';
import { summarizeInput } from './format.ts';
import type { PermissionRequest, QuestionRequest } from '../../agents/claude-sdk/SdkSession.ts';

type Box = InstanceType<typeof Gtk.Box>;

/** An allow/deny permission card. `decide` receives the user's choice; the caller
 *  removes the card from the transcript afterwards. */
export function permissionCard(req: PermissionRequest, decide: (allow: boolean) => void): Box {
  const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
  card.addCssClass('quilx-conversation-perm');
  const title = new Gtk.Label({ xalign: 0, label: `Allow ${req.toolName}?` });
  const detail = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, label: summarizeInput(req.input) });
  detail.addCssClass('quilx-conversation-tool');
  const buttons = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
  const allow = new Gtk.Button({ label: 'Allow' });
  const deny = new Gtk.Button({ label: 'Deny' });
  allow.on('clicked', () => decide(true));
  deny.on('clicked', () => decide(false));
  buttons.append(allow);
  buttons.append(deny);
  card.append(title);
  card.append(detail);
  card.append(buttons);
  return card;
}

/** AskUserQuestion: each question is a split — a choice list (left) and a detail
 *  pane (right) showing the focused choice's description. Single-select uses a
 *  browse list (first preselected); multi-select toggles rows. On Submit/Skip,
 *  `onAnswer` gets the chosen labels per question and the card swaps itself to a
 *  summary record in place. */
export function questionCard(
  req: QuestionRequest,
  onAnswer: (answers: Array<{ header: string; labels: string[] }>) => void,
): Box {
  const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 });
  card.addCssClass('quilx-conversation-question');

  const getters: Array<() => string[]> = []; // per-question selected labels
  for (const q of req.questions) {
    if (q.header) {
      const h = new Gtk.Label({ xalign: 0, label: q.header });
      h.addCssClass('quilx-conversation-question-h');
      card.append(h);
    }
    if (q.question) card.append(new Gtk.Label({ xalign: 0, wrap: true, selectable: true, label: q.question }));

    const list = new Gtk.ListBox();
    list.addCssClass('quilx-conversation-question-list');
    list.setSelectionMode(q.multiSelect ? Gtk.SelectionMode.MULTIPLE : Gtk.SelectionMode.SINGLE);

    const hasDetails = q.options.some((o) => !!o.description);
    const detail = new Gtk.Label({ xalign: 0, yalign: 0, wrap: true, selectable: true, hexpand: true });
    detail.addCssClass('quilx-conversation-question-detail');

    const rows: Array<{ row: InstanceType<typeof Gtk.ListBoxRow>; label: string }> = [];
    q.options.forEach((opt) => {
      const row = new Gtk.ListBoxRow();
      const rl = new Gtk.Label({ xalign: 0, label: opt.label });
      rl.addCssClass('quilx-conversation-question-opt');
      row.setChild(rl);
      list.append(row);
      rows.push({ row, label: opt.label });
      if (hasDetails) {
        // Focusing a choice (keyboard nav or click) shows its details on the right.
        const focus = new Gtk.EventControllerFocus();
        focus.on('enter', () => detail.setText(opt.description ?? ''));
        row.addController(focus);
      }
    });

    // Single-select: preselect the first choice (a sensible default); show its detail.
    if (!q.multiSelect && rows.length > 0) list.selectRow(rows[0].row);
    if (hasDetails) detail.setText(q.options[0]?.description ?? '');

    if (hasDetails) {
      const split = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 });
      split.addCssClass('quilx-conversation-question-split');
      list.setHexpand(false);
      list.setValign(Gtk.Align.START);
      split.append(list);
      split.append(detail);
      card.append(split);
    } else {
      card.append(list);
    }

    getters.push(() => rows.filter((r) => r.row.isSelected()).map((r) => r.label));
  }

  const buttons = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
  const submit = new Gtk.Button({ label: 'Submit' });
  submit.addCssClass('suggested-action');
  const skip = new Gtk.Button({ label: 'Skip' });
  const answer = (skipped: boolean) => {
    const answers = req.questions.map((q, i) => ({ header: q.header || q.question, labels: skipped ? [] : getters[i]() }));
    onAnswer(answers);
    // Replace the interactive card with a record of the choice — and drop the
    // active (blue) border.
    clearChildren(card);
    card.removeCssClass('quilx-conversation-question');
    card.addCssClass('quilx-conversation-question-answered');
    const picked = answers.filter((a) => a.labels.length > 0);
    const text = picked.length > 0
      ? picked.map((a) => `${a.header}: ${a.labels.join(', ')}`).join('   ·   ')
      : 'No answer selected';
    const label = new Gtk.Label({ xalign: 0, wrap: true, selectable: true });
    setMarkupSafe(label, `${iconSpan(NERDFONT.STATUS.CHECK, theme.ui.status.success)}  ${escapeMarkup(text)}`, text);
    card.append(label);
  };
  submit.on('clicked', () => answer(false));
  skip.on('clicked', () => answer(true));
  buttons.append(submit);
  buttons.append(skip);
  card.append(buttons);

  return card;
}
