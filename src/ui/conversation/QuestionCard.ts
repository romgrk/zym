/*
 * QuestionCard — the AskUserQuestion UI. Each question is a page in an Adwaita
 * ViewSwitcher/ViewStack; the user drives it by keyboard:
 *   j/k   move the focused answer        h/l   switch question
 *   enter select the focused answer + advance (submit on the last question)
 *   n     add a note to the focused answer (enter saves / escape cancels)
 * A question with no selected answer is skipped. On submit the card swaps itself
 * to a compact record of the choices.
 */
import { Gtk, Adw, Gdk } from '../../gi.ts';
import { addStyles } from '../../styles.ts';
import { theme } from '../../theme/theme.ts';
import { escapeMarkup, setMarkupSafe, clearChildren } from '../proseMarkup.ts';
import { iconSpan } from '../icons.ts';
import { NERDFONT } from '../nerdfont.ts';
import type { AgentQuestion, QuestionRequest } from '../../agents/claude-sdk/SdkSession.ts';

type Answer = { header: string; labels: string[]; notes?: string };

addStyles(`
  .quilx-q-option { padding: 4px 8px; border-radius: 6px; }
  .quilx-q-option.is-focused { background: var(--t-ui-surface-selected); }
  .quilx-q-note { opacity: 0.7; padding-left: 22px; font-style: italic; }
  .quilx-q-hint { opacity: 0.5; font-size: var(--font-size-small); }
`);

interface Option { row: InstanceType<typeof Gtk.Box>; content: InstanceType<typeof Gtk.Label>; note: InstanceType<typeof Gtk.Label>; }

export class QuestionCard {
  readonly root: InstanceType<typeof Gtk.Box>;
  private readonly stack = new Adw.ViewStack();
  private readonly qs: AgentQuestion[];
  private readonly onAnswer: (answers: Answer[]) => void;
  private readonly opts: Option[][] = []; // [question][option]
  private readonly focused: number[] = [];
  private readonly selected: Array<number | null> = [];
  private readonly notes: string[][] = [];
  private current = 0;
  private answered = false;
  private editing = false;

  constructor(req: QuestionRequest, onAnswer: (answers: Answer[]) => void) {
    this.qs = req.questions;
    this.onAnswer = onAnswer;
    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    this.root.addCssClass('quilx-conversation-question');
    this.root.setFocusable(true);

    if (this.qs.length > 1) {
      const switcher = new Adw.ViewSwitcher();
      switcher.setStack(this.stack);
      switcher.setPolicy(Adw.ViewSwitcherPolicy.WIDE);
      this.root.append(switcher);
    }
    this.root.append(this.stack);

    this.qs.forEach((q, qi) => {
      this.focused.push(0);
      this.selected.push(null);
      this.notes.push(q.options.map(() => ''));
      const page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
      if (q.question) page.append(new Gtk.Label({ xalign: 0, wrap: true, label: q.question }));
      const rows: Option[] = [];
      q.options.forEach((opt, oi) => {
        const content = new Gtk.Label({ xalign: 0, wrap: true });
        const note = new Gtk.Label({ xalign: 0, wrap: true, visible: false });
        note.addCssClass('quilx-q-note');
        const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        row.addCssClass('quilx-q-option');
        row.append(content);
        row.append(note);
        const click = new Gtk.GestureClick();
        click.on('released', () => { if (!this.answered && !this.editing) { this.focused[qi] = oi; this.selected[qi] = oi; this.applyQuestion(qi); } });
        row.addController(click);
        page.append(row);
        rows.push({ row, content, note });
      });
      this.opts.push(rows);
      this.stack.addTitled(page, `q${qi}`, q.header || q.question || `Question ${qi + 1}`);
      this.applyQuestion(qi);
    });

    const hint = new Gtk.Label({ xalign: 0, label: 'j/k answers · h/l questions · enter select · n note' });
    hint.addCssClass('quilx-q-hint');
    this.root.append(hint);

    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number) => this.onKey(keyval));
    this.root.addController(keys);
    this.root.on('map', () => this.root.grabFocus()); // capture keys as soon as shown
  }

  // Re-render a question's option rows for the current focus / selection / notes.
  private applyQuestion(qi: number): void {
    const q = this.qs[qi];
    this.opts[qi].forEach((o, oi) => {
      if (oi === this.focused[qi]) o.row.addCssClass('is-focused'); else o.row.removeCssClass('is-focused');
      const marker = this.selected[qi] === oi
        ? iconSpan(NERDFONT.STATUS.CHECK, theme.ui.status.success)
        : iconSpan(NERDFONT.TASK.OPEN, theme.ui.text.muted);
      const opt = q.options[oi];
      const desc = opt.description ? `  <span foreground="${theme.ui.text.muted}">${escapeMarkup(opt.description)}</span>` : '';
      setMarkupSafe(o.content, `${marker}  <b>${escapeMarkup(opt.label)}</b>${desc}`, opt.label);
      o.note.setText(this.notes[qi][oi]);
      o.note.setVisible(this.notes[qi][oi] !== '');
    });
  }

  private onKey(keyval: number): boolean {
    if (this.answered || this.editing) return false;
    switch (keyval) {
      case Gdk.KEY_j: case Gdk.KEY_Down: this.moveAnswer(1); return true;
      case Gdk.KEY_k: case Gdk.KEY_Up: this.moveAnswer(-1); return true;
      case Gdk.KEY_l: case Gdk.KEY_Right: this.moveQuestion(1); return true;
      case Gdk.KEY_h: case Gdk.KEY_Left: this.moveQuestion(-1); return true;
      case Gdk.KEY_Return: case Gdk.KEY_KP_Enter: this.selectAndAdvance(); return true;
      case Gdk.KEY_n: this.startNote(); return true;
      default: return false;
    }
  }

  private moveAnswer(d: number): void {
    const n = this.qs[this.current].options.length;
    this.focused[this.current] = Math.min(Math.max(this.focused[this.current] + d, 0), n - 1);
    this.applyQuestion(this.current);
  }

  private moveQuestion(d: number): void {
    this.current = Math.min(Math.max(this.current + d, 0), this.qs.length - 1);
    this.stack.setVisibleChildName(`q${this.current}`);
    this.root.grabFocus();
  }

  private selectAndAdvance(): void {
    this.selected[this.current] = this.focused[this.current];
    this.applyQuestion(this.current);
    if (this.current < this.qs.length - 1) this.moveQuestion(1);
    else this.submit();
  }

  // Inline note editor on the focused answer; enter saves, escape cancels.
  private startNote(): void {
    const qi = this.current;
    const oi = this.focused[qi];
    const entry = new Gtk.Entry({ text: this.notes[qi][oi], placeholderText: 'note…' });
    this.opts[qi][oi].row.append(entry);
    this.editing = true;
    entry.grabFocus();
    const finish = (save: boolean) => {
      if (save) this.notes[qi][oi] = entry.getText();
      this.opts[qi][oi].row.remove(entry);
      this.editing = false;
      this.applyQuestion(qi);
      this.root.grabFocus();
    };
    entry.on('activate', () => finish(true)); // Enter
    const keys = new Gtk.EventControllerKey();
    keys.on('key-pressed', (keyval: number) => { if (keyval === Gdk.KEY_Escape) { finish(false); return true; } return false; });
    entry.addController(keys);
  }

  private submit(): void {
    this.answered = true;
    const answers: Answer[] = this.qs.map((q, qi) => {
      const sel = this.selected[qi];
      return sel === null
        ? { header: q.header || q.question, labels: [] }
        : { header: q.header || q.question, labels: [q.options[sel].label], notes: this.notes[qi][sel] || undefined };
    });
    this.onAnswer(answers);

    // Replace the interactive card with a compact record; drop the active border.
    clearChildren(this.root);
    this.root.removeCssClass('quilx-conversation-question');
    this.root.addCssClass('quilx-conversation-question-answered');
    const picked = answers.filter((a) => a.labels.length > 0);
    const text = picked.length > 0
      ? picked.map((a) => `${a.header}: ${a.labels.join(', ')}${a.notes ? ` (${a.notes})` : ''}`).join('   ·   ')
      : 'No answer selected';
    const label = new Gtk.Label({ xalign: 0, wrap: true, selectable: true });
    setMarkupSafe(label, `${iconSpan(NERDFONT.STATUS.CHECK, theme.ui.status.success)}  ${escapeMarkup(text)}`, text);
    this.root.append(label);
  }
}
