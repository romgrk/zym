#!/usr/bin/env node
/*
 * POC: drive the REAL AgentConversation with scripted, fake stream events so the
 * whole transcript (bubbles, streaming text/thinking, tool rows, Bash, a Task
 * subagent, a Monitor, a permission prompt embedded in a tool row, a question
 * card, the actions bar, the context gauge, errors) can be iterated on WITHOUT
 * spawning `claude`.
 *
 * Fidelity comes from reusing production code end-to-end: a fake `Transport`
 * (injected via AgentConversation's `createTransport` seam) feeds raw stream-json
 * events into the real SdkSession, which maps them to the real domain events the
 * real AgentConversation renders. Nothing about the rendering is reimplemented
 * here — only the event SOURCE is faked. So whatever we change in the conversation
 * UI shows up here verbatim.
 *
 * Permission + question cards and the actions bar ride SdkSession's file-watch
 * channels (not the event stream), so they're exercised by writing the same files
 * the MCP permission / `set_actions` bridge tools would write — into the per-session
 * runtime dir, discovered just after the session is constructed.
 *
 * After the scripted scene finishes you can keep typing: a submitted prompt gets a
 * short canned streamed reply, so the input / submit / interrupt / scroll-follow
 * behaviour is all live.
 *
 * Run:  node src/poc/conversation-transcript.ts
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import GLib from 'gi:GLib-2.0';
import Gio from 'gi:Gio-2.0';
import Adw from 'gi:Adw-1';
import { installStyles } from '../styles.ts';
import { registerBundledFonts, fonts } from '../fonts.ts';
import { theme } from '../theme/theme.ts';
import { Disposable } from '../util/eventKit.ts';
import { AgentConversation } from '../ui/AgentConversation.ts';
import { WorkbenchActions } from '../ui/workbench/WorkbenchActions.ts';
import type { Transport } from '../agents/claude-sdk/transport.ts';
import type { StreamEvent } from '../agents/claude-sdk/protocol.ts';
import { registerBuiltinPlugins, plugins } from '../plugin/index.ts';
import { preloadGrammars } from '../syntax/grammar.ts';

const MODEL = 'claude-opus-4-8';
const CWD = process.cwd();

// --- raw stream-json event builders (the shapes SdkSession.dispatch recognises) ---
const ev = {
  init: (): StreamEvent => ({
    type: 'system', subtype: 'init', session_id: 'poc-session',
    model: MODEL, permissionMode: 'default',
    slash_commands: ['/clear', '/compact', '/context', '/review'],
  } as unknown as StreamEvent),
  thinkingTokens: (estimated_tokens: number): StreamEvent =>
    ({ type: 'system', subtype: 'thinking_tokens', estimated_tokens } as unknown as StreamEvent),
  thinkingDelta: (thinking: string): StreamEvent =>
    ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking } } } as unknown as StreamEvent),
  textDelta: (text: string): StreamEvent =>
    ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } } as unknown as StreamEvent),
  // A full assistant message: carries tool_use blocks and/or the per-message usage
  // that drives the context gauge. Empty content (just usage) renders no row.
  assistant: (content: unknown[], usage?: unknown): StreamEvent =>
    ({ type: 'assistant', message: { content, usage } } as unknown as StreamEvent),
  toolUse: (id: string, name: string, input: unknown, parent?: string): StreamEvent =>
    ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] } } as unknown as StreamEvent),
  toolResult: (id: string, isError: boolean, text: string, parent?: string): StreamEvent =>
    ({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } } as unknown as StreamEvent),
  subagentText: (parent: string, text: string): StreamEvent =>
    ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text }] } } as unknown as StreamEvent),
  taskStarted: (toolUseId: string, taskId: string, extra: Record<string, unknown>): StreamEvent =>
    ({ type: 'system', subtype: 'task_started', tool_use_id: toolUseId, task_id: taskId, ...extra } as unknown as StreamEvent),
  taskProgress: (toolUseId: string, extra: Record<string, unknown>): StreamEvent =>
    ({ type: 'system', subtype: 'task_progress', tool_use_id: toolUseId, ...extra } as unknown as StreamEvent),
  taskNotification: (toolUseId: string, extra: Record<string, unknown>): StreamEvent =>
    ({ type: 'system', subtype: 'task_notification', tool_use_id: toolUseId, ...extra } as unknown as StreamEvent),
  usage: (tokens: number) => ({ input_tokens: Math.round(tokens * 0.1), cache_read_input_tokens: Math.round(tokens * 0.85), cache_creation_input_tokens: Math.round(tokens * 0.05), output_tokens: 420 }),
  result: (costUsd: number, contextWindow: number): StreamEvent =>
    ({ type: 'result', subtype: 'success', total_cost_usd: costUsd, modelUsage: { [MODEL]: { contextWindow } } } as unknown as StreamEvent),
  unknown: (): StreamEvent => ({ type: 'mystery_event', note: 'an event SdkSession does not model — surfaced raw' } as unknown as StreamEvent),
};

// --- the fake transport: scripted scene on start(), canned replies on later turns ---
class FakeTransport implements Transport {
  readonly writable = true;
  private handler: ((e: StreamEvent) => void) | null = null;
  private scenarioDone = false;
  private replies = 0;

  onEvent(cb: (e: StreamEvent) => void): Disposable { this.handler = cb; return new Disposable(() => { this.handler = null; }); }
  onStderr(_cb: (chunk: string) => void): Disposable { return new Disposable(() => {}); }
  onExit(_cb: (code: number | null) => void): Disposable { return new Disposable(() => {}); }
  feed(event: StreamEvent): void { this.handler?.(event); }
  dispose(): void { this.handler = null; }

  start(): void { this.playScene(); }

  // The agent (and the user) send turns / control requests here. The launch prompt
  // arrives before the scene finishes and is ignored (the scene is its reply); a
  // later user turn gets a short canned streamed reply so typing stays live.
  send(message: unknown): void {
    const m = message as { type?: string; request?: { subtype?: string; request_id?: string }; request_id?: string };
    if (m?.type === 'control_request') {
      // Make interrupt feel real: ack success (SdkSession drops to idle on it).
      if (m.request?.subtype === 'interrupt') {
        const requestId = (m as { request_id?: string }).request_id;
        setTimeout(() => this.feed({ type: 'control_response', response: { subtype: 'success', request_id: requestId } } as unknown as StreamEvent), 60);
      }
      return;
    }
    if (m?.type === 'user' && this.scenarioDone) this.cannedReply();
  }

  private cannedReply(): void {
    const n = ++this.replies;
    let t = 200;
    const at = (fn: () => void) => { setTimeout(fn, t); };
    at(() => this.feed(ev.textDelta('Got it — ')));
    t += 350; at(() => this.feed(ev.textDelta('this is a scripted POC reply, ')));
    t += 350; at(() => this.feed(ev.textDelta('no real model is running. ')));
    t += 350; at(() => this.feed(ev.textDelta(`(reply #${n})`)));
    t += 400; at(() => this.feed(ev.assistant([], ev.usage(42000 + n * 1500))));
    t += 150; at(() => this.feed(ev.result(0.03 * n, 200000)));
  }

  // The scripted timeline. `t` is a running cursor (ms); `at` schedules at the
  // current cursor, `wait` advances it, `stream` fans a string out as deltas.
  private playScene(): void {
    let t = 0;
    const at = (fn: () => void) => { const d = t; setTimeout(() => { try { fn(); } catch (e) { console.error('[scene]', e); } }, d); };
    const wait = (ms: number) => { t += ms; };
    const feed = (e: StreamEvent) => at(() => this.feed(e));
    const stream = (text: string, chunkWords = 3, stepMs = 34) => {
      const words = text.match(/\S+\s*|\s+/g) ?? [text];
      for (let i = 0; i < words.length; i += chunkWords) {
        const piece = words.slice(i, i + chunkWords).join('');
        at(() => this.feed(ev.textDelta(piece)));
        t += stepMs;
      }
    };
    const streamThinking = (text: string, chunkWords = 4, stepMs = 26) => {
      const words = text.match(/\S+\s*|\s+/g) ?? [text];
      for (let i = 0; i < words.length; i += chunkWords) {
        at(() => this.feed(ev.thinkingDelta(words.slice(i, i + chunkWords).join(''))));
        t += stepMs;
      }
    };

    feed(ev.init());

    // Thinking: a live token counter, then a streamed reasoning block.
    wait(400);
    feed(ev.thinkingTokens(120)); wait(250);
    feed(ev.thinkingTokens(540)); wait(250);
    feed(ev.thinkingTokens(1180)); wait(350);
    streamThinking('Let me map the conversation UI first. The transcript is built in AgentConversation, with the tool rows and bubbles I want to inspect. I should exercise each row type so the styling is visible.');

    // Assistant intro (streamed) — tall enough to test scroll-follow.
    wait(500);
    stream("Here's a tour of the transcript so you can iterate on the styling. I'll read a file, make an edit, run a shell command, kick off a subagent, and watch a process — each renders as its own row.\n\n");
    stream('A short list, to check prose rhythm:\n\n- streaming markdown\n- tool rows with a collapsible detail\n- a fenced code block below\n\n');
    stream('```ts\nfunction greet(name: string) {\n  return `hello, ${name}`;\n}\n```\n\n');
    feed(ev.assistant([], ev.usage(38000)));

    // Read (clickable file row — boilerplate result is suppressed).
    wait(250);
    feed(ev.toolUse('t_read', 'Read', { file_path: Path.join(CWD, 'src/ui/AgentConversation.ts') }));
    wait(400); feed(ev.toolResult('t_read', false, 'ok'));

    // Edit (records a changed file, clickable row).
    wait(300);
    feed(ev.toolUse('t_edit', 'Edit', { file_path: Path.join(CWD, 'src/ui/conversation/ToolRow.ts'), old_string: 'flat', new_string: 'flat tinted' }));
    wait(400); feed(ev.toolResult('t_edit', false, 'The file has been updated.'));

    // A run of CONSECUTIVE Reads — these collapse into a single row with each file
    // path stacked as its own clickable link.
    wait(300);
    stream('Reading a cluster of files:\n\n');
    ['src/ui/conversation/ToolRow.ts', 'src/ui/conversation/QuestionCard.ts', 'src/ui/conversation/SubagentView.ts', 'src/ui/conversation/MonitorView.ts', 'src/ui/conversation/format.ts']
      .forEach((rel, i) => {
        const id = `t_read_${i}`;
        feed(ev.toolUse(id, 'Read', { file_path: Path.join(CWD, rel) }));
        wait(120);
        feed(ev.toolResult(id, false, 'ok'));
        wait(90);
      });

    // A mix of file tools — each CONSECUTIVE run of the same tool collapses into its
    // own row: 3 Edits → one row, 2 Writes → one row, then a single Read.
    wait(300);
    stream('Editing and writing a few files:\n\n');
    const ops = [
      ['Edit', 'src/ui/conversation/ToolRow.ts'],
      ['Edit', 'src/ui/conversation/QuestionCard.ts'],
      ['Edit', 'src/ui/AgentConversation.ts'],
      ['Write', 'src/ui/conversation/NewPanelA.ts'],
      ['Write', 'src/ui/conversation/NewPanelB.ts'],
      ['Read', 'src/ui/conversation/MonitorView.ts'],
    ] as const;
    ops.forEach(([tool, rel], i) => {
      const id = `t_burst_${i}`;
      const input = tool === 'Read'
        ? { file_path: Path.join(CWD, rel) }
        : tool === 'Write'
          ? { file_path: Path.join(CWD, rel), content: '// new file\n' }
          : { file_path: Path.join(CWD, rel), old_string: 'a', new_string: 'b' };
      feed(ev.toolUse(id, tool, input));
      wait(160);
      feed(ev.toolResult(id, false, tool === 'Read' ? 'ok' : 'The file has been updated.'));
      wait(140);
    });

    // Post-tool assistant text opens a fresh bubble.
    wait(300);
    stream('Now a shell command — its output collapses into the row; a non-zero exit marks it ✗ but stays collapsed.\n\n');

    // Bash (multiline; output toggles in the detail).
    wait(200);
    feed(ev.toolUse('t_bash', 'Bash', { command: 'rg -n "scrollToBottom" src/ui/AgentConversation.ts \\\n  | head -5', description: 'find scroll calls' }));
    wait(500);
    feed(ev.toolResult('t_bash', false, '1308:  private scrollToBottom(): void {\n1311:    if (!this.stickToBottom) return;\n1316:  }'));

    // A failing Bash (non-zero exit): ✗ + error tint, but NOT auto-expanded.
    wait(300);
    feed(ev.toolUse('t_bash2', 'Bash', { command: 'pnpm typecheck' }));
    wait(500);
    feed(ev.toolResult('t_bash2', true, 'src/poc/x.ts(3,1): error TS2304: Cannot find name "foo".'));

    // A tool whose name is absurdly long + unbroken — it must WRAP, not stretch the row.
    wait(300);
    feed(ev.toolUse('t_longname', 'mcp__internal_platform_services__execute_an_extremely_long_and_overly_descriptive_operation_name_with_no_spaces', { target: 'staging', confirm: true }));
    wait(400);
    feed(ev.toolResult('t_longname', false, 'done'));

    // TodoWrite checklist.
    wait(300);
    feed(ev.toolUse('t_todo', 'TodoWrite', { todos: [
      { content: 'Restyle the tool-row button', status: 'completed' },
      { content: 'Indent tool rows', status: 'completed' },
      { content: 'Fix scroll-follow', status: 'in_progress' },
      { content: 'Write the POC', status: 'pending' },
    ] }));
    wait(200); feed(ev.toolResult('t_todo', false, 'Todos updated'));

    // The structured task panel (TaskCreate → TaskUpdate).
    wait(250);
    feed(ev.toolUse('t_tc1', 'TaskCreate', { subject: 'Audit the conversation styles' }));
    feed(ev.toolResult('t_tc1', false, 'Task #1 created'));
    feed(ev.toolUse('t_tc2', 'TaskCreate', { subject: 'Preview every row type' }));
    feed(ev.toolResult('t_tc2', false, 'Task #2 created'));
    feed(ev.toolUse('t_tc3', 'TaskCreate', { subject: 'Ship the footer redesign' }));
    feed(ev.toolResult('t_tc3', false, 'Task #3 created'));
    // End with ONE of each status: #1 completed (struck), #2 in-progress, #3 untouched
    // (not-started). The panel only hides once every task is completed.
    wait(600);
    feed(ev.toolUse('t_tu1', 'TaskUpdate', { taskId: '1', status: 'in_progress' }));
    feed(ev.toolResult('t_tu1', false, 'updated'));
    wait(700);
    feed(ev.toolUse('t_tu2', 'TaskUpdate', { taskId: '1', status: 'completed' }));
    feed(ev.toolResult('t_tu2', false, 'updated'));
    feed(ev.toolUse('t_tu3', 'TaskUpdate', { taskId: '2', status: 'in_progress' }));
    feed(ev.toolResult('t_tu3', false, 'updated'));

    // Five subagents (Agent tool) spawn: inline cards + the running panel. Only ONE
    // completes (report card + leaves the panel); the other four stay in-progress.
    wait(500);
    stream('Fanning out subagents to look around:\n\n');
    const subAgents = [
      ['Explore', 'Map the conversation components'],
      ['Plan', 'Design the stop-button placement'],
      ['general-purpose', 'Audit the scroll behaviour'],
      ['Explore', 'Find every tool-row call site'],
      ['code-reviewer', 'Review the footer changes'],
    ] as const;
    subAgents.forEach(([type, desc], i) => {
      const sid = `t_agent_${i}`;
      feed(ev.toolUse(sid, 'Agent', { subagent_type: type, description: desc, prompt: `${desc}.` }));
      feed(ev.taskStarted(sid, `task_agent_${i}`, { task_type: 'local_agent', subagent_type: type, description: desc, prompt: `${desc}.` }));
      wait(250);
    });
    // Complete ONLY the middle one; the other four remain running in the panel.
    wait(800);
    feed(ev.subagentText('t_agent_2', 'Auditing scroll: `setupAutoScroll` pins on the adjustment `changed` signal.'));
    feed(ev.taskNotification('t_agent_2', { status: 'completed', usage: { total_tokens: 5400, tool_uses: 7, duration_ms: 9000 } }));
    feed(ev.toolResult('t_agent_2', false, '## Findings\n\nThe transcript follows the bottom via a `stickToBottom` flag, pinned on the scroll adjustment `changed` signal. Looks correct.'));

    // A Monitor (shell watcher): inline card + running panel + status update.
    wait(500);
    const mon = 't_monitor';
    feed(ev.toolUse(mon, 'Monitor', { description: 'dev server', command: 'pnpm dev' }));
    feed(ev.taskStarted(mon, 'task_mon_1', { description: 'dev server' }));
    wait(900);
    feed(ev.taskNotification(mon, { status: 'completed', output_file: '/tmp/dev.log' }));

    // A permission prompt embedded into a matching Bash row (Allow/Deny in its detail).
    wait(500);
    stream('This next command needs your approval:\n\n');
    const permInput = { command: 'git push origin HEAD' };
    feed(ev.toolUse('t_perm', 'Bash', permInput));
    at(() => writePermissionRequest({ id: 'perm-1', tool_name: 'Bash', input: permInput }));
    wait(1400);
    feed(ev.toolResult('t_perm', false, 'Everything up-to-date'));

    // An unmodeled event (raw JSON row).
    wait(400);
    feed(ev.unknown());

    // Wrap-up + the context gauge / cost via the result.
    wait(300);
    stream('That covers the row types. Use the footer gauge to watch context, scroll up mid-stream to confirm it no longer yanks you down, and hover a tool row to check the new flat-button hover + indent.\n');
    feed(ev.assistant([], ev.usage(52000)));
    wait(200);
    feed(ev.result(0.21, 200000));

    // Actions bar (set_actions): the agent registers a few runnable actions, which
    // surface as buttons just above the prompt. The first is the default (the accent
    // "suggested" button); the terminal-less one shows a stop control while it runs.
    wait(500);
    stream("I've registered a few actions you can run — they show up in the bar above the prompt.\n");
    at(() => writeActions([
      { label: 'Run tests', command: 'pnpm test' },                        // default → accent button (terminal)
      { label: 'Start dev server', command: 'sleep 5', terminal: false },  // background → a stop control while it runs
      { label: 'Open the app', command: 'pnpm start' },                    // another terminal action
    ]));

    // Question card (AskUserQuestion), the final interactive beat — a SINGLE request
    // carrying several questions, so the one card demos every option through its
    // view-switcher: a single-select with descriptions, a multi-select (space toggles,
    // enter confirms), and one inviting a per-option note (press `n`). h/l moves
    // between the questions.
    wait(900);
    at(() => writePermissionRequest({
      id: 'q-all', tool_name: 'AskUserQuestion',
      input: { questions: [
        // 1) single-select; options carry descriptions (radio).
        {
          question: 'Which refinement should I take next?',
          header: 'Next step',
          multiSelect: false,
          options: [
            { label: 'Stop button', description: 'A visible interrupt control in the spinner row.' },
            { label: 'Jump to latest', description: 'A floating scroll-to-bottom pill.' },
            { label: 'Collapsible thinking', description: 'Fold long reasoning behind a toggle.' },
          ],
        },
        // 2) multi-select (checkboxes); space toggles, enter confirms the set.
        {
          question: 'Which polish items should I batch together?',
          header: 'Batch',
          multiSelect: true,
          options: [
            { label: 'Stop button', description: 'Visible interrupt control.' },
            { label: 'Jump to latest', description: 'Scroll-to-bottom pill.' },
            { label: 'Collapsible thinking', description: 'Fold long reasoning.' },
            { label: 'Per-turn timing', description: 'Hover-revealed duration + tokens.' },
          ],
        },
        // 3) single-select that invites a note — press `n` to reveal the note entry.
        {
          question: 'Anything to flag before I start?',
          header: 'Notes',
          multiSelect: false,
          options: [
            { label: 'Looks good', description: 'Proceed as planned.' },
            { label: 'Has concerns', description: 'Press n to attach a note with the details.' },
          ],
        },
      ] },
    }));

    at(() => { this.scenarioDone = true; console.log('[POC] scripted scene done — type a prompt to get a canned reply.'); });
  }
}

// --- permission/question request file (the channel SdkSession watches) ----------
// SdkSession creates a fresh per-session runtime dir in its constructor; we find it
// by diffing the sdk runtime root before/after the conversation is built.
const SDK_ROOT = Path.join(process.env.XDG_RUNTIME_DIR || Os.tmpdir(), 'zym', 'sdk');
function listSessionDirs(): Set<string> {
  try { return new Set(Fs.readdirSync(SDK_ROOT)); } catch { return new Set(); }
}
let sessionDir: string | null = null;
function writePermissionRequest(req: unknown): void {
  if (!sessionDir) { console.warn('[POC] no session dir — skipping permission/question demo'); return; }
  const file = Path.join(sessionDir, 'permission.req');
  try {
    Fs.writeFileSync(`${file}.tmp`, JSON.stringify(req));
    Fs.renameSync(`${file}.tmp`, file); // atomic → the Gio WATCH_MOVES monitor fires
  } catch (e) { console.warn('[POC] permission write failed:', (e as Error).message); }
}

// The `set_actions` bridge tool writes the registered actions (a JSON array)
// atomically to actions.json; SdkSession watches it and emits an `actions` event,
// which the AgentConversation renders into the ActionsBar above the prompt.
function writeActions(actions: unknown): void {
  if (!sessionDir) { console.warn('[POC] no session dir — skipping set_actions demo'); return; }
  const file = Path.join(sessionDir, 'actions.json');
  try {
    Fs.writeFileSync(`${file}.tmp`, JSON.stringify(actions));
    Fs.renameSync(`${file}.tmp`, file); // atomic → the Gio WATCH_MOVES monitor fires
  } catch (e) { console.warn('[POC] actions write failed:', (e as Error).message); }
}

// --- boot (mirrors the other POCs' scaffolding) ---------------------------------
const loop = GLib.MainLoop.new(null, false);
const app = new Adw.Application({ applicationId: 'com.github.romgrk.zym.poc.conversation', flags: Gio.ApplicationFlags.NON_UNIQUE });

app.on('activate', () => {
  try {
    registerBundledFonts();
    installStyles();
    fonts.init();
    Adw.StyleManager.getDefault().setColorScheme(
      theme.appearance === 'light' ? Adw.ColorScheme.FORCE_LIGHT : Adw.ColorScheme.FORCE_DARK,
    );

    const fake = new FakeTransport();
    const before = listSessionDirs();
    const agent = new AgentConversation({
      cwd: CWD,
      prompt: 'Give me a tour of the conversation transcript so I can iterate on its styling.',
      createTransport: () => fake,
      onOpenFile: (path) => console.log('[POC] open file:', path),
    });
    // Actions now live on the workbench: bind a standalone controller; `bindActions`
    // pipes the agent's set_actions into it (mirroring what AppWindow does). Terminal
    // actions have no host here (the runner logs); background ones spawn for real.
    const wbActions = new WorkbenchActions(() => CWD);
    wbActions.setTerminalRunner({
      run: (action) => console.log('[POC] run in terminal:', action.label, '→', action.command),
      stop: () => {},
      isRunning: () => false,
      onDidChangeRunning: () => () => {},
    });
    agent.bindActions(wbActions);
    // The just-created session's runtime dir (the new entry under SDK_ROOT).
    const after = listSessionDirs();
    for (const d of after) if (!before.has(d)) sessionDir = Path.join(SDK_ROOT, d);

    const window = new Adw.ApplicationWindow({ application: app });
    window.setName('AppWindow'); // so the --t-* theme CSS variables resolve
    window.setTitle('zym POC — conversation transcript');
    window.setDefaultSize(900, 920);
    window.setContent(agent.root);
    window.on('close-request', () => { agent.dispose(); loop.quit(); app.quit(); return false; });
    window.present();

    agent.start(); // spawns the fake transport → plays the scripted scene

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
