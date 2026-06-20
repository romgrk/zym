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

// Nerd Font (FontAwesome) codepoints, matching the Icons convention in icons.ts.
const G = {
  bash: 0xf120, // terminal
  read: 0xf15c, // file-text
  write: 0xf0c7, // floppy / save
  edit: 0xf044, // pencil-square
  glob: 0xf07c, // folder-open
  grep: 0xf002, // search
  web: 0xf0ac, // globe
  task: 0xf0c0, // users (subagent)
  todo: 0xf0ae, // tasks (checklist)
  notebook: 0xf02d, // book
  mcp: 0xf1e6, // plug (MCP tool)
  tool: 0xf013, // cog (default)
} as const;

const glyph = (cp: number) => String.fromCodePoint(cp);

export interface ToolView {
  /** Nerd Font glyph (render with ICON_FONT_FAMILY). */
  icon: string;
  /** Short tool name / label. */
  title: string;
  /** A one-line, human-readable summary of the tool input. */
  detail: string;
}

/** Map a tool name + input to an icon, title, and a formatted detail line. */
export function describeTool(name: string, input: unknown, cwd?: string): ToolView {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const s = (v: unknown): string => (typeof v === 'string' ? v : '');
  const p = (v: unknown): string => shortenPath(s(v), cwd);

  switch (name) {
    case 'Bash':
      return { icon: glyph(G.bash), title: 'Bash', detail: s(i.command) || s(i.description) };
    case 'Read':
      return { icon: glyph(G.read), title: 'Read', detail: p(i.file_path) };
    case 'Write':
      return { icon: glyph(G.write), title: 'Write', detail: p(i.file_path) };
    case 'Edit':
      return { icon: glyph(G.edit), title: 'Edit', detail: p(i.file_path) };
    case 'MultiEdit':
      return { icon: glyph(G.edit), title: 'MultiEdit', detail: p(i.file_path) + (Array.isArray(i.edits) ? `  (${i.edits.length} edits)` : '') };
    case 'NotebookEdit':
      return { icon: glyph(G.notebook), title: 'NotebookEdit', detail: p(i.notebook_path) };
    case 'Glob':
      return { icon: glyph(G.glob), title: 'Glob', detail: s(i.pattern) + (i.path ? `  in ${p(i.path)}` : '') };
    case 'Grep':
      return { icon: glyph(G.grep), title: 'Grep', detail: s(i.pattern) + (i.path ? `  in ${p(i.path)}` : '') };
    case 'WebFetch':
      return { icon: glyph(G.web), title: 'WebFetch', detail: s(i.url) };
    case 'WebSearch':
      return { icon: glyph(G.grep), title: 'WebSearch', detail: s(i.query) };
    case 'Task':
      return { icon: glyph(G.task), title: i.subagent_type ? `Task · ${s(i.subagent_type)}` : 'Task', detail: s(i.description) || truncate(s(i.prompt), 120) };
    case 'TodoWrite':
      return { icon: glyph(G.todo), title: 'TodoWrite', detail: Array.isArray(i.todos) ? `${i.todos.length} item${i.todos.length === 1 ? '' : 's'}` : '' };
    default:
      // MCP tools arrive as mcp__<server>__<tool>; show "server · tool".
      if (name.startsWith('mcp__')) {
        const parts = name.slice(5).split('__');
        return { icon: glyph(G.mcp), title: parts.join(' · '), detail: compactJson(input) };
      }
      return { icon: glyph(G.tool), title: name, detail: compactJson(input) };
  }
}

/** Pango markup for a tool-use row: icon (icon font) + bold title + mono detail. */
export function toolMarkup(name: string, input: unknown, opts: { cwd?: string; monoFamily: string }): string {
  const { icon, title, detail } = describeTool(name, input, opts.cwd);
  let markup = `<span font_family="${attrEscape(ICON_FONT_FAMILY)}">${escapeMarkup(icon)}</span>  <b>${escapeMarkup(title)}</b>`;
  if (detail) markup += `  <span face="${attrEscape(opts.monoFamily)}">${escapeMarkup(detail)}</span>`;
  return markup;
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

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function attrEscape(text: string): string {
  return escapeMarkup(text).replace(/"/g, '&quot;');
}
