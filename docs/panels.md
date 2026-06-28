# Panels & layout

The workbench is a dock layout (`Workbench`, `src/ui/Workbench.ts`) around a
splittable center (`PanelGroup`, `src/ui/PanelGroup.ts`). The shared building
block is `Panel` (`src/ui/Panel.ts`): a tab host (Adw.TabBar + Adw.TabView)
with a friendly empty-state placeholder. Every tab group in the app — the
center editor groups **and** the docks (the Files side dock, the bottom
Notifications/Diagnostics/Keybindings docks) — is a `Panel`. (Source Control
opens as a center tab, not a dock — see docs/git/index.md.)

- **`Panel`** — one tab strip. `add(widget, { title?, requireTabBar? })` is
  the *only* way content enters a panel. With no tabs it shows the
  **welcome surface** (`welcomePanel()`, `src/ui/WelcomePanel.ts`): a sleeping
  cat over a keybinding cheatsheet and a charitable callout, shown in *any*
  empty panel (no per-panel variant).
- **`PanelGroup`** (center) — a binary tree of `Split` (Gtk.Paned) branches
  and `Leaf`/`Panel` leaves; any split layout is expressible.
  Splitting/closing reshapes the tree; the root leaf may sit empty (shows the
  placeholder). Still supports a `pinned` leaf (a center leaf that can't be split
  or collapsed; opens beside it land in the work area via `openPanel` /
  `ensureWorkArea`), though agents no longer use it — the agent widget lives in the
  window-level agent sidebar (below), leaving the agent center an ordinary work area.
- **`Workbench`** — fixed dock slots (left/right/top/bottom, nested
  Gtk.Paned) around the center. One Workbench per "person" (the user, each
  agent); switching person swaps which Workbench the window shows (see
  docs/agents.md). The Files tree dock lives in the **right** slot — note the
  misleading `leftPanel` field / `revealFileTree` names, which dock via
  `setRight`. (Source Control is a center tab, not a dock — `revealGitPanel`.)
- **`AgentSidebar`** (`src/ui/AgentSidebar.ts`) — not a workbench slot but a
  **window-level** full-height column (its own `Adw.ToolbarView` header + a
  `Gtk.Stack` of every open agent's widget), shown between the WorkbenchList and the
  content for an agent workbench. AppWindow attaches/detaches it on its own
  `agentPaned` and flips the visible stack page on switch (see docs/agents.md "agent
  secondary sidebar"). It's a top-level focus zone, so `ctrl-w h/l` reaches it.

## Dock visibility (toggleable docks)

Each dock side is **independently show/hide-able without discarding its
panels**. `Workbench` tracks a side's assigned *content* and its *visibility*
separately (`dockContent` / `dockVisible`); the Paned slot shows the content
only when the side is both occupied and visible, so hiding a dock just detaches
its widget (tabs/state live on inside it) and re-showing re-attaches the same
widget.

- API: `setDockVisible(side, visible)` / `toggleDock(side)` (no-op on an empty
  side) / `isDockVisible(side)` / `isDockOccupied(side)` / `dockVisibility()`.
- The content setters (`setLeft/Right/Top/Bottom`) **force the side visible**
  when given non-null content — putting something in a dock means you want to
  see it — so the content pickers (bottom dock
  notifications/diagnostics/keymap, side-dock `revealFileTree`) need no separate
  "show" call. The bottom-dock content toggles
  (`toggleNotificationLog`/`toggleDiagnosticsPanel`/`toggleKeymapPanel`) only
  *close* when their panel is the currently-**shown** content; if it's selected
  but the dock was hidden via the visibility toggle, they re-reveal it.
- Commands `dock:toggle-{left,right,top,bottom}` (`ctrl-w g h/j/k/l`, by vim
  direction: h=left, j=bottom, k=top, l=right), handled in
  `AppWindow.toggleDockSide` (focuses into a freshly-shown dock; falls focus
  back to the center when hiding out from under it). Left/top carry no built-in
  content yet, so toggling them is a no-op + toast until a plugin contributes a
  panel there. (The agent widget is *not* a dock — it's the window-level agent
  sidebar; see `AgentSidebar` above.)
- The window-level **workbench sidebar** (the left-most `#WorkbenchSidebar`
  column, also not a dock) has its own visibility toggle `sidebar:toggle`
  (`ctrl-w g s`), handled in `AppWindow.toggleSidebar`. Like the agent sidebar,
  it detaches/attaches the top-level split's start child (rather than toggling
  `visible`) so the absent column leaves no stray handle, restoring its last
  width (collapsed or expanded) on show.
- **Default state**: the user workbench's right dock (Files) is
  *assigned but hidden* at startup — the `Workbench` constructor calls `setRight`
  then `setDockVisible('right', false)`, so the dock toggle / `file-tree:focus`
  have content to reveal, but it stays out of the way until asked for. A restored
  session re-applies the user's last visibility (below).
- **Session-persisted**: `SessionDocks.visible` (per-side flags) is
  saved/restored with the rest of the dock state; a toggle schedules an
  autosave. Sessions with no `visible` entry restore all sides shown.
  `SessionDocks.sizes` carries each *shown* side's resized extent (width
  for left/right, height for top/bottom) — `Workbench.dockSizes()` reads
  the live allocations, `setDockSizes()` re-applies them so a dragged
  Gtk.Paned handle survives a restore (an absent side falls back to its
  default width / `DOCK_FRACTION` height). The center `PanelGroup`'s own
  split positions ride along in the layout tree (`PanelNode.split.position`).

## Active / focus management

Governing rules, implemented in `Panel` + `PanelGroup`:

- **One active panel at a time — the one containing keyboard focus.** `Panel`
  owns a single static `activePanel`. Each panel installs an
  `EventControllerFocus` on its root; on `enter` it calls `activate()`,
  becoming the active panel and deactivating the previous one (a leaf *or* a
  dock). The center's `PanelGroup` syncs its active **leaf** via the
  `onActivate` callback (so "where new tabs open" follows focus); docks just
  flip active state. The active leaf is **session-persisted**: `serializeLayout`
  marks it (`PanelNode.leaf.active`) and `restoreLayout` re-activates it (not
  just the first leaf), so a restore puts focus back where it was.
- **Overlay exception.** Focus moving onto an overlay (command palette, file
  picker, popover that isn't parented inside a panel) fires no panel's `enter`,
  so the active panel is left unchanged. Activation is `enter`-only — we never
  deactivate on `leave` — which is what gives the exception for free.
- **Panels accept focus on their top-level widget.** `Panel.root` is
  `focusable`, so a panel can take focus and steal the active state even with
  no focusable content (e.g. an empty pane after a split —
  `focusEmptyState()` grabs the root, not the placeholder).
- **`.active-empty` outline = direct keyboard focus on a panel-level widget.**
  Applied (focus-driven, via `updateFocusOutline`) to whichever widget holds
  *direct* focus when that widget is the panel root (empty pane) or a direct
  panel child. Content that delegates focus to a descendant (an editor's view)
  shows its own focus ring and gets no outline. Styled with a thin
  selection-colored outline (`theme.ui.surface.selected`).
- **Every panel child is marked `.is-panel-child`.** `add()` stamps the class
  on every child; it is the sole entry point, so no widget reaches a panel
  without it. Focus/active logic relies on that class to identify direct panel
  children. `Panel.containing(child)` resolves a child back to its panel (a
  `WeakMap`).
- **Page moves keep `Panel.containing` honest.** The `WeakMap` and
  `.is-panel-child` marking are maintained on the TabView's `page-attached` /
  `page-detached` signals, not just in `add()`, so an Adw tab **drag-and-drop
  transfer** between panels (which fires detach-then-attach) re-binds the child to
  its new panel. `page-detached` only clears the mapping if this panel is still the
  recorded owner — a transfer's attach on the destination wins regardless of signal
  order. (Without this, a dragged tab kept the source panel's stale mapping; a
  reused widget's reveal logic then re-`add()`ed it into a second page, orphaning
  it — see the reveal rule below.)

## Tab bar

- Lone-tab is chromeless (tab bar hidden) — we drive `bar.setVisible`
  manually instead of Adw autohide (which animates a revealer). Exception: a
  child added with `requireTabBar: true` (editors) keeps its title shown at all
  times.
- `bar.setExpandTabs(false)` — tabs size to content (Adwaita caps +
  ellipsizes) rather than stretching to fill the width. The tab bar has a
  bottom border.

## Dock close behavior & the "zombie" rule

Re-adding a previously-closed widget into an Adw.TabView that is **detached
(unrooted)** yields a blank page (Adw leaves the closed child in a
not-yet-finalized page). The rule: **never `add()` into an unrooted tab view.**

- **Bottom docks (Notifications/Diagnostics/Keybindings)** — single
  persistent views. Each panel's `onTabCloseRequest` (`hideBottomDock`)
  intercepts the tab close to *hide the dock* and veto the page close, so the
  view never tears down; re-toggling (e.g. `space l l` for Diagnostics,
  `space n` for Notifications) re-shows the same widget with no rebuild.
- **Side dock (right Files)** — keeps **per-tab close**. Closing the last tab
  collapses the dock (`leftPanel`'s `onEmpty` → `detachDock` → `setRight(null)`).
  The reveal/focus path (`revealFileTree`) **re-attaches (roots) the panel via
  `setRight` before re-adding the tab** (unparenting any closed page first), so the
  `add()` always targets a rooted view. (Source Control opens as a center tab
  instead — `revealGitPanel` follows the same unparent-then-add rule against the
  always-rooted center.)
- **Reusing a center widget → reveal via the live tree, never a stored handle.**
  The `GitPanel` (and any reused center tab) is created once and re-shown across
  close/reopen. `revealGitPanel` asks `PanelGroup.reveal(root)` — which walks the
  **current** leaves and selects the page if found — instead of trusting a saved
  `PanelChild` handle or `Panel.containing`. Those can point at a panel that a tab
  drag moved it out of, or that a layout rebuild (`restoreLayout` discards the old
  tree without closing its pages) detached: selecting such a page shows nothing and
  `unparent()`-ing a *live* page child corrupts it into a zombie that vanishes from
  the tree. A `false` from `reveal` means it is not shown **in the center**, but the
  widget may still be live elsewhere — its tab can be dragged into a *dock* (a `Panel`
  outside the center, which `PanelGroup.reveal` doesn't walk). So before unparenting,
  `revealGitPanel` checks `gitPanel.root.getRoot()`: non-null means it is still in the
  live window tree (e.g. the dock), so it reveals it in place via
  `Panel.containing(root).reveal(root)` and never unparents it; only a null `getRoot()`
  (closed, or orphaned by a layout rebuild) is safe to `unparent()` + `add()` fresh.
  Tested in `GitPanelReveal.test.ts`.
- **Agents** — each agent's widget is a `Gtk.Stack` page in the window-level
  `AgentSidebar`, not a tab — so it's inherently uncloseable (no tab, no close
  button). Switching person flips the visible page and swaps the shown Workbench, so
  the process keeps running and the agent's state is preserved (nothing reparented).

## Focus memory

Per-tab focus memory (`AppWindow.focusMemory`, keyed by the `.is-panel-child`
content widget, driven by the window's `notify::focus-widget`): re-activating a
panel restores focus to the exact widget that last held it in that tab (e.g.
an editor's search bar), falling back to the tab's default focus target. Focus
on the tab's own root drops the entry (so restore re-derives from the tab
itself).

## Remaining / planned

- [ ] Left and top docks carry no built-in content; toggling them is a no-op +
  toast until a plugin contributes a panel there.
