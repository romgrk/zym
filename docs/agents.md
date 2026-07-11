# Agents

Run coding agents inside zym. **Two kinds** share one workbench / list /
lifecycle / worktree spine — they differ only in how the agent is driven and
displayed:

- **`claude-tui`** *(shipped default)* — the agent's own terminal UI hosted
  in a `Vte.Terminal` tab. Mature; live status via Claude Code hooks.
  `src/ui/AgentTerminal.ts` + `src/agents/claude-tui/session.ts`.
- **`acp`** *(opt-in via `agent.implementation: "acp"`)* — any **Agent Client
  Protocol** agent (default profiles: **Codex** and **Claude Code** via their
  adapters; Google Antigravity via `antigravity-acp` still configurable but
  dropped from the defaults; argv from the `agent.profiles` picker) rendered in
  **native GTK widgets** (no terminal, no Ink/Vte repaint cost), over
  JSON-RPC/stdio. (The free-tier Gemini CLI it once used natively was retired by
  Google — see agents/acp.md.) Deep dive: **[agents/acp.md](agents/acp.md)**.

(The former `claude-sdk` kind — headless `claude -p` stream-json — was
replaced by `acp` + the official claude-agent-acp adapter, which covers the
same features over the open protocol; legacy configs/sessions map to
claude-tui, whose `--resume` still opens their claude session ids.)

The native view (`AgentConversation`) is typed against the tool-agnostic
`ConversationSession` seam (`src/agents/session.ts`); `AcpSession` implements
it.

UX rework backlog for the native conversation view (discoverability + in-the-
moment controls: send/stop, inline retry, copy, jump-to-latest, richer
permission prompt): **[agents/conversation-ux.md](agents/conversation-ux.md)**.

`src/agents/configs.ts` is the kind registry — `resolveAgentKind()` picks the
kind from the config flag (default `claude-tui`); a single
`AppWindow.openAgent()` launch path serves every kind, each agent getting its
own workbench.

The open work is **depth, cross-kind**: agent profiles/customization (incl.
tools other than claude), richer management UX, git-worktree integration, and
reviewing an agent's diff — detailed below. Per-feature pages split out as
they grow (`agents/acp.md` already has).

## Current state

What already exists and is reused, not rebuilt:

- **Per-person workbenches** — `src/ui/workbench/Workbench.ts` is a first-class object:
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
  (an `Adw.ToolbarView` top bar showing the agent name on the left and, at the trailing
  edge, the **active agent's edited-files button** (pencil + count, click →
  `openAgentChanges`; tracks `onDidChangeFiles`, hidden with no edits) plus any
  **per-agent `headerWidgets`** the active agent contributes — for `AgentConversation`
  these are the subagent (robot) and monitor (terminal) count buttons (each hidden until
  it has a running item; popover lists them). `setActiveAgent` swaps both the edited-files
  tracking and the packed `headerWidgets` on every switch. All three icon buttons
  (subagent, monitor, edited-files) share one look + `[icon][count]` content via
  `headerButton.ts` (`headerButtonContent` / the `agent-header-button` class). So the header lines up with the agent column for free — no width-sync
  against the window header (whose padding never aligned). It's **uncloseable**: it's a
  `Gtk.Stack` page, not a tab. Every open agent's widget is a stack page kept alive
  across switches; `activateWorkbench` flips the visible one (`AgentSidebar.show(agent)`,
  which also repoints the edited-files button) and attaches the column to its split
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
  serialized as an `AgentState` under its project and relaunched resumed on session
  restore (work-area file-tab layout still deferred).
- **`src/ui/AgentTerminal.ts`** *(the `claude-tui` kind)* — a `Terminal`
  subclass that spawns the agent CLI (`agent.command` config, default
  `['claude']`); the Claude integration lives in
  `src/agents/claude-tui/session.ts` (`ClaudeSession`, arg/`--settings`
  injection + the status/edited-files/rename watchers). Notable behaviour:
  - initial title = the agent's program basename until the CLI reports its own
    (OSC) title; `prompt` option appends a launch prompt to argv;
  - on process exit the widget is **not** torn down and the agent/workbench is
    **not** closed — it prints a "process exited" notice, flips to `disconnected`
    (the single "not running" state), and stays listed; the user restarts
    (`agent:restart`/`r`) or stops
    (`agent:stop`/`x`) it from the workbench list. Closing its tab
    (`tab:close`) never retires it — it just backgrounds it (a running agent
    keeps working); `agent:close`/`d d` retires it;
  - **live status** (`idle | working | waiting | disconnected`, via `status` /
    `onDidChangeStatus`): for a `claude` agent it injects a per-session
    `--settings` block whose **hooks** write a status word to a file the
    terminal watches with a `Gio.FileMonitor`. Reporter:
    `assets/hooks/agent-status.sh`. `UserPromptSubmit`/`PreToolUse`→working,
    `Notification`→waiting/idle, `Stop`/`SessionStart`→idle.
- **`src/agents/acp/` + `src/ui/AgentConversation.ts`** *(the `acp` kind)* —
  spawns an Agent Client Protocol agent over JSON-RPC/stdio and renders the
  turn natively. Full doc: **[agents/acp.md](agents/acp.md)**. Shape:
  - `AcpSession.ts` (spawn + `@agentclientprotocol/sdk` wire plumbing +
    protocol→domain mapping) → `AgentConversation.ts` (the native transcript
    host), with the zym bridge injected from `bridge.ts`. `AcpSession` exposes
    the **same observable surface** `AgentTerminal` does (the
    `ConversationSession` seam), so the manager/sidebar/picker stay
    tool-agnostic.
  - Features: turn loop; tool rows with nerdfont icons (claude-quality rows —
    Bash command headers, collapsed file groups — via the adapter's
    `_meta.claudeCode.toolName`); native permission cards from
    `session/request_permission` (the agent's own options + diff previews);
    **interrupt** (`session/cancel`, on `ctrl-c`) and **close** (`ctrl-d
    ctrl-d`, anywhere); **subagents** (captured per-Task transcript via
    `_meta.claudeCode.parentToolUseId` — grouped inline entry, robot count
    button, pushed `Adw.NavigationView` page through the same shared row
    builder); **questions** (ACP form elicitation → the interactive card;
    claude's AskUserQuestion rides it); **plans** (ACP `plan` → the sticky
    Tasks panel); **message queueing** while busy (right-aligned "Pending"
    bubble); unknown updates surfaced as raw-JSON rows.
  - UI is split under `src/ui/conversation/`: `format.ts` (pure helpers,
    tested), `Transcript.ts` (the scrollable entries column + consecutive-run
    grouping, shared by the main view and each subagent page), `toolRows.ts` (the
    shared tool-use row builder — Bash / file-tool group / generic toggle — used by
    both), `StickyListPanel.ts` (the Tasks panel), `HeaderCountButton.ts` (the
    header-bar robot/terminal count buttons + popover, used by SubagentView /
    MonitorView), `cards.ts` (permission), `QuestionCard.ts`, `SubagentView.ts`,
    `MonitorView.ts`.
  - **Resume/serialize:** an acp agent serializes its argv + session id and
    resumes over `session/load` (history replays over the wire); branch /
    restart-of-live fork via `session/fork`.
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
  — `onActivateUser`), the rest are the running agents (status indicator + title;
  the per-agent edited-files badge moved to the AgentSidebar header, reflecting the
  *active* agent). The status indicator is a bundled symbolic `ImageIcons` SVG
  (`createAgentStatusIcon` in `agentStatusIcon.ts`, shared with the conversation
  footer): a single `Gtk.Image` swapped in place per state — dot (idle, green;
  disconnected/not-running, dimmed), warning shield (waiting/needs-permission,
  amber), loading ellipsis (working, muted), warning sign (error, red — POC-only
  for now). The user row's leading icon is the dimmed `user-symbolic` person, and
  all row titles (user + agents) share the `Workbenchrow--label` font class.
  **Never empty** (the user row is always present → no empty state). The header bar + scrollable list are assembled in an
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
  flag), and the worktree choice. The fields render as one `linked`, segmented
  group (they sit flush and share a single seam, only the group's outer corners
  rounded). Adwaita's own `.linked` only styles direct-child `entry`/`button` nodes
  and each `Combobox` nests its entry, so the launcher restyles the nested entry
  itself — leaning on GTK's `:first-child`/`:last-child` (which skip hidden widgets)
  to round the outer ends. The model slot is always shown (right after the agent)
  so the row's shape is stable; the permission / effort slots hide when the profile
  offers only the pass-through `default` for them (dead UI — their real options ride
  the generic config dropdowns). Each dropdown labels itself with a floating
  `title` (Adw.EntryRow-like — a placeholder while empty, floating above the value
  once set) and auto-sizes to fit its value, so there's no separate caption row.
  Each kind's `AgentLaunchOptions`
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
  widget listed (it flips to `disconnected`, restartable). The list's `x` key / row
  action.
- Closing the agent's tab (`tab:close`) never retires the agent, whatever its
  state: the terminal-tab close is vetoed (the terminal stays in its workbench
  — a running agent keeps working in the background, a stopped one stays
  listed) and the view falls back to the agent's rail neighbor
  (`WorkbenchManager.fallbackOwner`); re-select the agent to bring it back.
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
the picker (the `R` key in the list). The `acp` kind also handles a typed
**`/rename`** client-side (display-only). Most ACP agents also emit an evolving
**topic** (`session_info_update.title`) as the conversation shifts; that is
**not** the name — it's surfaced as the agent-sidebar header **subtitle**
(`Agent.topic` / `onDidChangeTopic`, off the churning list/tab name), and only
the *first* one seeds the stable name (once) when nothing else has named the
session. A pinned/auto name still wins.

**Naming a fresh session** — new sessions are **not** auto-named by a one-shot on
launch (that redundant `claude -p` call was removed — ACP is the source of the
name). A fresh `acp` session names itself from the agent's own **topic**: the
first non-empty `session_info_update.title` seeds the stable name once (see the
topic note above). Until then it reads as the picked **agent option** — the
launcher's profile label (e.g. `codex`), threaded through as
`AgentConversation`'s `defaultName` (launcher `profileLabel` → `openAgent` →
`AGENT_CONFIGS.create`); it's the lowest-priority fallback in the `title` getter,
so any real name (topic seed / auto-name / rename) still wins. Only a launch that
supplies no label falls back to the generic `acp agent`. The one-shot namer
survives only as an **on-demand** action.

**Auto-name (on demand)** — a one-shot LLM names a session from its task, triggered
by an **empty `/rename`** (only). A **one-shot agent** (`src/agents/oneshot.ts`:
`OneShotAgent` interface + `createOneShotAgent()`, hardcoded to `claude -p --model
sonnet` but behind a config-shaped seam) runs a prompt to completion via the
process runner and returns text; `src/agents/autoName.ts` wraps it to turn a task
prompt into `{ name, description }` (pure, lenient
`buildNamePrompt`/`parseAgentName`). Claude Code persists each `claude -p` run as
an ordinary session, so the one-shot reads the `session_id` from the result
envelope and deletes that transcript on completion
(`oneshot.ts:discardSessionTranscript`, via `agentSessions.ts:transcriptDir`) —
otherwise these throwaway naming queries would pollute the resume picker below. It
names from the **user's own prompt**, never zym's scaffolding: `launchPrompt`
returns `{ agentPrompt, userPrompt }` — `agentPrompt` (editor instructions + user
prompt) is the first turn, `userPrompt` is what the namer sees — threaded through
`openAgent` → `AgentLaunch.userPrompt` → `AgentConversation`. The editor
instructions in `agentPrompt` are wrapped in a `<zym-editor-instructions
label="…">` tag (`wrapEditorInstructions`, `conversation/format.ts`): the agent
receives the full scaffolding, but `AgentConversation` splits it back out
(`parseEditorInstructions`) and renders the `label` as a **condensed,
collapsible row** (worktree icon + one-liner, exact text behind the reveal)
instead of dumping the raw prose into the transcript — the user's own text still
renders as their message bubble. (claude-tui has no native transcript, so it
shows the tag verbatim in its terminal.) The naming context
prefers `userPrompt`, falling back to the first genuine user turn (the launch echo
is skipped). While the one-shot runs the title shows a transient `…` placeholder
(in-app only, never persisted); on success it's replaced by the `name` (persisted
like `/rename`) **silently** — the title change in the sidebar/tab is the
confirmation; on failure it's dropped, reverting to the previous name (the kind
default if it had none) plus a warning toast. The `description` is captured but not
yet surfaced. The one-shot is injectable (`AgentConversationOptions.oneShot`) for
tests.

**Tab affordance** — the agent's tab title is prefixed with a status glyph
(`agentTabTitle` in AppWindow), refreshed on status change; mirrors the sidebar
indicator's states with the equivalent text glyph (Adw tab titles are plain text —
no image/colour), so the waiting state drives Adw's `needs-attention` highlight
instead. The same glyph fallback (`agentStatusMarkup`) covers the markup-only
picker rows / SubagentView, which can't embed the sidebar's `Gtk.Image`.

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
- **Resume always spawns in the main dir** — because of the cwd invariant (see
  *git worktree integration → The cwd invariant* below), `--resume <id>` always
  runs from the main dir, so it must find the transcript there.
  `relocateTranscriptToMainRoot(session, mainRoot)` ensures that: it copies the
  transcript under `mainRoot`'s project dir when it lives elsewhere (a session
  launched in a worktree — legacy — or one surfaced by the worktree scan in
  *Enumerate*). New sessions are already born under the main dir (the invariant), so
  this is a no-op for them and only recovers older/worktree-dir transcripts. The
  editor re-roots to the session's worktree separately (see *git worktree
  integration → Resume* below), not via the spawn cwd — so a removed worktree just
  resumes in the main dir with no crash.
- **Resume** — `AgentTerminal` takes a `resume: { sessionId? | continue?; fork?
  }` option → prepends `--resume <id>` / `--continue` (+ `--fork-session`) to
  the claude argv. Commands: `agent:resume` (`space a r`, resume the current
  *exited* agent in place), `agent:resume-conversation` (`space a R`, a picker
  of past sessions excluding any currently live — label + relative time), and
  `agent:branch` (`space a b` / list `b`, fork the current agent via
  `--fork-session`).
- **Persist across editor restarts** — `AgentTerminal.serialize()` records
  `sessionId`; the (Session-management-owned) restore can relaunch a saved
  agent as `--resume <id>` to continue the conversation rather than start
  fresh. The `TabState` agent variant has an optional `sessionId`. The `acp`
  kind additionally serializes its **stable display name** (`name`) and its
  **session mode** (`permissionMode`) and restores both — the name as the title,
  the mode re-applied on resume (also on `agent:restart`/`agent:branch`) so a
  codex agent kept in `agent-full-access` doesn't silently revert to its
  sandboxed ask-first default and start prompting again (its modes are
  protocol-applied, so they aren't in the saved argv; claude-tui's `--permission-mode`
  is). The topic/subtitle stays unpersisted — see [agents/acp.md](agents/acp.md).

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

### Per-agent baselines (the attribution mechanism) — done 2026-07-05 (acp)

Capture each agent's "before" so its diff is well-defined. Shipped hook-free
for the `acp` kind (`AcpSession.captureBaseline`, in-memory):

- The **first** time an edit-kind `tool_call` streams in for a path, its
  current content is snapshotted — the notification arrives *before* the tool
  executes (verified against the claude adapter: emit → permission → run), so
  the read is pre-edit. Reads go through the injected fs host (buffer-aware:
  the user's unsaved edits from before the agent ran aren't attributed to it);
  a missing file baselines as "created".
- Agent A's change to a file = `diff(baseline, current)`. Works in **any**
  tree, which is why it's primary: a worktree can hold several agents, so the
  worktree's own `git diff` ≠ a single agent's work.
- **Fallbacks**: history replay (a resumed session) skips capture — the file
  already holds the replayed edits — and `claude-tui` has no ACP stream; both
  fall back to the **git HEAD blob** in the review diff (≈ working tree vs
  HEAD, filtered to the agent's touched files).
- (The pre-ACP design — `PreToolUse` hook → `.baseline/` snapshot files — is
  superseded; nothing is written to disk.)

### Review UI — done 2026-07-05

- The **"Agent Changes" tab** (`AgentController.openAgentChangesDiff`): the
  pencil badge in the agent header / `agent:open-changes` (`o` on a selected
  agent) opens ONE continuous multi-file diff (`baseline → current`) in the
  agent's work area — the same windowed multibuffer `DiffView` as the git
  diffs. Reopening refreshes in place (the stale tab closes first).
- **Editable**: the new side is live `Document`s — fix the agent's work up in
  place, saves write through, the diff re-flows. Enter/double-click on a row
  jumps to the real file.
- **Comment-to-agent**: review comments (single or batched) are delivered
  straight to *that* agent as a submitted turn (not the current-agent/picker
  routing), prefixed `Review of <title>'s changes (this session)`.
- TODO: expand the diff comment-to-agent action into threaded comments the agent can reply to inline.

### Ongoing vs past

- **Ongoing**: the new side re-diffs live as *open* documents change; the file
  list + baselines are captured at open time — click the pencil again to
  refresh with the agent's latest edits.
- **Past**: baselines are in-memory per session object, so an *exited* (not
  yet closed) agent stays precisely reviewable; a *resumed* conversation falls
  back to the git HEAD blob (above).

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

### The cwd invariant

**An agent's *process* always spawns in its project's main dir
(`AgentController.mainRoot()` = the active project's root — `process.cwd()` for the
primary, a `project:open`ed root otherwise), never a worktree.** A worktree is an
*editor* concern, decoupled from the process cwd along three axes:

- **process cwd** — fixed at the main dir for the agent's whole life. The OS cwd
  of the spawned `claude` never sits inside a worktree, so removing a worktree
  can't pull the dir out from under a live agent (which crashes it with a failing
  `getcwd()`). It's also why every transcript lands under one project dir
  (`~/.claude/projects/<encoded-main-dir>`), so `claude --resume <id>` always
  resolves. **Resume + discovery use the same `mainRoot()`** (`resumeOptions`
  relocates the transcript there; `agentSessionRoots` scans there), so an agent
  launched in a non-primary project resumes correctly — its transcript is under that
  project's dir, not `process.cwd()`.
- **editor root** (`workbench.cwd`) — the worktree the user sees: Files/Git/gutters.
  **The single source of truth for where the agent's editor is rooted** — the agent
  stores no cwd of its own. Seeded from `openAgent({ root })` (→ `buildWorkbench(agent,
  root)`) and moved by `set_worktree`, which the agent surfaces as a cwd on
  `onDidChangeWorktree` for `reRootWorkbench` to apply.
- **where the agent edits** — the worktree, reached via the agent's own Bash `cd`
  / absolute paths; `set_worktree` keeps the editor root in step.

So `openAgent` spawns at `mainRoot` and threads the worktree separately as `root`,
which roots the agent's **workbench** (not the agent); a vanished `root` falls back to
`mainRoot`. Resume/branch/restart pass the worktree as `root` (editor only) — reading
it back from `workbench.cwd` (`agentRoot`) — and never put it on the process cwd. The
trade-off: the
transcript records the *main dir* as Claude's cwd, not the worktree (already true
for dynamic moves) — recovered by the `<id>.zym-worktree` sidecar (*Resume* below).

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
     `--mcp-config` + pre-allowed in `--settings`; the tool's own MCP description
     carries the strict when/how — the model receives it either way — while
     `--append-system-prompt` adds only a proactive nudge + the "don't explain the
     integration" constraint, so nothing is repeated between them).
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
  `WorktreePicker` — rooting directly via `openAgent({root})` — is no longer wired
  to a command.)
- **Resume** — restores a conversation's worktree into the editor (`resumeOptions`).
  Per the cwd invariant the process spawns at `mainRoot`, so resume only ensures the
  transcript resolves there (`relocateTranscriptToMainRoot`) — it does *not* spawn in
  the session's old cwd. `agent:picker` / `agent:resume-conversation` list sessions
  across every worktree (`agentSessionRoots()` → `listResumableSessions`). The editor
  re-roots to the worktree the session worked in: a **dynamic** move
  (`session.effectiveCwd`, from the `<id>.zym-worktree` sidecar
  `recordSessionWorktree` wrote on each announce) wins over the launch cwd
  (`session.cwd`). When that worktree still exists, `resumeOptions` passes it as
  `root` and `buildWorkbench` roots the editor (Files/Git/gutters) there directly —
  no "call `set_worktree` and stop" re-announce turn (the seed restores the view, so
  resume is silent). A worktree that's since been removed simply resumes in the main
  dir (no spawn there, so no crash). Launch-time and dynamic worktrees are now one
  path — both spawn at the main dir and re-root the editor from the sidecar/cwd.

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
- **`set_actions([{ label, command, terminal? }])`**: overwrite the  **workbench actions**.

The tool *descriptions* cover only the **what**. The **when** — the mandate to
call `set_worktree` the instant a worktree is created/switched, and `set_actions`
whenever there's reviewable work — ships in the server-level **`instructions`**
field of the MCP initialize result (one clause per advertised tool, mirroring the
conditional tool advertising). A client surfaces that at startup even while the
tool schemas stay deferred, so the mandates are always seen up front.

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

### Next (prioritized, 2026-07-05)

1. [x] **fs capability (acp)** — done 2026-07-05: `fs/readTextFile`/`writeTextFile`
   advertised and served from the Document registry (reads see **unsaved buffer
   contents**, writes land in open documents). The Gemini CLI used it; the claude
   adapter doesn't route its file tools through client fs yet (as of 0.55.0), and
   antigravity does its file IO directly through `agy`.
   (See [agents/acp.md](agents/acp.md).)
2. [ ] **Manual QA pass on the less-happy acp paths** — wired but only
   spike-tested: the session-persistence round trip (quit zym with a live acp
   agent → restart → it reappears and `session/load`s its history), the
   worktree launch flows now that the bridge rides `mcpServers` (does the agent
   actually call `set_worktree`?), and interrupt while a permission card is up.
3. [x] **Agent profiles** — done 2026-07-05: `agent.profiles` (name + argv,
   defaults offer **codex** + the **claude adapter** — the gemini default was
   dropped 2026-07-06 when Google retired the free-tier Gemini CLI, and
   antigravity was dropped from the defaults 2026-07-07 as its `antigravity-acp`
   adapter honors almost none of zym's client capabilities; see agents/acp.md),
   resolved in `agents/profiles.ts`; the launcher's kind dropdown
   is a profile picker, and a legacy `agent.acp.command` / `ZYM_ACP_COMMAND`
   surfaces as the leading profile. The ACP registry manifest can seed
   suggestions later.
4. [x] **Terminal capability (acp)** — done 2026-07-05: full client-side
   `terminal/*` (`acp/terminals.ts`, zym-owned processes); live terminals
   revive the monitors UX (running panel with kill buttons, live-output
   inspect page). The Gemini CLI's shell tool rode it; the claude adapter still
   buffers over `_meta.terminal_output` (as of 0.55.0), and antigravity runs
   shell directly through `agy` (no client terminals). Live output into the
   tool *rows* themselves remains open (see agents/acp.md limitations).
5. [x] **Review story** — done 2026-07-05: the "Agent Changes" tab (see
   *Feature: reviewing an agent's work* above) — first-touch baselines off the
   ACP tool_call stream (hook-free; note: the adapter's diff payloads are
   *snippets*, so baselines snapshot the file at first sighting instead),
   editable continuous DiffView in the agent's work area, comments delivered
   to that agent. claude-tui / resumed sessions diff against git HEAD.

Smaller: session **config options** in the footer (model / effort switching for
agents that expose them) — done 2026-07-06, plus an argv-keyed cache that seeds
the *launcher* from what an agent advertised last run (see agents/acp.md
"Discovered options + the cache"). Still open: the in-app **`authenticate`** flow
(replacing the "log in via the agent's CLI" hint).

### Backlog

- [x] Profiles: `agent.profiles` schema + resolver (`agents/profiles.ts`),
      back-compat with `agent.acp.command`; picked in the launcher — done
      2026-07-05 (see *Next* item 3 above)
- [ ] Claude arg builder (model / tools / permission-mode / system-prompt)
      merged with the status `--settings`
- [~] Attention notifications: in-app toasts on waiting / working→idle while
      the tab is inactive are done (`notifyAgentAttention`); header `waiting`
      badge and OS notifications while the window is unfocused are still todo
- [x] Editor Diff renderer (`text-editor/diff.md`) — substrate for review
      (the multibuffer `DiffView`)
- [x] Review work: per-agent baselines + the "Agent Changes" diff panel — done
      2026-07-05 (stream-captured baselines, no hook/snapshot files; see
      *Feature: reviewing an agent's work*)
- [ ] Overlap warning when two live agents edit the same file (compare
      `changedFiles`)
- [ ] Worktree lifecycle (deferred) — keep/merge/discard when last agent
      leaves; per-worktree vs per-agent (baseline) review granularity
- [x] Resume/serialize for the `acp` kind — done (see *agents/acp.md*)
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

- ~~**Profile selection UX**~~ — settled 2026-07-05: the launcher's agent
  dropdown is the profile picker (sticky across launches, like the other
  launch options).
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
