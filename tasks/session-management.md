# Session management

Architecture plan for the Session management section. A *session* is the working
state of one project root: which files/terminals/agents are open, how they're
laid out, and where the cursors sit — distinct from `quilx.config`, which is
global app settings. The goal is to persist that state so it can be restored on
demand, and to never lose unsaved work on exit.

This page covers the architecture; per-feature pages can split out later if they
grow.

## Decisions (locked)

These were settled up front and shape everything below:

- **Storage = central XDG state dir**, keyed by root path — *not* in-repo. A
  session lives at `$XDG_STATE_HOME/quilx/sessions/<filename>.json` (falling back
  to `~/.local/state`). Clean, never pollutes the project, and the natural home for
  a future "open another project's session" picker.
- **Naming/identity:** the filename is a **hash of the primary root** unless the
  user gives the session an explicit **name** (then a slug of the name). The hash
  is opaque, so **wherever a text label is needed** (picker, title) and there is no
  user name, show the **primary root's directory basename**, never the raw hash.
  Label resolution: `name ?? basename(primaryRoot)`.
- **Lifecycle is configurable** (`session.*`), with these defaults:
  - **Do not reopen on launch.** Restore is an explicit action (`session:restore`
    / a picker), never automatic. (A `session.restoreOnLaunch` opt-in exists for
    users who want it.)
  - **Autosave silently** (debounced on change + on quit) so a manual restore has
    something to load.
  - **Prompt on exit only if a widget reports modified data.** This requires a
    first-class **modified-status API/hook** that widgets expose (see below) — the
    centerpiece of this work, not an afterthought.
- **An explicit file arg suppresses restore.** `quilx foo.ts` means "just open
  this"; restore never fires implicitly off a launch. Restore is always the user
  asking for it.

## Constraints carried from the codebase

- **Single-rooted today, multi-root-ready format.** `process.cwd()` feeds
  `FileTree`, `GitRepo`, and `PROJECT_NAME`; the app opens one `initialFile`, so the
  MVP runtime is single-root. But the **storage format is shaped for multi-root now**
  (a list of *workspaces* with one active — see below), so adding the active-root
  switch later is a runtime change, not a format migration. The target model is
  agents.md's "the window holds the active root; viewing an agent in another
  worktree switches the active root (FileTree, GitRepo, GitBranchButton, title)" — i.e.
  **one active root at a time, switchable**, not several folders shown at once.
- **Sync `Fs` at startup/save is fine.** The "no node I/O on the main path" rule
  is about async `child_process`/promises starved by the GLib loop; `config/load.ts`
  already does synchronous `Fs.readFileSync`/`writeFileSync` at boot and on save.
  Session storage follows the same pattern.
- **Strip-only TS** (project memory): no enums, no parameter properties, no
  namespaces. The state shapes below are interfaces + discriminated unions.
- **One main component per file** under `src/ui` / `src/`, camel-cased.
- **Atom-derived spine.** `quilx` mirrors `atom`; `Config` mirrors `atom.config`;
  `eventKit` provides `Emitter`/`Disposable`. The serialize/deserialize seam below
  deliberately mirrors Atom's `serialize()` + `atom.deserializers` so the shape is
  familiar to the rest of the code.

## Current state holders (what a session must capture)

- **`PanelGroup` (center)** — the splittable tree: `Split` branches (orientation +
  position) and `Panel` leaves (a tab strip). Tabs host one of:
  - **`TextEditor`** — `currentFile` + cursor/scroll (vim buffer model).
  - **`Terminal`** — a shell; only its `cwd` is meaningful (process can't restore).
  - **`AgentTerminal`** — `command` + `cwd` + launch `prompt`; process relaunch-only.
- **`FileTree` (left dock)** — `rootPath` + which directories are expanded.
- **`AgentManager` (`quilx.agents`)** — the live agent registry.
- **Docks** — notification log visible/hidden; left-paned split position.

AppWindow already holds the maps that tie widgets to tabs (`editors`,
`terminals`, `agentChildren`), so it is the natural orchestrator; `PanelGroup`
owns the split tree, so it owns the layout walk.

## The two seams

### 1. Serialize / deserialize (saving & restoring shape)

A small registry on a new **`SessionManager` (`quilx.session`)**, mirroring
`atom.deserializers`:

```ts
interface Serializable<T> {
  serialize(): T | null;            // null → "don't persist me" (e.g. an empty tab)
}

// quilx.session
registerDeserializer(name: string, build: (state: any) => Widget | null): void;
deserialize(state: { kind: string }): Widget | null;
```

Leaf widgets implement `serialize()` returning a tagged `TabState`; AppWindow
registers a deserializer per `kind` that knows how to construct the widget and
re-wire it (the same wiring `openFile`/`openTerminal`/`openAgent` do today). This
keeps claude/agent specifics and editor specifics out of `SessionManager`.

`PanelGroup` grows the tree walk (it owns the tree):

```ts
serializeLayout(serializeChild: (w: Widget) => TabState | null): PanelNode;
restoreLayout(node: PanelNode, deserializeChild: (s: TabState) => Widget | null): void;
```

### 2. Modified-status (the exit prompt)

The locked decision — "prompt on exit only if a widget reports modified data" —
needs widgets to *report* that. A second optional interface, surfaced as a hook
so the exit path doesn't hard-code widget types:

```ts
interface SessionParticipant {
  isModified(): boolean;                 // unsaved/at-risk data?
  getModifiedLabel?(): string;           // for the prompt list, e.g. "foo.ts (unsaved)"
  saveModified?(): Promise<void> | void; // optional "Save all" support
}
```

- **`TextEditor`** → `isModified()` reads the buffer's modified flag (dirty since
  last save); `saveModified()` writes the file when it has a path.
- **`AgentTerminal`** → `isModified()` is true while the agent is **running**
  (`status !== 'exited'`); `getModifiedLabel()` → e.g. `"claude (running)"`. No
  `saveModified` (nothing to flush); on quit the process is killed. It's listed in
  the exit prompt as live work.
- **`Terminal`** (plain shell) → default *not* modified; never blocks exit.

`quilx.session.collectModified()` walks the registered participants; AppWindow's
`close-request` consults it.

## Storage format

```ts
type TabState =
  | { kind: 'file';     path: string; cursor?: [number, number] }
  | { kind: 'terminal'; cwd: string }
  | { kind: 'agent';    command: string[]; cwd: string; prompt?: string };

type PanelNode =
  | { type: 'leaf';  tabs: TabState[]; activeIndex: number }
  | { type: 'split'; orientation: 'horizontal' | 'vertical';
      position: number; start: PanelNode; end: PanelNode };

// One root's working state. A window switches its active root by swapping which
// WorkspaceState is live (re-rooting FileTree/GitRepo/title) — see agents.md.
interface WorkspaceState {
  root: string;                 // the cwd / worktree path
  layout: PanelNode;
  fileTree?: { expanded: string[] };
}

interface SessionState {
  version: 1;
  name?: string;                // user-given; absent → label = basename(primaryRoot)
  savedAt: string;              // ISO timestamp
  workspaces: WorkspaceState[]; // MVP writes exactly one; format allows many
  activeWorkspace: number;      // index into workspaces; MVP: 0
  docks?: { notificationLog: boolean; leftSplit?: number }; // window-level, shared
}
```

`workspaces[0].root` is the **primary root** — the hash source and the default
label. The MVP always writes a single workspace and `activeWorkspace: 0`; the
runtime carries no root-switch yet. Restoring just rebuilds `workspaces[active]`.
Layering multi-root on later means: keep more than one workspace, and let the
active-root switch swap which one drives `FileTree`/`GitRepo`/`GitBranchButton`/title —
no format change.

`SessionManager` resolves the path
(`<state>/quilx/sessions/<slug(name) ?? hash(primaryRoot)>.json`), reads/writes via
sync `Fs` (mkdir -p, atomic temp+rename), validates `version`, and refuses to apply
a session whose primary root doesn't match the current cwd (until the root-switch
lands). The hash keeps filenames short and avoids path-length limits; the label
never shows it (see Naming/identity).

## Lifecycle

- **Autosave** (`session.autosave`, default on): a debounced `saveNow()` on
  layout/tab/cursor changes (hook the same events that already drive the title and
  active-tab sync), plus a final flush in `close-request`.
- **Restore** is explicit: `session:restore` rebuilds the saved layout for the
  current cwd (notifying on anything it had to skip). `session.restoreOnLaunch`
  (default off) lets a bare `quilx` launch auto-restore; an explicit file arg
  always suppresses it.
- **Exit prompt**: `close-request` calls `collectModified()`. If non-empty (and
  `session.promptOnExitWhenModified`, default on), show an `Adw.AlertDialog`
  listing the modified widgets with **Save all / Discard / Cancel**; only proceed
  to `onQuit()` on Save-all (after saves) or Discard. "Save all" only applies to
  participants with `saveModified` (editors); running agents have nothing to save,
  so they're listed for awareness and killed on quit. Today's handler returns
  `false` (allow close) immediately — it becomes: block (`return true`), prompt,
  then quit on confirm.

## Config schema (`session.*`)

```ts
session.autosave: boolean                  // default true
session.restoreOnLaunch: boolean           // default false
session.promptOnExitWhenModified: boolean  // default true
session.autosaveDebounceMs: integer        // default 1000
```

Registered on `quilx.config` like the rest; editable via the existing
`ConfigEditor` for free.

## Commands

- `session:save` — force a save now.
- `session:restore` — restore the current cwd's session into the workbench.
- `session:open` — picker over *all* stored sessions (other roots) — **future**,
  pairs with multi-root.

Handlers on `#AppWindow`; bindings added centrally in `src/keymaps/default.ts`.

## Edge cases

- **Missing files** on restore → skip the tab, aggregate into one notification
  ("N files no longer exist"). Never block the restore.
- **Cursor out of range** (file shrank on disk) → clamp to the buffer's bounds.
- **Unsaved buffer *contents*** are *not* persisted in the MVP — only path +
  cursor. The exit prompt is the data-loss guard. Persisting actual unsaved text
  (a buffer cache keyed off the session) is a noted future enhancement.
- **Agents** are recorded as their own workspaces (one `WorkspaceState` per agent
  workbench, marked by an `agent` field — its relaunch identity from
  `AgentTerminal.serialize`) after the primary (user) workspace. On **restore** each
  is relaunched **resumed** (`--resume <id>`, via `resumeOptions`), which also
  restores its worktree (see agents.md) and does *not* re-run the original launch
  prompt. Relaunch is fine here because restore is explicit (or the opt-in
  `restoreOnLaunch`), not a surprise. An agent with no session id is relaunched
  fresh with its prompt; one already open is skipped (no duplicate). **Deferred:**
  restoring each agent workbench's work-area file tabs (the layout is recorded for
  forward-compat but not yet rebuilt — the pinned-agent center makes a generic
  layout-restore awkward).
- **Stale/corrupt session file** → warn and ignore (like the config loader); never
  throw, never block startup.
- **Empty/placeholder tabs** serialize to `null` and are dropped.

## Phasing

- [x] `SessionManager` (`quilx.session`): XDG path resolution, versioned read/write
      (atomic), `session.*` config schema, the deserializer registry.
- [x] Serialize seam: `Serializable` on `TextEditor`/`Terminal`/`AgentTerminal`;
      `PanelGroup.serializeLayout`/`restoreLayout`; `FileTree` expansion state.
- [x] Modified-status seam: `SessionParticipant` hook + `collectModified()`; the
      exit-prompt `Adw.AlertDialog` (Save all / Discard / Cancel) replacing the
      immediate quit.
- [x] Lifecycle wiring: debounced autosave + on-quit flush; `session:restore` /
      `session:save` commands + keymap; launch-arg suppresses restore.
      (`SessionController`, wired from `AppWindow`; `space s s` / `space s r`.)
- [x] Cursor save/restore (with clamping) and missing-file skip notifications.
- [x] Agents in sessions — each agent workbench serialized as a `WorkspaceState`
      (with an `agent` relaunch identity); relaunched resumed (worktree restored) on
      explicit `session:restore` / `restoreOnLaunch`, deduped against live agents.
      Work-area file-tab layout deferred.
- [ ] Multi-root sessions + `session:open` picker — co-design with agent worktrees.

## Settled

The four prior open questions, now decided:

- **Filename/identity** → **hash of the primary root**, unless the user names the
  session (then a name-slug). The raw hash is never shown; labels resolve to
  `name ?? basename(primaryRoot)`.
- **Multi-root** → not in the MVP *runtime*, but the **format is prepared for it
  now** (`workspaces[]` + `activeWorkspace`), so it's a later runtime change, not a
  migration. Co-designed with agents.md's active-root switch.
- **Agents in sessions** → each agent workbench is its own workspace; on restore
  they're **relaunched resumed** (restore is explicit / opt-in, so this is the
  user's intent, not a surprise) — the original launch prompt is not re-run. A
  **running** agent (status not `exited`) **does** block exit and is listed in the
  prompt — it's live work in progress. Plain terminals do not block; unsaved
  editors do.
- **Restore semantics** → `session:restore` **replaces** the current workbench
  ("reopen my session"), consistent with the workspace-swap model.
- **Unsaved buffer text** → **not persisted** in the MVP; path + cursor + the exit
  prompt is the guard. A buffer cache is a noted future enhancement.

## Open questions

None blocking — the above are settled. Remaining choices are implementation-level
(e.g. the exact debounce wiring, hash function) and can be made during phase 1.
