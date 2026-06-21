/*
 * toolDisplay — format an agent tool-use for the conversation view: a Nerd Font
 * icon, a title, and a human-readable detail drawn from the tool's salient input
 * (the command, the file path, the pattern…) instead of a raw JSON dump. Unknown
 * tools fall back to a generic icon + compact JSON.
 *
 * `describeTool` is the pure mapping (tested); `toolMarkup` builds the Pango markup
 * (icon in the icon font, title bold, detail in the app monospace font).
 */
import * as Os from 'node:os';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { escapeMarkup } from './proseMarkup.ts';
import { NERDFONT } from './nerdfont.ts';
import { truncate } from './conversation/format.ts';

// Tool icons come from the shared Nerd Font catalog (NERDFONT). Most live in the
// TOOL group; bash/grep reuse the EDITOR terminal/search glyphs.
const G = {
  bash: NERDFONT.EDITOR.TERMINAL,
  read: NERDFONT.TOOL.READ,
  write: NERDFONT.TOOL.WRITE,
  edit: NERDFONT.TOOL.EDIT,
  glob: NERDFONT.TOOL.GLOB,
  grep: NERDFONT.EDITOR.SEARCH,
  web: NERDFONT.TOOL.WEB,
  task: NERDFONT.TOOL.SUBAGENT,
  todo: NERDFONT.TOOL.TODO,
  notebook: NERDFONT.TOOL.NOTEBOOK,
  mcp: NERDFONT.TOOL.MCP,
  tool: NERDFONT.TOOL.GENERIC,
  skill: NERDFONT.TOOL.SKILL,
  question: NERDFONT.TOOL.QUESTION,
  workflow: NERDFONT.TOOL.WORKFLOW,
  clock: NERDFONT.TOOL.CLOCK,
  calendar: NERDFONT.TOOL.CALENDAR,
  eye: NERDFONT.TOOL.MONITOR,
  bolt: NERDFONT.TOOL.TRIGGER,
  bell: NERDFONT.TOOL.BELL,
  process: NERDFONT.TOOL.COGS,
  stop: NERDFONT.TOOL.STOP,
  design: NERDFONT.TOOL.DESIGN,
  plan: NERDFONT.TOOL.PLAN,
  worktree: NERDFONT.TOOL.WORKTREE,
} as const;

export interface ToolView {
  /** Nerd Font glyph (render with ICON_FONT_FAMILY). */
  icon: string;
  /** Short tool name / label. */
  title: string;
  /** A one-line, human-readable summary of the tool input. */
  detail: string;
}

/** Tool input as a loose record, plus the formatting helpers a descriptor needs. */
type Input = Record<string, unknown>;
interface Fmt {
  /** Coerce a value to a string ('' when not a string). */
  s: (v: unknown) => string;
  /** Coerce a value to a string and shorten it as a file path. */
  p: (v: unknown) => string;
}

/**
 * Per-tool descriptor. `title`/`detail` may be a literal or a function of the
 * input; an absent `title` renders no label, an absent `detail` renders ''.
 */
interface ToolDescriptor {
  icon: string;
  title?: string | ((i: Input, f: Fmt) => string);
  detail?: (i: Input, f: Fmt) => string;
}

// Declarative tool table. Grouped by purpose; the keys are the exact tool names.
const TOOLS: Record<string, ToolDescriptor> = {
  // No label for Bash — the terminal icon + the command read clearly on their own.
  Bash: { icon: G.bash, detail: (i, { s }) => s(i.command) || s(i.description) },
  Read: { icon: G.read, title: 'Read', detail: (i, { p }) => p(i.file_path) },
  Write: { icon: G.write, title: 'Write', detail: (i, { p }) => p(i.file_path) },
  Edit: { icon: G.edit, title: 'Edit', detail: (i, { p }) => p(i.file_path) },
  MultiEdit: { icon: G.edit, title: 'MultiEdit', detail: (i, { p }) => p(i.file_path) + (Array.isArray(i.edits) ? `  (${i.edits.length} edits)` : '') },
  NotebookEdit: { icon: G.notebook, title: 'NotebookEdit', detail: (i, { p }) => p(i.notebook_path) },
  Glob: { icon: G.glob, title: 'Glob', detail: (i, { s, p }) => s(i.pattern) + (i.path ? `  in ${p(i.path)}` : '') },
  Grep: { icon: G.grep, title: 'Grep', detail: (i, { s, p }) => s(i.pattern) + (i.path ? `  in ${p(i.path)}` : '') },
  WebFetch: { icon: G.web, title: 'WebFetch', detail: (i, { s }) => s(i.url) },
  WebSearch: { icon: G.grep, title: 'WebSearch', detail: (i, { s }) => s(i.query) },
  Task: { icon: G.task, title: (i, { s }) => i.subagent_type ? `Task · ${s(i.subagent_type)}` : 'Task', detail: (i, { s }) => s(i.description) || truncate(s(i.prompt), 120) },
  // `Agent` is the subagent-spawn tool (the live name for `Task`); its transcript
  // is shown on a dedicated page (see AgentConversation).
  Agent: { icon: G.task, title: (i, { s }) => i.subagent_type ? `Agent · ${s(i.subagent_type)}` : 'Agent', detail: (i, { s }) => s(i.description) || truncate(s(i.prompt), 120) },
  TodoWrite: { icon: G.todo, title: 'TodoWrite', detail: (i) => Array.isArray(i.todos) ? `${i.todos.length} item${i.todos.length === 1 ? '' : 's'}` : '' },

  // Skill / agent meta-tools.
  Skill: { icon: G.skill, title: 'Skill', detail: (i, { s }) => s(i.skill) + (i.args ? `  ${truncate(s(i.args), 80)}` : '') },
  ToolSearch: { icon: G.grep, title: 'ToolSearch', detail: (i, { s }) => s(i.query) },
  AskUserQuestion: {
    icon: G.question,
    title: 'AskUserQuestion',
    detail: (i, { s }) => {
      const first = (Array.isArray(i.questions) ? i.questions[0] : undefined) as Input | undefined;
      return first ? (s(first.header) || s(first.question)) : '';
    },
  },
  Workflow: { icon: G.workflow, title: 'Workflow', detail: (i, { s }) => s(i.name) || s(i.scriptPath) || '(inline script)' },

  // Task tracking (subjects/ids).
  TaskCreate: { icon: G.todo, title: 'TaskCreate', detail: (i, { s }) => s(i.subject) },
  TaskUpdate: { icon: G.todo, title: 'TaskUpdate', detail: (i, { s }) => (i.taskId ? `#${s(i.taskId)}` : '') + (i.status ? `  → ${s(i.status)}` : '') },
  TaskGet: { icon: G.todo, title: 'TaskGet', detail: (i, { s }) => i.taskId ? `#${s(i.taskId)}` : '' },
  TaskList: { icon: G.todo, title: 'TaskList' },

  // Background-task I/O (bash/agent processes).
  TaskOutput: { icon: G.process, title: 'TaskOutput', detail: (i, { s }) => s(i.task_id) },
  TaskStop: { icon: G.stop, title: 'TaskStop', detail: (i, { s }) => s(i.task_id) || s(i.shell_id) },

  // Scheduling / monitoring / notifications.
  ScheduleWakeup: { icon: G.clock, title: 'ScheduleWakeup', detail: (i, { s }) => (typeof i.delaySeconds === 'number' ? `${i.delaySeconds}s` : '') + (i.reason ? `  ${s(i.reason)}` : '') },
  CronCreate: { icon: G.calendar, title: 'CronCreate', detail: (i, { s }) => s(i.cron) + (i.recurring === false ? '  (once)' : '') },
  CronDelete: { icon: G.calendar, title: 'CronDelete', detail: (i, { s }) => s(i.id) },
  CronList: { icon: G.calendar, title: 'CronList' },
  Monitor: { icon: G.eye, title: 'Monitor', detail: (i, { s }) => s(i.description) || s(i.command) },
  RemoteTrigger: { icon: G.bolt, title: 'RemoteTrigger', detail: (i, { s }) => s(i.action) + (i.trigger_id ? `  ${s(i.trigger_id)}` : '') },
  PushNotification: { icon: G.bell, title: 'PushNotification', detail: (i, { s }) => truncate(s(i.message), 120) },

  // Design sync / plan mode / worktrees.
  DesignSync: { icon: G.design, title: 'DesignSync', detail: (i, { s }) => s(i.method) + (i.projectId ? `  ${s(i.projectId)}` : '') },
  EnterPlanMode: { icon: G.plan, title: 'EnterPlanMode' },
  ExitPlanMode: { icon: G.plan, title: 'ExitPlanMode' },
  EnterWorktree: { icon: G.worktree, title: 'EnterWorktree', detail: (i, { s }) => s(i.name) || s(i.path) },
  ExitWorktree: { icon: G.worktree, title: 'ExitWorktree', detail: (i, { s }) => s(i.action) },
};

/** Map a tool name + input to an icon, title, and a formatted detail line. */
export function describeTool(name: string, input: unknown, cwd?: string): ToolView {
  const i = (input && typeof input === 'object' ? input : {}) as Input;
  const fmt: Fmt = {
    s: (v) => (typeof v === 'string' ? v : ''),
    p: (v) => shortenPath(typeof v === 'string' ? v : '', cwd),
  };

  const d = TOOLS[name];
  if (d) {
    return {
      icon: d.icon,
      title: typeof d.title === 'function' ? d.title(i, fmt) : (d.title ?? ''),
      detail: d.detail ? d.detail(i, fmt) : '',
    };
  }

  // MCP tools arrive as mcp__<server>__<tool>; show "server · tool".
  if (name.startsWith('mcp__')) {
    return { icon: G.mcp, title: name.slice(5).split('__').join(' · '), detail: compactJson(input) };
  }
  return { icon: G.tool, title: name, detail: compactJson(input) };
}

/** The file a tool acts on (for click-to-open), or null when it isn't a file tool. */
export function toolFilePath(name: string, input: unknown): string | null {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const path = name === 'NotebookEdit'
    ? i.notebook_path
    : name === 'Read' || name === 'Write' || name === 'Edit' || name === 'MultiEdit'
      ? i.file_path
      : undefined;
  return typeof path === 'string' && path ? path : null;
}

/** Pango markup for the icon (icon font) + bold title, without the detail — for
 *  rows that render the detail separately (e.g. a file-path button). */
export function toolHeadMarkup(name: string, input: unknown, cwd?: string): string {
  const { icon, title } = describeTool(name, input, cwd);
  let markup = `<span font_family="${attrEscape(ICON_FONT_FAMILY)}">${escapeMarkup(icon)}</span>`;
  if (title) markup += `  <b>${escapeMarkup(title)}</b>`;
  return markup;
}

/** Pango markup for the detail run (mono), or '' when the tool has no detail. */
export function toolDetailMarkup(detail: string, monoFamily: string): string {
  return detail ? `<span face="${attrEscape(monoFamily)}">${escapeMarkup(detail)}</span>` : '';
}

/** Pango markup for a tool-use row: icon (icon font) + bold title + mono detail. */
export function toolMarkup(name: string, input: unknown, opts: { cwd?: string; monoFamily: string }): string {
  const head = toolHeadMarkup(name, input, opts.cwd);
  const { detail } = describeTool(name, input, opts.cwd);
  const detailMarkup = toolDetailMarkup(detail, opts.monoFamily);
  return detailMarkup ? `${head}  ${detailMarkup}` : head;
}

/** Pango markup for a tool-row body: bold title + mono detail, WITHOUT the icon —
 *  for rows that render the icon in a dedicated leading slot (see ToolRow). */
export function toolBodyMarkup(name: string, input: unknown, opts: { cwd?: string; monoFamily: string }): string {
  const { title, detail } = describeTool(name, input, opts.cwd);
  const titleMarkup = title ? `<b>${escapeMarkup(title)}</b>` : '';
  const detailMarkup = toolDetailMarkup(detail, opts.monoFamily);
  return titleMarkup && detailMarkup ? `${titleMarkup}  ${detailMarkup}` : titleMarkup || detailMarkup;
}

// --- helpers -----------------------------------------------------------------

// A path relative to `cwd` when under it, else with the home dir collapsed to `~`.
function shortenPath(path: string, cwd?: string): string {
  if (!path) return '';
  if (cwd && (path === cwd || path.startsWith(cwd + '/'))) return path.slice(cwd.length + 1) || path;
  const home = Os.homedir();
  if (home && (path === home || path.startsWith(home + '/'))) return '~' + path.slice(home.length);
  return path;
}

function compactJson(input: unknown): string {
  if (input == null) return '';
  let text: string;
  try {
    text = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    text = String(input);
  }
  return truncate(text, 200);
}

function attrEscape(text: string): string {
  return escapeMarkup(text).replace(/"/g, '&quot;');
}
