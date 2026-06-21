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

Each `claude-tui` agent is a full Ink/React TUI process whose render loop
repaints ANSI on every token; Vte then re-parses + rasterises that on
zym's GTK main thread. The cost shows up *in the `claude` process* (htop)
**and** on zym's loop, and Vte (CPU rasteriser, shared loop) is worse at
it than a GPU terminal like kitty. GTK pins all widget work to one thread,
so the cost can't be threaded away — only removed. Headless removes it:
`claude -p` emits compact JSON deltas (no ANSI, no repaint, no Vte parse),
which we render incrementally into native widgets.

## Decision: drive the CLI directly, SDK types only

`@anthropic-ai/claude-agent-sdk` is a thin wrapper over exactly this
`claude -p` protocol — but it `child_process.spawn`s from the calling
process, assumes a vanilla Node loop, and manages its own CLI binary.
zym is opinionated against all three (fork-from-big-parent discipline;
node-gtk GLib loop; must run the **user's** installed `claude` with their
auth/config). So:

- **Transport:** spawn `claude` directly ourselves, exactly like
  `LspClient` (a long-lived streaming child over stdio is the proven
  node-gtk pattern — the one-shot `process/runner.ts` broker does **not**
  fit; that's for short git/gh commands). Newline-delimited JSON, not LSP
  Content-Length framing.
- **Types:** depend on `@anthropic-ai/claude-agent-sdk` for its exported
  message **types only** (a type-only import, erased at runtime by the type
  stripper — no runtime coupling, no spawn). Until that dep is vendored and
  the export names verified, `protocol.ts` carries hand-written types
  grounded in the **observed** wire output (see below); swap them for the
  SDK's once aligned.
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

The TUI's in-terminal permission prompt becomes a structured request
rendered natively. We wire `--permission-prompt-tool` from the start (not
an MVP shortcut like `acceptEdits`): claude calls a designated MCP tool to
ask for permission; we expose that tool from a small stdio MCP server
(`assets/mcp/zymPermission.mjs`, sibling to `zymBridge.mjs`), the call
surfaces to `SdkSession` as a permission request (status → `waiting`), the
native card collects allow/deny, and the decision is returned as the tool
result. This exercises the `waiting` path for real, and is exactly how the
Agent SDK's `canUseTool` works internally.

## Selecting the implementation

An agent config carries a `kind` so a profile chooses its implementation:
`'claude-tui'` (default, = `AgentTerminal`) vs `'claude-sdk'`.
`agent.command` stays back-compatible → a synthetic `claude-tui` profile.
A single `AppWindow.openAgent(options)` serves both kinds: it resolves an
`AgentConfig` (from `src/agents/configs.ts`, picked by the
`agent.implementation` flag or an explicit `options.kind`) and that
config's `create()` factory builds the host. Both kinds register in
`zym.agents` and get their own workbench (own center + Files/Git + docks).
The sidebar/picker read the shared observable surface, so they don't branch
on kind. Stop/close/restart route correctly per kind.

A shared `Agent` interface (`src/agents/types.ts`) is implemented by both
`AgentTerminal` and `AgentConversation`; `AgentManager`, `WorkbenchList`,
`AgentPicker`, `agentStatusIcon`, and the AppWindow owner machinery are
generic over `Agent`.

## Native transcript UI

`src/ui/AgentConversation.ts` (orchestrator) + `src/ui/conversation/*`
(`format`, `StickyListPanel`, `cards`, `QuestionCard`, `SubagentView`,
`MonitorView`) render a scrollable transcript of user/assistant/thinking/
tool rows. Tool rows carry nerdfont icons; Bash is syntax-highlighted +
cropped to one line until expanded. Richer turn surfaces:

- Thinking spinner + token meter.
- **Subagents:** per-`Agent`-tool transcript captured off the main thread;
  inline button + sticky "Subagents" panel + pushed `Adw.NavigationView`
  page.
- **Shell monitors:** sticky panel + inspect page + cancel.
- **AskUserQuestion:** an `Adw.ViewSwitcher` card (j/k/h/l + notes).
- **Message queueing** while busy: right-aligned "Pending" bubble.
- **Interrupt** on `ctrl-c`.
- Unknown event types surface as raw-JSON rows, never dropped.

## Resume

A headless session resumes like the terminal agent: `SdkSession.start()` adds
the shared `resumeFlags` (`--resume <id>` / `--continue` / `--fork-session`,
`src/agents/resume.ts`) so `claude -p` reloads its context. **`--resume` restores
the model's context but does NOT replay history as stream events** (verified
against claude-code 2.1.x — a resumed `-p` run emits only `init` + the new turn).
So the *visible transcript* is rebuilt separately: `transcript.ts` reads claude's
own on-disk JSONL (the same file `agentSessions.ts` reads for labels) into
`ReplayEntry[]`, and `SdkSession.replay` re-emits them as the domain events a live
turn produces, so `AgentConversation.wireSession`'s row handlers redraw the
conversation. Replay runs in the constructor (before the workbench subscribes to
changed-files, so historical edits seed rather than flood-open), guarded by a
`replaying` flag that draws Agent/Monitor/Question as static rows.

**Lazy reconnect:** a resume with no launch prompt rebuilds the transcript but does
NOT spawn `claude -p --resume` until the user's first turn (`ensureConnected`, off
`deferredStart`) — so restoring N agents on launch doesn't fire N claude processes
up front. `serialize()` falls back to the resume id when the deferred process hasn't
reported its own init session id yet, so a never-resumed agent still round-trips its
id. A resume that carries a prompt (e.g. the worktree re-announce) starts eagerly.

A resumed transcript ends with a permanent divider marking the boundary between
restored history and the live continuation. While not yet reconnected the agent
reports the `disconnected` status (a dim hollow dot, not live green — see
`agentStatusIcon`) and the divider reads `── session disconnected · send a message
to resume ──`; `ensureConnected` rewrites it to `── session resumed ──` (and clears
the disconnected status) on the first turn — the divider row itself stays.

`AgentConversation.serialize()` returns `{kind:'agent', agentKind:'claude-sdk',
…, sessionId}`; `TabState.agentKind` tells `restoreAgent` which host to relaunch.
A resume no longer forces `claude-tui` (`openAgent`); in-place resume of a headless
agent is a restart (its session is wired into views built at construction).

**Subagent restore:** Claude stores each subagent's conversation as
`<sid>/subagents/agent-<n>.jsonl` + a `.meta.json` ({agentType, description,
toolUseId}). `readSubagents` rebuilds each into a `SubagentInfo` keyed by its
spawning `Agent` tool id and attaches it to that tool's `ReplayEntry`; `replay`
seeds it into the session before the row is drawn, so the restored `Agent` tool
spawns the real subagent button + drill-down page (not a static row) and is marked
done. Monitor **inner** state is still not reconstructed (drawn as a static row).

Scope: the main thread restores fully — user turns, assistant text/thinking, tool
calls + results, the tasks panel, and spawned subagents' inner transcripts. The
footer's model + context gauge is seeded from the transcript's latest assistant
`usage` (`readContextSeed`), so a resumed agent shows its real context occupancy
before the first turn; cost and the exact context-window size aren't in the
transcript, so they settle on the first live `result`. Empty thinking blocks
(transcript stores signatures, not text) don't render.

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
- **Unknown event types** (`dispatch`→false, e.g. an inbound
  `control_request`) are surfaced as a raw-JSON row, never dropped.
- **Debug log** is opt-in via `ZYM_SDK_DEBUG` (off in tests).
