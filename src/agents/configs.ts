/*
 * agents/configs.ts — the hardcoded registry of agent kinds. Each `AgentConfig`
 * knows how to construct its host (an `Agent`) for a launch; `AppWindow.openAgent`
 * resolves one config (from the `agent.implementation` flag, or an explicit kind)
 * and drives the rest generically, so there is a single launch path for every
 * kind.
 *
 * This is the one place that maps a kind → its concrete UI host, so it depends on
 * `../ui/*`. The classes are referenced only inside the `create` closures (called
 * at launch time), so module evaluation stays free of an import cycle.
 *
 * (Agent *profiles* — the named launch targets the launcher's agent dropdown
 * offers, one per configured ACP agent — live in `agents/profiles.ts`; a
 * profile resolves to a kind here + an argv.)
 */
import { AgentTerminal } from '../ui/AgentTerminal.ts';
import { AgentConversation } from '../ui/AgentConversation.ts';
import { createClaudeTuiDriver } from './claude-tui/session.ts';
import { claudeTuiLaunchOptions } from './claude-tui/config.ts';
import { acpLaunchOptions, acpCommand } from './acp/config.ts';
import { AcpSession, type AcpFsHost } from './acp/AcpSession.ts';
import { createAcpBridge } from './acp/bridge.ts';
import type { Agent, AgentResume } from './types.ts';

export type AgentKind = 'claude-tui' | 'acp';

/** A selectable choice in the launcher (a model, a permission mode, a kind, …). */
export interface LaunchOption {
  /** The value applied when chosen (a model id, a `--permission-mode` value, …). */
  value: string;
  /** Short label shown in the combobox. */
  label: string;
  /** Optional muted one-liner shown beside the label. */
  detail?: string;
}

/**
 * The launch-time options a kind offers (its models, permission modes, and how it
 * turns a selection into argv). Lives in each kind's own `config.ts` so the choices
 * — which may differ per agent — stay next to the kind they belong to; gathered
 * here onto `AGENT_CONFIGS`.
 */
export interface AgentLaunchOptions {
  /** Display label for the kind itself (shown in the launcher's kind control). */
  label: string;
  models: LaunchOption[];
  defaultModel: string;
  permissionModes: LaunchOption[];
  defaultPermissionMode: string;
  /** Reasoning-effort levels (passed as `--effort`); `default` omits the flag. */
  efforts: LaunchOption[];
  defaultEffort: string;
  /** Base argv for the chosen model/permission mode/effort (e.g. `['claude','--model',…]`). */
  buildCommand(sel: { model: string; permissionMode: string; effort: string }): string[];
}

/** The per-launch parameters every kind's factory accepts. */
export interface AgentLaunch {
  /** The directory the agent *process* is spawned in — always the editor's main dir
   *  (the cwd invariant), never a worktree, so its OS cwd can't be removed out from
   *  under it and `--resume` resolves under one project dir. See docs/agents.md. */
  cwd: string;
  /** Base argv (default `['claude']`). */
  command?: string[];
  /** An initial prompt to launch with — what the agent is told (may include zym's
   *  editor instructions, e.g. worktree setup). */
  prompt?: string;
  /** The user's own prompt, free of zym's editor instructions — context for
   *  auto-naming (the acp conversation). Undefined when the user typed nothing. */
  userPrompt?: string;
  /** Resume a past conversation: claude-tui via `--resume`, acp via
   *  `session/load` / `session/fork` (see docs/agents/acp.md). */
  resume?: AgentResume;
  /** Initial title override. */
  title?: string;
  /** The launcher's model / permission-mode selections, for acp profiles whose
   *  options apply over the protocol rather than argv (`'default'`/absent =
   *  the agent's own default). claude-tui encodes both in `command`. */
  model?: string;
  permissionMode?: string;
  /** Generic ACP config-option choices (model / effort / … applied over
   *  `session/set_config_option`); value id per option id. acp only. */
  configOptions?: Record<string, string>;
  /** Open a file the agent touched (acp conversation rows; tui ignores it). */
  onOpenFile?: (path: string) => void;
  /** Editor-backed file access (the ACP `fs` capability: reads see unsaved
   *  buffers, writes land in open documents; tui ignores it). */
  fs?: AcpFsHost;
}

export interface AgentConfig {
  readonly kind: AgentKind;
  /** The kind's launch-time options (models, permission modes, argv builder). */
  readonly options: AgentLaunchOptions;
  /** Construct the host for a launch. The agent is **not** yet spawned — the
   *  caller mounts it, then calls `agent.start()`. */
  create(launch: AgentLaunch): Agent;
}

export const AGENT_CONFIGS: Record<AgentKind, AgentConfig> = {
  'claude-tui': {
    kind: 'claude-tui',
    options: claudeTuiLaunchOptions,
    create: (l) =>
      new AgentTerminal({
        cwd: l.cwd,
        command: l.command,
        prompt: l.prompt,
        resume: l.resume,
        title: l.title,
        driverFactory: createClaudeTuiDriver,
      }),
  },
  // An Agent Client Protocol agent (Gemini CLI natively; Claude Code / Codex via
  // their ACP adapters) in the same native conversation view. The argv comes from
  // the picked profile (`agent.profiles`; `acpCommand()` — the leading profile —
  // backs launches that skip the picker), resolved here so serialize/restore
  // round-trips the exact agent, not whatever the config says later; resume goes
  // over `session/load` / `session/fork` where the agent advertises them. See
  // docs/agents/acp.md.
  'acp': {
    kind: 'acp',
    options: acpLaunchOptions,
    create: (l) => {
      const command = l.command && l.command.length > 0 ? l.command : acpCommand();
      return new AgentConversation({
        cwd: l.cwd,
        command,
        prompt: l.prompt,
        userPrompt: l.userPrompt,
        resume: l.resume,
        onOpenFile: l.onOpenFile,
        createSession: (o) => new AcpSession({ cwd: o.cwd, command, resume: o.resume, bridge: createAcpBridge(), fs: l.fs, model: l.model, permissionMode: l.permissionMode, configOptions: l.configOptions }),
      });
    },
  },
};

/** Pick a kind from the `agent.implementation` config value: `acp` (an Agent
 *  Client Protocol agent, natively rendered) or anything else → `claude-tui`
 *  (the Vte terminal agent) — which also maps the retired `claude-sdk` value
 *  from older configs to a kind that can still resume its claude sessions.
 *
 *  The `ZYM_AGENT` env var overrides config when set, so the host can be
 *  switched per-launch without editing config — e.g. `ZYM_AGENT=acp zym`. */
export function resolveAgentKind(implementation: unknown): AgentKind {
  const value = process.env.ZYM_AGENT || implementation;
  return value === 'acp' ? 'acp' : 'claude-tui';
}
