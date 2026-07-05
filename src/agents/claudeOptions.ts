/*
 * Launch options for the claude-tui kind (models / permission modes / effort →
 * the `claude` argv), composed into its `AgentLaunchOptions` by
 * claude-tui/config.ts.
 */
import type { LaunchOption } from './configs.ts';

export const CLAUDE_MODELS: LaunchOption[] = [
  { value: 'claude-opus-4-8', label: 'opus', detail: 'most capable' },
  { value: 'claude-sonnet-4-6', label: 'sonnet', detail: 'fast, balanced' },
  { value: 'claude-fable-5', label: 'fable', detail: 'most powerful' },
];
export const CLAUDE_DEFAULT_MODEL = 'claude-opus-4-8';

// The permission modes offered at launch (passed as `--permission-mode`).
export const CLAUDE_PERMISSION_MODES: LaunchOption[] = [
  { value: 'default', label: 'default', detail: 'ask before edits' },
  { value: 'acceptEdits', label: 'acceptEdits', detail: 'auto-accept edits' },
  { value: 'plan', label: 'plan', detail: 'read-only planning' },
  { value: 'auto', label: 'auto', detail: 'auto-approve actions' },
];
export const CLAUDE_DEFAULT_PERMISSION_MODE = 'default';

// The reasoning-effort levels offered at launch (passed as `--effort`). The leading
// `default` choice is a sentinel — it leaves the flag off so the CLI uses its own
// default — distinct from the real `low…max` levels the CLI accepts.
export const CLAUDE_EFFORTS: LaunchOption[] = [
  { value: 'default', label: 'default', detail: 'tool default' },
  { value: 'low', label: 'low', detail: 'fast, scoped tasks' },
  { value: 'medium', label: 'medium', detail: 'balanced' },
  { value: 'high', label: 'high', detail: 'thorough' },
  { value: 'xhigh', label: 'xhigh', detail: 'coding / agentic' },
  { value: 'max', label: 'max', detail: 'maximum effort' },
];
export const CLAUDE_DEFAULT_EFFORT = 'default';

/** Base argv for the chosen options. `default` permission mode and effort are left
 *  implicit (the flag is omitted so the CLI applies its own default). */
export function buildClaudeCommand(sel: { model: string; permissionMode: string; effort: string }): string[] {
  const argv = ['claude', '--model', sel.model];
  if (sel.permissionMode && sel.permissionMode !== 'default') {
    argv.push('--permission-mode', sel.permissionMode);
  }
  if (sel.effort && sel.effort !== 'default') {
    argv.push('--effort', sel.effort);
  }
  return argv;
}
