/*
 * AgentConversation — the native UI host for a headless `claude-sdk` agent: a
 * purpose-made conversation view (NOT a terminal, NOT a reused editor buffer). It
 * owns an `SdkSession` (which drives `claude -p` stream-json) and renders the
 * conversation incrementally as message bubbles — user turns right-aligned,
 * assistant turns left-aligned, plus dim thinking blocks, tool-use rows, and a
 * permission card. Message text is rendered through the app's markdown→Pango
 * converter (markdownMarkup).
 *
 * The input is a buffer-only `TextEditor` (full vim editing); `enter` submits the
 * prompt and `alt-enter` inserts a newline, via commands bound on the prompt
 * container (keymap scoped to `#AgentConversationPrompt #TextEditor`).
 *
 * It implements the tool-agnostic `Agent` surface (../agents/types.ts), so it is a
 * first-class workbench owner registered in `quilx.agents` — the chrome reads
 * `status` / `changedFiles` / etc., never the concrete class.
 */
import { Gtk } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { fonts } from '../fonts.ts';
import { quilx } from '../quilx.ts';
import { worktreeInfo, type WorktreeInfo } from '../git.ts';
import { TextEditor } from './TextEditor/TextEditor.ts';
import { MarkdownView } from './markdown/MarkdownView.ts';
import { toolMarkup } from './toolDisplay.ts';
import { SdkSession, type PermissionRequest } from '../agents/claude-sdk/SdkSession.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import type { Agent, AgentMode, AgentStatus } from '../agents/types.ts';
import type { TabState } from '../SessionManager.ts';

const editorFg = theme.ui.editor.foreground;
const editorBg = theme.ui.editor.background ?? '@theme_base_color';

// Tools whose first input path counts as a "changed file" (mirrors the claude-tui
// PostToolUse Edit|Write|MultiEdit|NotebookEdit hook).
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

addStyles(`
  .quilx-conversation { background: ${editorBg}; color: ${editorFg}; }
  .quilx-conversation-transcript { padding: 12px; }
  .quilx-conversation-row { padding: 6px 0; }
  /* User and assistant share the bubble shape; only the background differs. */
  .quilx-conversation-user, .quilx-conversation-assistant {
    padding: 6px 10px;
    margin: 6px 0;
    border-radius: 10px;
  }
  .quilx-conversation-user { background: ${theme.ui.surface.selected}; }
  .quilx-conversation-assistant { background: ${theme.ui.surface.popover}; }
  .quilx-conversation-thinking { opacity: 0.55; font-style: italic; }
  .quilx-conversation-tool { opacity: 0.8; }
  .quilx-conversation-toolrow { opacity: 0.85; }
  .quilx-conversation-system { opacity: 0.6; font-style: italic; }
  .quilx-conversation-perm {
    padding: 8px; margin: 6px 0;
    border: 1px solid ${theme.ui.surface.selected};
    border-radius: 6px;
  }
  #AgentConversationPrompt { padding: 8px; }
`);
// The monospace bits (tool rows, permission detail) use the app's configured
// monospace font, not a generic family.
fonts.monospace('.quilx-conversation-tool');

// The enter/alt-enter keymap is global (selector-scoped to our prompt), registered
// once for the whole app — not per conversation instance.
let promptKeymapRegistered = false;
function registerPromptKeymapOnce(): void {
  if (promptKeymapRegistered) return;
  promptKeymapRegistered = true;
  quilx.keymaps.add('agent-conversation', {
    '#AgentConversationPrompt #TextEditor': {
      enter: 'conversation:submit-prompt',
      'alt-enter': 'conversation:prompt-newline',
    },
  });
}

export interface AgentConversationOptions {
  /** Working directory for claude. */
  cwd: string;
  /** Base argv (default `['claude']`). */
  command?: string[];
  /** An initial prompt to send once the session starts. */
  prompt?: string;
}

export class AgentConversation implements Agent {
  readonly root: InstanceType<typeof Gtk.Box>;
  private readonly session: SdkSession;
  private readonly cwd: string;
  private readonly messages: InstanceType<typeof Gtk.Box>;
  private readonly scroller: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly input: TextEditor;
  private readonly promptContainer: InstanceType<typeof Gtk.Box>;
  private readonly subs = new CompositeDisposable();
  private readonly launchPrompt?: string;

  // Per-turn streaming state: the open assistant/thinking markdown views and the
  // raw markdown accumulated into each (re-rendered on every delta). Reset per turn.
  private assistantView: MarkdownView | null = null;
  private assistantRaw = '';
  private thinkingView: MarkdownView | null = null;
  private thinkingRaw = '';

  // --- Agent state (mirrors AgentTerminal) ---
  private _status: AgentStatus = 'idle';
  private _displayName: string | null = null;
  private _changedFiles: string[] = [];
  private _worktree: WorktreeInfo | null | undefined;
  private _viewed = false;
  private _acknowledged = true;
  private readonly statusHandlers: Array<() => void> = [];
  private readonly fileHandlers: Array<() => void> = [];
  private readonly titleHandlers: Array<() => void> = [];
  private readonly attentionHandlers: Array<() => void> = [];

  constructor(options: AgentConversationOptions) {
    this.cwd = options.cwd;
    this.launchPrompt = options.prompt;
    this.session = new SdkSession({ cwd: options.cwd, command: options.command });

    this.messages = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.messages.addCssClass('quilx-conversation-transcript');
    this.scroller = new Gtk.ScrolledWindow({ vexpand: true });
    this.scroller.setChild(this.messages);

    // A buffer-only editor (full vim editing) as the prompt input, wrapped in a
    // named container so the enter/alt-enter keymap can scope to it.
    this.input = new TextEditor({ buffer: { placeholder: 'Message claude…' } });
    this.input.root.setVexpand(false);
    this.promptContainer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.promptContainer.setName('AgentConversationPrompt');
    this.promptContainer.setVexpand(false);
    this.promptContainer.append(this.input.root);
    this.installPromptCommands();

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.setName('AgentConversation');
    this.root.addCssClass('quilx-conversation');
    this.root.append(this.scroller);
    this.root.append(this.promptContainer);

    quilx.agents.add(this); // join the registry → sidebar lists it
    this.wireSession();
  }

  /** Spawn claude and send the launch prompt (if any). */
  start(): void {
    this.session.start();
    if (this.launchPrompt) this.session.prompt(this.launchPrompt);
    this.input.focus();
  }

  // --- Agent surface ----------------------------------------------------------

  get title(): string { return this._displayName ?? 'claude (sdk)'; }
  get status(): AgentStatus { return this._status; }
  get permissionMode(): AgentMode { return 'default'; }
  get changedFiles(): string[] { return this._changedFiles.slice(); }
  get effectiveCwd(): string { return this.cwd; }
  get sessionId(): string | null { return this.session.sessionId; }
  get renamed(): boolean { return this._displayName !== null; }
  get exited(): boolean { return this._status === 'exited'; }
  get unannouncedWorktree(): string | null { return null; }

  get worktree(): WorktreeInfo | null {
    if (this._worktree === undefined) this._worktree = worktreeInfo(this.cwd);
    return this._worktree;
  }

  get needsAttention(): boolean {
    if (this._status === 'waiting') return !this._viewed;
    if (this._status === 'idle') return !this._acknowledged;
    return false;
  }

  setViewed(viewed: boolean): void {
    const was = this.needsAttention;
    this._viewed = viewed;
    if (viewed) this._acknowledged = true;
    if (this.needsAttention !== was) this.emitAttention();
  }

  rename(name: string): void {
    this._displayName = name.trim() || null;
    this.emitTitle();
  }

  /** Stop the claude process (keeps the widget listed as `exited`). */
  kill(): void { this.session.stop(); }

  /** Restart support is a later phase; no-op for now. */
  resume(): void { /* sdk resume — later phase */ }

  focus(): void { this.input.focus(); }

  /** Push editor context into the input (Agent surface). */
  deliver(text: string): void {
    this.input.insertText(text);
    this.input.focus();
  }

  clearUnannouncedWorktree(): void { /* no worktree validator for sdk */ }

  serialize(): TabState | null { return null; } // not persisted across restarts yet
  isModified(): boolean { return !this.exited; }
  getModifiedLabel(): string { return `${this.title} (running)`; }

  onDidChangeStatus(cb: () => void): () => void { return push(this.statusHandlers, cb); }
  onDidChangeFiles(cb: () => void): () => void { return push(this.fileHandlers, cb); }
  onTitleChange(cb: () => void): () => void { return push(this.titleHandlers, cb); }
  onDidChangeAttention(cb: () => void): () => void { return push(this.attentionHandlers, cb); }
  onDidChangePermissionMode(_cb: () => void): () => void { return () => {}; }
  onDidChangeWorktree(_cb: () => void): () => void { return () => {}; }

  dispose(): void {
    this.subs.dispose();
    this.input.dispose();
    this.session.dispose();
    quilx.agents.remove(this);
  }

  // --- input ------------------------------------------------------------------

  // enter → submit the prompt; alt-enter → soft newline. Bound via the keymap
  // (registerPromptKeymapOnce) to these commands, registered on the container.
  private installPromptCommands(): void {
    registerPromptKeymapOnce();
    this.subs.add(
      quilx.commands.add(this.promptContainer, {
        'conversation:submit-prompt': {
          didDispatch: () => this.submit(),
          description: 'Submit the prompt to the agent',
        },
        'conversation:prompt-newline': {
          didDispatch: () => this.input.insertText('\n'),
          description: 'Insert a newline in the prompt',
        },
      }),
    );
  }

  private submit(): void {
    const text = this.input.getText().trim();
    if (!text) return;
    this.input.setText('');
    this.session.prompt(text);
  }

  // --- session → state + rows -------------------------------------------------

  private wireSession(): void {
    this.subs.add(
      this.session.onStatus(() => this.setStatus(this.session.status)),
      this.session.onUserMessage(({ text }) => {
        this.endTurn();
        this.addMarkdownBlock('quilx-conversation-user', Gtk.Align.END).setMarkdown(text);
      }),
      this.session.onAssistantStart(() => {
        this.assistantRaw = '';
        this.assistantView = this.addMarkdownBlock('quilx-conversation-assistant', Gtk.Align.START);
      }),
      this.session.onAssistantText(({ delta }) => {
        if (!this.assistantView) {
          this.assistantRaw = '';
          this.assistantView = this.addMarkdownBlock('quilx-conversation-assistant', Gtk.Align.START);
        }
        this.assistantRaw += delta;
        this.assistantView.setMarkdown(this.assistantRaw);
        this.scrollToBottom();
      }),
      this.session.onAssistantThinking(({ delta }) => {
        if (!this.thinkingView) {
          this.thinkingRaw = '';
          this.thinkingView = this.addMarkdownBlock('quilx-conversation-thinking', Gtk.Align.START);
        }
        this.thinkingRaw += delta;
        this.thinkingView.setMarkdown(this.thinkingRaw);
        this.scrollToBottom();
      }),
      this.session.onToolUse(({ name, input }) => {
        this.recordChangedFile(name, input);
        const label = this.addRow('quilx-conversation-toolrow');
        const markup = toolMarkup(name, input, { cwd: this.cwd, monoFamily: fonts.monospaceFamily });
        try { label.setMarkup(markup); } catch { label.setText(`${name} ${summarizeInput(input)}`); }
        this.scrollToBottom();
      }),
      this.session.onPermission((req) => this.addPermissionCard(req)),
      this.session.onExit(() => {
        this.endTurn();
        this.addRow('quilx-conversation-system').setText('── process exited ──');
        this.promptContainer.setSensitive(false);
      }),
    );
  }

  private setStatus(status: AgentStatus): void {
    if (this._status === status) return;
    const wasAttention = this.needsAttention;
    this._status = status;
    this._acknowledged = this._viewed;
    for (const handler of this.statusHandlers) handler();
    if (this.needsAttention !== wasAttention) this.emitAttention();
  }

  private recordChangedFile(toolName: string, input: unknown): void {
    if (!EDIT_TOOLS.has(toolName)) return;
    const path = (input as { file_path?: unknown })?.file_path;
    if (typeof path !== 'string' || this._changedFiles.includes(path)) return;
    this._changedFiles.push(path);
    for (const handler of this.fileHandlers) handler();
  }

  private emitTitle(): void { for (const h of this.titleHandlers) h(); }
  private emitAttention(): void { for (const h of this.attentionHandlers) h(); }

  // --- rows -------------------------------------------------------------------

  private endTurn(): void {
    this.assistantView = null;
    this.assistantRaw = '';
    this.thinkingView = null;
    this.thinkingRaw = '';
  }

  // A markdown message block (user / assistant / thinking): a styled container
  // (bubble background, alignment) wrapping a MarkdownView; returns the view so the
  // caller can stream into it via setMarkdown.
  private addMarkdownBlock(cssClass: string, align: number): MarkdownView {
    const view = new MarkdownView();
    const bubble = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    bubble.addCssClass(cssClass);
    bubble.setHalign(align);
    bubble.append(view.root);
    this.messages.append(bubble);
    this.scrollToBottom();
    return view;
  }

  // A single wrapped, left-aligned row (thinking / tool / system).
  private addRow(cssClass: string): InstanceType<typeof Gtk.Label> {
    const label = new Gtk.Label({ xalign: 0, wrap: true, selectable: true });
    label.addCssClass('quilx-conversation-row');
    label.addCssClass(cssClass);
    this.messages.append(label);
    this.scrollToBottom();
    return label;
  }

  private addPermissionCard(req: PermissionRequest): void {
    const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
    card.addCssClass('quilx-conversation-perm');
    const title = new Gtk.Label({ xalign: 0, label: `Allow ${req.toolName}?` });
    const detail = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, label: summarizeInput(req.input) });
    detail.addCssClass('quilx-conversation-tool');
    const buttons = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    const allow = new Gtk.Button({ label: 'Allow' });
    const deny = new Gtk.Button({ label: 'Deny' });
    const decide = (ok: boolean) => {
      this.session.respondPermission(req.id, { allow: ok });
      allow.setSensitive(false);
      deny.setSensitive(false);
      title.setText(`${ok ? 'Allowed' : 'Denied'} ${req.toolName}`);
    };
    allow.on('clicked', () => decide(true));
    deny.on('clicked', () => decide(false));
    buttons.append(allow);
    buttons.append(deny);
    card.append(title);
    card.append(detail);
    card.append(buttons);
    this.messages.append(card);
    this.scrollToBottom();
  }

  // Defer to a tick callback: the appended widget isn't laid out yet, so the
  // vadjustment's upper is stale until the next layout pass (microtasks never run
  // under the GLib loop — see memory `queuemicrotask-dead-under-glib-loop`).
  private scrollToBottom(): void {
    this.scroller.addTickCallback(() => {
      const adj = this.scroller.getVadjustment();
      adj.setValue(adj.getUpper() - adj.getPageSize());
      return false; // GLib SOURCE_REMOVE — run once
    });
  }
}

/** Push `cb` onto `list` and return an unsubscribe that splices it out. */
function push(list: Array<() => void>, cb: () => void): () => void {
  list.push(cb);
  return () => {
    const i = list.indexOf(cb);
    if (i !== -1) list.splice(i, 1);
  };
}

/** A compact one-line view of a tool/permission input for a row. */
function summarizeInput(input: unknown): string {
  if (input == null) return '';
  let text: string;
  try {
    text = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    text = String(input);
  }
  return text.length > 200 ? text.slice(0, 200) + '…' : text;
}
