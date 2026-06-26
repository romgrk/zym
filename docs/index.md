# Docs

This page is the index: each section holds only the important decisions or plans
plus a one-line summary of the point, and links to a dedicated document for the
detail. Anything longer than a small paragraph lives in its own file. File names
mirror the header structure (`git/index.md` for the git section,
`text-editor/lsp-integration.md` for LSP, etc.); a header with more than one
subheader becomes a directory with an `index.md`.

Do not document conventions or workarounds with inline code comments. Anything 
that needs to be known globally should be in the `docs/`. Inline code comments
can explain briefly, but should point to the documentation. In general, knowledge
should only be stated once; further mentions should point to other documents.

## Architecture

- Use Atom as a model for the overall architecture.
- Prefer idiomatic Node.js, only use GObject libraries when required.

## TypeScript

- Parameter properties (`constructor(private foo: T)`) are forbidden — declare fields explicitly.
- Avoid `(x as any)`. Prompt and justify your choice if you need to.

## UI

- Components use Adwaita and GTK4 via node-gtk (in dev, linked to `../node-gtk`).
- One main component per file, under `src/ui`.
- Fonts (ui and monospace) are defined in `src/fonts.ts`
- Icons are Nerd Font glyphs via `src/ui/nerdfonts.ts` — avoid `Gio.ThemedIcon` / `Gtk.Image(iconName)`.
- Bundled SVGs live in `assets/icons/`, named `*-symbolic.svg` so GTK recolors them to the theme foreground (the suffix is the recolor trigger — `FORCE_SYMBOLIC` won't substitute). `scripts/generate-icons.ts` (run on `postinstall`, or `pnpm run generate-icons`) emits a name→path map to `src/icons.generated.ts` (key drops `-symbolic`), which `src/icons.ts` exposes as `ImageIcons` — `ImageIcons.CAT_SLEEPING(52)` builds a sized, theme-recolored `Gtk.Image`. Add an icon by dropping an `*-symbolic.svg` in the folder and re-running the script.
- Do not under any circumstance use a Gtk.EventController of any kind without prompting.

## Commands & keymaps

Named commands dispatched along the focus chain (`CommandManager`) +
priority-layered multi-key bindings (`KeymapManager`), ported from Atom. Keys are
data-driven in `src/keymaps/default.ts` plus a live-reloaded user `keymap.json`.

See [commands-keymaps.md](commands-keymaps.md).

## Styling & theming

UI styling is in GTK CSS. Editing a file's `addStyles(...)` CSS hot-reloads.
Before writing styles or classnames, see [styling.md](styling.md).

The theme system is being reworked. Avoid using it as much as possible. Only use
it when you need status colors (hint, info, success, warning, error). The existing 
theme is at `src/themes/zym.json`
See [theming.md](theming.md).

## Workbenches, panels & layout

A workbench has a current directory, docks and a center panel. Many workbenches can
exist at once. Every tab group (center editor groups and all docks) is one shared `Panel`
abstraction, with exactly one active panel defined by keyboard-focus containment.
Covers the `Panel`/`PanelGroup`/`Workbench` dock model, focus/tab-bar rules. 
See [panels.md](panels.md).

## Lifecycle & disposal

Teardown is load-bearing: widgets detach (not destroy) on close and node-gtk pins
GObjects/handlers, so every GObject signal/controller — even on the owner's own
buffer/view — must be cut by hand in an idempotent `dispose()` (`destroy` never
fires on tab-close), else it leaks.

**The rule, no exceptions: the instant you acquire a resource, register its
teardown in the same statement through the owner's `CompositeDisposable`.** A
signal handler → `disposables.connect(obj, sig, fn)`; an event controller →
`disposables.addController(widget, c)`; a `setTimeout`/`setInterval` →
`disposables.timer`/`interval`; a subscription, a `setParent`'d popover, or
anything else → `disposables.defer(() => …)` (or `adopt`/`use`). **Never** a bare
`.on()` / `addController()` / `setTimeout()` whose cleanup lives elsewhere (or
nowhere) — that is the leak. A `dispose()` should do nothing but drain its bag;
reach for `clear()` / `nest()` to re-arm a recycled widget. Components without a
`dispose()` that own any such resource are a bug.

Covers the `eventKit.ts` primitives (acquire-and-defer helpers), the disposal
rules, and the CDP leak-hunting recipe. Read before adding a component that owns
a GObject, handler, timer, or child. See
[lifecycle-and-disposal.md](lifecycle-and-disposal.md).

## Developer tooling

`pnpm run lint` (ESLint flat config) is tuned to **catch real bugs, not style**.
`pnpm run typecheck` does type-level checking. See [tooling.md](tooling.md).

## Data & storage

App data follows XDG: config in `$XDG_CONFIG_HOME/zym`, state (sessions,
frecency) in `$XDG_STATE_HOME/zym`, caches (LSP installs, generated GtkSource
schemes) in `$XDG_CACHE_HOME/zym` — never `/tmp`. Tests get throwaway dirs via
`src/util/testTmp.ts` (`tmpDir(prefix)`), removed on process exit.

## Configuration

The schema is the single source of truth: a key is editable/persisted only once
declared, and `config.json` stores only values that differ from defaults. Covers
the schema-driven `Config` store, schema assembly (baseline + subsystem
namespaces + plugin contributions), live-watched persistence, and the
schema-generated preferences window. See [config.md](config.md).

## System integration

Not done yet. Some config keys may exist but aren't linked properly.

Goal: zym tracks the desktop's appearance and fonts and follows OS font/theme changes
at runtime (no restart). Fonts already react live; the core open work is making
the **theme palette** follow OS light/dark via a swappable `theme` + a
`theme:changed` event, gated on `core.followSystemColorScheme`.

See [system-integration.md](system-integration.md).

## Git

Fully async, with consumers restricted to the two core module `git.ts`/`github.ts` 
boundary.  Event-driven file watches (`HEAD`/`index` + tracked-file content, throttled)
over a slow backstop poll feed a cached, reactive `GitRepo`.
Anything that interacts with git must use the core modules.
See [git/index.md](git/index.md).

## Process runner

If you need to run a process, do not use `node:child_process`.
See [process-runner.md](process-runner.md).

## LSP integration

A GTK-free `src/lsp/` core drives editors through an `LspDocument` interface, fed
by the plugin-contributed language/server registry in `src/lang/`. Servers are
curated, hand-authored `ServerDef`s contributed by plugins (no runtime fetch),
with **per-project server selection** (root-marker activation + exclusion groups +
priority) overridable by the user. Covers navigation, hover, completion, signature
help, code actions, rename, formatting, diagnostics, and inlay hints. See
[text-editor/lsp-integration.md](text-editor/lsp-integration.md) and
[text-editor/language-config.md](text-editor/language-config.md). Later: semantic
tokens, document highlight, format-on-save.

## Text editor

The widget is a `GtkSourceView` backed by a custom `MultiBuffer` model (inspired by Zed)
than can itself point to one or more `Document`. A simple mode exists for transient
inputs, see `createInput()`.

It implements complex features (multi-cursor, vim, etc) via the
vim implementation (extracted from Atom's `vim-mode-plus`). Syntax-highlighting
is also a custom layer via tree-sitter, which provides syntax-aware folding.

See [text-editor/index.md](text-editor/index.md).

Per-feature detail:

- [Coordinates](text-editor/coordinates.md) — the `document`/`buffer`/`screen`
  position vocabulary (canonical); code/docs are mid-migration onto it.
- [Multibuffer](text-editor/multibuffer.md) — every editor on a
  `ViewProjection`/`ProjectionView` substrate; editable project-search + git-diff
  shipped (folding off by design).
- [Folding](text-editor/folding.md) — view-side text projection; model stays the
  source of truth, renderers translate + re-render on `onFoldsChanged`.
- [Document registry](text-editor/document-registry.md) — `Document` (shared
  headless model) split from N views, each with its own native buffer.
- Decorations are based/inspired by the Atom model:
  [Inline widgets](text-editor/inline-widgets.md) /
  [block decorations](text-editor/block-decorations.md) /
  [virtual lines](text-editor/virtual-lines.md) /
  [decorations](text-editor/decorations.md)
  NOTE: Decorations need to be re-architected and simplified.
- [Diff](text-editor/diff.md) — one multibuffer `DiffView` for every diff
  (working tree, commit, branch); see [multibuffer.md](text-editor/multibuffer.md).

### Grammar & syntax

Tree-sitter based.

[text-editor/syntax-injection.md](text-editor/syntax-injection.md)

### Vim mode

Custom modal editing ported from Atom's vim-mode-plus over an `EditorModel` shim,
the default (replaced `GtkSource.VimIMContext`). Motions/operators/text-objects,
visual + blockwise + multi-cursor, occurrence, surround, search via the
`SearchBar`. The `:` ex-command line is won't-do. See
[text-editor/vim-mode.md](text-editor/vim-mode.md). Occurrence is unified with
search (`g o` arms operators on the search matches) —
[text-editor/occurrence-search.md](text-editor/occurrence-search.md).

### Autocompletion

A source-pluggable framework: the `CompletionSource` contract, a
`CompletionController` (insert-mode triggers, fzy ranking, accept/navigate keys),
and a keyboard-driven `CompletionPopup` with a doc pane. Sources: buffer-words and
LSP (`priority: 100`, with auto-import `additionalTextEdits`). See
[text-editor/autocompletion.md](text-editor/autocompletion.md). Planned: Copilot
ghost text, snippet insertion, widget polish.

## Session management

A project root's working state (open files w/ cursor+scroll, unsaved buffers,
terminals, agents, layout, window geometry) is serialized to the XDG state dir,
debounce-autosaved, and restored on request, with an exit prompt for unsaved work.
The core is implemented; **named sessions** (switchable per-root workspaces) and
multi-root are the open plans. See [session-management.md](session-management.md).

## Agents

Run coding agents inside zym via two interchangeable rendering kinds —
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

## node-gtk

This project is the flagship demo for `node-gtk`, and bugs in `node-gtk` should be
surfaced and fixed at the source. Workarounds for `node-gtk` should not be allowed.

Unconfirmed gotcha: JS microtasks may not drain promptly under node-gtk's GLib main 
loop. Evidence is mixed — `node-gtk`'s `loop.cc` flushes them in `loop_source_prepare` 
every iteration, and `queueMicrotask`-deferred multi-cursor edit replication 
(`EditorModel`) works in the app — yet `ProjectionView`/`DiffView` saw 
microtask-deferred work stay stale until later activity and switched to `setTimeout` 
/ the GTK frame clock. Cause unresolved; if work you defer doesn't seem to run promptly in the app, suspect
this and prefer a macrotask (or the frame clock when it must land before a paint).

## Tasks & runners

Idea — not started.
See [tasks-and-runners.md](tasks-and-runners.md).

## Debugger (DAP)

Idea — not started. 

See [debugger.md](debugger.md).

## Notes

### Inspiration

- https://www.reddit.com/r/gnome/comments/1u56coz/gitte_070_is_out_simple_git_client/
- https://codeberg.org/ckruse/Gitte/src/branch/main/SCREENSHOTS.md