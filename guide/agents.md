# Agents

zym hosts coding agents (such as `claude`) right inside the workbench. Each
agent gets its own *workbench* — a working directory, its own docks and tabs —
listed in the sidebar next to yours, so you can jump into an agent's world to
see what it's doing and jump back to your own.

An agent is a terminal like any other, except it runs the agent CLI instead of
a login shell and is tracked globally. When the agent process exits the pane is
*not* torn down — a "process exited" notice is printed and the agent stays
listed so you can read its final output, restart it, or close it.

The command used to launch an agent comes from the `agent.command` config key
(default `["claude"]`).

## Agent kinds

zym can host an agent two ways, chosen by the `agent.implementation` config
key or per-launch with the *agent* dropdown in the launcher:

| Kind | What it is |
| ---- | ---------- |
| `claude-tui`  | Claude Code's own terminal UI in an embedded terminal (default). |
| `acp`         | Any [Agent Client Protocol](https://agentclientprotocol.com) agent rendered as a native conversation — message bubbles, tool rows, diff previews, native permission prompts, subagent pages, plans. E.g. Codex (`["npx", "-y", "@agentclientprotocol/codex-acp"]`) or Claude Code via its adapter (`["npx", "-y", "@agentclientprotocol/claude-agent-acp"]`). |

ACP agents are configured as named **profiles** in `agent.profiles` (each
`{ "name", "command" }`); the launcher's agent dropdown lists them alongside
`claude-tui`, so Codex, the Claude adapter, etc. sit side by side.
**Codex and the Claude adapter are offered out of the box.** (A legacy
`agent.acp.command`, if set, still appears as the first profile.)

The launcher's option dropdowns follow the chosen profile. zym **remembers what
each agent advertised last time it ran** and offers it on the next launch: the
Claude adapter's permission modes, model, and reasoning effort, Codex its
sandbox/approval modes. A brand-new agent shows a small built-in set until its first
session fills these in. You can also switch these live in the agent's footer
while it runs. Any profile entry can still define its own argv-based lists:
`"models": [{ "value": "gemini-2.5-pro", "args": ["-m", "gemini-2.5-pro"] }]`
appends those args to the launch command when picked (`default` always means the
agent's own), and a configured list wins over the remembered one.

An `acp` agent must be signed in with its own CLI first (run it once in a
terminal). Resuming, branching, permission prompts, diffs, plans, questions,
and edited-file tracking all work.

## Launching and switching

| Keys          | Command |
| ------------- | ------- |
| `space a a`   | agent picker — running agents, past conversations, or start a new one. Typing a prompt and choosing **Start agent** launches a fresh agent seeded with that prompt. |
| `space a n n` | new agent in the current directory |
| `space a n w` | new agent in a **fresh git worktree** |
| `space a n e` | new agent in an existing worktree (picker) |
| `space a n .` | new agent in the current worktree |
| `space j`     | jump to a workbench — leap-style: each sidebar row shows a letter, pressing it switches there (any other key cancels) |
| `space a w`   | switch workbench — you or any agent |
| `space a l`   | focus the workbench sidebar |
| `super-,` / `super-.` | cycle through workbenches |
| `space a r`   | rename the current agent |
| `space a R`   | resume a past conversation (picker) |
| `space a b`   | branch the current agent into a forked agent |
| `space a d`   | review the current agent's changes (the Agent Changes diff) |

The worktree variants give each agent an isolated checkout, so agents can work
in parallel without stepping on your tree or each other's.

`space j` is the fastest switch: every sidebar row shows a one-letter mark and
pressing a mark's key switches to that workbench — escape or any other key
cancels, and a hidden sidebar flashes in for the duration.

## Agent status

Running agents appear in the workbench sidebar with a live status:

| Indicator | Meaning |
| --------- | ------- |
| green dot | idle / ready |
| amber dot | waiting for you (e.g. a permission prompt) |
| grey cog  | working |
| muted dot | the process has exited |

For `claude`, the status is driven by Claude Code hooks: zym launches it with a
per-session settings block whose hooks report state changes back to the
terminal. You don't need to configure anything.

With the sidebar focused (`space a l`), keys act on the selected agent:
`l` reveals its terminal, `r` restarts, `R` renames, `b` branches, `x` stops
the process, `d d` closes it, and `o` reviews its changes (the Agent Changes
diff).

Inside an agent's terminal, `ctrl-d ctrl-d` closes the agent (a single `ctrl-d`
still reaches the CLI as a normal EOF).

## Sending context to an agent

Send what you're looking at without leaving the editor — the second key picks
**s**election or **f**ile, the third picks the destination:

| Keys          | Sends |
| ------------- | ----- |
| `space a s s` | selection → current agent |
| `space a s a` | selection → pick an agent |
| `space a s n` | selection → new agent, with an editable prompt |
| `space a f f` | file path → current agent |
| `space a f a` | file path → pick an agent |
| `space a f n` | file path → new agent, with an editable prompt |

**Comment to agent:** in a file editor, `enter` in normal mode (or on a visual
selection) opens an inline comment box on that line/selection; the comment is
sent to an agent with the location attached. In diff views the same gesture
adds review comments.

## Reviewing an agent's changes

The pencil badge in the agent's header (or `space a d` anywhere, `o` on a
selected agent — the `agent:open-changes` command) opens the **Agent Changes**
tab: one continuous
diff of every file the agent edited this session, from the file's content *at
the agent's first touch* to its content now — your own uncommitted work from
before the agent ran stays out of it (`acp` agents; `claude-tui` diffs against
git HEAD instead). The new side is editable in place; `enter` on a row adds a
review comment that is sent straight back to that agent; double-click jumps to
the file. Click the pencil again to refresh with the agent's latest edits.
