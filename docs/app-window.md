# AppWindow decomposition

`AppWindow` (`src/ui/AppWindow.ts`) is the top-level application window. Historically
it was a God object (~3600 lines) that owned the window chrome **and** every feature's
orchestration (LSP, git, files, agents), the tab/item registry, workbench lifecycle,
docks, and focus/pane navigation.

It is being refactored toward Atom's split: a thin **composition root** (build the
GTK window + top-level layout, instantiate collaborators, wire them, handle
present/geometry/shutdown) plus focused collaborators that each own one
responsibility. The two collaborator idioms already in the codebase:

- **Stateless command modules** — `registerXCommands(deps)` functions taking an
  explicit deps object and returning a `Disposable` (the `registerGithubCommands`
  idiom). A feature owns its `*:` commands + their small pickers; anything stateful
  (the active editor, the active workbench cwd/git, file-open, workspace-edit
  application) is injected.
- **State-owning controllers** — classes that own a slice of state and are
  constructed by `AppWindow` with a deps object of lazy closures over the other
  collaborators (so the mutually-recursive wiring resolves at call time, not
  construction time).

## Extracted so far

- `src/ui/lspCommands.ts` — `registerLspCommands` (`lsp:*` / `tag:rename`):
  navigation, references, symbol pickers, code actions, rename, format. The
  GTK-free LSP core stays in `src/lsp/`; this is its GTK-facing command surface.
- `src/ui/git/gitCommands.ts` — `registerGitCommands` (`git:*` repo ops): staging,
  fetch/pull/push, branch, stash. Chains in `registerGithubCommands`.
- `src/ui/fileCommands.ts` — `registerFileCommands` (`file:*`): open / save /
  save-as / move / rename (with LSP reference rewrites).
- `src/ui/workbench/WorkbenchView.ts` — `WorkbenchView`, the **active workbench's
  view layer**: the window's sidebars (workbench list + agent secondary sidebar),
  docks (reveal / toggle / show-hide), keyboard-focus memory, and
  directional/cyclic pane navigation. It always acts on the active workbench (read
  lazily) and attaches/detaches the window-level columns on their `Gtk.Paned`
  splits; the panel-tree operations it needs (focus tab content, open a split view,
  build the live diff, register a tab-close handler) are injected. This merges what
  the plan called `FocusNavigator` + `DockController` into one cohesive controller,
  because they share the active-workbench view state and splitting them would need
  heavy mutual injection.

## Remaining

The deeply-coupled runtime core, still in `AppWindow`, to be extracted in dependency
order:

1. **`PaneItems`** (the tab/item-registry spine) — the per-widget registries
   (editors / terminals / conversations / project-search / action-terminals + their
   subscriptions), `createEditorTab` / `createTerminalTab` / `makeCenter` /
   `disposeChild` / `serializeChild` / `reopenTab`, the `openFile*` funnel +
   `activeEditor`, the active-surface resolvers, `applyWorkspaceEdit`, and
   `buildCurrentChangesDiff`. This is Atom's `Workspace` / `PaneContainer` /
   `TextEditorRegistry` split. `zym.workspace` keeps delegating to it through the
   existing provider seams (`setOpener` / `setActiveEditorProvider` / `setTabHost` /
   …). Everything else depends on this, so it is the keystone.
2. **`WorkbenchManager`** — the `workbenches` map + per-person workbench lifecycle
   (`buildWorkbench` / `activateWorkbench` / `activateOwner` / `cycleWorkbench` /
   `reRootWorkbench` / `ownerWorkbenchCwd`); publishes the active-workbench provider.
3. **`AgentController`** — the agent feature: launch / close / restart / resume /
   branch / rename, send-to-agent + diff-review routing, auto-open changed files,
   per-agent subscriptions, viewed/attention tracking, agent session
   serialize/restore, and the `agent:*` / `terminal:*` / `workbench:action-*`
   commands.

After those land, the residual command tables (diff/search, the remaining window /
notification / config / session groups) move out with their controllers, leaving
`AppWindow` as the composition root.
