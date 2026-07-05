// WorkbenchList leap-style jump (workbench:jump): labels go up on every row, the key
// grab (registered via `zym.keymaps.addListener`, ahead of command dispatch) claims
// the deciding keystroke, a label's key activates its row, anything else cancels.
// The grab listener is driven directly with synthetic `Key`s — no real keystrokes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Gtk from 'gi:Gtk-4.0';
import { zym } from '../zym.ts';
import { Key } from '../keymap/Key.ts';
import { WorkbenchList } from './WorkbenchList.ts';
import { createProject } from './workbench/Owner.ts';

Gtk.init();

// A two-project rail (labels `a` and `s`), recording activations into `activated`.
// `onProjectsChanged` hands back the rebuild trigger so a test can simulate the
// owner set changing mid-jump.
function makeList(activated: string[]) {
  let rebuild: (() => void) | null = null;
  const groups = [
    { project: createProject('/tmp/alpha'), agents: [] },
    { project: createProject('/tmp/beta'), agents: [] },
  ];
  const list = new WorkbenchList({
    getGroups: () => groups,
    onActivateProject: (project) => activated.push(project.title),
    onProjectsChanged: (cb) => {
      rebuild = cb;
      return { dispose: () => {} };
    },
  });
  return { list, rebuild: () => rebuild?.() };
}

// Feed one key to the pending jump's grab (the listener registered by startJump).
function press(key: Key): boolean {
  const listener = zym.keymaps.listeners[zym.keymaps.listeners.length - 1];
  assert.ok(listener, 'a jump key grab is registered');
  return listener(key, undefined, []);
}

function bareModifier(): Key {
  const key = new Key();
  key.name = 'control_l';
  return key;
}

// Whether any Gtk.Label under `root` displays `text` (`visibleOnly` requires the
// label widget itself to be visible).
function findLabelText(root: InstanceType<typeof Gtk.Widget>, text: string, visibleOnly = false): boolean {
  if (root instanceof Gtk.Label && root.getText() === text && (!visibleOnly || root.getVisible())) return true;
  for (let child = root.getFirstChild(); child; child = child.getNextSibling())
    if (findLabelText(child, text, visibleOnly)) return true;
  return false;
}

test('a label key jumps to its row and releases the grab', () => {
  const activated: string[] = [];
  const { list } = makeList(activated);
  const grabsBefore = zym.keymaps.listeners.length;

  let done: boolean | null = null;
  list.startJump((jumped) => (done = jumped));
  assert.equal(zym.keymaps.listeners.length, grabsBefore + 1);

  assert.equal(press(Key.fromDescription('s')!), true, 'the key is claimed');
  assert.deepEqual(activated, ['beta']);
  assert.equal(done, true);
  assert.equal(zym.keymaps.listeners.length, grabsBefore, 'grab released');
  list.dispose();
});

test('an unlabeled key cancels (still claimed)', () => {
  const activated: string[] = [];
  const { list } = makeList(activated);

  let done: boolean | null = null;
  list.startJump((jumped) => (done = jumped));
  // Only `a`/`s` are assigned for two rows; `z` is in the alphabet but unassigned.
  assert.equal(press(Key.fromDescription('z')!), true);
  assert.deepEqual(activated, []);
  assert.equal(done, false);
  list.dispose();
});

test('escape and modifier chords cancel; a bare modifier keeps waiting', () => {
  const activated: string[] = [];
  const { list } = makeList(activated);

  let done: boolean | null = null;
  list.startJump((jumped) => (done = jumped));
  assert.equal(press(bareModifier()), false, 'bare modifier falls through, grab stays');
  assert.equal(done, null);
  assert.equal(press(Key.fromDescription('escape')!), true);
  assert.equal(done, false);

  list.startJump((jumped) => (done = jumped));
  assert.equal(press(Key.fromDescription('ctrl-a')!), true, 'a chord is never a label');
  assert.deepEqual(activated, []);
  assert.equal(done, false);
  list.dispose();
});

test('a rebuild (owner set changed) cancels a pending jump', () => {
  const activated: string[] = [];
  const { list, rebuild } = makeList(activated);
  const grabsBefore = zym.keymaps.listeners.length;

  let done: boolean | null = null;
  list.startJump((jumped) => (done = jumped));
  rebuild();
  assert.equal(done, false);
  assert.equal(zym.keymaps.listeners.length, grabsBefore, 'grab released with the rows');
  list.dispose();
});

test('a project row shows its mark as a lead pseudo-icon, hidden after cancel', () => {
  const activated: string[] = [];
  const { list } = makeList(activated);

  list.startJump();
  assert.ok(findLabelText(list.root, 's', true), 'the mark is shown in the lead slot');
  assert.ok(findLabelText(list.root, 'beta'), 'the title itself is untouched');
  press(Key.fromDescription('escape')!);
  assert.ok(!findLabelText(list.root, 's', true), 'the mark is hidden after cancel');
  list.dispose();
});

test('dispose releases a pending grab', () => {
  const activated: string[] = [];
  const { list } = makeList(activated);
  const grabsBefore = zym.keymaps.listeners.length;
  list.startJump();
  list.dispose();
  assert.equal(zym.keymaps.listeners.length, grabsBefore);
});
