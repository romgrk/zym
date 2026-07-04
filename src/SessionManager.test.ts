import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import {
  SessionManager,
  SESSION_VERSION,
  emptySessionState,
  type SessionState,
  type TabState,
  type AgentTabState,
} from './SessionManager.ts';

// Each test gets its own temp state dir, so the on-disk format is exercised for
// real without touching the user's actual sessions.
function makeManager(): { manager: SessionManager; dir: string } {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'zym-session-'));
  return { manager: new SessionManager(dir), dir };
}

// One project, its default workbench empty, no agents.
function sessionFor(root: string, name?: string): SessionState {
  const state: SessionState = {
    version: SESSION_VERSION,
    savedAt: '',
    active: { project: 0 },
    projects: [{ root, workbench: { layout: { type: 'leaf', tabs: [], activeIndex: 0 } }, agents: [] }],
  };
  if (name) state.name = name;
  return state;
}

test('save then loadByName round-trips a named session', () => {
  const { manager } = makeManager();
  const root = '/home/me/project';
  const tab: TabState = { kind: 'file', path: '/home/me/project/a.ts', cursor: [3, 5] };
  const state = sessionFor(root, 'Work');
  state.projects[0].workbench.layout = { type: 'leaf', tabs: [tab], activeIndex: 0 };

  manager.save(state);
  const loaded = manager.loadByName('Work');

  assert.ok(loaded);
  assert.equal(loaded!.version, SESSION_VERSION);
  assert.equal(loaded!.name, 'Work');
  assert.equal(loaded!.projects[0].root, root);
  assert.deepEqual(loaded!.projects[0].workbench.layout, { type: 'leaf', tabs: [tab], activeIndex: 0 });
});

test('round-trips the focused agent, active leaf, split position, and dock sizes', () => {
  const { manager } = makeManager();
  const root = '/home/me/project';
  // A split whose end leaf is the focused one; a resized divider; an agent under the
  // project that is the active owner; per-side dock extents.
  const layout: SessionState['projects'][number]['workbench']['layout'] = {
    type: 'split',
    orientation: 'horizontal',
    position: 480,
    start: { type: 'leaf', tabs: [], activeIndex: 0 },
    end: { type: 'leaf', tabs: [], activeIndex: 0, active: true },
  };
  const agentTab: AgentTabState = { kind: 'agent', command: ['claude'], cwd: '/home/me/project/.worktrees/agent' };
  const state: SessionState = {
    version: SESSION_VERSION,
    name: 'Split',
    savedAt: '',
    active: { project: 0, agent: 0 },
    projects: [
      {
        root,
        workbench: { layout },
        agents: [
          { root: '/home/me/project/.worktrees/agent', workbench: { layout: { type: 'leaf', tabs: [], activeIndex: 0 } }, agent: agentTab },
        ],
      },
    ],
    docks: { notificationLog: false, sizes: { right: 320, bottom: 180 } },
  };

  manager.save(state);
  const loaded = manager.loadByName('Split')!;

  assert.deepEqual(loaded.active, { project: 0, agent: 0 });
  assert.deepEqual(loaded.projects[0].workbench.layout, layout);
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

  const roots = manager.list().map((s) => s.projects[0].root).sort();
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
  assert.equal(loaded!.projects[0].root, '/r');
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

test('emptySessionState is a fresh unnamed single-project slate (session:close)', () => {
  const root = '/home/me/project';
  const state = emptySessionState(root);

  assert.equal(state.name, undefined); // unnamed → applying it drops to the default session
  assert.equal(state.version, SESSION_VERSION);
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].root, root);
  assert.deepEqual(state.projects[0].agents, []);
  assert.deepEqual(state.projects[0].workbench.layout, { type: 'leaf', tabs: [], activeIndex: 0, active: true });
  assert.deepEqual(state.active, { project: 0 });

  // A save must refuse it (unnamed never persists) — the close path applies it live, not to disk.
  const { manager } = makeManager();
  assert.throws(() => manager.save(state));
});

test('lock: our own acquired lock is not reported as "open elsewhere", and releases cleanly', () => {
  const { manager, dir } = makeManager();
  const lockPath = Path.join(dir, 'zym', 'sessions', 'work.lock');

  manager.acquireLock('Work');
  assert.ok(Fs.existsSync(lockPath));
  assert.equal(manager.lockHolder('Work'), null); // same process → not "elsewhere"

  manager.releaseLock('Work');
  assert.ok(!Fs.existsSync(lockPath));
  assert.equal(manager.lockHolder('Work'), null);
});

test('lockHolder: reports another live instance, ignores a stale (dead) pid', () => {
  const { manager, dir } = makeManager();
  const lockPath = Path.join(dir, 'zym', 'sessions', 'work.lock');
  Fs.mkdirSync(Path.dirname(lockPath), { recursive: true });
  const host = Os.hostname();

  // A live foreign pid (pid 1 is always alive and not us) → held elsewhere.
  Fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, host, since: '' }));
  assert.ok(manager.lockHolder('Work'));

  // A dead pid (far above pid_max) → stale → free.
  Fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, host, since: '' }));
  assert.equal(manager.lockHolder('Work'), null);

  // A lock from another host can't be liveness-checked → treated as held.
  Fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, host: `${host}-other`, since: '' }));
  assert.ok(manager.lockHolder('Work'));
});

test('releaseLock leaves another process’s lock intact; delete removes it', () => {
  const { manager, dir } = makeManager();
  const lockPath = Path.join(dir, 'zym', 'sessions', 'work.lock');
  Fs.mkdirSync(Path.dirname(lockPath), { recursive: true });
  Fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, host: Os.hostname(), since: '' }));

  manager.releaseLock('Work'); // not ours → must not delete
  assert.ok(Fs.existsSync(lockPath));

  manager.delete(sessionFor('/home/me/project', 'Work')); // forgetting the session clears its lock
  assert.ok(!Fs.existsSync(lockPath));
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
