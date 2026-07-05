/*
 * Launch options for the `acp` kind (an Agent Client Protocol agent rendered in
 * the native conversation). Unlike the claude kinds, model / permission-mode /
 * effort are the *agent's* concern, negotiated per session (ACP session modes /
 * config options) — the launcher offers only the pass-through `default` for each.
 * The argv comes from the agent *profiles* (`agent.profiles`; see
 * `agents/profiles.ts`) — the launcher passes the picked profile's command, so
 * `acpCommand()` only backs the launches that don't go through it.
 */
import type { AgentLaunchOptions, LaunchOption } from '../configs.ts';
import { listAgentProfiles } from '../profiles.ts';

const PASS_THROUGH: LaunchOption[] = [{ value: 'default', label: 'default', detail: 'agent default' }];

/** The default ACP agent argv — the leading ACP profile's (which already folds
 *  in the `ZYM_ACP_COMMAND` env override and a legacy explicit
 *  `agent.acp.command`; see `agents/profiles.ts`). Backs launches that skip the
 *  launcher's profile picker (a picker "start new" with
 *  `agent.implementation: "acp"`). */
export function acpCommand(): string[] {
  const first = listAgentProfiles().find((p) => p.kind === 'acp')?.command;
  return first ?? ['gemini', '--acp'];
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
