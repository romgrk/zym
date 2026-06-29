import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import {
  projectSettingsPath,
  readProjectActions,
  readProjectSettings,
  ensureProjectSettingsFile,
  parseSearchPresets,
  projectSearchPresets,
  saveSearchPreset,
  deleteSearchPreset,
  BUILTIN_SEARCH_PRESETS,
} from './projectSettings.ts';
import { tmpDir } from './util/testTmp.ts';

function write(cwd: string, json: string): void {
  Fs.writeFileSync(projectSettingsPath(cwd), json);
  // (tmpDir exists; the file sits at its root/.zym — ensure the dir)
}
function writeSettings(cwd: string, obj: unknown): void {
  Fs.mkdirSync(projectSettingsPath(cwd).replace(/settings\.json$/, ''), { recursive: true });
  Fs.writeFileSync(projectSettingsPath(cwd), JSON.stringify(obj));
}

// --- actions section ---------------------------------------------------------

test('readProjectActions reads the `actions` section of <cwd>/.zym/settings.json', () => {
  const cwd = tmpDir('ps-actions');
  writeSettings(cwd, { actions: [{ label: 'Dev', command: 'pnpm dev' }] });
  assert.deepEqual(readProjectActions(cwd).map((a) => a.label), ['Dev']);
});

test('readProjectSettings returns empty sections when the file is missing or malformed', () => {
  const missing = tmpDir('ps-missing');
  assert.deepEqual(readProjectSettings(missing), { actions: [], searchPresets: [] });
  const bad = tmpDir('ps-bad');
  Fs.mkdirSync(projectSettingsPath(bad).replace(/settings\.json$/, ''), { recursive: true });
  write(bad, '{ not json');
  assert.deepEqual(readProjectSettings(bad), { actions: [], searchPresets: [] });
});

test('ensureProjectSettingsFile seeds a new file but leaves an existing one', () => {
  const fresh = tmpDir('ps-seed');
  const path = ensureProjectSettingsFile(fresh);
  assert.equal(path, projectSettingsPath(fresh));
  assert.ok(Fs.existsSync(path));
  assert.ok(readProjectActions(fresh).length > 0); // the seed parses to at least one action

  const existing = tmpDir('ps-keep');
  writeSettings(existing, { actions: [{ label: 'Mine', command: 'echo mine' }] });
  ensureProjectSettingsFile(existing);
  assert.deepEqual(readProjectActions(existing).map((a) => a.label), ['Mine']); // untouched
});

// --- search presets ----------------------------------------------------------

test('parseSearchPresets validates names and coerces options field-by-field', () => {
  const presets = parseSearchPresets([
    { name: '  Code  ', options: { globs: ['!*.test.*', ''], regex: true, bogus: 1 } },
    { name: '', options: {} }, // dropped: empty name
    { name: 'Code', options: {} }, // dropped: duplicate name
    'nope', // dropped: not an object
  ]);
  assert.equal(presets.length, 1);
  assert.equal(presets[0].name, 'Code');
  assert.deepEqual(presets[0].options, { regex: true, globs: ['!*.test.*'] });
});

test('projectSearchPresets layers project presets over the built-ins (override by name)', () => {
  const cwd = tmpDir('ps-presets');
  writeSettings(cwd, { search: { presets: [{ name: 'Code', options: { globs: ['!x/'] } }] } });
  const presets = projectSearchPresets(cwd);
  const names = presets.map((p) => p.name);
  // The project's "Code" wins (its options), and the other built-ins still appear.
  assert.equal(names[0], 'Code');
  assert.deepEqual(presets[0].options, { globs: ['!x/'] });
  for (const b of BUILTIN_SEARCH_PRESETS) if (b.name !== 'Code') assert.ok(names.includes(b.name));
});

test('a project with no file still offers the built-in presets', () => {
  const cwd = tmpDir('ps-builtins');
  assert.deepEqual(
    projectSearchPresets(cwd).map((p) => p.name),
    BUILTIN_SEARCH_PRESETS.map((p) => p.name),
  );
});

test('saveSearchPreset adds then replaces by name, preserving other sections', () => {
  const cwd = tmpDir('ps-save');
  writeSettings(cwd, { actions: [{ label: 'Dev', command: 'pnpm dev' }] });
  saveSearchPreset(cwd, { name: 'mine', options: { regex: true } });
  saveSearchPreset(cwd, { name: 'mine', options: { wholeWord: true } }); // replace
  const settings = readProjectSettings(cwd);
  assert.deepEqual(settings.actions.map((a) => a.label), ['Dev'], 'actions preserved');
  const mine = settings.searchPresets.filter((p) => p.name === 'mine');
  assert.equal(mine.length, 1);
  assert.deepEqual(mine[0].options, { wholeWord: true });
});

test('deleteSearchPreset removes a project preset by name', () => {
  const cwd = tmpDir('ps-delete');
  saveSearchPreset(cwd, { name: 'a', options: {} });
  saveSearchPreset(cwd, { name: 'b', options: {} });
  deleteSearchPreset(cwd, 'a');
  assert.deepEqual(readProjectSettings(cwd).searchPresets.map((p) => p.name), ['b']);
});
