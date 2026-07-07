#!/usr/bin/env node
/*
 * POC: drive the REAL AgentConversation with a scripted, fake session so the whole
 * transcript (bubbles, streaming text/thinking, tool rows, Bash, a plan/Tasks panel,
 * Task subagents + a Monitor — surfaced as count buttons in the agent header bar, a
 * permission prompt that replaces the input, a question card, the footer's mode
 * dropdown + the "…" config-options overflow menu, the actions bar, the context
 * gauge, errors) can be iterated on WITHOUT spawning a real agent. The conversation
 * is wrapped in the real `AgentSidebar` so its header bar is exercised.
 *
 * Fidelity comes from reusing production code end-to-end: the entire UI stack
 * (AgentConversation, Transcript, ToolRow, cards, QuestionCard, SubagentView,
 * MonitorView, ModelMenu, the config-option comboboxes) is the real thing —
 * only the event SOURCE is faked. AgentConversation consumes a `ConversationSession`
 * (src/agents/session.ts) through its `createSession` seam; here a `FakeSession`
 * implements that surface and emits the same domain events a live `AcpSession`
 * would. So whatever we change in the conversation UI shows up here verbatim.
 *
 * Unlike the (deleted) SdkSession-era POC, permission/question responses come back
 * through the session's own `respondPermission` / `answerQuestion` calls — no file
 * watching. The scene is sequential (async/await) and BLOCKS at each
 * permission/question until you respond, branching the permission outcome on allow
 * vs deny, so the prompt-replacement UX can be exercised end to end at your own pace.
 *
 * After the scripted scene finishes you can keep typing: a submitted prompt gets a
 * short canned streamed reply, so the input / submit / interrupt / scroll-follow
 * behaviour is all live.
 *
 * Run:  pnpm poc:conversation
 */
import * as Path from 'node:path';
import GLib from 'gi:GLib-2.0';
import Gio from 'gi:Gio-2.0';
import Adw from 'gi:Adw-1';
import { installStyles } from '../styles.ts';
import { registerBundledFonts, fonts } from '../fonts.ts';
import { theme } from '../theme/theme.ts';
import { zym } from '../zym.ts';
import { Emitter, Disposable } from '../util/eventKit.ts';
import { AgentConversation } from '../ui/AgentConversation.ts';
import { AgentSidebar } from '../ui/AgentSidebar.ts';
import { WorkbenchActions } from '../ui/workbench/WorkbenchActions.ts';
import type {
  ConfigOption, ContextUsage, ConversationSession, MonitorInfo, PermissionDecision,
  PermissionRequest, QuestionRequest, SubagentInfo,
} from '../agents/session.ts';
import type { AgentMode, AgentStatus } from '../agents/types.ts';
import { registerBuiltinPlugins, plugins } from '../plugin/index.ts';
import { preloadGrammars } from '../syntax/grammar.ts';

const MODEL = 'claude-opus-4-8';
const CWD = process.cwd();
const SLASH_COMMANDS = ['/clear', '/compact', '/context', '/review'];

// --- the fake session: scripted scene on the launch turn, canned replies after -----
// Implements the tool-agnostic ConversationSession surface AgentConversation consumes,
// emitting domain events over an Emitter. The UI never knows it isn't a live AcpSession.
class FakeSession implements ConversationSession {
  private readonly emitter = new Emitter();
  private _status: AgentStatus = 'idle';
  private _permissionMode: AgentMode = 'default';
  private started = false;
  private replies = 0;

  // Mode + generic config-option state (drive the footer's mode dropdown and the new
  // "…" overflow menu respectively). Mutated by setModeById / setConfigOption.
  private currentModeId = 'default';
  private readonly modes = [
    { id: 'default', name: 'default' },
    { id: 'acceptEdits', name: 'acceptEdits' },
    { id: 'auto', name: 'auto' },
    { id: 'plan', name: 'plan' },
  ];
  private readonly configState: ConfigOption[] = [
    {
      id: 'model', name: 'Model', category: 'model', kind: 'select', current: 'opus',
      choices: [
        { value: 'opus', label: 'Opus 4.8' },
        { value: 'sonnet', label: 'Sonnet 5' },
        { value: 'haiku', label: 'Haiku 4.5' },
      ],
    },
    {
      id: 'effort', name: 'Reasoning effort', category: 'thought_level', kind: 'select', current: 'medium',
      choices: [
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high' },
      ],
    },
    { id: 'fast', name: 'Fast mode', category: 'model_config', kind: 'boolean', current: false },
  ];

  // Captured subagent / monitor state (read back by SubagentView / MonitorView).
  private readonly subagents = new Map<string, SubagentInfo>();
  private readonly monitors = new Map<string, MonitorInfo>();

  // Resolvers that unblock the scene when the user answers a permission / question.
  private permResolve: ((d: PermissionDecision) => void) | null = null;
  private questionResolve: ((a: Array<{ header: string; labels: string[]; notes?: string }>) => void) | null = null;

  get status(): AgentStatus { return this._status; }
  get permissionMode(): AgentMode { return this._permissionMode; }
  get sessionId(): string | null { return 'poc-session'; }

  // --- required lifecycle -----------------------------------------------------
  start(): void {
    // The handshake result: model + slash commands. The onInit handler pulls
    // getModeState / getConfigOptions, so the mode dropdown and "…" menu populate here.
    this.emitter.emit('init', { model: MODEL, slashCommands: SLASH_COMMANDS });
  }

  prompt(text: string): void {
    this.emitter.emit('user-message', { text });
    this.setStatus('working');
    if (!this.started) { this.started = true; void this.playScene(); }
    else void this.cannedReply();
  }

  interrupt(): boolean {
    if (this._status !== 'working' && this._status !== 'waiting') return false;
    this.setStatus('idle');
    this.emitter.emit('interrupted', undefined);
    return true;
  }

  stop(): void { this.setStatus('disconnected'); }
  dispose(): void { /* nothing owned that outlives the process */ }

  setPermissionMode(mode: AgentMode): void { this.setModeById(mode); }

  respondPermission(_id: string, decision: PermissionDecision): void {
    const resolve = this.permResolve;
    this.permResolve = null;
    if (resolve) { this.setStatus('working'); resolve(decision); }
  }

  getSubagent(id: string): SubagentInfo | undefined { return this.subagents.get(id); }
  getMonitor(id: string): MonitorInfo | undefined { return this.monitors.get(id); }
  stopTask(taskId: string): void {
    for (const m of this.monitors.values()) {
      if (m.taskId === taskId) { m.status = 'killed'; this.emitter.emit('monitor-update', { id: m.id }); }
    }
  }

  // --- optional capabilities --------------------------------------------------
  answerQuestion(_id: string, answers: Array<{ header: string; labels: string[]; notes?: string }>): void {
    const resolve = this.questionResolve;
    this.questionResolve = null;
    if (resolve) { this.setStatus('working'); resolve(answers); }
  }

  getModeState(): { currentId: string; modes: Array<{ id: string; name: string }> } {
    return { currentId: this.currentModeId, modes: this.modes };
  }
  setModeById(id: string): void {
    this.currentModeId = id;
    this._permissionMode = id as AgentMode;
    this.emitter.emit('mode', undefined);
  }

  getConfigOptions(): ConfigOption[] { return this.configState; }
  setConfigOption(id: string, value: string | boolean): void {
    const option = this.configState.find((o) => o.id === id);
    if (option) option.current = value;
    console.log('[POC] setConfigOption', id, '→', value);
    this.emitter.emit('config-options', undefined);
  }

  // --- event registration (own both sides, so the names are internal) ---------
  private on2<T>(name: string, cb: (m: T) => void): Disposable {
    return this.emitter.on(name, (v?: unknown) => cb(v as T));
  }
  onStatus(cb: () => void): Disposable { return this.on2('status', () => cb()); }
  onMode(cb: () => void): Disposable { return this.on2('mode', () => cb()); }
  onUserMessage(cb: (m: { text: string }) => void): Disposable { return this.on2('user-message', cb); }
  onAssistantStart(cb: () => void): Disposable { return this.on2('assistant-start', () => cb()); }
  onAssistantText(cb: (m: { delta: string }) => void): Disposable { return this.on2('assistant-text', cb); }
  onAssistantThinking(cb: (m: { delta: string }) => void): Disposable { return this.on2('assistant-thinking', cb); }
  onToolUse(cb: (m: { id: string; name: string; input: unknown }) => void): Disposable { return this.on2('tool-use', cb); }
  onToolResult(cb: (m: { id: string; isError: boolean; text: string }) => void): Disposable { return this.on2('tool-result', cb); }
  onResult(cb: (m: { costUsd?: number; contextWindow?: number }) => void): Disposable { return this.on2('result', cb); }
  onContext(cb: (m: ContextUsage) => void): Disposable { return this.on2('context', cb); }
  onInit(cb: (m: { model: string; slashCommands: string[] }) => void): Disposable { return this.on2('init', cb); }
  onError(cb: (m: { message: string; detail?: string }) => void): Disposable { return this.on2('error', cb); }
  onInterrupted(cb: () => void): Disposable { return this.on2('interrupted', () => cb()); }
  onUnhandled(cb: (m: { event: unknown }) => void): Disposable { return this.on2('unhandled', cb); }
  onPermission(cb: (r: PermissionRequest) => void): Disposable { return this.on2('permission', cb); }
  onActions(cb: (m: { actions: import('../actions.ts').Action[] }) => void): Disposable { return this.on2('actions', cb); }
  onCwd(cb: (m: { cwd: string }) => void): Disposable { return this.on2('cwd', cb); }
  onExit(cb: (m: { code: number | null; stderr: string }) => void): Disposable { return this.on2('exit', cb); }
  onThinkingTokens(cb: (m: { tokens: number }) => void): Disposable { return this.on2('thinking-tokens', cb); }
  onTaskProgress(cb: (m: import('../agents/session.ts').TaskProgress) => void): Disposable { return this.on2('task-progress', cb); }
  onSubagentUpdate(cb: (m: { id: string }) => void): Disposable { return this.on2('subagent-update', cb); }
  onSubagentDone(cb: (m: { id: string }) => void): Disposable { return this.on2('subagent-done', cb); }
  onMonitorUpdate(cb: (m: { id: string }) => void): Disposable { return this.on2('monitor-update', cb); }
  onQuestion(cb: (r: QuestionRequest) => void): Disposable { return this.on2('question', cb); }
  onPlan(cb: (m: { entries: import('../agents/session.ts').PlanEntry[] }) => void): Disposable { return this.on2('plan', cb); }
  onTopic(cb: (m: { topic: string | null }) => void): Disposable { return this.on2('topic', cb); }
  onConfigOptions(cb: () => void): Disposable { return this.on2('config-options', () => cb()); }

  // --- scene machinery --------------------------------------------------------
  private setStatus(status: AgentStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emitter.emit('status', undefined);
  }

  private delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

  // Stream `text` out as deltas: each chunk is PRE-SCHEDULED on its own timer (so the
  // deltas fire at fixed offsets, not paced by per-chunk `await` — which under node-gtk
  // adds real per-timer latency); the promise resolves once the last chunk has fired.
  private streamWith(mk: (piece: string) => void, text: string, chunkWords: number, stepMs: number): Promise<void> {
    return new Promise((resolve) => {
      const words = text.match(/\S+\s*|\s+/g) ?? [text];
      let t = 0;
      for (let i = 0; i < words.length; i += chunkWords) {
        const piece = words.slice(i, i + chunkWords).join('');
        setTimeout(() => { try { mk(piece); } catch (e) { console.error('[scene]', e); } }, t);
        t += stepMs;
      }
      setTimeout(resolve, t);
    });
  }
  private stream(text: string, chunkWords = 6, stepMs = 24): Promise<void> {
    return this.streamWith((p) => this.emitter.emit('assistant-text', { delta: p }), text, chunkWords, stepMs);
  }
  private streamThinking(text: string, chunkWords = 8, stepMs = 20): Promise<void> {
    return this.streamWith((p) => this.emitter.emit('assistant-thinking', { delta: p }), text, chunkWords, stepMs);
  }

  private usage(tokens: number): ContextUsage {
    return {
      tokens,
      input: Math.round(tokens * 0.1),
      cacheRead: Math.round(tokens * 0.85),
      cacheCreation: Math.round(tokens * 0.05),
      output: 420,
    };
  }

  private toolUse(id: string, name: string, input: unknown): void { this.emitter.emit('tool-use', { id, name, input }); }
  private toolResult(id: string, isError: boolean, text: string): void { this.emitter.emit('tool-result', { id, isError, text }); }

  // Surface a permission request (the prompt-replacement UX under test) and BLOCK the
  // scene until the user answers; returns their decision so the scene shows an allow vs
  // deny outcome in the tool row's result.
  private askPermission(req: PermissionRequest): Promise<PermissionDecision> {
    this.setStatus('waiting');
    this.emitter.emit('permission', req);
    return new Promise((resolve) => { this.permResolve = resolve; });
  }
  private askQuestion(req: QuestionRequest): Promise<Array<{ header: string; labels: string[]; notes?: string }>> {
    this.setStatus('waiting');
    this.emitter.emit('question', req);
    return new Promise((resolve) => { this.questionResolve = resolve; });
  }

  private cannedReply(): void {
    const n = ++this.replies;
    let t = 200;
    const at = (fn: () => void) => setTimeout(fn, t);
    at(() => this.emitter.emit('assistant-text', { delta: 'Got it — ' }));
    t += 350; at(() => this.emitter.emit('assistant-text', { delta: 'this is a scripted POC reply, ' }));
    t += 350; at(() => this.emitter.emit('assistant-text', { delta: 'no real model is running. ' }));
    t += 350; at(() => this.emitter.emit('assistant-text', { delta: `(reply #${n})` }));
    t += 400; at(() => this.emitter.emit('context', this.usage(42000 + n * 1500)));
    t += 150; at(() => { this.emitter.emit('result', { costUsd: 0.03 * n, contextWindow: 200000 }); this.setStatus('idle'); });
  }

  private async playScene(): Promise<void> {
    const wait = (ms: number) => this.delay(ms);
    try {
      // Thinking: a live token counter, then a streamed reasoning block (needs
      // agent.showThinking, set true in boot).
      await wait(400);
      this.emitter.emit('thinking-tokens', { tokens: 120 }); await wait(250);
      this.emitter.emit('thinking-tokens', { tokens: 540 }); await wait(250);
      this.emitter.emit('thinking-tokens', { tokens: 1180 }); await wait(350);
      await this.streamThinking('Let me map the conversation UI first. The transcript is built in AgentConversation, with the tool rows and bubbles I want to inspect. I should exercise each row type so the styling is visible.');

      // Assistant intro (streamed) — tall enough to test scroll-follow.
      await wait(300);
      await this.stream("Here's a tour of the transcript so you can iterate on the styling. I'll read a file, make an edit, run a shell command, kick off a subagent, and watch a process — each renders as its own row.\n\n");
      await this.stream('A short list, to check prose rhythm:\n\n- streaming markdown\n- tool rows with a collapsible detail\n- a fenced code block below\n\n');
      await this.stream('```ts\nfunction greet(name: string) {\n  return `hello, ${name}`;\n}\n```\n\n');
      await this.stream('The footer carries the **permission-mode dropdown** and the **model/context gauge** — click the gauge to open its popover, where the model / effort / fast config options sit above the token breakdown.\n\n');
      this.emitter.emit('context', this.usage(38000));
      // The agent's first reported topic (ACP session_info_update): it seeds the stable
      // name (shown in the sidebar list/header) once, then later updates only move the
      // header subtitle — see the second emit near the end.
      this.emitter.emit('topic', { topic: 'transcript tour' });

      // Read (clickable file row — boilerplate result is suppressed).
      await wait(250);
      this.toolUse('t_read', 'Read', { file_path: Path.join(CWD, 'src/ui/AgentConversation.ts') });
      await wait(400); this.toolResult('t_read', false, 'ok');

      // Edit (records a changed file, clickable row).
      await wait(300);
      this.toolUse('t_edit', 'Edit', { file_path: Path.join(CWD, 'src/ui/conversation/ToolRow.ts'), old_string: 'flat', new_string: 'flat tinted' });
      await wait(400); this.toolResult('t_edit', false, 'The file has been updated.');

      // A run of CONSECUTIVE Reads — collapse into a single row, each path a link.
      await wait(250);
      await this.stream('Reading a cluster of files:\n\n');
      const cluster = ['src/ui/conversation/ToolRow.ts', 'src/ui/conversation/QuestionCard.ts', 'src/ui/conversation/MonitorView.ts'];
      for (let i = 0; i < cluster.length; i++) {
        const id = `t_read_${i}`;
        this.toolUse(id, 'Read', { file_path: Path.join(CWD, cluster[i]) });
        await wait(120); this.toolResult(id, false, 'ok'); await wait(90);
      }

      // Post-tool assistant text opens a fresh bubble.
      await wait(300);
      await this.stream('Now a shell command — its output collapses into the row; a non-zero exit marks it ✗ but stays collapsed.\n\n');

      // Bash (multiline; output toggles in the detail).
      await wait(200);
      this.toolUse('t_bash', 'Bash', { command: 'rg -n "scrollToBottom" src/ui/AgentConversation.ts \\\n  | head -5', description: 'find scroll calls' });
      await wait(500);
      this.toolResult('t_bash', false, '1308:  private scrollToBottom(): void {\n1311:    if (!this.stickToBottom) return;\n1316:  }');

      // A failing Bash (non-zero exit): ✗ + error tint, but NOT auto-expanded.
      await wait(300);
      this.toolUse('t_bash2', 'Bash', { command: 'pnpm typecheck' });
      await wait(500);
      this.toolResult('t_bash2', true, 'src/poc/x.ts(3,1): error TS2304: Cannot find name "foo".');

      // A tool whose name is absurdly long + unbroken — it must WRAP, not stretch the row.
      await wait(300);
      this.toolUse('t_longname', 'mcp__internal_platform_services__execute_an_extremely_long_and_overly_descriptive_operation_name_with_no_spaces', { target: 'staging', confirm: true });
      await wait(400); this.toolResult('t_longname', false, 'done');

      // TodoWrite checklist (a normal tool row).
      await wait(300);
      this.toolUse('t_todo', 'TodoWrite', { todos: [
        { content: 'Restyle the tool-row button', status: 'completed' },
        { content: 'Indent tool rows', status: 'completed' },
        { content: 'Fix scroll-follow', status: 'in_progress' },
        { content: 'Write the POC', status: 'pending' },
      ] });
      await wait(200); this.toolResult('t_todo', false, 'Todos updated');

      // The sticky Tasks panel (ACP plan → applyPlan): one of each status; the panel
      // hides only once every entry is completed, so an in-progress entry keeps it up.
      await wait(300);
      this.emitter.emit('plan', { entries: [
        { content: 'Audit the conversation styles', status: 'completed' },
        { content: 'Preview every row type', status: 'in_progress' },
        { content: 'Ship the footer redesign', status: 'pending' },
      ] });

      // Three subagents (Agent tool) spawn: inline items + the robot header button +
      // running panel. Only ONE completes (report card); the others stay in-progress.
      await wait(300);
      await this.stream('Fanning out subagents to look around:\n\n');
      const subAgents = [
        ['Explore', 'Map the conversation components'],
        ['Plan', 'Design the stop-button placement'],
        ['general-purpose', 'Audit the scroll behaviour'],
      ] as const;
      for (let i = 0; i < subAgents.length; i++) {
        const [type, description] = subAgents[i];
        const sid = `t_agent_${i}`;
        this.subagents.set(sid, { id: sid, agentType: type, description, prompt: `${description}.`, status: 'running', messages: [] });
        this.toolUse(sid, 'Agent', { subagent_type: type, description, prompt: `${description}.` });
        this.emitter.emit('subagent-update', { id: sid });
        await wait(200);
      }
      // Complete ONLY the middle one; the others remain running in the panel.
      await wait(400);
      const done = this.subagents.get('t_agent_2')!;
      done.messages.push({ kind: 'text', text: 'Auditing scroll: `setupAutoScroll` pins on the adjustment `changed` signal.' });
      done.status = 'completed';
      this.emitter.emit('subagent-update', { id: 't_agent_2' });
      this.emitter.emit('subagent-done', { id: 't_agent_2' });

      // A Monitor (shell watcher): inline row + the terminal header button + running
      // panel, then a status update to completed.
      await wait(300);
      const mon = 't_monitor';
      this.monitors.set(mon, { id: mon, taskId: 'task_mon_1', description: 'dev server', status: 'running', outputFile: null, output: 'listening on http://localhost:5173' });
      this.toolUse(mon, 'Monitor', { description: 'dev server', command: 'pnpm dev' });
      this.emitter.emit('monitor-update', { id: mon });
      await wait(600);
      const m = this.monitors.get(mon)!; m.status = 'completed';
      this.emitter.emit('monitor-update', { id: mon });

      // PERMISSION #1 (Bash): the prompt REPLACES the input — title is the description,
      // the command is the body, the default allow/deny actions below. Blocks here.
      await wait(300);
      await this.stream('This next command needs your approval — pick any action; the scene waits for you.\n\n');
      const perm1 = { command: 'git push origin HEAD', description: 'Push the current branch to origin' };
      this.toolUse('t_perm', 'Bash', perm1);
      const d1 = await this.askPermission({ id: 'perm-1', toolName: 'Bash', input: perm1 });
      this.toolResult('t_perm', !d1.allow, d1.allow ? 'Everything up-to-date' : 'The user denied permission to run this command.');

      // PERMISSION #2 (an Edit): the title is the file path, the body is a +/- DIFF
      // (old→new, context dimmed) capped to a comfortable height. Blocks again.
      await wait(400);
      const perm2 = {
        file_path: Path.join(CWD, 'src/ui/conversation/cards.ts'),
        old_string: "  const button = new Gtk.Button({ label });\n  button.addCssClass('flat');\n  return button;",
        new_string: "  const button = new Gtk.Button({ label });\n  button.addCssClass('raised');\n  button.setTooltipText(label);\n  return button;",
      };
      this.toolUse('t_perm2', 'Edit', perm2);
      const d2 = await this.askPermission({
        id: 'perm-2', toolName: 'Edit', input: perm2,
        diff: { path: perm2.file_path, oldText: perm2.old_string, newText: perm2.new_string },
      });
      this.toolResult('t_perm2', !d2.allow, d2.allow ? 'The file has been updated.' : 'The user denied the edit.');

      // An unmodeled event (raw JSON row) — nothing is silently lost.
      await wait(400);
      this.emitter.emit('unhandled', { event: { type: 'mystery_event', note: 'an event the session does not model — surfaced raw' } });

      // Wrap-up + the context gauge / cost via the result.
      await wait(300);
      await this.stream('That covers the row types and the permission prompt. Next: the question card, which also replaces the input.\n');
      this.emitter.emit('context', this.usage(52000));
      await wait(200);
      this.emitter.emit('result', { costUsd: 0.21, contextWindow: 200000 });

      // Actions bar (set_actions): the agent registers a few runnable actions, surfaced
      // as buttons in the workbench header (piped through bindActions → WorkbenchActions).
      await wait(500);
      await this.stream("I've registered a few actions you can run — they show up on the workbench.\n");
      this.emitter.emit('actions', { actions: [
        { id: 'run-tests', label: 'Run tests', command: 'pnpm test', terminal: true },
        { id: 'dev-server', label: 'Start dev server', command: 'sleep 5', terminal: false },
        { id: 'open-app', label: 'Open the app', command: 'pnpm start', terminal: true },
      ] });

      // The topic evolves (a later ACP session_info_update): the stable name stays
      // 'transcript tour', but the agent-sidebar header subtitle now shows this.
      this.emitter.emit('topic', { topic: 'polishing the footer redesign' });

      // Question card (AskUserQuestion): REPLACES the input. A SINGLE request carrying
      // several questions, so the one card demos every option through its view-switcher:
      // a single-select with descriptions, a multi-select (space toggles, enter
      // confirms), and one inviting a per-option note (press `n`). Blocks until answered.
      await wait(900);
      await this.askQuestion({
        id: 'q-all',
        questions: [
          {
            question: 'Which refinement should I take next?', header: 'Next step', multiSelect: false,
            options: [
              { label: 'Stop button', description: 'A visible interrupt control in the spinner row.' },
              { label: 'Jump to latest', description: 'A floating scroll-to-bottom pill.' },
              { label: 'Collapsible thinking', description: 'Fold long reasoning behind a toggle.' },
            ],
          },
          {
            question: 'Which polish items should I batch together?', header: 'Batch', multiSelect: true,
            options: [
              { label: 'Stop button', description: 'Visible interrupt control.' },
              { label: 'Jump to latest', description: 'Scroll-to-bottom pill.' },
              { label: 'Collapsible thinking', description: 'Fold long reasoning.' },
              { label: 'Per-turn timing', description: 'Hover-revealed duration + tokens.' },
            ],
          },
          {
            question: 'Anything to flag before I start?', header: 'Notes', multiSelect: false,
            options: [
              { label: 'Looks good', description: 'Proceed as planned.' },
              { label: 'Has concerns', description: 'Press n to attach a note with the details.' },
            ],
          },
        ],
      });

      // A short acknowledgement once the question is answered, then close out.
      await wait(300);
      await this.stream('Thanks — recorded your answers above. The input is back; type anything for a canned reply.\n');
      this.emitter.emit('context', this.usage(53000));
      this.emitter.emit('result', { costUsd: 0.22, contextWindow: 200000 });
      this.setStatus('idle');
      console.log('[POC] scripted scene done — type a prompt to get a canned reply.');
    } catch (e) {
      console.error('[scene]', e);
    }
  }
}

// --- boot (mirrors the other POCs' scaffolding) ---------------------------------
const loop = GLib.MainLoop.new(null, false);
const app = new Adw.Application({ applicationId: 'com.github.romgrk.zym.poc.conversation', flags: Gio.ApplicationFlags.NON_UNIQUE });

app.on('activate', () => {
  try {
    registerBundledFonts();
    installStyles();
    fonts.init();
    zym.config.set('agent.showThinking', true); // render the scene's dim thinking block
    Adw.StyleManager.getDefault().setColorScheme(
      theme.appearance === 'light' ? Adw.ColorScheme.FORCE_LIGHT : Adw.ColorScheme.FORCE_DARK,
    );

    const session = new FakeSession();
    const agent = new AgentConversation({
      cwd: CWD,
      prompt: 'Give me a tour of the conversation transcript so I can iterate on its styling.',
      createSession: () => session,
      onOpenFile: (path) => console.log('[POC] open file:', path),
    });
    // Actions live on the workbench: bind a standalone controller; `bindActions` pipes
    // the agent's set_actions into it (mirroring AppWindow). Terminal actions have no
    // host here (the runner logs); background ones would spawn for real.
    const wbActions = new WorkbenchActions(() => CWD);
    wbActions.setTerminalRunner({
      run: (action) => console.log('[POC] run in terminal:', action.label, '→', action.command),
      stop: () => {},
      isRunning: () => false,
      onDidChangeRunning: () => () => {},
    });
    agent.bindActions(wbActions);

    // Wrap the conversation in the real agent header bar (AgentSidebar): its Adw header
    // shows the agent title and packs the agent's headerWidgets — the subagent (robot)
    // and monitor (terminal) count buttons, which appear once the scene spawns some.
    const sidebar = new AgentSidebar({ onOpenChanges: (a) => console.log('[POC] open changes:', a.title) });
    sidebar.addAgent(agent.root);
    sidebar.show(agent);
    // AppWindow's AgentController normally forwards topic changes to the header
    // subtitle; the POC has no controller, so wire it directly (unsub discarded — the
    // agent + sidebar are torn down together on window close).
    void agent.onDidChangeTopic(() => sidebar.setTopic(agent.topic));

    const window = new Adw.ApplicationWindow({ application: app });
    window.setName('AppWindow'); // so the --t-* theme CSS variables resolve
    window.setTitle('zym POC — conversation transcript');
    window.setDefaultSize(900, 920);
    window.setContent(sidebar.root);
    window.on('close-request', () => { agent.dispose(); sidebar.dispose(); loop.quit(); app.quit(); return false; });
    window.present();

    agent.start(); // emits init, then the launch prompt plays the scripted scene

    loop.run();
  } catch (e) {
    process.stderr.write('[POC] activate threw: ' + (e as Error)?.stack + '\n');
    loop.quit();
    app.quit();
  }
});

registerBuiltinPlugins();
await plugins.activateAll();
await preloadGrammars();

// node-gtk #442: defer app.run past the top-level module microtask, or activate
// never fires and the app exits 0.
await new Promise((res) => setTimeout(res, 0));
app.run([]);
