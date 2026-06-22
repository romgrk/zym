/*
 * default.ts — the built-in keymap, as declarative data.
 *
 * Shape: `{ selector: { keystroke: 'command:name' } }`, exactly the input
 * `zym.keymaps.add` takes. A zym component is targeted by its name with an
 * `#id` selector (`#Panel`, `#FileTree`, `#TextEditor.insert-mode`, …); a raw GTK
 * widget by its type tag (`GtkText`). The keystroke's command must be
 * registered by some component (commands live with their owner — e.g. Panel
 * registers `tab:*`, AppWindow registers `pane:*`/`file:*`). This table is the
 * single place to read or change the app's key bindings; `load.ts` registers it
 * and layers a user keymap on top.
 *
 * Subsystems that own a dynamic, mode-scoped keymap (the vim layer) register
 * their own table at load time and are intentionally not listed here.
 *
 * A binding value is a command name, or `{ command, args }` to pass arguments to
 * the command (e.g. `{ command: 'tab:go-to', args: [2] }`).
 */
import type { CommandRef } from '../KeymapManager.ts';

type Binding = string | CommandRef;

// Space-leader bindings: a `space` prefix then a mnemonic (Spacemacs-style).
// Registered on `#AppWindow` (an ancestor of everything), so the leader is
// available globally; text-input contexts release `space` with `unset!` (see
// below) so it still types literally there.
const SPACE_COMMANDS: Record<string, string> = {
  'space space': 'command-palette:toggle',
  'space w': 'file:save',
  'space o': 'file:find', // fuzzy file picker
  'space f o': 'file:find', // fuzzy file picker
  'space f e': 'file:open-path', // open by path (directory-navigating opener)
  'space /': 'project:search', // full-text search (ripgrep)
  'space *': 'project:search-results', // selected text → all matches in a multibuffer
  'space q': 'app:quit',
  'space t': 'terminal:new',
  'space p r': 'scripts:run', // "p"ackage "r"un — run a package.json script in a terminal
  'space a a': 'agent:picker', // open the agent picker (agents, conversations, new)
  'space a l': 'workbench-list:focus', // focus the workbench sidebar
  'space a n': 'agent:new', // launch a new agent
  'space a r': 'agent:rename', // rename the current agent
  'space a R': 'agent:resume-conversation', // resume a past conversation (picker)
  'space a c': 'agent:continue', // continue the latest conversation in this folder
  'space a b': 'agent:branch', // branch the current agent into a new forked agent
  'space a x': 'agent:action-run-default', // run the agent's default action (set_actions)
  'space a X': 'agent:action-picker', // pick one of the agent's actions to run
  // Send editor context to an agent: the second key picks selection (s) or file
  // (f); the third picks the current agent (repeat), one from the picker (a), or
  // a new agent with an editable prompt (n).
  'space a s s': 'agent:send-selection', // selection → current agent
  'space a s a': 'agent:send-selection-to', // selection → pick an agent
  'space a s n': 'agent:send-selection-to-new', // selection → new agent (editable prompt)
  'space a f f': 'agent:send-file', // file path → current agent
  'space a f a': 'agent:send-file-to', // file path → pick an agent
  'space a f n': 'agent:send-file-to-new', // file path → new agent (editable prompt)
  'space n': 'notifications:toggle-log', // show/hide the bottom notification log
  'space ?': 'keymap:show', // show all keybindings and their source
  // Config (space , …): the preferences editor, plus quick access to the raw user files.
  'space , ,': 'config:open-editor', // preferences editor (GNOME-style comma == settings)
  'space , k': 'keymap:open-as-text', // edit the user keymap (keymap.json)
  'space , c': 'config:open-as-text', // edit the user config (config.json)
  'space , p': 'plugin:open-manager', // plugin manager
  'space f f': 'file-tree:focus', // focus the Files tab
  'space g g': 'git-panel:focus', // focus the git (Source Control) tab
  'space g f': 'git:fetch',
  'space g l': 'git:pull', // git "l"oad / pull from upstream
  'space g p': 'git:push',
  // Diff views (space g d …): the current changes, a past commit, or this branch vs master/main.
  'space g d d': 'git:diff-current-changes', // "d"iff the current changes (continuous multibuffer / staging surface)
  'space g d c': 'git:diff-commit', // diff the last "c"ommit (HEAD, against its parent)
  'space g d b': 'git:diff-branch', // diff this "b"ranch vs master/main (PR-style)
  'space g D': 'git:diff-current', // "D"iff just the current file (working tree vs HEAD)
  'space g c': 'git:start-commit', // "c"ommit staged changes (edit the message in a tab)
  'space g C': 'git:commit-amend', // "C"ommit --amend the last commit (prefilled message)
  'space g m': 'git:show-commit', // show the commit "m"essage that last touched this line
  // File-level staging from anywhere (not just the Source Control panel).
  // "a"dd / "u"nstage sub-leaders, then "a"ll or "." for the current file.
  'space g a a': 'git:stage-all', // "a"dd "a"ll (git add -A)
  'space g a .': 'git:stage-current', // "a"dd the current file (git add <file>)
  'space g u a': 'git:unstage-all', // "u"nstage "a"ll
  'space g u .': 'git:unstage-current', // "u"nstage the current file
  // Hunk-level staging on the gutter hunk under the cursor (editor only): "s"tage,
  // "u"nstage (a staged/blue hunk), "r"evert (discard the unstaged change).
  'space h s': 'git:stage-hunk',
  'space h u': 'git:unstage-hunk',
  'space h r': 'git:revert-hunk',
  // Branch (space g b …): switch / delete / merge / rename.
  'space g b b': 'git:branch-switch', // "b"ranch picker (switch / create)
  'space g b d': 'git:branch-delete',
  'space g b m': 'git:branch-merge', // merge a branch into the current one
  'space g b r': 'git:branch-rename', // rename the current branch
  // Stash (space g s …): push / pop / apply / drop.
  'space g s s': 'git:stash-push',
  'space g s p': 'git:stash-pop',
  'space g s a': 'git:stash-apply',
  'space g s d': 'git:stash-drop',
  // GitHub (space g h …): repo / actions / issues / switch-to-PR / new PR / failed CI.
  'space g h r': 'github:repository-open',
  'space g h a': 'github:actions-open',
  'space g h i': 'github:issue-picker',
  'space g h p': 'github:pull-request-checkout', // pick a PR and switch to it
  'space g h c': 'github:pull-request-checkout',
  'space g h n': 'github:pull-request-create', // "n"ew pull request
  'space g h o': 'github:pull-request-open', // "o"pen the PR for this branch in the browser
  'space g h l': 'github:open-line', // open the current "l"ine on GitHub (permalink)
  'space g h L': 'github:open-pr-for-line', // open the PR that introduced this "L"ine
  'space g h f': 'github:failed-ci-picker',
  'space l d': 'lsp:go-to-definition', // "l"sp "d"efinition
  'space l p': 'lsp:peek-definition', // "p"eek definition inline (below the cursor)
  'space l D': 'lsp:go-to-declaration', // declaration
  'space l t': 'lsp:go-to-type-definition', // "t"ype definition
  'space l i': 'lsp:go-to-implementation', // "i"mplementation
  'space l r': 'lsp:find-references', // "r"eferences
  'space l s': 'lsp:workspace-symbols', // "s"ymbols (project-wide, via LSP)
  'space l o': 'lsp:document-symbols', // "o"utline (symbols in the current file)
  'space l k': 'lsp:hover', // hover (type / docs)
  'space l a': 'lsp:code-action', // "a"ction (quick fix / refactor)
  'space l R': 'lsp:rename', // "R"ename symbol
  'space l f': 'lsp:format', // "f"ormat document
  'space l l': 'lsp:toggle-diagnostics-panel', // "l"sp problems "l"ist
  'space s s': 'session:save', // save the workspace session
  'space s r': 'session:restore', // restore the saved session
};

// Tab navigation. alt-, / alt-. switch to the previous / next tab; alt-1..8 jump
// to a tab by index via one parameterized command (`tab:go-to` with the 0-based
// index as its argument); alt-9 jumps to the last.
const TAB_BINDINGS: Record<string, Binding> = {
  'alt-,': 'tab:previous',
  'alt-.': 'tab:next',
  // Reorder the active tab: shift of the prev/next keys moves it before/after.
  'alt-<': 'tab:move-backward',
  'alt->': 'tab:move-forward',
  'alt-9': 'tab:go-to-last',
  'alt-c': 'tab:close', // close the focused panel child
  'alt-p': 'tab:toggle-pin', // pin/unpin the active tab (pinned tabs group at the front)
};
for (let n = 1; n <= 8; n++)
  TAB_BINDINGS[`alt-${n}`] = { command: 'tab:go-to', args: [n - 1] };

// Vim-style list navigation, shared by the focusable list widgets (file tree,
// git panel, agent list). Each widget registers the `core:*` handlers; this is
// the one place the keystrokes are defined. `l` (core:right) is the per-list
// "enter/activate" action.
const LIST_NAV: Record<string, Binding> = {
  j: 'core:down',
  k: 'core:up',
  'g g': 'core:top',
  G: 'core:bottom',
  l: 'core:right',
};

export const DEFAULT_KEYMAP: Record<string, Record<string, Binding>> = {
  '#AppWindow': {
    // Vim-style split (pane) management.
    'ctrl-w v': 'pane:split-right',
    'ctrl-w s': 'pane:split-down',
    'ctrl-w c': 'pane:close',
    'ctrl-w h': 'pane:focus-left',
    'ctrl-w j': 'pane:focus-down',
    'ctrl-w k': 'pane:focus-up',
    'ctrl-w l': 'pane:focus-right',
    'ctrl-w w': 'pane:focus-next',
    'ctrl-w ctrl-w': 'pane:focus-next',
    'ctrl-w d d': 'agent:close', // close the active agent (terminate if running, then remove it)

    // Toggle a dock side's visibility (keeping its panels), by vim direction.
    'ctrl-w g h': 'dock:toggle-left',
    'ctrl-w g j': 'dock:toggle-bottom',
    'ctrl-w g k': 'dock:toggle-top',
    'ctrl-w g l': 'dock:toggle-right', // right dock = Files / Source Control

    // Cycle the active workbench (the user / each agent) — previous / next.
    'super-,': 'workbench:previous',
    'super-.': 'workbench:next',

    ...SPACE_COMMANDS,
  },

  // LSP hover on the symbol under the cursor. Bound only in normal mode so it
  // doesn't shadow typing 'K' while inserting.
  '#TextEditor.normal-mode': {
    K: 'lsp:hover',
  },

  // Tab switching, routed to whichever panel holds focus.
  '#Panel': TAB_BINDINGS,

  // File tree: shared list navigation plus tree-specific keys.
  '#FileTree': {
    ...LIST_NAV, // j/k, g g, G, l (l enters a directory / opens a file)
    h: 'core:left', // collapse a directory / go to parent
    ',': 'tree:toggle-untracked-files', // show/hide files not tracked by git
    '.': 'tree:toggle-hidden-files', // show/hide dotfiles
  },

  // Git panel: shared list navigation plus git-specific keys.
  '#GitPanel': {
    ...LIST_NAV, // j/k, g g, G, l (l opens the file under the cursor)
    s: 'git:stage', // stage the file under the cursor
    u: 'git:unstage', // unstage the file under the cursor
    A: 'git:stage-all', // stage everything (or unstage all when nothing is unstaged)
    X: 'git:discard', // restore (tracked) / delete (untracked) the file under the cursor
    'c c': 'git:commit', // commit: edit the message in a tab, save+close to commit
  },

  // Editable diff multibuffer (git:diff-current-changes): fold-style keys expand the elided `⋯`
  // unchanged lines. More specific than the vim `#TextEditor` bindings, so these win; `z z`/
  // `z t`/`z b` (scroll) aren't bound here and still fall through to vim.
  // Project-search results multibuffer: per-file (excerpt) collapse. `z a` toggles the file under
  // the cursor; `z M`/`z R` collapse/expand all. More specific than vim's `#TextEditor`, so these win.
  '#TextEditor.search-results': {
    'z a': 'search:toggle-collapse',
    'z M': 'search:collapse-all',
    'z R': 'search:expand-all',
  },
  '#TextEditor.continuous-diff': {
    'z o': 'diff:expand-context', // reveal more unchanged lines at the nearest gap
    'z R': 'diff:expand-all', // reveal all unchanged lines (show the full files)
    'z m': 'diff:collapse-context', // re-collapse expanded context
    // Hunk staging (`space h s`/`u` → git:stage-hunk/unstage-hunk) is the unified binding from
    // `#AppWindow`; it routes here automatically (this embedded editor registers no gutter
    // variant). Bare `s`/`u` are left to vim (substitute / undo) since this surface is editable.
    // `g d` jumps to the file/line under the cursor — Enter now opens the inline comment box
    // (handled directly in ContinuousDiffView), which sends the row/selection + comment to the agent.
    'g d': 'diff:open-file',
  },

  // Workbench list (the left sidebar): shared list navigation (l reveals the selected
  // agent's terminal) plus lifecycle keys acting on the selected agent.
  '#WorkbenchList': {
    ...LIST_NAV, // j/k, g g, G, l (l reveals the selected agent's terminal)
    r: 'agent:restart', // restart the selected agent (resume its conversation)
    R: 'agent:rename', // rename the selected agent
    b: 'agent:branch', // branch the selected agent into a new forked agent
    x: 'agent:stop', // stop the selected agent's process (it stays listed, restartable)
    'd d': 'agent:close', // close the selected agent (terminate if running, then remove it)
    o: 'agent:open-changes', // open the files the selected agent has edited
  },

  // Location lists (LSP diagnostics, project-wide search, …): shared navigation
  // Location lists (LSP diagnostics, project-wide search, …): shared navigation
  // (l opens the location under the cursor).
  '#LocationList': LIST_NAV,

  // The notification log: while it has focus, bare keys act on the history
  // (vim-tree style). `c` clears it; `q` hides it (same command as the leader
  // toggle). The log takes no literal text input, so single keys are safe.
  '#NotificationLog': {
    c: 'notifications:clear',
    q: 'notifications:toggle-log',
  },

  // Modal terminal (Terminal & AgentTerminal), both modes: the usual terminal
  // clipboard chords. `ctrl-c` / `ctrl-v` are taken by the shell (SIGINT / the
  // child), so copy/paste use the shifted variants, bound here so they're caught
  // before insert mode hands the key to the child.
  '.zym-terminal': {
    'ctrl-shift-c': 'terminal:copy',
    'ctrl-shift-v': 'terminal:paste',
  },

  // Modal terminal (Terminal & AgentTerminal). Normal mode hands the keyboard to
  // the app (leader / window-nav); `i` enters insert mode to type into the child.
  // Insert mode types directly; Escape returns to normal, and `ctrl-[` still sends
  // a literal Escape to the child (the usual ctrl-[ ≡ Escape, kept reachable).
  '.zym-terminal.terminal-normal': {
    i: 'terminal:insert-mode',
    a: 'terminal:insert-mode',
  },

  // AgentTerminal: a double `ctrl-d` closes the agent (terminate if running,
  // then remove). A single `ctrl-d` is held briefly (the keymap manager's
  // partial-match timeout) to see if a second follows; if not, it falls through
  // to the agent CLI as a normal EOF. Bound on the agent terminal only — a plain
  // shell terminal keeps `ctrl-d` as its immediate EOF.
  '#AgentTerminal': {
    'ctrl-d ctrl-d': 'agent:close',
  },
  // The headless claude-sdk conversation: same double-`ctrl-d` to close.
  '#AgentConversation': {
    'ctrl-d ctrl-d': 'agent:close',
  },
  '.zym-terminal.terminal-insert': {
    escape: 'terminal:normal-mode',
    'ctrl-[': 'terminal:send-escape',
    // Insert mode is a raw terminal: release `ctrl-w …` (window navigation) so the
    // child gets it (e.g. delete-word). Use normal mode to navigate windows. The
    // `space` leader is already released via `.has-text-input`.
    'ctrl-w': 'unset!',
  },

  // Plugin manager: vim-style list navigation plus expand/toggle.
  '#PluginManagerPanel': {
    j:     'plugin-manager:focus-next',
    k:     'plugin-manager:focus-prev',
    o:     'plugin-manager:toggle-expander',
    space: 'plugin-manager:toggle-switch',
  },

  // AskUserQuestion card: release the `space` leader while it's open so space
  // reaches the focused control natively — toggling the focused check/radio and
  // typing literal spaces in a note entry. (Matches via the card root class on any
  // focused descendant; the class is dropped once the question is answered.)
  '.zym-conversation-question': { space: 'unset!' },

  // Any widget that takes literal text input carries the `.has-text-input` class
  // (text entries, the terminal / agent terminal, the editor in insert mode).
  // Releasing `space` there with `unset!` lets it type a literal space instead of
  // triggering the AppWindow leader. A widget adds/removes the class itself (the
  // editor toggles it per mode), so this one rule covers them all.
  '.has-text-input': { space: 'unset!' },
};
