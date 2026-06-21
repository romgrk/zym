/*
 * Launch options for the `claude-tui` kind (the Vte terminal agent). See
 * `agents/configs.ts` for how these are gathered onto the kind registry, and
 * `agents/claudeOptions.ts` for the shared Claude model/permission lists.
 */
import type { AgentLaunchOptions } from '../configs.ts';
import {
  CLAUDE_MODELS,
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_PERMISSION_MODES,
  CLAUDE_DEFAULT_PERMISSION_MODE,
  buildClaudeCommand,
} from '../claudeOptions.ts';

export const claudeTuiLaunchOptions: AgentLaunchOptions = {
  label: 'terminal',
  models: CLAUDE_MODELS,
  defaultModel: CLAUDE_DEFAULT_MODEL,
  permissionModes: CLAUDE_PERMISSION_MODES,
  defaultPermissionMode: CLAUDE_DEFAULT_PERMISSION_MODE,
  buildCommand: buildClaudeCommand,
};
