# Agents

Architecture plan for the Agents section. The basics (run an agent CLI in a tab,
list/switch them, live status) are done; the open work is depth:

1. **Agent profiles & customization** — named, configurable agent types (command,
   model, tools, prompt…), and first-class support for tools other than `claude`.
2. **Management UX** — close/kill/restart, attention notifications, richer list
   and picker, keybindings.
3. **Git worktree integration** — run an agent in its own worktree, and re-root
   the editor to that worktree when viewing it.

This page covers the architecture; per-feature pages can split out later
(`agents/profiles.md`, `agents/worktrees.md`) if they grow.

## Current state

What already exists and is reused, not rebuilt:

- **`src/ui/AgentTerminal.ts`** — a `Terminal` subclass that spawns the agent CLI
  (`agent.command` config, default `['claude']`). Notable behaviour:
  - initial title = the agent's program basename until the CLI reports its own
    (OSC) title; `prompt` option appends a launch prompt to argv;
  - on process exit the widget is **not** torn down — it prints a "process
    exited" notice, flips to `exited`, and stays listed; `onCloseRequest` (Enter)
    closes the dead tab;
  - **live status** (`idle | working | waiting | exited`, via `status` /
    `onDidChangeStatus`): for a `claude` agent it injects a per-session
    `--settings` block whose **hooks** write a status word to a file the terminal
    watches with a `Gio.FileMonitor`. Reporter: `assets/hooks/agent-status.sh`.
    `UserPromptSubmit`/`PreToolUse`→working, `Notification`→waiting/idle,
    `Stop`/`SessionStart`→idle.
- **`src/AgentManager.ts` — `quilx.agents`** — the registry: `add`/`remove`/
  `getAgents` (launch order) + `onDidAddAgent`/`onDidRemoveAgent`.
- **`src/ui/AgentList.ts`** — left-dock sidebar under an "Agents" header (robot
  glyph). Rows = status indicator (grey cog while working, colored dot otherwise)
  + title; empty-state filler; `onActivate` / `selectAgent`.
- **`src/ui/AgentPicker.ts`** — fuzzy quick-switcher over running agents, with a
  *Start agent: `<query>`* action that launches a new agent with the typed prompt.
- **`AppWindow`** — `openAgent(prompt?)` / `showAgent` (reattaches a persisted
  widget, gated on `getRoot()` so a desynced tab map can't strand or rip it),
  `agentChildren` (agent → center tab), `agent:new` / `agent:switch` commands,
  focus→`selectAgent`, and retiring an agent from the registry when its **exited**
  tab is closed.

## Constraints carried from the codebase

- **No node I/O on the main path.** Node's `child_process`/promises are starved by
  the GLib main loop; agent processes run in VTE, and any out-of-band git/tooling
  goes through `GitRepo.run`/`runOutput` (`Gio.Subprocess`) or `Gio.FileMonitor`.
- **Strip-only TS** (project memory): no enums, no parameter properties, no
  namespaces.
- **One main component per file** under `src/ui`, camel-cased after the component.
- **Config** via `quilx.config` (scoped, typed, observable, backed by
  `config.json`) — e.g. FileTree's `scope('FileTree').register({...})`.
- **Status is best-effort & claude-specific.** Hooks give working/waiting/idle/
  exited; there is *no* true "thinking" introspection. Non-claude tools get only
  alive/exited unless an adapter is written.

## Feature: agent profiles & customization

Replace the single `agent.command` with **named profiles** (agent *types*), so the
user can keep several configured agents and pick one when starting.

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
A `buildClaudeArgs(profile)` turns the claude extras into flags, merged with the
status `--settings` (claude lets later `--settings`/flags compose).

### Other tools than claude

`AgentTerminal` already runs arbitrary argv. The only claude-specific piece is the
hook-based status. So:

- **Generic kind** → no status hooks; status is just `working` (alive) vs `exited`
  — or stays a single neutral state. (We *could* still infer "waiting for input"
  for some tools later via heuristics, but not in the MVP.)
- Keep status reporting behind an **adapter seam**: today one `ClaudeStatusAdapter`
  (hooks + file watch). A second adapter (e.g. a tool that emits OSC/title states,
  or writes its own status file) can be slotted in by `kind` without touching the
  UI, which only sees `status` / `onDidChangeStatus`.

### UI

- The **picker/starter** gains a profile step: either a two-stage pick (choose
  profile → type prompt) or a prefix in the existing entry (`@review fix the bug`).
  Simplest first: a `agent:new` variant per profile, plus the default on `space a`.
- Optionally a small **config editor** entry (there is already `ConfigEditor`) —
  profiles are just `config.json`, so this is free to start.

## Feature: management UX

Concrete, mostly small additions on top of what exists:

- **Lifecycle commands** (registered on `AgentList` / `AppWindow`, bound centrally):
  - `agent:kill` — terminate the process (SIGTERM the VTE child) but keep the
    widget (it flips to `exited`).
  - `agent:close` — close the tab; if exited, retire from the registry (today's
    behaviour) — also expose it as an explicit command/row action.
  - `agent:restart` — respawn an exited (or running, after confirm) agent with the
    same profile/cwd; reuse the row.
  - `agent:reveal` / `agent:focus-next` / `agent:focus-prev` — navigation.
- **Attention notifications** — the high-value win now that status exists: when an
  agent transitions to **waiting** (needs permission) or **working→idle**
  (finished) while its tab is **not focused**, post a `quilx.notifications` event
  ("Agent *name* needs permission" / "…finished"). Add an **attention badge/count**
  on the AgentList header (number of `waiting` agents).
- **List ergonomics** — vim bare-key bindings while `#AgentList` is focused
  (`j`/`k` move, Enter reveal, `x` close, `r` restart), mirroring FileTree; hover
  action buttons on rows.
- **Rename** — *done*: `AgentTerminal.rename()` pins a display name over the CLI's
  reported title (`renamed` reports whether pinned); `agent:rename` prompts via the
  picker (the `R` key in the list).
- **Tab affordance** — *done*: the agent's tab title is prefixed with a status glyph
  (`agentTabTitle` in AppWindow), refreshed on status change; mirrors the sidebar
  indicator, sans colour.

## Feature: resume / persist conversations

Claude Code stores every session as a JSONL transcript at
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (the dir name is the cwd with
`/` and `_` → `-`). A session is resumed with `claude --resume <id>` (or
`--continue` for the latest); `--fork-session` branches a copy instead of
appending. These compose with our `--settings` block, so status hooks keep working.

**Built (`src/agentSessions.ts`, `AgentTerminal`, `AppWindow`):**

- **Capture** — the hook reporter writes the live `session_id` (present in every
  hook payload) to `<statusFile>.session`; `AgentTerminal.sessionId` reads it.
- **Enumerate** — `listAgentSessions(cwd)` reads the transcript dir: filename → id,
  mtime → last activity, first `type:"user"` line → label. Newest first. Only the
  head of each transcript is read (cheap). All format-parsing is isolated here, as
  the JSONL format is Claude Code's internal one (subject to change).
- **Resume** — `AgentTerminal` takes a `resume: { sessionId? | continue?; fork? }`
  option → prepends `--resume <id>` / `--continue` (+ `--fork-session`) to the
  claude argv. Commands: `agent:resume` (a picker of past sessions, excluding any
  currently live, label + relative time → `space a r`) and `agent:continue`
  (`space a c`).
- **Persist across editor restarts** — `AgentTerminal.serialize()` now records
  `sessionId`; the (Session-management-owned) restore can relaunch a saved agent as
  `--resume <id>` to continue the conversation rather than start fresh. The
  `TabState` agent variant gained an optional `sessionId`.

**Open**: surface session branch/cost in the resume list; resume-with-prompt;
offer fork on resuming a *live* session; honor `cleanupPeriodDays` (transcripts are
pruned after ~30 days).

## Feature: git worktree integration

Goal: run agents in **isolated worktrees** so parallel agents don't fight over one
working tree, and make "viewing an agent" re-root the editor to its worktree.

### Backend (`GitRepo`)

Add worktree ops (subprocess, like the rest of mutating git):

```ts
listWorktrees(): { path: string; branch: string; head: string }[]; // `git worktree list --porcelain`
addWorktree(path: string, branch: string, onDone): void;           // run(['worktree','add', ...])
removeWorktree(path: string, onDone): void;                        // run(['worktree','remove', ...])
```

### Association & lifecycle

- An agent profile / launch can request a worktree: create
  `<repo>/.quilx/worktrees/<agent>` on a new branch (e.g. `agent/<name>`), set the
  agent's `cwd` to it.
- The agent carries its `cwd` (already passed to VTE). Track `agent.cwd` so the UI
  can show the branch/worktree and so reveal can re-root.
- On agent close/exit: offer to **keep / merge / discard** the worktree (it may
  hold uncommitted work) — destructive, never implicit.

### Re-rooting the editor (the hard part)

Today the editor is single-rooted (`process.cwd()` feeds `FileTree`, `GitRepo`,
`PROJECT_NAME`). Two options:

- **MVP — open the worktree path in the file tree / git** scoped to that agent's
  view, without a full app re-root (e.g. a secondary FileTree root, or a
  "workspace folder" switch). Lowest blast radius.
- **Full — a Workspace/Session concept**: the window holds the active root; viewing
  an agent in another worktree switches the active root (FileTree, GitRepo,
  BranchButton, title) to it. This is really **Session management** (see that task)
  and should be designed with it, not bolted on. Flag the dependency rather than
  duplicating.

This item is the largest and most cross-cutting; recommend it **after** profiles +
UX, and co-designed with Session management.

## More ideas

Backlog beyond the three big features above, roughly in priority order. The first
group builds directly on the change-tracking / transcript plumbing that already
exists, so it's cheap and high-value; the rest are bigger or more speculative.

### Builds on what exists

- **Review an agent's diff** *(recommended next)* — the natural step past
  "open changed files": snapshot the working tree (or just the edited files'
  contents) when an agent starts, then show **what that agent changed** as a diff
  against its own baseline. Turns the "✎ N" badge into a "review this agent's work"
  loop — the daily pain point in agent-driven dev. Reuses `AgentTerminal.changedFiles`
  for the file set and the (planned) editor Diff display for rendering; the baseline
  is a per-agent snapshot taken on launch. Per-agent, so two agents' edits don't mix.
- **Live activity timeline** — a panel that tails the agent's transcript JSONL
  (already parsed by `agentSessions.ts` for resume) into a structured feed: tools
  used, files touched, assistant messages. A readable "what is it doing" view
  without watching the terminal scroll. Live via a `Gio.FileMonitor` on the
  transcript, isolated behind the same format-parsing seam as `agentSessions`.
- **OS notifications** — when an agent goes `waiting` / `working→idle` while the
  **window is unfocused**, fire a desktop `Gio.Notification` (today we only post
  in-app toasts via `notifyAgentAttention`). Gate on window focus; clicking the
  notification reveals the agent (same `reveal` callback).
- **Agent interrupt** — `agent:interrupt`: send ESC / `ctrl-c` to the child to stop
  the current action, a softer alternative to `agent:kill`. Trivial now that the
  modal terminal already sends ESC (`feedChild('\x1b')`); ctrl-c is `feedChild('\x03')`.
- **Jump to an agent's latest edit** — open the file the agent last touched **at the
  exact line** (not just the file). Needs the hook to record a position alongside the
  path in `<statusFile>.files` (e.g. the edit's first changed line), surfaced via the
  `o` action / a dedicated command.

### Bigger / speculative

- **Cost / context meter** — the claude `statusLine` JSON exposes `cost` and
  `context_window.used_percentage`; a second `--settings` `statusLine` hook could
  surface a per-agent cost/▮ context gauge in the row. (Deferred a couple of times;
  small and self-contained when picked up.)
- **Orchestration** — multiple agents on one task, or a "lead"/"review" agent
  watching another's diff. Speculative; out of scope until the basics are deep.

Done (moved out of ideas): **send-to-agent** (selection/file → current / picked /
new agent), **resume past conversations** (see the feature above), **file-change
awareness** (a `PostToolUse` Edit/Write/MultiEdit/NotebookEdit hook appends the
edited path to `<statusFile>.files`; `AgentTerminal.changedFiles` /
`onDidChangeFiles` watch it; the agent list shows a clickable "✎ N" badge whose
click — or the `o` key / `agent:open-changes` — opens the edited files, one
directly or several via a newest-first picker; each edit also triggers an immediate
`GitRepo.refresh()`), and **modal terminal input** (normal/insert via a focusable
container that steals focus from the Vte; see index.md).

## Shared concerns

- **Status is the spine.** Everything (dot, tab, notifications, badge) reads
  `AgentTerminal.status` / `onDidChangeStatus`; no parallel state.
- **Refresh** via the manager's events (`onDidAddAgent`/`onDidRemoveAgent`) + each
  agent's `onDidChangeStatus`; no manual cross-component pokes.
- **Feedback** through `quilx.notifications`, consistent with git ops.
- **Commands first, bindings central** (`src/keymaps/default.ts`), vim bare keys
  while the panel is focused — like FileTree.
- **Destructive ops** (kill, worktree discard) confirm first, never implicit.
- **Claude specifics stay isolated** behind the status adapter / arg builder, so
  the manager, list, and picker remain tool-agnostic.

## Phasing

- [ ] Profiles: `AgentProfile` config schema + resolver; back-compat with
      `agent.command`; `kind`-gated status integration
- [ ] Claude arg builder (model / tools / permission-mode / system-prompt) merged
      with the status `--settings`
- [ ] Picker/starter: choose a profile when launching
- [ ] Attention notifications (waiting / finished while unfocused) + header badge
- [x] Lifecycle commands: kill / close / restart / focus-next/prev (+ bindings,
      per-row hover actions)
- [x] Status in the tab title; rename
- [x] File-change awareness (PostToolUse hook → `.files`; agent-list badge)
- [ ] `GitRepo` worktree ops (list / add / remove)
- [ ] Run an agent in a per-agent worktree (cwd + branch + cleanup prompt)
- [ ] Re-root editor to an agent's worktree (MVP scoped view; full re-root with
      Session management)

## Open questions

- **Profile selection UX**: two-stage picker (profile → prompt) vs an `@profile`
  prefix in the prompt entry vs per-profile `agent:new:<name>` commands?
- **Generic-tool status**: leave non-claude agents at alive/exited, or attempt a
  generic "waiting for input" heuristic (PTY idle / prompt detection)?
- **Worktree re-rooting**: secondary scoped root (cheap) vs full window re-root
  (needs Session management) — how independent should an agent's view be?
- **Kill semantics**: SIGTERM the VTE child directly, or `claude`-aware graceful
  shutdown? And should closing a *running* agent's tab ever kill it, or always
  detach (today) and require explicit `agent:kill`?
- **Rename vs CLI title**: when the user renames, does the agent's reported (OSC)
  title still override, or is the manual name pinned?
