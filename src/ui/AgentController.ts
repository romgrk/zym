/*
 * AgentController — the agent feature: launching / resuming agents in their own
 * workbench, the send-to-agent + diff-review routing, per-agent subscriptions
 * (title / status / worktree / edited files), viewed/attention tracking, agent session
 * serialize+restore, and the `agent:*` commands. Pulled out of AppWindow so the agent
 * feature lives in one place.
 *
 * It owns the agent-lifetime subscriptions (`agentSubs`), the last-focused agent, and
 * the viewed agent. Everything it needs from the rest of the shell is the panel-tree
 * spine (`PaneItems`), the per-person workbench lifecycle (`WorkbenchManager`), and the
 * two agent-facing widgets (the secondary sidebar + the WorkbenchList); pickers mount on
 * the app-wide `zym.workspace` picker host. See docs/agents.md.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import Gtk from 'gi:Gtk-4.0';
import { zym } from '../zym.ts';
import type { Agent } from '../agents/types.ts';
import { type AgentStatus, type AgentResume } from './AgentTerminal.ts';
import { AgentConversation } from './AgentConversation.ts';
import { AGENT_CONFIGS, resolveAgentKind, type AgentKind } from '../agents/configs.ts';
import { createDocumentFs } from '../agents/acp/documentFs.ts';
import { listResumableSessions, recordSessionWorktree, relativeTime, relocateTranscriptToMainRoot, type AgentSession } from '../agentSessions.ts';
import { type AgentState, fileTabsOf } from '../SessionManager.ts';
import type { Workbench } from './workbench/Workbench.ts';
import { type Owner, isAgent } from './workbench/Owner.ts';
import type { PaneItems } from './workbench/PaneItems.ts';
import type { WorkbenchManager } from './workbench/WorkbenchManager.ts';
import type { AgentSidebar } from './AgentSidebar.ts';
import type { Sidebar } from './Sidebar.ts';
import { openAgentPicker } from './AgentPicker.ts';
import { openAgentLauncher, launchPrompt, type LauncherMode } from './AgentLauncher.ts';
import { openPicker } from './Picker.ts';
import { Icons } from './icons.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { proseMarkup, escapeMarkup, PROSE_LINE_HEIGHT } from './proseMarkup.ts';
import { listWorktrees, worktreeInfo, repoRoot, readFileAtRef, type WorktreeInfo } from '../git.ts';
import { DiffView } from './DiffView.ts';
import { type DiffFile } from './multibuffer/diffMultiBuffer.ts';
import { type PanelChild } from './Panel.ts';
import { CompositeDisposable, Disposable } from '../util/eventKit.ts';

type Wb = Workbench<Owner>;

export interface AgentControllerDeps {
  paneItems: PaneItems;
  workbenchManager: WorkbenchManager;
  agentSidebar: AgentSidebar;
  sidebar: Sidebar;
}

export class AgentController {
  private readonly d: AgentControllerDeps;
  // Per-agent subscriptions (title/status/worktree/files + the session participant),
  // disposed in closeAgent.
  private readonly agentSubs = new Map<Agent, CompositeDisposable>();
  // The most recently focused agent — the default target for send-to-agent.
  private lastAgent: Agent | null = null;
  // Each agent's open "Agent Changes" diff tab — reopening closes it first
  // (refresh-in-place); a WeakMap so retired agents drop out on their own.
  private readonly changesTabs = new WeakMap<Agent, PanelChild>();
  // The agent the user is currently looking at (its workbench is active), so its status
  // counts as seen — clears the sidebar attention blink (see updateViewedAgent).
  private viewedAgent: Agent | null = null;

  constructor(deps: AgentControllerDeps) {
    this.d = deps;
  }

  private get workbench(): Wb {
    return this.d.workbenchManager.active;
  }

  private host() {
    return zym.workspace.getPickerHost();
  }

  /** The agent whose workbench is active, if any. */
  get activeAgent(): Agent | null {
    return isAgent(this.workbench.owner) ? this.workbench.owner : null;
  }

  // The launcher gathers the prompt + model / permission mode / effort / kind + a worktree
  // choice, then hands back the assembled argv. The worktree is set up by the agent itself
  // (it announces it via set_worktree, which re-roots the workbench) — see launchPrompt.
  private launchAgent(mode?: LauncherMode): void {
    openAgentLauncher(this.host(), {
      cwd: this.workbench.cwd,
      defaultKind: resolveAgentKind(zym.config.get('agent.implementation')),
      mode,
      onLaunch: ({ prompt, command, cwd, kind, worktree, background, model, permissionMode }) => {
        const { agentPrompt, userPrompt } = launchPrompt(prompt, worktree);
        this.openAgent({ prompt: agentPrompt, userPrompt, command, root: cwd, kind, background, model, permissionMode });
      },
    });
  }

  /** Register the `agent:*` commands on `.AppWindow`. */
  registerCommands(): void {
    zym.commands.add('.AppWindow', {
      'agent:new': { didDispatch: () => this.launchAgent(), description: 'Start a new agent' },
      // The three worktree-scoped launcher flows (the worktree itself is realized by the
      // agent — see launchPrompt): pick an existing branch, the current root, or a fresh one.
      'agent:new-in-worktree': { didDispatch: () => this.launchAgent('existing-worktree'), description: 'Start a new agent in an existing git worktree' },
      'agent:new-this-worktree': { didDispatch: () => this.launchAgent('this-worktree'), description: 'Start a new agent in the current git worktree' },
      'agent:new-worktree': { didDispatch: () => this.launchAgent('new-worktree'), description: 'Start a new agent in a new git worktree' },
      'agent:picker': {
        didDispatch: () => openAgentPicker(this.host(), {
          onActivate: (agent) => this.showAgent(agent),
          sessionRoots: this.agentSessionRoots(),
          mainRoot: this.mainRoot(),
          agentWorktree: (agent) => this.agentWorktree(agent),
          // Resume restoring the conversation's branch/worktree/cwd (see resumeOptions).
          onResume: (session) => this.openAgent(this.resumeOptions(session)),
          onStart: (prompt) => this.openAgent({ prompt }),
        }),
        description: 'Open the agent picker (agents, conversations, new)',
      },
      // Resume a stopped agent in place (current agent, if exited). Resuming a
      // past *conversation* as a fresh agent is agent:resume-conversation (a picker).
      'agent:resume': { didDispatch: () => this.resumeCurrentAgent(), description: 'Resume the stopped agent', when: () => this.currentAgent()?.exited === true },
      'agent:resume-conversation': { didDispatch: () => this.resumeAgentPicker(), description: 'Resume a past conversation…' },
      // Branch the current agent into a new agent/workbench: a fresh session forked off
      // its conversation, so the original agent is left running and untouched.
      'agent:branch': { didDispatch: () => this.branchCurrentAgent(), description: 'Branch the agent into a new forked agent', when: () => this.currentAgent() !== null },
      // Lifecycle / navigation for the active agent. Stop SIGTERMs the child (the widget
      // lingers as exited, resumable); next/prev cycle through the running agents.
      'agent:stop': { didDispatch: () => this.activeAgent?.kill(), description: 'Stop the active agent', when: () => this.activeAgent !== null },
      'agent:restart': { didDispatch: () => this.restartCurrentAgent(), description: 'Restart the agent (resume its conversation)', when: () => this.currentAgent() !== null },
      'agent:rename': { didDispatch: () => this.renameCurrentAgent(), description: 'Rename the agent', when: () => this.currentAgent() !== null },
      // Close for good: terminate the child if it's still running, then remove its
      // workbench and retire it from the list (unlike tab:close, which only backgrounds).
      'agent:close': { didDispatch: () => this.closeCurrentAgent(), description: 'Close the agent (terminate it and remove it from the list)', when: () => this.currentAgent() !== null },
      'agent:open-changes': { didDispatch: () => this.openChangesOfCurrentAgent(), description: "Review the agent's changes (diff panel)", when: () => this.currentAgent() !== null },
      'agent:focus-next': { didDispatch: () => this.focusAdjacentAgent(1), description: 'Focus the next agent' },
      'agent:focus-prev': { didDispatch: () => this.focusAdjacentAgent(-1), description: 'Focus the previous agent' },
      // Push the active editor's context into an agent's prompt — the current agent
      // (send-*), or one chosen from the picker (send-*-to).
      'agent:send-selection': { didDispatch: () => this.sendToAgent(this.editorSelectionText()), description: 'Send the selection to the current agent' },
      'agent:send-file': { didDispatch: () => this.sendToAgent(this.editorFileText()), description: 'Send the file path to the current agent' },
      'agent:send-selection-to': { didDispatch: () => this.pickAgentAndSend(this.editorSelectionText()), description: 'Send the selection to an agent…' },
      'agent:send-file-to': { didDispatch: () => this.pickAgentAndSend(this.editorFileText()), description: 'Send the file path to an agent…' },
      'agent:send-selection-to-new': { didDispatch: () => this.composeNewAgent(this.editorSelectionText()), description: 'Send the selection to a new agent' },
      'agent:send-file-to-new': { didDispatch: () => this.composeNewAgent(this.editorFileText()), description: 'Send the file path to a new agent' },
    });
  }

  /**
   * Launch (or resume) an agent in its own workbench. The kind is an explicit
   * `options.kind`, else the `agent.implementation` flag. `AGENT_CONFIGS` builds the
   * host; everything below is generic over the `Agent` surface, so the terminal and
   * headless kinds share this one launch path.
   *
   * The agent gets its own `Workbench`; its widget lives in the secondary sidebar, the
   * center stays free as the work/review area. Activate the workbench before focusing it.
   */
  openAgent(
    options: { kind?: AgentKind; prompt?: string; userPrompt?: string; resume?: AgentResume; title?: string; root?: string; command?: string[]; background?: boolean; model?: string; permissionMode?: string } = {},
  ): Agent {
    // Both kinds can resume, so a
    // resume no longer forces the terminal agent — it respects the configured kind
    // unless a caller pins one (e.g. restoreAgent passes the saved agent's kind).
    const kind = options.kind ?? resolveAgentKind(zym.config.get('agent.implementation'));
    // Invariant: the agent *process* always spawns in the active project's main dir
    // (`mainRoot()`), never a worktree — its OS cwd then can't sit inside a worktree that
    // gets removed (which crashes the agent), and every transcript lands under one project
    // dir so `--resume` always resolves (resume + discovery use the same mainRoot). The
    // worktree is an editor concern only: `root` roots the agent's *workbench*
    // (Files/Git/gutters), which owns the editor cwd — the agent stores none. Launching from
    // a second project spawns there, not the global primary; on restore the restored project
    // is active. See docs/agents.md.
    const mainRoot = this.mainRoot();
    let root = options.root ?? mainRoot;
    if (root !== mainRoot && !Fs.existsSync(root)) root = mainRoot; // a vanished worktree → main dir
    const agent = AGENT_CONFIGS[kind].create({
      cwd: mainRoot, command: options.command, prompt: options.prompt, userPrompt: options.userPrompt, resume: options.resume, title: options.title,
      model: options.model, permissionMode: options.permissionMode,
      onOpenFile: (path) => this.d.paneItems.openFile(path),
      fs: createDocumentFs(this.d.paneItems.documents),
    });
    // Track in the tab registry (terminal focus-routing / headless disposal key off these).
    this.d.paneItems.trackAgent(agent);
    // Background launch: build the agent's workbench and start it, but stay on the
    // current workbench and don't focus it (it's listed in the sidebar; switch to it later).
    const workbench = this.d.workbenchManager.buildWorkbench(agent, root);
    // Pipe the agent's `set_actions` straight into its workbench's action set (the agent
    // keeps no copy). The set is shown as buttons in the window header bar when this
    // workbench is active; pruning stale terminal tabs is driven off the workbench set change.
    agent.bindActions(workbench.actions);
    // The agent widget lives in the "secondary sidebar" (a full-height column with its own
    // header) rather than the workbench center — uncloseable (no tab). activateWorkbench
    // makes it the visible one. The workbench center stays free as the work/review area.
    this.d.agentSidebar.addAgent(agent.root);
    if (!options.background) this.d.workbenchManager.activateWorkbench(workbench); // shows + reveals the agent column
    if (!options.background) this.updateViewedAgent(); // its workbench is now active — mark it viewed
    // Keep the secondary-sidebar header title in sync when this agent is the shown one.
    const agentSubs = new CompositeDisposable();
    this.agentSubs.set(agent, agentSubs);
    // A running agent reports as modified, so it's consulted before exit. Tracked on the
    // agent's subscription bag (not a tab), torn down with the rest in closeAgent.
    agentSubs.add(zym.session.registerParticipant(agent));
    agentSubs.add(new Disposable(agent.onTitleChange(() => {
      if (this.activeAgent === agent) this.d.agentSidebar.setTitle(agent.title);
    })));
    // Notify when the agent needs attention while the user isn't looking at it.
    let previousStatus = agent.status;
    agentSubs.add(new Disposable(agent.onDidChangeStatus(() => {
      this.notifyAgentAttention(agent, previousStatus, agent.status);
      previousStatus = agent.status;
      // On settle, flag a worktree it created but never announced (validator).
      if (agent.status === 'idle') this.warnUnannouncedWorktree(agent);
    })));
    // The agent announced (via the set_worktree bridge tool) that it moved into `cwd` —
    // re-root its workbench to match (workbench.cwd becomes the editor root).
    agentSubs.add(new Disposable(agent.onDidChangeWorktree((cwd) => {
      this.d.workbenchManager.reRootWorkbench(workbench, cwd);
      // Persist the worktree as a sidecar under the spawn dir's transcript dir so a later
      // resume can re-root to it.
      if (agent.sessionId) recordSessionWorktree(mainRoot, agent.sessionId, cwd);
    })));
    // When the agent edits files, re-check git now instead of waiting for the poll, so its
    // changes surface in Source Control promptly, and (when enabled) auto-open each newly-
    // edited file. Seed from the current list so resuming doesn't flood-open its history.
    const seenFiles = new Set<string>(agent.changedFiles);
    agentSubs.add(new Disposable(agent.onDidChangeFiles(() => {
      workbench.git.refresh(); // the agent's own workbench root, not the active one
      const autoOpen = zym.config.get('agent.autoOpenChangedFiles') === true;
      for (const path of agent.changedFiles) {
        if (seenFiles.has(path)) continue;
        seenFiles.add(path);
        if (autoOpen) this.autoOpenChangedFile(agent, path);
      }
    })));
    // Track the last-focused agent (the default target for send-to-agent).
    const focus = new Gtk.EventControllerFocus();
    focus.on('enter', () => { this.lastAgent = agent; });
    agentSubs.addController(agent.root, focus); // severed in closeAgent; `enter` captures the agent (rule 9)
    agent.start(); // terminal: no-op (already spawned); headless: spawn claude now
    if (!options.background) agent.focus(); // the workbench is already active (above); focus the agent
    return agent;
  }

  // The agent that send-to-agent targets: the active one, else the last focused,
  // else any still-running agent (skipping exited ones).
  private targetAgent(): Agent | null {
    for (const agent of [this.activeAgent, this.lastAgent]) {
      if (agent && !agent.exited) return agent;
    }
    return zym.agents.getAgents().find((agent) => !agent.exited) ?? null;
  }

  // The editor context the send-to-agent commands push: the current selection, or
  // the active file's path (cwd-relative, trailing space). Empty when unavailable.
  private editorSelectionText(): string {
    return this.d.paneItems.activeEditor?.getSelectedText() ?? '';
  }
  private editorFileText(): string {
    const file = this.d.paneItems.activeEditor?.currentFile;
    return file ? `${Path.relative(this.workbench.cwd, file)} ` : '';
  }

  // Feed `text` into `agent`'s prompt. With `submit`, send it as a turn immediately.
  // `reveal` (default true) shows + focuses the agent.
  private deliverToAgent(agent: Agent, text: string, options?: { submit?: boolean; reveal?: boolean }): void {
    const reveal = options?.reveal !== false;
    agent.deliver(text, { submit: options?.submit, focus: reveal });
    if (reveal) this.showAgent(agent);
  }

  // Send to the current agent (active → last-focused → any running).
  private sendToAgent(text: string, options?: { submit?: boolean; reveal?: boolean }): void {
    if (!text) return;
    const agent = this.targetAgent();
    if (!agent) {
      zym.notifications.addWarning('No running agent to send to');
      return;
    }
    this.deliverToAgent(agent, text, options);
  }

  // Deliver a diff review (one comment, or an accumulated batch) to an agent — the sink every
  // diff surface's `onSend` routes through. Sends it as a turn and REVEALS the agent so the
  // review visibly lands and the agent starts working on it. With no agent running, the picker
  // chooses one — or starts a fresh agent with the review as its first turn.
  reviewToAgent(message: string): void {
    if (!message) return;
    const agent = this.targetAgent();
    if (agent) {
      this.deliverToAgent(agent, message, { submit: true });
      return;
    }
    openAgentPicker(this.host(), {
      placeholder: 'Send review to agent…',
      agentWorktree: (agent) => this.agentWorktree(agent),
      onActivate: (agent) => this.deliverToAgent(agent, message, { submit: true }),
      // A highlighted, always-present "Send to new agent" entry → the launcher (pick model /
      // permission / worktree), then deliver the review to the agent it starts.
      newAgent: { label: 'Send to new agent', run: () => this.launchAgentForReview(message) },
    });
  }

  // The "Send to new agent" review path: open the launcher with the review PRE-FILLED as the
  // prompt, so it's the agent's FIRST turn (the launch prompt is the spawn argument, reliably
  // delivered) rather than a racing post-launch turn.
  private launchAgentForReview(message: string): void {
    openAgentLauncher(this.host(), {
      cwd: this.workbench.cwd,
      defaultKind: resolveAgentKind(zym.config.get('agent.implementation')),
      initialWorktree: 'current', // a review runs against the working tree by default
      initialPrompt: message, // the review is the prompt → delivered as the agent's first turn
      onLaunch: ({ prompt, command, cwd, kind, worktree, background, model, permissionMode }) => {
        const { agentPrompt, userPrompt } = launchPrompt(prompt, worktree);
        this.openAgent({ prompt: agentPrompt, userPrompt, command, root: cwd, kind, background, model, permissionMode });
      },
    });
  }

  // Send to an agent chosen from the picker (or a freshly started one).
  private pickAgentAndSend(text: string): void {
    if (!text) return;
    openAgentPicker(this.host(), {
      placeholder: 'Send to agent…',
      agentWorktree: (agent) => this.agentWorktree(agent),
      onActivate: (agent) => this.deliverToAgent(agent, text),
      onStart: (prompt) => this.deliverToAgent(this.openAgent({ prompt }), text),
    });
  }

  // Compose a new agent's prompt: a list-less picker seeded with the editor context
  // (editable); submitting launches a NEW agent with that prompt.
  private composeNewAgent(seed: string): void {
    openPicker({
      host: this.host(),
      placeholder: 'Prompt for new agent…',
      query: seed,
      items: [],
      onSelect: () => {},
      action: {
        label: (prompt) => `Start agent: ${prompt}`,
        run: (prompt) => this.openAgent({ prompt }),
      },
    });
  }

  // The roots the resume picker scans: every worktree of this repo, **main worktree
  // first** — listResumableSessions treats roots[0] as the prefix anchor for also
  // recovering transcripts from worktrees that have since been removed. process.cwd()
  // is kept in case it isn't itself a worktree root (e.g. a subdir / non-repo run).
  private agentSessionRoots(): string[] {
    // Scan the active project's root + its worktrees — that's where agents launched in it
    // record their transcripts (mainRoot), so resumable conversations are discoverable there.
    const main = this.mainRoot();
    const roots = listWorktrees(main).map((wt) => wt.path);
    if (!roots.includes(main)) roots.push(main);
    return roots;
  }

  /** The directory an agent's process spawns in and its transcripts land under: the ACTIVE
   *  PROJECT's root (process.cwd() for the primary), fixed at launch, never a throw-away
   *  worktree. Resume + discovery use the same root so `--resume` resolves even for an agent
   *  launched in a non-primary project (its transcript isn't under process.cwd()). See
   *  docs/agents.md. */
  private mainRoot(): string {
    return this.d.workbenchManager.activeProjectRoot();
  }

  /** A live agent's editor root — its workbench cwd (the single source of truth for
   *  where the agent's editor is rooted), falling back to the main dir if it has no
   *  workbench. Replaces the former `agent.effectiveCwd`. */
  private agentRoot(agent: Agent): string {
    return this.d.workbenchManager.cwdOf(agent) ?? this.mainRoot();
  }

  /** A live agent's worktree (the branch badge in the pickers), from its workbench cwd
   *  — replaces the former `agent.worktree`. Null when it has no workbench yet. */
  private agentWorktree(agent: Agent): WorktreeInfo | null {
    const cwd = this.d.workbenchManager.cwdOf(agent);
    return cwd ? worktreeInfo(cwd) : null;
  }

  // `openAgent` options to resume `session`. The process spawns in the main dir (the cwd
  // invariant), so we only ensure the transcript is resolvable there. The editor re-roots to
  // the worktree the session worked in by passing it as `root`, so a resume restores the
  // worktree silently. A removed worktree resumes in the main dir.
  private resumeOptions(session: AgentSession): { root?: string; resume: AgentResume; title: string } {
    const mainRoot = this.mainRoot();
    relocateTranscriptToMainRoot(session, mainRoot); // so `--resume <id>` resolves under the main dir
    const wt = session.effectiveCwd ?? session.cwd;
    const worktree = wt && wt !== mainRoot && Fs.existsSync(wt) ? wt : undefined;
    return {
      root: worktree,
      resume: { sessionId: session.id },
      title: truncate(session.label, 40),
    };
  }


  // Relaunch an agent workbench from its saved workspace, resumed to its conversation/
  // worktree. A session that's since vanished falls back to a bare resume; an agent that
  // never reported a session id is relaunched fresh with its original prompt. Returns the
  // relaunched agent (or null when skipped) so the caller can re-focus the saved workbench.
  restoreAgent(state: AgentState): Agent | null {
    const a = state.agent;
    // Don't duplicate an agent that's already open (explicit restore over a live session).
    if (a.sessionId && zym.agents.getAgents().some((ag) => ag.sessionId === a.sessionId)) return null;
    // Restore as the kind that was saved. Older sessions have no tag, and states
    // saved by the retired `claude-sdk` kind map to claude-tui — their session ids
    // are claude's, so the terminal agent resumes them with --resume.
    const kind: AgentKind = a.agentKind === 'acp' ? 'acp' : 'claude-tui';
    let agent: Agent;
    if (kind === 'acp') {
      // An acp agent restores with its *saved* argv (a gemini session must not
      // reopen into whatever `agent.acp.command` says now); resume goes over
      // session/load inside AcpSession, not the claude transcript store.
      agent = this.openAgent({
        kind,
        root: state.root,
        command: a.command,
        prompt: a.sessionId ? undefined : a.prompt,
        resume: a.sessionId ? { sessionId: a.sessionId } : undefined,
      });
    } else if (a.sessionId) {
      const session = listResumableSessions(this.agentSessionRoots()).find((s) => s.id === a.sessionId);
      // The saved workbench cwd (`state.root`) is authoritative for where the editor roots —
      // `resumeOptions` still relocates the transcript + supplies the resume id + title, but
      // its transcript-derived root is overridden by the recorded one.
      agent = session
        ? this.openAgent({ ...this.resumeOptions(session), root: state.root, kind })
        : this.openAgent({ kind, root: state.root, resume: { sessionId: a.sessionId } });
    } else {
      agent = this.openAgent({ kind, root: state.root, prompt: a.prompt });
    }
    // Reopen the files that were in this agent's work area. The agent leaf itself is
    // recreated by openAgent; the work-area split geometry isn't preserved.
    const workbench = this.d.workbenchManager.workbenches.get(agent);
    if (workbench) {
      // Restore the workbench's live action set (a resuming agent may re-report and
      // overwrite it on its next set_actions — the intended precedence).
      if (state.workbench.actions) workbench.actions.restore(state.workbench.actions);
      const panel = workbench.center.openPanel;
      for (const tab of fileTabsOf(state.workbench.layout)) {
        if (Fs.existsSync(tab.path)) {
          this.d.paneItems.openFileIn(tab.path, panel, { focus: false, owner: workbench });
        }
      }
    }
    return agent;
  }

  // Resume a past conversation: pick one of the project's saved sessions (newest first,
  // excluding any currently live) and reopen it as `claude --resume <id>`.
  private resumeAgentPicker(): void {
    const live = new Set(zym.agents.getAgents().map((a) => a.sessionId).filter(Boolean));
    const sessions = listResumableSessions(this.agentSessionRoots()).filter((s) => !live.has(s.id));
    if (sessions.length === 0) {
      zym.notifications.addInfo('No past conversations to resume');
      return;
    }
    const byId = new Map(sessions.map((s) => [s.id, s]));
    openPicker({
      host: this.host(),
      placeholder: 'Resume conversation…',
      proseEntry: true, // the query is prose, not a path/identifier
      // Match against the bare label; render it markdown-style with the time muted in the
      // right-aligned detail column. Untitled sessions are dimmed to set the named ones apart.
      items: sessions.map((s) => ({ value: s.id, text: s.label })),
      renderRow: (item, positions) => {
        const session = byId.get(item.value);
        // "ran elsewhere" is relative to the active project's root (where its agents spawn),
        // not process.cwd() — else every session in a non-primary active project reads as elsewhere.
        const ranElsewhere = session?.cwd && session.cwd !== this.mainRoot();
        const where = ranElsewhere ? `${escapeMarkup(Path.basename(session!.cwd!))} · ` : '';
        return renderRowSingleLine({
          main: proseMarkup(item.text, positions, !session?.titled),
          detail: `<span face="Sans" line_height="${PROSE_LINE_HEIGHT}">${where}${escapeMarkup(relativeTime(session?.modified ?? 0))}</span>`,
        });
      },
      onSelect: (id) => {
        const session = byId.get(id);
        if (session) this.openAgent(this.resumeOptions(session));
        else this.openAgent({ resume: { sessionId: id } });
      },
      // When the query matches no past conversation, offer to start a fresh agent with the
      // typed text as its prompt instead.
      action: {
        label: (query) => `Start agent: ${query}`,
        run: (query) => this.openAgent({ prompt: query }),
      },
      actionWhenEmpty: true,
    });
  }

  // The sidebar selection follows the active workbench's owner (which person you're
  // viewing), not focus.
  updateAgentHighlight(): void {
    this.d.sidebar.list.selectOwner(this.workbench.owner);
  }

  // Tell each agent whether the user is currently looking at it — only the agent whose
  // workbench is active counts as viewed. Viewing acknowledges its status, clearing the
  // sidebar attention blink; switching away from a still-`waiting` agent lets it blink again.
  updateViewedAgent(): void {
    const viewed = this.activeAgent;
    if (viewed === this.viewedAgent) return;
    this.viewedAgent?.setViewed(false);
    this.viewedAgent = viewed;
    viewed?.setViewed(true);
  }

  /** Reveal the agent `delta` steps from the active one (wraps; first if none). */
  private focusAdjacentAgent(delta: number): void {
    const agents = zym.agents.getAgents();
    if (agents.length === 0) return;
    const index = this.activeAgent ? agents.indexOf(this.activeAgent) : -1;
    const next = agents[(((index + delta) % agents.length) + agents.length) % agents.length];
    if (next) this.showAgent(next);
  }

  // Surface an attention-worthy status change as a notification — but only when the user
  // isn't already watching that agent. Clicking the notification reveals the agent.
  private notifyAgentAttention(agent: Agent, previous: AgentStatus, current: AgentStatus): void {
    if (this.activeAgent === agent) return; // already on this agent's workbench — its widget is on screen
    const reveal = () => this.showAgent(agent);
    if (current === 'waiting') {
      zym.notifications.addWarning(`${agent.title} needs your input`, { onDidClick: reveal });
    } else if (current === 'idle' && previous === 'working') {
      zym.notifications.addTrace(`${agent.title} finished`, { onDidClick: reveal });
    }
  }

  // The agent a lifecycle command acts on: the active one, else the last focused.
  private currentAgent(): Agent | null {
    return this.activeAgent ?? this.lastAgent;
  }

  private restartCurrentAgent(): void {
    const agent = this.currentAgent();
    if (agent) this.restartAgent(agent);
  }

  // Resume a stopped agent in its existing pane (vs restart, which retires the old widget
  // and opens a fresh one). Reveals the agent so its revived terminal is in view.
  private resumeCurrentAgent(): void {
    const agent = this.currentAgent();
    if (!agent || !agent.exited) return;
    // The terminal agent revives its child in the same pane. The headless agent's session is
    // wired into views built at construction, so it can't hot-swap a fresh process in place —
    // restart it (a new widget that rebuilds the transcript from disk and resumes by id).
    if (agent instanceof AgentConversation) { this.restartAgent(agent); return; }
    agent.resume();
    this.showAgent(agent);
  }

  private closeCurrentAgent(): void {
    const agent = this.currentAgent();
    if (agent) this.closeAgent(agent);
  }

  // Branch the current agent: open a NEW agent/workbench whose claude session is forked off
  // the current agent's conversation. The fork is a transcript copy, so the original keeps
  // running. Requires a claude agent that has reported its session id.
  private branchCurrentAgent(): void {
    const agent = this.currentAgent();
    if (!agent) return;
    const kind = agentKindOf(agent);
    const sessionId = agent.sessionId;
    if (!sessionId) {
      zym.notifications.addWarning('No conversation to branch yet');
      return;
    }
    // Branch into the same kind as the source agent, its editor rooted at the same
    // worktree (acp: session/fork — an agent without the capability reports an error).
    this.openAgent({
      kind,
      root: this.agentRoot(agent),
      resume: { sessionId, fork: true },
      title: `${agent.title} (branch)`,
      command: agentCommandOf(agent),
    });
  }

  private renameCurrentAgent(): void {
    const agent = this.currentAgent();
    if (agent) this.renameAgentPrompt(agent);
  }

  private openChangesOfCurrentAgent(): void {
    const agent = this.currentAgent();
    if (agent) this.openAgentChanges(agent);
  }

  // Review what an agent changed this session: an "Agent Changes" tab in its work
  // area — one continuous, EDITABLE multi-file diff (first-touch baseline →
  // current buffer/disk), with review comments delivered straight back to that
  // agent. Reopening (the pencil button again) refreshes in place. Jumping to a
  // real file tab is Enter/double-click on any diff row.
  openAgentChanges(agent: Agent): void {
    const files = agent.changedFiles;
    if (files.length === 0) {
      zym.notifications.addInfo(`${agent.title} hasn't edited any files yet`);
      return;
    }
    this.showAgent(agent); // the active workbench is now the agent's
    void this.openAgentChangesDiff(agent, files);
  }

  private async openAgentChangesDiff(agent: Agent, paths: string[]): Promise<void> {
    const root = this.agentRoot(agent);
    const diffFiles = (await Promise.all(paths.map((path) => this.agentDiffFile(agent, root, path))))
      .filter((file): file is DiffFile => file !== null);
    if (diffFiles.length === 0) {
      zym.notifications.addInfo(`${agent.title}'s edited files match their baselines — nothing to review`);
      return;
    }
    const view = new DiffView({
      files: diffFiles,
      cwd: root,
      editable: true, // fix up the agent's work in place — saves write through, the diff re-flows
      documents: this.d.paneItems.documents,
      onActivate: ({ path, row }) => zym.workspace.openFile(path, { cursor: [row, 0] }),
      // Comments go straight to THIS agent, not the current-agent/picker routing.
      onSend: (message) => this.deliverToAgent(agent, message, { submit: true }),
      reviewContext: `Review of ${agent.title}'s changes (this session)`,
    });
    // Unsent review comments are consulted on window close, like the git diffs.
    const participant = zym.session.registerParticipant(view);
    this.changesTabs.get(agent)?.close(); // refresh-in-place: drop the stale panel first
    const child = this.d.paneItems.openCenterTab(view.root, {
      title: `${Icons.pencil}  Changes — ${agent.title}`,
      requireTabBar: true,
      onClose: () => { participant.dispose(); view.dispose(); },
    });
    this.changesTabs.set(agent, child);
    view.focus();
  }

  // One review DiffFile: OLD = the agent's first-touch baseline (acp; see
  // AcpSession.captureBaseline), else the git HEAD blob (claude-tui, resumed
  // sessions), else empty (not a repo / created). NEW = the live buffer when
  // open, else disk. Null when the sides match — nothing to review there.
  private async agentDiffFile(agent: Agent, root: string, path: string): Promise<DiffFile | null> {
    const baseline = agent.baselineFor?.(path);
    let oldText: string;
    if (baseline !== undefined) {
      oldText = baseline ?? ''; // null = the agent created the file
    } else {
      const repo = repoRoot(root);
      oldText = repo
        ? await new Promise<string>((resolve) =>
            readFileAtRef(repo, 'HEAD', Path.relative(repo, path), (text) => resolve(text ?? '')))
        : '';
    }
    const current = this.readCurrent(path);
    const newText = current ?? '';
    if (oldText === newText) return null;
    return { path, oldText, newText, deleted: current === null && oldText !== '' };
  }

  /** A file's current text through the editor's lens: the live buffer when open
   *  (unsaved edits included), else disk; null when it doesn't exist. */
  private readCurrent(path: string): string | null {
    const doc = this.d.paneItems.documents.find(path);
    if (doc?.isLoaded) return doc.getText();
    try { return Fs.readFileSync(path, 'utf8'); } catch { return null; }
  }

  // Auto-open a file the agent just edited in *its own* workbench's work area, without
  // switching to that workbench. Mirrors openAgentChanges but never steals focus.
  private autoOpenChangedFile(agent: Agent, path: string): void {
    const workbench = this.d.workbenchManager.workbenches.get(agent);
    if (!workbench) return;
    if (this.d.paneItems.editorForPath(path)) return;
    // openPanel splits the agent panel to the right on the first file, then reuses that work
    // area for the rest. Pass the agent's workbench as owner so the gutter uses *its* git.
    const panel = workbench.center.openPanel;
    // select: only the first file reveals itself — it fills the freshly-created (empty) work
    // area. Every later edit opens quietly as a background tab, so the agent's edits never
    // pull the view off whatever the user is looking at.
    const select = panel.tabCount === 0;
    this.d.paneItems.openFileIn(path, panel, { focus: false, owner: workbench, select });
  }

  // Restart an agent: retire the old one and relaunch in place, resuming its
  // conversation (forking a still-live session so the original transcript isn't
  // clobbered — claude via --fork-session, acp via session/fork).
  restartAgent(agent: Agent): void {
    const kind = agentKindOf(agent);
    const title = agent.renamed ? agent.title : undefined;
    const resume = agent.sessionId ? { sessionId: agent.sessionId, fork: !agent.exited } : undefined;
    const root = this.agentRoot(agent);
    const command = agentCommandOf(agent);
    this.closeAgent(agent);
    this.openAgent({ kind, resume, title, root, command });
  }

  // Close an agent for good: SIGTERM a live child, drop its workbench (falling back to
  // its rail neighbor if it was active), and retire it from the registry.
  closeAgent(agent: Agent): void {
    if (!agent.exited) agent.kill();
    const workbench = this.d.workbenchManager.workbenches.get(agent);
    // Drop this workbench's action terminals (set_actions tabs in its center); disposeChild
    // won't reach them (they're terminals, not editors).
    if (workbench) this.d.paneItems.disposeWorkbenchActionTerminals(workbench);
    if (this.workbench.owner === agent) {
      // Swap away first — to the owner just before this one in the rail (never the start).
      const fallback = this.d.workbenchManager.fallbackOwner(agent) ?? this.d.workbenchManager.primaryProject;
      this.d.workbenchManager.activateOwner(fallback);
    }
    this.d.workbenchManager.workbenches.delete(agent); // its workbench (center + Files/Git + bottom + tabs) goes
    if (workbench) {
      // Tear down the editors that lived in this workbench — closing it drops their widgets
      // but not their bookkeeping (gutter git sub, LSP doc ref, session participant, owner entry).
      this.d.paneItems.disposeWorkbenchEditors(workbench);
      workbench.dispose(); // tears down every widget it owns + releases its pooled git repo
    }
    this.agentSubs.get(agent)?.dispose(); // title/status/worktree/files subs + the session participant
    this.agentSubs.delete(agent);
    this.d.agentSidebar.removeAgent(agent.root); // drop its page from the secondary-sidebar stack
    this.d.paneItems.disposeAgentWidget(agent); // sever the Vte focus controller / kill the headless child
    // Drop the last-focused pointer if it named this agent — otherwise currentAgent() would
    // resolve a retired, disposed agent. With it cleared, the commands' `when` guards disable.
    if (this.lastAgent === agent) this.lastAgent = null;
    zym.agents.remove(agent);
  }

  /** Close every open agent — the replace-semantics teardown `session:open` runs
   *  before applying a different session. Snapshots first (`closeAgent` mutates the
   *  registry) so the iteration isn't disturbed mid-loop. */
  closeAllAgents(): void {
    for (const agent of [...zym.agents.getAgents()]) this.closeAgent(agent);
  }

  // Prompt for a new display name (pinned over the CLI's reported title).
  renameAgentPrompt(agent: Agent): void {
    openPicker({
      host: this.host(),
      placeholder: 'Rename agent…',
      proseEntry: true,
      query: agent.title,
      items: [],
      onSelect: () => {},
      action: {
        label: (name) => `Rename to: ${name}`,
        run: (name) => agent.rename(name),
      },
    });
  }

  // The cooperative-detection safety net: if an agent created a worktree (spotted by the
  // Bash validator) but never announced it via set_worktree, warn once when it next settles.
  private warnUnannouncedWorktree(agent: Agent): void {
    const path = agent.unannouncedWorktree;
    if (!path) return;
    agent.clearUnannouncedWorktree();
    zym.notifications.addWarning(`${agent.title} switched worktree without telling the editor`, {
      detail:
        `It created a worktree (${path}) but didn't call the set_worktree tool, so its file tree ` +
        'and Source Control still point at the old root.',
    });
  }

  /** Show `agent`: activate its workbench (its widget lives in the agent sidebar). */
  showAgent(agent: Agent): void {
    this.d.workbenchManager.activateOwner(agent);
  }

  /** Drain every agent's subscription bag (window teardown). */
  dispose(): void {
    for (const subs of this.agentSubs.values()) subs.dispose();
    this.agentSubs.clear();
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The kind an agent was launched as: the conversation host is the `acp` kind;
 *  the terminal host is always `claude-tui`. */
function agentKindOf(agent: Agent): AgentKind {
  return agent instanceof AgentConversation ? agent.agentKind : 'claude-tui';
}

/** The argv an acp agent runs (from its serialized state), so restart/branch
 *  reuse the exact agent; undefined for the claude kinds (config default). */
function agentCommandOf(agent: Agent): string[] | undefined {
  if (agentKindOf(agent) !== 'acp') return undefined;
  const saved = agent.serialize();
  return saved?.kind === 'agent' ? saved.command : undefined;
}
