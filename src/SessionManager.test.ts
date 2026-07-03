import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import {
  SessionManager,
  SESSION_VERSION,
  type SessionState,
  type TabState,
} from './SessionManager.ts';

// Each test gets its own temp state dir, so the on-disk format is exercised for
// real without touching the user's actual sessions.
function makeManager(): { manager: SessionManager; dir: string } {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'zym-session-'));
  return { manager: new SessionManager(dir), dir };
}

function sessionFor(root: string, name?: string): SessionState {
  const state: SessionState = {
    version: SESSION_VERSION,
    savedAt: '',
    activeWorkspace: 0,
    workspaces: [{ root, layout: { type: 'leaf', tabs: [], activeIndex: 0 } }],
  };
  if (name) state.name = name;
  return state;
}

test('save then loadByName round-trips a named session', () => {
  const { manager } = makeManager();
  const root = '/home/me/project';
  const tab: TabState = { kind: 'file', path: '/home/me/project/a.ts', cursor: [3, 5] };
  const state = sessionFor(root, 'Work');
  state.workspaces[0].layout = { type: 'leaf', tabs: [tab], activeIndex: 0 };

  manager.save(state);
  const loaded = manager.loadByName('Work');

  assert.ok(loaded);
  assert.equal(loaded!.version, SESSION_VERSION);
  assert.equal(loaded!.name, 'Work');
  assert.equal(loaded!.workspaces[0].root, root);
  assert.deepEqual(loaded!.workspaces[0].layout, { type: 'leaf', tabs: [tab], activeIndex: 0 });
});

test('round-trips the focused workspace, active leaf, split position, and dock sizes', () => {
  const { manager } = makeManager();
  const root = '/home/me/project';
  // A split whose end leaf is the focused one; a resized divider; a second
  // (agent) workspace that is the active one; per-side dock extents.
  const layout: SessionState['workspaces'][number]['layout'] = {
    type: 'split',
    orientation: 'horizontal',
    position: 480,
    start: { type: 'leaf', tabs: [], activeIndex: 0 },
    end: { type: 'leaf', tabs: [], activeIndex: 0, active: true },
  };
  const state: SessionState = {
    version: SESSION_VERSION,
    name: 'Split',
    savedAt: '',
    activeWorkspace: 1,
    workspaces: [
      { root, layout },
      { root: '/home/me/project/.worktrees/agent', layout: { type: 'leaf', tabs: [], activeIndex: 0 } },
    ],
    docks: { notificationLog: false, sizes: { right: 320, bottom: 180 } },
  };

  manager.save(state);
  const loaded = manager.loadByName('Split')!;

  assert.equal(loaded.activeWorkspace, 1);
  assert.deepEqual(loaded.workspaces[0].layout, layout);
  assert.deepEqual(loaded.docks?.sizes, { right: 320, bottom: 180 });
});

test('save stamps savedAt with an ISO timestamp', () => {
  const { manager } = makeManager();
  manager.save(sessionFor('/r', 'Stamp'));
  const loaded = manager.loadByName('Stamp')!;
  assert.match(loaded.savedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('named sessions are stored under the name slug', () => {
  const { manager } = makeManager();
  manager.save(sessionFor('/home/me/project', 'My Cool Session!'));

  const files = Fs.readdirSync(manager.sessionsDir()).sort();
  assert.deepEqual(files, ['my-cool-session.json']);
});

test('save refuses an unnamed (ephemeral) session — nothing is written', () => {
  const { manager } = makeManager();
  assert.throws(() => manager.save(sessionFor('/home/me/project')), /unnamed/);
  assert.equal(Fs.existsSync(manager.sessionsDir()), false);
});

test('label is the name when set, else the primary root basename', () => {
  const { manager } = makeManager();
  assert.equal(manager.label(sessionFor('/home/me/project')), 'project');
  assert.equal(manager.label(sessionFor('/home/me/project', 'Work')), 'Work');
});

test('loadByName returns null for a missing session', () => {
  const { manager } = makeManager();
  assert.equal(manager.loadByName('nope'), null);
});

test('loadPath returns null and does not throw on corrupt JSON', () => {
  const { manager, dir } = makeManager();
  const path = Path.join(dir, 'bad.json');
  Fs.writeFileSync(path, '{ not json');
  assert.equal(manager.loadPath(path), null);
});

test('loadByName rejects an unsupported version', () => {
  const { manager } = makeManager();
  manager.save(sessionFor('/r', 'Ver'));
  // Tamper with the version on disk.
  const path = manager.pathForName('Ver');
  const onDisk = JSON.parse(Fs.readFileSync(path, 'utf8'));
  onDisk.version = SESSION_VERSION + 1;
  Fs.writeFileSync(path, JSON.stringify(onDisk));
  assert.equal(manager.loadByName('Ver'), null);
});

test('load rejects a structurally invalid session', () => {
  const { manager, dir } = makeManager();
  Fs.mkdirSync(dir, { recursive: true });
  Fs.writeFileSync(Path.join(dir, 'x.json'), JSON.stringify({ version: 1, workspaces: [] }));
  assert.equal(manager.loadPath(Path.join(dir, 'x.json')), null);
});

test('list returns every valid session (named + legacy no-name) and skips junk', () => {
  const { manager } = makeManager();
  manager.save(sessionFor('/a', 'Ay'));
  manager.save(sessionFor('/b', 'Bee'));
  // A legacy no-name file (old per-root autosave) written straight to disk still
  // surfaces in the picker for migration; nothing auto-loads it.
  Fs.writeFileSync(manager.pathForRoot('/legacy'), JSON.stringify(sessionFor('/legacy')));
  Fs.writeFileSync(Path.join(manager.sessionsDir(), 'junk.json'), 'nope');
  Fs.writeFileSync(Path.join(manager.sessionsDir(), 'ignore.txt'), 'not json at all');

  const roots = manager.list().map((s) => s.workspaces[0].root).sort();
  assert.deepEqual(roots, ['/a', '/b', '/legacy']);
});

test('delete removes the session file and its buffer cache', () => {
  const { manager } = makeManager();
  const state = sessionFor('/r', 'Doomed');
  manager.save(state);
  manager.writeBuffers(state, [{ path: '/r/a.ts', text: 'unsaved' }]);
  assert.ok(manager.loadByName('Doomed'));
  const buffers = manager.pathForName('Doomed').replace(/\.json$/, '.buffers');
  assert.ok(Fs.existsSync(buffers));

  manager.delete(state);
  assert.equal(manager.loadByName('Doomed'), null);
  assert.equal(Fs.existsSync(buffers), false);
});

test('rename moves the json and its buffer cache to the new name', () => {
  const { manager } = makeManager();
  const state = sessionFor('/r', 'Old Name');
  manager.save(state);
  manager.writeBuffers(state, [{ path: '/r/a.ts', text: 'draft' }]);

  const renamed = manager.rename(state, 'New Name');
  assert.equal(renamed.name, 'New Name');

  // Old gone, new present, and the buffer cache followed the rename.
  assert.equal(manager.loadByName('Old Name'), null);
  const loaded = manager.loadByName('New Name');
  assert.ok(loaded);
  assert.equal(loaded!.workspaces[0].root, '/r');
  assert.equal(manager.readBuffer(renamed, '/r/a.ts'), 'draft');
  const oldBuffers = manager.pathForName('Old Name').replace(/\.json$/, '.buffers');
  assert.equal(Fs.existsSync(oldBuffers), false);
});

test('collectModified returns only participants reporting modified, and respects deregistration', () => {
  const { manager } = makeManager();
  const clean = { isModified: () => false };
  let dirty = true;
  const editor = { isModified: () => dirty, getModifiedLabel: () => 'foo.ts (unsaved)' };

  manager.registerParticipant(clean);
  const reg = manager.registerParticipant(editor);

  assert.deepEqual(manager.collectModified(), [editor]);

  dirty = false; // editor saved
  assert.deepEqual(manager.collectModified(), []);

  dirty = true;
  reg.dispose(); // editor's tab closed
  assert.deepEqual(manager.collectModified(), []);
});

test('deserializer registry builds by kind and unregisters', () => {
  const { manager } = makeManager();
  const fileTab: TabState = { kind: 'file', path: '/a.ts' };
  const termTab: TabState = { kind: 'terminal', cwd: '/' };

  const disposable = manager.registerDeserializer('file', (s) => `built:${(s as any).path}`);
  assert.equal(manager.deserialize(fileTab), 'built:/a.ts');
  assert.equal(manager.deserialize(termTab), null); // no deserializer for terminal

  disposable.dispose();
  assert.equal(manager.deserialize(fileTab), null);
});
