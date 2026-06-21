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
 * first-class workbench owner registered in `zym.agents` — the chrome reads
 * `status` / `changedFiles` / etc., never the concrete class.
 */
import { Gtk, Adw, Pango } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { fonts } from '../fonts.ts';
import { zym } from '../zym.ts';
import { worktreeInfo, type WorktreeInfo } from '../git.ts';
import { TextEditor, createInput } from './TextEditor/TextEditor.ts';
import { createSlashCommandSource } from './TextEditor/createSlashCommandSource.ts';
import { MarkdownView } from './markdown/MarkdownView.ts';
import { toolBodyMarkup, toolFilePath, describeTool } from './toolDisplay.ts';
import { escapeMarkup, setMarkupSafe } from './proseMarkup.ts';
import { iconSpan, iconLabel } from './icons.ts';
import { clipboard } from './TextEditor/vim/clipboard.ts';
import { truncateLines, summarizeInput, formatCount, progressLine } from './conversation/format.ts';
import { StickyListPanel } from './conversation/StickyListPanel.ts';
import { permissionCard, permissionButtons } from './conversation/cards.ts';
import { QuestionCard } from './conversation/QuestionCard.ts';
import { ToolRow } from './conversation/ToolRow.ts';
import { SubagentView } from './conversation/SubagentView.ts';
import { MonitorView } from './conversation/MonitorView.ts';
import { ModelContext } from './conversation/ModelContext.ts';
import { createAgentStatusIcon } from './agentStatusIcon.ts';
import { NERDFONT } from './nerdfont.ts';
import { highlightToMarkup } from '../syntax/highlightToMarkup.ts';
import { SdkSession, type PermissionRequest, type QuestionRequest, type TaskProgress } from '../agents/claude-sdk/SdkSession.ts';
import { readTranscript, readContextSeed } from '../agents/claude-sdk/transcript.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import type { Agent, AgentMode, AgentResume, AgentStatus } from '../agents/types.ts';
import type { AgentAction } from '../agents/actions.ts';
import { ActionProcesses } from '../agents/ActionProcesses.ts';
import type { TabState } from '../SessionManager.ts';

// Tools whose first input path counts as a "changed file" (mirrors the claude-tui
// PostToolUse Edit|Write|MultiEdit|NotebookEdit hook).

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Colors come from the theme as CSS variables (--t-ui-*); the monospace bits read
// the font store's --t-font-monospace-family. See docs/styling.md + theming.md.
addStyles(`
  .zym-conversation { background: var(--t-ui-editor-background); color: var(--t-ui-editor-foreground); }
  /* The transcript reads as prose, so it sits a touch larger than the dense chrome
     around it — every message (bubbles, tool rows, results) inherits this size. */
  .zym-conversation-transcript { padding: 16px; font-size: 1.05em; }
  .zym-conversation-row { padding: 6px 0; }
  /* Shared tool rows (tool-use / Bash / unknown event): a leading tool icon next to
     a toggle (a flat header button over a collapsible detail). The container owns
     the horizontal padding (matching the input card); only the toggle expands and
     fades its background to a message bubble's (popover surface) on expand. */
  .zym-conversation-toolrow-container { padding: 0 calc(2 * var(--t-spacing)); }
  /* The leading tool icon. A size group ties its height to the header button's, so
     the label's own vertical centering keeps the glyph centered on the header row. */
  .zym-conversation-toolrow-icon { padding-right: 8px; }
  /* The BUTTON + DETAILS expander: the only part that grows + gains the bubble bg. */
  .zym-conversation-toolrow-toggle {
    border-radius: 8px;
    background: transparent;
    transition: background 150ms ease;
  }
  .zym-conversation-toolrow-expanded { background: var(--t-ui-surface-popover); }
  /* The header button: flat, left-aligned, no min size. Its own transparent
     background suppresses the flat hover, so re-add an explicit hover tint
     (rounded to match the toggle). */
  .zym-conversation-toolrow-button {
    padding: 6px 8px; min-height: 0; border-radius: 8px;
    background: transparent; border: none; box-shadow: none;
  }
  .zym-conversation-toolrow-button:hover { background: var(--t-ui-surface-selected); }
  .zym-conversation-toolrow-detail { padding: 0 8px 6px 8px; }
  /* Allow/Deny buttons embedded in a tool row's details (a permission prompt). */
  .zym-conversation-perm-buttons { margin-top: 4px; }
  /* User and assistant share the bubble shape; only the background differs. The
     generous margin gives consecutive turns clear visual separation. The assistant
     prose is capped to a reading measure in code (MarkdownView max-width-chars) —
     GTK CSS has no max-width. */
  .zym-conversation-user, .zym-conversation-assistant {
    padding: 14px 18px;
    margin: 10px 0;
    border-radius: 10px;
  }
  .zym-conversation-user { background: var(--t-ui-surface-selected); }
  .zym-conversation-assistant { background: var(--t-ui-surface-popover); }
  /* The floating "copy message" button, pinned top-right of the transcript viewport. */
  .zym-conversation-copy { margin: 10px; padding: 2px 6px; min-height: 0; min-width: 0; opacity: 0.5; }
  .zym-conversation-copy:hover { opacity: 1; }
  .zym-conversation-thinking { opacity: 0.55; font-style: italic; padding: 0 calc(2 * var(--t-spacing)); }
  .zym-conversation-tool { opacity: 0.8; }
  .zym-conversation-toolrow { opacity: 0.85; }
  .zym-conversation-thinking-row { padding: 6px calc(2 * var(--t-spacing)); }
  /* A message queued while the agent is busy — a right-aligned bubble above the spinner. */
  .zym-conversation-pending {
    background: var(--t-ui-surface-selected);
    border-radius: 10px;
    padding: 6px 10px;
    margin: 0 12px;
  }
  /* Subagent transcript: the "view conversation" link + the pushed page's header. */
  .zym-conversation-subagent-link { padding: 1px 4px; min-height: 0; color: var(--t-ui-text-info); }
  .zym-conversation-subagent-header { padding: 6px; border-bottom: 1px solid var(--t-ui-border); }
  .zym-conversation-result {
    opacity: 0.7;
    background: var(--t-ui-surface-popover);
    padding: 4px 8px;
    margin-top: 2px;
    border-radius: 4px;
  }
  /* A Task (subagent) report renders as a fuller markdown card. */
  .zym-conversation-task-result {
    background: var(--t-ui-surface-popover);
    border-left: 3px solid var(--t-ui-surface-selected);
    padding: 6px 10px;
    margin-top: 4px;
    border-radius: 4px;
  }
  .zym-conversation-tasks {
    padding: 8px 12px;
    background: var(--t-ui-surface-popover);
    border-bottom: 1px solid var(--t-ui-border);
  }
  .zym-conversation-tasks-header { font-weight: bold; opacity: 0.6; margin-bottom: 4px; }
  /* The running-subagents panel sits below the input card → divider on top, not bottom. */
  .zym-conversation-subagents { border-top: 1px solid var(--t-ui-border); border-bottom: none; }
  .zym-conversation-system { opacity: 0.6; font-style: italic; }
  /* The resume boundary divider: centered, muted, italic. */
  .zym-conversation-resume { color: ${theme.ui.text.muted}; font-style: italic; }
  .zym-conversation-error { color: var(--t-ui-status-error); }
  /* An unrecognised stream event, dumped as raw JSON so nothing is silently lost.
     A warning accent on the shared ToolRow (which owns padding + the expand fade). */
  .zym-conversation-unknown { border-left: 2px solid var(--t-ui-status-warning); }
  .zym-conversation-unknown-body { opacity: 0.75; }
  /* Agent-registered actions: a row of buttons just above the input card. The
     default action reads as the suggested (accent) button. */
  .zym-conversation-actions {
    padding: 6px 8px 0 8px;
  }
  /* The input + its status strip, as a bordered rounded card with its own bg.
     No top margin — the card sits flush under the transcript (no gap above). */
  .zym-conversation-input-card {
    margin: 0 calc(2 * var(--t-spacing)) calc(2 * var(--t-spacing)) calc(2 * var(--t-spacing));
    border: 1px solid var(--t-ui-border);
    border-radius: var(--card-radius);
    background: var(--t-ui-surface-popover);
  }
  /* Let the card's background show through the editor (no separate editor bg). */
  #AgentConversationPrompt,
  #AgentConversationPrompt scrolledwindow,
  #AgentConversationPrompt textview,
  #AgentConversationPrompt textview text {
    background: transparent;
  }
  .zym-conversation-footer {
    padding: 6px 12px;
    border-top: 1px solid var(--t-ui-border); /* divider between the input and the status strip */
  }
  /* The footer metadata (model name · context tokens) reads as muted secondary text. */
  .zym-conversation-footer-label { color: var(--t-ui-text-muted); }
  /* The detail popover: a compact two-column key/value grid. */
  .zym-context-popover { padding: 6px 4px; }
  .zym-context-popover-heading { font-weight: bold; margin-bottom: 2px; }
  .zym-context-popover-caption { color: var(--t-ui-text-muted); }
  /* The permission-mode dropdown, colored per mode (like Claude Code). */
  .zym-conversation-mode { min-height: 0; }
  .zym-cmode-default { color: var(--t-ui-text-muted); }
  .zym-cmode-acceptEdits { color: var(--t-ui-status-success); }
  .zym-cmode-auto { color: var(--t-ui-status-warning); }
  .zym-cmode-plan { color: var(--t-ui-status-info); }
  .zym-conversation-perm {
    padding: 8px; margin: 6px 0;
    border: 1px solid var(--t-ui-surface-selected);
    border-radius: 6px;
  }
  /* AskUserQuestion: an interactive choice card (info-tinted while open). Split
     into a choice list (left) + a detail pane (right) for the focused choice. */
  .zym-conversation-question {
    padding: calc(2 * var(--t-spacing)); margin: 6px 0;
    border: 1px solid var(--t-ui-status-info);
    border-radius: var(--card-radius);
  }
  /* Once answered the border is dropped — it's just a record of the choice. */
  .zym-conversation-question-answered { padding: 6px 0; margin: 6px 0; }
  .zym-conversation-question-h { font-weight: bold; opacity: 0.6; }
  .zym-conversation-question-split { }
  .zym-conversation-question-list { background: transparent; min-width: 150px; }
  .zym-conversation-question-opt { padding: 2px 4px; }
  .zym-conversation-question-detail {
    padding: 2px 12px; opacity: 0.8;
    border-left: 1px solid var(--t-ui-border);
  }
  #AgentConversationPrompt { padding: 0; }
  /* The monospace bits (tool rows, JSON dumps) follow the font store. */
  .zym-conversation-tool,
  .zym-conversation-result,
  .zym-conversation-unknown-body { font-family: var(--t-font-monospace-family); }
`);

// The enter/alt-enter keymap is global (selector-scoped to our prompt), registered
// once for the whole app — not per conversation instance.
let promptKeymapRegistered = false;
function registerPromptKeymapOnce(): void {
  if (promptKeymapRegistered) return;
  promptKeymapRegistered = true;
  zym.keymaps.add('agent-conversation', {
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
  /** Resume a past conversation (`--resume`/`--continue`) instead of starting fresh.
   *  On a `sessionId` resume the prior transcript is rebuilt into the view. */
  resume?: AgentResume;
  /** An initial prompt to send once the session starts. */
  prompt?: string;
  /** Open a file the agent touched (makes file-tool rows clickable). */
  onOpenFile?: (path: string) => void;
  /** Run a `terminal` action in a terminal tab (terminal-less ones run in-process). */
  onRunInTerminal?: (action: AgentAction) => void;
}

export class AgentConversation implements Agent {
  readonly root: InstanceType<typeof Adw.NavigationView>; // root page = the conversation; subagent transcripts push pages
  private readonly session: SdkSession;
  private readonly cwd: string;
  private readonly messages: InstanceType<typeof Gtk.Box>;
  private readonly scroller: InstanceType<typeof Gtk.ScrolledWindow>;
  // A "copy message" button floated over the transcript viewport (so it stays sticky
  // while scrolling a long message); revealed when the pointer is over a message,
  // copying that message's markdown source.
  private readonly copyButton: InstanceType<typeof Gtk.Button>;
  private copyTargetView: MarkdownView | null = null;
  private readonly bubbleViews = new Map<InstanceType<typeof Gtk.Widget>, MarkdownView>();
  private readonly thinkingReveal: InstanceType<typeof Gtk.Revealer>; // spinner + pending message above the prompt
  private readonly thinkingLabel: InstanceType<typeof Gtk.Label>; // "Thinking…" + live token count
  private readonly thinkingRow: InstanceType<typeof Gtk.Box>; // the spinner row (shown while working)
  private readonly pendingBox: InstanceType<typeof Gtk.Box>; // a queued message shown above the spinner
  private readonly pendingLabel: InstanceType<typeof Gtk.Label>;
  private pendingText = ''; // a message submitted while busy, sent once the agent is idle
  private readonly input: TextEditor;
  private readonly promptContainer: InstanceType<typeof Gtk.Box>;
  private readonly footer: InstanceType<typeof Gtk.Box>;
  // Footer model name + context-window gauge + token/cost popover (owns its state).
  private readonly modelContext = new ModelContext();
  private readonly modeDropdown: InstanceType<typeof Gtk.DropDown>;
  private applyingMode = false; // guards the dropdown's notify::selected feedback loop
  private readonly statusIcon: { widget: InstanceType<typeof Gtk.Widget>; dispose: () => void };
  private readonly subs = new CompositeDisposable();
  private readonly launchPrompt?: string;
  // Base argv this agent was launched with (default ['claude']); kept for serialize.
  private readonly baseCommand?: string[];
  // The session id this agent resumes, if any — kept so serialize() preserves it
  // even before the (deferred) live process has reported its own init session id.
  private readonly resumeSessionId?: string;
  // A resumed agent defers spawning `claude -p --resume` until the user's first
  // turn (its transcript is rebuilt from disk meanwhile); flipped false on connect.
  private deferredStart = false;
  // The permanent "session resumed" divider row (boundary between restored history
  // and the live continuation); its text drops the reconnect nudge once connected.
  private resumeNoteRow: InstanceType<typeof Gtk.Widget> | null = null;
  // While true, keep the transcript pinned to the bottom as its height changes —
  // enabled on resume so a restored conversation lands at the latest message even
  // though its height settles over several layout passes. Released when the user
  // scrolls up. See enableFollowBottom.
  private followBottom = false;
  // True while rebuilding the transcript from a past session (see restoreTranscript):
  // tool rows render statically and changed-file notifications are suppressed.
  private replaying = false;

  // Tool-use rows keyed by tool_use_id, so the matching result can update the
  // row's status icon + append a preview.
  // Each tool row supplies a handler that fills in its result (per-tool layout:
  // Bash output toggle, Task markdown card, or a plain preview). `row`/`name`/`input`
  // let an incoming permission request find its row (permission has no tool_use_id —
  // it correlates by tool name + input; see addPermissionCard).
  private readonly toolRows = new Map<string, {
    row: ToolRow;
    name: string;
    input: unknown;
    onResult: (isError: boolean, text: string) => void;
    onProgress?: (p: TaskProgress) => void;
  }>();
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
  private _slashCommands: string[] = []; // from init; offered by the slash completion source
  private readonly onOpenFile?: (path: string) => void;
  private readonly onRunInTerminal?: (action: AgentAction) => void;
  // Runnable actions the agent has registered (set_actions), rendered as a button
  // bar above the input card; the bar hides when the set is empty.
  private _actions: AgentAction[] = [];
  private readonly actionHandlers: Array<() => void> = [];
  private readonly runningActionHandlers: Array<() => void> = [];
  private readonly actionsBar: InstanceType<typeof Adw.WrapBox>;
  // Background processes of terminal-less actions; re-rendering the bar on change
  // toggles each running action's stop control.
  private readonly actionProcesses = new ActionProcesses(() => {
    this.renderActions();
    for (const handler of this.runningActionHandlers) handler();
  });

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
  // The agent's current working directory: its launch cwd, or a worktree it has
  // since moved into (announced via the set_worktree bridge tool).
  private _effectiveCwd: string;
  private _worktree: WorktreeInfo | null | undefined;
  private _viewed = false;
  private _acknowledged = true;
  private readonly statusHandlers: Array<() => void> = [];
  private readonly fileHandlers: Array<() => void> = [];
  private readonly titleHandlers: Array<() => void> = [];
  private readonly attentionHandlers: Array<() => void> = [];
  private readonly worktreeHandlers: Array<() => void> = [];

  constructor(options: AgentConversationOptions) {
    this.cwd = options.cwd;
    this._effectiveCwd = options.cwd;
    this.launchPrompt = options.prompt;
    this.baseCommand = options.command;
    this.resumeSessionId = options.resume?.sessionId;
    this.onOpenFile = options.onOpenFile;
    this.onRunInTerminal = options.onRunInTerminal;
    this.session = new SdkSession({ cwd: options.cwd, command: options.command, resume: options.resume });

    this.messages = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.messages.addCssClass('zym-conversation-transcript');
    // Cap the transcript to a readable column (GTK CSS has no max-width). Adw.Clamp
    // limits the messages box to `maximumSize`, so every bubble's width is bounded
    // while user/assistant turns still right/left-align within the column. halign
    // START pins the column to the left (Clamp centres by default); the threshold
    // matches the maximum for a hard cap (no gradual tightening).
    const transcriptClamp = new Adw.Clamp();
    transcriptClamp.setMaximumSize(820);
    transcriptClamp.setTighteningThreshold(820);
    transcriptClamp.setHalign(Gtk.Align.START);
    transcriptClamp.setChild(this.messages);
    this.scroller = new Gtk.ScrolledWindow({ vexpand: true });
    this.scroller.setChild(transcriptClamp);

    // The copy button lives in an overlay OVER the scroller, so it's positioned
    // relative to the viewport — it stays pinned top-right while the message scrolls.
    this.copyButton = new Gtk.Button();
    this.copyButton.addCssClass('flat');
    this.copyButton.addCssClass('zym-conversation-copy');
    this.copyButton.setChild(iconLabel(NERDFONT.ACTION.COPY));
    this.copyButton.setTooltipText('Copy message');
    this.copyButton.setHalign(Gtk.Align.END);
    this.copyButton.setValign(Gtk.Align.START);
    this.copyButton.setVisible(false);
    this.copyButton.on('clicked', () => {
      if (!this.copyTargetView) return;
      clipboard.write(this.copyTargetView.getMarkdown());
      this.copyButton.setTooltipText('Copied');
    });
    const transcriptOverlay = new Gtk.Overlay();
    transcriptOverlay.setChild(this.scroller);
    transcriptOverlay.addOverlay(this.copyButton);
    // Track the message under the pointer to target + reveal the button. The
    // controller is on the overlay so moving onto the (overlaid) button isn't a leave.
    const copyMotion = new Gtk.EventControllerMotion();
    copyMotion.on('motion', (x: number, y: number) => this.updateCopyButton(transcriptOverlay, x, y));
    copyMotion.on('leave', () => this.copyButton.setVisible(false));
    transcriptOverlay.addController(copyMotion);

    // Above the prompt, in a slide Revealer: an optional right-aligned "pending"
    // message (a turn the user queued while the agent was busy) over a "Thinking…"
    // spinner row. The reveal is shown while working or while a message is pending.
    this.thinkingRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    this.thinkingRow.addCssClass('zym-conversation-thinking-row');
    const spinner = new Adw.Spinner();
    spinner.setSizeRequest(16, 16); // Adw.Spinner fills its allocation otherwise
    this.thinkingRow.append(spinner);
    this.thinkingLabel = new Gtk.Label({ label: 'Thinking…' });
    this.thinkingLabel.addCssClass('zym-conversation-system');
    this.thinkingRow.append(this.thinkingLabel);

    this.pendingBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, halign: Gtk.Align.END });
    this.pendingBox.addCssClass('zym-conversation-pending');
    this.pendingBox.setVisible(false);
    this.pendingLabel = new Gtk.Label({ xalign: 1, wrap: true });
    const pendingHint = new Gtk.Label({ xalign: 1, label: 'Pending' });
    pendingHint.addCssClass('zym-conversation-system');
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
    // Auto-grows from one line up to 240px; past that the editor scrolls internally.
    this.input = createInput({
      placeholder: 'Write prompt…', 
      grow: true, 
      maxHeight: 240,
      padding: 16,
    });
    this.input.root.setVexpand(false);
    this.input.addCompletionSource(createSlashCommandSource(() => this._slashCommands));
    this.promptContainer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.promptContainer.setName('AgentConversationPrompt');
    this.promptContainer.setVexpand(false);
    this.promptContainer.append(this.input.root);

    // A thin footer: the agent status icon (same as the sidebar) + a permission-mode
    // dropdown (colored per mode) + the model/context gauge (ModelContext).
    this.statusIcon = createAgentStatusIcon(this);
    this.modeDropdown = Gtk.DropDown.newFromStrings(PERMISSION_CYCLE);
    this.modeDropdown.addCssClass('flat');
    this.modeDropdown.addCssClass('zym-conversation-mode');
    this.modeDropdown.on('notify::selected', () => {
      if (this.applyingMode) return;
      const mode = PERMISSION_CYCLE[this.modeDropdown.getSelected()];
      if (mode) this.session.setPermissionMode(mode);
    });
    this.footer = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 14 });
    this.footer.addCssClass('zym-conversation-footer');
    this.footer.append(this.statusIcon.widget);
    this.footer.append(this.modeDropdown);
    this.footer.append(this.modelContext.widget);
    this.updateFooter();

    // The input and its status strip live together in a bordered, rounded card.
    // `overflow: hidden` (the GTK CSS property) doesn't exist — the equivalent is
    // setOverflow(HIDDEN), which clips children to the rounded border so the
    // TextEditor's square background corners don't escape the radius.
    const inputCard = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    inputCard.addCssClass('zym-conversation-input-card');
    inputCard.setOverflow(Gtk.Overflow.HIDDEN);
    inputCard.append(this.promptContainer);
    inputCard.append(this.footer);

    // Subagents push pages onto this.root (the NavigationView, assigned next); the
    // push/pop arrows defer that lookup until a click.
    const nav = { push: (page: InstanceType<typeof Adw.NavigationPage>) => this.root.push(page), pop: () => this.root.pop() };
    this.subagentView = new SubagentView(this.session, nav, this.cwd);
    this.monitorView = new MonitorView(this.session, nav);

    // A button bar for the agent's registered actions, just above the input card;
    // hidden until the agent registers any (see renderActions). A WrapBox so a long
    // row of actions wraps onto further lines instead of overflowing the width.
    this.actionsBar = new Adw.WrapBox({ childSpacing: 6, lineSpacing: 6 });
    this.actionsBar.addCssClass('zym-conversation-actions');
    this.actionsBar.setVisible(false);

    const mainBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
    mainBox.addCssClass('zym-conversation');
    mainBox.append(this.tasksPanel.root);
    mainBox.append(transcriptOverlay); // the scroller, with the floating copy button over it
    mainBox.append(this.thinkingReveal); // the thinking spinner sits just above the prompt
    mainBox.append(this.actionsBar);
    mainBox.append(inputCard);
    mainBox.append(this.subagentView.panel.root); // running subagents expand below the input card
    mainBox.append(this.monitorView.panel.root); // running shell monitors, likewise

    // A NavigationView so a subagent's transcript can push its own page.
    this.root = new Adw.NavigationView();
    this.root.setName('AgentConversation');
    this.root.add(Adw.NavigationPage.new(mainBox, 'Conversation'));

    this.installCommands(); // after this.root exists (commands register on it)
    zym.agents.add(this); // join the registry → sidebar lists it
    this.wireSession();
    // Resuming a specific session: rebuild its visible transcript now (before the
    // workbench subscribes to onDidChangeFiles, so historical edits seed its
    // changed-files set rather than flood-opening). `--resume` restores claude's
    // context but doesn't replay history as events, so we draw it from disk.
    if (options.resume?.sessionId) this.restoreTranscript(options.cwd, options.resume.sessionId);
    // A resume with no launch prompt reconnects lazily: the transcript is rebuilt
    // above, but `claude -p --resume` isn't spawned until the user's first turn (so
    // restoring N agents doesn't fire N claude processes up front). A resume that
    // carries a prompt — e.g. the worktree re-announce — still starts eagerly.
    this.deferredStart = !!options.resume && !options.prompt;
    if (options.resume?.sessionId) {
      // A permanent divider marking the boundary between the restored history and
      // the live continuation: "session disconnected …" until the first turn, then
      // "session resumed" (a dim hollow dot reflects the not-yet-live state too).
      const divider = this.addRow('zym-conversation-resume');
      divider.setXalign(0.5);
      divider.setHalign(Gtk.Align.CENTER);
      this.resumeNoteRow = divider;
      this.refreshResumeNote();
      if (this.deferredStart) this.setStatus('disconnected');
      this.enableFollowBottom(); // land at the latest message once layout settles
    }
  }

  // Pin the transcript to the bottom as its height changes, until the user scrolls
  // up. Restored content is appended before the widget is laid out, and its height
  // settles over several frames (markdown wrapping/measuring), so a one-shot scroll
  // lands short; following `changed` re-pins until the final height is reached.
  private enableFollowBottom(): void {
    if (this.followBottom) return;
    this.followBottom = true;
    const adj = this.scroller.getVadjustment();
    adj.on('changed', () => { if (this.followBottom) adj.setValue(adj.getUpper() - adj.getPageSize()); });
    adj.on('value-changed', () => {
      // A user scroll away from the bottom releases the follow (a programmatic pin
      // lands at the bottom, so it never trips this).
      if (adj.getUpper() - adj.getPageSize() - adj.getValue() > 4) this.followBottom = false;
    });
  }

  // Set the resume divider's text: while disconnected it nudges the user to send a
  // message; once connected it collapses to a plain "session resumed" marker.
  private refreshResumeNote(): void {
    if (!this.resumeNoteRow) return;
    const text = this.deferredStart
      ? '── session disconnected · send a message to resume ──'
      : '── session resumed ──';
    (this.resumeNoteRow as InstanceType<typeof Gtk.Label>).setText(text);
  }

  // Rebuild the conversation rows from a past session's on-disk transcript, by
  // replaying its domain events through the same row handlers a live turn uses.
  private restoreTranscript(cwd: string, sessionId: string): void {
    const entries = readTranscript(cwd, sessionId);
    if (entries.length === 0) return;
    this.replaying = true;
    try {
      this.session.replay(entries);
    } finally {
      this.replaying = false;
      this.endTurn(); // close the last open bubble so the next live turn starts clean
    }
    // Seed the footer's model + context gauge from the transcript's latest usage, so
    // a resumed agent shows its real context occupancy before the first live turn
    // (cost + exact window arrive with the first live `result`).
    const seed = readContextSeed(cwd, sessionId);
    if (seed.model) this.modelContext.setModel(seed.model);
    if (seed.usage) this.modelContext.setUsage(seed.usage);
  }

  // Sync the permission-mode dropdown (selection + color). The status itself is the
  // icon to the left (self-updating); model/context live in ModelContext.
  private updateFooter(): void {
    const index = PERMISSION_CYCLE.indexOf(this._permissionMode);
    if (index >= 0 && this.modeDropdown.getSelected() !== index) {
      this.applyingMode = true; // setSelected fires notify::selected — don't loop back
      this.modeDropdown.setSelected(index);
      this.applyingMode = false;
    }
    for (const m of PERMISSION_CYCLE) this.modeDropdown.removeCssClass(`zym-cmode-${m}`);
    this.modeDropdown.addCssClass(`zym-cmode-${this._permissionMode}`);
  }

  /** Spawn claude and send the launch prompt (if any). A lazily-resumed agent
   *  skips the spawn here — `ensureConnected` runs it on the first turn instead. */
  start(): void {
    if (!this.deferredStart) {
      this.session.start();
      if (this.launchPrompt) this.session.prompt(this.launchPrompt);
    }
    this.input.focusInsert(); // ready to type immediately, not vim normal mode
  }

  // Spawn the (deferred) claude process on demand — the first time a resumed agent
  // is actually given a turn. No-op once connected or for an eagerly-started agent.
  private ensureConnected(): void {
    if (!this.deferredStart) return;
    this.deferredStart = false;
    this.refreshResumeNote(); // keep the divider, drop the "send a message" nudge
    this.setStatus('idle'); // leave disconnected; the turn that follows flips it to working
    this.session.start();
  }

  // --- Agent surface ----------------------------------------------------------

  get title(): string { return this._displayName ?? 'claude (sdk)'; }
  get status(): AgentStatus { return this._status; }
  get permissionMode(): AgentMode { return this._permissionMode; }
  get changedFiles(): string[] { return this._changedFiles.slice(); }
  get actions(): AgentAction[] { return this._actions.slice(); }
  get effectiveCwd(): string { return this._effectiveCwd; }
  get sessionId(): string | null { return this.session.sessionId; }
  get renamed(): boolean { return this._displayName !== null; }
  get exited(): boolean { return this._status === 'exited'; }
  get unannouncedWorktree(): string | null { return null; }

  get worktree(): WorktreeInfo | null {
    if (this._worktree === undefined) this._worktree = worktreeInfo(this._effectiveCwd);
    return this._worktree;
  }

  // The agent moved into `cwd` (set_worktree): recompute the worktree and notify so
  // AppWindow re-roots this agent's workbench.
  private setEffectiveCwd(cwd: string): void {
    if (cwd === this._effectiveCwd) return;
    this._effectiveCwd = cwd;
    this._worktree = worktreeInfo(cwd);
    for (const handler of this.worktreeHandlers) handler();
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

  /** No in-place resume: this host's session is wired into views built at
   *  construction, so it can't hot-swap a fresh process. AppWindow resumes a
   *  headless agent by restarting it (a fresh widget that rebuilds the transcript
   *  from disk and resumes via `--resume`); see AppWindow.resumeCurrentAgent. */
  resume(): void { /* intentionally a no-op — resume is a restart for this kind */ }

  focus(): void { this.input.focus(); }

  /** Push editor context into the input (Agent surface). */
  deliver(text: string, options?: { submit?: boolean; focus?: boolean }): void {
    this.input.insertText(text);
    if (options?.focus !== false) this.input.focus(); // background delivery leaves the cursor put
    if (options?.submit) this.submit(); // send it as a turn now (queues if the agent is busy)
  }

  clearUnannouncedWorktree(): void { /* no worktree validator for sdk */ }

  /** Session state: base argv + cwd + prompt + session id, tagged `claude-sdk` so a
   *  restore relaunches this native host (not the terminal agent) and resumes the
   *  conversation rather than starting over. */
  serialize(): TabState | null {
    return {
      kind: 'agent',
      agentKind: 'claude-sdk',
      command: this.baseCommand ?? ['claude'],
      cwd: this.cwd,
      prompt: this.launchPrompt,
      // Fall back to the resume id: a lazily-resumed agent that the user hasn't
      // sent a turn to yet has no live (init-reported) session id, but must still
      // serialize the id it resumes so a later restart can resume it again.
      sessionId: this.sessionId ?? this.resumeSessionId ?? undefined,
    };
  }
  isModified(): boolean { return !this.exited; }
  getModifiedLabel(): string { return `${this.title}${this._status === 'disconnected' ? ' (resumed)' : ' (running)'}`; }

  onDidChangeStatus(cb: () => void): () => void { return push(this.statusHandlers, cb); }
  onDidChangeFiles(cb: () => void): () => void { return push(this.fileHandlers, cb); }
  onDidChangeActions(cb: () => void): () => void { return push(this.actionHandlers, cb); }
  onDidChangeRunningActions(cb: () => void): () => void { return push(this.runningActionHandlers, cb); }

  /** Run an action: `terminal` ones open a terminal tab (`onRunInTerminal`), the
   *  rest run as a background process (re-running terminates the previous one). */
  runAction(action: AgentAction): void {
    if (action.terminal) this.onRunInTerminal?.(action);
    else this.actionProcesses.run(action, this._effectiveCwd);
  }

  /** Stop a terminal-less action's process (no-op otherwise). */
  stopAction(actionId: string): void { this.actionProcesses.stop(actionId); }

  /** Whether a terminal-less action currently has a running process. */
  isActionRunning(actionId: string): boolean { return this.actionProcesses.isRunning(actionId); }
  onTitleChange(cb: () => void): () => void { return push(this.titleHandlers, cb); }
  onDidChangeAttention(cb: () => void): () => void { return push(this.attentionHandlers, cb); }
  onDidChangePermissionMode(cb: () => void): () => void { return push(this.permissionModeHandlers, cb); }
  onDidChangeWorktree(cb: () => void): () => void { return push(this.worktreeHandlers, cb); }

  dispose(): void {
    this.actionProcesses.stopAll(); // terminate any terminal-less action processes
    this.subs.dispose();
    this.statusIcon.dispose();
    this.input.dispose();
    this.session.dispose();
    zym.agents.remove(this);
  }

  // --- input ------------------------------------------------------------------

  // The conversation commands, bound via the keymap (registerPromptKeymapOnce).
  // Registered on `this.root` so they resolve from anywhere in the conversation.
  private installCommands(): void {
    registerPromptKeymapOnce();
    this.subs.add(
      zym.commands.add(this.root, {
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

  // Replace the registered-actions set and re-render the button bar.
  private setActions(actions: AgentAction[]): void {
    this._actions = actions;
    this.renderActions();
    for (const handler of this.actionHandlers) handler();
  }

  // Rebuild the action button bar from `_actions`. The first action is the default
  // and reads as the accent "suggested" button; a terminal-less action that is
  // currently running gets a linked stop control. The bar hides when empty.
  private renderActions(): void {
    this.actionsBar.removeAll();
    this._actions.forEach((action, index) => {
      const run = new Gtk.Button({ label: action.label });
      if (index === 0) run.addCssClass('suggested-action'); // the default action
      // Re-running terminates the previous process first (handled in runAction).
      run.on('clicked', () => this.runAction(action));

      if (action.terminal) {
        run.setTooltipText(action.command);
        this.actionsBar.append(run);
        return;
      }

      // Terminal-less: the run button + a stop control, joined (`linked`). The stop
      // button shows only while the background process is running.
      const running = this.actionProcesses.isRunning(action.id);
      run.setTooltipText(`${action.command}\n(background process${running ? ', running — click to restart' : ''})`);
      const group = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
      group.addCssClass('linked');
      group.append(run);
      if (running) {
        const stop = new Gtk.Button({ valign: Gtk.Align.CENTER });
        const stopLabel = new Gtk.Label();
        setMarkupSafe(stopLabel, iconSpan(NERDFONT.STATUS.CROSS, theme.ui.text.muted), '✗');
        stop.setChild(stopLabel);
        stop.setTooltipText(`Stop ${action.label}`);
        stop.on('clicked', () => this.stopAction(action.id));
        group.append(stop);
      }
      this.actionsBar.append(group);
    });
    this.actionsBar.setVisible(this._actions.length > 0);
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
    this.ensureConnected(); // a lazily-resumed agent spawns claude on its first turn
    if (this._status === 'idle') { this.session.prompt(text); return; }
    // The agent is busy — queue (accumulate) the message; it's sent on next idle.
    this.pendingText = this.pendingText ? `${this.pendingText}\n\n${text}` : text;
    this.refreshThinking();
  }

  // --- session → state + rows -------------------------------------------------

  private wireSession(): void {
    this.subs.add(
      this.session.onStatus(() => this.setStatus(this.session.status)),
      this.session.onActions(({ actions }) => this.setActions(actions)),
      this.session.onCwd(({ cwd }) => this.setEffectiveCwd(cwd)),
      this.session.onMode(() => {
        this._permissionMode = this.session.permissionMode;
        this.updateFooter();
        for (const handler of this.permissionModeHandlers) handler();
      }),
      this.session.onUserMessage(({ text }) => {
        this.endTurn();
        this.thinkingLabel.setText('Thinking…'); // reset the live token count for the new turn
        this.addMarkdownBlock('zym-conversation-user', Gtk.Align.END).setMarkdown(text);
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
        this.assistantView = this.addMarkdownBlock('zym-conversation-assistant', Gtk.Align.START);
      }),
      this.session.onAssistantText(({ delta }) => {
        if (!this.assistantView) {
          this.assistantRaw = '';
          this.assistantView = this.addMarkdownBlock('zym-conversation-assistant', Gtk.Align.START);
        }
        this.assistantRaw += delta;
        this.assistantView.setMarkdown(this.assistantRaw);
        this.scrollToBottom();
      }),
      this.session.onAssistantThinking(({ delta }) => {
        if (!this.thinkingView) {
          this.thinkingRaw = '';
          this.thinkingView = this.addMarkdownBlock('zym-conversation-thinking', Gtk.Align.START);
        }
        this.thinkingRaw += delta;
        this.thinkingView.setMarkdown(this.thinkingRaw);
        this.scrollToBottom();
      }),
      this.session.onToolUse(({ id, name, input }) => {
        if (this.handleTaskTool(id, name, input)) return; // TaskCreate/TaskUpdate → tasks panel, no row
        // While rebuilding a past transcript, an Agent whose subagent transcript we
        // reconstructed (seeded into the session before this event) spawns the real
        // subagent button + page; every other tool draws as a static row, since the
        // interactive Monitor/Question widgets drive off a lifecycle replay lacks.
        if (this.replaying) {
          if (name === 'Agent' && this.session.getSubagent(id)) {
            this.endTurn();
            this.messages.append(this.subagentView.spawn(id, input));
            this.scrollToBottom();
            return;
          }
          this.recordChangedFile(name, input); this.endTurn(); this.addToolRow(id, name, input); return;
        }
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
      this.session.onInit(({ model, slashCommands }) => { this.modelContext.setModel(model); this._slashCommands = slashCommands; }),
      this.session.onContext((usage) => this.modelContext.setUsage(usage)),
      this.session.onResult(({ costUsd, contextWindow }) => {
        if (costUsd != null) this.modelContext.setCost(costUsd);
        if (contextWindow) this.modelContext.setWindow(contextWindow);
      }),
      this.session.onError(({ message }) => this.addErrorRow(message)),
      this.session.onInterrupted(() => this.addInterruptedRow()),
      this.session.onUnhandled(({ event }) => this.addUnknownRow(event)),
      this.session.onPermission((req) => this.addPermissionCard(req)),
      this.session.onQuestion((req) => this.addQuestionCard(req)),
      this.session.onExit(() => {
        this.endTurn();
        this.addRow('zym-conversation-system').setText('── process exited ──');
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
    // Replaying a past transcript seeds the changed-files list silently — its edits
    // already happened, so don't notify (which would re-open / re-diff them all).
    if (this.replaying) return;
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
    // Register the bubble as a copy target (skip thinking — it's an ephemeral note).
    if (cssClass !== 'zym-conversation-thinking') this.bubbleViews.set(bubble, view);
    this.scrollToBottom();
    return view;
  }

  // Point the floating copy button at the message under the pointer, revealing it
  // over that message (or hide it when the pointer isn't over a copyable message).
  private updateCopyButton(overlay: InstanceType<typeof Gtk.Overlay>, x: number, y: number): void {
    let w: InstanceType<typeof Gtk.Widget> | null = overlay.pick(x, y, Gtk.PickFlags.DEFAULT);
    while (w) {
      if (w === this.copyButton) return; // over the button itself — leave it shown
      const view = this.bubbleViews.get(w);
      if (view) {
        this.copyTargetView = view;
        this.copyButton.setTooltipText('Copy message');
        this.copyButton.setVisible(true);
        return;
      }
      w = w.getParent();
    }
    this.copyButton.setVisible(false);
  }

  // A single wrapped, left-aligned row (thinking / tool / system).
  private addRow(cssClass: string): InstanceType<typeof Gtk.Label> {
    const label = new Gtk.Label({ xalign: 0, wrap: true, selectable: true });
    label.addCssClass('zym-conversation-row');
    label.addCssClass(cssClass);
    this.messages.append(label);
    this.scrollToBottom();
    return label;
  }

  // An error notice in the conversation flow (refusal / max-turns / API error).
  private addErrorRow(message: string): void {
    const label = this.addRow('zym-conversation-error');
    setMarkupSafe(label, `${iconSpan(NERDFONT.STATUS.CROSS, theme.ui.status.error)}  ${escapeMarkup(message)}`, message);
  }

  // A muted notice that the user interrupted the turn (ctrl-c).
  private addInterruptedRow(): void {
    const label = this.addRow('zym-conversation-system');
    setMarkupSafe(label, `${iconSpan(NERDFONT.STATUS.STOP)}  Interrupted`, 'Interrupted');
  }

  // An unrecognised stream event (shared ToolRow): a warning header that toggles the
  // raw JSON (monospace, selectable) so an unmodeled payload is visible rather than
  // silently dropped.
  private addUnknownRow(event: unknown): void {
    const type = event && typeof event === 'object' && typeof (event as { type?: unknown }).type === 'string'
      ? (event as { type: string }).type : 'unknown';
    let json: string;
    try { json = JSON.stringify(event, null, 2); } catch { json = String(event); }

    const header = new Gtk.Label({ xalign: 0, wrap: true, hexpand: true });
    setMarkupSafe(header, `unhandled <tt>${escapeMarkup(type)}</tt> event`, `unhandled ${type} event`);

    const toolRow = new ToolRow({ icon: NERDFONT.STATUS.WARNING, iconColor: theme.ui.status.warning, header });
    toolRow.root.addCssClass('zym-conversation-unknown');
    const body = new Gtk.Label({ xalign: 0, wrap: true, selectable: true });
    body.addCssClass('zym-conversation-unknown-body');
    body.setText(json);
    toolRow.content.append(body);

    this.messages.append(toolRow.root);
    this.scrollToBottom();
  }

  // A tool-use row (shared ToolRow): a status slot (red ✗ only on failure) + the
  // formatted tool over a collapsible detail section (result + TodoWrite checklist).
  // File tools open their file on click instead of toggling; Bash gets a bespoke row.
  private addToolRow(id: string, name: string, input: unknown): void {
    if (name === 'Bash') { this.addBashRow(id, input); return; }

    const filePath = toolFilePath(name, input);
    const opensFile = !!(filePath && this.onOpenFile);

    // The icon goes in the row's leading slot; the header is just title + detail.
    // File tools open their file on click (no toggle); the rest toggle their detail.
    const { icon } = describeTool(name, input, this.cwd);
    const header = new Gtk.Label({ xalign: 0, wrap: true, hexpand: true });
    header.addCssClass('zym-conversation-toolrow');
    setMarkupSafe(header, toolBodyMarkup(name, input, { cwd: this.cwd, monoFamily: fonts.monospaceFamily }), `${name} ${summarizeInput(input)}`);

    const toolRow = new ToolRow({
      icon,
      header,
      onActivate: opensFile ? () => this.onOpenFile!(filePath!) : undefined,
    });

    // TodoWrite carries its checklist in the input — render it now, not on result.
    const todos = (input as { todos?: unknown })?.todos;
    if (name === 'TodoWrite' && Array.isArray(todos)) toolRow.content.append(renderTodos(todos));

    this.messages.append(toolRow.root);
    if (id) {
      // Background-task rows (run_in_background) get a live progress line.
      let progress: InstanceType<typeof Gtk.Label> | null = null;
      this.toolRows.set(id, {
        row: toolRow,
        name,
        input,
        onResult: (isError, text) => this.fillToolResult(toolRow, name, isError, text),
        onProgress: (p) => {
          if (!progress) {
            progress = new Gtk.Label({ xalign: 0, wrap: true });
            progress.addCssClass('zym-conversation-system');
            toolRow.content.append(progress);
          }
          progress.setText(progressLine(p));
          toolRow.setExpanded(true); // surface live progress as it streams in
          this.scrollToBottom();
        },
      });
    }
    this.scrollToBottom();
  }


  // Bash (shared ToolRow): no icon — the command (monospace) is the header that
  // toggles the detail (its output). Collapsed shows the first line; expanded shows
  // the full command + output. A failure expands the row and adds a ✗ to the status.
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

    const label = new Gtk.Label({ xalign: 0, hexpand: true });
    label.addCssClass('zym-conversation-toolrow');
    // Collapsed: the command is cropped to its first line; the full (multiline)
    // command shows only once expanded.
    const render = (expanded: boolean) => {
      const full = expanded || !multiline;
      const text = full ? cmd : firstLine;
      label.setWrap(full);
      label.setEllipsize(full ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END);
      setMarkupSafe(label, highlight(text), text);
    };
    render(false);

    const toolRow = new ToolRow({ icon: describeTool('Bash', input).icon, header: label, onToggle: render });
    this.messages.append(toolRow.root);

    let progress: InstanceType<typeof Gtk.Label> | null = null;
    if (id) this.toolRows.set(id, {
      row: toolRow,
      name: 'Bash',
      input,
      onResult: (isError, text) => {
        const trimmed = text.trim();
        if (trimmed) {
          const out = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, label: truncateLines(trimmed, 40, 4000) });
          out.addCssClass('zym-conversation-result');
          toolRow.content.append(out);
        }
        if (isError) {
          toolRow.setIcon(NERDFONT.STATUS.CROSS, theme.ui.status.error); // ✗ replaces the terminal icon
          toolRow.setExpanded(true);
        }
      },
      // Background-bash progress (run_in_background); shown in the detail body.
      onProgress: (p) => {
        if (!progress) {
          progress = new Gtk.Label({ xalign: 0, wrap: true });
          progress.addCssClass('zym-conversation-system');
          toolRow.content.append(progress);
        }
        progress.setText(progressLine(p));
        toolRow.setExpanded(true);
        this.scrollToBottom();
      },
    });
    this.scrollToBottom();
  }

  // Fill a non-Bash tool row's result: a red ✗ on failure (which also expands the
  // row), then a markdown card for Task (the subagent's report) or a truncated text
  // preview otherwise, into the row's collapsible detail section.
  private fillToolResult(toolRow: ToolRow, name: string, isError: boolean, text: string): void {
    if (isError) {
      toolRow.setIcon(NERDFONT.STATUS.CROSS, theme.ui.status.error); // ✗ replaces the tool icon
      toolRow.setExpanded(true); // surface the failure without a click
    }
    // File tools (Read/Write/Edit/…): the file is opened on the side via the
    // clickable row, and the result is just a boilerplate "created/updated" notice —
    // don't dump it into the conversation (only a failure still shows its error text).
    if ((name === 'Read' || EDIT_TOOLS.has(name)) && !isError) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (name === 'Task' || name === 'Agent') {
      const view = new MarkdownView();
      view.root.addCssClass('zym-conversation-task-result');
      toolRow.content.append(view.root);
      view.setMarkdown(trimmed);
    } else {
      const label = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, label: truncateLines(trimmed, 8, 800) });
      label.addCssClass('zym-conversation-result');
      toolRow.content.append(label);
    }
  }

  private updateToolResult(id: string, isError: boolean, text: string): void {
    const row = this.toolRows.get(id);
    if (!row) return;
    row.onResult(isError, text);
    this.scrollToBottom();
  }

  private addPermissionCard(req: PermissionRequest): void {
    // Prefer to surface the prompt in-place: expand the tool row the request is for
    // and put the Allow/Deny buttons in its details. The request has no tool_use_id,
    // so correlate by tool name + input (the most recent match wins).
    const entry = this.findPermissionRow(req);
    if (entry) {
      const buttons = permissionButtons((allow) => {
        this.session.respondPermission(req.id, { allow });
        entry.row.content.remove(buttons); // answered — drop the buttons
      });
      entry.row.content.append(buttons);
      entry.row.setExpanded(true);
      this.scrollToBottom();
      return;
    }
    // Fallback (no matching row — e.g. the request raced ahead of its tool-use row):
    // a standalone card in the transcript flow.
    const card = permissionCard(req, (allow) => {
      this.session.respondPermission(req.id, { allow });
      this.messages.remove(card); // answered — drop it from the transcript
    });
    this.messages.append(card);
    this.scrollToBottom();
  }

  // The tool row a permission request belongs to: the most recently added row whose
  // tool name + input match (permission requests carry no tool_use_id). Returns
  // undefined when none match (the request predates its row, or has no row).
  private findPermissionRow(req: PermissionRequest): { row: ToolRow } | undefined {
    const target = stableJson(req.input);
    let match: { row: ToolRow } | undefined;
    for (const entry of this.toolRows.values()) {
      if (entry.name === req.toolName && stableJson(entry.input) === target) match = entry;
    }
    return match;
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
/** A key-stable JSON serialization (object keys sorted at every level) so two inputs
 *  with the same content but different key order compare equal — used to match a
 *  permission request to its tool row (the two inputs come from different channels). */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

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
