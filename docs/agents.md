# Agents

Run coding agents (Claude today, other tools later) inside zym. **Two
rendering implementations** share one workbench / list / lifecycle /
worktree spine — they differ only in how a turn is displayed:

- **`claude-tui`** *(shipped default)* — the agent's own terminal UI hosted
  in a `Vte.Terminal` tab. Mature; live status via Claude Code hooks.
  `src/ui/AgentTerminal.ts` + `src/agents/claude-tui/session.ts`.
- **`claude-sdk`** *(opt-in via `agent.implementation: "claude-sdk"`)* —
  drives a persistent `claude -p` stream-json process headlessly and renders
  the conversation in **native GTK widgets** (no terminal, no Ink/Vte repaint
  cost). Deep dive: **[agents/claude-sdk.md](agents/claude-sdk.md)**.

`src/agents/configs.ts` is the kind registry — `resolveAgentKind()` picks the
kind from the config flag (default `claude-tui`); a single
`AppWindow.openAgent()` launch path serves both, each agent getting its own
workbench.

The open work is **depth, cross-kind**: agent profiles/customization (incl.
tools other than claude), richer management UX, git-worktree integration, and
reviewing an agent's diff — detailed below. Per-feature pages split out as
they grow (`agents/claude-sdk.md` already has).

## Current state

What already exists and is reused, not rebuilt:

- **Per-person workbenches** — `src/ui/Workbench.ts` is a first-class object:
  one person's dock frame (left/right/top/bottom/center) **plus the widgets
  that fill its slots** — its own `center`, `fileTree`, Source-Control,
  `leftPanel`, and the four bottom-dock panels — with an `owner` field naming
  its person. **Each person in the WorkbenchList owns a fully self-contained
  `Workbench`; nothing is shared or reparented across workbenches.**
  `buildWorkbench(owner, cwd)` constructs those widgets (rooted at `cwd`) and
  hands them to `new Workbench(owner, contents, { showSideDock })` (which docks
  the center, and Source-Control for the user); it registers the workbench in
  `AppWindow.workbenches` (owner → `Workbench`). `AppWindow` holds only
  `this.workbench` (the active one) and reads all per-person state straight off
  `this.workbench.*` (`this.workbench.center`, `this.workbench.bottomDock`, …)
  — there is **no mirror struct and no save/restore on switch**.
  `activateWorkbench(workbench)` just sets `this.workbench`, swaps the overlay
  child (`overlay.setChild(workbench.root)`), and re-selects the row.
  `activateOwner(owner)` resolves a person → their `Workbench`;
  `cycleWorkbench(±1)` (bound to `super-,` / `super-.`) steps the active
  workbench through `[user, …agents]` (the workbench-list order), wrapping.
  `workbench:picker` (`space a w`, `src/ui/WorkbenchPicker.ts`) fuzzy-jumps to
  any of that same set in one go — a quick-switcher over the picker UI (parallel
  to `agent:picker`, but it lists the **user** workbench too and marks the
  current one), `onSelect` → `activateOwner`.
  Detached workbenches stay alive, so a terminal's scrollback / open editors
  survive a switch. An agent's widget (`AgentTerminal`/`AgentConversation`) does
  **not** live in its workbench at all: it's shown in a window-level **secondary
  sidebar** (`src/ui/AgentSidebar.ts`) — a full-height column *outside* the header
  bar, between the WorkbenchList and the content, themed with the libadwaita
  `secondarySidebar` colors. Like WorkbenchList it carries its **own** `Adw` header
  (an `Adw.ToolbarView` top bar showing the agent name), so the header lines up with
  the agent column for free — no width-sync against the window header (whose padding
  never aligned). It's **uncloseable**: it's a `Gtk.Stack` page, not a tab. Every open
  agent's widget is a stack page kept alive across switches; `activateWorkbench` flips
  the visible one (`AgentSidebar.show`) and attaches the column to its split
  (`agentPaned`, at `AGENT_SIDEBAR_WIDTH`, resizable) — or detaches it for the user
  workbench, which has no agent. The workbench center stays free as the work/review
  area. `showSideDock` is still false for agents, so Files/Source-Control isn't docked
  on open but the panel is built (so `this.workbench.fileTree`/`gitPanel` stay valid and
  `file-tree:focus`/git commands can reveal it in the **right** slot). `openAgent` adds
  the widget to the sidebar stack; `closeAgent` removes it (`AgentSidebar.removeAgent`)
  and disposes it + the workbench's editors / file tree / git panel / bottom-dock panels
  (no leak). The agent column is a top-level **focus zone** (`focusZones`), so geometry-
  based `ctrl-w h/l` reaches it, and `agent-sidebar:toggle` (`ctrl-w g a`) hides/shows it
  (`agentSidebarHidden` — a no-op + toast on the user workbench). Each agent workbench is
  serialized as a `WorkspaceState` and relaunched resumed on session restore (work-area
  file-tab layout still deferred).
- **`src/ui/AgentTerminal.ts`** *(the `claude-tui` kind)* — a `Terminal`
  subclass that spawns the agent CLI (`agent.command` config, default
  `['claude']`); the Claude integration lives in
  `src/agents/claude-tui/session.ts` (`ClaudeSession`, arg/`--settings`
  injection + the status/edited-files/rename watchers). Notable behaviour:
  - initial title = the agent's program basename until the CLI reports its own
    (OSC) title; `prompt` option appends a launch prompt to argv;
  - on process exit the widget is **not** torn down and the agent/workbench is
    **not** closed — it prints a "process exited" notice, flips to `exited`,
    and stays listed; the user restarts (`agent:restart`/`r`) or stops
    (`agent:stop`/`x`) it from the workbench list. Closing its tab
    (`tab:close`) never retires it — it just backgrounds it (a running agent
    keeps working); `agent:close`/`d d` retires it;
  - **live status** (`idle | working | waiting | exited`, via `status` /
    `onDidChangeStatus`): for a `claude` agent it injects a per-session
    `--settings` block whose **hooks** write a status word to a file the
    terminal watches with a `Gio.FileMonitor`. Reporter:
    `assets/hooks/agent-status.sh`. `UserPromptSubmit`/`PreToolUse`→working,
    `Notification`→waiting/idle, `Stop`/`SessionStart`→idle.
- **`src/agents/claude-sdk/` + `src/ui/AgentConversation.ts`** *(the
  `claude-sdk` kind)* — drives a persistent `claude -p` stream-json process and
  renders the turn natively. Full doc:
  **[agents/claude-sdk.md](agents/claude-sdk.md)**. Shape:
  - `transport.ts` (spawn + NDJSON line framing) → `SdkSession.ts` (turn queue,
    event→domain mapping, status/changedFiles/sessionId/cost, control protocol)
    → `AgentConversation.ts` (the native transcript host). `SdkSession` exposes
    the **same observable surface** `AgentTerminal` does, so the
    manager/sidebar/picker stay tool-agnostic.
  - Features: turn loop; thinking + token meter; tool rows with nerdfont icons
    (Bash plain monospace + one-line crop); permission gating via the bundled stdio
    MCP `assets/mcp/zymPermission.mjs` (`--permission-prompt-tool`, atomic
    file IPC) → native allow/deny card; **interrupt** (control_request, on
    `ctrl-c`); **subagents** (captured per-`Agent`-tool transcript, inline
    button + sticky panel + pushed `Adw.NavigationView` page, kept out of the
    main thread); **shell monitors** (sticky panel + inspect page + cancel via
    `stop_task`); **AskUserQuestion** as an `Adw.ViewSwitcher` card (j/k/h/l +
    notes; answered over the only working channel, the permission deny-message);
    **message queueing** while busy (right-aligned "Pending" bubble); unknown
    events surfaced as raw-JSON rows.
  - UI is split under `src/ui/conversation/`: `format.ts` (pure helpers,
    tested), `StickyListPanel.ts` (Tasks/Subagents/Monitors), `cards.ts`
    (permission), `QuestionCard.ts`, `SubagentView.ts`, `MonitorView.ts`.
  - **Deferred:** conversation resume + session serialize for sdk
    (`serialize()` returns null → not persisted across editor restart);
    token-level live streaming.
- **`src/AgentManager.ts` — `zym.agents`** — the registry: `add`/`remove`/
  `getAgents` (launch order) + `onDidAddAgent`/`onDidRemoveAgent`.
  The agent list / sidebar is `WorkbenchList` (not a separate `AgentList`).
- **`src/ui/Sidebar.ts`** — assembles the **WorkbenchSidebar** (the full-height
  column at the very left of the window, outside/left of the header bar). It owns
  the `WorkbenchList` (exposed as `sidebar.list`) and wraps it in the
  `#WorkbenchSidebar` column box, exposed as its `root`. AppWindow owns the
  top-level horizontal `Gtk.Paned` (`AppWindow.sidebarPaned`, class
  `AppWindow--paned`) whose start child is `sidebar.root` and whose end child is the
  content (header bar + workbench wrapped in the toast overlay). The collapse/expand
  width toggle is the list's robot button firing `onToggleCollapsed`, which AppWindow
  applies to the paned position (between `SIDEBAR_COLLAPSED_WIDTH` and
  `SIDEBAR_WIDTH`). AppWindow constructs one `Sidebar`, forwarding the agent
  callbacks, and never touches the list directly.
- **`src/ui/WorkbenchList.ts`** — the contents of the WorkbenchSidebar column.
  Each entry is associated with a particular **workbench**: the first ("default",
  selected-by-default) row is the **user** (person glyph + name, as a pseudo-agent
  — `onActivateUser`), the rest are the running agents (status indicator + title
  + changed-files badge). **Never empty** (the user row is always present → no
  empty state). The header bar + scrollable list are assembled in an
  `Adw.ToolbarView` (its `root`): the project-title `Adw.HeaderBar` (themed to
  match the window header bar) is a **top bar** over the list as **content**, so
  the bar matches the window header beside it and the view manages the seam
  between header and list. Collapsing the sidebar to icons-only / expanding to
  icons+text is requested via `onToggleCollapsed` (the `Sidebar` applies the
  width).
- **`src/ui/AgentPicker.ts`** — fuzzy quick-switcher over running agents, with
  a *Start agent: `<query>`* action that launches a new agent with the typed
  prompt.
- **`src/ui/AgentLauncher.ts`** — the compose overlay for starting an agent: an
  auto-growing multi-line prompt editor (vim editing, grows to 20 lines then
  scrolls) over a reflowing row of option dropdowns (`Combobox`es) — agent kind,
  model, permission mode, **effort** (`--effort`; the `default` choice omits the
  flag), and the worktree choice. Each kind's `AgentLaunchOptions`
  (`agents/configs.ts` + `claudeOptions.ts`) supplies the option lists and the
  `buildCommand` argv builder, so changing the kind re-populates them. `enter`
  launches; the last-used options + an unsent draft persist to the next open.
  `ctrl-tab` / `ctrl-shift-tab` cycle focus forward / backward through the card's
  controls in tab order (the `tab` the prompt editor swallows), driven by GTK's
  own `childFocus` traversal so it follows the layout; bound in the window's
  capture-phase keymap so they're swallowed before Adw.TabView's built-in
  ctrl-tab cycles a background panel group's tab.
  A `mode` selects one of four flows, differing only in how the worktree choice is
  surfaced/seeded and where focus starts (the worktree is always realized by the
  agent via `set_worktree` — see `launchPrompt`): `default` (`agent:new`) keeps the
  worktree dropdown in the options row; `existing-worktree` (`agent:new-in-worktree`)
  moves it into a "Launch agent in worktree [combobox]" title, focuses it first, and
  drops the "create" choice; `this-worktree` (`agent:new-this-worktree`) is the same
  titled combobox pre-selected to the current root with the prompt focused; and
  `new-worktree` (`agent:new-worktree`) drops the control entirely under a "Launch
  agent in new worktree:" title (pinned to a fresh worktree).
- **`AppWindow`** — `openAgent(prompt?)` (hosts the agent in the `AgentSidebar` stack)
  / `showAgent`, `agent:new` / `agent:picker` commands, focus→`selectAgent`. An agent is
  "viewed" (clears its attention blink) whenever its workbench is active — its widget is
  the shown one in the agent sidebar — rather than via a center tab.

## Feature: agent profiles & customization

Replace the single `agent.command` with **named profiles** (agent *types*), so
the user can keep several configured agents and pick one when starting.

### Config schema (`agent.*`)

```ts
interface AgentProfile {
  name: string;                 // display + list/picker label
  kind?: 'claude' | 'generic';  // drives status integration (default inferred from command[0])
  command: string[];            // argv; default ['claude']
  description?: string;
  cwd?: string;                 // default: session cwd (see worktrees)
  env?: Record<string, string>;
  // claude-kind extras, translated to flags / --settings:
  model?: string;               // --model
  allowedTools?: string[];      // --allowed-tools
  permissionMode?: string;      // --permission-mode
  appendSystemPrompt?: string;  // --append-system-prompt
  addDirs?: string[];           // --add-dir
}
agent.profiles: AgentProfile[]   // new
agent.default: string            // profile name to use when unspecified
agent.command: string[]          // kept as a back-compat shorthand → a synthetic default profile
```

`resolveAgentCommand()` grows into a profile resolver. `buildStatusIntegration`
stays, gated on `kind === 'claude'` (or `basename(command[0]) === 'claude'`).
A `buildClaudeArgs(profile)` turns the claude extras into flags, merged with
the status `--settings` (claude lets later `--settings`/flags compose).

### Other tools than claude

`AgentTerminal` already runs arbitrary argv. The only claude-specific piece is
the hook-based status. So:

- **Generic kind** → no status hooks; status is just `working` (alive) vs
  `exited` — or stays a single neutral state. (We *could* still infer "waiting
  for input" for some tools later via heuristics, but not in the MVP.)
- Keep status reporting behind an **adapter seam**: today one
  `ClaudeStatusAdapter` (hooks + file watch). A second adapter (e.g. a tool
  that emits OSC/title states, or writes its own status file) can be slotted in
  by `kind` without touching the UI, which only sees `status` /
  `onDidChangeStatus`.

### UI

- The **picker/starter** gains a profile step: either a two-stage pick (choose
  profile → type prompt) or a prefix in the existing entry (`@review fix the
  bug`). Simplest first: a `agent:new` variant per profile, plus the default on
  `space a`.
- Optionally a small **config editor** entry (there is already `ConfigEditor`)
  — profiles are just `config.json`, so this is free to start.

## Feature: management UX

Lifecycle commands are registered on `AppWindow`, bound centrally in
`src/keymaps/default.ts`; the list dispatches the selected row's command:

- `agent:stop` — terminate the process (SIGTERM the VTE child) but keep the
  widget listed (it flips to `exited`, restartable). The list's `x` key / row
  action.
- Closing the agent's tab (`tab:close`) never retires the agent, whatever its
  state: the terminal-tab close is vetoed (the terminal stays in its workbench
  — a running agent keeps working in the background, a stopped one stays
  listed) and the view falls back to the user's workbench; re-select the agent
  to bring it back.
- `agent:close` — close for good: terminate the child if it's still running,
  remove its workbench, and retire it from the list (`closeAgent`). The list's
  `d d` key; acts on the selected row, or the active/last-focused agent from
  the command palette.
- `agent:restart` (list `r`) / `agent:resume` (`space a r`) — respawn an exited
  agent in place, resuming its conversation; reuse the row.
- `agent:focus-next` / `agent:focus-prev` — navigation (`focusAdjacentAgent`).

**List ergonomics** — vim bare-key bindings while the WorkbenchList is focused
(`j`/`k` move, `x` stop, `r` restart, `R` rename, `b` branch, `d d` close, `o`
open-changes), mirroring FileTree; hover action buttons on rows.

**Rename** — `AgentTerminal.rename()` pins a display name over the CLI's
reported title (`renamed` reports whether pinned); `agent:rename` prompts via
the picker (the `R` key in the list). The `claude-sdk` kind also handles a
typed **`/rename`** client-side (headless claude lacks it) — see
[agents/claude-sdk.md](agents/claude-sdk.md).

**Auto-name** — an optional one-shot LLM names a session from its task. A
**one-shot agent** (`src/agents/oneshot.ts`: `OneShotAgent` interface +
`createOneShotAgent()`, hardcoded to `claude -p --model sonnet` but behind a
config-shaped seam) runs a prompt to completion via the process runner and
returns text; `src/agents/autoName.ts` wraps it to turn a task prompt into
`{ name, description }` (pure, lenient `buildNamePrompt`/`parseAgentName`).
Triggers (`claude-sdk`): on launch when `agent.autoName` is set, and on an empty
`/rename` on demand. Both name from the **user's own prompt**, never zym's
scaffolding: `launchPrompt` returns `{ agentPrompt, userPrompt }` — `agentPrompt`
(editor instructions + user prompt) is the first turn, `userPrompt` is what the
namer sees — threaded through `openAgent` → `AgentLaunch.userPrompt` →
`AgentConversation`. The naming context prefers `userPrompt`, falling back to the
first genuine user turn (the launch echo is skipped). While the one-shot runs the
title shows a transient `…` placeholder (in-app only, never persisted); on
success it's replaced by the `name` (persisted like `/rename`) **silently** — the
title change in the sidebar/tab is the confirmation; on failure it's dropped,
reverting to the previous name (the kind default if it had none) plus a warning
toast. The `description` is captured but not yet surfaced. The one-shot is
injectable (`AgentConversationOptions.oneShot`) for tests.

**Tab affordance** — the agent's tab title is prefixed with a status glyph
(`agentTabTitle` in AppWindow), refreshed on status change; mirrors the sidebar
indicator, sans colour.

**Attention notifications** — `AppWindow.notifyAgentAttention` posts an in-app
`zym.notifications` toast (click → reveal) when an agent goes **waiting**
(needs input) or **working→idle** (finished) while its tab isn't the active
panel child. Still todo: an **attention badge/count** on the sidebar header
(number of `waiting` agents) and desktop notifications when the window is
unfocused (see *More ideas → OS notifications*).

## Feature: resume / persist conversations

Claude Code stores every session as a JSONL transcript at
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (the dir name is the cwd
with *every non-alphanumeric char* → `-`; see
`agentSessions.ts:transcriptDir`). A session is resumed with
`claude --resume <id>` (or `--continue` for the latest); `--fork-session`
branches a copy instead of appending. These compose with our `--settings`
block, so status hooks keep working.

Built in `src/agentSessions.ts`, `AgentTerminal`, `AppWindow`:

- **Capture** — the hook reporter writes the live `session_id` (present in
  every hook payload) to `<statusFile>.session`; `AgentTerminal.sessionId`
  reads it.
- **Enumerate** — `listAgentSessions(cwd)` reads the transcript dir: filename →
  id, mtime → last activity, first `type:"user"` line → label. Newest first.
  Only the head of each transcript is read (cheap). All format-parsing is
  isolated here, as the JSONL format is Claude Code's internal one (subject to
  change). Across a repo, `listResumableSessions(roots)` (the picker passes
  `AppWindow.agentSessionRoots()`, **main worktree first**) unions every root's
  dir **plus** every `~/.claude/projects/*` dir whose encoded name is that main
  root or a `<encodedMain>-…` child/sibling. That recovers conversations whose
  worktree has since been **removed**: the transcript outlives the worktree, but
  the path is no longer a live root to pass. The `-`-separator guard stops
  `…/zym` from also matching `…/zymfoo`.
- **Resume into a vanished cwd** — `resolveResumeCwd(session, mainRoot)` decides
  where to spawn `--resume`: the cwd Claude recorded if it still exists, else it
  **relocates** the transcript under `mainRoot`'s project dir and resumes there
  (claude resolves `--resume <id>` relative to cwd, so the file must sit under the
  spawn dir). So a removed-worktree conversation resumes in the main repo. The
  dynamic-worktree re-announce is skipped on a relocated resume (that worktree is
  gone too).
- **Resume** — `AgentTerminal` takes a `resume: { sessionId? | continue?; fork?
  }` option → prepends `--resume <id>` / `--continue` (+ `--fork-session`) to
  the claude argv. Commands: `agent:resume` (`space a r`, resume the current
  *exited* agent in place), `agent:resume-conversation` (`space a R`, a picker
  of past sessions excluding any currently live — label + relative time),
  `agent:continue` (`space a c`, latest conversation in this folder), and
  `agent:branch` (`space a b` / list `b`, fork the current agent via
  `--fork-session`).
- **Persist across editor restarts** — `AgentTerminal.serialize()` records
  `sessionId`; the (Session-management-owned) restore can relaunch a saved
  agent as `--resume <id>` to continue the conversation rather than start
  fresh. The `TabState` agent variant has an optional `sessionId`.

**Open**: surface session branch/cost in the resume list; resume-with-prompt;
offer fork on resuming a *live* session; honor `cleanupPeriodDays` (transcripts
are pruned after ~30 days).

## Feature: reviewing an agent's work

Goal: let the user review **what one agent changed** — while it works (ongoing)
or after (past). The obstacle: a working tree shared by several agents (the
main folder, *or a worktree that hosts more than one agent* — see below) mixes
everyone's edits, so a plain `git diff` can't attribute a change to one agent.
Per-agent attribution is therefore the **primary** mechanism, needed even when
worktrees are in play. (Observed usage: parallel agents mostly edit
**disjoint** areas, so attribution-without-full-isolation is good enough for
the common case.)

### Per-agent baselines (the attribution mechanism)

Capture each agent's "before" so its diff is well-defined:

- A `PreToolUse` hook on `Edit/Write/MultiEdit/NotebookEdit` copies the target
  file's *current* content into `<statusFile>.baseline/<encoded-path>` the
  **first** time this agent touches it — "the file as it was right before agent
  A started." Pairs with the existing `PostToolUse` → `.files` log (the touched
  set / "after").
- Agent A's change to a file = `diff(baseline, current)`. Tool-agnostic and
  under our control. (Claude keeps its own snapshots under
  `~/.claude/file-history/`, but it's internal/undocumented — at most a fallback
  for resumed sessions with no baseline.)
- Works in **any** tree, which is why it's primary: a worktree can hold several
  agents, so the worktree's own `git diff` ≠ a single agent's work.

### Review UI

- An **"Agent Changes" panel** — a `LocationList`-style list (like Diagnostics)
  of the agent's changed files with ± counts; selecting one opens its diff. The
  "✎ N" badge / `o` key graduates from "open the files" to "review the
  changes."
- A **diff view** per file (`baseline → current`): next/prev change, optionally
  per-hunk accept / revert.
- **Built on the editor Diff renderer** (`text-editor/diff.md`) — the
  multibuffer `DiffView` is the rendering substrate (with comment-to-agent /
  review mode). Sequence: diff display → agent review.
- TODO: expand the diff comment-to-agent action into threaded comments the agent can reply to inline.

### Ongoing vs past

- **Ongoing**: a `Gio.FileMonitor` (reuse the `.files` watch) keeps the diff
  live as the agent edits.
- **Past**: baselines persist after the process exits (cleaned with `.files` /
  `.session` when the agent is retired), so a finished agent stays reviewable.
  Resumed sessions with no baseline fall back to claude's file-history or `git
  diff`.

### Parallel agents in one tree

- **Disjoint files** (the common case) → clean per-agent diffs, nothing more
  needed.
- **Overlap** (two live agents edit the same file): compare agents'
  `changedFiles` sets and **flag the overlap** in the agent list — attribution
  muddies and the agents can stomp each other. True isolation for that case =
  worktrees (below).

## Feature: git worktree integration

Goal: let agents run in **worktrees** (not only the main folder) so a group of
related agents shares an isolated branch, and "viewing an agent" re-roots the
editor to its worktree. **A worktree is its own axis, N:1 with agents — more
than one agent can run in the same worktree.** So a worktree gives *isolation
between worktrees*, while telling agents apart *within* a worktree still relies
on the per-agent baselines above.

Design decisions that govern this: full per-workbench root (not a scoped MVP
view); the **agent** creates worktrees (`git worktree add`), zym only detects
+ re-roots — no zym-side `worktree add/remove`; association is **both**
launch-time (pick an existing worktree) and dynamic (the agent moves into one
mid-session); dynamic detection is **cooperative** (the agent announces via an
MCP tool) with a hook **validator** that warns if it changes worktree without
announcing.

### Architecture

Root ownership lives on the **`Workbench`** (`cwd` + `git`), not the window.
The window chrome and pickers read the *active* workbench; an agent's workbench
can re-root independently. Pieces and how they connect:

- **Per-workbench root** — `Workbench.{cwd, git}`.
  `AppWindow.buildWorkbench(owner, cwd)` acquires a pooled `GitRepo` and roots
  `FileTree`/`GitPanel` at `cwd`. There is no `AppWindow.git`; every git/cwd
  call site reads `this.workbench.*`.
- **GitRepo pool** (`git.ts`) — `acquireGitRepo(cwd)` / `releaseGitRepo(repo)`,
  ref-counted and keyed by repo top-level. Several workbenches in one root (N
  agents : 1 worktree) share one polling `CliGitRepo`; a linked worktree keys
  separately, so it gets its own branch/status. The repo is disposed when the
  last holder releases.
- **Chrome follows the active workbench** — `activateWorkbench` →
  `HeaderBar.rebind()` re-points `GitBranchButton.setRepo`,
  `GithubService.rebind`, `GithubButtons.setRepo` and the upstream-behind watch
  at the active `workbench.{git, cwd}`. The header bar (`src/ui/HeaderBar.ts`)
  owns this git-chrome lifecycle — the branch button + GitHub pill, the
  per-workbench health cluster, the upstream-behind "pull" prompt, and the
  background auto-fetch — read off a `getWorkbench` accessor supplied by AppWindow.
- **Agent → editor bridge** (cooperative dynamic detection). Data flow for a
  worktree the agent creates mid-session:
  1. agent runs `git worktree add … && cd …`, then calls the **`set_worktree`**
     MCP tool (bundled stdio server `assets/mcp/zymBridge.mjs`, wired via
     `--mcp-config` + pre-allowed in `--settings`, instructed by
     `--append-system-prompt`).
  2. the bridge writes the path to `$ZYM_STATUS_FILE.cwd` (atomic) — the same
     IPC channel as the status hooks.
  3. `ClaudeSession` watches `.cwd` → `host.onCwd` →
     `AgentTerminal.setEffectiveCwd` (recomputes `worktree`, fires
     `onDidChangeWorktree`).
  4. `AppWindow.reRootWorkbench` swaps the workbench's pooled git, re-roots
     `FileTree`/`GitPanel` in place (`setRoot`), re-points the gutters of
     editors owned by that workbench (`TextEditor.setGitRepo` →
     `GitGutter.setGit`, tracked via `editorOwners`), and rebinds chrome if
     active.
- **Validator** (safety net) — a `PostToolUse(Bash)` hook greps for `git
  worktree add <path>` and writes it to `$ZYM_STATUS_FILE.wtcreate`; if the
  agent settles to idle without a matching `set_worktree`, `AppWindow` warns
  once.
- **Launch-time** — the launcher's worktree-scoped flows
  (`agent:new-in-worktree` / `-this-worktree` / `-worktree`) seed the worktree
  choice up front; the agent then realizes it via `set_worktree`, which re-roots
  the workbench (see `launchPrompt`). (`cli.listWorktrees()` + the standalone
  `WorktreePicker` — rooting directly via `openAgent({cwd})` — is no longer wired
  to a command.)
- **Resume** — restores a conversation's branch/worktree/cwd (`resumeOptions`).
  `AgentSession.cwd` is read from the transcript (Claude records its cwd per
  entry); `agent:picker` / `agent:resume-conversation` list sessions across
  every worktree (`agentSessionRoots()` → `listResumableSessions`) and resume
  in that cwd (`openAgent({cwd, resume})`) — both where `claude --resume`
  resolves the session *and* where the workbench roots. **Launch-time**
  worktrees restore directly (the transcript cwd *is* the worktree).
  **Dynamic** moves (the agent `cd`'d into a worktree mid-session via
  set_worktree; Claude's own cwd never changed, so the transcript still says
  the launch dir) are handled by a sidecar: on each announce
  `recordSessionWorktree` writes `effectiveCwd` next to the transcript
  (`<id>.zym-worktree`); on resume we still spawn in the launch cwd (so
  `--resume` resolves) but inject a terse prompt telling the agent to **only**
  call `set_worktree(<W>)` and then stop — re-rooting the editor without
  kicking off work (Tier 1: cooperative, via the announce loop; no touching
  Claude's transcript storage).

Key files: `git.ts` (pool), `git/cli.ts` (`listWorktrees`), `Workbench.ts`,
`AppWindow.ts` (build/activate/re-root), `claudeAgent.ts` +
`assets/mcp/zymBridge.mjs` + `assets/hooks/agent-status.sh`
(bridge/validator), `AgentTerminal.ts`, `FileTree.ts`/`GitPanel.ts`/
`GitGutter.ts` (`setRoot`/`setGit`), `WorkbenchList.ts`.

### Lifecycle (deferred)

Lifecycle is **per worktree, not per agent**: only when the **last** agent
leaves a worktree do we offer **keep / merge / discard** the branch — a
worktree with uncommitted/unmerged work is never removed implicitly. Deferred
until after the re-root foundation lands; co-design with per-agent review
baselines (above) and Session management (agent-workbench serialization already
stores `cwd`).

## Editor integration (MCP tools)

An agent running inside zym can call back into the editor through bundled MCP
tools (`assets/mcp/zymBridge.mjs`; both kinds get every tool):

- **`set_worktree(path)`**: update the workbench's cwd to this worktree.
- **`set_actions([{ label, command, terminal? }])`**: register runnable actions 
   (buttons and commands available in IDE).

## More ideas

Backlog beyond the features above, roughly in priority order. The first group
builds directly on the change-tracking / transcript plumbing that already
exists, so it's cheap and high-value; the rest are bigger or more speculative.

### Builds on what exists

- **Review an agent's diff** *(recommended next)* — promoted to its own design:
  see **Feature: reviewing an agent's work** above (per-agent baselines + an
  "Agent Changes" diff panel; the attribution mechanism that also works inside
  a shared worktree).
- **Live activity timeline** — a panel that tails the agent's transcript JSONL
  (already parsed by `agentSessions.ts` for resume) into a structured feed:
  tools used, files touched, assistant messages. A readable "what is it doing"
  view without watching the terminal scroll. Live via a `Gio.FileMonitor` on
  the transcript, isolated behind the same format-parsing seam as
  `agentSessions`.
- **OS notifications** — when an agent goes `waiting` / `working→idle` while the
  **window is unfocused**, fire a desktop `Gio.Notification` (today we only post
  in-app toasts via `notifyAgentAttention`). Gate on window focus; clicking the
  notification reveals the agent (same `reveal` callback).
- **Agent interrupt** — `agent:interrupt`: send ESC / `ctrl-c` to the child to
  stop the current action, a softer alternative to `agent:stop`. Trivial now
  that the modal terminal already sends ESC (`feedChild('\x1b')`); ctrl-c is
  `feedChild('\x03')`.
- **Jump to an agent's latest edit** — open the file the agent last touched
  **at the exact line** (not just the file). Needs the hook to record a
  position alongside the path in `<statusFile>.files` (e.g. the edit's first
  changed line), surfaced via the `o` action / a dedicated command.

### Bigger / speculative

- **Cost / context meter** — the claude `statusLine` JSON exposes `cost` and
  `context_window.used_percentage`; a second `--settings` `statusLine` hook
  could surface a per-agent cost/▮ context gauge in the row. (Small and
  self-contained when picked up.)
- **Orchestration** — multiple agents on one task, or a "lead"/"review" agent
  watching another's diff. Speculative; out of scope until the basics are deep.

## Shared concerns

- **Status is the spine.** Everything (dot, tab, notifications, badge) reads
  `AgentTerminal.status` / `onDidChangeStatus`; no parallel state.
- **Refresh** via the manager's events (`onDidAddAgent`/`onDidRemoveAgent`) +
  each agent's `onDidChangeStatus`; no manual cross-component pokes.
- **Feedback** through `zym.notifications`, consistent with git ops.
- **Commands first, bindings central** (`src/keymaps/default.ts`), vim bare
  keys while the panel is focused — like FileTree.
- **Destructive ops** (kill, worktree discard) confirm first, never implicit.
- **Claude specifics stay isolated** behind the status adapter / arg builder,
  so the manager, list, and picker remain tool-agnostic.

## Remaining / planned

- [ ] Profiles: `AgentProfile` config schema + resolver; back-compat with
      `agent.command`; `kind`-gated status integration
- [ ] Claude arg builder (model / tools / permission-mode / system-prompt)
      merged with the status `--settings`
- [ ] Picker/starter: choose a profile when launching
- [~] Attention notifications: in-app toasts on waiting / working→idle while
      the tab is inactive are done (`notifyAgentAttention`); header `waiting`
      badge and OS notifications while the window is unfocused are still todo
- [x] Editor Diff renderer (`text-editor/diff.md`) — substrate for review
      (the multibuffer `DiffView`)
- [ ] Review work: per-agent baselines (PreToolUse snapshot → `.baseline/`);
      "Agent Changes" diff panel (baseline → current); live (FileMonitor) +
      post-exit
- [ ] Overlap warning when two live agents edit the same file (compare
      `changedFiles`)
- [ ] Worktree lifecycle (deferred) — keep/merge/discard when last agent
      leaves; per-worktree vs per-agent (baseline) review granularity
- [x] Resume/serialize for the `claude-sdk` kind — done (see *agents/claude-sdk.md*)
- [ ] Monitor inner-state restore (`claude-sdk`) — a resumed `Monitor` tool renders as a static row; its live panel/output isn't rebuilt
- [ ] **Retire the file-based IPC.** Every agent→editor channel today round-trips
      through atomic-rename files watched by `Gio.FileMonitor` — status hooks
      (`$ZYM_STATUS_FILE.*`), the permission server
      (`permission.{req,res}`), and the bridge tools (`set_worktree` →
      `.cwd`, `set_actions` → `actions.json`). It's used because the bridge/perm
      MCP servers are *grandchild* processes (zym → claude → server) with no
      direct pipe back, but it spreads watchers + temp files across the tree and
      can't carry rich/bidirectional data cleanly. Replace with one channel: have
      zym host an in-process MCP server over a local socket the spawned servers
      (and hooks) connect to — the WebSocket/JSON-RPC transport the
      `feat/ide-integration` branch already builds for `claude --ide` is the
      natural carrier. Collapses the bridge, permission prompt, and status
      reporting onto a single typed connection.

## Open questions

- **Profile selection UX**: two-stage picker (profile → prompt) vs an
  `@profile` prefix in the prompt entry vs per-profile `agent:new:<name>`
  commands?
- **Generic-tool status**: leave non-claude agents at alive/exited, or attempt
  a generic "waiting for input" heuristic (PTY idle / prompt detection)?
- **Review granularity inside a shared worktree**: N agents per worktree means
  the worktree's `git diff` mixes them — is the default review view the
  *worktree* diff, the *per-agent* (baseline) diff, or both side by side?
  Baselines are the precise per-agent answer; the worktree diff is the "what's
  the net state" answer.
- **Baseline cost**: snapshot-on-first-edit (`PreToolUse` copy) is cheap per
  file but unbounded across a long session — cap by count/size, or rely on git
  for large files? And dedupe baselines when several agents share a worktree +
  file.
- **Kill semantics**: `agent:stop` SIGTERMs the VTE child directly — could add
  a `claude`-aware graceful shutdown. (Closing a *running* agent's tab does
  **not** kill it — it backgrounds the agent.)
