/*
 * WorkbenchManager — the per-person workbench lifecycle: it owns the `workbenches` map
 * (the user + each agent) and which one is active, builds a person's workbench (its
 * pooled GitRepo + center + Files tree + bottom-dock widgets, handed to a `Workbench`),
 * activates one (swapping which the window shows), cycles between them, and re-roots an
 * agent's workbench when it moves into a git worktree. Pulled out of AppWindow so the
 * shell only composes.
 *
 * Nothing is shared or reparented across workbenches, so a switch never reparents — it
 * just re-points `active` and refreshes the chrome. The panel-tree spine (`PaneItems`)
 * and the view layer / header / window columns are injected; the late-bound ones are
 * lazy getters since `build` runs during AppWindow construction before they exist.
 */
import * as Path from 'node:path';
import type Gtk from 'gi:Gtk-4.0';
import { zym } from '../../zym.ts';
import { Workbench } from './Workbench.ts';
import type { Agent } from '../../agents/types.ts';
import type { PaneItems } from './PaneItems.ts';
import type { WorkbenchView } from './WorkbenchView.ts';
import type { HeaderBar } from '../HeaderBar.ts';
import type { Sidebar } from '../Sidebar.ts';
import { FileTree } from '../FileTree.ts';
import { Panel } from '../Panel.ts';
import { NotificationLog } from '../NotificationLog.ts';
import { DiagnosticsPanel } from '../../lsp/diagnostics/DiagnosticsPanel.ts';
import { KeymapPanel } from '../KeymapPanel.ts';
import { fileIconGlyph } from '../fileIcons.ts';
import { acquireGitRepo, releaseGitRepo, invalidateRepoRoot } from '../../git.ts';
import { type Owner, type Project, isProject } from './Owner.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;
type Wb = Workbench<Owner>;

export interface WorkbenchManagerDeps {
  paneItems: PaneItems;
  getWorkbenchView: () => WorkbenchView;
  getHeaderBar: () => HeaderBar;
  getContentOverlay: () => Overlay;
  getSidebar: () => Sidebar;
  /** The agent whose workbench is active, if any (drives the agent secondary sidebar). */
  activeAgent: () => Agent | null;
  /** Run after a switch settles (mark the now-active agent viewed). */
  onActivated: () => void;
}

export class WorkbenchManager {
  private readonly d: WorkbenchManagerDeps;
  private activeWorkbench!: Wb;
  // Every owner (each project, each agent) owns a self-contained `Workbench`; switching
  // owner just swaps which one the overlay shows. Keyed by owner.
  readonly workbenches = new Map<Owner, Wb>();
  // The open project owners, in rail order (the first is the primary). Agents live in
  // `zym.agents`; this is the projects half of the rail's `[...projects, ...agents]`.
  readonly projects: Project[] = [];

  constructor(deps: WorkbenchManagerDeps) {
    this.d = deps;
  }

  /** The primary (first-opened) project — the fallback owner to activate when an
   *  agent workbench closes, and the session's primary root. */
  get primaryProject(): Project {
    return this.projects[0];
  }

  /** The active workbench (the one the window currently shows). */
  get active(): Wb {
    return this.activeWorkbench;
  }

  /** Set the active workbench without the activation side effects — the initial seed,
   *  before the chrome that `activateWorkbench` refreshes even exists. */
  setActive(workbench: Wb): void {
    this.activeWorkbench = workbench;
  }

  /**
   * Build a person's workbench rooted at `cwd`: acquire the (pooled) GitRepo for that
   * root, construct its own center, Files tree, and bottom-dock widgets, then hand them
   * to a `Workbench` (which docks the center, and the Files side dock for the user).
   * Source Control is created lazily on first reveal. Nothing is shared with other
   * workbenches, so a switch never reparents. Registers and returns the `Workbench`.
   */
  buildWorkbench(owner: Owner, cwd: string): Wb {
    const git = acquireGitRepo(cwd);
    const center = this.d.paneItems.makeCenter();
    const fileTree = new FileTree({
      rootPath: cwd,
      onOpenFile: (path) => this.d.paneItems.openFile(path),
      git,
    });
    // The file tree is the only tab in this right-side dock. Source Control (GitPanel)
    // is created lazily on first reveal and opens as a center tab — not here. The dock
    // collapses out of the workbench when its last tab closes; the closure captures this
    // workbench's own `leftPanel`.
    const leftPanel = new Panel({ onEmpty: () => this.d.getWorkbenchView().detachDock(leftPanel) });
    const filesTab = leftPanel.add(fileTree.root, { title: `${fileIconGlyph('', true)}  Files` });
    filesTab.select();

    // Each bottom dock is a single persistent view: closing its tab hides the dock (its
    // toggle brings it back) rather than destroying the page, so its widget/state survive
    // and reopening never shows an empty panel.
    const notificationLog = new NotificationLog();
    const notificationPanel = new Panel({ onTabCloseRequest: () => this.d.getWorkbenchView().hideBottomDock('notifications') });
    notificationPanel.add(notificationLog.root, { title: 'Notifications' });
    // Scope this workbench's diagnostics to the files under its root (read live via
    // `owner`, so a re-root re-scopes it).
    const diagnosticsPanel = new DiagnosticsPanel(
      (target) => this.d.paneItems.openOrFocusFile(target.path, [target.line, target.character]),
      (path) => this.ownerWorkbenchCwd(path) === this.workbenches.get(owner)?.cwd,
    );
    const diagnosticsDock = new Panel({ onTabCloseRequest: () => this.d.getWorkbenchView().hideBottomDock('diagnostics') });
    diagnosticsDock.add(diagnosticsPanel.root, { title: 'Diagnostics' });
    const keymapPanel = new KeymapPanel();
    const keymapDock = new Panel({ onTabCloseRequest: () => this.d.getWorkbenchView().hideBottomDock('keymap') });
    keymapDock.add(keymapPanel.root, { title: 'Keybindings' });

    const workbench = new Workbench<Owner>(
      owner,
      {
        cwd, git, center, fileTree, leftPanel, filesTab,
        notificationLog, notificationPanel, diagnosticsPanel, diagnosticsDock,
        keymapPanel, keymapDock,
      },
      { showSideDock: isProject(owner) },
    );
    // The workbench owns its runtime action set (seeded from `<cwd>/.zym/settings.json`,
    // overwritable by an agent, run from `space x`); wire the terminal-action runner so a
    // `terminal` action runs in a tab here and reports its run/stop state, and prune
    // orphaned action tabs when the set shrinks. The subscriptions live on plain-JS
    // emitters collected with the workbench on dispose — hence the explicit `void` discard.
    workbench.actions.setTerminalRunner({
      run: (action) => this.d.paneItems.runWorkbenchActionInTerminal(workbench, action),
      stop: (actionId) => this.d.paneItems.findActionTerminal(workbench, actionId)?.terminal.kill(),
      isRunning: (actionId) => (this.d.paneItems.findActionTerminal(workbench, actionId)?.terminal.pid ?? null) !== null,
      onDidChangeRunning: (cb) => {
        const sub = this.d.paneItems.onActionTerminalChange((wb) => { if (wb === workbench) cb(); });
        return () => sub.dispose();
      },
    });
    void workbench.actions.onDidChange(() => this.d.paneItems.pruneActionTerminals(workbench));
    this.workbenches.set(owner, workbench);
    if (isProject(owner) && !this.projects.includes(owner)) this.projects.push(owner);
    return workbench;
  }

  /** Activate the workbench owned by `owner`. */
  activateOwner(owner: Owner): void {
    const workbench = this.workbenches.get(owner);
    if (workbench) this.activateWorkbench(workbench);
  }

  // Step the active workbench by `step` (−1 / +1) through the workbench-list order
  // ([…projects, …agents]), wrapping around. No-op with a single owner.
  cycleWorkbench(step: number): void {
    const owners: Owner[] = [...this.projects, ...zym.agents.getAgents()];
    if (owners.length < 2) return;
    const current = owners.indexOf(this.activeWorkbench.owner);
    const next = (current + step + owners.length) % owners.length;
    this.activateOwner(owners[next]);
  }

  /**
   * Activate `workbench`: make it the visible one. Nothing is reparented — every slot
   * already belongs to it; the previously-active workbench is detached but alive (its
   * tabs/terminal/editor state persist). All per-person state lives on the workbench
   * itself, so there's nothing to save/restore on switch.
   */
  activateWorkbench(workbench: Wb): void {
    this.activeWorkbench = workbench;
    this.d.getContentOverlay().setChild(workbench.root); // show this workbench
    this.d.getSidebar().list.selectAgent(isProject(workbench.owner) ? null : workbench.owner);
    this.d.getHeaderBar().rebind(); // header branch/GitHub now reflect this workbench's root
    this.d.getHeaderBar().refreshStatus(); // diagnostics pill + LSP indicator → this workbench
    this.d.getWorkbenchView().showAgentSidebar(this.d.activeAgent()); // reveal/hide this workbench's agent column
    this.d.onActivated();
    this.d.getWorkbenchView().focusActivePane();
  }

  // The open workbench whose root (cwd) most specifically contains `path` — the longest
  // matching prefix, so a file (or server root) inside a nested worktree is owned by that
  // worktree, not its parent. Paths under no open root fall to the user workbench. Used
  // to scope per-workbench diagnostics + the header LSP status.
  ownerWorkbenchCwd(path: string): string {
    let best = process.cwd(); // user workbench root / fallback for orphan paths
    for (const wb of this.workbenches.values()) {
      if (isUnderRoot(path, wb.cwd) && wb.cwd.length > best.length) best = wb.cwd;
    }
    return best;
  }

  // Re-root an agent's workbench after it moves into a worktree: swap the pooled GitRepo
  // and re-root the file tree + Source Control in place (the widgets/tabs stay put); if
  // it's the active workbench, re-point the header chrome too.
  reRootWorkbench(workbench: Wb, newCwd: string): void {
    if (newCwd === workbench.cwd) return;
    // The worktree at newCwd may have been probed (and cached) as a non-repo before it
    // existed; drop that stale entry so repoRoot resolves the new checkout.
    invalidateRepoRoot(newCwd);
    const oldGit = workbench.git;
    const git = acquireGitRepo(newCwd); // acquire before release: a shared root keeps its repo
    workbench.cwd = newCwd;
    workbench.git = git;
    workbench.fileTree.setRoot(newCwd, git);
    workbench.gitPanel?.setRoot(newCwd, git); // null until lazily created; it'll pick up the new root on creation
    // Re-point the gutters of editors already open in this workbench at the new repo.
    this.d.paneItems.repointGutters(workbench, git);
    releaseGitRepo(oldGit);
    if (this.activeWorkbench === workbench) this.d.getHeaderBar().rebind();
    // Diagnostics ownership shifts on a re-root (paths under the old/new root change
    // hands), so re-scope every workbench's panel and the active header status.
    for (const wb of this.workbenches.values()) wb.diagnosticsPanel.refresh();
    this.d.getHeaderBar().refreshStatus();
  }

  /** Dispose every workbench (window teardown) — each owns its dock/center Panels +
   *  content and a refcounted pooled git repo, freed as a unit. */
  dispose(): void {
    for (const wb of this.workbenches.values()) wb.dispose();
  }
}

// Whether `path` is `root` itself or lives beneath it (a `root + sep` prefix, so
// `/a/bc` doesn't count as under `/a/b`).
function isUnderRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(Path.sep) ? root : root + Path.sep);
}
