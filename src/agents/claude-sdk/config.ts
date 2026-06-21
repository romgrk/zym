/*
 * Launch options for the `claude-sdk` kind (the headless, natively-rendered
 * conversation). See `agents/configs.ts` for how these are gathered onto the kind
 * registry, and `agents/claudeOptions.ts` for the shared Claude model/permission
 * lists.
 */
import type { AgentLaunchOptions } from '../configs.ts';
import {
  CLAUDE_MODELS,
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_PERMISSION_MODES,
  CLAUDE_DEFAULT_PERMISSION_MODE,
  buildClaudeCommand,
} from '../claudeOptions.ts';

export const claudeSdkLaunchOptions: AgentLaunchOptions = {
  label: 'native',
  models: CLAUDE_MODELS,
  defaultModel: CLAUDE_DEFAULT_MODEL,
  permissionModes: CLAUDE_PERMISSION_MODES,
  defaultPermissionMode: CLAUDE_DEFAULT_PERMISSION_MODE,
  buildCommand: buildClaudeCommand,
};
