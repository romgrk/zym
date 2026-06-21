/*
 * Shared launch options for the Claude-backed agent kinds. Both `claude-tui` and
 * `claude-sdk` spawn the same `claude` CLI, so they pick from the same models /
 * permission modes and build their base argv the same way. Each kind's own
 * `config.ts` composes these into its `AgentLaunchOptions` (and could swap in its
 * own lists later, if the kinds ever diverge).
 */
import type { LaunchOption } from './configs.ts';

export const CLAUDE_MODELS: LaunchOption[] = [
  { value: 'claude-opus-4-8', label: 'opus', detail: 'most capable' },
  { value: 'claude-sonnet-4-6', label: 'sonnet', detail: 'fast, balanced' },
];
export const CLAUDE_DEFAULT_MODEL = 'claude-opus-4-8';

// The `--permission-mode` values the `claude` CLI accepts. (zym's runtime AgentMode
// also has `auto`/`dontAsk`, which aren't valid launch flags — they're omitted here.)
export const CLAUDE_PERMISSION_MODES: LaunchOption[] = [
  { value: 'default', label: 'default', detail: 'ask before edits' },
  { value: 'acceptEdits', label: 'acceptEdits', detail: 'auto-accept edits' },
  { value: 'plan', label: 'plan', detail: 'read-only planning' },
  { value: 'bypassPermissions', label: 'bypass', detail: 'skip all prompts' },
];
export const CLAUDE_DEFAULT_PERMISSION_MODE = 'default';

/** Base argv for the chosen options. `default` permission mode is left implicit. */
export function buildClaudeCommand(sel: { model: string; permissionMode: string }): string[] {
  const argv = ['claude', '--model', sel.model];
  if (sel.permissionMode && sel.permissionMode !== 'default') {
    argv.push('--permission-mode', sel.permissionMode);
  }
  return argv;
}
