# Agent: claude-sdk (headless, natively rendered)

A second Claude agent implementation that runs `claude` **headlessly** (the
`claude -p` stream-json protocol) and renders the conversation in quilx's own
widgets, instead of hosting Claude's interactive TUI inside a `Vte.Terminal`.

The existing terminal implementation (`src/ui/AgentTerminal.ts` + `claude-tui/session.ts`)
is **kept** as `claude-tui` — we still want it (other agent CLIs, and Claude's TUI
when the user prefers it). This page is only about the new `claude-sdk` kind.

## Why (recap of the investigation)

Each `claude-tui` agent is a full Ink/React TUI process whose render loop repaints
ANSI on every token; Vte then re-parses + rasterises that on quilx's GTK main
thread. The cost shows up *in the `claude` process* (htop) **and** on quilx's loop,
and Vte (CPU rasteriser, shared loop) is worse at it than a GPU terminal like
kitty. GTK pins all widget work to one thread, so the cost can't be threaded
away — only removed. Headless removes it: `claude -p` emits compact JSON deltas
(no ANSI, no repaint, no Vte parse), which we render incrementally into native
widgets. See the conversation that produced this doc; the turn-by-turn capability
was verified live (one persistent `claude -p` process, two turns, context carried,
same `session_id`, no `--resume`).

## Decision: drive the CLI directly, SDK types only

`@anthropic-ai/claude-agent-sdk` is a thin wrapper over exactly this `claude -p`
protocol — but it `child_process.spawn`s from the calling process, assumes a
vanilla Node loop, and manages its own CLI binary. quilx is opinionated against
all three (fork-from-big-parent discipline; node-gtk GLib loop; must run the
**user's** installed `claude` with their auth/config). So:

- **Transport:** spawn `claude` **directly** ourselves, exactly like `LspClient`
  (a long-lived streaming child over stdio is the proven node-gtk pattern — the
  one-shot `process/runner.ts` broker does **not** fit; that's for short git/gh
  commands). Newline-delimited JSON, not LSP Content-Length framing.
- **Types:** depend on `@anthropic-ai/claude-agent-sdk` for its exported message
  **types only** (a type-only import, erased at runtime by the type stripper — no
  runtime coupling, no spawn). Until that dep is vendored and the export names
  verified, `protocol.ts` carries hand-written types grounded in the **observed**
  wire output (see below); swap them for the SDK's once aligned.
- **Migration-friendly:** the UI consumes `SDKMessage`-shaped events either way,
  so if quilx ever leaves node-gtk we can swap our transport for the SDK's
  `query()` runtime in one localized change.

## Observed wire protocol (captured live, claude-code 2.1.x)

Invocation: `claude -p --input-format stream-json --output-format stream-json --verbose`.
Persistent: the process stays alive across turns; write one JSON line per user
turn to stdin; events stream out on stdout, one JSON object per line.

Input (one user turn):
```json
{"type":"user","message":{"role":"user","content":"...text..."}}
```

Output events (one per line) seen in the capture:
- `{"type":"system","subtype":"init", session_id, tools, model, permissionMode, slash_commands, cwd, ...}`
- `{"type":"system","subtype":"thinking_tokens", estimated_tokens, estimated_tokens_delta, session_id}`
- `{"type":"assistant","message":{role,content:[{type:"thinking",...}|{type:"text",text}],usage,...}, session_id}`
- `{"type":"result","subtype":"success", result:"...", num_turns, total_cost_usd, usage, permission_denials, ...}` — **one per turn** (not per session)
- `{"type":"rate_limit_event", rate_limit_info:{...}}`

Session continuity = a stable `session_id` across turns within the one process;
each turn closes with its own `result`. Token streaming is available via
`--include-partial-messages` (more granular `assistant` deltas) — opt in later.

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

So the existing registry/sidebar/picker work unchanged, `claude-sdk` exposes the
same observable surface `AgentTerminal` does (`status` / `onDidChangeStatus`,
`changedFiles` / `onDidChangeFiles`, `sessionId`, session name, worktree):

| Source event | Domain |
|---|---|
| stdin write (user turn) → first event | `working` |
| `result` | `idle` |
| permission request (see below) | `waiting` |
| process exit | `exited` |
| `assistant` text/thinking blocks | transcript messages (native render) |
| `assistant` tool_use blocks (Edit/Write/…) | `changedFiles` (path from tool input) |
| `system/init.session_id` | `sessionId` (native — no hook scraping) |
| `result.total_cost_usd`, `usage` | cost/context meter (free, was deferred for TUI) |

This **replaces** the `agent-status.sh` hooks + status-file scraping + the
`quilxBridge` MCP for this kind: status, edited files, session id, cwd, and cost
all arrive as typed stream events. (`claude-tui` keeps the hook path.)

### Permissions — decided: `--permission-prompt-tool`

The TUI's in-terminal permission prompt becomes a structured request rendered
natively. **Decision:** wire `--permission-prompt-tool` from the start (not an
MVP shortcut like `acceptEdits`). claude calls a designated MCP tool to ask for
permission; we expose that tool from a small stdio MCP server (sibling to
`quilxBridge.mjs`), the call surfaces to `SdkSession` as a permission request
(status → `waiting`), the native card collects allow/deny, and the decision is
returned as the tool result. This is the honest end state and exercises the
`waiting` path for real.

## Selecting the implementation

Add a `kind` to the agent config so a profile chooses its implementation:
`'claude-tui'` (default, = today's `AgentTerminal`) vs `'claude-sdk'`. Keep
`agent.command` back-compat → a synthetic `claude-tui` profile. The launch seam is
`AppWindow.openAgent` / `buildWorkbench`; both `claude-tui` and `claude-sdk` agents
register in `quilx.agents` and get a workbench. The sidebar/picker read the shared
observable surface, so they don't branch on kind.

## Phasing

- [x] **Reorg** — `claude-tui` → `src/agents/claude-tui/`, SDK → `src/agents/claude-sdk/`,
      `AgentTerminal` abstracted onto an injected `AgentDriver` (`src/agents/types.ts`),
      `createClaudeTuiDriver` installed by `AppWindow.openAgent`.
- [x] **Transport** — `transport.ts` + test (fake `claude` script). Spawn, line
      framing, send/onEvent/onExit/dispose. 4/4 tests pass.
- [x] **Protocol types** — `protocol.ts` from observed wire output.
- [x] **SdkSession** — argv build (stream-json + permission-prompt-tool), turn
      queue, event→domain mapping (status + granular transcript events), injectable
      transport, abort/dispose. Unit-tested (fake transport) + a real end-to-end
      smoke test (claude returned `PONG`, working→idle, real session id).
- [x] **Native transcript UI** — `src/ui/AgentConversation.ts`: a purpose-made
      message-list (scrollable transcript of user/assistant/thinking/tool rows +
      permission card + input entry). *Not* run-tested in the GUI yet — built to
      quilx conventions; needs a visual pass.
- [x] **Permissions** — `--permission-prompt-tool` wired to `assets/mcp/quilxPermission.mjs`
      (stdio MCP server) over an atomic request/response file pair; SdkSession
      surfaces the request (`waiting`) and `respondPermission` answers. Server
      connection verified; the full trigger→card→decision loop needs the editor's
      GLib loop (the file watcher) — test in-app.
- [x] **Integration** — a shared `Agent` interface (`src/agents/types.ts`) that
      both `AgentTerminal` and `AgentConversation` implement; `AgentManager`,
      `WorkbenchList`, `AgentPicker`, `agentStatusIcon`, and the AppWindow owner
      machinery are now generic over `Agent`. `agent:new` branches on
      `agent.implementation` to `openSdkAgent`, which builds the agent its **own
      workbench** (own center + Files/Git + docks), registers it in `quilx.agents`
      (→ sidebar entry + switching), and wires status/attention/changed-files/
      lifecycle exactly like a terminal agent. Stop/close/restart route correctly
      per kind. A single `AppWindow.openAgent(options)` now serves both kinds: it
      resolves an `AgentConfig` (from `src/agents/configs.ts`, picked by the
      `agent.implementation` flag or an explicit `options.kind`) and that config's
      `create()` factory builds the host — one launch path, no `openSdkAgent`.
      **Still deferred:** conversation resume + session serialize for sdk
      (serialize returns null → not persisted across editor restart yet).
- [ ] **Extras (free now)** — cost/context meter; token-level streaming
      (`--include-partial-messages`); live transcript.

## Constraints carried in

- **node-gtk GLib loop:** streaming child IO works (LSP proves it); start the loop
  from a macrotask (already done). See memory `node-gtk-node-io-lsp`.
- **Strip-only TS:** no enums / parameter properties / namespaces. Type-only
  imports (the SDK types) are erased — safe.
- **Disposal discipline:** the session owns a child process + stdio listeners +
  emitter subs; tear all down in `dispose()` (memory `disposal-discipline`).
- **One main component per `src/ui` file**, camelCased — but the transport/session
  live under `src/agents/claude-sdk/` (non-UI plumbing), UI host under `src/ui/`.
