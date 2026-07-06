# AppWindow decomposition

`AppWindow` (`src/ui/AppWindow.ts`) is the top-level application window. It was once a
God object (~3600 lines) that owned the window chrome **and** every feature's
orchestration (LSP, git, files, agents), the tab/item registry, workbench lifecycle,
docks, and focus/pane navigation. It is now a **composition root** (~1000 lines): build
the GTK window + top-level layout, instantiate the collaborators, wire them, register
the window-chrome commands, and handle present/geometry/shutdown.

Following Atom, the collaborators take two shapes, both already idiomatic in the codebase:

- **Stateless command modules** — `registerXCommands(deps)` functions taking an
  explicit deps object and returning a `Disposable` (the `registerGithubCommands`
  idiom). A feature owns its `*:` commands + their small pickers. Anything app-wide
  (the active editor, the active workbench, file-open, the picker host, notifications,
  workspace-edit application) is read off the **`zym` global**, Atom-style — *not*
  threaded through a deps object; only genuinely module-specific collaborators are
  injected. See "the zym.workspace seam" below.
- **State-owning controllers** — classes that own a slice of state, constructed by
  `AppWindow` with a deps object whose late-bound entries are lazy closures over the
  other collaborators, so the mutually-recursive wiring resolves at call time (not
  construction time — `buildWorkbench` runs during construction before the view layer
  exists).

## The collaborators

Command modules (in/next to their feature folder):

- `src/ui/lspCommands.ts` — `registerLspCommands` (`lsp:*` / `tag:rename`): navigation,
  references, symbol pickers, code actions, rename, format. The GTK-free LSP core stays
  in `src/lsp/`; this is its GTK-facing command surface. Injects only `documents`.
- `src/ui/git/gitCommands.ts` — `registerGitCommands` (`git:*` repo ops): staging,
  fetch/pull/push, branch, stash. Chains in `registerGithubCommands`. Injects only the
  header's `github` service.
- `src/ui/fileCommands.ts` — `registerFileCommands` (`file:*`): open / save / save-as /
  move / rename (with LSP reference rewrites). Injects only `activeSavableSurface`.
- `src/ui/sessionCommands.ts` — `registerSessionCommands` (`session:*`): save / save-as /
  open / close / rename / delete, plus their pickers and the open-elsewhere prompt.
  Injects only the `sessionController` (the state owner); the shared "Unsaved work"
  confirm lives in `src/ui/confirmUnsavedWork.ts` (also used by the quit path).

State-owning controllers:

- `src/ui/workbench/PaneItems.ts` — **the tab/item-registry spine** (Atom's `Workspace`
  / `PaneContainer` / `TextEditorRegistry`). Owns every center-tab registry (editors /
  terminals / headless agents / project-search & diff surfaces / action terminals) + the
  shared `DocumentRegistry`, the create/attach/serialize/dispose/reopen lifecycle, the
  `openFile` funnel + `activeEditor`, the active-surface resolvers, `applyWorkspaceEdit`,
  and the search/diff/git-log view openers. Everything else depends on it.
- `src/ui/workbench/WorkbenchManager.ts` — **per-person workbench lifecycle**: the
  `workbenches` map + the active one, `buildWorkbench` / `activateWorkbench` /
  `activateOwner` / `cycleWorkbench` / `reRootWorkbench` / `ownerWorkbenchCwd`. AppWindow
  exposes the active workbench + map through getters so the rest of the shell reads them
  unchanged.
- `src/ui/workbench/WorkbenchView.ts` — **the active workbench's view layer**: the
  window's sidebars (workbench list + agent secondary sidebar), docks (reveal / toggle /
  show-hide), keyboard-focus memory, and directional/cyclic pane navigation. (Merges what
  an earlier plan called `FocusNavigator` + `DockController`; they share the active-
  workbench view state so heavily that splitting them would need heavy mutual injection.)
- `src/ui/GlobalJumpList.ts` — **the single jump engine** (`workspace:jump-backward`
  / `-forward`, ctrl-o / ctrl-i): a time-ordered ring of (path, point) entries, the sole
  store for jumps (there is no per-editor jump ring). It watches the caret at the source
  (`TextEditor.onDidChangeCursorPosition`) so any far same-file move of the focused editor
  (≥ `vim-mode-plus.jumpListMinLines` rows) records where the caret left — catching jumps no
  command announces (in-file `g d`, mouse, big motions) with no per-command wiring. Explicit
  *hints* (`onDidRecordJump`) cover jumps too short for that detector: vim `jump = true` motions
  (`}`/`%`) and the `*`/`#`/`n`/`N` search; duplicates collapse. The departure on each
  active-editor change is recorded too. Self-contained
  on the `zym.workspace` seam (`observeTextEditors` / `onDidChangeActiveTextEditor` / `openFile`);
  vim's `jump-backward`/`-forward` delegate here, and the `g;`/`g,` change list stays in the vim
  layer (see [text-editor/vim-mode.md](text-editor/vim-mode.md)).
- `src/ui/AgentController.ts` — **the agent feature**: launch / resume / close / restart /
  branch / rename, send-to-agent + diff-review routing, auto-open changed files, the
  per-agent subscriptions, viewed/attention tracking, agent session serialize+restore, and
  the `agent:*` commands. Lands on four collaborators (`PaneItems` + `WorkbenchManager` +
  the two agent widgets), reading the rest off the `zym` globals.

## The `zym.workspace` seam

`zym.workspace` (Atom's `atom.workspace`) is how a command module reaches app-wide state
without a deps object. AppWindow injects the concrete impls once, on construction:
`setOpener` / `setActiveEditorProvider` / `setActiveWorkbenchProvider` / `setTabReopener`
/ `setTabHost` / `setReviewSink`, plus `setPickerHost` (the window-level overlay floating
pickers mount into) and `setWorkspaceEditApplier` (the impl owns the editor registry, so
it stays in `PaneItems`). Modules then call `zym.workspace.getActiveTextEditor()` /
`getActiveWorkbench()` / `openFile()` / `getPickerHost()` / `applyWorkspaceEdit()` and the
other `zym` managers (`zym.notifications`, `zym.window`, `zym.agents`, …) directly.
AppWindow also funnels its tab/split change signal into
`zym.workspace.notifyActiveItemChanged()`, which dedups by editor identity into the
Atom-style `onDidChangeActiveTextEditor` event modules can subscribe to.

## What stays in AppWindow

The composition root: the GTK window + top-level `Gtk.Paned` layout (sidebar column +
agent column + content overlay + toast overlay), constructing and wiring the collaborators
above, the window-chrome command tables that are pure dispatch into them (`registerPane`/
`Window`/`Terminal`/`Notification`/`Config`/`Session` commands), session save/restore
wiring, LSP config plumbing, and shutdown (`teardownAndQuit` drains each collaborator's
`dispose()`).
