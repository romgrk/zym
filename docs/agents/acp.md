# Agent: acp (Agent Client Protocol)

The `acp` kind runs any [Agent Client Protocol](https://agentclientprotocol.com)
agent — Gemini CLI natively (`gemini --acp`), Claude Code and Codex via their
ACP adapters — inside the same native conversation view the `claude-sdk` kind
uses. ACP is "LSP for coding agents": the client (zym) spawns the agent as a
subprocess and speaks JSON-RPC 2.0 over stdio (protocol version 1).

## The seam: `ConversationSession`

`AgentConversation` (the native transcript UI) is typed against
`src/agents/session.ts:ConversationSession` — the tool-agnostic session surface
(status, granular transcript events, permission requests, metadata) extracted
from `SdkSession`, which remains its reference implementation. A kind supplies
its session via `AgentConversationOptions.createSession`; claude-only
affordances degrade explicitly:

- `resume`/transcript replay, `/rename` persistence, and launch auto-naming are
  gated on the `claude-sdk` kind (`AgentConversation.kind` / the narrowed `sdk`
  handle);
- optional capabilities (`onQuestion`, `onPlan`, `onFileEdited`,
  `onSessionName`) are wired with `?.` — a session that lacks one simply never
  fires it;
- `getSubagent`/`getMonitor` are required but may always return `undefined`
  (the views only act on ids the session itself surfaced).

## Architecture

```
spawn agent argv (agent.acp.command)            src/agents/acp/AcpSession.ts
  stdio ⇄ ndJsonStream ⇄ @agentclientprotocol/sdk client()
        │  session/update, session/request_permission   (agent → zym)
        │  initialize, session/new, session/prompt, session/cancel (zym → agent)
AcpSession (protocol → ConversationSession domain mapping)
        │  same events SdkSession emits
AgentConversation (unchanged rendering)
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
  to it right after `session/new` (the analog of claude-sdk's
  `--permission-mode default`).
- `setPermissionMode` (the footer dropdown / `shift-tab`) only maps when the
  agent advertises a mode whose id *is* a zym `AgentMode` (the Claude adapter's
  are; Gemini's `ask`/`architect`/`code` are not — the dropdown is inert there,
  by design, until modes are surfaced generically).

## Configuration

- `agent.implementation: "acp"` — make `agent:new` launch this kind (or
  `ZYM_AGENT=acp zym` per-launch; the launcher's kind dropdown always offers it).
- `agent.acp.command` — the agent argv, default `["gemini", "--acp"]`. E.g.
  `["npx", "@agentclientprotocol/claude-agent-acp"]` for Claude Code. The
  `ZYM_ACP_COMMAND` env var (whitespace-split) overrides it for one launch.

The launcher's model / permission-mode / effort dropdowns are pass-through
`default` sentinels for this kind — those knobs are the agent's own, negotiated
per session (ACP session modes / config options).

## Limitations / planned

- [ ] **fs capability** — advertise `fs.readTextFile`/`writeTextFile` and serve
      them from the Document registry, so agents see unsaved buffer contents
      (an integration the claude kinds don't have).
- [ ] **terminal capability** — back `terminal/*` with the process runner and
      render like monitors.
- [ ] **Resume** — `session/load` (gated on the agent's `loadSession`
      capability) replays history as `session/update` notifications;
      `serialize()` returns null until then (no session persistence), and
      restart/branch treat acp as fresh-launch/unsupported
      (`AgentController.agentKindOf`).
- [ ] **zymBridge MCP** — pass the bridge server via `session/new.mcpServers`
      so `set_worktree`/`set_actions` work for any ACP agent; until then the
      launcher's worktree flows (`agent:new-worktree` etc.) instruct a tool the
      agent doesn't have — use the default flow with acp agents.
- [ ] **Auth flows** — `authMethods` / the `authenticate` method aren't wired;
      an agent that requires login must be authenticated from its own CLI first
      (e.g. `gemini` once, interactively).
- [ ] Session config options (`config_option_update`), `session/list`
      discovery, and the ACP registry (agent profiles) — later.

## Validation

No unit tests yet — the session was validated end-to-end against the real
Claude Code ACP adapter (handshake, streamed turns, tool calls with results,
permission request → deny round-trip, mode forcing, usage/cost, session title,
interrupt-free dispose). The spike lives out of tree; re-run by driving
`AcpSession` directly under plain node (the module chain is runtime-pure —
`agents/types.ts` imports Gtk type-only for exactly this reason).
