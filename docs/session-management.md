# Session management

A *session* is the working state of one project root: which
files/terminals/agents are open, how they're laid out, and where the
cursors sit — distinct from `zym.config`, which is global app
settings. State is persisted so it can be restored on demand, and
unsaved work is never lost on exit.

The core is implemented: `SessionManager` (`src/SessionManager.ts`,
storage/format, exposed as `zym.session`) + `SessionController`
(`src/SessionController.ts`, per-window policy), wired from
`src/ui/AppWindow.ts`.

**Sessions are named-only** (the locked model — see "Session identity"
below). A fresh window opens an **unnamed/default** session that is
held in memory and *never persisted*: it is either promoted to a named
session (`session:save`, which acts as save-as when unnamed) or
discarded on close — only unsaved *editor tabs* prompt, never the
session itself. A named session autosaves to
`$XDG_STATE_HOME/zym/sessions/<slug(name)>.json` and is reopened
explicitly through `session:open`. There is **no** automatic per-root
session and **no** restore-on-launch. Multi-root (several projects in
one window) rides on the same `workspaces[]` format; see the multi-root
note below.

This page covers the architecture; per-feature pages can split out
later if they grow.

## Session identity (locked)

- A session is persisted **iff it has a name.** The runtime tracks a
  `currentName: string | null` (`SessionController`); `null` = the
  unnamed/default session, which never touches disk. Naming (via
  save-as) is the *only* thing that promotes a window to a persisted,
  autosaving session.
- **`session:save` on an unnamed session behaves as save-as** — prompt
  for a name, then persist (mirrors an editor's Save on an untitled
  buffer). On a named session it flushes.
- **Unnamed sessions are discarded silently on close.** The only exit
  prompt is the existing modified-*editor* guard (unwritten file
  edits) — losing an unnamed session loses layout/tabs/agent-set, never
  file contents.
- **No restore-on-launch.** A fresh `zym [dir]` always starts unnamed,
  rooted at cwd (the cwd is still the active *project*; only the
  working *set* is unpersisted). Reopening a session is the explicit
  `session:open`.
- **Storage is global and keyed by name.** `slug(name).json` under the
  XDG sessions dir; discovery/switching is the `session:open` picker
  over `zym.session.list()`. Legacy per-root `hash(root).json` files
  from the old autosave model are still *listed* (labelled by
  basename), so they remain openable — nothing auto-loads them.

## Decisions (locked)

These shape everything below:

- **Storage = central XDG state dir**, keyed by **name** — *not*
  in-repo. A session lives at
  `$XDG_STATE_HOME/zym/sessions/<slug(name)>.json` (falling back to
  `~/.local/state`). Clean, never pollutes the project, the natural
  home for the `session:open` picker.
- **Naming/identity:** persisted sessions are named; the filename is a
  slug of the name. Label resolution is still
  `name ?? basename(primaryRoot)` so a legacy no-name file (old
  autosave) shows its root basename in the picker.
- **Lifecycle** (`session.*`), with these defaults:
  - **Never reopen on launch.** A window always starts unnamed;
    reopening is the explicit `session:open`.
  - **Autosave only a named session** (debounced on change + on quit).
    The unnamed/default session never writes.
  - **Prompt on exit only if a widget reports modified data.** This
    requires a first-class **modified-status API/hook** that widgets
    expose (see below) — the centerpiece of this work, not an
    afterthought.

## Constraints carried from the codebase

- **Single-rooted today, multi-root-ready format.** `process.cwd()`
  feeds `FileTree`, `GitRepo`, and `PROJECT_NAME`; the app opens one
  `initialFile`, so the runtime is single-root. But the **storage
  format is shaped for multi-root now** (a list of *workspaces* with
  one active — see below), so adding the active-root switch later is a
  runtime change, not a format migration. The target model is
  agents.md's "the window holds the active root; viewing an agent in
  another worktree switches the active root (FileTree, GitRepo,
  GitBranchButton, title)" — i.e. **one active root at a time,
  switchable**, not several folders shown at once.
- **Sync `Fs` at startup/save is fine.** The "no node I/O on the main
  path" rule is about async `child_process`/promises starved by the
  GLib loop; `config/load.ts` already does synchronous
  `Fs.readFileSync`/`writeFileSync` at boot and on save. Session
  storage follows the same pattern.
- **Strip-only TS** (project memory): no enums, no parameter
  properties, no namespaces. The state shapes below are interfaces +
  discriminated unions.
- **One main component per file** under `src/ui` / `src/`,
  camel-cased.
- **Atom-derived spine.** `zym` mirrors `atom`; `Config` mirrors
  `atom.config`; `eventKit` provides `Emitter`/`Disposable`. The
  serialize/deserialize seam below deliberately mirrors Atom's
  `serialize()` + `atom.deserializers` so the shape is familiar to the
  rest of the code.

## Current state holders (what a session must capture)

- **`PanelGroup` (center)** — the splittable tree: `Split` branches
  (orientation + resized divider `position`) and `Panel` leaves (a tab
  strip, the focused one flagged `active`). Tabs host one of:
  - **`TextEditor`** — `currentFile` + cursor/scroll (vim buffer
    model).
  - **`Terminal`** — a shell; only its `cwd` is meaningful (process
    can't restore).
  - **`AgentTerminal`** — `command` + `cwd` + launch `prompt`; process
    relaunch-only. The `cwd` recorded is the **workbench (worktree) cwd**
    (`effectiveCwd`), not the process spawn dir (always the main dir — see the cwd
    invariant in agents.md); restore re-roots the editor there.
- **`FileTree` (left dock)** — `rootPath` + which directories are
  expanded.
- **`AgentManager` (`zym.agents`)** — the live agent registry.
- **Docks** — notification log visible/hidden; per-side visibility and
  resized extents (the dock Gtk.Paned dimensions).

AppWindow holds the maps that tie widgets to tabs (`editors`,
`terminals`, `agentChildren`), so it is the natural orchestrator;
`PanelGroup` owns the split tree, so it owns the layout walk.

## The two seams

### 1. Serialize / deserialize (saving & restoring shape)

A small registry on **`SessionManager` (`zym.session`)**, mirroring
`atom.deserializers` (actual signatures):

```ts
interface Serializable<T> {
  serialize(): T | null;            // null → "don't persist me" (e.g. an empty tab)
}

// zym.session
registerDeserializer(kind: string, build: (state: TabState) => unknown | null): Disposable;
deserialize(state: TabState): unknown | null;
```

Leaf widgets (`TextEditor`/`Terminal`/`AgentTerminal`) implement
`serialize()` returning a tagged `TabState`. The widget
construction/wiring lives in `SessionController`'s `deserialize` (file
→ `createEditorTab`, terminal → `createTerminalTab`, agent → relaunch
via `restoreAgent`), which AppWindow supplies — keeping claude/agent
and editor specifics out of `SessionManager`.

`PanelGroup` owns the tree walk:

```ts
serializeLayout(serializeChild: (w: Widget) => TabState | null): PanelNode;
restoreLayout(node: PanelNode, buildChild: (s: TabState) => RestoredChild | null): void;
```

### 2. Modified-status (the exit prompt)

The locked decision — "prompt on exit only if a widget reports
modified data" — needs widgets to *report* that. A second optional
interface, surfaced as a hook so the exit path doesn't hard-code
widget types:

```ts
interface SessionParticipant {
  isModified(): boolean;                 // unsaved/at-risk data?
  getModifiedLabel?(): string;           // for the prompt list, e.g. "foo.ts (unsaved)"
  saveModified?(): Promise<void> | void; // optional "Save all" support
}
```

- **`TextEditor`** → `isModified()` reads the buffer's modified flag
  (dirty since last save); `saveModified()` writes the file when it
  has a path.
- **`AgentTerminal` / `AgentConversation`** → **not** modified
  (`isModified()` is `false`). A running agent has nothing to flush and
  is killed on quit, so it never blocks the exit prompt — only unsaved
  editors do. (`getModifiedLabel()` is kept for the Agent surface but
  unused while `isModified` is false.)
- **`Terminal`** (plain shell) → default *not* modified; never blocks
  exit.

`zym.session.collectModified()` walks the registered participants;
AppWindow's `close-request` consults it.

## Storage format

Actual shapes (`src/SessionManager.ts`):

```ts
type TabState =
  | { kind: 'file';     path: string; cursor?: [number, number]; scroll?: number; dirty?: boolean }
  | { kind: 'terminal'; cwd: string }
  | { kind: 'agent';    command: string[]; cwd: string; prompt?: string; sessionId?: string };

type PanelNode =
  | { type: 'leaf';  tabs: TabState[]; activeIndex: number; active?: boolean } // active → the focused leaf
  | { type: 'split'; orientation: 'horizontal' | 'vertical';
      position: number; start: PanelNode; end: PanelNode };                    // position = the resized Gtk.Paned divider

// One root's working state. A window switches its active root by swapping which
// WorkspaceState is live (re-rooting FileTree/GitRepo/title) — see agents.md.
interface WorkspaceState {
  root: string;                 // the cwd / worktree path
  layout: PanelNode;
  fileTree?: { expanded: string[] };
  agent?: AgentTabState;        // present → this is an agent workbench (relaunch on restore)
}

interface SessionState {
  version: number;              // SESSION_VERSION (currently 1)
  name?: string;                // persisted iff named; absent only on legacy no-name files
  savedAt: string;              // ISO timestamp, stamped by save()
  workspaces: WorkspaceState[]; // runtime writes one user workspace + one per live agent
  activeWorkspace: number;      // index into workspaces of the focused workbench (0 = user)
  // window-level, shared. `visible` = per-side dock-visibility toggle
  // (left/right/top/bottom); absent → all sides shown. `sizes` = each side's resized
  // extent (width left/right, height top/bottom) so a dragged Gtk.Paned is restored.
  docks?: { notificationLog: boolean;
            visible?: { left: boolean; right: boolean; top: boolean; bottom: boolean };
            sizes?: { left?: number; right?: number; top?: number; bottom?: number } };
  window?: { width: number; height: number; maximized: boolean };
}
```

`workspaces[0].root` is the **primary root** — the default label
source. `workspaces[0]` is always the **user** workspace; the runtime
carries one project today, so restore rebuilds it and relaunches the
rest as agent workbenches. `activeWorkspace` records the **focused
workbench** at save time — 0 for the user, else the active agent's
index — and restore re-activates it (`activateWorkspace`): focus
follows the user back to wherever they were (the user workbench or one
of the relaunched agents). Multi-root (above) generalizes `slice(1)`
into "each workspace is a project or an agent."

`SessionManager` resolves the path
(`<state>/zym/sessions/<slug(name)>.json`), reads/writes via sync `Fs`
(mkdir -p, atomic temp+rename), and validates `version`. Persisted
sessions are always named, so the filename is the name slug;
`loadByName(name)` reads one back and `list()` enumerates the dir for
the `session:open` picker.

## Lifecycle

- **Autosave** (`session.autosave`, default on) — **named sessions
  only.** A debounced `saveNow()` on layout/tab/cursor changes (hooking
  the same events that drive the title and active-tab sync), plus a
  final flush in `close-request`. When `currentName === null` the
  autosave/flush/save paths all early-return, so the unnamed session
  never touches disk.
- **Open** is explicit: `session:open` picks a named session from
  `zym.session.list()` and switches into it (flush the current named
  session, close its agents, then `applyState` the target). There is no
  launch restore. Because the switch tears down the current window's
  editors, it is **guarded by the same unsaved-work prompt as quitting**
  (`confirmUnsavedWork`, gated on `session.promptOnExitWhenModified`) —
  so a switch never silently drops unwritten edits.
- **Exit prompt**: `close-request` calls `collectModified()`. If
  non-empty (and `session.promptOnExitWhenModified`, default on),
  `close-request` blocks (`return true`) and shows an
  `Adw.AlertDialog` listing the modified widgets with **Save all /
  Discard / Cancel**; it proceeds to `onQuit()` only on Save-all
  (after saves) or Discard. Only unsaved **editors** are modified, so
  the prompt is purely about unwritten edits; running agents are *not*
  modified — they never appear and are killed on quit without a prompt.

## Config schema (`session.*`)

```ts
session.autosave: boolean                  // default true (named sessions only)
session.promptOnExitWhenModified: boolean  // default true
session.autosaveDebounceMs: integer        // default 1000
```

Registered on `zym.config` like the rest; editable via the existing
`ConfigEditor` for free. (`session.restoreOnLaunch` was removed with the
named-only model — there is no launch restore.)

## Commands

- `session:save` (`space s s`) — flush the active named session; on the
  unnamed/default session it **acts as save-as** (prompt for a name,
  then persist).
- `session:save-as` (`space s a`) — always prompt for a name and save
  under it (also forks a named session under a new name).
- `session:open` (`space s o`) — picker over `zym.session.list()`
  (label + `relativeTime(savedAt)`); switches into the chosen session.
- `session:rename` — rename the active named session (moves the json +
  its `.buffers`); no-op + toast on the unnamed session.
- `session:delete` — picker → forget a session (its json + `.buffers`);
  guards the active one.

Handlers on `#AppWindow`; bindings in `src/keymaps/default.ts`.

## Feature: named sessions

Named sessions are the persistence model (see "Session identity"
above): a window keeps **named, switchable working sets** — "review",
"feature-x", "debugging" — and the unnamed default is ephemeral.

### The runtime spine

`SessionController` carries a `currentName: string | null` (null = the
unnamed/default session):

- `serialize()` stamps `name: currentName ?? undefined`.
- `scheduleAutosave()`, `flush()`, and `saveNow()` **early-return when
  `currentName === null`** — the persistence gate. Nothing on disk for
  an unnamed window.
- `saveAs(name)` sets `currentName`, then `saveNow()`.
- `open(state)` — flush the current named session, close its agents,
  `applyState(state)` (the extracted body of the old `restore()`:
  rebuild the user layout, relaunch agents, apply docks/window), and
  set `currentName = state.name ?? null`.
- `renameSession(newName)` / `deleteSession(state)` delegate to
  `SessionManager`.

### SessionManager storage

- `fileName()`/`pathFor()` key by `slug(name)` (the `hash(root)` write
  path is gone; writing an unnamed state is a bug). `pathForName(name)`
  + `loadByName(name)` read one back.
- `rename(state, newName)` writes the new json and **moves the
  `.buffers/` dir**, then removes the old json.
- `delete(state)` removes the json **and its `.buffers/`** (previously
  it leaked the buffer dir).
- `list()` still reads every `*.json`, so legacy no-name files surface
  in the picker (labelled by basename via `label()`); nothing
  auto-loads them.

### Locked decisions (this feature)

- **Unnamed close = silent discard.** Only the modified-editor prompt
  fires; the session itself is never save-prompted.
- **No restore-on-launch.** Always start unnamed.
- **`session:save` on unnamed = save-as.**
- **`session:open` uses replace semantics** — the current window is
  torn down (agents closed) and the target applied.

## Multi-root (several projects in one window)

**Live multi-project is implemented.** A workbench owner is
`Project | Agent` (`src/ui/workbench/Owner.ts`) — `Project` replaced the
former `'user'` singleton. `WorkbenchManager` holds an ordered
`projects[]` (the primary is `projects[0]`, the fallback owner) with
`addProject(root)` / `closeProject` / `closeNonPrimaryProjects` and a
`did-change-projects` emitter.

**Each workbench belongs to a project, and the rail groups by it.** A
`Project` is a *grouping*: its own **default ("you") workbench** (the
owner) plus the agents launched under it. The association is explicit
(`agentProject`, set in `buildWorkbench` to the project active at launch)
— *not* the agent's cwd, since agents always spawn under the primary main
dir (agents.md cwd invariant). `projectOf(owner)` / `activeProject()` /
`projectGroups()` expose it; the WorkbenchList rail renders each project
as a section **headed by its default workbench row** (which shows the
project name) over its agent rows, a margin separating the groups, and
switches between owners (the same one-active-root switch agents already
use — `activateWorkbench`). The rail rebuilds on
`did-change-projects` (emitted from `buildWorkbench` *after* the workbench
+ association exist — the agent's own `did-add-agent` fires too early to
group). Commands:

- `project:open` (`space p o`) — a folder picker; opens the chosen
  folder as a project workbench and switches to it (dedups an
  already-open root).
- `project:close` (`space p c`) — closes the active project (never the
  last one); agents rooted under it keep running in their own worktrees.

**Persistence is not yet multi-project.** `serialize()`/`applyState()`
still record just the primary project (`workspaces[0]`) + agents, and
`session:open` resets extra projects (`closeNonPrimaryProjects`) before
applying. The format already supports N projects — `workspaces[]`
discriminates a **project** workspace (no `agent`) from an **agent** one
(`agent` present) — so finishing this is the runtime change of
`serialize` emitting one workspace per project and `applyState`
iterating (`agent ? relaunchAgent : buildProjectWorkbench`) instead of
assuming a single project at index 0.

## Edge cases

- **Missing files** on restore → skip the tab, aggregate into one
  notification ("N files no longer exist"). Never block the restore.
- **Cursor out of range** (file shrank on disk) → clamp to the
  buffer's bounds.
- **Unsaved buffer *contents*** are persisted: a per-session buffer
  cache (`<sessionfile>.buffers/<sha1(path)>`,
  `SessionManager.writeBuffers`/`readBuffer`) stores modified editors'
  text on each save; restore reopens dirty tabs from the cache and
  re-marks them modified (`Document.restoreUnsaved`). Path + cursor +
  scroll are stored regardless; the exit prompt remains the guard for
  unwritten work.
- **Agents** are recorded as their own workspaces (one
  `WorkspaceState` per agent workbench, marked by an `agent` field —
  its relaunch identity from `AgentTerminal.serialize`) after the
  primary (user) workspace. Each workspace's `root` is the agent's
  **workbench cwd** (its worktree); restore re-roots the editor there
  directly (`openAgent({ root: ws.root })`), so it needs no
  set_worktree re-announce from the agent. On **restore** each is
  relaunched **resumed** (`--resume <id>`, via `resumeOptions` — which
  relocates the transcript under the main dir and supplies the resume
  id, while `ws.root` overrides where the editor roots) and does *not*
  re-run the original launch prompt. Relaunch is fine because `session:open`
  is explicit, not a surprise. An agent with no
  session id is relaunched fresh with its prompt; one already open is
  skipped (no duplicate). After relaunch, the agent's work-area
  **files are reopened** from its saved layout (rooted in that
  workbench); the work-area *split geometry* isn't preserved (the
  pinned-agent center doesn't fit the generic `restoreLayout` path, so
  files reopen as a flat strip).
- **Stale/corrupt session file** → warn and ignore (like the config
  loader); never throw, never block startup.
- **Empty/placeholder tabs** serialize to `null` and are dropped.

## Remaining / planned

- [x] Named sessions (the persistence model) — `currentName`,
      save/save-as/open/rename/delete, name-keyed storage.
- [ ] Multi-root: hold several project workspaces in one window,
      switched from the WorkbenchList rail (see the multi-root note);
      builds on the named-session spine.

## Open questions

None blocking. Multi-root is the next runtime step and needs no
session-format change.
