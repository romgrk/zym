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
import type { Agent, AgentResume } from './types.ts';

export type AgentKind = 'claude-tui' | 'claude-sdk';

/** The per-launch parameters every kind's factory accepts. */
export interface AgentLaunch {
  /** Working directory the agent (and its workbench) is rooted at. */
  cwd: string;
  /** Base argv (default `['claude']`). */
  command?: string[];
  /** An initial prompt to launch with. */
  prompt?: string;
  /** Resume a past conversation (claude-tui only; sdk ignores it for now). */
  resume?: AgentResume;
  /** Initial title override. */
  title?: string;
  /** Open a file the agent touched (sdk conversation rows; tui ignores it). */
  onOpenFile?: (path: string) => void;
}

export interface AgentConfig {
  readonly kind: AgentKind;
  /** Construct the host for a launch. The agent is **not** yet spawned — the
   *  caller mounts it, then calls `agent.start()`. */
  create(launch: AgentLaunch): Agent;
}

export const AGENT_CONFIGS: Record<AgentKind, AgentConfig> = {
  'claude-tui': {
    kind: 'claude-tui',
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
    create: (l) => new AgentConversation({ cwd: l.cwd, command: l.command, prompt: l.prompt, onOpenFile: l.onOpenFile }),
  },
};

/** Pick a kind from the `agent.implementation` config value (default claude-sdk;
 *  set `agent.implementation` to `claude-tui` for the Vte terminal agent). */
export function resolveAgentKind(implementation: unknown): AgentKind {
  return implementation === 'claude-tui' ? 'claude-tui' : 'claude-sdk';
}
