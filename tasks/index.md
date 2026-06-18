# Tasks

Each task can have its own page with research, design, and implementation details.
File names mirror the header structure, e.g. `git.md` for the git section, `code-editing/lsp-integration.md` for the LSP integration section, etc. When a header has more than one subheader, it becomes a directory with an `index.md` file for the main section.

The task documents should be updated as the implementation progresses, with notes on research findings, design decisions, and implementation details. This will help keep track of the progress and provide context for future reference.

## Architecture

### Commands & keymaps

See [commands-keymaps.md](commands-keymaps.md). Done: commands with
args/descriptions/`when`, keymaps with sequences/priority/`unset!`, `#id`
selectors, user `keymap.json` (live-reloaded), command palette (shortcuts,
name+description search, dim-when-unavailable), which-key hints (currently
disabled — `WhichKey` constructor skips the `onPendingChanged` subscription;
re-enable in `src/ui/WhichKey.ts`), conflict detection, keymap reference panel
(all bindings + source, `space ?`). Remaining: `when` keymap fall-through;
keybinding editing UI.

### Panels & layout

See [panels.md](panels.md) for the `Panel` / `PanelGroup` / dock model: single
active panel = focus container (overlay exception), root-focusable panels,
focus-driven `.active-empty` outline, `.is-panel-child` invariant, the tab-bar
rules (`requireTabBar`, non-expanding tabs), and the zombie-safe dock-close rule
(bottom docks veto-hide; side docks per-tab close + re-root-before-re-add).

### Styling & theming

See [styling.md](styling.md) for how UI styling works: GTK CSS (`addStyles` /
`styles.set`) vs. inline Pango markup, the shared `window` CSS custom properties
(`--popover-radius`, `--font-size-small`, …), the one-secondary-text-size font
rule, `theme.ui` color tokens, Nerd Font icons, and `.linked` button groups.

See [theming.md](theming.md) for the **owned theme format** (no longer Zed's):
concern-first `ui` keys with longest-prefix fallback, per-capture `syntax`
tokens, the loader (`src/theme/theme.ts`) + JSON Schema (`theme.schema.json`),
and diff tints derived from the `status.*` colors.

### Plugin system

See [plugins.md](plugins.md) for the architecture (Atom-inspired) and
[plugin-creation.md](plugin-creation.md) for the step-by-step guide to adding one.
A plugin is a manifest + `activate(ctx)`/`deactivate`; the `PluginContext` exposes
disposable-tracked contribution points (languages/grammars/LSP servers, keymaps,
commands, config schema, stylesheets, `observeTextEditors`) so deactivation tears
everything down. The `PluginRegistry` (`quilx`-level `plugins` singleton) owns
activation state.

- [x] **Plugin core** — `src/plugin/` (`types.ts`, `PluginContext.ts`,
  `PluginRegistry.ts`, `index.ts`). Contribution registries made
  disposable-aware: `LanguageRegistry.register*` return Disposables,
  `Config.removeSchema`, `styles.addRemovable` (queue-or-install, removable),
  `grammar.clearGrammar`. Keymaps/commands already returned Disposables.
- [x] **First plugin: TypeScript** — `src/plugins/typescript/` (the former
  `src/lang/builtin.ts`). Contributes the TS/JS/TSX detection, tree-sitter
  grammars (queries vendored under `queries/`, `GrammarDef.highlightsPath`), and
  the flow/tsserver/deno/eslint server candidates. Activated at startup
  (`src/index.ts`: `registerBuiltinPlugins()` → `plugins.activateAll()`) before
  `preloadGrammars`, so the registry is populated before anything reads it.
- [x] **HTML plugin** — `src/plugins/html/`. Detection (`.html`/`.htm`/`.xhtml`),
  the bundled `tree-sitter-html` grammar (highlights + folds, palette-adapted),
  and the `vscode-html-language-server` (single-file). Exercises *cross-plugin
  injections*: `<style>` → a CSS grammar this plugin vendors injection-only, and
  `<script>` → the TypeScript plugin's tsx grammar (`js`), each a no-op if its
  guest grammar isn't registered.
- [x] **More bundled plugins** (`registerBuiltinPlugins()` in `src/plugin/index.ts`
  registers all 9): **markdown** (LSP + config + vendored block/inline grammars +
  image preview), **css** (CSS/SCSS/Sass; bundled + vendored grammars), **json**
  (JSON/JSONC), **cpp** (C/C++; clangd), **rust** (rust-analyzer), **python**
  (pyright/pylsp/ruff), and **color-preview** (the `observeTextEditors` reference
  consumer — no language layer). See [plugins.md](plugins.md) → Bundled plugins.
- [ ] UI-component / panel contributions (register a `Panel`/dock widget).
- [ ] Snippets, menus, and command-palette categories as contribution points.
- [ ] Out-of-repo plugin discovery + loading (npm-style packages, a manifest
  file), enable/disable persisted to config, and a plugin-manager UI.
- [ ] Per-plugin config namespace + settings UI integration.

## System integration

See [system-integration.md](system-integration.md) for how quilx should track the
desktop's appearance and fonts, with the rule that **OS font/theme changes are
followed through at runtime** (no restart).

- [x] Editor scheme follows the OS light/dark preference (`notify::dark`), when the theme defines no background; terminal inherits libadwaita colors.
- [x] **Color palette centralized** — all colors come from `theme.ui.*` (resolved at load via concern-first keys + `DEFAULT_UI`; no inline literals outside `src/theme/`). Tokens: `shadow`/`flash`/`diff*` (derived from `status.*`)/`pr*`; regex highlighting folds into `theme.syntax`. Prereq for live theme-swap; lint guardrail still TODO.
- [x] **Own the theme format** — replaced the Zed theme-family adapter with a native loader + `theme.schema.json` (concern-first `ui` keys, per-capture `syntax` tokens). See [theming.md](theming.md).
- [ ] Follow OS **monospace** font changes live (editor, terminal, pickers — currently read once at startup).
- [ ] Follow OS **UI** font changes live (proportional text — currently read once).
- [ ] Follow OS **light/dark** through the quilx theme palette (swap between a light/dark theme file pair selected by `appearance`; chrome/syntax/picker colors re-apply), and wire the dead `core.followSystemColorScheme` config.
- [ ] Central `Gio.Settings`/`Adw.StyleManager` watcher that emits font/appearance-changed signals instead of per-widget one-shot reads.

## Git

See [git/index.md](git/index.md) for the architecture and per-feature status.

- [x] **Status viewer** — `GitPanel` (`src/ui/GitPanel.ts`), a sibling tab of the
  file tree; staged/changes/untracked lists with stage/unstage/discard/stage-all,
  cursor nav + bare-key bindings.
- [x] **Staging view + hunk staging** — `GitStagingView` (`src/ui/GitStagingView.ts`,
  `space g o`): a tab with an inline read-only `DiffViewer` accordion per file
  (`o` expands). Hunk-level stage/unstage/revert is in the editor diff gutter
  (`GitGutter.stageHunk`/`unstageHunk` via `git apply --cached`; `space h s`/`u`/`r`).
- [x] **Commit interface** — `c c` opens `.git/COMMIT_EDITMSG` in a normal editor
  tab; save+close commits (`git commit -F`). No amend/sign-off yet.
- [x] **GitHub forge** — `src/git/github.ts` + `GithubButtons`/pickers (via `gh`):
  open repo/actions/issues, PR + CI status in the header, PR/issue/CI pickers,
  create/checkout PR; remote resolved `upstream`→`origin` (`git.remotes.*` config).
  Remaining: `#123`-in-text detection, open file/line on web, GitLab.
- [x] **Branch** (switch/create/delete/merge/rename) + **stash**
  (push/pop/apply/drop) pickers; per-line **diff gutter** in the editor.
- [x] **Backend** — fully git-CLI now (libgit2/Ggit removed). `src/git/cli.ts`
  (`gitSync`/`git`, porcelain-v2 status parsing); `src/git.ts` exposes the
  `GitRepo` interface backed by `CliGitRepo`, with `acquireGitRepo`/`releaseGitRepo`
  pooling one polling repo per root.

## Code editing

### LSP integration

See [code-editing/lsp-integration.md](code-editing/lsp-integration.md) for the design and decisions.

- [x] **Restructure:** grammar + LSP unified under a `LanguageRegistry` (the plugin seam); curated hand-authored server defs (now contributed by the TypeScript plugin, `src/plugins/typescript/` — see [plugins.md](plugins.md)); runtime Helix fetch dropped; **per-project server selection** (flow vs tsserver vs deno, + additive linters) via root-marker activation + exclusion groups + priority; user overrides (`lsp.servers`/`lsp.disabledLanguages`). See [code-editing/language-config.md](code-editing/language-config.md).
- [x] LSP client + per-(server,root) lifecycle with crash recovery (exponential-backoff restart) and trace logging. **Incremental** document sync (full-text fallback). Correct LSP `languageId` (`.tsx`→typescriptreact, `.js`→javascript, …). See `src/lsp/`.
- [x] Server→client requests answered: `workspace/configuration` (from `ServerDef.settings`), `client/(un)registerCapability`, `workDoneProgress/create`; `window/showMessage` surfaced, error `logMessage` to the trace log. File watching: dynamically-registered `workspace/didChangeWatchedFiles` via a per-dir `WorkspaceWatcher` (excludes node_modules/.git).
- [x] Diagnostics integration (gutter, inline, panel) — custom-drawn Cairo squiggles (`UnderlineOverlay`), Nerd-Font gutter glyphs, a "Diagnostics" panel (shared `LocationList`). Namespaced by `(server, path)` and merged.
- [x] Go to shortcuts — definition/declaration/type-definition/implementation + find-references (`space l d`/`D`/`t`/`i`/`r`); jumps reveal an already-open tab.
- [x] Hover tooltips — `space l k` / vim `K`; markdown card above the cursor, code blocks syntax-highlighted by reusing tree-sitter, in the editor monospace.
- [x] Server install — `ServerDef.install` (npm / raw command) → `lsp/installer.ts` installs into a managed dir (`$XDG_DATA_HOME/quilx/lsp/<server>`), searched + on the spawn PATH. Triggers: "Install" button on the missing-server warning, `lsp:install-server` picker, and `lsp.autoInstall` (default off). Missing servers are skipped (not crash-looped); the warning names the exact missing binary.
- [x] Code actions — `textDocument/codeAction` (+ resolve) → pick (`space l a`) and apply via the shared `WorkspaceEdit` applier (`lsp/workspaceEdit.ts`: `applyTextEdits`/`normalizeWorkspaceEdit`; open editors edited in-buffer, others on disk).
- [x] Rename — `textDocument/rename` (+ `prepareRename`); `space l R` prompts (prefilled with the symbol) → applies the multi-file `WorkspaceEdit`.
- [x] Formatting — `textDocument/formatting` (+ range); `space l f` applies the edits to the buffer. Options from `editor.tabLength`/`insertSpaces`.
- [x] Completion — `textDocument/completion` (+ resolve, auto-import `additionalTextEdits`, `textEdit` ranges). See the Autocompletion section.
- [x] Signature help — `textDocument/signatureHelp`; floating card while typing call args, anchored at the callee name, active parameter bold, syntax-highlighted. Backend in `src/lsp/`; card in `TextEditor`.
- [x] Document symbols (`DocumentSymbolPicker`) + workspace symbols (`WorkspaceSymbolPicker`); inlay hints (`InlayHintController`, `editor.inlayHints`) and diagnostic **error-lens** trailing text (`editor.errorLens`), both via `VirtualText` (EOL `GtkSourceAnnotations`).
- [ ] Later: semantic tokens, document highlight, format-on-save, command-only code actions (`workspace/executeCommand`) + `WorkspaceEdit` resource ops (create/rename/delete file).

### Grammar

- [ ] More default grammars
- [x] **Language injection** (embedded languages) — done; see
  [code-editing/syntax-injection.md](code-editing/syntax-injection.md). The
  highlighter gathers base + injected captures into one paint sweep; grammars
  declare `injections` on their `GrammarDef` (guest resolved through the shared
  `LanguageRegistry`, so it's cross-plugin). **Markdown** is fully working: block +
  inline grammars vendored (built via the plugin's own `build-grammars.sh`), and
  fenced ```` ```lang ```` blocks highlight through the contributing language's
  grammar (e.g. ```` ```ts ```` → the TypeScript plugin's grammar).
- [x] **Styled tags** — highlight tags carry font styling (bold/italic/underline/
  strikethrough/`scale`/background) via `theme.syntaxStyle`, not just foreground
  color, so headings render bold + larger (per level: h1 1.5 / h2 1.2 / h3+ 1.1),
  **strong**/*emphasis*/~~strike~~ as such, and code with a background. Benefits
  every language; Markdown is the forcing function. Markdown queries cover
  headings/emphasis/strike/code/links/lists/GFM task-lists/tables/inline-HTML.
- [x] **Soft-wrap** (`editor.softWrap`, on by default) — long lines wrap to the
  editor width. Vim display-line motion (`j`/`k`/`gj`/`gk`) is wrap- and
  scaled-heading-aware: `EditorModel.displayLineMove` moves by one display row via
  `forward/backward_display_line` + a mid-row re-snap. See syntax-injection.md.

### Autocompletion

See [code-editing/autocompletion.md](code-editing/autocompletion.md).

- [x] Framework: source contract (`CompletionSource`), coordinator (`CompletionController` — insert-mode triggers, debounce, rank, sync-immediate/async-awaited, accept/navigate/dismiss keys), and keyboard-driven popup (`CompletionPopup`).
- [x] Fuzzy matching: reuse the picker's fzy scorer (`fuzzyMatch`, subsequence + 1 typo) for ranking, with matched-character highlighting in the popup.
- [x] Popup: theme background, word-start alignment, square selection, compact (no min-height), and a split documentation pane (`CompletionItem.documentation`).
- [x] Buffer-words source (`createBufferWordsSource`) — the first real source.
- [x] LSP source (`createLspCompletionSource`): `textDocument/completion` via the primary server → framework items (kind, detail, `documentation` feeds the doc pane). `LanguageServer.completion`/`hasCompletion`/`completionTriggerCharacters`; `LspManager.completion`. Trigger-character support added to the controller (`.`/`::` etc., sourced from the server) so member completion fires on an empty prefix.
- [x] Source ranking: `CompletionSource.priority` (default 0); a higher-priority source ranks entirely above lower ones (score/`sortText` order within a source). LSP is `priority: 100`, so it sits above buffer-words — which also keeps the buffer-words fallback out of the way on empty-prefix member completion.
- [x] Per-item source tag (`CompletionItem.source`, stamped by the controller) shown dimmed in the popup — debug aid for which source produced each candidate.
- [x] Auto-imports: an accepted item's `additionalEdits` (LSP `additionalTextEdits`, fetched via resolve) apply on accept — e.g. the `import` line for a cross-module symbol (tsserver `includeCompletionsForModuleExports`). Honors `textEdit` ranges via `replaceRange`.
- [ ] More sources: Copilot (ghost text).
- [ ] Widget polish: kind icons, scroll-into-view, mouse, flip-above.
- [ ] Behavior: snippet insertion, eagerness config; de-dupe identical labels across sources.

### Text editor

See [code-editing/text-editor.md](code-editing/text-editor.md) for the widget evaluation (GtkSourceView vs. custom/Rust), the shared editor-layer primitives, and the prioritized "What's next".

The widget question is settled (**stay on GtkSourceView + emulate**), and the A2 document model, multi-cursor, vim mode, diff, folding, and inline widgets have all shipped (see below). Remaining editor work is mostly polish and the future inline-widget consumers. (The vim `:` ex-command line is **won't-do** — see text-editor.md.)

Shared primitives now in place (in `EditorModel` / `TextDecorations`):

- [x] Buffer change events (`EditorModel.onDidChangeText`, Atom shape) — drives LSP didChange, vim undo/redo, and multi-cursor live edit-replication.
- [x] Viewport + pixel geometry (`getFirst/LastVisibleScreenRow`, `pixelRectForBufferPosition`) — for hover/code-action popovers, vim H/M/L, scroll commands. (Realized-view paths need interactive verification.)
- [x] Inline decoration surface (`editor.decorations` — clearable tag layers) — for search highlights and inline diff. (Diagnostic squiggles are custom-drawn via `UnderlineOverlay`; gutter icons + virtual text land with their consumers.)

Features:

- [~] Consider a custom widget or a fork of GtkSourceView for better control and features. Research how to implement features like multiple cursors, rectangular selection, and better performance with large files. Consider a JS widget, or a Rust widget with a JS wrapper. — **Decided: stay on GtkSourceView and emulate (Option A).** Multi-cursor + blockwise are now built on top (virtual selection/cursor mark pairs via `MarkerLayer`, surfaced through the array-shaped `getCursors()`/`getSelections()`); see Vim mode below. A custom/Rust widget remains a gated escape hatch only if long single lines become intolerable (see text-editor.md).
- [x] Diff display (unified + side-by-side) — see [code-editing/diff.md](code-editing/diff.md). Synthesized read-only buffers + decorations + diff gutter + scroll-sync (sidesteps GtkTextView's lack of virtual lines). `DiffModel`/`splitSides` (computeDiff + word-level intra-line diff, unit-tested); `DiffView` (unified) + `SideBySideDiffView` (scroll-synced, Tab switches panes); `DiffViewer` wrapper (stats header, icon toggle, hunk nav); per-pane syntax highlighting; full-line backgrounds; fold-unchanged (`foldUnchanged` collapses long context runs to a `⋯ N unchanged lines` row via the editor's fold projection, both panes in lockstep); `git:diff-current` (`space g d`) → working-tree vs HEAD in a tab. Remaining: more git diff sources (commit/PR). (Try it: `node scripts/diff-demo.ts`.)
- [x] Search interface — `SearchBar` (top-right) + `SearchController` over `EditorModel.scan`: case/regex toggles, replace + replace-all, highlights via `editor.decorations`. Bound to vim `/` `?` `n` `N`.
- [x] **Code folding (single-line, navigable)** — view-side text *projection*: a model range is physically collapsed to a `[N]` placeholder in the view buffer (model stays source of truth + view↔model translation), so `import {[N]} from 'x'` is one real navigable line. Fold style is grammar-declared in `folds.scm` (`@fold` joins the footer; `@fold.keepFooter` keeps `} else {`-style chains on their own line — TS/TSX, Rust, and C/C++ ship keep-footer queries). See [code-editing/folding.md](code-editing/folding.md). Reusable for any "show less than the model" marker. Remaining: fold persistence across reload.
- [~] Inline widgets / virtual lines — three mechanisms (see [code-editing/inline-widgets.md](code-editing/inline-widgets.md) and the API survey in [virtual-lines.md](code-editing/virtual-lines.md)). **Done:** `BlockDecorations` (text-window `add_overlay`, scrolls natively, non-interactive) → **markdown image preview** (`plugins/markdown/imagePreview.ts`); `Peek` (sibling `Gtk.Overlay` child positioned via `get-child-position`, focusable, no IM leak) → **see-definition** (`lsp:peek-definition` / `space l p`) — now a **live** read-only view of the file's shared `Document` when open, snapshot otherwise (the document-registry refactor shipped); `VirtualText` (EOL `GtkSourceAnnotations`) → inlay hints + error-lens. The focusable peek path required a node-gtk fix (`get-child-position` out-struct, **#444 / PR #445**). **Remaining:** polish (center the def slice, jump-to button) and the future consumers below.
  - Future consumers (ideas to split; detail + infra-reuse + priority in [inline-widgets.md](code-editing/inline-widgets.md)):
    - [x] **Error lens** — diagnostic message as trailing text (`VirtualText`, `editor.errorLens`; in `DiagnosticsView`).
    - [ ] **Code lens** — `N references` / `run·debug` above a symbol, clickable (block, `placement: above`; LSP `codeLens`). *med*
    - [ ] **Inline AI ghost text** — multi-line agent completion preview below the cursor (block; agents). *higher*
    - [~] **Color swatch / image / math preview** — under CSS colors / markdown `![img]` / `$$` (block). Color swatch = `color-preview` plugin; **markdown image preview built** (`plugins/markdown/imagePreview.ts`, local images, `markdown.imagePreview`). Math/remote-image deferred. *low–med*
    - [ ] **Peek references / implementations / type-def** — list + preview inline (peek; reuses find-references). *med — natural next*
    - [ ] **Inline AI edit (Cmd-K)** — focusable prompt under the line → apply as diff (peek; agents). *higher; distinctive*
    - [ ] **Peek commit / blame diff** — inline `DiffViewer` below a line (peek; diff viewer + git). *med*
    - [ ] **Inline rename** — small inline editor for LSP rename + preview (peek). *med*
    - [x] **EOL trailing text** (`VirtualText` over `GtkSourceAnnotations`) — built; powers inlay hints + error-lens. Remaining idea: git blame.
- [x] Document registry — `Document` (buffer + syntax + LSP + modified + undo) split from the `TextEditor` view via `DocumentRegistry` (ref-counted `acquire`/`release`), N views per document, each with its own native `GtkSource.Buffer`/cursor (the A2 model). Enables the live see-definition peek and split-view-of-same-file. See [code-editing/document-registry.md](code-editing/document-registry.md).

#### Vim mode

Custom modal editing ported from Atom's vim-mode-plus, driven by quilx's
CommandManager/KeymapManager over an `EditorModel` shim (see `src/ui/TextEditor/vim/`).
It replaced `GtkSource.VimIMContext` and is now the default (no flag).

- [x] Initial implementation derived from Atom's vim-mode-plus
- [x] Motions, operators, text-objects, visual mode, registers, marks, counts, dot-repeat
- [x] find-char (f/F/t/T/;/,), case ops (gU/gu/g~), surround (ys/ds/cs), indent/outdent/join
- [x] System clipboard integration; register prefix (`"`)
- [x] Make custom vim the default; remove GtkSource.VimIMContext
- [~] `:` ex-command line — **won't do** (save/close/open/search reachable via `space w` / `tab:close` / `space o` / SearchBar; see text-editor.md)
- [x] `/` `?` `n` `N` search via the `SearchBar` (incremental highlight, case/regex, replace)
- [x] Occurrence — operator-modifier `o`/`O` (`c o p`, `d o p`, `g U o w`; subword via `O`) and preset occurrence `g o`/`g O`/`g .` (persistent highlighted markers any later operator restricts itself to). Real `OccurrenceManager` over `MarkerLayer` + a `TextDecorations` highlight layer. (`occurrence.test.ts`.)
- [x] visual-blockwise (`ctrl-v`) and multiple cursors — emulated on `MarkerLayer` mark pairs surfaced through the array-shaped `getCursors()`/`getSelections()`. Entry points: blockwise `ctrl-v` (I/A/c/d/yank/paste), occurrence `c o p`, and persistent `ctrl-alt-↑/↓` (add cursor above/below; `escape` collapses). Extra-caret rendering (reverse-video block tags in normal/visual; host-drawn beam carets in insert); multi-cursor operations undo as one step; insert is incrementally replicated to every cursor live. (`blockwise.test.ts`, `multicursor.test.ts`.) Caret visuals + `ctrl-alt-arrow` keys need in-app verification (headless can't realize the view).
- [x] Polish: `=`/`==` auto-indent (real tree-sitter indent source — `syntax/indent.ts` + `EditorModel.setIndentSource`), matching-bracket highlight (`syntax/bracketMatch.ts`; ignores strings/comments/regex; enclosing pair when inside), indent guides (`IndentGuides`, `editor.indentGuides`), tree-sitter text objects `ic`/`ac` (class) alongside `if`/`af`/`ia`/`aa`, H/M/L screen motions, ctrl-f/b/d/u/e/y scrolling, flash-on-operate.

## Session management

See [session-management.md](session-management.md) for the architecture. The core
is implemented.

- [x] Storage format + manager — `SessionManager` (`src/SessionManager.ts`) persists
  a versioned `SessionState` (open files w/ cursor+scroll, unsaved buffers, terminals,
  agents, split/dock layout, window geometry) keyed by repo root.
- [x] Save/restore wired up — `SessionController` (`src/SessionController.ts`) drives a
  serialize/deserialize seam each widget implements (`TextEditor`/`Terminal`/
  `AgentTerminal`/`FileTree`/`PanelGroup`); debounced autosave + on-quit flush;
  `Adw.AlertDialog` prompt for unsaved buffers on exit. Commands `session:save`
  (`space s s`) / `session:restore` (`space s r`).
- [ ] Named sessions (storage groundwork exists; no UI) and multi-root + a
  `session:open` picker.

## Agents

See [agents.md](agents.md) for the architecture plan.

- [x] Basic agent runner (claude in terminal tab)
- [x] Basic AgentManager, sidebar list, and picker/starter
- [x] Live agent status (idle/working/waiting/exited) via Claude Code hooks
- [x] Management UX: kill, focus-next/prev, vim list nav; in-app attention toasts (`AppWindow.notifyAgentAttention` on waiting / working→idle while inactive). Sidebar waiting badge + OS notifications still TODO (see below)
- [x] Send editor context to an agent (selection / file → current / picked / new agent)
- [x] Resume / continue past conversations (transcript enumeration + `--resume`/`--continue`); capture session id for restore
- [x] More management UX: restart (resume conversation), rename, stop, close — keyboard/command driven (`r`/`R`/`x`/`d d`); status glyph in the tab title
- [x] Resume a stopped agent **in place** (`agent:resume`, `space a r`): respawns the claude process in the same terminal pane (`Terminal.respawn` reuses the pty/scrollback) with a fresh `ClaudeSession` resuming `--resume <sessionId>` — vs `agent:restart` which retires the widget and opens a new one. The past-conversation picker was renamed `agent:resume-conversation` (`space a R`)
- [x] Track Claude's own session name: the built-in `/rename` command (and auto-summaries) writes the session's `.name` to `~/.claude/sessions/<pid>.json` — it is NOT emitted over the PTY as a terminal title (and with `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` there's no OSC at all), so `AgentTerminal` watches that file (keyed by the spawned child's pid = the main claude process) and reflects `.name` as the title. Precedence: quilx `agent:rename` pin > Claude session `.name` > live OSC title / argv basename
- [x] **Extracted the Claude integration out of `AgentTerminal`** → `ClaudeSession` in `src/ui/claudeAgent.ts`: it owns the argv/`--settings` injection, the IPC files, and the three watchers (status / edited-files / session-name `/rename`), translating them into host callbacks (`ClaudeHost`). `ClaudeSession.create()` returns null for a non-claude command, so `AgentTerminal` is now the tool-agnostic host (status, changed-files, rename, serialize) and runs anything else plain (alive/exited only).
- [ ] **TBD — fuller agent seam** (deferred; only when a second tool actually lands): promote `ClaudeSession` to an `AgentBackend` interface selected by *kind* (`claude` | `generic`) with a `capabilities` flag set so the UI degrades instead of branching, and split a tool-agnostic `Agent` model out of the terminal widget so `AgentManager`/`WorkbenchList`/`AppWindow` depend on the model, not the concrete `AgentTerminal`. Pairs with the agent-profiles + worktree work below.
- [x] File-change awareness: a PostToolUse hook records edited files; agent-list "✎ N" badge (tooltip), click/`o` opens them (newest first), and edits trigger an immediate git refresh
- [x] **Per-person workbenches** — `src/ui/Workbench.ts` is a first-class object: one person's dock frame **plus the widgets filling its slots** (its own `center`, Files/Source-Control, `leftPanel`, bottom-dock panels), with an `owner` field naming its person. **Each person owns a fully self-contained `Workbench`; nothing is shared or reparented on switch.** `buildWorkbench(owner)` constructs the widgets and hands them to `new Workbench(owner, contents, { showSideDock })`, registering it in `AppWindow.workbenches` (owner → `Workbench`). AppWindow keeps only `this.workbench` (the active one) and reads per-person state straight off `this.workbench.*` — **no mirror struct, no save/restore on switch**. `activateWorkbench(workbench)` just sets `this.workbench` + `overlay.setChild(workbench.root)`; `cycleWorkbench(±1)` (`super-,` / `super-.`) steps through `[user, …agents]`. Detached workbenches stay alive (tabs/terminal/editors persist — verified). An agent's workbench opens terminal-only (`showSideDock` false — the panel is still built, so `file-tree:focus`/git commands reveal it on demand); any workbench can open/edit files. **Now worktree-ready** (each agent's Files/Git is its own — just needs a per-workbench root/`GitRepo`). Defer: per-worktree roots; session restore of agent workbenches (only the user workbench is serialized); per-workbench NotificationLog/KeymapPanel subscribe to global signals and aren't disposed on close (minor leak, few agents)
- [x] **WorkbenchSidebar / WorkbenchList** (renamed from agent sidebar / AgentList): its own full-height column at the very left of the window (left of the header bar) — a top-level horizontal `Gtk.Paned` (sidebar | header-bar+workbench), no longer a workbench dock. Top is a themed `Adw.HeaderBar` whose only content is a flat **logo button** (square placeholder for now; styled like the git branch button) that toggles collapse (icons-only / icons+text). The first row is the **user** (default-selected pseudo-agent), the rest are agents; never empty; each row is one header-bar tall. Each entry is associated with a workbench. Files/Source-Control moved to the **right** dock (fixed 220px); the left dock is empty/hidden at startup
- [x] Modal terminal input (Terminal & AgentTerminal): normal/insert modes — `Escape`↔`i`; normal frees the `space` leader / `ctrl-w` window-nav, `ctrl-[` sends a literal Escape to the child. Implemented by wrapping the Vte in a focusable container that *steals* focus in normal mode (Vte un-focused → cursor idles, no keys reach it — no key-swallowing guard needed); clicking the Vte re-enters insert
- [ ] **Review an agent's work** (next; design in agents.md): per-agent baselines (PreToolUse snapshot → `.baseline/`) make one agent's diff well-defined even in a tree shared by several agents; an "Agent Changes" diff panel (baseline→current), live while it works + after exit; overlap warning when two live agents edit the same file. Needs the editor Diff renderer first
- [ ] Live activity timeline: tail the agent's transcript JSONL (already parsed for resume) into a structured feed (tools used, files touched, messages)
- [ ] OS notifications (`Gio.Notification`) when an agent needs attention while the window is unfocused (today: in-app toasts only)
- [ ] Agent interrupt (`agent:interrupt` → send ESC/ctrl-c to the child) — softer than kill
- [ ] Jump to an agent's latest edit *location* (file + exact line), not just the file
- [ ] Agent configuration and customization (name, description, model, tools, etc), integration with other tools than claude.
- [ ] Worktree integration: run agents in worktrees (**N agents per worktree**, not 1:1), group the list by worktree, re-root the editor when viewing one; review at worktree (`git diff`) vs per-agent (baseline) granularity; per-worktree keep/merge/discard when the last agent leaves
- [ ] Cost/context meter (per-row `$cost · context%` via a `statusLine` hook); multi-agent orchestration (speculative)
