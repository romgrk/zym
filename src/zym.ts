/*
 * zym — the global application registry (analog to Atom's `atom` /
 * xedel's `xedel`).
 *
 * It holds the singletons the command/keymap subsystem reaches for: the command
 * manager, the keymap manager, and the active application window. The managers
 * and their helpers (`getActiveElements`, `KeymapManager`) import this singleton
 * directly; it is also attached to `globalThis.zym` so it can be inspected
 * from the console and to mirror the Atom-style global.
 *
 * The window is wired in once by `AppWindow` (`zym.window = …`) after it is
 * constructed, before `zym.keymaps.initialize()`.
 */
import type Adw from 'gi:Adw-1';
type ApplicationWindow = InstanceType<typeof Adw.ApplicationWindow>;
import { CommandManager } from './CommandManager.ts';
import { KeymapManager } from './KeymapManager.ts';
import { NotificationManager } from './NotificationManager.ts';
import { AgentManager } from './AgentManager.ts';
import { SessionManager } from './SessionManager.ts';
import { LspManager } from './lsp/LspManager.ts';
import { Workspace } from './Workspace.ts';
import { Config, type ConfigSchema } from './util/Config.ts';
import { availableThemes, DEFAULT_THEME_NAME } from './theme/theme.ts';

/*
 * The application-wide config schema (Atom's `core.*` / `editor.*`). This is the
 * general, non-vim baseline; subsystems contribute their own namespaced
 * parameters at load time via `zym.config.scope(namespace).register(...)` —
 * see `ui/TextEditor/vim/settings.ts`, which registers under `vim-mode-plus`.
 */
const CONFIG_SCHEMA: Record<string, ConfigSchema> = {
  'core.followSystemColorScheme': {
    type: 'boolean',
    default: true,
    description: 'Follow the system light/dark preference for the active theme.',
  },
  'theme.active': {
    type: 'string',
    default: DEFAULT_THEME_NAME,
    enum: availableThemes(),
    description: 'Active theme; loads <name>.json from src/theme/. Overridden by the ZYM_THEME env var. Applied at startup — restart after changing.',
  },
  'core.uiFont': {
    type: 'string',
    default: '',
    description:
      "UI (proportional) font as a Pango description, e.g. 'Cantarell 11'; empty follows the system UI font.",
  },
  'core.monospaceFont': {
    type: 'string',
    default: '',
    description:
      "Monospace font as a Pango description, e.g. 'JetBrains Mono 13'; empty follows the system monospace font.",
  },
  'keymap.partialMatchTimeoutMs': {
    type: 'integer',
    default: 1000,
    minimum: 100,
    maximum: 10000,
    description:
      'How long (ms) an incomplete multi-key chord prefix is held before it is abandoned — the keys then fall through to the focused widget (or a shorter binding fires). Longer gives more time to finish a chord; shorter lets a lone prefix key reach the widget sooner.',
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
  'editor.minimap': {
    type: 'boolean',
    default: false,
    description: 'Show the source-map minimap gutter on the right of the editor.',
  },
  'editor.diffLineNumbers': {
    type: 'boolean',
    default: false,
    description:
      'Show the old|new file line-number gutter in the diff view. The live staging diff keeps its staged/unstaged marker either way.',
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
  'editor.lineBlame': {
    type: 'boolean',
    default: false,
    description: 'Show git blame for the line under the cursor, trailing it (GitLens-style).',
  },
  'editor.lineBlameFormat': {
    type: 'string',
    default: '[message, time, author]',
    description:
      "Fields shown in the line-blame annotation, in order. Recognized tokens: message, time, author, date, sha (any surrounding punctuation is a separator).",
  },
  'editor.scrollPastEnd': {
    type: 'boolean',
    default: true,
    description: 'Allow scrolling past the end of the buffer so the last line can reach the top of the viewport.',
  },
  'editor.centerFraction': {
    type: 'number',
    default: 0.25,
    minimum: 0,
    maximum: 0.5,
    description:
      'Where a centered reveal lands the cursor: the fraction of the viewport height from the top (0 = top edge, 0.25 = a quarter down, 0.5 = the middle). Used everywhere something opens centered — vim z z, gg/G, jumping to a search match, session restore.',
  },
  'editor.languageInjections': {
    type: 'array',
    default: [],
    description:
      'User-defined syntax injections: highlight a region of one language as another. ' +
      'Each entry names the host `host` (a language id or a list, e.g. ["typescript", "tsx"]), ' +
      'a guest `language` (defaults to the marker), and one matcher: `comment` (a ' +
      '`/* css */` or `// css` comment before a backtick template), `tag` (a tagged ' +
      'template such as css`…` or styled.div`…`), or `query` (a raw tree-sitter ' +
      'injection query). ' +
      'E.g. [{ "host": ["typescript", "tsx"], "comment": "css" }, ' +
      '{ "host": "tsx", "tag": "gql", "language": "graphql" }].',
  },
  'agent.command': {
    type: 'array',
    default: ['claude'],
    description: 'Argv of the terminal agent launched by AgentTerminal (agent:new).',
  },
  'agent.implementation': {
    type: 'string',
    default: 'claude-sdk',
    description:
      "Which Claude agent host `agent:new` launches: 'claude-tui' (the terminal " +
      "TUI) or 'claude-sdk' (headless `claude -p`, natively rendered; default).",
  },
  'agent.autoOpenChangedFiles': {
    type: 'boolean',
    default: true,
    description:
      "Automatically open a file in the agent's own workbench right dock when the agent first edits it (without switching to that workbench).",
  },
  'agent.autoName': {
    type: 'boolean',
    default: false,
    description:
      'When launching an agent with a prompt, auto-generate its session name from that prompt ' +
      'via a one-shot `claude -p --model sonnet` call. An empty `/rename` triggers the same naming on demand.',
  },
  'agent.showThinking': {
    type: 'boolean',
    default: false,
    description:
      "Show the agent's dim 'thinking' (reasoning) blocks inline in the conversation transcript. " +
      'Off by default; the footer "Thinking…" status indicator is unaffected either way.',
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
  'help.showKeybindings': {
    type: 'boolean',
    default: true,
    description: 'Show keybinding hints (keycaps) in the UI, e.g. the Source Control commit box.',
  },
  'session.autosave': {
    type: 'boolean',
    default: true,
    description: 'Autosave a named session (layout, tabs, cursors) as it changes and on quit. The unnamed/default session never persists.',
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
      'Automatically install a missing language server (into a zym-managed dir) when a file needs it — shown as an info notification — instead of prompting with an Install button.',
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

class Zym {
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

export const zym = new Zym();

declare global {
   
  var zym: Zym;
}

(globalThis as { zym?: Zym }).zym = zym;
