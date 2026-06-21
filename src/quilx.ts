/*
 * quilx — the global application registry (analog to Atom's `atom` /
 * xedel's `xedel`).
 *
 * It holds the singletons the command/keymap subsystem reaches for: the command
 * manager, the keymap manager, and the active application window. The managers
 * and their helpers (`getActiveElements`, `KeymapManager`) import this singleton
 * directly; it is also attached to `globalThis.quilx` so it can be inspected
 * from the console and to mirror the Atom-style global.
 *
 * The window is wired in once by `AppWindow` (`quilx.window = …`) after it is
 * constructed, before `quilx.keymaps.initialize()`.
 */
import type { ApplicationWindow } from './gi.ts';
import { CommandManager } from './CommandManager.ts';
import { KeymapManager } from './KeymapManager.ts';
import { NotificationManager } from './NotificationManager.ts';
import { AgentManager } from './AgentManager.ts';
import { SessionManager } from './SessionManager.ts';
import { LspManager } from './lsp/LspManager.ts';
import { Workspace } from './Workspace.ts';
import { Config, type ConfigSchema } from './util/Config.ts';

/*
 * The application-wide config schema (Atom's `core.*` / `editor.*`). This is the
 * general, non-vim baseline; subsystems contribute their own namespaced
 * parameters at load time via `quilx.config.scope(namespace).register(...)` —
 * see `ui/TextEditor/vim/settings.ts`, which registers under `vim-mode-plus`.
 */
const CONFIG_SCHEMA: Record<string, ConfigSchema> = {
  'core.followSystemColorScheme': {
    type: 'boolean',
    default: true,
    description: 'Follow the system light/dark preference for the active theme.',
  },
  'editor.tabLength': {
    type: 'integer',
    default: 2,
    minimum: 1,
    maximum: 16,
    description: 'Default indent width (a file with its own detectable indentation overrides this).',
  },
  'editor.insertSpaces': {
    type: 'boolean',
    default: true,
    description: 'Indent with spaces by default (a file with detectable tab indentation overrides this).',
  },
  'editor.autoCloseBrackets': {
    type: 'boolean',
    default: true,
    description: 'Auto-insert the closing bracket/quote when typing an opener, and delete both on backspace.',
  },
  'editor.fontFamily': {
    type: 'string',
    default: '',
    description: 'Editor font family; empty uses the platform monospace default.',
  },
  'editor.fontSize': {
    type: 'integer',
    default: 13,
    minimum: 6,
    maximum: 100,
    description: 'Editor font size in points.',
  },
  'editor.minimap': {
    type: 'boolean',
    default: false,
    description: 'Show the source-map minimap gutter on the right of the editor.',
  },
  'editor.locationBar': {
    type: 'boolean',
    default: true,
    description: 'Show a location bar atop the editor with the file path and the tree-sitter scope breadcrumb.',
  },
  'editor.softWrap': {
    type: 'boolean',
    default: true,
    description: 'Wrap long lines to the editor width instead of scrolling horizontally.',
  },
  'editor.indentGuides': {
    type: 'boolean',
    default: true,
    description: 'Draw faint vertical guides marking each indentation level.',
  },
  'editor.errorLens': {
    type: 'boolean',
    default: true,
    description: "Show each line's diagnostic message inline (trailing the line), not just on hover.",
  },
  'editor.inlayHints': {
    type: 'boolean',
    default: true,
    description: 'Show LSP inlay hints (parameter names / inferred types) trailing each line.',
  },
  'ui.lsColors': {
    type: 'boolean',
    default: true,
    description: 'Color file names in the path opener (file:open-path) using the $LS_COLORS environment variable.',
  },
  'editor.scrollPastEnd': {
    type: 'boolean',
    default: true,
    description: 'Allow scrolling past the end of the buffer so the last line can reach the top of the viewport.',
  },
  'agent.command': {
    type: 'array',
    default: ['claude'],
    description: 'Argv of the terminal agent launched by AgentTerminal (agent:new).',
  },
  'agent.autoOpenChangedFiles': {
    type: 'boolean',
    default: true,
    description:
      "Automatically open a file in the agent's own workbench right dock when the agent first edits it (without switching to that workbench).",
  },
  'git.remotes.upstream': {
    type: 'string',
    default: 'upstream',
    description: 'Remote name for the canonical repo (PR/issue detection, fetch).',
  },
  'git.remotes.origin': {
    type: 'string',
    default: 'origin',
    description: 'Remote name for your fork (push).',
  },
  'git.autoFetchMinutes': {
    type: 'integer',
    default: 5,
    minimum: 0,
    maximum: 1440,
    description: 'Background `git fetch` interval in minutes (0 disables).',
  },
  'session.autosave': {
    type: 'boolean',
    default: true,
    description: 'Persist the working state (layout, tabs, cursors) as it changes and on quit.',
  },
  'session.restoreOnLaunch': {
    type: 'boolean',
    default: false,
    description: 'Reopen the saved session on startup (an explicit file arg always suppresses it).',
  },
  'session.promptOnExitWhenModified': {
    type: 'boolean',
    default: true,
    description: 'Prompt before quitting when an editor has unsaved changes or an agent is running.',
  },
  'session.autosaveDebounceMs': {
    type: 'integer',
    default: 1000,
    minimum: 0,
    maximum: 60000,
    description: 'Debounce window (ms) before an autosave is written after a change.',
  },
  'lsp.enable': {
    type: 'boolean',
    default: true,
    description: 'Enable LSP language servers (diagnostics, go-to-definition, …).',
  },
  'lsp.disabledLanguages': {
    type: 'array',
    default: [],
    description: 'Language ids (e.g. "typescript") for which no server starts.',
  },
  'lsp.servers': {
    type: 'object',
    default: {},
    description:
      'Per-language server overrides, keyed by language id then server name, e.g. ' +
      '{ "typescript": { "deno": { "disable": true }, "typescript-language-server": { "command": "…", "priority": 50 } } }. ' +
      'Set "disable": true to turn a server off; an unknown name with a "command" adds a new server.',
  },
  'lsp.autoInstall': {
    type: 'boolean',
    default: false,
    description:
      'Automatically install a missing language server (into a quilx-managed dir) when a file needs it — shown as an info notification — instead of prompting with an Install button.',
  },
  'plugins.disabled': {
    type: 'array',
    default: [],
    description: 'Plugin IDs (e.g. "rust") that are not activated on startup.',
  },
  'diagnostics.statusSeverities': {
    type: 'array',
    default: ['error', 'warning', 'info', 'hint'],
    description:
      'Which diagnostic severities the header status pill counts, in any subset of ' +
      '"error", "warning", "info", "hint". Counts always display in severity order; ' +
      'severities left out here still appear in the Diagnostics panel.',
  },
  'scriptRunner.detectPackageManager': {
    type: 'boolean',
    default: false,
    description:
      'Auto-detect the package manager from the lockfile (pnpm-lock.yaml → pnpm, yarn.lock → yarn, bun.lock → bun, else npm). When false, always use npm.',
  },
};

class Quilx {
  window: ApplicationWindow | null = null;
  readonly commands = new CommandManager();
  readonly keymaps = new KeymapManager();
  readonly notifications = new NotificationManager();
  readonly agents = new AgentManager();
  readonly session = new SessionManager();
  readonly lsp = new LspManager();
  readonly config = new Config(CONFIG_SCHEMA);
  readonly workspace = new Workspace();
}

export const quilx = new Quilx();

declare global {
   
  var quilx: Quilx;
}

(globalThis as { quilx?: Quilx }).quilx = quilx;
