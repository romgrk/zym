/*
 * Profile resolution (agents/profiles.ts): the launcher's agent dropdown is
 * built from these — the terminal kind first, then the configured ACP profiles,
 * with pre-profiles setups (an explicit agent.acp.command / the ZYM_ACP_COMMAND
 * env override) surfacing as the leading ACP entry. Pure config/env plumbing —
 * no GTK needed.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { zym } from '../zym.ts';
import { listAgentProfiles, defaultProfileFor, profileNameFor, profileCommand } from './profiles.ts';
import { acpCommand } from './acp/config.ts';

afterEach(() => {
  zym.config.unset('agent.profiles');
  zym.config.unset('agent.acp.command');
  delete process.env.ZYM_ACP_COMMAND;
});

test('defaults: the terminal kind, then the built-in acp profiles', () => {
  const profiles = listAgentProfiles();
  assert.deepEqual(profiles.map((p) => p.id), ['claude-tui', 'acp:gemini', 'acp:claude-acp']);
  assert.equal(profiles[0].kind, 'claude-tui');
  assert.equal(profiles[0].command, undefined); // argv comes from buildCommand
  assert.deepEqual(profiles[1].command, ['gemini', '--acp']);
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
  zym.config.set('agent.acp.command', ['gemini', '--acp']);
  const profiles = listAgentProfiles();
  assert.deepEqual(profiles.map((p) => p.id), ['claude-tui', 'acp:gemini', 'acp:claude-acp']);
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
  assert.deepEqual(profiles.map((p) => p.id), ['claude-tui', 'acp:gemini', 'acp:claude-acp']);
});

test('profileNameFor skips runners and flags, basenames the binary', () => {
  assert.equal(profileNameFor(['gemini', '--acp']), 'gemini');
  assert.equal(profileNameFor(['npx', '-y', '@agentclientprotocol/claude-agent-acp']), 'claude-agent-acp');
  assert.equal(profileNameFor(['/usr/bin/codex-acp']), 'codex-acp');
});

test('defaultProfileFor picks the first profile of the kind', () => {
  const profiles = listAgentProfiles();
  assert.equal(defaultProfileFor('claude-tui', profiles).id, 'claude-tui');
  assert.equal(defaultProfileFor('acp', profiles).id, 'acp:gemini');
});

test('recognized agents import their launch options', () => {
  const [, gemini, claudeAcp] = listAgentProfiles();
  // gemini: approval mode is a launch flag; models are left to configuration.
  assert.equal(gemini.id, 'acp:gemini');
  assert.equal(gemini.models, undefined);
  assert.deepEqual(gemini.permissionModes?.map((o) => o.value), ['default', 'auto_edit', 'yolo']);
  assert.deepEqual(gemini.permissionModes?.[2].args, ['--approval-mode', 'yolo']);
  // claude adapter: models over _meta, modes over session/set_mode — no argv args.
  assert.equal(claudeAcp.id, 'acp:claude-acp');
  assert.equal(claudeAcp.models?.[0].value, 'default');
  assert.ok(claudeAcp.models!.length > 1);
  assert.ok(claudeAcp.models!.every((o) => o.args.length === 0));
  assert.deepEqual(claudeAcp.permissionModes?.map((o) => o.value), ['default', 'acceptEdits', 'plan', 'bypassPermissions']);
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
  assert.deepEqual(acpCommand(), ['gemini', '--acp']);
  zym.config.set('agent.profiles', [{ name: 'codex', command: ['codex-acp'] }]);
  assert.deepEqual(acpCommand(), ['codex-acp']);
  process.env.ZYM_ACP_COMMAND = 'gemini --experimental-acp';
  assert.deepEqual(acpCommand(), ['gemini', '--experimental-acp']);
});
