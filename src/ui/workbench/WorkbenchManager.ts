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
import { type Owner, type Project, isProject, createProject } from './Owner.ts';
import { Emitter, type Disposable } from '../../util/eventKit.ts';

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
  /** Schedule a session autosave (a project's action-set change isn't a tab/layout
   *  change, so it needs its own nudge to reach the persisted session state). */
  scheduleAutosave: () => void;
  /** Close an agent for good (terminate + drop its workbench) — closing a project
   *  closes the agents launched under it. */
  closeAgent: (agent: Agent) => void;
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
  // Which project each agent belongs to — the project active when the agent was
  // launched. Kept explicit (rather than derived from the agent's cwd) since it's known
  // directly at launch and survives the agent re-rooting into a worktree. Drives the
  // rail grouping. A fresh agent also roots in this project (see activeProjectRoot).
  private readonly agentProject = new Map<Agent, Project>();
  private readonly emitter = new Emitter();

  constructor(deps: WorkbenchManagerDeps) {
    this.d = deps;
  }

  /** Notified when the owner set changes (project opened/closed, agent workbench built
   *  or removed) so the rail can rebuild. */
  onDidChangeProjects(callback: () => void): Disposable {
    return this.emitter.on('did-change-projects', callback);
  }

  /** The primary (first-opened) project — the fallback owner to activate when an
   *  agent workbench closes, and the session's primary root. */
  get primaryProject(): Project {
    return this.projects[0];
  }

  /** The project an owner belongs to: a project is itself; an agent is the project it
   *  was launched under (else the primary). */
  projectOf(owner: Owner): Project {
    return isProject(owner) ? owner : (this.agentProject.get(owner) ?? this.primaryProject);
  }

  /** The active workbench's project (the launch context for a new agent). */
  activeProject(): Project {
    return this.projectOf(this.activeWorkbench.owner);
  }

  /** The rail's grouped view: each project with the agents that belong to it (launch
   *  order). An agent whose project was closed is regrouped under the primary. */
  projectGroups(): { project: Project; agents: Agent[] }[] {
    const agents = zym.agents.getAgents();
    return this.projects.map((project) => ({
      project,
      agents: agents.filter((agent) => this.projectOf(agent) === project),
    }));
  }

  /** Every owner in the exact order the rail shows them (each project then its agents),
   *  so the workbench cycle (`super-,` / `.`) steps in sidebar order. */
  orderedOwners(): Owner[] {
    const owners: Owner[] = [];
    for (const { project, agents } of this.projectGroups()) owners.push(project, ...agents);
    return owners;
  }

  /** The active project's root — where a freshly-launched agent roots (its process spawn
   *  dir, editor, and transcript home), rather than the global primary. */
  activeProjectRoot(): string {
    return this.workbenches.get(this.activeProject())?.cwd ?? process.cwd();
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
    void workbench.actions.onDidChange(() => {
      this.d.paneItems.pruneActionTerminals(workbench);
      // A project's action-set change (reset / edit / a plugin) belongs in the session;
      // agents' set_actions are transient (re-reported on resume), so don't autosave those.
      if (isProject(owner)) this.d.scheduleAutosave();
    });
    this.workbenches.set(owner, workbench);
    if (isProject(owner)) {
      if (!this.projects.includes(owner)) this.projects.push(owner);
    } else {
      // Associate the agent with the project active at launch (its workbench + the
      // active context both exist now, before activateWorkbench switches away).
      this.agentProject.set(owner, this.activeProject());
    }
    // Fired after the workbench + any agent association exist, so a rail rebuild groups
    // it correctly (the agent's own `did-add-agent` fires from its constructor, before
    // this workbench was built — too early to group).
    this.emitter.emit('did-change-projects');
    return workbench;
  }

  /** Activate the workbench owned by `owner`. */
  activateOwner(owner: Owner): void {
    const workbench = this.workbenches.get(owner);
    if (workbench) this.activateWorkbench(workbench);
  }

  /** Open a project rooted at `root` (building its workbench), or return the already-open
   *  one for that root (dedup). The caller activates it. Fires `did-change-projects`. */
  addProject(root: string): Project {
    const existing = this.projects.find((p) => this.workbenches.get(p)?.cwd === root);
    if (existing) return existing;
    const project = createProject(root);
    this.buildWorkbench(project, root); // registers into projects[] + workbenches (+ emits)
    return project;
  }

  /** Close a project and every workbench under it — the agents launched under it plus
   *  its own default workbench (editors + action terminals). Never closes the last
   *  project; an active project hands off to another first. Fires `did-change-projects`. */
  closeProject(project: Project): void {
    if (this.projects.length <= 1) return; // always keep at least one project open
    const workbench = this.workbenches.get(project);
    if (!workbench) return;
    // If the active owner belongs to this project (its default or one of its agents),
    // switch to another project first — so nothing we're about to dispose is active
    // (and closing the agents below never re-activates a workbench we're tearing down).
    const fallback = this.projects.find((p) => p !== project) ?? this.primaryProject;
    if (this.projectOf(this.activeWorkbench.owner) === project) this.activateOwner(fallback);
    // Close the agents launched under this project (each tears down its own workbench).
    // `getAgents()` is a snapshot, so closing — which mutates the registry — is safe.
    for (const agent of zym.agents.getAgents()) {
      if (this.agentProject.get(agent) === project) {
        this.agentProject.delete(agent);
        this.d.closeAgent(agent);
      }
    }
    const i = this.projects.indexOf(project);
    if (i >= 0) this.projects.splice(i, 1);
    this.workbenches.delete(project);
    this.d.paneItems.disposeWorkbenchActionTerminals(workbench);
    this.d.paneItems.disposeWorkbenchEditors(workbench);
    workbench.dispose(); // tears down its Panels/content + releases its pooled git repo
    this.emitter.emit('did-change-projects');
  }

  /** Close every non-primary project (a session switch resets to the primary root). */
  closeNonPrimaryProjects(): void {
    for (const project of this.projects.slice(1)) this.closeProject(project);
  }

  // Step the active workbench by `step` (−1 / +1) through the rail order (each project
  // then its agents), wrapping around. No-op with a single owner.
  cycleWorkbench(step: number): void {
    const owners = this.orderedOwners();
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
    this.d.getSidebar().list.selectOwner(workbench.owner);
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
