/*
 * agents/profiles.ts — named launch targets for the launcher's "agent" control.
 *
 * A profile is what the user picks when starting an agent: the terminal kind
 * (`claude-tui`, whose argv is built from the model/permission/effort
 * selections) or one named ACP agent from `agent.profiles` (name + argv), so
 * antigravity / the claude adapter / codex sit side by side in the dropdown
 * instead of hiding behind one global `agent.acp.command`.
 *
 * Pre-profiles setups keep working: an explicitly-set `agent.acp.command` (or
 * the one-shot `ZYM_ACP_COMMAND` env override) surfaces as the *first* ACP
 * profile — named after its binary — unless a configured profile already
 * carries the same argv. This module only resolves the list; construction
 * stays in `configs.ts` (`AGENT_CONFIGS[kind].create`).
 */
import { zym } from '../zym.ts';
import { claudeTuiLaunchOptions } from './claude-tui/config.ts';
import { readAcpOptionsCache } from './acp/optionsCache.ts';
import type { AgentKind } from './configs.ts';

/** One launch-option choice a profile offers (a model, a permission mode, …).
 *  `args` are appended to the profile argv when chosen; an empty `args` choice
 *  changes nothing on the command line — it may instead be applied over the
 *  protocol (the claude adapter's `_meta.claudeCode.options.model`, or a
 *  `session/set_mode` after setup — see AcpSession). */
export interface ProfileLaunchOption {
  value: string;
  label: string;
  detail?: string;
  args: string[];
}

/** The leading no-op choice every profile option list carries: the agent's own
 *  default, nothing appended or sent. */
const DEFAULT_OPTION: ProfileLaunchOption = { value: 'default', label: 'default', detail: 'agent default', args: [] };

/** A generic config option the launcher offers for a profile (an ACP `select`
 *  `configOption` — model / effort / … — discovered from the cache). Applied over
 *  the protocol (`session/set_config_option`), never argv; the launcher routes the
 *  chosen value into the launch request's `configOptions`. Boolean options are
 *  left to the live footer (they're interdependent and unstable). */
export interface ProfileConfigOption {
  /** The ACP `configOption` id, sent as `configId`. */
  id: string;
  /** Human label (the option's name; the launcher's dropdown title). */
  name: string;
  /** Selectable values. */
  options: ProfileLaunchOption[];
  /** The value selected by default (the option's advertised current value). */
  default: string;
}

export interface AgentProfile {
  /** Dropdown value: `claude-tui`, or `acp:<name>` for an ACP profile. */
  id: string;
  /** Shown in the launcher's agent dropdown. */
  label: string;
  kind: AgentKind;
  /** The ACP agent argv (acp profiles only); `claude-tui` builds its argv from
   *  the launcher's model/permission/effort selections instead. */
  command?: string[];
  /** Launch-option lists the launcher shows for this profile — configured on
   *  the `agent.profiles` entry, or imported for recognized agents (below).
   *  Absent → the launcher shows the kind's pass-through `default`. */
  models?: ProfileLaunchOption[];
  permissionModes?: ProfileLaunchOption[];
  efforts?: ProfileLaunchOption[];
  /** Generic config options the agent advertised last run (cache-seeded); the
   *  launcher shows a dropdown per entry, applied over `session/set_config_option`. */
  configOptions?: ProfileConfigOption[];
}

interface AcpProfileEntry {
  name: string;
  command: string[];
  models?: ProfileLaunchOption[];
  permissionModes?: ProfileLaunchOption[];
  efforts?: ProfileLaunchOption[];
  configOptions?: ProfileConfigOption[];
}

function isArgv(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((t) => typeof t === 'string' && t.length > 0);
}

/** Parse one option list off a profile entry: entries are strings (a bare
 *  value) or `{ value, label?, detail?, args? }`. Returns undefined when the
 *  key is absent/unusable; a parsed list always leads with the `default`
 *  no-op choice (prepended if the config didn't include one). */
function parseOptionList(raw: unknown): ProfileLaunchOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const options: ProfileLaunchOption[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.length > 0) {
      options.push({ value: item, label: item, args: [] });
      continue;
    }
    if (item == null || typeof item !== 'object') continue;
    const { value, label, detail, args } = item as { value?: unknown; label?: unknown; detail?: unknown; args?: unknown };
    if (typeof value !== 'string' || value.length === 0) continue;
    options.push({
      value,
      label: typeof label === 'string' && label ? label : value,
      detail: typeof detail === 'string' ? detail : undefined,
      args: Array.isArray(args) && args.every((t) => typeof t === 'string') ? args : [],
    });
  }
  if (options.length === 0) return undefined;
  if (!options.some((o) => o.value === DEFAULT_OPTION.value)) options.unshift(DEFAULT_OPTION);
  return options;
}

/** Parse `agent.profiles` — an array of `{ name, command, models?,
 *  permissionModes?, efforts? }` — skipping entries that don't fit (config
 *  files are hand-written; one typo'd entry shouldn't take the whole picker
 *  down). */
function configuredAcpProfiles(): AcpProfileEntry[] {
  const raw = zym.config.get('agent.profiles');
  if (!Array.isArray(raw)) return [];
  const entries: AcpProfileEntry[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue;
    const { name, command, models, permissionModes, efforts } = item as Record<string, unknown>;
    if (typeof name !== 'string' || name.length === 0 || !isArgv(command)) continue;
    entries.push({
      name,
      command,
      models: parseOptionList(models),
      permissionModes: parseOptionList(permissionModes),
      efforts: parseOptionList(efforts),
    });
  }
  return entries;
}

// --- imported options for recognized agents ---------------------------------------
// "Import options for the chosen agent": when a profile's argv is an agent zym
// knows, fill the option lists it didn't configure itself, so the launcher
// offers real choices instead of the bare pass-through `default`.

/** The claude adapter (claude-agent-acp): its permission modes are advertised ACP
 *  session modes, applied via `session/set_mode` after setup (empty `args`). This
 *  is only the first-launch seed — the modes (and its model / effort / … options)
 *  are discovered from the live session and cached (see importCachedOptions), which
 *  supersedes this. Its model list is *not* hardcoded here anymore: the adapter
 *  advertises it as a `model` config option (applied via `session/set_config_option`),
 *  so it rides the generic configOptions path once the cache has seen a session. */
function importClaudeAcpOptions(entry: AcpProfileEntry): void {
  entry.permissionModes ??= [
    { ...DEFAULT_OPTION, detail: 'ask before edits' },
    { value: 'acceptEdits', label: 'acceptEdits', detail: 'auto-accept edits', args: [] },
    { value: 'plan', label: 'plan', detail: 'read-only planning', args: [] },
    { value: 'bypassPermissions', label: 'bypassPermissions', detail: 'auto-approve actions', args: [] },
  ];
}

/** Antigravity (the `antigravity-acp` / `agy-acp` adapter over Google's `agy`
 *  CLI): it exposes its modes as a `mode` *config option* (Standard `default` /
 *  `plan` / `bypassPermissions`), not native ACP modes — no `session/set_mode`.
 *  AcpSession promotes that config option into the mode channel and switches it
 *  over `session/set_config_option` (empty `args` here — protocol-applied). This
 *  is only the first-launch seed; the live modes/models are discovered and cached
 *  (importCachedOptions supersedes this). Models drift too fast to hardcode
 *  (`agy` discovers them per session). Requires Bun + a one-time `agy` login. */
function importAntigravityOptions(entry: AcpProfileEntry): void {
  entry.permissionModes ??= [
    { ...DEFAULT_OPTION, detail: 'standard mode' },
    { value: 'plan', label: 'plan', detail: 'read-only planning', args: [] },
    { value: 'bypassPermissions', label: 'bypassPermissions', detail: 'skip permission prompts', args: [] },
  ];
}

/** Codex (the `@agentclientprotocol/codex-acp` adapter over OpenAI's Codex CLI):
 *  it advertises native ACP session modes — `read-only` (planning), `agent`
 *  (its sandboxed default, which asks before escaping the sandbox) and
 *  `agent-full-access` (unsandboxed) — switched over `session/set_mode` (empty
 *  `args` — protocol-applied, like the claude adapter). Its model /
 *  reasoning-effort / sandbox knobs ride the generic config-option path,
 *  discovered per session and cached (importCachedOptions supersedes this seed).
 *  Codex advertises no `default` mode id, so the pass-through `default` choice
 *  leaves it in `agent` (sandboxed, ask-first) — there is no silent-bypass
 *  default to force away from (unlike the claude adapter's `acceptEdits`). */
function importCodexOptions(entry: AcpProfileEntry): void {
  entry.permissionModes ??= [
    { ...DEFAULT_OPTION, detail: 'agent (sandboxed)' },
    { value: 'read-only', label: 'read-only', detail: 'read-only planning', args: [] },
    { value: 'agent-full-access', label: 'agent-full-access', detail: 'unsandboxed, auto-approve', args: [] },
  ];
}

const isAntigravity = (t: string) => t === 'antigravity-acp' || t === 'agy-acp' || t.endsWith('/antigravity-acp') || t.endsWith('/agy-acp');

function importKnownAgentOptions(entry: AcpProfileEntry): AcpProfileEntry {
  if (entry.command.some((t) => t.includes('claude-agent-acp'))) importClaudeAcpOptions(entry);
  else if (entry.command.some((t) => t.includes('codex-acp'))) importCodexOptions(entry);
  else if (entry.command.some(isAntigravity)) importAntigravityOptions(entry);
  return entry;
}

/** Seed a profile's option lists from what the agent advertised the last time it
 *  ran (the argv-keyed cache — see acp/optionsCache.ts). This is the "remember for
 *  next launch" half: modes fill the permission dropdown, `select` config options
 *  (model / effort / …) fill the generic dropdowns. Runs *before* the hardcoded
 *  seed (both use `??=`), so a real, current session snapshot wins over the static
 *  guess; an explicitly-configured `agent.profiles` list still wins over both. */
function importCachedOptions(entry: AcpProfileEntry): AcpProfileEntry {
  const cached = readAcpOptionsCache(entry.command);
  if (!cached) return entry;
  if (cached.modes?.length) {
    entry.permissionModes ??= cached.modes.map((m) => ({
      value: m.id, label: m.name, ...(m.description ? { detail: m.description } : {}), args: [],
    }));
  }
  // Only `select` options reach the launcher (booleans are interdependent/unstable
  // — live footer only); the `mode` category is already excluded by AcpSession.
  const selects = (cached.configOptions ?? []).filter((o) => o.kind === 'select' && o.category !== 'mode');
  if (selects.length) {
    entry.configOptions ??= selects.map((o): ProfileConfigOption => ({
      id: o.id,
      name: o.name,
      options: (o.choices ?? []).map((c) => ({ value: c.value, label: c.name, ...(c.description ? { detail: c.description } : {}), args: [] })),
      default: typeof o.current === 'string' ? o.current : (o.choices?.[0]?.value ?? 'default'),
    }));
  }
  return entry;
}

/** A display name for an ad-hoc argv: the first token that isn't a package
 *  runner or a flag, basename'd (`npx -y @scope/claude-agent-acp` →
 *  `claude-agent-acp`; `bunx antigravity-acp` → `antigravity-acp`). */
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
    // Cache first (a real session's advertised options), then the hardcoded seed as
    // a first-launch fallback; a configured `agent.profiles` list wins over both.
    ...acp.map(importCachedOptions).map(importKnownAgentOptions).map((p): AgentProfile => ({
      id: `acp:${p.name}`,
      label: p.name,
      kind: 'acp',
      command: p.command,
      models: p.models,
      permissionModes: p.permissionModes,
      efforts: p.efforts,
      configOptions: p.configOptions,
    })),
  ];
}

/** The argv for launching `profile` with the launcher's selections: the
 *  profile command plus each chosen option's `args` (the `default` choice —
 *  or an argless one, applied over the protocol instead — appends nothing). */
export function profileCommand(profile: AgentProfile, sel: { model: string; permissionMode: string; effort: string }): string[] {
  const argsOf = (list: ProfileLaunchOption[] | undefined, value: string): string[] =>
    list?.find((option) => option.value === value)?.args ?? [];
  return [
    ...(profile.command ?? []),
    ...argsOf(profile.models, sel.model),
    ...argsOf(profile.permissionModes, sel.permissionMode),
    ...argsOf(profile.efforts, sel.effort),
  ];
}

/** The profile the launcher pre-selects for `kind` — its first entry of that
 *  kind (so `agent.implementation: "acp"` lands on the leading ACP profile). */
export function defaultProfileFor(kind: AgentKind, profiles: AgentProfile[]): AgentProfile {
  return profiles.find((p) => p.kind === kind) ?? profiles[0];
}
