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
import { fonts, ICON_FONT_FAMILY } from '../fonts.ts';
import { quilx } from '../quilx.ts';
import { worktreeInfo, type WorktreeInfo } from '../git.ts';
import { TextEditor } from './TextEditor/TextEditor.ts';
import { createSlashCommandSource } from './TextEditor/createSlashCommandSource.ts';
import { MarkdownView } from './markdown/MarkdownView.ts';
import { toolMarkup, toolFilePath } from './toolDisplay.ts';
import { escapeMarkup } from './proseMarkup.ts';
import { createAgentStatusIcon } from './agentStatusIcon.ts';
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
    padding: 8px 12px;
    margin: 8px 0;
    border-radius: 10px;
  }
  .quilx-conversation-user { background: ${theme.ui.surface.selected}; }
  .quilx-conversation-assistant { background: ${theme.ui.surface.popover}; }
  .quilx-conversation-thinking { opacity: 0.55; font-style: italic; padding-left: 12px; }
  .quilx-conversation-tool { opacity: 0.8; }
  .quilx-conversation-toolrow { opacity: 0.85; }
  .quilx-conversation-result {
    opacity: 0.7;
    background: ${theme.ui.surface.popover};
    padding: 4px 8px;
    margin-top: 2px;
    border-radius: 4px;
  }
  /* A Task (subagent) report renders as a fuller markdown card. */
  .quilx-conversation-task-result {
    background: ${theme.ui.surface.popover};
    border-left: 3px solid ${theme.ui.surface.selected};
    padding: 6px 10px;
    margin-top: 4px;
    border-radius: 4px;
  }
  .quilx-conversation-tasks {
    padding: 8px 12px;
    background: ${theme.ui.surface.popover};
    border-bottom: 1px solid ${theme.ui.border};
  }
  .quilx-conversation-tasks-header { font-weight: bold; opacity: 0.6; margin-bottom: 4px; }
  .quilx-conversation-system { opacity: 0.6; font-style: italic; }
  .quilx-conversation-error { color: ${theme.ui.status.error}; }
  /* The input + its status strip, as a bordered rounded card with its own bg. */
  .quilx-conversation-input-card {
    margin: 8px;
    border: 1px solid ${theme.ui.border};
    border-radius: 12px;
    background: ${theme.ui.surface.popover};
  }
  /* Let the card's background show through the editor (no separate editor bg). */
  #AgentConversationPrompt,
  #AgentConversationPrompt scrolledwindow,
  #AgentConversationPrompt textview,
  #AgentConversationPrompt textview text {
    background: transparent;
  }
  .quilx-conversation-footer {
    padding: 6px 12px;
    border-top: 1px solid ${theme.ui.border}; /* divider between the input and the status strip */
  }
  /* The permission-mode dropdown, colored per mode (like Claude Code). */
  .quilx-conversation-mode { min-height: 0; }
  .quilx-cmode-default { color: ${theme.ui.text.muted}; }
  .quilx-cmode-acceptEdits { color: ${theme.ui.status.success}; }
  .quilx-cmode-auto { color: ${theme.ui.status.warning}; }
  .quilx-cmode-plan { color: ${theme.ui.status.info}; }
  .quilx-conversation-perm {
    padding: 8px; margin: 6px 0;
    border: 1px solid ${theme.ui.surface.selected};
    border-radius: 6px;
  }
  #AgentConversationPrompt { padding: 0; }
`);
// The monospace bits (tool rows, permission detail) use the app's configured
// monospace font, not a generic family.
fonts.monospace('.quilx-conversation-tool');
fonts.monospace('.quilx-conversation-result');

// Status / checklist glyphs (Nerd Font codepoints).
const GLYPH = {
  pending: 0xf252, // hourglass
  done: 0xf00c, // check
  error: 0xf00d, // times
  todoDone: 0xf046, // check-square
  todoActive: 0xf138, // caret-right
  todoOpen: 0xf096, // square-o
};

// An icon-font span, optionally coloured.
function iconSpan(cp: number, color?: string): string {
  const open = color ? `<span font_family="${ICON_FONT_FAMILY}" foreground="${color}">` : `<span font_family="${ICON_FONT_FAMILY}">`;
  return `${open}${String.fromCodePoint(cp)}</span>`;
}

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
    // shift-tab cycles the permission mode anywhere in the conversation.
    '#AgentConversation': {
      'shift-tab': 'conversation:cycle-permission-mode',
    },
  });
}

// The permission modes shift-tab cycles through / the dropdown offers.
const PERMISSION_CYCLE: AgentMode[] = ['default', 'acceptEdits', 'auto', 'plan'];

export interface AgentConversationOptions {
  /** Working directory for claude. */
  cwd: string;
  /** Base argv (default `['claude']`). */
  command?: string[];
  /** An initial prompt to send once the session starts. */
  prompt?: string;
  /** Open a file the agent touched (makes file-tool rows clickable). */
  onOpenFile?: (path: string) => void;
}

export class AgentConversation implements Agent {
  readonly root: InstanceType<typeof Gtk.Box>;
  private readonly session: SdkSession;
  private readonly cwd: string;
  private readonly messages: InstanceType<typeof Gtk.Box>;
  private readonly scroller: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly input: TextEditor;
  private readonly promptContainer: InstanceType<typeof Gtk.Box>;
  private readonly footer: InstanceType<typeof Gtk.Box>;
  private readonly footerLabel: InstanceType<typeof Gtk.Label>;
  private readonly modeDropdown: InstanceType<typeof Gtk.DropDown>;
  private applyingMode = false; // guards the dropdown's notify::selected feedback loop
  private readonly statusIcon: { widget: InstanceType<typeof Gtk.Widget>; dispose: () => void };
  private readonly subs = new CompositeDisposable();
  private readonly launchPrompt?: string;

  // Tool-use rows keyed by tool_use_id, so the matching result can update the
  // row's status icon + append a preview.
  // Each tool row supplies a handler that fills in its result (per-tool layout:
  // Bash output toggle, Task markdown card, or a plain preview).
  private readonly toolRows = new Map<string, { onResult: (isError: boolean, text: string) => void }>();
  // The structured task list (TaskCreate/TaskUpdate): a dedicated sticky panel,
  // not message rows. `tasks` is keyed by task id (from the TaskCreate result);
  // `pendingTaskCreates` maps a TaskCreate tool_use_id → subject until its result
  // gives the id. The panel hides once every task is completed.
  private readonly tasks = new Map<string, { subject: string; status: string }>();
  private readonly pendingTaskCreates = new Map<string, string>();
  private readonly tasksPanel: InstanceType<typeof Gtk.Box>;
  private readonly tasksList: InstanceType<typeof Gtk.Box>;
  private _costUsd: number | null = null;
  private _contextTokens: number | null = null;
  private _contextWindow = 1_000_000; // refined from result.modelUsage[model].contextWindow
  private _model: string | null = null;
  private _slashCommands: string[] = []; // from init; offered by the slash completion source
  private readonly onOpenFile?: (path: string) => void;

  // Per-turn streaming state: the open assistant/thinking markdown views and the
  // raw markdown accumulated into each (re-rendered on every delta). Reset per turn.
  private assistantView: MarkdownView | null = null;
  private assistantRaw = '';
  private thinkingView: MarkdownView | null = null;
  private thinkingRaw = '';

  // --- Agent state (mirrors AgentTerminal) ---
  private _status: AgentStatus = 'idle';
  private _permissionMode: AgentMode = 'default';
  private readonly permissionModeHandlers: Array<() => void> = [];
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
    this.onOpenFile = options.onOpenFile;
    this.session = new SdkSession({ cwd: options.cwd, command: options.command });

    this.messages = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.messages.addCssClass('quilx-conversation-transcript');
    this.scroller = new Gtk.ScrolledWindow({ vexpand: true });
    this.scroller.setChild(this.messages);

    // A buffer-only editor (full vim editing) as the prompt input, wrapped in a
    // named container so the enter/alt-enter keymap can scope to it.
    this.input = new TextEditor({ buffer: { placeholder: 'Message claude…' } });
    this.input.root.setVexpand(false);
    this.input.root.setSizeRequest(-1, 96); // ~5 lines tall; the editor scrolls internally beyond that
    this.input.addCompletionSource(createSlashCommandSource(() => this._slashCommands));
    this.promptContainer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.promptContainer.setName('AgentConversationPrompt');
    this.promptContainer.setVexpand(false);
    this.promptContainer.append(this.input.root);

    // A thin footer: the agent status icon (same as the sidebar) + a permission-mode
    // dropdown (colored per mode) + cost / context.
    this.statusIcon = createAgentStatusIcon(this);
    this.modeDropdown = Gtk.DropDown.newFromStrings(PERMISSION_CYCLE);
    this.modeDropdown.addCssClass('flat');
    this.modeDropdown.addCssClass('quilx-conversation-mode');
    this.modeDropdown.on('notify::selected', () => {
      if (this.applyingMode) return;
      const mode = PERMISSION_CYCLE[this.modeDropdown.getSelected()];
      if (mode) this.session.setPermissionMode(mode);
    });
    this.footerLabel = new Gtk.Label({ xalign: 0, hexpand: true });
    this.footer = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    this.footer.addCssClass('quilx-conversation-footer');
    this.footer.append(this.statusIcon.widget);
    this.footer.append(this.modeDropdown);
    this.footer.append(this.footerLabel);
    this.updateFooter();

    // A sticky tasks panel at the top (TaskCreate/TaskUpdate); hidden until tasks exist.
    this.tasksPanel = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.tasksPanel.addCssClass('quilx-conversation-tasks');
    this.tasksPanel.setVisible(false);
    const tasksHeader = new Gtk.Label({ xalign: 0, label: 'Tasks' });
    tasksHeader.addCssClass('quilx-conversation-tasks-header');
    this.tasksList = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
    this.tasksPanel.append(tasksHeader);
    this.tasksPanel.append(this.tasksList);

    // The input and its status strip live together in a bordered, rounded card.
    // `overflow: hidden` (the GTK CSS property) doesn't exist — the equivalent is
    // setOverflow(HIDDEN), which clips children to the rounded border so the
    // TextEditor's square background corners don't escape the radius.
    const inputCard = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    inputCard.addCssClass('quilx-conversation-input-card');
    inputCard.setOverflow(Gtk.Overflow.HIDDEN);
    inputCard.append(this.promptContainer);
    inputCard.append(this.footer);

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.setName('AgentConversation');
    this.root.addCssClass('quilx-conversation');
    this.root.append(this.tasksPanel);
    this.root.append(this.scroller);
    this.root.append(inputCard);

    this.installCommands(); // after this.root exists (commands register on it)
    quilx.agents.add(this); // join the registry → sidebar lists it
    this.wireSession();
  }

  // Sync the mode dropdown (selection + color) and the cost/context label. The
  // status itself is the icon to the left (self-updating).
  private updateFooter(): void {
    const index = PERMISSION_CYCLE.indexOf(this._permissionMode);
    if (index >= 0 && this.modeDropdown.getSelected() !== index) {
      this.applyingMode = true; // setSelected fires notify::selected — don't loop back
      this.modeDropdown.setSelected(index);
      this.applyingMode = false;
    }
    for (const m of PERMISSION_CYCLE) this.modeDropdown.removeCssClass(`quilx-cmode-${m}`);
    this.modeDropdown.addCssClass(`quilx-cmode-${this._permissionMode}`);

    const parts: string[] = [];
    if (this._model) parts.push(this._model.replace(/^claude-/, ''));
    if (this._contextTokens != null) {
      const pct = Math.round((this._contextTokens / this._contextWindow) * 100);
      parts.push(`${(this._contextTokens / 1000).toFixed(0)}k (${pct}%)`);
    }
    if (this._costUsd != null) parts.push(`$${this._costUsd.toFixed(2)}`);
    this.footerLabel.setText(parts.join('   ·   '));
  }

  /** Spawn claude and send the launch prompt (if any). */
  start(): void {
    this.session.start();
    if (this.launchPrompt) this.session.prompt(this.launchPrompt);
    this.input.focusInsert(); // ready to type immediately, not vim normal mode
  }

  // --- Agent surface ----------------------------------------------------------

  get title(): string { return this._displayName ?? 'claude (sdk)'; }
  get status(): AgentStatus { return this._status; }
  get permissionMode(): AgentMode { return this._permissionMode; }
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
  onDidChangePermissionMode(cb: () => void): () => void { return push(this.permissionModeHandlers, cb); }
  onDidChangeWorktree(_cb: () => void): () => void { return () => {}; }

  dispose(): void {
    this.subs.dispose();
    this.statusIcon.dispose();
    this.input.dispose();
    this.session.dispose();
    quilx.agents.remove(this);
  }

  // --- input ------------------------------------------------------------------

  // The conversation commands, bound via the keymap (registerPromptKeymapOnce).
  // Registered on `this.root` so they resolve from anywhere in the conversation.
  private installCommands(): void {
    registerPromptKeymapOnce();
    this.subs.add(
      quilx.commands.add(this.root, {
        'conversation:submit-prompt': {
          didDispatch: () => this.submit(),
          description: 'Submit the prompt to the agent',
        },
        'conversation:prompt-newline': {
          didDispatch: () => this.input.insertText('\n'),
          description: 'Insert a newline in the prompt',
        },
        'conversation:cycle-permission-mode': {
          didDispatch: () => this.cyclePermissionMode(),
          description: 'Cycle the agent permission mode (default / acceptEdits / plan)',
        },
      }),
    );
  }

  private cyclePermissionMode(): void {
    const index = PERMISSION_CYCLE.indexOf(this._permissionMode);
    const next = PERMISSION_CYCLE[(index + 1) % PERMISSION_CYCLE.length];
    this.session.setPermissionMode(next);
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
      this.session.onMode(() => {
        this._permissionMode = this.session.permissionMode;
        this.updateFooter();
        for (const handler of this.permissionModeHandlers) handler();
      }),
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
      this.session.onToolUse(({ id, name, input }) => {
        if (this.handleTaskTool(id, name, input)) return; // TaskCreate/TaskUpdate → tasks panel, no row
        this.recordChangedFile(name, input);
        this.endTurn(); // close the current message; post-tool text opens a fresh bubble
        this.addToolRow(id, name, input);
      }),
      this.session.onToolResult(({ id, isError, text }) => {
        if (this.handleTaskResult(id, text)) return; // TaskCreate result → record the new task id
        this.updateToolResult(id, isError, text);
      }),
      this.session.onInit(({ model, slashCommands }) => { this._model = model; this._slashCommands = slashCommands; this.updateFooter(); }),
      this.session.onContext(({ tokens }) => { this._contextTokens = tokens; this.updateFooter(); }),
      this.session.onResult(({ costUsd, contextWindow }) => {
        if (costUsd != null) this._costUsd = costUsd;
        if (contextWindow) this._contextWindow = contextWindow;
        this.updateFooter();
      }),
      this.session.onError(({ message }) => this.addErrorRow(message)),
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
    this.updateFooter();
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

  // --- tasks panel (TaskCreate/TaskUpdate) ------------------------------------

  // Intercept the structured task tools: they drive the sticky tasks panel, not
  // message rows. Returns true when handled (so no tool row is drawn).
  private handleTaskTool(id: string, name: string, input: unknown): boolean {
    const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (name === 'TaskCreate') {
      this.pendingTaskCreates.set(id, typeof i.subject === 'string' ? i.subject : '');
      return true;
    }
    if (name === 'TaskUpdate') {
      const taskId = i.taskId != null ? String(i.taskId) : '';
      const task = this.tasks.get(taskId);
      if (task) {
        if (typeof i.status === 'string') task.status = i.status;
        if (typeof i.subject === 'string') task.subject = i.subject;
      }
      this.renderTasksPanel();
      return true;
    }
    return false;
  }

  // A TaskCreate result carries the new task's id ("Task #N created…"); record it
  // against the subject we stashed on the tool call. Returns true when handled.
  private handleTaskResult(id: string, text: string): boolean {
    const subject = this.pendingTaskCreates.get(id);
    if (subject === undefined) return false;
    this.pendingTaskCreates.delete(id);
    const match = text.match(/#(\d+)/);
    const taskId = match ? match[1] : `t${this.tasks.size + 1}`;
    this.tasks.set(taskId, { subject, status: 'pending' });
    this.renderTasksPanel();
    return true;
  }

  // Re-render the panel; hide it once every (non-deleted) task is completed.
  private renderTasksPanel(): void {
    const visible = [...this.tasks.values()].filter((t) => t.status !== 'deleted');
    if (visible.length === 0 || visible.every((t) => t.status === 'completed')) {
      this.tasksPanel.setVisible(false);
      return;
    }
    clearBox(this.tasksList);
    for (const task of this.tasks.values()) {
      if (task.status === 'deleted') continue;
      const cp = task.status === 'completed' ? GLYPH.todoDone : task.status === 'in_progress' ? GLYPH.todoActive : GLYPH.todoOpen;
      const color = task.status === 'completed' ? theme.ui.status.success : task.status === 'in_progress' ? theme.ui.status.warning : undefined;
      const body = task.status === 'completed' ? `<s>${escapeMarkup(task.subject)}</s>` : escapeMarkup(task.subject);
      const label = new Gtk.Label({ xalign: 0, wrap: true });
      setMarkupSafe(label, `${iconSpan(cp, color)}  ${body}`, task.subject);
      this.tasksList.append(label);
    }
    this.tasksPanel.setVisible(true);
  }

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

  // An error notice in the conversation flow (refusal / max-turns / API error).
  private addErrorRow(message: string): void {
    const label = this.addRow('quilx-conversation-error');
    setMarkupSafe(label, `${iconSpan(GLYPH.error, theme.ui.status.error)}  ${escapeMarkup(message)}`, message);
  }

  // A tool-use row: a status slot (red ✗ only on failure) + the formatted tool, a
  // result area filled when the result lands, and the TodoWrite checklist inline.
  // Bash gets a bespoke row (the command itself is the output toggle).
  private addToolRow(id: string, name: string, input: unknown): void {
    if (name === 'Bash') { this.addBashRow(id, input); return; }

    const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    row.addCssClass('quilx-conversation-row');

    const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    const status = new Gtk.Label({ valign: Gtk.Align.START });
    const tool = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, hexpand: true });
    tool.addCssClass('quilx-conversation-toolrow');
    setMarkupSafe(tool, toolMarkup(name, input, { cwd: this.cwd, monoFamily: fonts.monospaceFamily }), `${name} ${summarizeInput(input)}`);
    header.append(status);
    header.append(tool);
    row.append(header);

    // File tools (Read/Write/Edit/…) are clickable → open the file in the editor.
    const filePath = toolFilePath(name, input);
    if (filePath && this.onOpenFile) {
      header.setCursorFromName('pointer');
      const click = new Gtk.GestureClick();
      click.on('released', () => this.onOpenFile!(filePath));
      header.addController(click);
    }

    const resultBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    resultBox.setMarginStart(22); // align under the tool text, past the status icon
    row.append(resultBox);

    // TodoWrite carries its checklist in the input — render it now, not on result.
    const todos = (input as { todos?: unknown })?.todos;
    if (name === 'TodoWrite' && Array.isArray(todos)) resultBox.append(renderTodos(todos));

    this.messages.append(row);
    if (id) this.toolRows.set(id, { onResult: (isError, text) => this.fillToolResult(status, resultBox, name, isError, text) });
    this.scrollToBottom();
  }

  // Bash: no icon — the command (monospace) is itself the toggle that reveals the
  // output (collapsed by default, expanded on error, where the command also gets a ✗).
  private addBashRow(id: string, input: unknown): void {
    const command = (input as { command?: unknown })?.command;
    const cmd = typeof command === 'string' ? command : summarizeInput(input);
    const mono = (text: string) => `<span face="${escapeMarkup(fonts.monospaceFamily)}">${escapeMarkup(text)}</span>`;

    const expander = new Gtk.Expander();
    expander.addCssClass('quilx-conversation-row');
    const label = new Gtk.Label({ xalign: 0, wrap: true, selectable: true });
    label.addCssClass('quilx-conversation-toolrow');
    setMarkupSafe(label, mono(cmd), cmd);
    expander.setLabelWidget(label);
    const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    expander.setChild(content);
    this.messages.append(expander);

    if (id) this.toolRows.set(id, {
      onResult: (isError, text) => {
        const trimmed = text.trim();
        if (trimmed) {
          const out = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, label: truncateLines(trimmed, 40, 4000) });
          out.addCssClass('quilx-conversation-result');
          content.append(out);
        }
        if (isError) {
          setMarkupSafe(label, `<span foreground="${theme.ui.status.error}">✗</span> ${mono(cmd)}`, cmd);
          expander.setExpanded(true);
        }
      },
    });
    this.scrollToBottom();
  }

  // Fill a non-Bash tool row's result: a red ✗ on failure, then a markdown card for
  // Task (the subagent's report) or a truncated text preview otherwise.
  private fillToolResult(
    status: InstanceType<typeof Gtk.Label>,
    resultBox: InstanceType<typeof Gtk.Box>,
    name: string,
    isError: boolean,
    text: string,
  ): void {
    if (isError) setMarkupSafe(status, iconSpan(GLYPH.error, theme.ui.status.error), '✗');
    const trimmed = text.trim();
    if (!trimmed) return;
    if (name === 'Task') {
      const view = new MarkdownView();
      view.root.addCssClass('quilx-conversation-task-result');
      resultBox.append(view.root);
      view.setMarkdown(trimmed);
    } else {
      const label = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, label: truncateLines(trimmed, 8, 800) });
      label.addCssClass('quilx-conversation-result');
      resultBox.append(label);
    }
  }

  private updateToolResult(id: string, isError: boolean, text: string): void {
    const row = this.toolRows.get(id);
    if (!row) return;
    row.onResult(isError, text);
    this.scrollToBottom();
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
      this.messages.remove(card); // the prompt is answered — drop it from the transcript
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

/** Remove every child of a box (GTK4 has no clear()). */
function clearBox(box: InstanceType<typeof Gtk.Box>): void {
  let child = box.getFirstChild();
  while (child) {
    const next = child.getNextSibling();
    box.remove(child);
    child = next;
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

/** Set Pango markup, falling back to plain `fallback` if Pango rejects it. */
function setMarkupSafe(label: InstanceType<typeof Gtk.Label>, markup: string, fallback: string): void {
  try {
    label.setMarkup(markup);
  } catch {
    label.setText(fallback);
  }
}

// A TodoWrite checklist: one glyph-prefixed row per todo (completed struck through).
function renderTodos(todos: unknown[]): InstanceType<typeof Gtk.Box> {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
  for (const raw of todos) {
    const todo = (raw && typeof raw === 'object' ? raw : {}) as { content?: unknown; status?: unknown };
    const content = typeof todo.content === 'string' ? todo.content : '';
    const status = todo.status;
    const cp = status === 'completed' ? GLYPH.todoDone : status === 'in_progress' ? GLYPH.todoActive : GLYPH.todoOpen;
    const color = status === 'completed' ? theme.ui.status.success : status === 'in_progress' ? theme.ui.status.warning : undefined;
    const body = status === 'completed' ? `<s>${escapeMarkup(content)}</s>` : escapeMarkup(content);
    const label = new Gtk.Label({ xalign: 0, wrap: true });
    setMarkupSafe(label, `${iconSpan(cp, color)}  ${body}`, content);
    box.append(label);
  }
  return box;
}

// First `maxLines` lines of `text`, capped at `maxChars`, with an ellipsis when truncated.
function truncateLines(text: string, maxLines: number, maxChars: number): string {
  if (!text) return '';
  const lines = text.split('\n');
  let out = lines.slice(0, maxLines).join('\n');
  const truncated = lines.length > maxLines || out.length > maxChars;
  if (out.length > maxChars) out = out.slice(0, maxChars);
  return truncated ? out.replace(/\s+$/, '') + ' …' : out;
}
