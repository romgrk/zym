# Agent: acp (Agent Client Protocol)

The `acp` kind runs any [Agent Client Protocol](https://agentclientprotocol.com)
agent in the native conversation view (`AgentConversation`). The **default
profiles** are **Codex** (`npx -y @agentclientprotocol/codex-acp`) and the
**Claude Code** adapter (`@agentclientprotocol/claude-agent-acp`); Google
Antigravity (`bunx antigravity-acp`, wrapping the `agy` CLI) is still
configurable but dropped from the defaults — its adapter honors almost none of
zym's client capabilities (see the Antigravity note and the bridge caveat
below). ACP is "LSP for coding agents": the client (zym) spawns the agent as a
subprocess and speaks JSON-RPC 2.0 over stdio (protocol version 1). It replaced
the former `claude-sdk` kind (headless `claude -p` stream-json,
reverse-engineered): the official claude-agent-acp adapter provides the same
claude features over the open protocol.

**Codex (default, 2026-07-07):** the `@agentclientprotocol/codex-acp` adapter
(the one Zed ships) is a well-behaved ACP citizen — unlike antigravity it
**forwards client-provided `mcpServers`** (so the zym bridge's `set_worktree` /
`set_actions` reach it), serves the ACP **fs** and **terminal** capabilities,
and raises real **`session/request_permission`** cards. It advertises native
session modes `read-only` / `agent` (its sandboxed default — asks before
escaping the sandbox) / `agent-full-access`, switched over `session/set_mode`;
model + reasoning-effort + sandbox ride the generic config-option path. It has
no `default` mode id, so zym's ask-first force (below) is a no-op for it — the
sandboxed `agent` default is already ask-first, not a silent bypass like the
claude adapter's `acceptEdits`. (Not yet driven end-to-end against zym — the
capability claims are the adapter's; a QA pass on the bridge + permission flow
is pending.)

**Gemini → Antigravity (2026-07-06):** the free-tier Gemini CLI (`gemini --acp`)
stopped working — Google's backend now rejects the old client
(`IneligibleTierError: … migrate to the Antigravity suite`) and moved individuals
to **Antigravity** (`agy` CLI). `agy` doesn't speak ACP itself, so the default
profile now points at the community **`antigravity-acp`** adapter (bin
`agy-acp` / `antigravity-acp`; also used by the OpenAB harness, so it's the
de-facto Antigravity ACP bridge). Caveats: it needs **Bun** installed and a
one-time `agy` login; it spawns `agy -p <prompt>` per turn and streams by polling
agy's SQLite conversation DB (so no interactive per-edit permission cards — modes
are Standard / Plan / Skip-Permissions, below); `agy` is auto-downloaded from
GitHub (`google-antigravity/antigravity-cli`) or `$AGY_BIN`.

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

**Error handling:** every *outbound* request goes through `AcpSession.request()`,
which returns a `Result<T>` (`core/Result.ts` — the same convention `git.ts` uses)
instead of a rejecting promise, so each call site must branch on `isErr()`; it
also centralizes the "connection gone" guard. `failHandshake` is the single setup
failure handler (auth-required → login hint, else generic). A rejected
`set_mode` / `set_config_option` is *surfaced and reverted*, never swallowed (see
below). *Inbound* handlers (`fs/*`, `terminal/*`) still `throw RequestError` — the
SDK's contract converts a throw into the RPC error response, so Result doesn't
apply there.

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
| `session/new` `configOptions` + `config_option_update` + set-response | `config-options` → the model-menu popover's generic option controls (model / effort / …); a `mode`-category option is **promoted to the mode channel** when the agent has no native modes (antigravity), else dropped (rides the mode channel above) |
| `session_info_update.title` | `topic` (evolving; the sidebar-header subtitle, never persisted — seeds the stable name once) |
| `session/cancel` (notify) | ← `interrupt()` (a pending permission resolves `cancelled`, per spec) |
| `fs/read_text_file` / `fs/write_text_file` | ← served from the injected `AcpFsHost` (the window's Document registry; below) |
| `terminal/create` / `output` / `wait_for_exit` / `kill` / `release` | ← zym-owned command execution (`acp/terminals.ts`; live terminals wear the monitor surface — below) |
| `user_message_chunk` | known; ignored (history replay renders these) |
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
  agent advertises a mode whose id *is* a zym `AgentMode`. The Claude adapter's
  ids (`default`/`acceptEdits`/`plan`/`bypassPermissions`/`auto`/`dontAsk`) all
  are. Antigravity's `antigravity-acp` exposes `default` (Standard) / `plan` /
  `bypassPermissions` — all zym `AgentMode`s, so they map to the footer indicator.
  (The dead Gemini CLI advertised `default`/`autoEdit`/`yolo`/`plan` as native ACP
  modes; only `default`/`plan` were zym `AgentMode`s.)
- **Modes via the mode channel vs. a `mode` config option.** Two wire shapes reach
  the same footer control (`getModeState`):
  - **Native ACP modes** (`session/new.modes` + `current_mode_update`, switched
    over `session/set_mode`) — the Claude adapter, the old Gemini CLI.
  - **A `mode`-category *config option*** — Antigravity's `antigravity-acp`
    advertises **no** native modes and no `session/set_mode`; it carries
    Standard/Plan/Skip-Permissions as a `select` config option with `category:
    "mode"`. When an agent has no native modes, `applyConfigOptions` **promotes**
    that option into the mode channel (`availableModes` + `modeConfigOption`), and
    `requestSetMode` routes the switch through `session/set_config_option` instead
    of `session/set_mode` (folding the returned full option set back in). Agents
    with real ACP modes still own the channel — their `mode` config option is
    dropped as before.
- **A rejected mode switch is surfaced, not swallowed** (`requestSetMode`): the
  switch is applied optimistically, but if the agent rejects it the footer reverts
  and an error row explains why. (Historic live case: the Gemini CLI refused its
  *privileged* modes in an untrusted folder while zym optimistically showed the
  mode active, so it kept prompting under a footer claiming `yolo`.)
- **Config options** (`getConfigOptions` / `setConfigOption`) are the agent's
  *other* per-session knobs — ACP `configOptions`, a generic `select`/`boolean`
  system distinct from modes. The client opts in via `clientCapabilities.session.
  configOptions`; the agent returns the full set on `session/new` and re-sends the
  full set on every `session/set_config_option` response and `config_option_update`
  (so the footer rebuilds wholesale — options are interdependent: on the claude
  adapter, choosing `model: sonnet` drops the `fast` toggle). The `mode` category
  is filtered out of `getConfigOptions` (it rides the mode channel — either native
  or promoted, above). Verified against claude-agent-acp: it advertises `mode` /
  `model` / `effort` / `fast`. Antigravity advertises `mode` + `model` (models
  discovered by `agy` per session).

## Configuration

- `agent.profiles` — named ACP agents, each `{ "name", "command" }`; the
  launcher's agent dropdown lists them alongside `claude-tui` (resolution in
  `agents/profiles.ts`). Defaults offer **codex** (`npx -y
  @agentclientprotocol/codex-acp`) and the **claude adapter**; antigravity
  (`bunx antigravity-acp`) is still recognized (its seed modes fill in) when a
  user configures it, but is no longer a default.
- **Per-profile launch options** — a profile entry may carry `models` /
  `permissionModes` / `efforts` lists (`{ "value", "label"?, "args"? }` or a
  bare string); the launcher shows them for that profile and appends the
  chosen options' `args` to the argv. A configured list on the entry always
  wins over the discovered/seeded options below — a user who wants a
  restart-surviving mode configures the argv explicitly (`{ "value": "yolo",
  "args": ["--approval-mode", "yolo"] }`). Protocol-applied selections don't
  survive a restart — argv-encoded ones do (argv is what serializes).
  `configOptionLabels` is an id→label map for display-only shortening of
  advertised ACP options; the built-in Codex profile maps `reasoning_effort` to
  `effort`.
- **Discovered options + the cache** (`agents/acp/optionsCache.ts`) — the
  launcher can't ask an unspawned agent what it offers, so zym **remembers** what
  each agent advertised last run, keyed by argv, at
  `$XDG_STATE_HOME/zym/acp-options.json`. `AcpSession` writes it on every
  handshake and live config change; `agents/profiles.ts` (`importCachedOptions`)
  seeds a profile from it — advertised **modes** fill the permission dropdown,
  `select` **config options** (model / effort / …) become their own launcher
  dropdowns, applied at launch via `session/set_config_option`. Case-only label
  duplicates fold into the corresponding fixed launcher control (or replace a
  pass-through-only fixed placeholder). Protocol ids remain unchanged. Precedence:
  configured `agent.profiles` list **>** cache **>** the hardcoded first-launch
  seed (`importKnownAgentOptions` — antigravity's `default`/`plan`/
  `bypassPermissions`, the claude adapter's modes) **>** bare `default`. A
  brand-new agent shows the seed (or nothing) until its first session fills the
  cache in. **The claude model list is no longer hardcoded** — the adapter
  advertises `model` (and `effort`, `fast`) as config options, so it rides this
  path; the old `_meta.claudeCode.options.model` application remains only as a
  fallback for adapters that don't advertise a `model` config option.
  Antigravity's seed modes carry empty `args` (protocol-applied via the promoted
  `mode` config option, above — not argv), and its models are left to discovery.
- `agent.implementation: "acp"` — make `agent:new` default to the leading ACP
  profile (or `ZYM_AGENT=acp zym` per-launch).
- `agent.acp.command` — legacy single argv, superseded by profiles; when set
  explicitly it surfaces as the *first* ACP profile (named after its binary,
  deduped against identical profiles). The `ZYM_ACP_COMMAND` env var
  (whitespace-split) does the same with higher precedence, for one launch.

The launcher's *fixed* model / permission-mode / effort dropdowns hold only the
pass-through `default` for this kind unless a profile configures/discovers real
choices; a fixed slot with just `default` is hidden. The agent's own knobs surface
instead through the permission dropdown (session modes) and the cache-seeded
config-option dropdowns (model / effort / …), negotiated per session.

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
  completion. An ACP agent that runs its shell through the client rides this (the
  retired Gemini CLI did); the claude adapter doesn't call `terminal/*` yet
  (verified 0.55.0) and keeps using the buffered `_meta` channel below.
  **Antigravity's `antigravity-acp` does *not* use it** — `agy` runs shell
  directly on disk (rooted via `--add-dir`), so no monitor rows for it.
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
  id + the **stable display name** + the **session mode** and restore with their
  *saved* argv. The name
  (pinned rename / auto-name / topic seed — `_displayName ?? _sessionName`, never the
  transient auto-naming placeholder) is restored as the display title (`title` option →
  `_displayName`) so a resumed conversation keeps the name the user saw instead of
  reverting to the kind default; the evolving *topic* (the subtitle) stays unpersisted and
  re-emits from the agent (it no longer re-seeds the name, since one is already set).
  The **session mode** (`getModeState().currentId`, e.g. `agent-full-access`) is
  captured into the serialized state and threaded back as the launcher's
  `permissionMode` on restore / `agent:restart` / `agent:branch`, so the ask-first
  force re-applies it — protocol-applied modes have empty argv, so without this a
  resumed agent silently reverts to its ask-first default and starts prompting again.
  (The claude-tui kind needs none of this: its mode rides `--permission-mode` in the
  argv, which the saved `command` already carries.)
- **zymBridge** — `session/new.mcpServers` carries the bundled bridge
  (`set_worktree` / `set_actions`), injected via `acp/bridge.ts` (the Gio
  watcher) so `AcpSession` stays drivable from plain node. **It reaches an agent
  only if that agent's adapter forwards client-provided `mcpServers`** — codex
  (`codex-acp`) and the claude adapter do; **Antigravity's `antigravity-acp`
  drops the field entirely** (it shells out to `agy -p`, and `agy` has no
  client-MCP injection path — only its own on-disk `mcp_config.json`), so
  `set_worktree` / `set_actions` never appear to it. Same story for the other
  client capabilities antigravity ignores (fs / terminal, noted above).
- **fs capability** — `fs/read_text_file` / `fs/write_text_file` are served
  from the window's Document registry (`acp/documentFs.ts`, injected by
  `AgentController` as an `AcpFsHost` — same pattern as the bridge): reads
  return the **live buffer** of an open document (unsaved edits included, with
  the protocol's 1-based `line`/`limit` window applied in `AcpSession`), writes
  land on disk then reload an open document in place through the silent-reload
  path (caret kept, LSP re-synced, no watcher re-fire) — an agent write over a
  dirty buffer clobbers it by design, since the agent based its write on the
  buffer state it read through this same capability. An agent that routes file
  tools through the client uses this when advertised (the retired Gemini CLI did);
  the claude adapter defines the plumbing but doesn't call it yet (verified against
  claude-agent-acp 0.55.0), and **Antigravity's `antigravity-acp` reads/writes
  disk directly through `agy`** (so unsaved-buffer reads / in-place writes don't
  apply to it — its edits land on disk and baselines fall back to the git-HEAD
  path).
- **Modes** — the footer dropdown is fed by the agent's advertised modes
  (`getModeState`); ask-first is forced at session setup.
- **Config options** — a control per advertised `configOption` (model / effort /
  … via `getConfigOptions` / `setConfigOption`) lives in the **model-menu popover**
  (`ModelMenu` / `ModelPopover`, the footer's model/context gauge), above the
  token/cost breakdown — the `mode` dropdown stays inline in the footer, the other
  per-session knobs live here so the footer isn't crowded. The gauge button shows a
  muted "…" placeholder (no ring) until the first usage lands, then the "123k" count
  + ring. What's advertised is cached per-agent and seeds the *next* launcher (see the cache under
  Configuration). Verified end-to-end against claude-agent-acp: launch from the
  cache, live-switch model/effort, cache round-trip.
- **Auth** — an `auth_required` handshake failure renders a login hint naming
  the agent's auth methods.
- **First-touch baselines** — the OLD side of the Agent Changes review diff
  (`getBaseline`): an edit-kind `tool_call` snapshots the file *at first
  sighting* (which precedes execution), read through the fs host so unsaved
  user edits aren't attributed to the agent. Skipped during history replay
  (resumed sessions fall back to the git HEAD blob). Note the adapter's diff
  payloads are hunk *snippets* (`old_string`/structuredPatch), not full files —
  which is why the baseline is a snapshot, not the diff's `oldText`.

## Limitations / planned

- [ ] Streamed tool output into live *rows* (the row fills once, at result
      time; live output is on the monitor inspect page meanwhile).
- [x] Session config options — wired (`configOptions` / `config_option_update` /
      `session/set_config_option`), cached per agent to seed the launcher.
- [ ] `session/list` discovery and the ACP registry (agent profiles) — later.
- [ ] Boolean config options in the *launcher* (live footer only for now — they're
      interdependent and the spec marks them unstable).
- [ ] `authenticate` flow (in-app login) — today the hint says to log in via
      the agent's own CLI.

## Validation

Unit tests cover the fs capability's editor side (`acp/documentFs.test.ts`:
buffer-over-disk reads, in-place writes, the `line`/`limit` window), the
terminal registry (`acp/terminals.test.ts`: output capture, byte-limit
truncation, kill/release, spawn failures), baseline capture
(`acp/baselines.test.ts`: first-touch wins, created files, fs-host routing,
replay guard), the options cache (`acp/optionsCache.test.ts`: argv-keyed
round-trip, corrupt/missing → no cache), and cache-seeded profiles
(`profiles.test.ts`: modes → permission, `select` config options →
configOptions, configured-wins). The
session itself was validated end-to-end against the real
Claude Code ACP adapter: streamed turns; subagent capture with drill-down
data; the whitelisted-command terminal round-trip; AskUserQuestion →
elicitation → answer; permission deny; mode forcing (the adapter defaults to
`acceptEdits`!); session titles; a full dispose → `session/load` resume whose
follow-up question proved the restored context; and the config-option path
(discover `model`/`effort`/`fast`, apply a launch choice via
`session/set_config_option`, live-switch, cache round-trip). The spike lives out
of tree; re-run by driving `AcpSession` directly under plain node (the module
chain is runtime-pure — `agents/types.ts` imports Gtk type-only for exactly
this reason).
