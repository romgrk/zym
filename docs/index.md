# Docs

This page is the index: each section holds only the important decisions or plans
plus a one-line summary of the point, and links to a dedicated document for the
detail. Anything longer than a small paragraph lives in its own file. File names
mirror the header structure (`git/index.md` for the git section,
`text-editor/lsp-integration.md` for LSP, etc.); a header with more than one
subheader becomes a directory with an `index.md`.

## Architecture

- Prefer idiomatic Node.js, only use GObject libraries when required.

### UI

- Components use Adwaita and GTK4 via node-gtk (in dev, linked to `../node-gtk`),
  styled with CSS.
- One main component per file, under `src/ui`.
- Icons are Nerd Font glyphs via `src/ui/nerdfonts.ts` — never
  `Gio.ThemedIcon` / `Gtk.Image(iconName)`.

### Commands & keymaps

Named commands dispatched along the focus chain (`CommandManager`) +
priority-layered multi-key bindings (`KeymapManager`), ported from Atom. Keys are
data-driven in `src/keymaps/default.ts` plus a live-reloaded user `keymap.json`.
**All keybindings go through this system.** See
[commands-keymaps.md](commands-keymaps.md).

### Panels & layout

Every tab group (center editor groups and all docks) is one shared `Panel`
abstraction, with exactly one active panel defined by keyboard-focus containment.
Covers the `Panel`/`PanelGroup`/`Workbench` dock model, focus/tab-bar rules, and
the zombie-safe dock-close rule. See [panels.md](panels.md).

### Styling & theming

UI styling is GTK CSS (`addStyles` / `styles.set`) with `#WidgetName` selectors
and modern CSS variables only (no legacy `@named` colors). Variable families:
libadwaita's, shared chrome props, per-theme `--t-ui-*` colors, and `--t-font-*`
fonts. See [styling.md](styling.md).

The theme format is owned (not Zed's): concern-grouped nested `ui` colors that
mirror the in-app model 1:1 (`theme.ui.editor.background`), per-capture `syntax`
tokens, a loader + JSON Schema, and a `DEFAULT_THEME` fallback guaranteeing every
field. See [theming.md](theming.md).

### Lifecycle & disposal

Teardown is load-bearing: widgets detach (not destroy) on close and node-gtk pins
GObjects/handlers, so subscriptions to long-lived objects must be cut by hand in
an idempotent `dispose()` (`destroy` never fires on tab-close). Covers the
`eventKit.ts` primitives, the disposal rules, and the CDP leak-hunting recipe.
Read before adding a component that owns a GObject, handler, timer, or child. See
[lifecycle-and-disposal.md](lifecycle-and-disposal.md).

### Developer tooling

`pnpm run lint` (ESLint flat config) is tuned to **catch real bugs, not style** —
formatting is deferred to a separate tool. The one type-aware rule,
`local/no-floating-cleanup`, flags discarded `eventKit` disposers (a leak class).
`pnpm run typecheck` does type-level checking. See [tooling.md](tooling.md).

### Data & storage

App data follows XDG: config in `$XDG_CONFIG_HOME/quilx`, state (sessions,
frecency) in `$XDG_STATE_HOME/quilx`, caches (LSP installs, generated GtkSource
schemes) in `$XDG_CACHE_HOME/quilx` — never `/tmp`. Tests get throwaway dirs via
`src/util/testTmp.ts` (`tmpDir(prefix)`), removed on process exit.

### Configuration

The schema is the single source of truth: a key is editable/persisted only once
declared, and `config.json` stores only values that differ from defaults. Covers
the schema-driven `Config` store, schema assembly (baseline + subsystem
namespaces + plugin contributions), live-watched persistence, and the
schema-generated preferences window. See [config.md](config.md).

## System integration

quilx tracks the desktop's appearance and fonts and follows OS font/theme changes
at runtime (no restart). Fonts already react live; the core open work is making
the **theme palette** follow OS light/dark via a swappable `theme` + a
`theme:changed` event, gated on `core.followSystemColorScheme`. See
[system-integration.md](system-integration.md).

## Git

Fully async, CLI-backed (no synchronous git, no libgit2), with consumers
restricted to the two-module `git.ts`/`github.ts` boundary. A background poll +
`HEAD` watch feeds a cached, reactive `GitRepo`. Covers status viewer, edit-in-tab
commit, branch/stash pickers, the diff gutter with hunk staging, the continuous
editable diff, and the GitHub-over-`gh` forge. See [git/index.md](git/index.md).

### Process runner

All spawns route through a generic broker so the ~1.5 GB node-gtk process never
`fork()`s (fork cost scales with RSS): it forks one tiny child once, which then
runs every command (~1 ms) over binary, length-prefixed IPC. See
[process-runner.md](process-runner.md).

## Code editing

### LSP integration

A GTK-free `src/lsp/` core drives editors through an `LspDocument` interface, fed
by the plugin-contributed language/server registry in `src/lang/`. Servers are
curated, hand-authored `ServerDef`s contributed by plugins (no runtime fetch),
with **per-project server selection** (root-marker activation + exclusion groups +
priority) overridable by the user. Covers navigation, hover, completion, signature
help, code actions, rename, formatting, diagnostics, and inlay hints. See
[text-editor/lsp-integration.md](text-editor/lsp-integration.md) and
[text-editor/language-config.md](text-editor/language-config.md). Later: semantic
tokens, document highlight, format-on-save.

### Grammar & syntax

tree-sitter highlighting gathers base + injected captures into one flat list and
paints them in a single sweep (innermost/later capture wins) — the backbone of
embedded-language highlighting. Markdown is fully working (block + inline grammars,
fenced-block highlighting). Styled tags carry font styling, not just color; soft
wrap with wrap-aware vim display-line motion. See
[text-editor/syntax-injection.md](text-editor/syntax-injection.md). Remaining: more
default grammars.

### Autocompletion

A source-pluggable framework: the `CompletionSource` contract, a
`CompletionController` (insert-mode triggers, fzy ranking, accept/navigate keys),
and a keyboard-driven `CompletionPopup` with a doc pane. Sources: buffer-words and
LSP (`priority: 100`, with auto-import `additionalTextEdits`). See
[text-editor/autocompletion.md](text-editor/autocompletion.md). Planned: Copilot
ghost text, snippet insertion, widget polish.

### Text editor

The widget question is settled: **stay on GtkSourceView and emulate** what it
lacks (multi-cursor, blockwise), owning the text model so each view has its own
buffer (the A2 design); a custom/Rust widget stays a perf-gated escape hatch.
Multi-cursor, vim, diff, folding, and inline widgets have shipped; scroll/open
cost is bounded to the viewport. See [text-editor/index.md](text-editor/index.md).

Per-feature detail:

- [Diff](text-editor/diff.md) — synthesized read-only buffers + decorations
  sidestep GtkTextView's lack of virtual lines; unified + side-by-side.
- [Multibuffer](text-editor/multibuffer.md) — every editor on a
  `ViewProjection`/`ProjectionView` substrate; editable project-search + git-diff
  shipped (folding off by design).
- [Folding](text-editor/folding.md) — view-side text projection; model stays the
  source of truth, renderers translate + re-render on `onFoldsChanged`.
- [Document registry](text-editor/document-registry.md) — `Document` (shared
  headless model) split from N views, each with its own native buffer.
- [Inline widgets](text-editor/inline-widgets.md) /
  [block decorations](text-editor/block-decorations.md) /
  [virtual lines](text-editor/virtual-lines.md) /
  [decorations](text-editor/decorations.md) — `BlockDecorations`, `Peek`, and
  `VirtualText`; focusable inline content must use a sibling overlay (`Peek`).

#### Vim mode

Custom modal editing ported from Atom's vim-mode-plus over an `EditorModel` shim,
the default (replaced `GtkSource.VimIMContext`). Motions/operators/text-objects,
visual + blockwise + multi-cursor, occurrence, surround, search via the
`SearchBar`. The `:` ex-command line is won't-do. See
[text-editor/vim-mode.md](text-editor/vim-mode.md).

## Tasks & runners

> Idea — not started. Run tests/mains/scripts from the editor via two decoupled
layers (detection via `runnables.scm`; a per-language Locator that derives the
concrete command from the build tool). See
[tasks-and-runners.md](tasks-and-runners.md).

## Debugger (DAP)

> Idea — not started. A DAP-based debugger mirroring the LSP architecture
(per-adapter lifecycle, plugin-contributed adapter defs, install seam), reusing
the Tasks Locator to derive debug configs. See [debugger.md](debugger.md).

## Session management

A project root's working state (open files w/ cursor+scroll, unsaved buffers,
terminals, agents, layout, window geometry) is serialized to the XDG state dir,
debounce-autosaved, and restored on request, with an exit prompt for unsaved work.
The core is implemented; **named sessions** (switchable per-root workspaces) and
multi-root are the open plans. See [session-management.md](session-management.md).

## Agents

Run coding agents inside quilx via two interchangeable rendering kinds —
`claude-tui` (the CLI's terminal UI in a Vte tab, the default) and `claude-sdk`
(headless `claude -p` stream-json rendered in native GTK widgets) — over a shared
workbench / list / lifecycle / worktree spine. Root ownership lives on a
self-contained per-person `Workbench` (`cwd` + pooled `GitRepo`), so each agent can
re-root to its own git worktree independently while per-agent edit baselines give
change attribution within a shared tree. See [agents.md](agents.md),
[agents/claude-sdk.md](agents/claude-sdk.md).

Open, cross-kind: agent profiles/customization, richer management UX, reviewing an
agent's diff (needs the editor Diff renderer first), and worktree lifecycle
(keep/merge/discard).

## TypeScript

- Parameter properties (`constructor(private foo: T)`) are forbidden — declare fields explicitly.

## Notes

### Inspiration

- https://www.reddit.com/r/gnome/comments/1u56coz/gitte_070_is_out_simple_git_client/
