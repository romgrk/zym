/*
 * Profile resolution (agents/profiles.ts): the launcher's agent dropdown is
 * built from these — the terminal kind first, then the configured ACP profiles,
 * with pre-profiles setups (an explicit agent.acp.command / the ZYM_ACP_COMMAND
 * env override) surfacing as the leading ACP entry. Pure config/env plumbing —
 * no GTK needed.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { zym } from '../zym.ts';
import { listAgentProfiles, defaultProfileFor, profileNameFor, profileCommand } from './profiles.ts';
import { acpCommand } from './acp/config.ts';
import { writeAcpOptionsCache } from './acp/optionsCache.ts';

// Isolate the argv-keyed options cache (importCachedOptions reads it) so a real
// dev-machine cache can't perturb the assertions; each test starts cache-empty.
let stateDir: string;
let prevXdg: string | undefined;
before(() => {
  prevXdg = process.env.XDG_STATE_HOME;
  stateDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'zym-profiles-'));
  process.env.XDG_STATE_HOME = stateDir;
});
after(() => {
  if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = prevXdg;
  Fs.rmSync(stateDir, { recursive: true, force: true });
});

afterEach(() => {
  zym.config.unset('agent.profiles');
  zym.config.unset('agent.acp.command');
  delete process.env.ZYM_ACP_COMMAND;
  Fs.rmSync(Path.join(stateDir, 'zym', 'acp-options.json'), { force: true });
});

test('defaults: the terminal kind, then the built-in acp profiles', () => {
  const profiles = listAgentProfiles();
  assert.deepEqual(profiles.map((p) => p.id), ['claude-tui', 'acp:antigravity', 'acp:claude-acp']);
  assert.equal(profiles[0].kind, 'claude-tui');
  assert.equal(profiles[0].command, undefined); // argv comes from buildCommand
  assert.deepEqual(profiles[1].command, ['bunx', 'antigravity-acp']);
  assert.deepEqual(profiles[2].command, ['npx', '-y', '@agentclientprotocol/claude-agent-acp']);
});

test('configured agent.profiles replace the defaults; invalid entries are skipped', () => {
  zym.config.set('agent.profiles', [
    { name: 'codex', command: ['codex-acp'] },
    { name: '', command: ['x'] }, // no name
    { name: 'bad-argv', command: [] }, // empty argv
    { name: 'bad-types', command: ['ok', 42] }, // non-string token
    'not-an-object',
    { name: 'gemini', command: ['gemini', '--acp'] },
  ]);
  const profiles = listAgentProfiles();
  assert.deepEqual(profiles.map((p) => p.id), ['claude-tui', 'acp:codex', 'acp:gemini']);
});

test('an explicitly-set agent.acp.command leads the acp profiles', () => {
  zym.config.set('agent.acp.command', ['codex-acp', '--flag']);
  const profiles = listAgentProfiles();
  assert.equal(profiles[1].id, 'acp:codex-acp');
  assert.deepEqual(profiles[1].command, ['codex-acp', '--flag']);
  assert.equal(profiles.length, 4); // claude-tui + legacy + the two defaults
});

test('a legacy command equal to an existing profile is not duplicated', () => {
  zym.config.set('agent.acp.command', ['bunx', 'antigravity-acp']);
  const profiles = listAgentProfiles();
  assert.deepEqual(profiles.map((p) => p.id), ['claude-tui', 'acp:antigravity', 'acp:claude-acp']);
});

test('ZYM_ACP_COMMAND wins over config and leads the list', () => {
  zym.config.set('agent.acp.command', ['codex-acp']);
  process.env.ZYM_ACP_COMMAND = 'npx -y @example/my-agent';
  const profiles = listAgentProfiles();
  assert.equal(profiles[1].label, 'my-agent');
  assert.deepEqual(profiles[1].command, ['npx', '-y', '@example/my-agent']);
});

test('an env command matching an existing profile is not duplicated', () => {
  process.env.ZYM_ACP_COMMAND = 'npx -y @agentclientprotocol/claude-agent-acp';
  const profiles = listAgentProfiles();
  assert.deepEqual(profiles.map((p) => p.id), ['claude-tui', 'acp:antigravity', 'acp:claude-acp']);
});

test('profileNameFor skips runners and flags, basenames the binary', () => {
  assert.equal(profileNameFor(['gemini', '--acp']), 'gemini');
  assert.equal(profileNameFor(['npx', '-y', '@agentclientprotocol/claude-agent-acp']), 'claude-agent-acp');
  assert.equal(profileNameFor(['/usr/bin/codex-acp']), 'codex-acp');
});

test('defaultProfileFor picks the first profile of the kind', () => {
  const profiles = listAgentProfiles();
  assert.equal(defaultProfileFor('claude-tui', profiles).id, 'claude-tui');
  assert.equal(defaultProfileFor('acp', profiles).id, 'acp:antigravity');
});

test('recognized agents import their launch options', () => {
  const [, antigravity, claudeAcp] = listAgentProfiles();
  // antigravity: modes are a `mode` config option (Standard/plan/bypassPermissions),
  // promoted into the mode channel by AcpSession and switched over
  // session/set_config_option (no argv); models are discovered by agy per session.
  assert.equal(antigravity.id, 'acp:antigravity');
  assert.equal(antigravity.models, undefined);
  assert.deepEqual(antigravity.permissionModes?.map((o) => o.value), ['default', 'plan', 'bypassPermissions']);
  assert.ok(antigravity.permissionModes!.every((o) => o.args.length === 0));
  // claude adapter: modes over session/set_mode (the first-launch seed). Its model
  // list is no longer hardcoded — it's discovered as a `model` config option and
  // cached, so with an empty cache there's no models / configOptions list yet.
  assert.equal(claudeAcp.id, 'acp:claude-acp');
  assert.equal(claudeAcp.models, undefined);
  assert.equal(claudeAcp.configOptions, undefined);
  assert.deepEqual(claudeAcp.permissionModes?.map((o) => o.value), ['default', 'acceptEdits', 'plan', 'bypassPermissions']);
});

test('cached options seed the launcher: modes → permission, select config options → configOptions', () => {
  writeAcpOptionsCache(['bunx', 'antigravity-acp'], {
    modes: [{ id: 'default', name: 'Default' }, { id: 'yolo', name: 'YOLO', description: 'all' }],
    configOptions: [
      { id: 'model', name: 'Model', category: 'model', kind: 'select', current: 'pro', choices: [{ value: 'pro', name: 'Pro' }, { value: 'flash', name: 'Flash' }] },
      { id: 'fast', name: 'Fast', category: 'model_config', kind: 'boolean', current: false }, // boolean → live footer only, not the launcher
    ],
  });
  const [, antigravity] = listAgentProfiles();
  // Cache modes replace the hardcoded seed (default/plan/bypassPermissions).
  assert.deepEqual(antigravity.permissionModes?.map((o) => o.value), ['default', 'yolo']);
  // Only the `select` option seeds configOptions; the boolean is excluded.
  assert.deepEqual(antigravity.configOptions?.map((o) => o.id), ['model']);
  assert.equal(antigravity.configOptions?.[0].default, 'pro');
  assert.deepEqual(antigravity.configOptions?.[0].options.map((o) => o.value), ['pro', 'flash']);
});

test('a configured permission list wins over the cache', () => {
  writeAcpOptionsCache(['gemini', '--acp'], { modes: [{ id: 'default', name: 'Default' }, { id: 'yolo', name: 'YOLO' }] });
  zym.config.set('agent.profiles', [{ name: 'gemini', command: ['gemini', '--acp'], permissionModes: ['plan'] }]);
  const [, gemini] = listAgentProfiles();
  assert.deepEqual(gemini.permissionModes?.map((o) => o.value), ['default', 'plan']); // configured, not cached
});

test('configured option lists are parsed, default-led, and suppress importing', () => {
  zym.config.set('agent.profiles', [{
    name: 'gemini',
    command: ['gemini', '--acp'],
    models: ['gemini-2.5-flash', { value: 'gemini-2.5-pro', label: 'pro', args: ['-m', 'gemini-2.5-pro'] }],
    permissionModes: [{ value: 'yolo', args: ['--approval-mode', 'yolo'] }],
  }]);
  const [, gemini] = listAgentProfiles();
  assert.deepEqual(gemini.models?.map((o) => o.value), ['default', 'gemini-2.5-flash', 'gemini-2.5-pro']);
  assert.deepEqual(gemini.models?.[1].args, []); // string shorthand → no args
  assert.equal(gemini.models?.[2].label, 'pro');
  // The configured permission list replaced the imported one (default still prepended).
  assert.deepEqual(gemini.permissionModes?.map((o) => o.value), ['default', 'yolo']);
});

test('profileCommand appends the chosen options’ args; default appends nothing', () => {
  zym.config.set('agent.profiles', [{
    name: 'gemini',
    command: ['gemini', '--acp'],
    models: [{ value: 'gemini-2.5-pro', args: ['-m', 'gemini-2.5-pro'] }],
    // A user who prefers argv-encoded (restart-surviving) modes over the
    // protocol default configures the args explicitly (suppresses importing).
    permissionModes: [{ value: 'yolo', args: ['--approval-mode', 'yolo'] }],
  }]);
  const [, gemini] = listAgentProfiles();
  assert.deepEqual(
    profileCommand(gemini, { model: 'gemini-2.5-pro', permissionMode: 'yolo', effort: 'default' }),
    ['gemini', '--acp', '-m', 'gemini-2.5-pro', '--approval-mode', 'yolo'],
  );
  assert.deepEqual(
    profileCommand(gemini, { model: 'default', permissionMode: 'default', effort: 'default' }),
    ['gemini', '--acp'],
  );
});

test('acpCommand() is the leading acp profile argv', () => {
  assert.deepEqual(acpCommand(), ['bunx', 'antigravity-acp']);
  zym.config.set('agent.profiles', [{ name: 'codex', command: ['codex-acp'] }]);
  assert.deepEqual(acpCommand(), ['codex-acp']);
  process.env.ZYM_ACP_COMMAND = 'gemini --experimental-acp';
  assert.deepEqual(acpCommand(), ['gemini', '--experimental-acp']);
});
