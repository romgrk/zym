/*
 * Launch options for the `acp` kind (an Agent Client Protocol agent rendered in
 * the native conversation). Unlike the claude kinds, model / permission-mode /
 * effort are the *agent's* concern, negotiated per session (ACP session modes /
 * config options) — the launcher offers only the pass-through `default` for each,
 * and the argv comes from the `agent.acp.command` config (default Gemini CLI,
 * the reference native ACP agent).
 */
import { zym } from '../../zym.ts';
import type { AgentLaunchOptions, LaunchOption } from '../configs.ts';

const PASS_THROUGH: LaunchOption[] = [{ value: 'default', label: 'default', detail: 'agent default' }];

/** The configured ACP agent argv (`agent.acp.command`), e.g. `['gemini', '--acp']`
 *  or `['npx', '@agentclientprotocol/claude-agent-acp']`. The `ZYM_ACP_COMMAND`
 *  env var (whitespace-split) overrides config for a single launch, mirroring
 *  `ZYM_AGENT` — e.g. `ZYM_ACP_COMMAND='npx -y @agentclientprotocol/claude-agent-acp'`. */
export function acpCommand(): string[] {
  const env = process.env.ZYM_ACP_COMMAND?.trim();
  if (env) return env.split(/\s+/);
  const value = zym.config.get('agent.acp.command');
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')) return value;
  return ['gemini', '--acp'];
}

export const acpLaunchOptions: AgentLaunchOptions = {
  label: 'acp',
  models: PASS_THROUGH,
  defaultModel: 'default',
  permissionModes: PASS_THROUGH,
  defaultPermissionMode: 'default',
  efforts: PASS_THROUGH,
  defaultEffort: 'default',
  // Selections are all pass-through sentinels; the agent's own defaults apply.
  buildCommand: () => acpCommand(),
};
