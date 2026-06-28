// Regression tests for "the Git Panel content sometimes disappears (removed from the
// tree altogether)". A reused center tab (the GitPanel — docs/panels.md "Reusing a
// center widget") is shown via the reveal-or-add pattern in AppWindow.revealGitPanel.
// The invariant this locks in: that pattern must NEVER unparent a *live* page child —
// doing so corrupts it into a zombie that vanishes from the tree (the reveal rule). The
// replica below mirrors revealGitPanel; keep them in sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Gtk from 'gi:Gtk-4.0';
import { PanelGroup } from './PanelGroup.ts';
import { Panel } from './Panel.ts';

Gtk.init();

type Widget = InstanceType<typeof Gtk.Widget>;

// A stand-in for GitPanel.root (a reused widget re-shown across close/reopen).
function makeGitRoot(): Widget {
  const w = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
  w.addCssClass('GitPanel');
  return w;
}

// Mirrors AppWindow.revealGitPanel (the fixed reveal-or-add). Returns where it landed.
function revealGitPanel(center: PanelGroup, gitRoot: Widget): 'center' | 'host' | 'added' {
  if (center.reveal(gitRoot)) return 'center';
  if (gitRoot.getRoot()) {
    // Live elsewhere (e.g. dragged into a dock) — reveal in place, never unparent.
    Panel.containing(gitRoot)?.reveal(gitRoot);
    return 'host';
  }
  if (gitRoot.getParent()) gitRoot.unparent(); // closed / orphaned — safe to drop
  center.add(gitRoot, { title: 'Git', requireTabBar: true });
  return 'added';
}

// The widget is shown live and intact (not a zombie): attached to a window, and its
// recorded host panel can still select its page.
function assertShownSomewhere(gitRoot: Widget, label: string) {
  assert.ok(gitRoot.getRoot(), `${label}: gitRoot is attached to a live window (not orphaned)`);
  const host = Panel.containing(gitRoot);
  assert.ok(host, `${label}: gitRoot has a hosting panel`);
  assert.ok(host!.reveal(gitRoot), `${label}: its host can still select its page (page intact)`);
}

// As above, and specifically inside `center` (the normal home for the git panel).
function assertShownInCenter(center: PanelGroup, gitRoot: Widget, label: string) {
  assertShownSomewhere(gitRoot, label);
  assert.ok(center.reveal(gitRoot), `${label}: shown in the center`);
}

// Each scenario hosts its own window so the widgets are in a live tree.
function freshCenter(): { center: PanelGroup; window: InstanceType<typeof Gtk.Window> } {
  const center = new PanelGroup();
  const window = new Gtk.Window();
  window.setChild(center.root);
  return { center, window };
}

test('add then reveal again is idempotent', () => {
  const { center } = freshCenter();
  const git = makeGitRoot();
  revealGitPanel(center, git);
  assertShownInCenter(center, git, 'first reveal');
  revealGitPanel(center, git);
  assertShownInCenter(center, git, 'second reveal');
});

test('survives restoreLayout discarding the tree (git panel is not persisted)', () => {
  const { center } = freshCenter();
  const git = makeGitRoot();
  center.add(new Gtk.Label({ label: 'editor.ts' }), { title: 'editor.ts' });
  revealGitPanel(center, git);
  assertShownInCenter(center, git, 'before restore');

  // The git panel serializes to null (not persisted); restoreLayout discards the old
  // tree without closing its pages, stranding the git root in the detached tree.
  const layout = center.serializeLayout((w) => (w === git ? null : ({ kind: 'editor', path: 'editor.ts' } as any)));
  center.restoreLayout(layout, (s: any) => ({ widget: new Gtk.Label({ label: s.path }), title: s.path }));

  assert.equal(revealGitPanel(center, git), 'added', 're-added after the rebuild dropped it');
  assertShownInCenter(center, git, 'after restore + reveal');
});

test('survives close + reopen', () => {
  const { center } = freshCenter();
  const git = makeGitRoot();
  revealGitPanel(center, git);
  assertShownInCenter(center, git, 'before close');
  center.closeActivePanel(); // close the git tab (the GitPanel object is reused)
  revealGitPanel(center, git);
  assertShownInCenter(center, git, 'after close + reopen');
});

test('survives a split (git tab stays in its leaf)', () => {
  const { center } = freshCenter();
  const git = makeGitRoot();
  revealGitPanel(center, git);
  center.split('right');
  center.add(new Gtk.Label({ label: 'other.ts' }), { title: 'other.ts' });
  revealGitPanel(center, git);
  assertShownInCenter(center, git, 'after split + reveal');
});

test('does not vanish when its tab was dragged into a dock (the regression)', () => {
  const center = new PanelGroup();
  const dock = new Panel();
  const window = new Gtk.Window();
  const outer = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
  outer.append(center.root);
  outer.append(dock.root);
  window.setChild(outer);

  const git = makeGitRoot();
  // End-state of an Adw tab drag from the center into the dock: the git panel is a live
  // page in the dock (a Panel outside the center), tracked by Panel.containing.
  dock.add(git);
  assert.equal(Panel.containing(git), dock, 'git panel is hosted by the dock');
  assert.ok(git.getRoot(), 'and live in the window');

  // git-panel:focus: center.reveal can't find it (it's in a dock). The OLD logic
  // unparented this live child and then crashed re-adding it, orphaning the panel
  // (it vanished). The fix reveals it where it lives — never unparenting a live child.
  assert.equal(revealGitPanel(center, git), 'host', 'revealed in place, not re-added');
  assert.equal(dock.tabCount, 1, 'the dock page is intact (not an orphaned/zombie page)');
  assertShownSomewhere(git, 'after reveal');
});
