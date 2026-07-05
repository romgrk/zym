/*
 * agents/profiles.ts — named launch targets for the launcher's "agent" control.
 *
 * A profile is what the user picks when starting an agent: the terminal kind
 * (`claude-tui`, whose argv is built from the model/permission/effort
 * selections) or one named ACP agent from `agent.profiles` (name + argv), so
 * gemini / the claude adapter / codex sit side by side in the dropdown instead
 * of hiding behind one global `agent.acp.command`.
 *
 * Pre-profiles setups keep working: an explicitly-set `agent.acp.command` (or
 * the one-shot `ZYM_ACP_COMMAND` env override) surfaces as the *first* ACP
 * profile — named after its binary — unless a configured profile already
 * carries the same argv. This module only resolves the list; construction
 * stays in `configs.ts` (`AGENT_CONFIGS[kind].create`).
 */
import { zym } from '../zym.ts';
import { claudeTuiLaunchOptions } from './claude-tui/config.ts';
import type { AgentKind } from './configs.ts';

export interface AgentProfile {
  /** Dropdown value: `claude-tui`, or `acp:<name>` for an ACP profile. */
  id: string;
  /** Shown in the launcher's agent dropdown. */
  label: string;
  kind: AgentKind;
  /** The ACP agent argv (acp profiles only); `claude-tui` builds its argv from
   *  the launcher's model/permission/effort selections instead. */
  command?: string[];
}

interface AcpProfileEntry {
  name: string;
  command: string[];
}

function isArgv(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((t) => typeof t === 'string' && t.length > 0);
}

/** Parse `agent.profiles` — an array of `{ name, command }` — skipping entries
 *  that don't fit (config files are hand-written; one typo'd entry shouldn't
 *  take the whole picker down). */
function configuredAcpProfiles(): AcpProfileEntry[] {
  const raw = zym.config.get('agent.profiles');
  if (!Array.isArray(raw)) return [];
  const entries: AcpProfileEntry[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue;
    const { name, command } = item as { name?: unknown; command?: unknown };
    if (typeof name !== 'string' || name.length === 0 || !isArgv(command)) continue;
    entries.push({ name, command });
  }
  return entries;
}

/** A display name for an ad-hoc argv: the first token that isn't a package
 *  runner or a flag, basename'd (`npx -y @scope/claude-agent-acp` →
 *  `claude-agent-acp`; `gemini --acp` → `gemini`). */
export function profileNameFor(command: string[]): string {
  const runners = new Set(['npx', 'pnpx', 'bunx', 'pnpm', 'node']);
  const token = command.find((t) => !runners.has(t) && !t.startsWith('-')) ?? command[0];
  return token.split('/').pop() || token;
}

/** The `agent.acp.command` / `ZYM_ACP_COMMAND` escape hatch, when in effect:
 *  the env var wins (a one-shot override, mirroring `ZYM_AGENT`), else an
 *  explicitly-set config value; `null` when neither is set. */
function legacyAcpCommand(): string[] | null {
  const env = process.env.ZYM_ACP_COMMAND?.trim();
  if (env) return env.split(/\s+/);
  if (!zym.config.has('agent.acp.command')) return null;
  const value = zym.config.get('agent.acp.command');
  return isArgv(value) ? [...value] : null;
}

const sameArgv = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

/** Every launchable profile, in dropdown order: the terminal kind first, then
 *  the ACP profiles (a legacy `agent.acp.command`, if set, leads them). */
export function listAgentProfiles(): AgentProfile[] {
  const acp = configuredAcpProfiles();
  const legacy = legacyAcpCommand();
  if (legacy && !acp.some((p) => sameArgv(p.command, legacy))) {
    acp.unshift({ name: profileNameFor(legacy), command: legacy });
  }
  return [
    { id: 'claude-tui', label: claudeTuiLaunchOptions.label, kind: 'claude-tui' },
    ...acp.map((p): AgentProfile => ({ id: `acp:${p.name}`, label: p.name, kind: 'acp', command: p.command })),
  ];
}

/** The profile the launcher pre-selects for `kind` — its first entry of that
 *  kind (so `agent.implementation: "acp"` lands on the leading ACP profile). */
export function defaultProfileFor(kind: AgentKind, profiles: AgentProfile[]): AgentProfile {
  return profiles.find((p) => p.kind === kind) ?? profiles[0];
}
