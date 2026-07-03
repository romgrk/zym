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
import { listResumableSessions, recordSessionWorktree, relativeTime, relocateTranscriptToMainRoot, type AgentSession } from '../agentSessions.ts';
import { type WorkspaceState, fileTabsOf } from '../SessionManager.ts';
import type { TextEditor } from './TextEditor/index.ts';
import type { Workbench } from './workbench/Workbench.ts';
import { type Owner, isProject, isAgent } from './workbench/Owner.ts';
import type { PaneItems } from './workbench/PaneItems.ts';
import type { WorkbenchManager } from './workbench/WorkbenchManager.ts';
import type { AgentSidebar } from './AgentSidebar.ts';
import type { Sidebar } from './Sidebar.ts';
import { openAgentPicker } from './AgentPicker.ts';
import { openAgentLauncher, launchPrompt, type LauncherMode } from './AgentLauncher.ts';
import { openPicker } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { proseMarkup, escapeMarkup, PROSE_LINE_HEIGHT } from './proseMarkup.ts';
import { listWorktrees } from '../git.ts';
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
      onLaunch: ({ prompt, command, cwd, kind, worktree, background }) => {
        const { agentPrompt, userPrompt } = launchPrompt(prompt, worktree);
        this.openAgent({ prompt: agentPrompt, userPrompt, command, root: cwd, kind, background });
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
      'agent:open-changes': { didDispatch: () => this.openChangesOfCurrentAgent(), description: "Open the agent's edited files", when: () => this.currentAgent() !== null },
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
    options: { kind?: AgentKind; prompt?: string; userPrompt?: string; resume?: AgentResume; title?: string; root?: string; command?: string[]; background?: boolean } = {},
  ): Agent {
    // Both kinds can resume now (claude-sdk rebuilds its transcript from disk), so a
    // resume no longer forces the terminal agent — it respects the configured kind
    // unless a caller pins one (e.g. restoreAgent passes the saved agent's kind).
    const kind = options.kind ?? resolveAgentKind(zym.config.get('agent.implementation'));
    // Invariant: the agent *process* always spawns in the editor's main dir, never a
    // worktree — its OS cwd then can't sit inside a worktree that gets removed (which
    // crashes the agent), and every transcript lands under one project dir so
    // `--resume` always resolves. A worktree is an editor concern only: `root` re-roots
    // the workbench (Files/Git/gutters) and seeds the agent's effectiveCwd. See docs/agents.md.
    const mainRoot = this.mainRoot();
    let root = options.root ?? mainRoot;
    if (root !== mainRoot && !Fs.existsSync(root)) root = mainRoot; // a vanished worktree → main dir
    const agent = AGENT_CONFIGS[kind].create({
      cwd: mainRoot, worktree: root, command: options.command, prompt: options.prompt, userPrompt: options.userPrompt, resume: options.resume, title: options.title,
      onOpenFile: (path) => this.d.paneItems.openFile(path),
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
    // The agent announced (via the set_worktree bridge tool) that it moved into a
    // different worktree — re-root its workbench to match.
    agentSubs.add(new Disposable(agent.onDidChangeWorktree(() => {
      this.d.workbenchManager.reRootWorkbench(workbench, agent.effectiveCwd);
      // Persist the worktree as a sidecar under the spawn dir's transcript dir so a later
      // resume can re-root to it.
      if (agent.sessionId) recordSessionWorktree(mainRoot, agent.sessionId, agent.effectiveCwd);
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
      onLaunch: ({ prompt, command, cwd, kind, worktree, background }) => {
        const { agentPrompt, userPrompt } = launchPrompt(prompt, worktree);
        this.openAgent({ prompt: agentPrompt, userPrompt, command, root: cwd, kind, background });
      },
    });
  }

  // Send to an agent chosen from the picker (or a freshly started one).
  private pickAgentAndSend(text: string): void {
    if (!text) return;
    openAgentPicker(this.host(), {
      placeholder: 'Send to agent…',
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
    const roots = listWorktrees(process.cwd()).map((wt) => wt.path);
    if (roots.length === 0) roots.push(process.cwd());
    if (!roots.includes(process.cwd())) roots.push(process.cwd());
    return roots;
  }

  /** The directory every agent process spawns in: the editor's own root (`process.cwd()`),
   *  fixed for the process's life and never a throw-away worktree. See docs/agents.md. */
  private mainRoot(): string {
    return process.cwd();
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

  // One WorkspaceState per open agent workbench (its root + center layout + the agent's
  // relaunch identity), for the session. The layout is recorded for forward-compat;
  // restore currently only relaunches the agent (see restoreAgent).
  serializeAgentWorkspaces(): WorkspaceState[] {
    const out: WorkspaceState[] = [];
    for (const agent of zym.agents.getAgents()) {
      const workbench = this.d.workbenchManager.workbenches.get(agent);
      const state = agent.serialize();
      if (!workbench || !state || state.kind !== 'agent') continue;
      out.push({
        root: workbench.cwd,
        layout: workbench.center.serializeLayout((w) => this.d.paneItems.serializeChild(w)),
        fileTree: { expanded: workbench.fileTree.serializeExpanded() },
        actions: workbench.actions.serialize(),
        agent: state,
      });
    }
    return out;
  }

  // The index, into the serialized workspaces, of the workbench that currently has focus:
  // 0 for the user, else the active agent's position among the serialized agent workspaces.
  activeWorkspaceIndex(): number {
    if (isProject(this.workbench.owner)) return 0;
    let i = 1;
    for (const agent of zym.agents.getAgents()) {
      const workbench = this.d.workbenchManager.workbenches.get(agent);
      const state = agent.serialize();
      if (!workbench || !state || state.kind !== 'agent') continue;
      if (agent === this.workbench.owner) return i;
      i++;
    }
    return 0;
  }

  // Relaunch an agent workbench from its saved workspace, resumed to its conversation/
  // worktree. A session that's since vanished falls back to a bare resume; an agent that
  // never reported a session id is relaunched fresh with its original prompt. Returns the
  // relaunched agent (or null when skipped) so the caller can re-focus the saved workbench.
  restoreAgent(ws: WorkspaceState): Agent | null {
    const a = ws.agent;
    if (!a) return null;
    // Don't duplicate an agent that's already open (explicit restore over a live session).
    if (a.sessionId && zym.agents.getAgents().some((ag) => ag.sessionId === a.sessionId)) return null;
    // Restore as the kind that was saved (older sessions have no tag → claude-tui).
    const kind: AgentKind = a.agentKind ?? 'claude-tui';
    let agent: Agent;
    if (a.sessionId) {
      const session = listResumableSessions(this.agentSessionRoots()).find((s) => s.id === a.sessionId);
      // The saved workbench cwd (`ws.root`) is authoritative for where the editor roots —
      // `resumeOptions` still relocates the transcript + supplies the resume id + title, but
      // its transcript-derived root is overridden by the recorded one.
      agent = session
        ? this.openAgent({ ...this.resumeOptions(session), root: ws.root, kind })
        : this.openAgent({ kind, root: ws.root, resume: { sessionId: a.sessionId } });
    } else {
      agent = this.openAgent({ kind, root: ws.root, prompt: a.prompt });
    }
    // Reopen the files that were in this agent's work area. The agent leaf itself is
    // recreated by openAgent; the work-area split geometry isn't preserved.
    const workbench = this.d.workbenchManager.workbenches.get(agent);
    if (workbench) {
      // Restore the workbench's live action set (a resuming agent may re-report and
      // overwrite it on its next set_actions — the intended precedence).
      if (ws.actions) workbench.actions.restore(ws.actions);
      const panel = workbench.center.openPanel;
      for (const tab of fileTabsOf(ws.layout)) {
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
        const ranElsewhere = session?.cwd && session.cwd !== process.cwd();
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
    const sessionId = agent.sessionId;
    if (!sessionId) {
      zym.notifications.addWarning('No conversation to branch yet');
      return;
    }
    // Branch into the same kind as the source agent, its editor rooted at the same worktree.
    this.openAgent({
      kind: agent instanceof AgentConversation ? 'claude-sdk' : 'claude-tui',
      root: agent.effectiveCwd,
      resume: { sessionId, fork: true },
      title: `${agent.title} (branch)`,
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

  // Review the files an agent has edited this session: switch to its workbench and open
  // every edited file as a tab in the work area split beside the agent panel.
  openAgentChanges(agent: Agent): void {
    const files = agent.changedFiles;
    if (files.length === 0) {
      zym.notifications.addInfo(`${agent.title} hasn't edited any files yet`);
      return;
    }
    this.showAgent(agent); // the active workbench is now the agent's
    const panel = this.workbench.center.openPanel; // the work area (split right of the agent)
    // Open without focusing each in turn, then reveal the first one that landed in the work
    // area. A file already open elsewhere is revealed in place — skip it when choosing focus.
    let firstInPane: TextEditor | null = null;
    for (const path of files) {
      const editor = this.d.paneItems.openFileIn(path, panel, { focus: false });
      if (!firstInPane && panel.getChildren().includes(editor.root)) firstInPane = editor;
    }
    if (firstInPane) {
      this.d.paneItems.editorChildFor(firstInPane.root)?.select();
      firstInPane.focus();
    }
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

  // Restart an agent: retire the old one and relaunch in place, resuming its claude
  // conversation (forking a still-live session so the original transcript isn't clobbered).
  restartAgent(agent: Agent): void {
    const kind: AgentKind = agent instanceof AgentConversation ? 'claude-sdk' : 'claude-tui';
    const title = agent.renamed ? agent.title : undefined;
    // Both kinds resume by session id now; fork a copy if the agent is still live so the
    // original keeps running. The editor re-roots to its (possibly moved) worktree.
    const resume = agent.sessionId ? { sessionId: agent.sessionId, fork: !agent.exited } : undefined;
    const root = agent.effectiveCwd;
    this.closeAgent(agent);
    this.openAgent({ kind, resume, title, root });
  }

  // Close an agent for good: SIGTERM a live child, drop its workbench (returning to the
  // user's workbench if it was active), and retire it from the registry.
  closeAgent(agent: Agent): void {
    if (!agent.exited) agent.kill();
    const workbench = this.d.workbenchManager.workbenches.get(agent);
    // Drop this workbench's action terminals (set_actions tabs in its center); disposeChild
    // won't reach them (they're terminals, not editors).
    if (workbench) this.d.paneItems.disposeWorkbenchActionTerminals(workbench);
    if (this.workbench.owner === agent) this.d.workbenchManager.activateOwner(this.d.workbenchManager.primaryProject); // swap away first
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
