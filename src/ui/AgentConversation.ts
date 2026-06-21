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
import { Gtk, Adw, Pango } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { fonts } from '../fonts.ts';
import { quilx } from '../quilx.ts';
import { worktreeInfo, type WorktreeInfo } from '../git.ts';
import { TextEditor } from './TextEditor/TextEditor.ts';
import { createSlashCommandSource } from './TextEditor/createSlashCommandSource.ts';
import { MarkdownView } from './markdown/MarkdownView.ts';
import { toolMarkup, toolDetailMarkup, toolFilePath, describeTool } from './toolDisplay.ts';
import { escapeMarkup, setMarkupSafe, clearChildren } from './proseMarkup.ts';
import { iconSpan } from './icons.ts';
import { truncateLines, summarizeInput, formatCount, progressLine } from './conversation/format.ts';
import { StickyListPanel } from './conversation/StickyListPanel.ts';
import { permissionCard } from './conversation/cards.ts';
import { QuestionCard } from './conversation/QuestionCard.ts';
import { SubagentView } from './conversation/SubagentView.ts';
import { MonitorView } from './conversation/MonitorView.ts';
import { createAgentStatusIcon } from './agentStatusIcon.ts';
import { NERDFONT } from './nerdfont.ts';
import { highlightToMarkup } from '../syntax/highlightToMarkup.ts';
import { SdkSession, type PermissionRequest, type QuestionRequest, type TaskProgress } from '../agents/claude-sdk/SdkSession.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import type { Agent, AgentMode, AgentStatus } from '../agents/types.ts';
import type { TabState } from '../SessionManager.ts';

// Tools whose first input path counts as a "changed file" (mirrors the claude-tui
// PostToolUse Edit|Write|MultiEdit|NotebookEdit hook).

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Colors come from the theme as CSS variables (--t-ui-*); the monospace bits read
// the font store's --t-font-monospace-family. See tasks/styling.md + theming.md.
addStyles(`
  .quilx-conversation { background: var(--t-ui-editor-background); color: var(--t-ui-editor-foreground); }
  .quilx-conversation-transcript { padding: 12px; }
  .quilx-conversation-row { padding: 6px 0; }
  /* User and assistant share the bubble shape; only the background differs. */
  .quilx-conversation-user, .quilx-conversation-assistant {
    padding: 14px 18px;
    margin: 8px 0;
    border-radius: 10px;
  }
  .quilx-conversation-user { background: var(--t-ui-surface-selected); }
  .quilx-conversation-assistant { background: var(--t-ui-surface-popover); }
  .quilx-conversation-thinking { opacity: 0.55; font-style: italic; padding-left: 12px; }
  .quilx-conversation-tool { opacity: 0.8; }
  .quilx-conversation-toolrow { opacity: 0.85; }
  /* File tools open their file via a flat button styled as an inline link. */
  .quilx-conversation-toolbutton {
    padding: 1px 4px; min-height: 0;
  }
  .quilx-conversation-thinking-row { padding: 6px 12px; }
  /* A message queued while the agent is busy — a right-aligned bubble above the spinner. */
  .quilx-conversation-pending {
    background: var(--t-ui-surface-selected);
    border-radius: 10px;
    padding: 6px 10px;
    margin: 0 12px;
  }
  /* Subagent transcript: the "view conversation" link + the pushed page's header. */
  .quilx-conversation-subagent-link { padding: 1px 4px; min-height: 0; color: var(--t-ui-text-info); }
  .quilx-conversation-subagent-header { padding: 6px; border-bottom: 1px solid var(--t-ui-border); }
  .quilx-conversation-result {
    opacity: 0.7;
    background: var(--t-ui-surface-popover);
    padding: 4px 8px;
    margin-top: 2px;
    border-radius: 4px;
  }
  /* A Task (subagent) report renders as a fuller markdown card. */
  .quilx-conversation-task-result {
    background: var(--t-ui-surface-popover);
    border-left: 3px solid var(--t-ui-surface-selected);
    padding: 6px 10px;
    margin-top: 4px;
    border-radius: 4px;
  }
  .quilx-conversation-tasks {
    padding: 8px 12px;
    background: var(--t-ui-surface-popover);
    border-bottom: 1px solid var(--t-ui-border);
  }
  .quilx-conversation-tasks-header { font-weight: bold; opacity: 0.6; margin-bottom: 4px; }
  /* The running-subagents panel sits below the input card → divider on top, not bottom. */
  .quilx-conversation-subagents { border-top: 1px solid var(--t-ui-border); border-bottom: none; }
  .quilx-conversation-system { opacity: 0.6; font-style: italic; }
  .quilx-conversation-error { color: var(--t-ui-status-error); }
  /* An unrecognised stream event, dumped as raw JSON so nothing is silently lost. */
  .quilx-conversation-unknown {
    border-left: 2px solid var(--t-ui-status-warning);
    padding-left: 8px;
    background: var(--t-ui-surface-popover);
    border-radius: 4px;
  }
  .quilx-conversation-unknown-body { opacity: 0.75; }
  /* The input + its status strip, as a bordered rounded card with its own bg. */
  .quilx-conversation-input-card {
    margin: 8px;
    border: 1px solid var(--t-ui-border);
    border-radius: 12px;
    background: var(--t-ui-surface-popover);
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
    border-top: 1px solid var(--t-ui-border); /* divider between the input and the status strip */
  }
  /* The footer metadata (model · context · cost) reads as muted secondary text. */
  .quilx-conversation-footer-label { color: var(--t-ui-text-muted); }
  /* The permission-mode dropdown, colored per mode (like Claude Code). */
  .quilx-conversation-mode { min-height: 0; }
  .quilx-cmode-default { color: var(--t-ui-text-muted); }
  .quilx-cmode-acceptEdits { color: var(--t-ui-status-success); }
  .quilx-cmode-auto { color: var(--t-ui-status-warning); }
  .quilx-cmode-plan { color: var(--t-ui-status-info); }
  .quilx-conversation-perm {
    padding: 8px; margin: 6px 0;
    border: 1px solid var(--t-ui-surface-selected);
    border-radius: 6px;
  }
  /* AskUserQuestion: an interactive choice card (info-tinted while open). Split
     into a choice list (left) + a detail pane (right) for the focused choice. */
  .quilx-conversation-question {
    padding: 10px; margin: 6px 0;
    border: 1px solid var(--t-ui-status-info);
    border-radius: 6px;
  }
  /* Once answered the border is dropped — it's just a record of the choice. */
  .quilx-conversation-question-answered { padding: 6px 0; margin: 6px 0; }
  .quilx-conversation-question-h { font-weight: bold; opacity: 0.6; }
  .quilx-conversation-question-split { }
  .quilx-conversation-question-list { background: transparent; min-width: 150px; }
  .quilx-conversation-question-opt { padding: 2px 4px; }
  .quilx-conversation-question-detail {
    padding: 2px 12px; opacity: 0.8;
    border-left: 1px solid var(--t-ui-border);
  }
  #AgentConversationPrompt { padding: 0; }
  /* The monospace bits (tool rows, JSON dumps) follow the font store. */
  .quilx-conversation-tool,
  .quilx-conversation-result,
  .quilx-conversation-unknown-body { font-family: var(--t-font-monospace-family); }
`);

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
    // shift-tab cycles the permission mode; ctrl-c interrupts the running turn —
    // both anywhere in the conversation. ctrl-c falls through to its default (copy)
    // when nothing is running (the command aborts the binding).
    '#AgentConversation': {
      'shift-tab': 'conversation:cycle-permission-mode',
      'ctrl-c': 'conversation:interrupt',
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
  readonly root: InstanceType<typeof Adw.NavigationView>; // root page = the conversation; subagent transcripts push pages
  private readonly session: SdkSession;
  private readonly cwd: string;
  private readonly messages: InstanceType<typeof Gtk.Box>;
  private readonly scroller: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly thinkingReveal: InstanceType<typeof Gtk.Revealer>; // spinner + pending message above the prompt
  private readonly thinkingLabel: InstanceType<typeof Gtk.Label>; // "Thinking…" + live token count
  private readonly thinkingRow: InstanceType<typeof Gtk.Box>; // the spinner row (shown while working)
  private readonly pendingBox: InstanceType<typeof Gtk.Box>; // a queued message shown above the spinner
  private readonly pendingLabel: InstanceType<typeof Gtk.Label>;
  private pendingText = ''; // a message submitted while busy, sent once the agent is idle
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
  private readonly toolRows = new Map<string, { onResult: (isError: boolean, text: string) => void; onProgress?: (p: TaskProgress) => void }>();
  // The structured task list (TaskCreate/TaskUpdate): a dedicated sticky panel,
  // not message rows. `tasks` is keyed by task id (from the TaskCreate result);
  // `pendingTaskCreates` maps a TaskCreate tool_use_id → subject until its result
  // gives the id. The panel hides once every task is completed.
  private readonly tasks = new Map<string, { subject: string; status: string }>();
  private readonly pendingTaskCreates = new Map<string, string>();
  private readonly tasksPanel = new StickyListPanel('Tasks');
  // Spawned subagents (the `Agent` tool): inline button + running panel + page.
  private readonly subagentView: SubagentView;
  // Shell monitors (the `Monitor` tool): inline button + running panel + page + cancel.
  private readonly monitorView: MonitorView;
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

    // Above the prompt, in a slide Revealer: an optional right-aligned "pending"
    // message (a turn the user queued while the agent was busy) over a "Thinking…"
    // spinner row. The reveal is shown while working or while a message is pending.
    this.thinkingRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    this.thinkingRow.addCssClass('quilx-conversation-thinking-row');
    const spinner = new Adw.Spinner();
    spinner.setSizeRequest(16, 16); // Adw.Spinner fills its allocation otherwise
    this.thinkingRow.append(spinner);
    this.thinkingLabel = new Gtk.Label({ label: 'Thinking…' });
    this.thinkingLabel.addCssClass('quilx-conversation-system');
    this.thinkingRow.append(this.thinkingLabel);

    this.pendingBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, halign: Gtk.Align.END });
    this.pendingBox.addCssClass('quilx-conversation-pending');
    this.pendingBox.setVisible(false);
    this.pendingLabel = new Gtk.Label({ xalign: 1, wrap: true });
    const pendingHint = new Gtk.Label({ xalign: 1, label: 'Pending' });
    pendingHint.addCssClass('quilx-conversation-system');
    this.pendingBox.append(this.pendingLabel);
    this.pendingBox.append(pendingHint);

    const thinkingContent = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
    thinkingContent.append(this.pendingBox);
    thinkingContent.append(this.thinkingRow);
    this.thinkingReveal = new Gtk.Revealer();
    this.thinkingReveal.setTransitionType(Gtk.RevealerTransitionType.SLIDE_UP);
    this.thinkingReveal.setChild(thinkingContent);
    this.thinkingReveal.setRevealChild(false);

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
    this.footerLabel.addCssClass('quilx-conversation-footer-label');
    this.footer = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 14 });
    this.footer.addCssClass('quilx-conversation-footer');
    this.footer.append(this.statusIcon.widget);
    this.footer.append(this.modeDropdown);
    this.footer.append(this.footerLabel);
    this.updateFooter();

    // The input and its status strip live together in a bordered, rounded card.
    // `overflow: hidden` (the GTK CSS property) doesn't exist — the equivalent is
    // setOverflow(HIDDEN), which clips children to the rounded border so the
    // TextEditor's square background corners don't escape the radius.
    const inputCard = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    inputCard.addCssClass('quilx-conversation-input-card');
    inputCard.setOverflow(Gtk.Overflow.HIDDEN);
    inputCard.append(this.promptContainer);
    inputCard.append(this.footer);

    // Subagents push pages onto this.root (the NavigationView, assigned next); the
    // push/pop arrows defer that lookup until a click.
    const nav = { push: (page: InstanceType<typeof Adw.NavigationPage>) => this.root.push(page), pop: () => this.root.pop() };
    this.subagentView = new SubagentView(this.session, nav, this.cwd);
    this.monitorView = new MonitorView(this.session, nav);

    const mainBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
    mainBox.addCssClass('quilx-conversation');
    mainBox.append(this.tasksPanel.root);
    mainBox.append(this.scroller);
    mainBox.append(this.thinkingReveal); // the thinking spinner sits just above the prompt
    mainBox.append(inputCard);
    mainBox.append(this.subagentView.panel.root); // running subagents expand below the input card
    mainBox.append(this.monitorView.panel.root); // running shell monitors, likewise

    // A NavigationView so a subagent's transcript can push its own page.
    this.root = new Adw.NavigationView();
    this.root.setName('AgentConversation');
    this.root.add(Adw.NavigationPage.new(mainBox, 'Conversation'));

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
        'conversation:interrupt': {
          // Interrupt the running turn; if nothing is running, abort so ctrl-c
          // keeps its default behaviour (copy a transcript selection).
          didDispatch: (event) => { if (!this.session.interrupt()) event.abortKeyBinding(); },
          description: 'Interrupt the running agent turn',
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
    if (this._status === 'idle') { this.session.prompt(text); return; }
    // The agent is busy — queue (accumulate) the message; it's sent on next idle.
    this.pendingText = this.pendingText ? `${this.pendingText}\n\n${text}` : text;
    this.refreshThinking();
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
        this.thinkingLabel.setText('Thinking…'); // reset the live token count for the new turn
        this.addMarkdownBlock('quilx-conversation-user', Gtk.Align.END).setMarkdown(text);
      }),
      // Live "Thinking… (N tokens)" while the model reasons before producing output.
      this.session.onThinkingTokens(({ tokens }) => {
        this.thinkingLabel.setText(tokens > 0 ? `Thinking… (${formatCount(tokens)} tokens)` : 'Thinking…');
      }),
      // Subagent / background-task live progress → the originating tool row.
      this.session.onTaskProgress((p) => this.toolRows.get(p.id)?.onProgress?.(p)),
      // Shown by subagentView.spawn (on the Agent tool call); hidden on completion.
      this.session.onSubagentDone(({ id }) => this.subagentView.done(id)),
      // Monitor status changes (running → killed/stopped/completed) refresh the panel.
      this.session.onMonitorUpdate(({ id }) => this.monitorView.update(id)),
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
        if (name === 'AskUserQuestion') return; // handled by the interactive question card
        if (name === 'Agent') { this.endTurn(); this.messages.append(this.subagentView.spawn(id, input)); this.scrollToBottom(); return; }
        if (name === 'Monitor') {
          const mi = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
          const desc = typeof mi.description === 'string' ? mi.description : typeof mi.command === 'string' ? mi.command : 'monitor';
          this.endTurn(); this.messages.append(this.monitorView.spawn(id, desc)); this.scrollToBottom(); return;
        }
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
      this.session.onInterrupted(() => this.addInterruptedRow()),
      this.session.onUnhandled(({ event }) => this.addUnknownRow(event)),
      this.session.onPermission((req) => this.addPermissionCard(req)),
      this.session.onQuestion((req) => this.addQuestionCard(req)),
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
    this.refreshThinking();
    this.updateFooter();
    for (const handler of this.statusHandlers) handler();
    if (this.needsAttention !== wasAttention) this.emitAttention();
    // A message queued while the agent was busy is sent once it goes idle.
    if (status === 'idle' && this.pendingText) {
      const text = this.pendingText;
      this.pendingText = '';
      this.refreshThinking();
      this.session.prompt(text); // re-enters 'working' and renders the user turn
    }
  }

  // Reveal the strip above the prompt when the agent is working (the spinner) or a
  // message is queued (the pending bubble); both can show at once.
  private refreshThinking(): void {
    const working = this._status === 'working';
    const pending = this.pendingText !== '';
    this.thinkingRow.setVisible(working);
    this.pendingLabel.setText(this.pendingText);
    this.pendingBox.setVisible(pending);
    this.thinkingReveal.setRevealChild(working || pending);
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
      this.tasksPanel.render([]);
      return;
    }
    const rows = visible.map((task) => {
      const glyph = task.status === 'completed' ? NERDFONT.TASK.DONE : task.status === 'in_progress' ? NERDFONT.TASK.ACTIVE : NERDFONT.TASK.OPEN;
      const color = task.status === 'completed' ? theme.ui.status.success : task.status === 'in_progress' ? theme.ui.status.warning : undefined;
      const body = task.status === 'completed' ? `<s>${escapeMarkup(task.subject)}</s>` : escapeMarkup(task.subject);
      const label = new Gtk.Label({ xalign: 0, wrap: true });
      setMarkupSafe(label, `${iconSpan(glyph, color)}  ${body}`, task.subject);
      return label;
    });
    this.tasksPanel.render(rows);
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
    setMarkupSafe(label, `${iconSpan(NERDFONT.STATUS.CROSS, theme.ui.status.error)}  ${escapeMarkup(message)}`, message);
  }

  // A muted notice that the user interrupted the turn (ctrl-c).
  private addInterruptedRow(): void {
    const label = this.addRow('quilx-conversation-system');
    setMarkupSafe(label, `${iconSpan(NERDFONT.STATUS.STOP)}  Interrupted`, 'Interrupted');
  }

  // An unrecognised stream event: a warning header + the raw JSON (monospace,
  // selectable) so an unmodeled payload is visible rather than silently dropped.
  private addUnknownRow(event: unknown): void {
    const type = event && typeof event === 'object' && typeof (event as { type?: unknown }).type === 'string'
      ? (event as { type: string }).type : 'unknown';
    let json: string;
    try { json = JSON.stringify(event, null, 2); } catch { json = String(event); }

    const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
    row.addCssClass('quilx-conversation-row');
    row.addCssClass('quilx-conversation-unknown');

    const header = new Gtk.Label({ xalign: 0, wrap: true });
    setMarkupSafe(header, `${iconSpan(NERDFONT.STATUS.WARNING, theme.ui.status.warning)}  unhandled <tt>${escapeMarkup(type)}</tt> event`, `unhandled ${type} event`);
    const body = new Gtk.Label({ xalign: 0, wrap: true, selectable: true });
    body.addCssClass('quilx-conversation-unknown-body');
    body.setText(json);

    row.append(header);
    row.append(body);
    this.messages.append(row);
    this.scrollToBottom();
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
    header.append(status);

    const filePath = toolFilePath(name, input);
    if (filePath && this.onOpenFile) {
      // File tools (Read/Write/Edit/…): the icon + name stay a plain label; only
      // the file path is a flat button that opens the file in the editor.
      const { icon, title, detail } = describeTool(name, input, this.cwd);
      const head = new Gtk.Label({ xalign: 0, wrap: true, selectable: true });
      head.addCssClass('quilx-conversation-toolrow');
      setMarkupSafe(head, `${iconSpan(icon)}${title ? `  <b>${escapeMarkup(title)}</b>` : ''}`, title || name);
      header.append(head);

      const pathLabel = new Gtk.Label({ xalign: 0, wrap: true });
      pathLabel.addCssClass('quilx-conversation-toolrow');
      setMarkupSafe(pathLabel, toolDetailMarkup(detail, fonts.monospaceFamily), detail);
      const button = new Gtk.Button();
      button.addCssClass('flat');
      button.addCssClass('quilx-conversation-toolbutton');
      button.setChild(pathLabel);
      button.on('clicked', () => this.onOpenFile!(filePath));
      header.append(button);
    } else {
      const tool = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, hexpand: true });
      tool.addCssClass('quilx-conversation-toolrow');
      setMarkupSafe(tool, toolMarkup(name, input, { cwd: this.cwd, monoFamily: fonts.monospaceFamily }), `${name} ${summarizeInput(input)}`);
      header.append(tool);
    }
    row.append(header);

    const resultBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    resultBox.setMarginStart(22); // align under the tool text, past the status icon
    row.append(resultBox);

    // TodoWrite carries its checklist in the input — render it now, not on result.
    const todos = (input as { todos?: unknown })?.todos;
    if (name === 'TodoWrite' && Array.isArray(todos)) resultBox.append(renderTodos(todos));

    this.messages.append(row);
    if (id) {
      // Background-task rows (run_in_background) get a live progress line.
      let progress: InstanceType<typeof Gtk.Label> | null = null;
      this.toolRows.set(id, {
        onResult: (isError, text) => this.fillToolResult(status, resultBox, name, isError, text),
        onProgress: (p) => {
          if (!progress) {
            progress = new Gtk.Label({ xalign: 0, wrap: true });
            progress.addCssClass('quilx-conversation-system');
            resultBox.append(progress);
          }
          progress.setText(progressLine(p));
          this.scrollToBottom();
        },
      });
    }
    this.scrollToBottom();
  }


  // Bash: no icon — the command (monospace) is itself the toggle that reveals the
  // output (collapsed by default, expanded on error, where the command also gets a ✗).
  private addBashRow(id: string, input: unknown): void {
    const command = (input as { command?: unknown })?.command;
    const cmd = typeof command === 'string' ? command : summarizeInput(input);
    const firstLine = cmd.split('\n', 1)[0];
    const multiline = cmd.includes('\n');

    // bash syntax highlighting when the grammar is available, else plain mono.
    const monoWrap = (inner: string) => `<span face="${escapeMarkup(fonts.monospaceFamily)}">${inner}</span>`;
    const highlight = (text: string): string => {
      let inner: string | null = null;
      try { inner = highlightToMarkup(text, 'bash'); } catch { /* no grammar */ }
      return monoWrap(inner ?? escapeMarkup(text));
    };

    const expander = new Gtk.Expander();
    expander.addCssClass('quilx-conversation-row');
    const label = new Gtk.Label({ xalign: 0, selectable: true, hexpand: true });
    label.addCssClass('quilx-conversation-toolrow');
    expander.setLabelWidget(label);
    const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    expander.setChild(content);

    // Collapsed: the command is cropped to its first line; the full (multiline)
    // command shows only once expanded.
    let errored = false;
    const render = () => {
      const full = expander.getExpanded() || !multiline;
      const text = full ? cmd : firstLine;
      label.setWrap(full);
      label.setEllipsize(full ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END);
      const prefix = errored ? `<span foreground="${theme.ui.status.error}">✗</span> ` : '';
      setMarkupSafe(label, prefix + highlight(text), text);
    };
    render();
    expander.on('notify::expanded', render);
    this.messages.append(expander);

    let progress: InstanceType<typeof Gtk.Label> | null = null;
    if (id) this.toolRows.set(id, {
      onResult: (isError, text) => {
        const trimmed = text.trim();
        if (trimmed) {
          const out = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, label: truncateLines(trimmed, 40, 4000) });
          out.addCssClass('quilx-conversation-result');
          content.append(out);
        }
        if (isError) {
          errored = true;
          expander.setExpanded(true); // also triggers render() via notify::expanded
          render();
        }
      },
      // Background-bash progress (run_in_background); shown in the expander body.
      onProgress: (p) => {
        if (!progress) {
          progress = new Gtk.Label({ xalign: 0, wrap: true });
          progress.addCssClass('quilx-conversation-system');
          content.append(progress);
        }
        progress.setText(progressLine(p));
        this.scrollToBottom();
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
    if (isError) setMarkupSafe(status, iconSpan(NERDFONT.STATUS.CROSS, theme.ui.status.error), '✗');
    // Read: the file is opened on the side via the clickable path — don't dump its
    // content into the conversation (only a failed Read still shows its error text).
    if (name === 'Read' && !isError) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (name === 'Task' || name === 'Agent') {
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
    const card = permissionCard(req, (allow) => {
      this.session.respondPermission(req.id, { allow });
      this.messages.remove(card); // answered — drop it from the transcript
    });
    this.messages.append(card);
    this.scrollToBottom();
  }

  private addQuestionCard(req: QuestionRequest): void {
    const card = new QuestionCard(req, (answers) => this.session.answerQuestion(req.id, answers));
    this.messages.append(card.root);
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
/** Push `cb` onto `list` and return an unsubscribe that splices it out. */
function push(list: Array<() => void>, cb: () => void): () => void {
  list.push(cb);
  return () => {
    const i = list.indexOf(cb);
    if (i !== -1) list.splice(i, 1);
  };
}

// A TodoWrite checklist: one glyph-prefixed row per todo (completed struck through).
function renderTodos(todos: unknown[]): InstanceType<typeof Gtk.Box> {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
  for (const raw of todos) {
    const todo = (raw && typeof raw === 'object' ? raw : {}) as { content?: unknown; status?: unknown };
    const content = typeof todo.content === 'string' ? todo.content : '';
    const status = todo.status;
    const glyph = status === 'completed' ? NERDFONT.TASK.DONE : status === 'in_progress' ? NERDFONT.TASK.ACTIVE : NERDFONT.TASK.OPEN;
    const color = status === 'completed' ? theme.ui.status.success : status === 'in_progress' ? theme.ui.status.warning : undefined;
    const body = status === 'completed' ? `<s>${escapeMarkup(content)}</s>` : escapeMarkup(content);
    const label = new Gtk.Label({ xalign: 0, wrap: true });
    setMarkupSafe(label, `${iconSpan(glyph, color)}  ${body}`, content);
    box.append(label);
  }
  return box;
}
