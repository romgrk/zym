/*
 * QuestionCard — the AskUserQuestion UI. Each question is a page in an Adwaita
 * ViewStack, switched with a compact Adw.InlineViewSwitcher; the options are an
 * Adwaita boxed list (PreferencesGroup of ExpanderRows). Each option carries a
 * check/radio prefix and expands to reveal a note entry. The user drives it by
 * keyboard:
 *   j/k   move the focused option         h/l   switch question
 *   space toggle the focused option (multi-select picks more than one)
 *   enter (single-select) select the focused option + advance; (multi-select)
 *         confirm the current toggles + advance (submit on the last question)
 *   n     open the focused option's note (enter/escape returns to the list)
 * A question with no selected option is skipped. On submit the card swaps itself
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
  .zym-q-prompt { margin-bottom: calc(2 * var(--t-spacing)); font-size: var(--t-font-ui-size-large); }
  .zym-q-switcher button { padding-top: 2px; padding-bottom: 2px; min-height: 0; }
  .zym-q-hint { opacity: 0.5; font-size: var(--t-font-ui-size-small); }
  .zym-q-row-focused { background: var(--t-ui-surface-selected); }
  .zym-q-note { padding-left: calc(4 * var(--t-spacing)); }
`);

interface Option {
  row: InstanceType<typeof Adw.ExpanderRow>;
  check: InstanceType<typeof Gtk.CheckButton>;
  note: InstanceType<typeof Adw.EntryRow>;
}

export class QuestionCard {
  readonly root: InstanceType<typeof Gtk.Box>;
  private readonly stack = new Adw.ViewStack();
  private readonly qs: AgentQuestion[];
  private readonly onAnswer: (answers: Answer[]) => void;
  private readonly opts: Option[][] = []; // [question][option]
  private readonly focused: number[] = [];
  private hint!: InstanceType<typeof Gtk.Label>;
  private current = 0;
  private answered = false;
  private editing = false; // a note entry holds focus → yield keys to typing

  constructor(req: QuestionRequest, onAnswer: (answers: Answer[]) => void) {
    this.qs = req.questions;
    this.onAnswer = onAnswer;
    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    this.root.addCssClass('zym-conversation-question');
    this.root.setFocusable(true);

    const numbered = this.qs.length > 1; // "1. …, 2. …" only when there's more than one

    if (numbered) {
      const switcher = new Adw.InlineViewSwitcher({ stack: this.stack });
      switcher.setDisplayMode(Adw.InlineViewSwitcherDisplayMode.LABELS);
      switcher.setHalign(Gtk.Align.START);
      switcher.addCssClass('zym-q-switcher');
      this.root.append(switcher);
    }
    this.root.append(this.stack);

    this.qs.forEach((q, qi) => {
      this.focused.push(0);
      const num = numbered ? `${qi + 1}. ` : '';
      const page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
      if (q.question) {
        // The number lives in the switcher tab title, so the prompt omits it.
        const prompt = new Gtk.Label({ xalign: 0, wrap: true });
        prompt.addCssClass('zym-q-prompt');
        setMarkupSafe(prompt, `<b>${escapeMarkup(q.question)}</b>`, q.question);
        page.append(prompt);
      }

      const group = new Adw.PreferencesGroup();
      const rows: Option[] = [];
      let groupLeader: InstanceType<typeof Gtk.CheckButton> | null = null;
      q.options.forEach((opt, oi) => {
        const row = new Adw.ExpanderRow();
        row.setTitle(escapeMarkup(opt.label));
        if (opt.description) row.setSubtitle(escapeMarkup(opt.description));
        // Row itself stays non-focusable; focus lands on the check below so GTK's
        // native "space toggles the focused check/radio" works. Mouse clicks still
        // expand the row.
        row.setFocusable(false);

        // Checkbox for multi-select; grouped radio for single-select. Focusable, so
        // native Space (and click) toggles it — we don't handle Space ourselves.
        const check = new Gtk.CheckButton();
        check.setValign(Gtk.Align.CENTER);
        if (!q.multiSelect) {
          if (groupLeader) check.setGroup(groupLeader); else groupLeader = check;
        }
        // Keep the focus highlight on the option the mouse just acted on. For single-select
        // only react to activation, so a radio auto-deselecting its sibling doesn't steal it.
        check.on('toggled', () => {
          if (this.answered || !(q.multiSelect || check.getActive())) return;
          this.focused[qi] = oi;
          if (qi === this.current) this.applyFocus();
        });
        row.addPrefix(check);

        // Revealed note field; typing must reach it, so track focus + handle enter/escape.
        const note = new Adw.EntryRow();
        note.setTitle('Add a note…');
        note.addCssClass('zym-q-note');
        const fc = new Gtk.EventControllerFocus();
        fc.on('enter', () => { this.editing = true; });
        fc.on('leave', () => {
          this.editing = false;
          if ((note.getText() ?? '').trim() === '') row.setExpanded(false); // collapse empty notes
        });
        note.addController(fc);
        const doneEditing = () => check.grabFocus(); // back to the option (→ fc.leave collapses empty notes)
        note.on('entry-activated', doneEditing); // enter → back to the list
        const noteKeys = new Gtk.EventControllerKey();
        noteKeys.on('key-pressed', (keyval: number) => { if (keyval === Gdk.KEY_Escape) { doneEditing(); return true; } return false; });
        note.addController(noteKeys);
        row.addRow(note);

        group.add(row);
        rows.push({ row, check, note });
      });
      this.opts.push(rows);
      page.append(group);
      this.stack.addTitled(page, `q${qi}`, `${num}${q.header || q.question || `Question ${qi + 1}`}`);
    });

    this.hint = new Gtk.Label({ xalign: 0 });
    this.hint.addCssClass('zym-q-hint');
    this.root.append(this.hint);
    this.updateHint();

    // Keep `current` in sync when the user clicks a switcher tab.
    this.stack.on('notify::visible-child', () => this.syncCurrent());

    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number) => this.onKey(keyval));
    this.root.addController(keys);
    this.root.on('map', () => this.focusOption(0)); // land on the first option once shown
  }

  private updateHint(): void {
    this.hint.setText(this.qs[this.current]?.multiSelect
      ? 'j/k options     ·     h/l questions     ·     space toggle     ·     enter confirm     ·     n note'
      : 'j/k options     ·     h/l questions     ·     enter select     ·     n note');
  }

  // XXX: redo this
  private onKey(keyval: number): boolean {
    if (this.answered || this.editing) return false;
    switch (keyval) {
      case Gdk.KEY_j: case Gdk.KEY_Down: this.moveOption(1); return true;
      case Gdk.KEY_k: case Gdk.KEY_Up: this.moveOption(-1); return true;
      case Gdk.KEY_l: case Gdk.KEY_Right: this.moveQuestion(1); return true;
      case Gdk.KEY_h: case Gdk.KEY_Left: this.moveQuestion(-1); return true;
      // Space is intentionally not handled: it falls through to the focused
      // check/radio, which GTK toggles natively.
      case Gdk.KEY_Return: case Gdk.KEY_KP_Enter: this.confirmAndAdvance(); return true;
      case Gdk.KEY_n: this.openNote(); return true;
      default: return false;
    }
  }

  private focusOption(i: number): void {
    const rows = this.opts[this.current];
    if (rows.length === 0) return;
    this.focused[this.current] = Math.min(Math.max(i, 0), rows.length - 1);
    this.applyFocus();
    rows[this.focused[this.current]].check.grabFocus(); // native focus → Space toggles it
  }

  // Highlight the focused option of the current question (focus lives on `root`,
  // so the indicator is a CSS class rather than the native focus ring).
  private applyFocus(): void {
    this.opts[this.current].forEach((o, oi) => {
      if (oi === this.focused[this.current]) o.row.addCssClass('zym-q-row-focused');
      else o.row.removeCssClass('zym-q-row-focused');
    });
  }

  private moveOption(d: number): void {
    this.focusOption(this.focused[this.current] + d);
  }

  private moveQuestion(d: number): void {
    const next = Math.min(Math.max(this.current + d, 0), this.qs.length - 1);
    if (next === this.current) return;
    this.stack.setVisibleChildName(`q${next}`); // → notify::visible-child → syncCurrent
  }

  // Reconcile `current` with the stack's visible page (driven by tab clicks or moveQuestion).
  private syncCurrent(): void {
    const name = this.stack.getVisibleChildName();
    if (!name) return;
    const i = Number.parseInt(name.slice(1), 10);
    if (Number.isNaN(i) || i === this.current) return;
    this.current = i;
    this.updateHint();
    this.focusOption(this.focused[i]);
  }

  // Enter advances to the next question, or submits on the last. For single-select
  // it auto-picks the focused option *only when nothing is chosen yet* — once a
  // choice exists, Enter submits it unchanged rather than re-selecting whatever is
  // focused (changing the selection is `space`'s job).
  private confirmAndAdvance(): void {
    if (!this.qs[this.current].multiSelect) {
      const rows = this.opts[this.current];
      if (!rows.some((o) => o.check.getActive())) rows[this.focused[this.current]]?.check.setActive(true);
    }
    if (this.current < this.qs.length - 1) this.moveQuestion(1);
    else this.submit();
  }

  // Reveal the focused option's note field and focus it for typing.
  private openNote(): void {
    const o = this.opts[this.current][this.focused[this.current]];
    if (!o) return;
    o.row.setExpanded(true);
    o.note.grabFocus();
  }

  private submit(): void {
    this.answered = true;
    const answers: Answer[] = this.qs.map((q, qi) => {
      const picked = this.opts[qi]
        .map((o, oi) => ({ oi, on: o.check.getActive(), note: (o.note.getText() ?? '').trim() }))
        .filter((x) => x.on);
      const notes = picked.map((x) => x.note).filter((n) => n !== '').join('; ');
      return {
        header: q.header || q.question,
        labels: picked.map((x) => q.options[x.oi].label),
        notes: notes || undefined,
      };
    });
    this.onAnswer(answers);

    // Replace the interactive card with a compact record; drop the active border.
    clearChildren(this.root);
    this.root.removeCssClass('zym-conversation-question');
    this.root.addCssClass('zym-conversation-question-answered');
    const picked = answers.filter((a) => a.labels.length > 0);
    const text = picked.length > 0
      ? picked.map((a) => `${a.header}: ${a.labels.join(', ')}${a.notes ? ` (${a.notes})` : ''}`).join('   ·   ')
      : 'No answer selected';
    const label = new Gtk.Label({ xalign: 0, wrap: true, selectable: true });
    setMarkupSafe(label, `${iconSpan(NERDFONT.STATUS.CHECK, theme.ui.status.success)}  ${escapeMarkup(text)}`, text);
    this.root.append(label);
  }
}
