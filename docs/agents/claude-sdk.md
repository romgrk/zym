# Agent: claude-sdk (headless, natively rendered)

A second Claude agent implementation that runs `claude` **headlessly** (the
`claude -p` stream-json protocol) and renders the conversation in zym's
own widgets, instead of hosting Claude's interactive TUI inside a
`Vte.Terminal`.

The terminal implementation (`src/ui/AgentTerminal.ts` +
`claude-tui/session.ts`) is kept as `claude-tui` — we still want it for
other agent CLIs, and for Claude's TUI when the user prefers it. This page
is only about the `claude-sdk` kind.

## Why headless

Each `claude-tui` agent is a full Ink/React TUI whose render loop repaints
ANSI every token; Vte re-parses + rasterises that on zym's GTK main thread.
The cost lands *in the `claude` process* (htop) **and** on zym's loop — and
Vte (CPU rasteriser, shared loop) is worse at it than a GPU terminal. GTK
pins widget work to one thread, so the cost can't be threaded away, only
removed. Headless removes it: `claude -p` emits compact JSON deltas (no ANSI,
no repaint, no Vte parse) we render incrementally into native widgets.

## Decision: drive the CLI directly, SDK types only

`@anthropic-ai/claude-agent-sdk` wraps exactly this `claude -p` protocol —
but it `child_process.spawn`s from the calling process, assumes a vanilla
Node loop, and manages its own CLI binary. zym rejects all three (fork-from-
big-parent discipline; node-gtk GLib loop; must run the **user's** `claude`
with their auth/config). So:

- **Transport:** spawn `claude` directly, like `LspClient` (a long-lived
  streaming child over stdio is the proven node-gtk pattern; the one-shot
  `process/runner.ts` broker is for short git/gh commands, not this).
  Newline-delimited JSON, not LSP Content-Length framing.
- **Types:** depend on `@anthropic-ai/claude-agent-sdk` for its message
  **types only** (type-only import, erased at runtime — no spawn, no runtime
  coupling). Until that dep is vendored and the export names verified,
  `protocol.ts` carries hand-written types from the **observed** wire output
  (below); swap once aligned.
- **Migration-friendly:** the UI consumes `SDKMessage`-shaped events either
  way, so if zym ever leaves node-gtk we can swap our transport for the
  SDK's `query()` runtime in one localized change.

## Wire protocol (observed live, claude-code 2.1.x)

Invocation:
`claude -p --input-format stream-json --output-format stream-json --verbose`.
The process stays alive across turns: write one JSON line per user turn to
stdin; events stream out on stdout, one JSON object per line.

Input (one user turn):
```json
{"type":"user","message":{"role":"user","content":"...text..."}}
```

Output events (one per line):
- `{"type":"system","subtype":"init", session_id, tools, model, permissionMode, slash_commands, cwd, ...}`
- `{"type":"system","subtype":"thinking_tokens", estimated_tokens, estimated_tokens_delta, session_id}`
- `{"type":"assistant","message":{role,content:[{type:"thinking",...}|{type:"text",text}],usage,...}, session_id}`
- `{"type":"result","subtype":"success", result:"...", num_turns, total_cost_usd, usage, permission_denials, ...}` — **one per turn** (not per session)
- `{"type":"rate_limit_event", rate_limit_info:{...}}`

Session continuity = a stable `session_id` across turns within the one
process; each turn closes with its own `result`. Token streaming is
available via `--include-partial-messages` (more granular `assistant`
deltas) — opt in later.

## Architecture

```
ClaudeStreamTransport   (transport.ts)  spawn claude, line framing, send/onEvent/onExit/dispose
        │ raw StreamEvent (one parsed line)
SdkSession              (SdkSession.ts) argv build, turn queue, event→domain mapping,
        │                               status/changedFiles/sessionName/sessionId/cost,
        │                               permission requests, abort
AgentConversation          (UI host)       native transcript surface; mirrors AgentTerminal's
                                        public API (status/onDidChangeStatus/changedFiles/…)
                                        so the manager, sidebar, picker stay tool-agnostic
```

`protocol.ts` holds the wire types + small constructors (`userTurn(text)`).

### Domain mapping (events → AgentTerminal-compatible surface)

So the existing registry/sidebar/picker work unchanged, `claude-sdk`
exposes the same observable surface `AgentTerminal` does (`status` /
`onDidChangeStatus`, `changedFiles` / `onDidChangeFiles`, `sessionId`,
session name, worktree):

| Source event | Domain |
|---|---|
| stdin write (user turn) → first event | `working` |
| `result` | `idle` |
| permission request (see below) | `waiting` |
| process exit | `exited` |
| `assistant` text/thinking blocks | transcript messages (native render) |
| `assistant` tool_use blocks (Edit/Write/…) | `changedFiles` (path from tool input) |
| `system/init.session_id` | `sessionId` (native — no hook scraping) |
| `result.total_cost_usd`, `usage` | cost/context meter |

For this kind, status, edited files, session id, cwd, and cost all arrive
as typed stream events — no `agent-status.sh` hooks, status-file scraping,
or `zymBridge` MCP. (`claude-tui` keeps the hook path.)

### Permissions — `--permission-prompt-tool`

The TUI's in-terminal prompt becomes a native structured request. We wire
`--permission-prompt-tool` from the start (not an `acceptEdits` shortcut):
claude calls a designated MCP tool to ask permission; we expose it from a
small stdio MCP server (`assets/mcp/zymPermission.mjs`, sibling to
`zymBridge.mjs`), the call surfaces to `SdkSession` as a request (status →
`waiting`), and the decision returns as the tool result — exactly how the Agent
SDK's `canUseTool` works internally.

**The prompt REPLACES the input** (it is *not* embedded in the tool row): while
the agent waits, the input card's `Gtk.Stack` swaps the prompt editor for an
interaction widget, restored once answered (`AgentConversation`'s interaction
slot + `interactionSubs`), and the input card is ringed in the matching status
colour — **warning** for a permission, **info** for a question (the `is-permission`
/ `is-question` classes; the `QuestionCard` itself is borderless, the ring lives on
the card). For a **permission** request that widget is `cards.ts:permissionPrompt`
— a title + a body (`toolRows.ts:permissionPromptParts`) over a row of **raised**
actions. The title/body depend on the tool: **Bash** → the command's description is
the title and the command the body (a monospace **code block** — a faint
`--window-bg-color` tint, button-radius rounding); an **edit tool** → the **file
path** is the title and the body is a **diff** of the change (`editDiffLines` →
`permissionDiffView`: signed +/- lines, added green / removed red / context dimmed,
height-capped and scrollable). The actions are **Accept** / **Deny** / **Switch to
auto**, plus **Allow edits** *only for edit tools* (`EDIT_TOOLS`; for a command run,
`acceptEdits` wouldn't auto-accept it, so it's dropped). The last two
`setPermissionMode('acceptEdits' | 'auto')` *and* allow, so like calls stop
prompting. The tool's own row stays in the transcript and fills with the result
once the decision lands, so no request↔row correlation is needed. An
**AskUserQuestion** swaps the same slot for the interactive `QuestionCard`; on
answer the card moves into the transcript (rendering itself as the answered
record) and the prompt returns.

## Selecting the implementation

An agent config carries a `kind`: `'claude-tui'` (default, = `AgentTerminal`)
vs `'claude-sdk'`; `agent.command` stays back-compatible → a synthetic
`claude-tui` profile. One `AppWindow.openAgent(options)` serves both: it
resolves an `AgentConfig` (`src/agents/configs.ts`, by the
`agent.implementation` flag or explicit `options.kind`) whose `create()`
builds the host. Both register in `zym.agents` with their own workbench
(center + Files/Git + docks); the sidebar/picker read the shared observable
surface, so they don't branch on kind, and stop/close/restart route per kind.

A shared `Agent` interface (`src/agents/types.ts`) is implemented by both hosts;
`AgentManager`, `WorkbenchList`, `AgentPicker`, `agentStatusIcon`, and the
AppWindow owner machinery are generic over `Agent`.

## Native transcript UI

`src/ui/AgentConversation.ts` (orchestrator) + `src/ui/conversation/*`
(`Transcript`, `toolRows`, `format`, `StickyListPanel`, `HeaderCountButton`, `cards`,
`QuestionCard`, `SubagentView`, `MonitorView`) render a scrollable transcript of
user/assistant/thinking/tool rows. **Tool-use entries are built in one place —
`toolRows.ts:appendToolRow` (Bash row, collapsed file-tool group, or generic toggle
row)** — so the main transcript and each subagent page render identically;
`AgentConversation` feeds result/progress from live events, a subagent page (holding
the full captured call+result) wires the result once. Tool rows carry nerdfont icons;
for a single-button `ToolRow` (Bash / generic toggle / monitor / unknown-event) the
icon sits **inline at the start of the header button**, left of the title, so icon +
title are one click target that grows + tints together — only the **grouped**
file-tool rows (Read/Edit/… collapsed into one run, built in `Transcript`) keep the
icon outside, beside the run's head. The header (toggle button) is one ellipsized
line, full text behind the toggle (`ToolRow.toolHeaderLabel`); the Bash command is
plain monospace, cropped to one line until expanded. A non-zero Bash exit shows a
trailing red dot, leaving the icon + command untouched (other tools swap to a red ✗
on a genuine failure). A **live** tool row spins (an `Adw.Spinner` swapped in for the
glyph in the button's icon slot, `ToolRow.setRunning`) from tool-use until its result
lands, so an in-flight Bash/Task reads differently from a finished one; replayed and
subagent-page rows pass `live:false` and never spin.

**Fitting the column:** every *wrapping* label in the transcript (tool detail/output,
Bash command, result/JSON dumps, monitor/subagent/question/permission rows) is built
through `proseMarkup.wrappingLabel`, which sets Pango `WORD_CHAR`. A plain `WORD`-wrap
label reports a minimum width as wide as its longest unbreakable token (a long URL,
path, tool name, or JSON string), and that minimum propagates up and forces the
column past its `Adw.Clamp` bound — widening *every* row. `WORD_CHAR` lets the token
break mid-word, keeping the minimum small so the row wraps inside the clamp instead.
Single-line headers ellipsize (`ToolRow.toolHeaderLabel`) for the same reason; message
bubbles are immune (the `MarkdownRenderer` reports a small fixed minimum width).

Richer turn surfaces:

- Thinking spinner + token + elapsed meter (the footer "Thinking…" indicator, shown
  while the model reasons; a 1s tick folds the turn's elapsed time in beside the
  reasoning-token count — `Thinking… (1.2k tokens · 1m 05s)`). The inline dim
  *thinking blocks* in the transcript are opt-in via the `agent.showThinking` config
  flag (off by default); the footer indicator is unaffected.
- **Subagents:** per-`Agent`-tool transcript captured off the main thread. A run
  of consecutive spawns **collapses into one inline entry** (a single subagent icon
  + an "Agent" head + each spawn stacked as a clickable item) — the same
  consecutive-run grouping Read uses (`Transcript.appendGroupItem` /
  `SUBAGENT_GROUP`). Plus a **robot count button in the agent header bar**
  (`HeaderCountButton`, packed by `AgentSidebar` via `Agent.headerWidgets`) — icon +
  running count, hidden at zero, opening a popover that lists the running ones (each
  leads with the shared `agentStatusIcon` glyph and opens) + a pushed
  `Adw.NavigationView` page whose tool rows go through the shared `appendToolRow`.
- **Shell monitors:** a **terminal count button in the agent header bar** (same
  `HeaderCountButton`; popover rows carry a Cancel) + inspect page + cancel.
- **AskUserQuestion:** an `Adw.ViewSwitcher` card (j/k/h/l + notes) that replaces
  the input while open, then moves into the transcript as the answered record.
- **Message queueing** while busy: right-aligned "Pending" bubble with **Edit**
  (pull it back into the prompt to amend) and **Cancel** (discard) controls; sent
  automatically on the next idle if left alone.
- **Interrupt** on `ctrl-c`; **close** on `ctrl-d ctrl-d` (anywhere — re-declared on
  the prompt editor so vim's `ctrl-d` scroll doesn't preempt the chord).
- Unknown event types surface as raw-JSON rows, never dropped.

## Resume

`SdkSession.start()` adds the shared `resumeFlags` (`--resume <id>` /
`--continue` / `--fork-session`, `src/agents/resume.ts`) so `claude -p` reloads
its context. **`--resume` restores context but does NOT replay history as events**
(verified, claude-code 2.1.x — a resumed `-p` run emits only `init` + the new turn).
So the *visible transcript* is rebuilt separately: `transcript.ts` reads claude's
on-disk JSONL (the file `agentSessions.ts` reads for labels) into `ReplayEntry[]`,
and `SdkSession.replay` re-emits them as the domain events a live turn produces, so
`AgentConversation.wireSession`'s handlers redraw it. Replay runs in the constructor
(before the workbench subscribes to changed-files, so historical edits seed rather
than flood-open), guarded by a `replaying` flag that draws Agent/Monitor/Question
as static rows.

**Lazy reconnect:** a resume with no launch prompt rebuilds the transcript but
doesn't spawn `claude -p --resume` until the first turn (`ensureConnected`, off
`deferredStart`) — so restoring N agents doesn't fire N processes up front.
`serialize()` falls back to the resume id when the deferred process hasn't reported
its init session id yet, so a never-resumed agent still round-trips its id. A resume
carrying a prompt (e.g. the worktree re-announce) starts eagerly.

A resumed transcript ends with a permanent divider between restored history and the
live continuation. Until reconnected the agent reports `disconnected` (a dim hollow
dot, not live green — `agentStatusIcon`) and the divider reads `── session
disconnected · send a message to resume ──`; the first turn rewrites it to
`── session resumed ──` and clears the status (the row stays).

`AgentConversation.serialize()` returns `{kind:'agent', agentKind:'claude-sdk',
…, sessionId}`; `TabState.agentKind` tells `restoreAgent` which host to relaunch.
Resume no longer forces `claude-tui`; in-place resume of a headless agent is a restart
(its session is wired into views built at construction).

**Subagent restore:** Claude stores each subagent as `<sid>/subagents/agent-<n>.jsonl`
+ a `.meta.json` ({agentType, description, toolUseId}). `readSubagents` rebuilds each
into a `SubagentInfo` keyed by its spawning `Agent` tool id and attaches it to that
tool's `ReplayEntry`; `replay` seeds it before the row is drawn, so the restored
`Agent` tool spawns the real button + drill-down page (not a static row), marked done.
Monitor **inner** state is still not reconstructed (static row).

Scope: the main thread restores fully — user turns, assistant text/thinking, tool
calls + results, the tasks panel, and subagents' inner transcripts. The footer's
context gauge (and the model in its breakdown popover) is seeded from the transcript's
latest assistant `usage` (`readContextSeed`), so a resumed agent shows real context
occupancy before the first turn; cost and the exact context-window size aren't in the
transcript, so they settle on the first live `result`. Empty thinking blocks (transcript
stores signatures, not text) don't render.

## Remaining / planned

- [ ] **Monitor inner-state restore** — the `Monitor` tool draws as a static row
      on resume; its live panel/output isn't reconstructed.
- [ ] **Cost on resume** — the context gauge is seeded from the transcript, but
      cost isn't recorded there; the footer cost shows `—` until the first turn.
- [ ] **Token-level live streaming** via `--include-partial-messages`.
- Swap `protocol.ts` hand-written types for the SDK's exported types once
  the dep is vendored and export names are verified.
- Verify the full permission trigger→card→decision loop in-app: the server
  connection is verified, but the loop relies on the editor's GLib loop
  (the file watcher).

## Constraints carried in

- **node-gtk GLib loop:** streaming child IO works (LSP proves it); start
  the loop from a macrotask (already done). See memory
  `node-gtk-node-io-lsp`.
- **Strip-only TS:** no enums / parameter properties / namespaces.
  Type-only imports (the SDK types) are erased — safe.
- **Disposal discipline:** the session owns a child process + stdio
  listeners + emitter subs; tear all down in `dispose()` (memory
  `disposal-discipline`).
- **One main component per `src/ui` file**, camelCased — but the
  transport/session live under `src/agents/claude-sdk/` (non-UI plumbing),
  UI host under `src/ui/`.

## Control surfaces (empirically verified — don't "fix" these blindly)

Flow: `transport` (spawn + NDJSON) → `SdkSession.dispatch` (events→domain)
→ `AgentConversation` (widgets). One persistent `claude -p` process per
agent; turns are `{type:'user',...}` lines on stdin.

- **Permission gating = `--permission-prompt-tool` (required, not
  optional).** Without it claude runs every tool unattended. claude calls
  our stdio MCP (`assets/mcp/zymPermission.mjs`); it bridges to
  `SdkSession` over an atomic file pair; the native card returns
  `{behavior:'allow'|'deny',...}`. This is exactly how the Agent SDK's
  `canUseTool` works internally.
- **Interrupt = control_request `{subtype:'interrupt'}`** on stdin →
  `control_response` success (flip to idle now) → `result`
  `error_during_execution` (suppress as intentional, see `interrupting`).
- **`error_during_execution` *without* an interrupt = a genuine crash** — claude
  hit a fatal error mid-turn (transient API/stream failure on a long session is
  the common one) and the `-p` process exits. The `result.result` field is empty
  in this case, so the cause only appears on **claude's stderr** — which the
  transport now captures into a bounded `stderrTail` ring buffer (`SdkSession`).
  The error row carries that tail as its `detail`; the trailing `exit` event
  carries the code (the row shows `(code N)` when non-zero) and the tail; an
  abnormal (non-zero) exit is always `console.warn`'d (`logExit`) so the cause
  survives in the app log without `ZYM_SDK_DEBUG`. The agent stays listed as
  `exited` and is restartable/resumable (`agent:restart` / `agent:resume`).
  Writing a turn to a child that just died raises EPIPE on stdin — the transport
  absorbs it (a stdin `'error'` handler) so it can't crash zym.
- **Cancel a background task / shell monitor = control_request
  `{subtype:'stop_task', task_id}`** (the CLI's `stopTask`; verified live)
  → `task_updated{patch.status:'killed'}` + `task_notification{status:
  'stopped'}` + `control_response` success. The full control vocabulary in
  the 2.1.x binary also includes `set_permission_mode`, `set_model`,
  `set_max_thinking_tokens`, `get_context_usage`, `background_tasks`,
  `mcp_message` — strings dump of `/opt/claude-code/bin/claude`.
- **Subagents / monitors** ride `task_started{task_id,tool_use_id,
  task_type,description}` → `task_updated{task_id,patch}` →
  `task_notification{tool_use_id,status,output_file,summary}`. `task_type`
  is `local_agent` for subagents, `local_bash` for both background-bash
  AND monitors — so a **Monitor is identified by the tool name**, not
  task_type. Cancel needs the `task_id` (from task_started); map it via
  the tool_use_id.
- **AskUserQuestion has NO clean headless answer channel.** It
  self-executes inside claude; with no TTY it returns "did not answer".
  Verified dead-ends: `allow`+any `updatedInput` shape, and client-sent
  `tool_result` (claude self-resolves first). **Only** working path: route
  it as an interactive question card and return the selection as the
  permission **`deny` message** (lands as the tool_result, flagged
  `is_error:true` — unavoidable; claude reads it fine).
- **`/rename` is a TUI-local command — headless `claude -p` lacks it.**
  Verified: a `/rename foo` turn returns the synthetic `"/rename isn't available
  in this environment."` and `/rename` is absent from `init.slash_commands`. So
  `AgentConversation.submit()` intercepts it **client-side** (`handleLocalCommand`
  → `parseLocalCommand`), like the TUI, never forwarding it. It sets the session
  name (`_sessionName`, distinct from the pinned `agent:rename` `_displayName`,
  which still wins) and **persists like the TUI**: `agentSessions.writeCustomTitle`
  appends the same `{"type":"custom-title","customTitle","sessionId"}` line to
  `~/.claude/projects/<encoded-launch-cwd>/<id>.jsonl` (O_APPEND, atomic per line).
  On resume, `readSessionName` re-reads it (custom title, else `ai-title`) — headless
  has no live OSC title channel. `/rename` is also injected into slash-completion (the
  CLI's `init` won't offer it); cross-kind, the resume picker label reads the same
  `custom-title`.
- **Auto-name = a one-shot `claude -p --model sonnet`** (`src/agents/oneshot.ts`
  + `autoName.ts`), separate from the streaming session. Bare `/rename` regenerates
  on demand; launching with `agent.autoName` names a fresh agent. Both name from the
  **user's own prompt** (`launchPrompt`'s `userPrompt`, with zym's worktree/editor
  instructions stripped — else the title describes our scaffolding), falling back to
  the first genuine user turn. Non-blocking (runs alongside the first turn): the title
  shows a transient `…` placeholder (`_transientName`, in-app only, never persisted)
  → on success the generated `name` (applied like a typed `/rename`, persisted; the
  title change is the only confirmation) → on failure reverts to the previous name
  (kind default `'claude (sdk)'`) plus a warning toast. The one-shot parses a
  `--output-format json` envelope (`parseOneShotEnvelope`) and the name out of
  fenced/prose JSON (`parseAgentName`, lenient). Injectable via
  `AgentConversationOptions.oneShot` for tests; model/argv hardcoded behind a
  config-shaped seam (`ClaudeOneShotConfig`).
- **Unknown event types** (`dispatch`→false, e.g. an inbound
  `control_request`) are surfaced as a raw-JSON row, never dropped.
- **Debug log** is opt-in via `ZYM_SDK_DEBUG` (off in tests).
