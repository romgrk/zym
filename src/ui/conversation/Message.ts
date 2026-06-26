/*
 * Message — a single conversation message: a user / assistant / thinking turn. The
 * outer container (.Message) owns the gutter around the turn; inside, a
 * `.message-bubble` carries the surface (background + radius) around a MarkdownView.
 * Shared by the main AgentConversation and the subagent pages (SubagentView) so every
 * turn looks and aligns the same. Callers mount `root` as a transcript entry and
 * stream markdown via `setMarkdown`.
 */
import { Gtk } from '../../gi.ts';
import { addStyles } from '../../styles.ts';
import { MarkdownView } from '../markdown/MarkdownView.ts';

/** user — the user's turn (right-aligned). assistant — the agent's turn (left).
 *  thinking — a dim, italic reasoning aside (no surface of its own). */
export type MessageKind = 'user' | 'assistant' | 'thinking';

addStyles(/* css */`
  /* The container owns the gutter around the bubble (.Message is NOT the bubble). */
  .Message {
    padding: 0 calc(2 * var(--t-spacing));
  }
  /* User and assistant share the bubble shape (radius + inner padding); only the
     background colour differs. The prose is capped to a reading measure in code
     (MarkdownView max-width-chars) — GTK CSS has no max-width. */
  .Message .message-bubble {
    padding: calc(2 * var(--t-spacing));
    border-radius: 10px;
  }
  .Message.is-user .message-bubble {
    background: color-mix(in srgb, var(--card-bg-color), var(--accent-color) 50%);
  }
  .Message.is-assistant .message-bubble {
    // background: var(--card-bg-color);
    // border: 1px solid var(--border-color);
  }
  .Message.is-thinking .message-bubble { 
    border: none;
    box-shadow: none;
    background: transparent;
    opacity: 0.55;
    font-style: italic;
  }
`);

export class Message {
  readonly kind: MessageKind;
  /** The outer container — mount as a transcript entry. */
  readonly root: InstanceType<typeof Gtk.Box>;
  /** The markdown view the message renders into. */
  readonly view = new MarkdownView();

  constructor(kind: MessageKind) {
    this.kind = kind;
    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.addCssClass('Message');
    this.root.addCssClass(`is-${kind}`); // surfaces the kind for the .Message.is-<kind> styling

    const bubble = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    bubble.addCssClass('card');
    bubble.addCssClass('message-bubble');
    // User turns hug the right; assistant and thinking hug the left.
    bubble.setHalign(kind === 'user' ? Gtk.Align.END : Gtk.Align.START);
    bubble.append(this.view.root);
    this.root.append(bubble);
  }

  /** Render markdown into the message (re-render on each streaming delta). */
  setMarkdown(markdown: string): void { this.view.setMarkdown(markdown); }

  /** The message's markdown source (for the copy action). */
  getMarkdown(): string { return this.view.getMarkdown(); }
}
