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
import Gdk from 'gi:Gdk-4.0';
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import { CompositeDisposable } from '../../util/eventKit.ts';
import { addStyles } from '../../styles.ts';
import { theme } from '../../theme/theme.ts';
import { escapeMarkup, setMarkupSafe, clearChildren, wrappingLabel } from '../proseMarkup.ts';
import { iconSpan } from '../icons.ts';
import { NERDFONT } from '../nerdfont.ts';
import { ToolRow, toolHeaderLabel } from './ToolRow.ts';
import type { AgentQuestion, QuestionRequest } from '../../agents/session.ts';

type Answer = { header: string; labels: string[]; notes?: string };

addStyles(/* css */`
  /* AskUserQuestion: the interactive choice card. It replaces the input while open —
     the info-coloured ring lives on the input card (AgentConversation), not here — so
     the card itself is borderless; once answered it becomes a transcript tool row. */
  .Question .question-card {
    padding: calc(2 * var(--t-spacing));
  }
  .Question .question-prompt { margin-bottom: calc(2 * var(--t-spacing)); font-size: var(--t-font-ui-size-large); }
  .Question .question-switcher button { padding-top: 2px; padding-bottom: 2px; min-height: 0; }
  .Question .question-hint { opacity: 0.5; font-size: var(--t-font-ui-size-small); }
  .Question .is-focused { background: var(--selection-bg-focus); }
  .Question .question-note { padding-left: calc(4 * var(--t-spacing)); }
`);

interface Option {
  row: InstanceType<typeof Adw.ExpanderRow>;
  check: InstanceType<typeof Gtk.CheckButton>;
  note: InstanceType<typeof Adw.EntryRow>;
}

export class QuestionCard {
  readonly root: InstanceType<typeof Gtk.Box>;
  readonly container: InstanceType<typeof Gtk.Box>;
  private readonly stack = new Adw.ViewStack();
  private readonly qs: AgentQuestion[];
  private readonly onAnswer: (answers: Answer[]) => void;
  private readonly opts: Option[][] = []; // [question][option]
  private readonly focused: number[] = [];
  private hint!: InstanceType<typeof Gtk.Label>;
  private current = 0;
  private answered = false;
  private editing = false; // a note entry holds focus → yield keys to typing
  // node-gtk roots connected controller/handler closures; the card is built per
  // question and torn down with the conversation, so funnel teardown here (rule 9).
  private readonly disposables = new CompositeDisposable();
  // Per-option controllers/handlers: the option `note`s are dropped on submit, so
  // this nested scope is cleared then; the root-level controllers live in `disposables`.
  private readonly optionScope = this.disposables.nest();

  constructor(req: QuestionRequest, onAnswer: (answers: Answer[]) => void) {
    this.qs = req.questions;
    this.onAnswer = onAnswer;
    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    this.root.addCssClass('Question');
    this.root.addCssClass('is-open'); // released on answer; the keymap scopes `space` to .Question.is-open
    this.root.setFocusable(true);

    this.container = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    this.container.addCssClass('question-card');
    this.root.append(this.container)

    const numbered = this.qs.length > 1; // "1. …, 2. …" only when there's more than one

    if (numbered) {
      const switcher = new Adw.InlineViewSwitcher({ stack: this.stack });
      switcher.setDisplayMode(Adw.InlineViewSwitcherDisplayMode.LABELS);
      switcher.setHalign(Gtk.Align.START);
      switcher.addCssClass('question-switcher');
      this.container.append(switcher);
    }
    this.container.append(this.stack);

    this.qs.forEach((q, qi) => {
      this.focused.push(0);
      const num = numbered ? `${qi + 1}. ` : '';
      const page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
      if (q.question) {
        // The number lives in the switcher tab title, so the prompt omits it.
        const prompt = wrappingLabel({ xalign: 0 });
        prompt.addCssClass('question-prompt');
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
        this.optionScope.connect(check, 'toggled', () => {
          if (this.answered || !(q.multiSelect || check.getActive())) return;
          this.focused[qi] = oi;
          if (qi === this.current) this.applyFocus();
        });
        row.addPrefix(check);

        // Revealed note field; typing must reach it, so track focus + handle enter/escape.
        const note = new Adw.EntryRow();
        note.setTitle('Add a note…');
        note.addCssClass('question-note');
        const fc = new Gtk.EventControllerFocus();
        fc.on('enter', () => { this.editing = true; });
        fc.on('leave', () => {
          this.editing = false;
          if ((note.getText() ?? '').trim() === '') row.setExpanded(false); // collapse empty notes
        });
        this.optionScope.addController(note, fc);
        const doneEditing = () => check.grabFocus(); // back to the option (→ fc.leave collapses empty notes)
        this.optionScope.connect(note, 'entry-activated', doneEditing); // enter → back to the list
        const noteKeys = new Gtk.EventControllerKey();
        noteKeys.on('key-pressed', (keyval: number) => { if (keyval === Gdk.KEY_Escape) { doneEditing(); return true; } return false; });
        this.optionScope.addController(note, noteKeys);
        row.addRow(note);

        group.add(row);
        rows.push({ row, check, note });
      });
      this.opts.push(rows);
      page.append(group);
      this.stack.addTitled(page, `q${qi}`, `${num}${q.header || q.question || `Question ${qi + 1}`}`);
    });

    this.hint = new Gtk.Label({ xalign: 0 });
    this.hint.addCssClass('question-hint');
    this.container.append(this.hint);
    this.updateHint();

    // Keep `current` in sync when the user clicks a switcher tab.
    this.disposables.connect(this.stack, 'notify::visible-child', () => this.syncCurrent());

    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number) => this.onKey(keyval));
    this.disposables.addController(this.root, keys);
    this.disposables.connect(this.root, 'map', () => this.focusOption(0)); // land on the first option once shown
  }

  /** Sever the card's controllers/handlers (root + per-option). Called when the
   *  owning conversation is disposed (the card root is dropped then). Idempotent. */
  dispose(): void {
    this.disposables.dispose();
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
      if (oi === this.focused[this.current]) o.row.addCssClass('is-focused');
      else o.row.removeCssClass('is-focused');
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

    // Replace the interactive card with a transcript tool row: a check icon + a
    // one-line summary header that expands to the full Q&A. Matches the padding /
    // indent of every other tool row (vs. the old bare, unpadded label).
    this.optionScope.clear(); // the option notes (+ their controllers) are about to be dropped
    clearChildren(this.root);
    this.root.removeCssClass('is-open'); // answered → release the `space` keymap scope
    const picked = answers.filter((a) => a.labels.length > 0);
    const summary = picked.length > 0
      ? picked.map((a) => `${a.header}: ${a.labels.join(', ')}${a.notes ? ` (${a.notes})` : ''}`).join('   ·   ')
      : 'No answer selected';
    const header = toolHeaderLabel();
    setMarkupSafe(header, escapeMarkup(summary), summary);
    const row = new ToolRow({ icon: NERDFONT.STATUS.CHECK, iconColor: theme.ui.status.success, header, subs: this.disposables });
    row.content.append(this.answeredDetails());
    this.root.append(row.root);
  }

  // The collapsible record of the questions: each prompt, then every offered option
  // marked selected (a success check) or not (a dim box), with any note.
  private answeredDetails(): InstanceType<typeof Gtk.Box> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
    this.qs.forEach((q, qi) => {
      const title = q.question || q.header;
      if (title) {
        const ql = wrappingLabel({ xalign: 0 });
        setMarkupSafe(ql, `<b>${escapeMarkup(title)}</b>`, title);
        box.append(ql);
      }
      this.opts[qi].forEach((o, oi) => {
        const opt = q.options[oi];
        const selected = o.check.getActive();
        const note = (o.note.getText() ?? '').trim();
        const glyph = selected
          ? iconSpan(NERDFONT.TASK.DONE, theme.ui.status.success)
          : iconSpan(NERDFONT.TASK.OPEN, undefined, true);
        const body = selected ? `<b>${escapeMarkup(opt.label)}</b>` : escapeMarkup(opt.label);
        const extra = note ? ` <span alpha="65%">— ${escapeMarkup(note)}</span>` : '';
        const label = wrappingLabel({ xalign: 0 });
        label.setMarginStart(8);
        setMarkupSafe(label, `${glyph}  ${body}${extra}`, `${opt.label}${note ? ` — ${note}` : ''}`);
        box.append(label);
      });
    });
    return box;
  }
}
