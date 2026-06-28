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
 * (Agent *profiles* — user-configurable command/model/prompt per named agent —
 * are a later feature; this file is the minimal kind registry it will grow into.)
 */
import { AgentTerminal } from '../ui/AgentTerminal.ts';
import { AgentConversation } from '../ui/AgentConversation.ts';
import { createClaudeTuiDriver } from './claude-tui/session.ts';
import { claudeTuiLaunchOptions } from './claude-tui/config.ts';
import { claudeSdkLaunchOptions } from './claude-sdk/config.ts';
import type { Agent, AgentResume } from './types.ts';

export type AgentKind = 'claude-tui' | 'claude-sdk';

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
  /** Working directory the agent (and its workbench) is rooted at. */
  cwd: string;
  /** Base argv (default `['claude']`). */
  command?: string[];
  /** An initial prompt to launch with — what the agent is told (may include zym's
   *  editor instructions, e.g. worktree setup). */
  prompt?: string;
  /** The user's own prompt, free of zym's editor instructions — context for
   *  auto-naming (claude-sdk). Undefined when the user typed nothing. */
  userPrompt?: string;
  /** Resume a past conversation. Both kinds honour it: claude-tui via `--resume`,
   *  claude-sdk via `--resume` plus rebuilding the transcript from disk. */
  resume?: AgentResume;
  /** Initial title override. */
  title?: string;
  /** Open a file the agent touched (sdk conversation rows; tui ignores it). */
  onOpenFile?: (path: string) => void;
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
  'claude-sdk': {
    kind: 'claude-sdk',
    options: claudeSdkLaunchOptions,
    create: (l) => new AgentConversation({ cwd: l.cwd, command: l.command, prompt: l.prompt, userPrompt: l.userPrompt, resume: l.resume, onOpenFile: l.onOpenFile }),
  },
};

/** The agent kinds as launcher options (value = kind, label = its display name). */
export function listAgentKinds(): LaunchOption[] {
  return (Object.keys(AGENT_CONFIGS) as AgentKind[]).map((kind) => ({
    value: kind,
    label: AGENT_CONFIGS[kind].options.label,
  }));
}

/** Pick a kind from the `agent.implementation` config value (default claude-tui,
 *  the Vte terminal agent; set `agent.implementation` to `claude-sdk` for the
 *  headless, natively-rendered conversation).
 *
 *  The `ZYM_AGENT` env var overrides config when set (to `claude-tui` or
 *  `claude-sdk`), so the host can be switched per-launch without editing config —
 *  e.g. `ZYM_AGENT=claude-sdk zym`. */
export function resolveAgentKind(implementation: unknown): AgentKind {
  const value = process.env.ZYM_AGENT || implementation;
  return value === 'claude-sdk' ? 'claude-sdk' : 'claude-tui';
}
