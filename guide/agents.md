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
key or per-launch with the *kind* dropdown in the launcher:

| Kind | What it is |
| ---- | ---------- |
| `claude-tui`  | Claude Code's own terminal UI in an embedded terminal (default). |
| `acp`         | Any [Agent Client Protocol](https://agentclientprotocol.com) agent rendered as a native conversation — message bubbles, tool rows, diff previews, native permission prompts, subagent pages, plans. E.g. Gemini CLI (`["gemini", "--acp"]`, the default) or Claude Code via its adapter (`["npx", "@agentclientprotocol/claude-agent-acp"]`). Set the agent with the `agent.acp.command` key. |

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
| `space a w`   | switch workbench — you or any agent |
| `space a l`   | focus the workbench sidebar |
| `super-,` / `super-.` | cycle through workbenches |
| `space a r`   | rename the current agent |
| `space a R`   | resume a past conversation (picker) |
| `space a b`   | branch the current agent into a forked agent |

The worktree variants give each agent an isolated checkout, so agents can work
in parallel without stepping on your tree or each other's.

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
the process, `d d` closes it, and `o` opens the files it has edited.

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
