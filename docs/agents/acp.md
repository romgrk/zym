# Agent: acp (Agent Client Protocol)

The `acp` kind runs any [Agent Client Protocol](https://agentclientprotocol.com)
agent — Gemini CLI natively (`gemini --acp`), Claude Code and Codex via their
ACP adapters — in the native conversation view (`AgentConversation`). ACP is
"LSP for coding agents": the client (zym) spawns the agent as a subprocess and
speaks JSON-RPC 2.0 over stdio (protocol version 1). It replaced the former
`claude-sdk` kind (headless `claude -p` stream-json, reverse-engineered): the
official claude-agent-acp adapter provides the same claude features over the
open protocol.

## The seam: `ConversationSession`

`AgentConversation` (the native transcript UI) is typed against
`src/agents/session.ts:ConversationSession` — the tool-agnostic session surface
(status, granular transcript events, permission requests, metadata).
`AcpSession` is its implementation, supplied via
`AgentConversationOptions.createSession`; optional capabilities (`onQuestion`,
`onPlan`, `onFileEdited`, `onSessionName`, `onReplay`, `getModeState`) are
wired with `?.` — a session that lacks one simply never fires it, and
`getSubagent`/`getMonitor` may always return `undefined` (the views only act on
ids the session itself surfaced). A future protocol only has to map its wire
events onto this surface.

## Architecture

```
spawn agent argv (an agent.profiles entry)      src/agents/acp/AcpSession.ts
  stdio ⇄ ndJsonStream ⇄ @agentclientprotocol/sdk client()
        │  session/update, session/request_permission   (agent → zym)
        │  initialize, session/new, session/prompt, session/cancel (zym → agent)
AcpSession (protocol → ConversationSession domain mapping)
        │  ConversationSession domain events
AgentConversation (rendering)
```

**Dependency decision:** `@agentclientprotocol/sdk` is a runtime dep (unlike
the rejected Claude Agent SDK) because it spawns nothing — it takes the streams
we hand it. zym keeps its own spawn discipline: a long-lived streaming child
over stdio, the LspClient / ClaudeStreamTransport pattern. The child's three
stdio pipes need `error` absorbers (verified: the SDK's `connection.close()`
cancels the Web-stream wrappers, which destroy the sockets *with an error* —
unabsorbed, disposing a session crashes zym).

## Protocol → domain mapping

| ACP | zym domain |
|---|---|
| `initialize` → `agentInfo.name` | `init.model` (footer model label) |
| `session/new` → `sessionId`, `modes` | `sessionId`; mode state (below) |
| `session/prompt` resolves (`stopReason`) | turn end: `end_turn`→idle, `cancelled`→interrupted, else an error row |
| `agent_message_chunk` (`messageId` change = new message) | `assistant-start` / `assistant-text` deltas |
| `agent_thought_chunk` | `assistant-thinking` deltas |
| `tool_call` / `tool_call_update` | `tool-use` / `tool-result` (dedup'd on repeated terminal updates) |
| edit-kind locations + diff paths | `file-edited` — **only when the call completes** (a denied edit never touched the file; verified) |
| `plan` (full replace) | `plan` → the Tasks panel (`plan_update`/`plan_removed` are unstable; ignored) |
| `session/request_permission` | `permission` with the agent's own options + a diff preview when the tool call carries one |
| `usage_update` (`used`/`size`/`cost`) | `context` (gauge) + `result` (window, USD cost) |
| `available_commands_update` | `init` re-emit → slash-command completion |
| `current_mode_update` / `session/set_mode` | `mode` (only ids that are zym `AgentMode`s map; below) |
| `session_info_update.title` | `session-name` (display-only, never persisted) |
| `session/cancel` (notify) | ← `interrupt()` (a pending permission resolves `cancelled`, per spec) |
| `fs/read_text_file` / `fs/write_text_file` | ← served from the injected `AcpFsHost` (the window's Document registry; below) |
| `terminal/create` / `output` / `wait_for_exit` / `kill` / `release` | ← zym-owned command execution (`acp/terminals.ts`; live terminals wear the monitor surface — below) |
| `user_message_chunk`, `config_option_update` | known; ignored (history replay / config options not wired) |
| anything else | an `unhandled` raw-JSON row — never silently dropped |

## Permissions & modes (verified against claude-agent-acp)

- The permission card renders the **agent's own options** (`allow_once` /
  `allow_always` / `reject_once` / `reject_always` hints; the decision returns
  the chosen `optionId`). An edit's proposed change previews as a diff (the
  request's `toolCall.content` diff → `diffBlock`).
- **Ask-first is forced at handshake:** the Claude Code adapter defaults its
  session mode to `acceptEdits` and writes files without ever requesting
  permission. When the agent advertises a mode with id `default`, zym switches
  to it right after session setup, so approvals are always exercised.
- `setPermissionMode` (the footer dropdown / `shift-tab`) only maps when the
  agent advertises a mode whose id *is* a zym `AgentMode` (the Claude adapter's
  are; Gemini's `ask`/`architect`/`code` are not — the dropdown is inert there,
  by design, until modes are surfaced generically).

## Configuration

- `agent.profiles` — named ACP agents, each `{ "name", "command" }`; the
  launcher's agent dropdown lists them alongside `claude-tui` (resolution in
  `agents/profiles.ts`). Defaults offer gemini and the claude adapter.
- `agent.implementation: "acp"` — make `agent:new` default to the leading ACP
  profile (or `ZYM_AGENT=acp zym` per-launch).
- `agent.acp.command` — legacy single argv, superseded by profiles; when set
  explicitly it surfaces as the *first* ACP profile (named after its binary,
  deduped against identical profiles). The `ZYM_ACP_COMMAND` env var
  (whitespace-split) does the same with higher precedence, for one launch.

The launcher's model / permission-mode / effort dropdowns are pass-through
`default` sentinels for this kind — those knobs are the agent's own, negotiated
per session (ACP session modes / config options).

## Implemented

- **Subagents** — Task tool calls open a captured transcript (drill-down page,
  robot count button); children arrive stamped `_meta.claudeCode.parentToolUseId`
  and are kept out of the main thread. (The adapter drops subagent *prose*;
  pages show the tool sequence + final answer.)
- **Input buffering** — the adapter streams `tool_call` before `rawInput` has
  finished streaming (verified: `{}` then a refine update); the row is emitted
  once the input is usable, execution starts, a permission request lands, or
  the result arrives — whichever comes first.
- **Terminal capability** — full client-side `terminal/*`
  (`acp/terminals.ts`): the agent runs commands *inside zym* as detached child
  processes with in-memory output (head-truncated at UTF-8 boundaries per
  `outputByteLimit`), killed as a process group. Every live terminal shows in
  the agent header's running-terminals panel (kill button) with a
  (near-)live-output inspect page — the revived monitors UX, via the session's
  `getMonitor`/`onMonitorUpdate`/`stopTask` mapping. A terminal embedded in a
  tool call's content (`{type:'terminal'}`) backs that row's result on
  completion. Gemini CLI's shell tool rides this; the claude adapter doesn't
  call `terminal/*` yet (verified 0.55.0) and keeps using the buffered `_meta`
  channel below.
- **Terminal channel (`_meta`)** — `clientCapabilities._meta.terminal_output`
  is advertised; command output + exit code arrive via `_meta.terminal_*`
  (codex-acp-compatible) and feed the row result.
- **Questions** — `elicitation/create` (form mode) parses into the interactive
  card (enum options, descriptions via `_meta`, per-question "Other" custom
  fields); non-form / free-form-only elicitations are declined.
- **Resume / serialize / branch** — `session/load` replays history over the
  wire (rows render statically between `onReplay` markers; the resume divider
  lands after the restored rows); `session/fork` backs branch and
  restart-of-live; `_meta.claudeCode.options.resume` is the context-only
  fallback for agents without `loadSession`. Agents serialize argv + session
  id and restore with their *saved* argv.
- **zymBridge** — `session/new.mcpServers` carries the bundled bridge
  (`set_worktree` / `set_actions` for any ACP agent), injected via
  `acp/bridge.ts` (the Gio watcher) so `AcpSession` stays drivable from plain
  node.
- **fs capability** — `fs/read_text_file` / `fs/write_text_file` are served
  from the window's Document registry (`acp/documentFs.ts`, injected by
  `AgentController` as an `AcpFsHost` — same pattern as the bridge): reads
  return the **live buffer** of an open document (unsaved edits included, with
  the protocol's 1-based `line`/`limit` window applied in `AcpSession`), writes
  land on disk then reload an open document in place through the silent-reload
  path (caret kept, LSP re-synced, no watcher re-fire) — an agent write over a
  dirty buffer clobbers it by design, since the agent based its write on the
  buffer state it read through this same capability. Gemini CLI routes its file
  tools here when the capability is advertised; the claude adapter defines the
  plumbing but doesn't call it yet (verified against claude-agent-acp 0.55.0).
- **Modes** — the footer dropdown is fed by the agent's advertised modes
  (`getModeState`); ask-first is forced at session setup.
- **Auth** — an `auth_required` handshake failure renders a login hint naming
  the agent's auth methods.

## Limitations / planned

- [ ] Streamed tool output into live *rows* (the row fills once, at result
      time; live output is on the monitor inspect page meanwhile).
- [ ] Session config options (`config_option_update`), `session/list`
      discovery, and the ACP registry (agent profiles) — later.
- [ ] `authenticate` flow (in-app login) — today the hint says to log in via
      the agent's own CLI.

## Validation

Unit tests cover the fs capability's editor side (`acp/documentFs.test.ts`:
buffer-over-disk reads, in-place writes, the `line`/`limit` window) and the
terminal registry (`acp/terminals.test.ts`: output capture, byte-limit
truncation, kill/release, spawn failures). The
session itself was validated end-to-end against the real
Claude Code ACP adapter: streamed turns; subagent capture with drill-down
data; the whitelisted-command terminal round-trip; AskUserQuestion →
elicitation → answer; permission deny; mode forcing (the adapter defaults to
`acceptEdits`!); session titles; and a full dispose → `session/load` resume
whose follow-up question proved the restored context. The spike lives out of
tree; re-run by driving `AcpSession` directly under plain node (the module
chain is runtime-pure — `agents/types.ts` imports Gtk type-only for exactly
this reason).
