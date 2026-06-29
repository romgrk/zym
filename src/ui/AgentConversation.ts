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
 * container (keymap scoped to `.AgentConversation .conversation-prompt .TextEditor`).
 *
 * It implements the tool-agnostic `Agent` surface (../agents/types.ts), so it is a
 * first-class workbench owner registered in `zym.agents` — the chrome reads
 * `status` / `changedFiles` / etc., never the concrete class.
 */
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { zym } from '../zym.ts';
import { worktreeInfo, type WorktreeInfo } from '../git.ts';
import { TextEditor, createInput } from './TextEditor/TextEditor.ts';
import { createSlashCommandSource } from './TextEditor/createSlashCommandSource.ts';
import { MarkdownView } from './markdown/MarkdownView.ts';
import { escapeMarkup, setMarkupSafe, wrappingLabel, clearChildren } from './proseMarkup.ts';
import { iconSpan } from './icons.ts';
import { formatCount, formatElapsed, parseLocalCommand } from './conversation/format.ts';
import { StickyListPanel } from './conversation/StickyListPanel.ts';
import { Transcript } from './conversation/Transcript.ts';
import { Message, type MessageKind } from './conversation/Message.ts';
import { permissionPrompt, permissionDiffView, type PermissionChoice } from './conversation/cards.ts';
import { QuestionCard } from './conversation/QuestionCard.ts';
import { ToolRow } from './conversation/ToolRow.ts';
import { appendToolRow, permissionPromptParts, editDiffLines, EDIT_TOOLS } from './conversation/toolRows.ts';
import { SubagentView, SUBAGENT_GROUP } from './conversation/SubagentView.ts';
import { MonitorView } from './conversation/MonitorView.ts';
import { ModelContext } from './conversation/ModelContext.ts';
import { createAgentStatusIcon } from './agentStatusIcon.ts';
import { NERDFONT } from './nerdfont.ts';
import { SdkSession, type PermissionRequest, type QuestionRequest, type TaskProgress } from '../agents/claude-sdk/SdkSession.ts';
import type { Transport, TransportOptions } from '../agents/claude-sdk/transport.ts';
import { readTranscript, readContextSeed } from '../agents/claude-sdk/transcript.ts';
import { writeCustomTitle, readSessionName } from '../agentSessions.ts';
import { createOneShotAgent, type OneShotAgent } from '../agents/oneshot.ts';
import { generateAgentName } from '../agents/autoName.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import type { Agent, AgentMode, AgentResume, AgentStatus } from '../agents/types.ts';
import type { WorkbenchActions } from './workbench/WorkbenchActions.ts';
import type { TabState } from '../SessionManager.ts';

// Colors come from the theme as CSS variables (--t-ui-*); the monospace bits read
// the font store's --t-font-monospace-family. See docs/styling.md + theming.md.
addStyles(/* css */`
  /* The user's own message-bubble surface, shared within the conversation by the live
     transcript bubble (Message.is-user) and the queued "pending" bubble below — scoped
     here, on their common ancestor, rather than as a global token. */
  .AgentConversation { --user-bubble-bg: color-mix(in srgb, var(--card-bg-color), var(--accent-color) 50%); }

  /* The conversation reads as the "secondary sidebar" it's docked into (left dock +
     its header section share these libadwaita --secondary-sidebar-* colors). */
  .AgentConversation .conversation-surface {
    color: var(--secondary-sidebar-fg-color);
    background: var(--secondary-sidebar-bg-color);
  }

  /* A message queued while the agent is busy — a right-aligned bubble above the prompt;
     it's the user's own queued turn, so it shares the user message-bubble surface. */
  .AgentConversation .conversation-pending {
    background: var(--user-bubble-bg);
    border-radius: 10px;
    padding: 6px 10px;
    margin: 0 12px;
  }
  /* The queued message's Edit / Cancel controls: compact flat buttons under the text. */
  .AgentConversation .conversation-pending-controls { margin-top: 4px; }
  .AgentConversation .conversation-pending-action { padding: 0 6px; min-height: 0; }

  /* The input + its status strip, as a borderless rounded card with its own bg.
     No top margin — the card sits flush under the transcript (no gap above). */
  .AgentConversation .conversation-input-card {
    margin: 0 calc(2 * var(--t-spacing)) calc(2 * var(--t-spacing)) calc(2 * var(--t-spacing));
    border-radius: var(--card-radius);
    /* A subtle foreground tint, no border at rest; a permission / question colours
       the (otherwise transparent) border — warning / info — via .is-permission /
       .is-question below. */
    background: alpha(currentColor, 0.05);
    border: 2px solid transparent;
    /* Native (libadwaita) focus ring: invisible at rest, fading + scaling in when the
       prompt takes focus (.prompt-focused). Follows the card's border-radius. */
    outline: 0 solid transparent;
    outline-offset: 3px;
    transition: outline-color 200ms ease-in-out, outline-width 200ms ease-in-out, outline-offset 200ms ease-in-out, border-color 200ms ease-in-out;
  }
  /* Ring the whole card while the prompt editor (not the footer dropdown) holds focus. */
  .AgentConversation .conversation-input-card.prompt-focused {
    outline: 2px solid alpha(var(--accent-color), 0.6);
    outline-offset: -1px;
  }
  /* While a permission / question replaces the input, ring the card in the matching
     status colour: warning to approve a tool, info to answer a question. */
  .AgentConversation .conversation-input-card.is-permission { border-color: var(--t-ui-status-warning); }
  .AgentConversation .conversation-input-card.is-question { border-color: var(--t-ui-status-info); }

  /* Let the card's background show through the editor (no separate editor bg). */
  .AgentConversation .conversation-prompt,
  .AgentConversation .conversation-prompt scrolledwindow,
  .AgentConversation .conversation-prompt textview,
  .AgentConversation .conversation-prompt textview text {
    background: transparent;
  }
  .AgentConversation .conversation-prompt { padding: 0; }

  .AgentConversation .conversation-footer {
    padding: 6px 12px;
  }

  /* The footer metadata (model name · context tokens) reads as muted secondary text. */
  .AgentConversation .conversation-footer-label { color: var(--t-ui-text-muted); }

  /* The permission-mode dropdown, colored per mode (like Claude Code). */
  .AgentConversation .conversation-mode { min-height: 0; }
  .AgentConversation .conversation-mode.is-default { color: var(--t-ui-text-muted); }
  .AgentConversation .conversation-mode.is-acceptEdits { color: var(--t-ui-status-success); }
  .AgentConversation .conversation-mode.is-auto { color: var(--t-ui-status-warning); }
  .AgentConversation .conversation-mode.is-plan { color: var(--t-ui-status-info); }

  /* A single wrapped, left-aligned row (interrupted / error / system / resume). */
  .AgentConversation .conversation-row { padding: 6px 0; }
  /* Tool-use header text (tool rows / subagent / monitor / answered question). */
  .AgentConversation .conversation-tool-header { opacity: 0.85; }
  /* Trailing dot marking a non-zero Bash exit (the icon + command colour stay put). */
  .AgentConversation .bash-error-dot { padding-left: 8px; }
  .AgentConversation .conversation-system { opacity: 0.6; font-style: italic; }
  /* The resume boundary divider: centered, muted, italic. */
  .AgentConversation .conversation-resume { opacity: var(--dim-opacity); font-style: italic; }
  .AgentConversation .conversation-error { color: var(--t-ui-status-error); }
  /* An unrecognised stream event, dumped as raw JSON so nothing is silently lost.
     The warning is carried by the ToolRow warning status (icon + header tint). */
  .AgentConversation .conversation-unknown-body { opacity: 0.75; }

  /* The Bash command, relocated into the expanded detail when its description owns the
     header (toolRows.ts). Plain monospace, a touch of bottom margin off the output card. */
  .AgentConversation .conversation-bash-command { margin-bottom: 4px; }
  /* Truncated tool-output preview tucked under a row. */
  .AgentConversation .conversation-result {
    opacity: 0.7;
    background: var(--card-bg-color);
    padding: 4px 8px;
    margin-top: 2px;
    border-radius: 4px;
  }
  /* A Task (subagent) report renders as a fuller markdown card. */
  .AgentConversation .conversation-task-result {
    background: var(--card-bg-color);
    padding: 6px 10px;
    margin-top: 4px;
    border-radius: 4px;
  }

  /* The pushed subagent/monitor page's header (back button + title). */
  .AgentConversation .conversation-page-header { padding: 6px; border-bottom: 1px solid var(--border-colo); }

  /* The permission prompt that REPLACES the input while the agent waits for approval
     (cards.ts, shown in the input card's interaction slot): a title, an optional
     command line, then a row of equal, unemphasised actions. */
  .AgentConversation .conversation-perm-prompt { padding: 16px; }
  /* The command (Bash) and the diff (edit tools) read as a code block: a faint
     window-bg tint, rounded like a button, 1×spacing of padding. The diff caps its
     height in cards.ts and scrolls past it. */
  .AgentConversation .conversation-perm-command,
  .AgentConversation .conversation-perm-diff {
    background: alpha(var(--window-bg-color), 0.1);
    border-radius: var(--popover-radius-small);
  }
  .AgentConversation .conversation-perm-command,
  .AgentConversation .conversation-perm-diff-body { padding: var(--t-spacing); }
  .AgentConversation .conversation-perm-command { opacity: 0.8; }
  .AgentConversation .conversation-perm-actions { margin-top: 6px; }

  /* The monospace bits (tool detail, results, JSON dumps) follow the font store. */
  .AgentConversation .conversation-perm-command,
  .AgentConversation .conversation-perm-diff-body,
  .AgentConversation .conversation-bash-command,
  .AgentConversation .conversation-result,
  .AgentConversation .conversation-unknown-body { font-family: var(--t-font-monospace-family); }
`);

// The enter/alt-enter keymap is global (selector-scoped to our prompt), registered
// once for the whole app — not per conversation instance.
let promptKeymapRegistered = false;
function registerPromptKeymapOnce(): void {
  if (promptKeymapRegistered) return;
  promptKeymapRegistered = true;
  zym.keymaps.add('agent-conversation', {
    '.AgentConversation .conversation-prompt .TextEditor': {
      enter: 'conversation:submit-prompt',
      'alt-enter': 'conversation:prompt-newline',
    },
    // shift-tab cycles the permission mode; ctrl-c interrupts the running turn —
    // both anywhere in the conversation. ctrl-c falls through to its default (copy)
    // when nothing is running (the command aborts the binding).
    '.AgentConversation': {
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
  /** An initial prompt to send once the session starts — what the agent is told
   *  (may include zym's editor instructions, e.g. worktree setup). */
  prompt?: string;
  /** The user's own prompt, free of zym's editor instructions — context for
   *  auto-naming, so a generated title reflects the task and not our scaffolding. */
  userPrompt?: string;
  /** Open a file the agent touched (makes file-tool rows clickable). */
  onOpenFile?: (path: string) => void;
  /** Override how the underlying session's transport is created — a test/POC seam
   *  to drive the conversation off scripted stream events instead of spawning
   *  `claude` (forwarded verbatim to SdkSession; see src/poc/conversation-transcript.ts). */
  createTransport?: (spec: TransportOptions) => Transport;
  /** Override the one-shot agent used for auto-naming (test seam; default
   *  `createOneShotAgent()` → `claude -p --model sonnet`). */
  oneShot?: OneShotAgent;
}

// The kind's default title, shown when nothing has named the session.
const DEFAULT_TITLE = 'claude (sdk)';

export class AgentConversation implements Agent {
  readonly root: InstanceType<typeof Adw.NavigationView>; // root page = the conversation; subagent transcripts push pages
  private readonly session: SdkSession;
  private readonly cwd: string;
  // The scrollable column of entries (entries box + spacing + stick-to-bottom).
  private readonly transcript = new Transcript({ maxWidth: 820 });
  private readonly thinkingReveal: InstanceType<typeof Gtk.Revealer>; // pending (queued) message above the prompt
  private readonly thinkingLabel: InstanceType<typeof Gtk.Label>; // "Thinking…" + live token count (footer)
  private readonly thinkingFooter: InstanceType<typeof Gtk.Box>; // footer slot: spinner + label, replaces the status icon while working
  // The live "Thinking…" footer state: latest reasoning-token count + the turn's start
  // time, recomposed each second into "Thinking… (1.2k tokens · 12s)" so a long turn
  // reads as still-going rather than stuck. The ticking interval lives in its own bag
  // (re-armed per turn, cleared when the turn ends); `thinkingTimerActive` guards it.
  private thinkingTokens = 0;
  private thinkingStartMs = 0;
  private thinkingTimerActive = false;
  private readonly thinkingTimerSubs = new CompositeDisposable();
  private readonly pendingBox: InstanceType<typeof Gtk.Box>; // a queued message shown above the prompt
  private readonly pendingLabel: InstanceType<typeof Gtk.Label>;
  private pendingText = ''; // a message submitted while busy, sent once the agent is idle
  private readonly input: TextEditor;
  private readonly promptContainer: InstanceType<typeof Gtk.Box>;
  // The input area is a Gtk.Stack: the prompt editor, or an "interaction" widget (a
  // permission prompt / question card) that REPLACES it while the agent waits for the
  // user, restored to the prompt once answered. See docs/agents/claude-sdk.md.
  private readonly promptStack = new Gtk.Stack();
  private readonly interactionSlot = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  // The rounded input card; gets a status-coloured border (warning / info) while a
  // permission / question replaces the prompt — see showInteraction.
  private readonly inputCard: InstanceType<typeof Gtk.Box>;
  private readonly footer: InstanceType<typeof Gtk.Box>;
  // Footer model name + context-window gauge + token/cost popover (owns its state).
  private readonly modelContext = new ModelContext();
  private readonly modeDropdown: InstanceType<typeof Gtk.DropDown>;
  private applyingMode = false; // guards the dropdown's notify::selected feedback loop
  private readonly statusIcon: { widget: InstanceType<typeof Gtk.Widget>; dispose: () => void };
  private readonly subs = new CompositeDisposable();
  // Holds the active permission prompt's button handlers (a question card owns its own
  // teardown); cleared when the prompt is restored so they don't pile up per request.
  private readonly interactionSubs = this.subs.nest();
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
    row?: ToolRow; // absent for the collapsed Read row (not a ToolRow); see addReadRow
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
  // Actions live on the workbench, not here. The agent's reported `set_actions` is
  // piped straight into `boundActions` (its workbench's set); the buttons are shown in
  // the window header bar (`WorkbenchActionsBar`), not the conversation. Null until
  // `bindActions`.
  private boundActions: WorkbenchActions | null = null;

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
  // A user-pinned override (`agent:rename`); wins over everything when set.
  private _displayName: string | null = null;
  // Claude's session name — set by the local `/rename` command (and seeded from the
  // transcript on resume). Mirrors AgentTerminal._sessionName.
  private _sessionName: string | null = null;
  // A transient, in-app-only title (never persisted): the "…" placeholder shown
  // while auto-naming runs. Wins over the persisted names while set; cleared on
  // completion (success → the new name; failure → reverts to the previous name).
  private _transientName: string | null = null;
  // The one-shot agent backing auto-rename + its in-flight guard.
  private readonly oneShot: OneShotAgent;
  // The user's own launch prompt (no editor instructions) and the first genuine
  // user turn — naming context, preferring the clean launch prompt.
  private readonly userPrompt?: string;
  private firstUserText: string | null = null;
  private autoNaming = false;
  private disposed = false;
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
    this.userPrompt = options.userPrompt;
    this.baseCommand = options.command;
    this.resumeSessionId = options.resume?.sessionId;
    this.onOpenFile = options.onOpenFile;
    this.session = new SdkSession({ cwd: options.cwd, command: options.command, resume: options.resume, createTransport: options.createTransport });
    this.oneShot = options.oneShot ?? createOneShotAgent();

    // The footer's left slot: a live "Thinking… (N tokens)" indicator (spinner +
    // label) that REPLACES the status icon while the agent works (see refreshThinking
    // + the footer below). Built here so the label exists before onThinkingTokens fires.
    this.thinkingFooter = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    this.thinkingFooter.setVisible(false);
    const spinner = new Adw.Spinner();
    spinner.setSizeRequest(14, 14); // Adw.Spinner fills its allocation otherwise
    this.thinkingFooter.append(spinner);
    this.thinkingLabel = new Gtk.Label({ label: 'Thinking…' });
    this.thinkingLabel.addCssClass('conversation-system');
    this.thinkingFooter.append(this.thinkingLabel);

    this.subs.add(this.thinkingTimerSubs); // the per-turn "Thinking…" tick interval

    // Above the prompt, in a slide Revealer: a right-aligned "pending" message — a
    // turn the user queued while the agent was busy. Revealed while a message is pending.
    this.pendingBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, halign: Gtk.Align.END });
    this.pendingBox.addCssClass('conversation-pending');
    this.pendingLabel = wrappingLabel({ xalign: 1 });
    this.pendingBox.append(this.pendingLabel);
    // The queued turn is sent automatically once the agent goes idle; until then the
    // user can amend it (Edit → moves it back into the prompt) or drop it (Cancel).
    const pendingControls = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, halign: Gtk.Align.END, spacing: 4 });
    pendingControls.addCssClass('conversation-pending-controls');
    const pendingHint = new Gtk.Label({ label: 'Pending' });
    pendingHint.addCssClass('conversation-system');
    const editPending = new Gtk.Button({ label: 'Edit' });
    editPending.addCssClass('flat');
    editPending.addCssClass('conversation-pending-action');
    const cancelPending = new Gtk.Button({ label: 'Cancel' });
    cancelPending.addCssClass('flat');
    cancelPending.addCssClass('conversation-pending-action');
    this.subs.connect(editPending, 'clicked', () => this.editPending());
    this.subs.connect(cancelPending, 'clicked', () => this.cancelPending());
    pendingControls.append(pendingHint);
    pendingControls.append(editPending);
    pendingControls.append(cancelPending);
    this.pendingBox.append(pendingControls);

    this.thinkingReveal = new Gtk.Revealer();
    this.thinkingReveal.setTransitionType(Gtk.RevealerTransitionType.SLIDE_UP);
    this.thinkingReveal.setChild(this.pendingBox);
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
    // `/rename` is a zym-local command (headless claude rejects it), so it's offered
    // alongside the CLI's own slash commands rather than coming from `init`.
    this.input.addCompletionSource(createSlashCommandSource(() => ['rename', ...this._slashCommands]));
    this.promptContainer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.promptContainer.addCssClass('conversation-prompt');
    this.promptContainer.setVexpand(false);
    this.promptContainer.append(this.input.root);

    // A thin footer: the agent status icon (same as the sidebar) + a permission-mode
    // dropdown (colored per mode) + the model/context gauge (ModelContext).
    this.statusIcon = createAgentStatusIcon(this);
    this.modeDropdown = Gtk.DropDown.newFromStrings(PERMISSION_CYCLE);
    this.modeDropdown.addCssClass('flat');
    this.modeDropdown.addCssClass('conversation-mode');
    this.subs.connect(this.modeDropdown, 'notify::selected', () => {
      if (this.applyingMode) return;
      const mode = PERMISSION_CYCLE[this.modeDropdown.getSelected()];
      if (mode) this.session.setPermissionMode(mode);
    });
    // Footer layout: a LEFT slot (the status icon, or the thinking indicator that
    // replaces it while working) · a spacer · then the permission-mode dropdown and
    // the model/context gauge pushed to the RIGHT edge.
    this.footer = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 14 });
    this.footer.addCssClass('conversation-footer');
    this.footer.append(this.statusIcon.widget);
    this.footer.append(this.thinkingFooter);
    this.footer.append(new Gtk.Box({ hexpand: true })); // spacer → right-aligns the rest
    this.footer.append(this.modeDropdown);
    this.modelContext.widget.setHexpand(false); // the spacer owns the slack, not the gauge
    this.footer.append(this.modelContext.widget);
    this.updateFooter();

    // The input and its status strip live together in a bordered, rounded card.
    // `overflow: hidden` (the GTK CSS property) doesn't exist — the equivalent is
    // setOverflow(HIDDEN), which clips children to the rounded border so the
    // TextEditor's square background corners don't escape the radius.
    // The prompt editor + the interaction slot share a stack: a permission/question
    // widget replaces the editor in place (vhomogeneous off so the card sets its own
    // height), restored once answered. Starts on the prompt.
    this.promptStack.setVhomogeneous(false);
    this.promptStack.addNamed(this.promptContainer, 'prompt');
    this.promptStack.addNamed(this.interactionSlot, 'interaction');

    const inputCard = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.inputCard = inputCard;
    inputCard.addCssClass('conversation-input-card');
    inputCard.setOverflow(Gtk.Overflow.HIDDEN);
    inputCard.append(this.promptStack);
    inputCard.append(this.footer);

    // Ring the card while the prompt holds focus; the controller sits on the prompt
    // container so the footer dropdown is excluded.
    const promptFocus = new Gtk.EventControllerFocus();
    promptFocus.on('enter', () => inputCard.addCssClass('prompt-focused'));
    promptFocus.on('leave', () => inputCard.removeCssClass('prompt-focused'));
    this.subs.addController(this.promptContainer, promptFocus);

    // Subagents push pages onto this.root (the NavigationView, assigned next); the
    // push/pop arrows defer that lookup until a click.
    const nav = { push: (page: InstanceType<typeof Adw.NavigationPage>) => this.root.push(page), pop: () => this.root.pop() };
    // Owned child views: registered on `subs` so a single `subs.dispose()` severs their
    // handlers too (transcript is a field initializer, so it's added here, not at creation).
    this.subs.add(this.transcript);
    this.subagentView = this.subs.use(new SubagentView(this.session, nav, this.cwd, this.onOpenFile));
    this.monitorView = this.subs.use(new MonitorView(this.session, nav));

    // Workbench actions are shown in the window header bar (WorkbenchActionsBar), not
    // the conversation — this view only pipes the agent's reports into the set.

    const mainBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
    mainBox.addCssClass('conversation-surface');
    mainBox.append(this.tasksPanel.root);
    mainBox.append(this.transcript.root); // the scrollable transcript column
    mainBox.append(this.thinkingReveal); // the thinking spinner sits just above the prompt
    mainBox.append(inputCard);
    // Running subagents / monitors now live in the agent header bar (robot / terminal
    // count buttons with a popover), not a panel below the input — see headerWidgets.

    // A NavigationView so a subagent's transcript can push its own page.
    this.root = new Adw.NavigationView();
    this.root.addCssClass('AgentConversation');
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
      const divider = this.addRow('conversation-resume');
      divider.setXalign(0.5);
      divider.setHalign(Gtk.Align.CENTER);
      this.resumeNoteRow = divider;
      this.refreshResumeNote();
      if (this.deferredStart) this.setStatus('disconnected');
      // The Transcript follows the bottom by default, so the restored transcript lands
      // at the latest message as its height settles over the first few layout passes.
    }
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
    // Seed the title from the transcript (`/rename` custom title, else Claude's auto
    // title). Headless has no live OSC channel, so without this a resumed agent
    // would lose its name. A pinned `agent:rename` name, if any, still wins.
    const name = readSessionName(cwd, sessionId);
    if (name) { this._sessionName = name; this.emitTitle(); }
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
    for (const m of PERMISSION_CYCLE) this.modeDropdown.removeCssClass(`is-${m}`);
    this.modeDropdown.addCssClass(`is-${this._permissionMode}`);
  }

  /** Spawn claude and send the launch prompt (if any). A lazily-resumed agent
   *  skips the spawn here — `ensureConnected` runs it on the first turn instead. */
  start(): void {
    if (!this.deferredStart) {
      this.session.start();
      if (this.launchPrompt) {
        this.session.prompt(this.launchPrompt);
        // Auto-name a fresh agent from the user's prompt — namingContext() strips zym's
        // editor instructions (config-gated, non-blocking, runs alongside the first
        // turn). No-op if there's no user prompt or it's somehow already named.
        if (zym.config.get('agent.autoName') === true && !this._sessionName && !this._displayName) {
          void this.autoRename(this.namingContext());
        }
      }
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

  // A transient auto-naming title (placeholder / failed fallback) wins while set;
  // then a pinned name (`agent:rename`), then Claude's session name (`/rename` /
  // resumed transcript title), then the default. Mirrors AgentTerminal.title.
  get title(): string { return this._transientName ?? this._displayName ?? this._sessionName ?? DEFAULT_TITLE; }
  get status(): AgentStatus { return this._status; }
  get permissionMode(): AgentMode { return this._permissionMode; }
  get changedFiles(): string[] { return this._changedFiles.slice(); }
  get effectiveCwd(): string { return this._effectiveCwd; }
  get sessionId(): string | null { return this.session.sessionId; }
  get renamed(): boolean { return this._displayName !== null; }
  get exited(): boolean { return this._status === 'disconnected'; }
  get unannouncedWorktree(): string | null { return null; }

  // The agent header bar packs these (AgentSidebar): the subagent (robot) and monitor
  // (terminal) count buttons, each hidden until it has a running item and opening a
  // popover listing them. Per-agent + stable instances, so the sidebar can swap them.
  get headerWidgets(): Array<InstanceType<typeof Gtk.Widget>> {
    return [this.subagentView.headerButton.button, this.monitorView.headerButton.button];
  }

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
  // A running agent is not "modified" work: nothing to flush, killed on quit, so it
  // never blocks the exit prompt (only unsaved editors do). The label is kept for
  // the Agent surface but unused while isModified is false.
  isModified(): boolean { return false; }
  getModifiedLabel(): string { return `${this.title}${this._status === 'disconnected' ? ' (resumed)' : ' (running)'}`; }

  onDidChangeStatus(cb: () => void): () => void { return push(this.statusHandlers, cb); }
  onDidChangeFiles(cb: () => void): () => void { return push(this.fileHandlers, cb); }

  /** Bind to the workbench's action set so the agent's reported `set_actions` pipes
   *  into it (`session.onActions` → `boundActions.setFromAgent`). The conversation
   *  keeps no action state of its own and shows no in-chat bar — the buttons live in
   *  the header (`WorkbenchActionsBar`). AppWindow calls this once the workbench exists. */
  bindActions(controller: WorkbenchActions): void {
    this.boundActions = controller;
  }
  onTitleChange(cb: () => void): () => void { return push(this.titleHandlers, cb); }
  onDidChangeAttention(cb: () => void): () => void { return push(this.attentionHandlers, cb); }
  onDidChangePermissionMode(cb: () => void): () => void { return push(this.permissionModeHandlers, cb); }
  onDidChangeWorktree(cb: () => void): () => void { return push(this.worktreeHandlers, cb); }

  dispose(): void {
    this.disposed = true; // an in-flight auto-rename must not touch a torn-down view
    this.subs.dispose(); // also disposes transcript / subagentView / monitorView (registered via use())
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


  private cyclePermissionMode(): void {
    const index = PERMISSION_CYCLE.indexOf(this._permissionMode);
    const next = PERMISSION_CYCLE[(index + 1) % PERMISSION_CYCLE.length];
    this.session.setPermissionMode(next);
  }

  private submit(): void {
    const text = this.input.getText().trim();
    if (!text) return;
    this.input.setText('');
    if (this.handleLocalCommand(text)) return; // client-side slash command (e.g. /rename), not a turn
    this.ensureConnected(); // a lazily-resumed agent spawns claude on its first turn
    if (this._status === 'idle') { this.session.prompt(text); return; }
    // The agent is busy — queue (accumulate) the message; it's sent on next idle.
    this.setPendingText(this.pendingText ? `${this.pendingText}\n\n${text}` : text);
  }

  /** Set (or clear) the queued message and refresh the pending bubble. */
  private setPendingText(text: string): void {
    this.pendingText = text;
    this.refreshThinking();
  }

  /** Pull the queued message back into the prompt to amend it (prepended ahead of any
   *  text already typed), clearing the queue — it's being edited, not waiting. */
  private editPending(): void {
    const text = this.pendingText;
    if (!text) return;
    const current = this.input.getText();
    this.input.setText(current ? `${text}\n\n${current}` : text);
    this.setPendingText('');
    this.input.focusInsert();
  }

  /** Discard the queued message without sending it. */
  private cancelPending(): void {
    this.setPendingText('');
  }

  /** Run a zym-local slash command the headless CLI can't (today only `/rename`,
   *  which `claude -p` rejects as "not available in this environment"). Mirrors the
   *  TUI's client-side handling. Returns true when `text` was a local command (so
   *  it isn't sent to claude as a turn). */
  private handleLocalCommand(text: string): boolean {
    const parsed = parseLocalCommand(text);
    if (!parsed) return false;
    if (!parsed.name) {
      void this.autoRename(this.namingContext()); // bare `/rename` → auto-generate a name
      return true;
    }
    this.setSessionName(parsed.name); // the visible title change is the confirmation
    return true;
  }

  /** The best text to name this session from: the user's own launch prompt (free of
   *  zym's editor instructions), else the first genuine user turn (also captured
   *  while replaying a resumed transcript). */
  private namingContext(): string {
    return (this.userPrompt ?? this.firstUserText ?? '').trim();
  }

  /** Auto-generate and apply a session name from `context` via the one-shot agent.
   *  Non-blocking (runs alongside the live turn) and silent on success — only a
   *  failure raises a toast. No-op without context or while one is already running. */
  private async autoRename(context: string): Promise<void> {
    const text = context.trim();
    if (!text || this.autoNaming) return;
    this.autoNaming = true;
    this.setTransientName('…'); // show a placeholder while the one-shot runs (display only, not persisted)
    try {
      const result = await generateAgentName(this.oneShot, text, { cwd: this.cwd });
      if (this.disposed) return;
      if (result) {
        this.setSessionName(result.name); // persist like /rename
        this.setTransientName(null); // drop the placeholder → the real name shows (the confirmation)
      } else {
        this.failNaming();
      }
    } catch (err) {
      if (this.disposed) return;
      this.failNaming(err);
    } finally {
      this.autoNaming = false;
    }
  }

  /** A transient, in-app-only display title (the auto-naming placeholder / fallback);
   *  never persisted to the transcript. Null clears it. */
  private setTransientName(name: string | null): void {
    this._transientName = name;
    this.emitTitle();
  }

  /** Auto-naming failed: drop the placeholder — reverting to the previous name, or
   *  the kind default if there was none — and warn. */
  private failNaming(err?: unknown): void {
    this.setTransientName(null);
    zym.notifications.addWarning(
      err ? 'Auto-rename failed' : 'Could not generate an agent name',
      err ? { detail: String((err as Error)?.message ?? err) } : undefined,
    );
  }

  /** Set Claude's session name (`/rename`): update the live title and persist it to
   *  the transcript, exactly as the TUI does, so it survives resume and labels the
   *  resume picker. A pinned `agent:rename` name still wins (see `title`). */
  private setSessionName(name: string): void {
    this._sessionName = name;
    this.emitTitle();
    const id = this.sessionId ?? this.resumeSessionId;
    if (id) writeCustomTitle(this.cwd, id, name);
  }

  // --- session → state + rows -------------------------------------------------

  private wireSession(): void {
    this.subs.add(
      this.session.onStatus(() => this.setStatus(this.session.status)),
      // Pipe the agent's set_actions straight into its workbench's set (bound via
      // bindActions); the controller's change re-renders the header-bar buttons.
      this.session.onActions(({ actions }) => this.boundActions?.setFromAgent(actions)),
      this.session.onCwd(({ cwd }) => this.setEffectiveCwd(cwd)),
      this.session.onMode(() => {
        this._permissionMode = this.session.permissionMode;
        this.updateFooter();
        for (const handler of this.permissionModeHandlers) handler();
      }),
      this.session.onUserMessage(({ text }) => {
        // Capture the first genuine user turn (context for an empty `/rename`), but skip
        // the launch turn's echo — it may carry zym's editor instructions; `userPrompt`
        // holds the clean version and is preferred in namingContext().
        if (this.firstUserText === null && text !== this.launchPrompt) this.firstUserText = text;
        this.endTurn();
        // The token count + elapsed clock reset on the working transition (startThinkingTimer).
        this.addMarkdownBlock('user').setMarkdown(text);
      }),
      // Live "Thinking… (N tokens · Ms)" while the model reasons before producing output;
      // the elapsed time is folded in by refreshThinkingLabel.
      this.session.onThinkingTokens(({ tokens }) => {
        this.thinkingTokens = tokens;
        this.refreshThinkingLabel();
      }),
      // Subagent / background-task live progress → the originating tool row.
      this.session.onTaskProgress((p) => this.toolRows.get(p.id)?.onProgress?.(p)),
      // Shown by subagentView.spawn (on the Agent tool call); hidden on completion.
      this.session.onSubagentDone(({ id }) => this.subagentView.done(id)),
      // Monitor status changes (running → killed/stopped/completed) refresh the panel.
      this.session.onMonitorUpdate(({ id }) => this.monitorView.update(id)),
      this.session.onAssistantStart(() => {
        this.assistantRaw = '';
        this.assistantView = this.addMarkdownBlock('assistant');
      }),
      this.session.onAssistantText(({ delta }) => {
        if (!this.assistantView) {
          this.assistantRaw = '';
          this.assistantView = this.addMarkdownBlock('assistant');
        }
        this.assistantRaw += delta;
        this.assistantView.setMarkdown(this.assistantRaw);
        this.transcript.scrollToBottom();
      }),
      this.session.onAssistantThinking(({ delta }) => {
        if (zym.config.get('agent.showThinking') !== true) return; // thinking blocks are opt-in
        if (!this.thinkingView) {
          this.thinkingRaw = '';
          this.thinkingView = this.addMarkdownBlock('thinking');
        }
        this.thinkingRaw += delta;
        this.thinkingView.setMarkdown(this.thinkingRaw);
        this.transcript.scrollToBottom();
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
            this.transcript.appendGroupItem(SUBAGENT_GROUP.key, SUBAGENT_GROUP.icon, SUBAGENT_GROUP.head, this.subagentView.spawn(id, input));
            return;
          }
          this.recordChangedFile(name, input); this.endTurn(); this.addToolRow(id, name, input, false); return;
        }
        if (name === 'AskUserQuestion') return; // handled by the interactive question card
        if (name === 'Agent') { this.endTurn(); this.transcript.appendGroupItem(SUBAGENT_GROUP.key, SUBAGENT_GROUP.icon, SUBAGENT_GROUP.head, this.subagentView.spawn(id, input)); return; }
        if (name === 'Monitor') {
          const mi = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
          const desc = typeof mi.description === 'string' ? mi.description : typeof mi.command === 'string' ? mi.command : 'monitor';
          this.endTurn(); this.transcript.appendToolEntry(this.monitorView.spawn(id, desc)); this.transcript.scrollToBottom(); return;
        }
        this.recordChangedFile(name, input);
        this.endTurn(); // close the current message; post-tool text opens a fresh bubble
        this.addToolRow(id, name, input, true); // live: the row spins until its result lands
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
      this.session.onError(({ message, detail }) => this.addErrorRow(message, detail)),
      this.session.onInterrupted(() => this.addInterruptedRow()),
      this.session.onUnhandled(({ event }) => this.addUnknownRow(event)),
      this.session.onPermission((req) => this.addPermissionCard(req)),
      this.session.onQuestion((req) => this.addQuestionCard(req)),
      this.session.onExit(({ code }) => {
        this.endTurn();
        const note = code != null && code !== 0 ? `── process exited (code ${code}) ──` : '── process exited ──';
        this.addRow('conversation-system').setText(note);
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
    // Turn ended: stop any tool row still spinning (interrupted / crashed before its
    // result landed; a completed row already cleared its own spinner via onResult).
    if (status === 'idle' || status === 'disconnected') {
      for (const entry of this.toolRows.values()) entry.row?.setRunning(false);
    }
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

  // While working, the footer's thinking indicator replaces the status icon; a queued
  // message reveals the pending bubble above the prompt. The two are independent.
  private refreshThinking(): void {
    const working = this._status === 'working';
    const pending = this.pendingText !== '';
    this.statusIcon.widget.setVisible(!working);
    this.thinkingFooter.setVisible(working);
    this.pendingLabel.setText(this.pendingText);
    this.thinkingReveal.setRevealChild(pending);
    // Run the per-turn elapsed-time tick only while working (started/stopped here so a
    // queued-message refresh mid-turn doesn't restart the clock — see startThinkingTimer).
    if (working) this.startThinkingTimer();
    else this.stopThinkingTimer();
  }

  // Begin (or keep) the per-turn "Thinking…" clock: reset the token count + start time
  // and tick the footer label once a second. Idempotent within a turn — a no-op while
  // already running, so it resets exactly once per working transition.
  private startThinkingTimer(): void {
    if (this.thinkingTimerActive) return;
    this.thinkingTimerActive = true;
    this.thinkingTokens = 0;
    this.thinkingStartMs = Date.now();
    this.refreshThinkingLabel();
    this.thinkingTimerSubs.interval(() => this.refreshThinkingLabel(), 1000);
  }

  // Stop the clock when the turn ends (idle / waiting / exited); clears the interval.
  private stopThinkingTimer(): void {
    if (!this.thinkingTimerActive) return;
    this.thinkingTimerActive = false;
    this.thinkingTimerSubs.clear();
  }

  // Recompose the footer indicator from the latest token count + elapsed time:
  // "Thinking…", "Thinking… (12s)", or "Thinking… (1.2k tokens · 1m 05s)".
  private refreshThinkingLabel(): void {
    const parts: string[] = [];
    if (this.thinkingTokens > 0) parts.push(`${formatCount(this.thinkingTokens)} tokens`);
    if (this.thinkingStartMs > 0) parts.push(formatElapsed(Date.now() - this.thinkingStartMs));
    this.thinkingLabel.setText(parts.length ? `Thinking… (${parts.join(' · ')})` : 'Thinking…');
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
      const label = wrappingLabel({ xalign: 0 });
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

  // A markdown message block (user / assistant / thinking) as a shared Message;
  // returns its view so the caller can stream into it via setMarkdown.
  private addMarkdownBlock(kind: MessageKind): MarkdownView {
    const message = new Message(kind);
    this.transcript.appendEntry(message.root); // a MESSAGE entry (not a tool entry)
    this.transcript.scrollToBottom();
    return message.view;
  }

  // A single wrapped, left-aligned row (thinking / tool / system).
  private addRow(cssClass: string): InstanceType<typeof Gtk.Label> {
    const label = wrappingLabel({ xalign: 0, selectable: true });
    label.addCssClass('conversation-row');
    label.addCssClass(cssClass);
    this.transcript.appendToolEntry(label);
    this.transcript.scrollToBottom();
    return label;
  }

  // An error notice in the conversation flow (refusal / max-turns / API error). The
  // optional `detail` (claude's own message, else the captured stderr tail) renders
  // as a dim monospace sub-row so the cause is visible, not just the subtype.
  private addErrorRow(message: string, detail?: string): void {
    const label = this.addRow('conversation-error');
    setMarkupSafe(label, `${iconSpan(NERDFONT.STATUS.CROSS, theme.ui.status.error)}  ${escapeMarkup(message)}`, message);
    if (!detail) return;
    const body = this.addRow('conversation-system');
    body.addCssClass('conversation-unknown-body'); // monospace, wrapped
    body.setText(detail);
  }

  // A muted notice that the user interrupted the turn (ctrl-c).
  private addInterruptedRow(): void {
    const label = this.addRow('conversation-system');
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

    const header = wrappingLabel({ xalign: 0, hexpand: true }); // WORD_CHAR breaks a long unbroken event name instead of widening the row
    setMarkupSafe(header, `unhandled <tt>${escapeMarkup(type)}</tt> event`, `unhandled ${type} event`);

    const toolRow = new ToolRow({ icon: NERDFONT.STATUS.WARNING, header, status: 'warning', subs: this.subs });
    const body = wrappingLabel({ xalign: 0, selectable: true });
    body.addCssClass('conversation-unknown-body');
    body.setText(json);
    toolRow.content.append(body);

    this.transcript.appendToolEntry(toolRow.root);
    this.transcript.scrollToBottom();
  }

  // A tool-use row: built by the shared `appendToolRow` (Bash command row, collapsed
  // file-tool group, or generic toggle row) so the main transcript and each subagent
  // page render tools identically. We only key the returned handle by tool_use_id so
  // the matching result / progress event can update it.
  private addToolRow(id: string, name: string, input: unknown, live: boolean): void {
    const entry = appendToolRow(this.transcript, name, input, { cwd: this.cwd, onOpenFile: this.onOpenFile, subs: this.subs, live });
    if (id) this.toolRows.set(id, { row: entry.row, name, input, onResult: entry.onResult, onProgress: entry.onProgress });
  }

  private updateToolResult(id: string, isError: boolean, text: string): void {
    const row = this.toolRows.get(id);
    if (!row) return;
    row.onResult(isError, text);
    this.transcript.scrollToBottom();
  }

  // A permission request REPLACES the prompt with an approval widget (title +
  // command + actions). The tool's own row already sits in the transcript (from the
  // tool-use event) and fills in with the result once the decision lands, so the
  // prompt carries only the approval — no correlation to a row needed.
  private addPermissionCard(req: PermissionRequest): void {
    const parts = permissionPromptParts(req.toolName, req.input, this.cwd);
    // Edit tools show the change as a diff body (the title is the file path); "Allow
    // edits" only makes sense for them (acceptEdits auto-accepts file edits, not
    // command runs), so it's offered only for those.
    const isEdit = EDIT_TOOLS.has(req.toolName);
    const body = isEdit ? permissionDiffView(editDiffLines(req.toolName, req.input)) : undefined;
    const choices: PermissionChoice[] = isEdit
      ? ['accept', 'deny', 'acceptEdits', 'auto']
      : ['accept', 'deny', 'auto'];
    const prompt = permissionPrompt(this.interactionSubs, { ...parts, body }, choices, (choice) => this.resolvePermission(req, choice));
    this.showInteraction(prompt, 'permission');
  }

  // Apply the user's choice: `acceptEdits` / `auto` first switch the session mode (so
  // the like calls that follow stop prompting), then every non-deny choice allows the
  // pending call. Restoring the prompt drops the widget + its handlers.
  private resolvePermission(req: PermissionRequest, choice: PermissionChoice): void {
    if (choice === 'acceptEdits') this.session.setPermissionMode('acceptEdits');
    else if (choice === 'auto') this.session.setPermissionMode('auto');
    this.session.respondPermission(req.id, { allow: choice !== 'deny' });
    this.interactionSubs.clear(); // sever the prompt's button handlers
    this.clearInteraction(); // drops the widget from the slot + restores the prompt
  }

  // An AskUserQuestion REPLACES the prompt with the interactive question card. On
  // answer the card moves into the transcript (where it renders itself as the answered
  // record) and the prompt is restored — so the card outlives the slot, hence it's
  // owned by `subs`, not the per-interaction bag.
  private addQuestionCard(req: QuestionRequest): void {
    const card = new QuestionCard(req, (answers) => {
      this.session.answerQuestion(req.id, answers);
      this.interactionSlot.remove(card.root); // hand the card to the transcript before it
      this.transcript.appendEntry(card.root); // rewrites itself into the answered summary
      this.clearInteraction(); // back to the prompt
      this.transcript.scrollToBottom();
    });
    this.subs.defer(() => card.dispose()); // sever the card's controllers when the conversation tears down
    this.showInteraction(card.root, 'question'); // the card grabs focus on map (for j/k nav)
  }

  // Swap the input for an interaction widget (permission / question) and ring the
  // input card in the matching status colour; clearInteraction reverses both.
  private showInteraction(widget: InstanceType<typeof Gtk.Widget>, kind: 'permission' | 'question'): void {
    clearChildren(this.interactionSlot);
    this.interactionSlot.append(widget);
    this.promptStack.setVisibleChildName('interaction');
    this.inputCard.addCssClass(kind === 'permission' ? 'is-permission' : 'is-question');
  }

  private clearInteraction(): void {
    clearChildren(this.interactionSlot);
    this.promptStack.setVisibleChildName('prompt');
    this.inputCard.removeCssClass('is-permission');
    this.inputCard.removeCssClass('is-question');
    this.input.focusInsert(); // ready to type again
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
