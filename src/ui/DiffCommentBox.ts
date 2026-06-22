/*
 * DiffCommentBox — a small focusable comment input shown inline in the continuous
 * diff (DiffView), hosted in the editor's focusable `Peek` (a sibling
 * overlay card, NOT a `BlockDecorations` band: the latter is the non-interactive
 * add_overlay path, where a nested focusable editor leaks IM input — see
 * Peek.ts / BlockDecorations.ts). The body is a buffer-only `TextEditor` (full vim
 * editing), mirroring the agent prompt input (AgentConversation):
 *   - `enter` submits → `onSubmit(text)`,
 *   - `alt-enter` inserts a newline (multi-line comments),
 *   - `ctrl-enter` starts review mode (accumulate) → `onStartReview()`,
 *   - `escape`/`q` (normal mode) cancels → `onCancel()`.
 */
import { Gtk } from '../gi.ts';
import { zym } from '../zym.ts';
import { addStyles } from '../styles.ts';
import { TextEditor, createInput } from './TextEditor/TextEditor.ts';

addStyles(`
  /* The editor box and a pending-comment card share the same card chrome. */
  .diff-comment-box,
  .diff-comment-card {
    background: var(--t-ui-surface-popover);
    border: 1px solid var(--t-ui-border);
    border-radius: var(--card-radius);
    margin: var(--t-spacing);
    padding: 6px 8px;
  }
  /* Let the card background show through the editor. */
  #DiffCommentInput textview,
  #DiffCommentInput textview text { background: transparent; }
  /* Footer text — muted, sits below the body. The card's "Pending" label uses the UI font. */
  .diff-comment-hint { color: var(--t-ui-text-muted); padding-top: 4px; }
  .diff-comment-card-label { color: var(--t-ui-editor-foreground); }
  .diff-comment-card-footer {
    color: var(--t-ui-text-muted);
    font-family: var(--t-font-ui-family);
    padding-top: 4px;
  }
  /* Review-mode badge: a small muted pill on the input footer. */
  .diff-comment-badge {
    color: var(--t-ui-text-muted);
    border: 1px solid var(--t-ui-text-muted);
    border-radius: 999px;
    padding: 0 6px;
    font-size: var(--t-font-ui-size-small);
  }
`);

// The keymap is global (selector-scoped to our card), registered once for the whole
// app — not per box instance.
let keymapRegistered = false;
function registerKeymapOnce(): void {
  if (keymapRegistered) return;
  keymapRegistered = true;
  zym.keymaps.add('diff-comment', {
    '#DiffCommentInput #TextEditor': {
      enter: 'diff-comment:submit',
      'alt-enter': 'diff-comment:newline',
      'ctrl-enter': 'diff-comment:start-review',
    },
    // Cancel from NORMAL mode (`q`/`escape`). In insert mode `escape` is vim's
    // insert→normal (so a single `escape` doesn't reach a cancel binding).
    '#DiffCommentInput #TextEditor.normal-mode': {
      q: 'diff-comment:cancel',
      escape: 'diff-comment:cancel',
    },
  });
}

export interface DiffCommentBoxOptions {
  /** Enter pressed — `text` is the comment as typed (untrimmed). */
  onSubmit: (text: string) => void;
  /** Escape pressed (or otherwise dismissed without submitting). */
  onCancel: () => void;
  /** Ctrl+Enter — start review mode (accumulate). No-op when already reviewing (the badge shows). */
  onStartReview?: () => void;
  /** Initial review state — sets the submit hint and whether the badge shows. */
  reviewing?: boolean;
  /** Editing an existing pending comment (changes the hint to "update"). */
  editing?: boolean;
  /** Prefill the input (editing an existing comment). */
  initialText?: string;
}

/** A read-only card showing an accumulated review comment, placed inline under its line — same card
 *  chrome as the editor box, with a muted "Pending" footer. */
export function buildCommentCard(text: string): InstanceType<typeof Gtk.Box> {
  const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  card.addCssClass('diff-comment-card');
  const label = new Gtk.Label({ label: text, xalign: 0, wrap: true, selectable: false });
  label.addCssClass('diff-comment-card-label');
  card.append(label);
  const footer = new Gtk.Label({ label: 'Pending', xalign: 0 });
  footer.addCssClass('diff-comment-card-footer');
  card.append(footer);
  return card;
}

export class DiffCommentBox {
  readonly root: InstanceType<typeof Gtk.Box>;
  /** Reserved-gap height for the hosting Peek, in px (card + the `--t-spacing` margins around it). */
  readonly height = 132;
  private readonly options: DiffCommentBoxOptions;
  private readonly input: TextEditor;
  private readonly hint: InstanceType<typeof Gtk.Label>;
  private readonly badge: InstanceType<typeof Gtk.Label>;
  private readonly commands: { dispose(): void };
  private reviewing: boolean;
  private disposed = false;

  constructor(options: DiffCommentBoxOptions) {
    registerKeymapOnce();
    this.options = options;
    this.reviewing = !!options.reviewing;

    this.input = createInput({ placeholder: 'Comment to agent…', initialText: options.initialText });
    this.input.root.setVexpand(true);
    this.input.root.setHexpand(true);

    this.hint = new Gtk.Label({ label: this.hintText(), xalign: 0 });
    this.hint.addCssClass('diff-comment-hint');
    this.hint.setHexpand(true);

    this.badge = new Gtk.Label({ label: '● Review', valign: Gtk.Align.CENTER });
    this.badge.addCssClass('diff-comment-badge');
    this.badge.setVisible(this.reviewing);

    const footer = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    footer.append(this.hint);
    footer.append(this.badge);

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.setName('DiffCommentInput');
    this.root.addCssClass('diff-comment-box');
    this.root.append(this.input.root);
    this.root.append(footer);

    this.commands = zym.commands.add(this.root, {
      'diff-comment:submit': {
        didDispatch: () => options.onSubmit(this.input.getText()),
        description: 'Send / add the diff comment',
      },
      'diff-comment:newline': {
        didDispatch: () => this.input.insertText('\n'),
        description: 'Insert a newline in the diff comment',
      },
      'diff-comment:start-review': {
        didDispatch: () => this.reviewAndSubmit(),
        description: 'Start review mode and add this comment',
      },
      'diff-comment:cancel': {
        didDispatch: () => options.onCancel(),
        description: 'Cancel the diff comment',
      },
    });
  }

  focus(): void {
    this.input.focusInsert(); // ready to type immediately, not vim normal mode
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.commands.dispose();
    this.input.dispose();
  }

  // Ctrl+Enter: turn review mode on (if off), then submit this comment — so it's accumulated.
  private reviewAndSubmit(): void {
    if (!this.reviewing) {
      this.reviewing = true;
      this.options.onStartReview?.(); // flips the view into review mode BEFORE the submit reads it
      this.hint.setText(this.hintText());
      this.badge.setVisible(true);
    }
    this.options.onSubmit(this.input.getText());
  }

  private hintText(): string {
    const submit = this.options.editing ? 'Enter to update' : this.reviewing ? 'Enter to add to review' : 'Enter to send';
    const review = this.options.editing || this.reviewing ? '' : ' · Ctrl+Enter to review';
    return `${submit} · Alt+Enter for newline${review}`;
  }
}
