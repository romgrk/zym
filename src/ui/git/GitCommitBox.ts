/*
 * GitCommitBox — the embedded commit-message editor shown in a vertical split above the
 * GitPanel's change list (replacing the old open-in-a-new-tab flow). The body is a
 * buffer-only `TextEditor` (full vim editing), like the agent prompt / DiffCommentBox:
 *   - `enter` inserts a newline (commit messages are multi-line: subject + body),
 *   - `ctrl-enter` commits → `onSubmit(text)`,
 *   - `escape`/`q` (normal mode) cancels → `onCancel()`.
 * The panel owns the git side (writing the message + `git.commit`); this widget just edits.
 * Keys are scoped to `.GitPanel .GitCommitInput` in the central keymap (see keymaps/default.ts).
 * A footer renders those bindings as `Keycap` chips, gated by `help.showKeybindings` (default on).
 */
import Gtk from 'gi:Gtk-4.0';
import { zym } from '../../zym.ts';
import { addStyles } from '../../styles.ts';
import { KeybindingHints } from '../KeybindingHints.ts';
import { type TextEditor, createInput } from '../TextEditor/TextEditor.ts';

addStyles(/* css */`
  /* A panel section: separated from the change list/diff below by a bottom border. */
  .GitCommitBox {
    border-bottom: 1px solid var(--border-color);
    padding: 6px 8px;
  }
  /* Let the panel background show through the editor (no separate input chrome). */
  .GitCommitBox .GitCommitInput,
  .GitCommitBox .GitCommitInput text { background: transparent; }
`);

export interface GitCommitBoxOptions {
  /** Amend mode — changes the placeholder + footer wording (the panel runs the amend). */
  amend: boolean;
  /** Prefill the message (blank for a commit, the last message for an amend). */
  initialText: string;
  /** Ctrl+Enter — commit with the message as typed (untrimmed; the panel guards empties). */
  onSubmit: (text: string) => void;
  /** Escape / `q` (normal mode) — dismiss without committing. */
  onCancel: () => void;
}

export class GitCommitBox {
  readonly root: InstanceType<typeof Gtk.Box>;
  private readonly input: TextEditor;
  private readonly hints: KeybindingHints;
  private readonly commands: { dispose(): void };
  private disposed = false;

  constructor(options: GitCommitBoxOptions) {
    this.input = createInput({
      placeholder: options.amend ? 'Amend commit message…' : 'Commit message…',
      initialText: options.initialText,
      cssClass: 'GitCommitInput', // the keymap scope for this editor's submit/cancel keys
    });
    this.input.root.setVexpand(true);
    this.input.root.setHexpand(true);

    // The bindings as keycap hints at the bottom (self-gated on `help.showKeybindings`).
    // Keystrokes mirror `.GitPanel .GitCommitInput` in keymaps/default.ts.
    this.hints = new KeybindingHints([
      ['ctrl-enter', options.amend ? 'amend' : 'commit'],
      ['escape', 'cancel'],
    ]);

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.addCssClass('GitCommitBox');
    this.root.append(this.input.root);
    this.root.append(this.hints.root);

    this.commands = zym.commands.add(this.root, {
      'git-commit:submit': {
        didDispatch: () => options.onSubmit(this.input.getText()),
        description: 'Commit the message',
      },
      'git-commit:newline': {
        didDispatch: () => this.input.insertText('\n'),
        description: 'Insert a newline in the commit message',
      },
      'git-commit:cancel': {
        didDispatch: () => options.onCancel(),
        description: 'Cancel the commit',
      },
    });
  }

  /** Focus the editor in insert mode — ready to type the message immediately. */
  focus(): void {
    this.input.focusInsert();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.commands.dispose();
    this.hints.dispose();
    this.input.dispose();
  }
}
