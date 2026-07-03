/*
 * default.ts — the built-in keymap, as declarative data.
 *
 * Shape: `{ selector: { keystroke: 'command:name' } }`, exactly the input
 * `zym.keymaps.add` takes. A zym component is targeted by its CSS class
 * (`.Panel`, `.FileTree`, `.TextEditor.insert-mode`, …); a raw GTK widget by its
 * type tag (`GtkText`). The keystroke's command must be
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
// Registered on `.AppWindow` (an ancestor of everything), so the leader is
// available globally; text-input contexts release `space` with `unset!` (see
// below) so it still types literally there.
const SPACE_COMMANDS: Record<string, string> = {
  'space space': 'command-palette:toggle',
  'space w': 'file:save',
  'space o': 'file:find', // fuzzy file picker
  'space f o': 'file:find', // fuzzy file picker
  'space f e': 'file:open-path', // open by path (directory-navigating opener)
  'space f m': 'file:move', // move the current file to another folder (folder picker)
  'space f r': 'file:rename', // rename/relocate the current file

  'space /': 'project:search', // full-text search (ripgrep) — quick-jump picker
  'space *': 'project:search-results', // selected text → all matches in the search multibuffer
  'space p s': 'project:search-open', // open the project-search multibuffer (search entry + flags)
  'space q': 'app:quit',
  'space t': 'terminal:new',
  'space p r': 'scripts:run', // "p"ackage "r"un — run a package.json script in a terminal
  'space a a': 'agent:picker', // open the agent picker (agents, conversations, new)
  'space a l': 'workbench-list:focus', // focus the workbench sidebar
  'space a w': 'workbench:picker', // switch to a workbench (the user / an agent)
  'space a n n': 'agent:new', // launch a new agent
  'space a n w': 'agent:new-worktree', // launch in a fresh worktree
  'space a n e': 'agent:new-in-worktree', // launch in an existing worktree
  'space a n .': 'agent:new-this-worktree', // launch in the current worktree
  'space a r': 'agent:rename', // rename the current agent
  'space a R': 'agent:resume-conversation', // resume a past conversation (picker)
  'space a b': 'agent:branch', // branch the current agent into a new forked agent
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
  'space g v': 'git:log', // open the git log (history) "v"iewer
  // Diff views (space g d …): the current changes, a past commit, or this branch vs master/main.
  'space g d d': 'git:diff-current-changes', // "d"iff the current changes (continuous multibuffer / staging surface)
  'space g d c': 'git:diff-commit', // pick a "c"ommit to diff (against its parent)
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
  // "u"nstage (a staged/blue hunk), "r"evert (discard the unstaged change), "n" stage + advance
  // to the next hunk (the fast review-and-stage flow in the continuous diff; `ctrl-]` is a
  // single-chord alternative, bound under `.TextEditor.continuous-diff.normal-mode`).
  'space h s': 'git:hunk-stage',
  'space h u': 'git:hunk-unstage',
  'space h r': 'git:hunk-revert',
  'space h n': 'git:hunk-stage-next',
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
  'space s s': 'session:save', // save the session (names it if unnamed)
  'space s a': 'session:save-as', // save the session under a name
  'space s o': 'session:open', // open a saved session
  'space s R': 'session:rename', // rename the current session
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
  'alt-C': 'tab:reopen-last', // shift mirror of alt-c: bring back the last closed tab
  'alt-p': 'tab:toggle-pin', // pin/unpin the active tab (pinned tabs group at the front)
};
for (let n = 1; n <= 8; n++)
  TAB_BINDINGS[`alt-${n}`] = { command: 'tab:go-to', args: [n - 1] };

// Workbench actions (`space x …`): the active workbench's runnable set
// (docs/workbench.md). `space x x` runs the first/default action; `space x 1`
// … `space x 9` run the Nth (one parameterized `workbench:action-run` with the
// 1-based index); `o` picks from a list, `e` edits the project file, `r` resets the
// live set to it. Kept out of the string-only SPACE_COMMANDS map because the numeric
// bindings carry an `args` payload.
const WORKBENCH_ACTIONS: Record<string, Binding> = {
  'space x x': { command: 'workbench:action-run', args: [1] }, // run the first (default) action
  'space x o': 'workbench:action-picker', // pick an action to run
  'space x e': 'workbench:action-edit', // edit the project settings (.zym/settings.json)
  'space x r': 'workbench:action-reset', // reset the live set to the project defaults
};
for (let n = 1; n <= 9; n++)
  WORKBENCH_ACTIONS[`space x ${n}`] = { command: 'workbench:action-run', args: [n] };

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
  '.AppWindow': {
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
    'ctrl-w g a': 'agent-sidebar:toggle', // the agent "secondary sidebar"
    'ctrl-w g s': 'sidebar:toggle', // the workbench sidebar (left-most column)

    // Cycle the active workbench (the user / each agent) — previous / next.
    'super-,': 'workbench:previous',
    'super-.': 'workbench:next',

    ...SPACE_COMMANDS,
    ...WORKBENCH_ACTIONS,
  },

  // LSP navigation on the symbol under the cursor. Normal mode only so the bare keys
  // don't shadow typing 'K'/'g d' while inserting. `g d`/`g D` mirror vim's goto-(local/
  // global)-declaration; the leader equivalents are `space l d`/`space l D`.
  '.TextEditor.normal-mode': {
    K: 'lsp:hover',
    'g d': 'lsp:go-to-definition',
    'g D': 'lsp:go-to-declaration',
  },

  // Comment the current line / selection to an agent (file editors only — `editor:comment` is
  // registered just on commenting-enabled editors, so it's inert elsewhere). `enter` in normal mode
  // / on a visual selection opens the inline box; insert-mode `enter` stays a newline. `:not(.zym-input)`
  // keeps it off inputs/pickers. Mirrors the diff's `enter`-opens-the-comment-box gesture.
  '.TextEditor.normal-mode:not(.zym-input)': {
    enter: 'editor:comment',
  },
  '.TextEditor.visual-mode:not(.zym-input)': {
    enter: 'editor:comment',
  },

  // Tab switching, routed to whichever panel holds focus.
  '.Panel': TAB_BINDINGS,

  // File tree: shared list navigation plus tree-specific keys.
  '.FileTree': {
    ...LIST_NAV, // j/k, g g, G, l (l enters a directory / opens a file)
    h: 'core:left', // collapse a directory / go to parent
    ',': 'tree:toggle-untracked-files', // show/hide files not tracked by git
    '.': 'tree:toggle-hidden-files', // show/hide dotfiles
  },

  // Git panel change list: shared list navigation plus git-specific keys. Scoped to the
  // list (.GitPanelList), NOT the panel root (.GitPanel), so the bare keys don't fire while
  // the embedded diff editor is focused.
  '.GitPanelList': {
    ...LIST_NAV, // j/k, g g, G, l (l opens the selected change's diff via core:right)
    o: 'git:open-diff', // open the selected change's diff (like `l`)
    enter: 'git:open-diff',
    s: 'git:stage', // stage the file under the cursor
    S: 'git:stage-all', // stage every change (git add -A)
    u: 'git:unstage', // unstage the file under the cursor
    U: 'git:unstage-all', // unstage every change (git reset)
    X: 'git:discard', // restore (tracked) / delete (untracked) the file under the cursor
    'c c': 'git:commit', // commit the staged changes (embedded editor)
  },

  // Move between the panel's two "windows" — the change list and the embedded diff — with vim's
  // `ctrl-w` direction keys (mirrors the git-log viewer). Override only the INWARD direction on
  // each side (`ctrl-w l` list→diff, `ctrl-w h` diff→list); the outward direction falls through
  // to `.AppWindow` pane nav. Both selectors outrank `.AppWindow` by CSS specificity (two classes vs one).
  '.GitPanel .GitPanelList': {
    'ctrl-w l': 'git-panel:focus-diff',
  },
  '.GitPanel .TextEditor': {
    'ctrl-w h': 'git-panel:focus-list',
  },
  // `q` closes the embedded diff (collapse back to the list). Normal-mode only — so it doesn't
  // shadow typing 'q' while editing the diff — and more specific than vim's bare `q` (macro
  // record) only inside the GitPanel's diff. `:not(.GitCommitInput)` keeps it off the commit
  // editor (which binds its own `q` to cancel below).
  '.GitPanel .TextEditor.normal-mode:not(.GitCommitInput)': {
    q: 'git-panel:close-diff',
  },

  // The embedded commit editor (the vertical split above the list): `ctrl-enter` commits,
  // `alt-enter` inserts a newline (plain `enter` stays a newline — commit messages are
  // multi-line), and `q`/`escape` in normal mode cancels. Scoped to `.GitCommitInput` so these
  // don't collide with the diff's keys (and vice-versa, via the `:not` above).
  '.GitPanel .GitCommitInput': {
    'ctrl-enter': 'git-commit:submit',
    'alt-enter': 'git-commit:newline',
  },
  '.GitPanel .GitCommitInput.normal-mode': {
    q: 'git-commit:cancel',
    escape: 'git-commit:cancel',
  },

  // Editable diff multibuffer (git:diff-current-changes): fold-style keys expand the elided `⋯`
  // unchanged lines. More specific than the vim `.TextEditor` bindings, so these win; `z z`/
  // `z t`/`z b` (scroll) aren't bound here and still fall through to vim.
  // Project-search results multibuffer: per-file (excerpt) collapse. `z a` toggles the file under
  // the cursor; `z M`/`z R` collapse/expand all. More specific than vim's `.TextEditor`, so these win.
  '.TextEditor.search-results': {
    'z a': 'search:toggle-collapse',
    'z M': 'search:collapse-all',
    'z R': 'search:expand-all',
  },
  // Scoped to `.normal-mode` so the `z`/`g` prefixes don't shadow typing those characters while
  // inserting (this surface is editable) — same reason `K: lsp:hover` is normal-mode only.
  '.TextEditor.continuous-diff.normal-mode': {
    // Per-FILE folding, vim-style: `z c`/`z o` close/open the file under the cursor, `z a` toggles
    // it, `z r`/`z m` open/close every file. (Revealing the elided unchanged lines at a `⋯` gap is
    // a click on the gap marker — `z o` is the file open now, not the context expand.)
    'z c': 'diff:collapse-file',
    'z o': 'diff:expand-file',
    'z a': 'diff:toggle-file',
    'z r': 'diff:expand-all-files',
    'z m': 'diff:collapse-all-files',
    // `z x` collapses every file matching a comma-separated glob (typed into a picker; `!` negates).
    'z x': 'diff:collapse-files-matching',
    // `z j`/`z k` step between files; `z /` opens a picker to jump to one.
    'z j': 'diff:next-file',
    'z k': 'diff:prev-file',
    'z /': 'diff:go-to-file',
    // Reveal the elided unchanged lines at a `⋯` gap (`.` mirrors the dots): `z .` expands the
    // nearest gap a chunk at a time, `z >` reveals the whole files, `z <` re-collapses to the
    // windowed diff. (Clicking a `⋯` marker also expands it.)
    'z .': 'diff:expand-context',
    'z >': 'diff:expand-all',
    'z <': 'diff:collapse-context',
    // Hunk staging (`space h s`/`u` → git:hunk-stage/git:hunk-unstage) is the unified binding from
    // `.AppWindow`; it routes here automatically (this embedded editor registers no gutter
    // variant). Bare `s`/`u` are left to vim (substitute / undo) since this surface is editable.
    // `g d` jumps to the file/line under the cursor — Enter now opens the inline comment box
    // (handled directly in DiffView), which sends the row/selection + comment to the agent.
    'g d': 'diff:open-file',
    // `[h`/`]h` move across the diff's own hunks. They override vim's gutter-based
    // MoveToPrevious/NextHunk (1 id + 1 class), which no-ops in this gutterless multibuffer.
    '] h': 'diff:next-hunk',
    '[ h': 'diff:prev-hunk',
    // `ctrl-]` is a single-chord alternative to `space h n` (stage the hunk + advance to the next).
    'ctrl-]': 'git:hunk-stage-next',
  },

  // Workbench list (the left sidebar): shared list navigation (l reveals the selected
  // agent's terminal) plus lifecycle keys acting on the selected agent.
  '.WorkbenchList': {
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
  '.LocationList': LIST_NAV,

  // Git log (history) viewer — bound to the list (not the whole view) so the bare
  // keys don't type into the search field above it. Shared list navigation (which
  // also live-previews the diff in the right pane) plus o/Enter to open the selected
  // commit's diff and focus it (l does the same via core:right), and `/` to filter.
  '.GitLogList': {
    ...LIST_NAV, // j/k, g g, G, l (l opens the selected commit)
    o: 'git-log:open',
    enter: 'git-log:open',
    '/': 'git-log:search',
    'y y': 'git-log:copy-sha', // yank the selected commit's short hash
    R: 'git-log:revert', // revert the selected commit (confirms first)
  },

  // The git log's filter field: Down/Enter/Escape drop focus into the results list
  // (the bare list keys are scoped to .GitLogList, so they type here as normal).
  '.GitLogSearch': {
    down: 'git-log:focus-list',
    enter: 'git-log:focus-list',
    'kp_enter': 'git-log:focus-list',
    escape: 'git-log:focus-list',
  },

  // Move between the viewer's two nested "windows" — the commit list and the embedded
  // diff editor — with vim's `ctrl-w` direction keys. Since every bare key inside a
  // TextEditor is taken by vim (escape included), the way out of the embedded editor has
  // to be a chord; `ctrl-w h`/`l` reuse the window-nav vocabulary. We override only the
  // INWARD direction on each side (`ctrl-w l` list→diff, `ctrl-w h` diff→list); the
  // outward `ctrl-w h`/`ctrl-w l` fall through to `.AppWindow` pane nav, so this reads as
  // a nested split, not a special case. Both selectors outrank `.AppWindow` by CSS
  // specificity (two classes vs one).
  '.GitLogView .GitLogList': {
    'ctrl-w l': 'git-log:focus-diff',
  },
  '.GitLogView .TextEditor': {
    'ctrl-w h': 'git-log:focus-list',
  },

  // The project-search query field: Down/Enter drop focus into the results multibuffer,
  // keeping the query (so you can browse/edit without reaching for the mouse).
  '.ProjectSearchEntry': {
    down: 'project-search:focus-results',
    enter: 'project-search:focus-results',
    'kp_enter': 'project-search:focus-results',
  },

  // The notification log: while it has focus, bare keys act on the history
  // (vim-tree style). `c` clears it; `q` hides it (same command as the leader
  // toggle). The log takes no literal text input, so single keys are safe.
  '.NotificationLog': {
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
  '.AgentTerminal': {
    'ctrl-d ctrl-d': 'agent:close',
  },
  '.AgentConversation': {
    'ctrl-d ctrl-d': 'agent:close',
  },
  '.AgentConversation .conversation-prompt .TextEditor': {
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
  '.PluginManagerPanel': {
    j:     'plugin-manager:focus-next',
    k:     'plugin-manager:focus-prev',
    o:     'plugin-manager:toggle-expander',
    space: 'plugin-manager:toggle-switch',
  },

  // AskUserQuestion card: release the `space` leader while it's open so space
  // reaches the focused control natively — toggling the focused check/radio and
  // typing literal spaces in a note entry. (Matches the card root from any focused
  // descendant; the `is-open` state is dropped once the question is answered.)
  '.Question.is-open': { space: 'unset!' },

  // Any widget that takes literal text input carries the `.has-text-input` class
  // (text entries, the terminal / agent terminal, the editor in insert mode).
  // Releasing `space` there with `unset!` lets it type a literal space instead of
  // triggering the AppWindow leader. A widget adds/removes the class itself (the
  // editor toggles it per mode), so this one rule covers them all.
  '.has-text-input': { space: 'unset!' },
};
