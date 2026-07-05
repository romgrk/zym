/*
 * AppWindow — the top-level application window. It owns the window chrome (the
 * Adwaita header bar, via Adw.ToolbarView), the toast overlay, and the
 * floating-picker overlay host. It composes the workbench docks: the file tree
 * in the left dock and the splittable center PanelGroup (a tree of editor
 * groups, one tab per open file). Actions and accelerators are routed to the
 * active split's active tab; the window title follows it. (Vim mode state is
 * shown in the editor widget itself.)
 *
 * One window per application instance. It is given the Adw.Application (for
 * registering actions/accelerators) and an `onQuit` callback so it never has to
 * know how the application shuts itself down.
 */
import * as Path from 'node:path';
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
type Application = InstanceType<typeof Adw.Application>;
type ApplicationWindow = InstanceType<typeof Adw.ApplicationWindow>;
type ToastOverlay = InstanceType<typeof Adw.ToastOverlay>;
import { ensureProjectSettingsFile } from '../projectSettings.ts';
import { openActionRunner } from './workbench/ActionPicker.ts';
import { Sidebar } from './Sidebar.ts';
import { AgentSidebar } from './AgentSidebar.ts';
import { HeaderBar } from './HeaderBar.ts';
import { repoRoot } from '../git.ts';
import { openCommitDiff, openCommitPicker, openBranchDiff } from './diffViews.ts';
import { Workbench, DOCK_SIDES } from './workbench/Workbench.ts';
import { type Owner, type Project, createProject, isProject } from './workbench/Owner.ts';
import { openFolderPicker } from './FileOpener.ts';
import { openScriptRunner } from './ScriptRunner.ts';
import { openDiffFilePicker } from './DiffFilePicker.ts';
import { openDiffCollapseGlobPicker } from './DiffCollapseGlobPicker.ts';
import { openSearchPicker } from './SearchPicker.ts';
import { openCommandPicker } from './CommandPicker.ts';
import { openThemePicker } from './ThemePicker.ts';
import { saveConfig } from '../config/load.ts';
import { WhichKey } from './WhichKey.ts';
import { openWorkbenchPicker } from './WorkbenchPicker.ts';
import { confirmUnsavedWork } from './confirmUnsavedWork.ts';
import { openBranchPicker } from './git/BranchPicker.ts';
import { openGithubCIChecksPicker } from './GithubCIChecksPicker.ts';
import { openConfigEditor } from './ConfigEditor.ts';
import { zym } from '../zym.ts';
import { type SessionParticipant, type SessionState, type ProjectState, type WorkbenchState, type AgentState, type TabState } from '../SessionManager.ts';
import { SessionController, type SessionDocks } from '../SessionController.ts';
import { type RestoredChild } from './PanelGroup.ts';
import { type Notification } from '../Notification.ts';
import { type LspConfig } from '../lsp/LspManager.ts';
import { NotificationToasts } from './NotificationToasts.ts';
import { loadKeymaps, ensureUserKeymap } from '../keymaps/load.ts';
import { loadConfig, configPath } from '../config/load.ts';
import { setUserInjectionRules } from '../syntax/grammar.ts';
import { parseInjectionRules } from '../syntax/userInjections.ts';
import { type DisposableLike } from '../util/eventKit.ts';
import { applyNotificationStyles } from './chromeStyles.ts';
import { addStyles } from '../styles.ts';
import { registerLspCommands } from './lspCommands.ts';
import { registerGitCommands } from './git/gitCommands.ts';
import { registerFileCommands } from './fileCommands.ts';
import { registerSessionCommands } from './sessionCommands.ts';
import { WorkbenchView, SIDEBAR_WIDTH, AGENT_SIDEBAR_WIDTH } from './workbench/WorkbenchView.ts';
import { PaneItems } from './workbench/PaneItems.ts';
import { WorkbenchManager } from './workbench/WorkbenchManager.ts';
import { AgentController } from './AgentController.ts';

const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 950;
const TOAST_TIMEOUT = 15;

addStyles(/* css */`
  .AppWindow--paned > separator { opacity: 0; }
`)

type Widget = InstanceType<typeof Gtk.Widget>;

export class AppWindow {
  private readonly app: Application;
  private readonly onQuit: () => void;

  // The tab/item-registry spine: every center-tab registry (editors, terminals, headless
  // agents, project-search / diff surfaces, action terminals) + their lifecycle, the
  // shared DocumentRegistry, and the `openFile` funnel. AppWindow delegates to it and
  // `zym.workspace` is backed by it. Built in the constructor.
  private readonly paneItems: PaneItems;
  // The agent feature: launch/close/restart/resume/branch, send-to-agent + review
  // routing, sessions, and the `agent:*` commands. Owns the per-agent subscriptions.
  private readonly agentController: AgentController;

  // The workbench sidebar: the full-height `.WorkbenchSidebar` column at the very left
  // of the window. Owns the `WorkbenchList` (`this.sidebar.list`); it's the start child
  // of `sidebarPaned`, whose width this window toggles on collapse/expand.
  private readonly sidebar: Sidebar;
  // Set once the user has confirmed an exit past unsaved work, so the re-entrant
  // close-request doesn't prompt again.
  private quitting = false;
  // The agent "secondary sidebar": a full-height column (its own header + a Gtk.Stack
  // of every open agent's widget) between the WorkbenchList and the content. Shown for
  // an agent workbench, hidden for the user's — toggled by attaching/detaching it from
  // `agentPaned` (whose position is its resizable width).
  private readonly agentSidebar: AgentSidebar;
  private readonly agentPaned: InstanceType<typeof Gtk.Paned>;
  private readonly toastOverlay: ToastOverlay;
  // Content-area overlay: hosts the active workbench (swapped on agent switch) and
  // the notification toasts — floats below the header bar, right of the sidebar.
  private readonly contentOverlay: InstanceType<typeof Gtk.Overlay>;
  // The top-level horizontal split: the full-height sidebar column on the start side,
  // the window content (header bar + workbench, wrapped by the toast overlay) on the
  // end. Its position is the sidebar width; `sidebar:toggle` hides/shows the column.
  private readonly sidebarPaned: InstanceType<typeof Gtk.Paned>;
  // Window-level overlay wrapping everything (sidebar + header + content): the host
  // for floating pickers, so they cover the whole window rather than just the content.
  private readonly overlay: InstanceType<typeof Gtk.Overlay>;
  private readonly window: ApplicationWindow;

  // Transient notification toasts, stacked in the bottom-right of the content
  // overlay (severity-colored). The log keeps the full history; these come and go.
  private readonly notificationToasts: NotificationToasts;

  // Every person (the user, each agent) owns a self-contained `Workbench` — its own
  // splittable center, Files/Source-Control, and bottom docks (see buildWorkbench).
  // Nothing is shared or reparented across workbenches; switching person just swaps
  // which one the overlay shows (activateWorkbench). `this.workbench` is the active
  // one; the rest live in `workbenches`, keyed by owner. All per-person state is read
  // straight off `this.workbench.*`.
  // Per-person workbench lifecycle: the `workbenches` map + the active one, plus
  // build / activate / cycle / re-root. AppWindow exposes the active workbench and the
  // map through getters so the rest of the shell reads them unchanged.
  private readonly workbenchManager: WorkbenchManager;
  private get workbench(): Workbench<Owner> { return this.workbenchManager.active; }
  private get workbenches(): Map<Owner, Workbench<Owner>> { return this.workbenchManager.workbenches; }

  // The window's Adwaita header bar: the branch button + GitHub PR/CI pill and the
  // per-workbench health cluster (diagnostics + LSP). It owns the git-chrome
  // lifecycle (rebind on workbench switch, upstream-behind prompt, auto-fetch); the
  // GitRepo it reflects lives on the active workbench (`this.workbench.git`).
  private readonly headerBar: HeaderBar;

  // Watches the user config file and syncs edits into zym.config; cancelled on
  // close.
  private readonly configWatcher: DisposableLike;
  // Watches the user keymap file and re-registers it live; cancelled on close.
  private readonly keymapWatcher: DisposableLike;
  // which-key hint overlay (continuations after a queued keymap prefix).
  private readonly whichKey: WhichKey;

  // The active workbench's view layer: sidebars, docks, keyboard-focus memory, and
  // directional/cyclic pane navigation. Constructed once the window-level columns
  // (sidebar/agent paneds) exist; reads the active workbench lazily.
  private readonly workbenchView: WorkbenchView;

  // Drives session save/restore/autosave; wired once the center + file tree exist.
  private sessionController!: SessionController;

  constructor(app: Application, onQuit: () => void, initialFile: string | undefined) {
    this.app = app;
    this.onQuit = onQuit;

    this.toastOverlay = new Adw.ToastOverlay();

    // The tab/item-registry spine. Built first — `buildWorkbench` below makes each
    // person's center through it. Its deps are lazy closures over `this`, so they
    // resolve the active workbench / sidebar once those exist.
    this.paneItems = new PaneItems({
      getWorkbench: () => this.workbench,
      activateWorkbench: (workbench) => this.workbenchManager.activateWorkbench(workbench),
      activateNeighborOf: (owner) => this.workbenchManager.activateOwner(
        this.workbenchManager.fallbackOwner(owner) ?? this.workbenchManager.primaryProject),
      onActiveTabChanged: () => this.onActiveTabChanged(),
      onReview: (message) => this.agentController.reviewToAgent(message),
      setModified: (modified) => this.sidebar.list.setModified(modified),
    });
    // Per-person workbench lifecycle. Its view/header/window-column deps are lazy
    // getters since `buildWorkbench` runs below before those exist.
    this.workbenchManager = new WorkbenchManager({
      paneItems: this.paneItems,
      getWorkbenchView: () => this.workbenchView,
      getHeaderBar: () => this.headerBar,
      getContentOverlay: () => this.contentOverlay,
      getSidebar: () => this.sidebar,
      activeAgent: () => this.agentController.activeAgent,
      onActivated: () => this.agentController.updateViewedAgent(),
      scheduleAutosave: () => this.sessionController.scheduleAutosave(),
      closeAgent: (agent) => this.agentController.closeAgent(agent),
    });

    // Build the user's workbench first — its own center + Files/Source-Control +
    // bottom docks, and the (pooled) GitRepo for the window cwd that the header
    // chrome below binds to. Agents get their own (openAgent); no widget is shared
    // across workbenches, so a switch reparents nothing.
    const primaryProject = createProject(process.cwd());
    const userWorkbench = this.workbenchManager.buildWorkbench(primaryProject, process.cwd());
    this.workbenchManager.setActive(userWorkbench); // the active workbench until an owner is switched
    // Publish the active-workbench provider now, before any consumer (the header bar
    // below) reads it; activateWorkbench just re-points the active one behind it.
    zym.workspace.setActiveWorkbenchProvider(() => this.workbench);

    // The header bar's git chrome targets the *active* workbench's git/cwd;
    // activateWorkbench re-points it (headerBar.rebind) on a person switch. The
    // click/picker closures read the active workbench / `this.overlay` lazily, so
    // they always act on the workbench shown when invoked.
    this.headerBar = new HeaderBar({
      getWorkbench: () => zym.workspace.getActiveWorkbench()!,
      onBranchPicker: () => openBranchPicker(this.overlay, this.workbench.cwd, this.workbench.git),
      onShowChecks: () => openGithubCIChecksPicker(this.overlay, this.workbench.cwd),
      onOpenDiagnostics: () => this.workbenchView.toggleDiagnosticsPanel(),
      onOpenLog: () => this.workbenchView.toggleNotificationLog(),
      // Pill + LSP indicator scope to the active workbench's worktree.
      ownsPath: (path) => this.workbenchManager.ownerWorkbenchCwd(path) === this.workbench.cwd,
      ownsServer: (rootDir) => this.workbenchManager.ownerWorkbenchCwd(rootDir) === this.workbench.cwd,
    });

    // Session save/restore/autosave. The controller owns the envelope + persistence
    // policy; the per-project widget walk (serialize all projects, rebuild them on
    // restore) lives here in AppWindow, which holds the collaborators. The builders
    // construct (but don't attach) a tab during restore; PanelGroup.restoreLayout places
    // them into the tree.
    this.sessionController = new SessionController({
      createEditorTab: (path, restore) => this.paneItems.createEditorTab(path, restore),
      createTerminalTab: (cwd) => this.paneItems.createTerminalTab(cwd),
      serializeProjects: () => this.serializeProjects(),
      getActive: () => this.activeOwnerRef(),
      restoreSession: (state, buildChild) => this.restoreSession(state, buildChild),
      getDocks: () => ({
        notificationLog: this.workbench.bottomDock === 'notifications',
        visible: this.workbench.dockVisibility(),
        sizes: this.workbench.dockSizes(),
      }),
      getWindow: () => ({
        width: this.window.getWidth(),
        height: this.window.getHeight(),
        maximized: this.window.isMaximized(),
      }),
      // Cache the unsaved contents of modified editors so a restore brings them back
      // (unsavedSnapshot also covers a restored tab not yet reopened).
      collectUnsaved: () =>
        this.paneItems.allEditors().flatMap((e) => {
          const text = e.unsavedSnapshot();
          return e.currentFile && text !== null ? [{ path: e.currentFile, text }] : [];
        }),
      // session:open replace-semantics teardown: drop the current window's agents and
      // any extra projects so applying the target session is deterministic (agentController
      // is late-bound below).
      closeAllAgents: () => {
        this.agentController.closeAllAgents();
        this.workbenchManager.closeNonPrimaryProjects();
      },
      // Reflect the active session name in the window title + sidebar header.
      onNameChange: (name) => this.applySessionName(name),
    });

    const toolbarView = new Adw.ToolbarView();
    toolbarView.addTopBar(this.headerBar.root);
    // Content-area overlay: wraps the active workbench (below the header bar, right
    // of the sidebar) and hosts the toasts. Pickers use the window-level overlay
    // built below instead, so they aren't clipped to the content.
    this.contentOverlay = new Gtk.Overlay();
    this.contentOverlay.setChild(this.workbench.root);
    // Notification toasts float in the bottom-right of the content area.
    this.notificationToasts = new NotificationToasts({ timeout: TOAST_TIMEOUT });
    this.contentOverlay.addOverlay(this.notificationToasts.root);
    toolbarView.setContent(this.contentOverlay);
    this.toastOverlay.setChild(toolbarView);

    // Workbench sidebar: a full-height column (`.WorkbenchSidebar`) at the very left of
    // the window, *outside* the header bar. The Sidebar owns the WorkbenchList; its
    // agent callbacks route into the active-workbench machinery, and the list's robot
    // button forwards collapse/expand here to resize the split below.
    this.sidebar = new Sidebar({
      onActivate: (agent) => this.agentController.showAgent(agent),
      onActivateProject: (project) => this.workbenchManager.activateOwner(project),
      getGroups: () => this.workbenchManager.projectGroups(),
      onProjectsChanged: (cb) => this.workbenchManager.onDidChangeProjects(cb),
      onRestart: (agent) => this.agentController.restartAgent(agent),
      onStop: (agent) => agent.kill(),
      onClose: (agent) => this.agentController.closeAgent(agent),
      onRename: (agent) => this.agentController.renameAgentPrompt(agent),
      onOpenChanges: (agent) => this.agentController.openAgentChanges(agent),
    });

    // The agent "secondary sidebar" sits between the WorkbenchList and the content,
    // also full-height (outside the header). Its own split (`agentPaned`) gives it a
    // resizable width; it starts detached (start child null) — the user workbench shows
    // no agent — and AppWindow attaches/detaches it on workbench switch. Window resize
    // grows the content, not the agent column.
    this.agentSidebar = new AgentSidebar({
      onOpenChanges: (agent) => this.agentController.openAgentChanges(agent), // the header's edited-files button
    });
    this.agentPaned = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
    this.agentPaned.addCssClass('AppWindow--paned'); // hide the handle; the sidebar's own border is the divider
    this.agentPaned.setEndChild(this.toastOverlay);
    this.agentPaned.setPosition(AGENT_SIDEBAR_WIDTH);
    this.agentPaned.setResizeStartChild(false);
    this.agentPaned.setShrinkStartChild(false);
    // Remember a dragged width so it survives switching away and back.
    this.agentPaned.on('notify::position', () => {
      if (this.agentPaned.getStartChild()) this.workbenchView.rememberAgentSidebarWidth(this.agentPaned.getPosition());
    });

    // Top-level horizontal split: the full-height WorkbenchList column on the start side,
    // the agent column + content (header bar + workbench, wrapped by the toast overlay)
    // on the end, so the columns span from the window's top edge to its bottom. Window
    // resize grows the content, not the sidebar; the split position is the toggled width.
    this.sidebarPaned = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
    this.sidebarPaned.addCssClass('AppWindow--paned');
    this.sidebarPaned.setStartChild(this.sidebar.root);
    this.sidebarPaned.setEndChild(this.agentPaned);
    this.sidebarPaned.setPosition(SIDEBAR_WIDTH);
    this.sidebarPaned.setResizeStartChild(false);
    this.sidebarPaned.setShrinkStartChild(false);

    // Window-level overlay over the whole layout (sidebar + header + content), so
    // floating pickers cover the entire window rather than being clipped to the
    // content area (where they slid under the sidebar).
    this.overlay = new Gtk.Overlay();
    this.overlay.setChild(this.sidebarPaned);

    // Bridge the notification manager to the toast stack. Only actionable
    // User-facing severities (info/success/warning/error/fatal) pop a transient
    // toast; only `trace` (the debug level) is log-only, so traces never interrupt.
    // The manager retains the full history for the log regardless.
    const TOAST_TYPES = new Set(['info', 'success', 'warning', 'error', 'fatal']);
    zym.notifications.onDidAddNotification((n) => {
      const notification = n as Notification;
      if (TOAST_TYPES.has(notification.getType())) this.notificationToasts.show(notification);
    });

    applyNotificationStyles();

    this.window = new Adw.ApplicationWindow({ application: app });
    this.window.addCssClass('AppWindow');
    this.window.setTitle(this.projectTitle()); // OS taskbar label — the project, not the bare "node"
    this.window.setDefaultSize(DEFAULT_WIDTH, DEFAULT_HEIGHT);
    this.window.setContent(this.overlay);

    // The active workbench's view layer (sidebars, docks, focus, pane navigation).
    // Built now that the window-level columns exist; it reads the active workbench
    // and the panel-tree operations it needs lazily through these callbacks.
    this.workbenchView = new WorkbenchView({
      window: this.window,
      sidebar: this.sidebar,
      agentSidebar: this.agentSidebar,
      sidebarPaned: this.sidebarPaned,
      agentPaned: this.agentPaned,
      getWorkbench: () => this.workbench,
      activeAgent: () => this.agentController.activeAgent,
      activeEditorFile: () => this.paneItems.activeEditor?.currentFile ?? null,
      focusContent: (widget) => this.paneItems.focusContent(widget),
      openFileView: (path, panel) => this.paneItems.openFileViewIn(path, panel),
      openFile: (path) => this.paneItems.openFile(path),
      buildCurrentChangesDiff: (workbench) => this.paneItems.buildCurrentChangesDiff(workbench),
      setTabCloseHandler: (widget, fn) => this.paneItems.setTabCloseHandler(widget, fn),
      scheduleAutosave: () => this.sessionController.scheduleAutosave(),
      toast: (message) => this.toast(message),
    });
    // The agent feature. Reads the active editor / workbench / picker host off the spine
    // and globals; the two managers + the two agent widgets are its only collaborators.
    this.agentController = new AgentController({
      paneItems: this.paneItems,
      workbenchManager: this.workbenchManager,
      agentSidebar: this.agentSidebar,
      sidebar: this.sidebar,
    });

    // Track the focused widget per panel tab so each panel can restore focus to
    // exactly where it was when it is re-activated (see WorkbenchView focus memory).
    this.window.on('notify::focus-widget', () => this.workbenchView.rememberFocus());
    // A GtkPaned is a layout container and must never hold keyboard focus. Reparenting a
    // focused widget into a freshly-built split — opening a work area beside a focused
    // agent terminal to auto-open an edited file — makes GTK reassign focus onto a bare
    // structural Paned on the next layout pass, pulling it out of wherever the user was.
    // Bounce it straight back to the last real focus the moment it lands on a Paned.
    let lastFocus: Widget | null = null;
    this.window.on('notify::focus-widget', () => {
      const f = this.window.getFocus();
      const onPaned = !!f && (f instanceof Gtk.Paned || f.constructor?.name === 'GtkPaned');
      if (onPaned) {
        if (lastFocus && lastFocus.getRoot() !== null) lastFocus.grabFocus();
        return; // never record the Paned itself as a restore target
      }
      lastFocus = f;
    });

    // Publish the window on the global registry and start the keymap manager's
    // CAPTURE-phase key controller.
    zym.window = this.window;
    // Expose file-opening app-wide (reveal-if-open by default — see PaneItems.openFile).
    zym.workspace.setOpener((path, options) => {
      const editor = this.paneItems.openFile(path);
      if (options?.cursor) editor.restoreCursor(options.cursor);
    });
    zym.workspace.setActiveEditorProvider(() => this.paneItems.activeEditor);
    // Expose closed-tab reopening app-wide; the history stack lives on the workspace.
    zym.workspace.setTabReopener((state) => this.paneItems.reopenTab(state));
    zym.workspace.setTabHost((widget, options) => this.paneItems.openCenterTab(widget, options));
    // Expose diff-review delivery app-wide so the decoupled commit/branch diff views (diffViews.ts)
    // can route comments to an agent without reaching into the AppWindow.
    zym.workspace.setReviewSink((message) => this.agentController.reviewToAgent(message));
    // The window-level overlay floating pickers mount into, and the workspace-edit
    // applier (its impl owns the editor registry) — app-wide so command modules reach
    // for the `zym.workspace` global instead of being handed these on every call.
    zym.workspace.setPickerHost(this.overlay);
    zym.workspace.setWorkspaceEditApplier((edit, encoding) => this.paneItems.applyWorkspaceEdit(edit, encoding));
    zym.keymaps.initialize();
    // which-key hint: shows the continuations after a queued prefix (e.g. Space).
    this.whichKey = new WhichKey(this.contentOverlay);
    // Components register their commands; the keymap (bindings) is loaded
    // centrally from src/keymaps (default table + optional user override).
    this.registerPaneCommands();
    this.registerWindowCommands();
    this.registerTerminalCommands();
    this.agentController.registerCommands();
    // The command modules read the active editor / workbench / picker host / file-open
    // straight off the `zym` globals (Atom-style); only their genuinely module-specific
    // collaborators are injected here.
    registerFileCommands({ activeSavableSurface: () => this.paneItems.activeSavableSurface() });
    registerGitCommands({ github: this.headerBar.github });
    this.registerNotificationCommands();
    this.registerConfigCommands();
    registerSessionCommands({ sessionController: this.sessionController });
    registerLspCommands({ documents: this.paneItems.documents });
    this.keymapWatcher = loadKeymaps();

    // Seed/load the user config and keep it in sync with on-disk edits. Done
    // before the first file opens so editors read live config values.
    this.configWatcher = loadConfig();

    // Configure language servers from `lsp.*` config (and on live edits).
    this.configureLsp();
    for (const key of ['lsp.enable', 'lsp.disabledLanguages', 'lsp.servers', 'lsp.autoInstall']) {
      zym.config.onDidChange(key, () => this.configureLsp());
    }

    // Apply user-configured syntax injections (`editor.languageInjections`), and
    // re-apply + repaint on live edits. After grammars are preloaded, so the rules
    // attach to already-loaded grammars.
    this.configureInjections();
    zym.config.onDidChange('editor.languageInjections', () => this.configureInjections());

    // Surface major LSP events (server start/ready/exit/failure) in the
    // notification log; trace-level so they stay out of the way.
    zym.lsp.onNotice(({ level, message, detail, action, replaceKey, sticky, loading }) => {
      const text = `LSP: ${message}`;
      // `detail` is the short reason shown under the message in the toast/log
      // (the `description` field only appears when a log entry is expanded); an
      // `action` (e.g. "Install") becomes a button; `replaceKey` lets a follow-up
      // notice reuse the same toast in place; `sticky` keeps it until replaced;
      // `loading` shows a spinner instead of the icon.
      const opts = {
        ...(detail ? { detail } : {}),
        ...(action ? { buttons: [{ text: action.label, onDidClick: action.run }] } : {}),
        ...(replaceKey ? { replaceKey } : {}),
        ...(sticky ? { dismissable: true } : {}),
        ...(loading ? { loading: true } : {}),
      };
      if (level === 'error') zym.notifications.addError(text, opts);
      else if (level === 'warning') zym.notifications.addWarning(text, opts);
      else if (level === 'success') zym.notifications.addSuccess(text, opts);
      else if (level === 'info') zym.notifications.addInfo(text, opts);
      else zym.notifications.addTrace(text, opts);
    });

    // Bind the header git chrome (branch button, GitHub model/buttons) and the
    // upstream-behind watch to the active (user) workbench; activateWorkbench
    // re-points them on a person switch. Seeds the behind-count so an already-behind
    // repo doesn't toast on launch.
    this.headerBar.rebind();
    this.headerBar.startAutoFetch();

    // Closing the window consults the session's modified participants first: an
    // editor with unsaved edits or a running agent blocks the quit behind a
    // confirm prompt (Save all / Discard / Cancel). Returning true keeps the
    // window open while the dialog decides; the dialog drives the actual quit.
    this.window.on('close-request', () => {
      if (this.quitting) return false;
      const modified = zym.session.collectModified();
      if (modified.length === 0 || zym.config.get('session.promptOnExitWhenModified') !== true) {
        this.teardownAndQuit();
        return false;
      }
      this.promptModifiedThenQuit(modified);
      return true;
    });
    // A fresh window always starts in the unnamed/default session — never restored,
    // never persisted (docs/session-management.md). Reopening a saved session is the
    // explicit `session:open`. An explicit file arg just opens that file. Default
    // geometry stands until a session is opened (GTK4 `setDefaultSize` no-ops once
    // mapped, so there is nothing to pre-apply before present).
    this.window.present();
    if (initialFile) this.paneItems.openFile(initialFile);
  }

  // Apply restored window geometry (from `applyState` when opening a session). Size
  // only takes effect before the window is mapped (a GTK4 constraint), so on an
  // already-shown window only `maximize` has a visible effect.
  private applyWindowGeometry(geom: NonNullable<SessionState['window']>): void {
    if (geom.width > 0 && geom.height > 0) this.window.setDefaultSize(geom.width, geom.height);
    if (geom.maximized) this.window.maximize();
  }

  // --- Shutdown --------------------------------------------------------------

  // Dispose the window-level subscriptions and quit the application. Used by both
  // the clean-exit path and, after confirmation, the unsaved-work path.
  private teardownAndQuit() {
    this.sessionController.flush(); // final autosave before the workbench goes away
    this.sessionController.releaseLock(); // drop our cross-instance session lock promptly
    this.headerBar.dispose();
    this.configWatcher.dispose();
    this.keymapWatcher.dispose();
    this.sidebar.dispose();
    this.agentSidebar.dispose();
    // Every workbench (the user's + each agent's) owns its dock/center Panels + content
    // and a refcounted pooled git repo — dispose them as units (a shared root is only
    // freed when its last workbench releases it).
    this.workbenchManager.dispose();
    // Drain any tab/agent subscriptions whose tabs weren't individually closed.
    this.paneItems.dispose();
    this.agentController.dispose();
    this.onQuit();
    // node-gtk keeps Node's event loop interleaved with GLib's, so quitting the
    // GLib loop + app doesn't end the process — lingering handles (LSP child
    // processes, fetch/autofetch timers) keep it alive. Exit explicitly once
    // teardown has run so closing the window ends the process.
    process.exit(0);
  }

  // Ask before discarding unsaved work. "Save all" flushes every participant that
  // can be saved (editors); a running agent has nothing to flush and is killed on
  // quit. "Discard" quits regardless; "Cancel" keeps the window open.
  private promptModifiedThenQuit(modified: SessionParticipant[]) {
    confirmUnsavedWork(modified, 'The following will be lost if you quit now:', () => {
      this.quitting = true; // bypass the re-entrant close-request check
      this.teardownAndQuit();
    });
  }

  // --- Active-tab tracking ---------------------------------------------------

  // Fired when the active split/tab changes. The vim status now lives in the
  // editor widget itself, so this only re-evaluates the agent highlight.
  private onActiveTabChanged() {
    this.agentController.updateAgentHighlight();
    this.agentController.updateViewedAgent();
    // Tab add/close/switch and split changes all route through here — a good,
    // cheap signal to (debounced-)persist the session.
    this.sessionController?.scheduleAutosave();
  }

  // --- Commands --------------------------------------------------------------
  // Each group registers its command handlers together with their palette
  // descriptions (the `{ didDispatch, description }` form); the key bindings that
  // invoke them live in the central keymap (src/keymaps/default.ts), loaded once
  // at startup. Commands owned by other widgets (tabs, file tree, git panel,
  // editor, …) declare their own action+description in those widgets' modules.

  // --- Pane switching (demo of the ported command/keymap managers) -----------

  // Vim-style window (split) management. Handlers only; bindings (ctrl-w v/s/c,
  // ctrl-w h/j/k/l, ctrl-w w) live in the central keymap under `.AppWindow`.
  //
  // Directional focus stays within the center; at the left edge `pane:focus-left`
  // falls back to the file-tree dock, and from the file tree `pane:focus-right`
  // returns to it.
  private registerPaneCommands() {
    zym.commands.add('.AppWindow', {
      'pane:split-right': { didDispatch: () => this.workbenchView.splitPane('right'), description: 'Split the pane to the right' },
      'pane:split-down': { didDispatch: () => this.workbenchView.splitPane('down'), description: 'Split the pane downward' },
      'pane:close': { didDispatch: () => this.workbenchView.closePane(), description: 'Close the active pane' },
      // The lifecycle counterpart to closing a tab: rebuild the most recently closed
      // one from the workspace's reopen stack (cross-panel, so it lives here, not in
      // Panel's per-panel tab commands).
      'tab:reopen-last': { didDispatch: () => zym.workspace.reopenLastTab(), description: 'Reopen the last closed tab' },
      'pane:focus-left': { didDispatch: () => this.workbenchView.navPane('left'), description: 'Focus the pane to the left' },
      'pane:focus-right': { didDispatch: () => this.workbenchView.navPane('right'), description: 'Focus the pane to the right' },
      'pane:focus-up': { didDispatch: () => this.workbenchView.navPane('up'), description: 'Focus the pane above' },
      'pane:focus-down': { didDispatch: () => this.workbenchView.navPane('down'), description: 'Focus the pane below' },
      'pane:focus-next': { didDispatch: () => this.workbenchView.focusNextPane(), description: 'Cycle to the next pane' },
      // Reveal+focus the file tree (re-adding it if the right dock had been collapsed
      // away by closing its last tab); Source Control opens as a center tab.
      'file-tree:focus': { didDispatch: () => this.workbenchView.revealFileTree(), description: 'Focus the file tree' },
      'git-panel:focus': { didDispatch: () => this.workbenchView.revealGitPanel(), description: 'Focus Source Control' },
      'workbench-list:focus': { didDispatch: () => this.sidebar.list.focus(), description: 'Focus the workbench sidebar' },
      // Cycle the active workbench through [user, …agents] (the workbench-list order).
      'workbench:previous': { didDispatch: () => this.workbenchManager.cycleWorkbench(-1), description: 'Switch to the previous workbench' },
      'workbench:next': { didDispatch: () => this.workbenchManager.cycleWorkbench(1), description: 'Switch to the next workbench' },
      // Multi-project: open another folder as a project in this window, or close the active one.
      'project:open': { didDispatch: () => this.openProjectPicker(), description: 'Open a folder as a project in this window' },
      'project:close': { didDispatch: () => this.closeActiveProject(), description: 'Close the active project' },
      // Fuzzy-pick a workbench to switch to (the user / each agent) — same set the
      // cycle steps through; selecting one activates it.
      'workbench:picker': {
        didDispatch: () => openWorkbenchPicker(this.overlay, {
          workbenches: this.workbenchManager.orderedOwners().flatMap((owner) => {
            const wb = this.workbenches.get(owner);
            return wb ? [{ owner: wb.owner, cwd: wb.cwd, active: wb === this.workbench }] : [];
          }),
          onActivate: (owner) => this.workbenchManager.activateOwner(owner),
        }),
        description: 'Switch to a workbench (a project or an agent)',
      },
      // Show/hide each dock side without discarding the panels it holds.
      'dock:toggle-left': { didDispatch: () => this.workbenchView.toggleDockSide('left'), description: 'Toggle the left dock' },
      'dock:toggle-right': { didDispatch: () => this.workbenchView.toggleDockSide('right'), description: 'Toggle the right dock (Files / Source Control)' },
      'dock:toggle-top': { didDispatch: () => this.workbenchView.toggleDockSide('top'), description: 'Toggle the top dock' },
      'dock:toggle-bottom': { didDispatch: () => this.workbenchView.toggleDockSide('bottom'), description: 'Toggle the bottom dock' },
      'agent-sidebar:toggle': { didDispatch: () => this.workbenchView.toggleAgentSidebar(), description: 'Toggle the agent sidebar' },
      'sidebar:toggle': { didDispatch: () => this.workbenchView.toggleSidebar(), description: 'Toggle the workbench sidebar' },
      'theme:select': { didDispatch: () => this.selectTheme(), description: 'Select the editor theme' },
      'lsp:toggle-diagnostics-panel': { didDispatch: () => this.workbenchView.toggleDiagnosticsPanel(), description: 'Toggle the Diagnostics panel' },
      'keymap:show': { didDispatch: () => this.workbenchView.toggleKeymapPanel(), description: 'Show all keybindings and their source' },
      'plugin:open-manager': { didDispatch: () => this.workbenchView.openPluginManager(), description: 'Open the Plugin Manager' },
    });
  }

  // Open the theme picker; persist the chosen theme to `theme.active` and toast a
  // restart hint (themes are resolved at startup by `activeThemeName`, not live).
  // A no-op selection of the active theme just reports it.
  private selectTheme() {
    const current = String(zym.config.get('theme.active'));
    openThemePicker(this.overlay, current, (name) => {
      if (name === current) {
        this.toast(`Theme “${name}” is already active`);
        return;
      }
      zym.config.set('theme.active', name);
      saveConfig();
      this.toast(`Theme set to “${name}” — restart to apply`);
    });
  }

  // Apply `lsp.*` config to the language-server manager.
  private configureLsp() {
    zym.lsp.configure({
      enable: zym.config.get('lsp.enable') as boolean,
      disabledLanguages: zym.config.get('lsp.disabledLanguages') as string[],
      serverOverrides: zym.config.get('lsp.servers') as LspConfig['serverOverrides'],
      autoInstall: zym.config.get('lsp.autoInstall') as boolean,
    });
  }

  // Apply `editor.languageInjections` to the grammar registry, then repaint open
  // editors so the change is visible live (the highlighter re-gathers injections
  // each paint, so no reparse is needed). Bad rules are dropped during parsing.
  private configureInjections() {
    setUserInjectionRules(parseInjectionRules(zym.config.get('editor.languageInjections')));
    for (const editor of zym.workspace.getTextEditors()) editor.repaintSyntax();
  }

  /** `diff:go-to-file` (`z /`) — pick a file in the active continuous diff and jump to its header. */
  private diffFilePicker() {
    const diff = this.paneItems.activeContinuousDiff();
    if (!diff) return;
    openDiffFilePicker(this.overlay, diff);
  }

  /** `diff:collapse-files-matching` (`z x`) — collapse every file in the active diff matching a
   *  comma-separated glob filter typed into a picker. */
  private diffCollapseGlobPicker() {
    const diff = this.paneItems.activeContinuousDiff();
    if (!diff) return;
    openDiffCollapseGlobPicker(this.overlay, diff);
  }

  // Window-level file/edit operations, surfaced in the command palette and (for
  // most) on the space leader. Handlers only; bindings live in the central keymap.
  private registerWindowCommands() {
    zym.commands.add('.AppWindow', {
      'project:search': {
        didDispatch: () =>
          openSearchPicker(this.overlay, this.workbench.cwd, (path, cursor) => this.paneItems.openFile(path).restoreCursor(cursor)),
        description: 'Search file contents (ripgrep)',
      },
      'git:diff-current': {
        didDispatch: () => this.paneItems.openCurrentFileDiff(),
        description: 'Diff the current file (working tree vs HEAD)',
        when: () => this.paneItems.activeEditor?.currentFile != null,
      },
      'git:start-commit': {
        didDispatch: () => this.startCommit(),
        description: 'Commit staged changes (edit the message in a tab)',
      },
      'git:commit-amend': {
        didDispatch: () => this.startCommit(true),
        description: 'Amend the last commit (edit the message in a tab)',
        when: () => this.workbench.git.getHead() !== null,
      },
      'project:search-results': {
        didDispatch: () => this.paneItems.openProjectSearch(this.paneItems.activeEditor?.getSelectedText().trim() ?? ''),
        description: 'Project search, seeded with the selected text (multibuffer)',
      },
      'project:search-open': {
        didDispatch: () => this.paneItems.openProjectSearch(''),
        description: 'Open project search (full-text, ripgrep) in a multibuffer',
      },
      'git:diff-current-changes': {
        didDispatch: () => void this.paneItems.openLiveDiff(),
        description: 'Diff working-tree changes (live, stageable)',
      },
      'git:diff-commit': {
        // With a revision argument, diff that commit; with none, pick one first.
        didDispatch: (_e, _el, rev) =>
          typeof rev === 'string' && rev !== ''
            ? void openCommitDiff(rev)
            : openCommitPicker(this.overlay),
        description: 'Diff a commit against its parent (pick one, or pass a revision)',
        when: () => this.workbench.git.getHead() !== null,
      },
      'git:diff-branch': {
        didDispatch: () => void openBranchDiff(),
        description: 'Diff this branch against master/main (PR-style)',
        when: () => this.workbench.git.getHead() !== null,
      },
      'git:log': {
        didDispatch: () => this.paneItems.openGitLog(),
        description: 'Open the git log (history) viewer',
        when: () => this.workbench.git.getHead() !== null,
      },
      'diff:expand-context': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.expandContextAtCursor(),
        description: 'Reveal more unchanged lines at the nearest gap',
        when: () => this.paneItems.activeContinuousDiff() !== null,
      },
      'diff:expand-all': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.expandAll(),
        description: 'Reveal all unchanged lines (show the full files)',
        when: () => this.paneItems.activeContinuousDiff() !== null,
      },
      'diff:collapse-context': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.collapseContext(),
        description: 'Re-collapse expanded context back to the windowed diff',
        when: () => this.paneItems.activeContinuousDiff() !== null,
      },
      'diff:toggle-file': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.toggleFileCollapseAtCursor(),
        description: 'Collapse / expand the file under the cursor',
        when: () => this.paneItems.activeContinuousDiff() !== null,
      },
      'diff:collapse-file': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.collapseFileAtCursor(),
        description: 'Collapse the file under the cursor to its header',
        when: () => this.paneItems.activeContinuousDiff() !== null,
      },
      'diff:expand-file': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.expandFileAtCursor(),
        description: 'Expand the file under the cursor back to its diff',
        when: () => this.paneItems.activeContinuousDiff() !== null,
      },
      'diff:next-file': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.nextFile(),
        description: 'Move to the next file in the diff',
        when: () => this.paneItems.activeContinuousDiff() !== null,
      },
      'diff:prev-file': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.previousFile(),
        description: 'Move to the previous file in the diff',
        when: () => this.paneItems.activeContinuousDiff() !== null,
      },
      'diff:go-to-file': {
        didDispatch: () => this.diffFilePicker(),
        description: 'Jump to a file in the diff…',
        when: () => this.paneItems.activeContinuousDiff() !== null,
      },
      'diff:collapse-all-files': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.collapseAllFiles(),
        description: 'Collapse every file to a one-line header (overview)',
        when: () => this.paneItems.activeContinuousDiff() !== null,
      },
      'diff:collapse-files-matching': {
        didDispatch: () => this.diffCollapseGlobPicker(),
        description: 'Collapse files matching a glob…',
        when: () => this.paneItems.activeContinuousDiff() !== null,
      },
      'diff:expand-all-files': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.expandAllFiles(),
        description: 'Expand every collapsed file back to its diff',
        when: () => this.paneItems.activeContinuousDiff() !== null,
      },
      'search:toggle-collapse': {
        didDispatch: () => this.paneItems.activeSearchResults()?.toggleCollapseAtCursor(),
        description: 'Collapse / expand the file under the cursor (search results)',
        when: () => this.paneItems.activeSearchResults() !== null,
      },
      'search:collapse-all': {
        didDispatch: () => this.paneItems.activeSearchResults()?.collapseAll(),
        description: 'Collapse every file (search results)',
        when: () => this.paneItems.activeSearchResults() !== null,
      },
      'search:expand-all': {
        didDispatch: () => this.paneItems.activeSearchResults()?.expandAll(),
        description: 'Expand every file (search results)',
        when: () => this.paneItems.activeSearchResults() !== null,
      },
      // Unified hunk commands: the same `git:hunk-stage`/`git:hunk-unstage`/`git:hunk-revert`
      // (`space h s`/`u`/`r`) as the editor gutter, routed here for the continuous diff. The
      // continuous-diff editor is embedded (no gutter), so it never registers the editor's variant —
      // these AppWindow registrations are what the focus chain resolves while it's focused.
      'git:hunk-stage': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.stageHunkAtCursor(),
        description: 'Stage the hunk under the cursor (continuous diff)',
        when: () => this.paneItems.activeContinuousDiff()?.live === true, // staging is live-diff only
      },
      'git:hunk-unstage': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.unstageHunkAtCursor(),
        description: 'Unstage the hunk under the cursor (continuous diff)',
        when: () => this.paneItems.activeContinuousDiff()?.live === true, // staging is live-diff only
      },
      'git:hunk-revert': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.revertHunkAtCursor(),
        description: 'Revert the hunk under the cursor (continuous diff)',
        when: () => this.paneItems.activeContinuousDiff()?.live === true, // revert restores to the index → live-diff only
      },
      'git:hunk-stage-next': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.stageHunkAndAdvance(),
        description: 'Stage the hunk under the cursor, then move to the next (continuous diff)',
        when: () => this.paneItems.activeContinuousDiff()?.live === true, // staging is live-diff only
      },
      'diff:next-hunk': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.nextHunk(),
        description: 'Move to the next changed hunk (continuous diff)',
        when: () => this.paneItems.activeContinuousDiff() !== null,
      },
      'diff:prev-hunk': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.prevHunk(),
        description: 'Move to the previous changed hunk (continuous diff)',
        when: () => this.paneItems.activeContinuousDiff() !== null,
      },
      'diff:review-comment': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.startComment(),
        description: 'Comment on the cursor/selection',
        when: () => this.paneItems.activeContinuousDiff()?.canComment === true, // any diff (routes to an agent)
      },
      'diff:review-toggle': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.toggleReviewMode(),
        description: 'Toggle review mode',
        when: () => this.paneItems.activeContinuousDiff()?.canComment === true,
      },
      'diff:review-send': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.submitReview(),
        description: 'Send the review',
        when: () => this.paneItems.activeContinuousDiff()?.canComment === true,
      },
      'diff:review-remove': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.removeCommentAtCursor(),
        description: 'Remove the comment under the cursor',
        when: () => this.paneItems.activeContinuousDiff()?.canComment === true,
      },
      'diff:open-file': {
        didDispatch: () => this.paneItems.activeContinuousDiff()?.openFileAtCursor(),
        description: 'Open the file/line under the cursor (continuous diff)',
        when: () => this.paneItems.activeContinuousDiff() !== null,
      },
      'app:quit': { didDispatch: () => this.onQuit(), description: 'Quit zym' },
      'command-palette:toggle': { didDispatch: () => openCommandPicker(this.overlay), description: 'Show all commands' },
    });
  }

  // Terminal + per-workbench action commands. Handlers only; bindings live in the
  // central keymap. (The `agent:*` commands live in AgentController.registerCommands.)
  private registerTerminalCommands() {
    zym.commands.add('.AppWindow', {
      'terminal:new': { didDispatch: () => this.paneItems.openTerminal(), description: 'Open a new terminal' },
      'scripts:run': {
        didDispatch: () => openScriptRunner(this.overlay, this.workbench.cwd, (name) => this.paneItems.runScript(name)),
        description: 'Run a package.json script in a terminal',
      },
      // Workbench actions (`space x`) — the active workbench's per-workbench runnable
      // set (docs/workbench.md). Run by 1-based number (`space x x`/`space x 1`
      // → the first/default, `space x N` → the Nth), pick from a list, edit the project
      // file, or reset the live set back to it. A `terminal` action opens a terminal
      // tab; a terminal-less one (re)starts its background process.
      'workbench:action-run': {
        didDispatch: (event) => {
          const actions = this.workbench.actions;
          const index = Math.max(1, Math.trunc(Number(event.args?.[0] ?? 1)) || 1);
          const action = actions.actions[index - 1];
          if (action) actions.run(action);
        },
        description: 'Run a workbench action by number (first by default)',
        when: () => this.workbench.actions.actions.length > 0,
      },
      'workbench:action-picker': {
        didDispatch: () => {
          const actions = this.workbench.actions;
          openActionRunner(this.overlay, actions.actions, (action) => actions.run(action));
        },
        description: 'Run one of the workbench actions…',
        when: () => this.workbench.actions.actions.length > 0,
      },
      'workbench:action-edit': {
        didDispatch: () => this.paneItems.openFile(ensureProjectSettingsFile(this.workbench.cwd)),
        description: 'Edit the project settings (.zym/settings.json)',
      },
      'workbench:action-reset': {
        didDispatch: () => this.workbench.actions.reset(),
        description: 'Reset workbench actions to the project defaults',
      },
    });
  }

  // Start a commit: open the message file (`.git/COMMIT_EDITMSG`) in an editor
  // tab. Closing the tab finalizes it — git-style: write the message, save, close
  // to commit (close without a saved message aborts). Reuses the normal editor.
  // `amend` rewrites HEAD and prefills the tab with the last commit's message.
  // Commit (`space g c` / the panel's `c c`) or amend (`space g C`): reveal Source Control
  // and edit the message in its embedded commit editor (a vertical split above the change
  // list) — no separate tab. The GitPanel owns the message → `git.commit` flow.
  private startCommit(amend = false) {
    if (!repoRoot(this.workbench.cwd)) return;
    this.workbenchView.revealGitPanel();
    this.workbench.gitPanel?.startCommit(amend);
  }

  // Notification log: show/hide the bottom-dock history, and clear it. Handlers
  // only; bindings (`space n`, and `c` while the log is focused) live in the
  // central keymap.
  private registerNotificationCommands() {
    zym.commands.add('.AppWindow', {
      'notifications:toggle-log': { didDispatch: () => this.workbenchView.toggleNotificationLog(), description: 'Toggle the notification log' },
      'notifications:clear': { didDispatch: () => zym.notifications.clear(), description: 'Clear notifications' },
      // Run the default action of the most recent notification that has one.
      'notifications:activate': { didDispatch: () => zym.notifications.activateLast(), description: 'Run the latest notification’s action' },
      // Demo commands (command palette only): post one notification of each
      // severity so the toast styling and the log can be exercised by hand.
      'notifications:test-info': {
        didDispatch: () =>
          zym.notifications.addInfo('Info notification', {
            detail: 'Click me to run a default action.',
            onDidClick: () => zym.notifications.addSuccess('Default action ran'),
          }),
        description: 'Post a test info notification',
      },
      'notifications:test-success': {
        didDispatch: () => zym.notifications.addSuccess('Success notification', { detail: 'Something worked.' }),
        description: 'Post a test success notification',
      },
      'notifications:test-warning': {
        didDispatch: () => zym.notifications.addWarning('Warning notification', { detail: 'Something looks off.' }),
        description: 'Post a test warning notification',
      },
      'notifications:test-error': {
        didDispatch: () => zym.notifications.addError('Error notification', { detail: 'Something failed.' }),
        description: 'Post a test error notification',
      },
      'notifications:test-fatal': {
        didDispatch: () =>
          zym.notifications.addFatalError('Fatal notification', {
            detail: 'Something failed badly.',
            dismissable: true,
          }),
        description: 'Post a test fatal notification',
      },
    });
  }

  // Settings: open the Adwaita preferences window over the config schema, the raw
  // config.json, or the user keymap.json in an editor tab. Handlers only; the
  // `space , …` bindings live in the central keymap.
  private registerConfigCommands() {
    zym.commands.add('.AppWindow', {
      'config:open-editor': { didDispatch: () => openConfigEditor(this.window), description: 'Open preferences' },
      'config:open-as-text': { didDispatch: () => this.paneItems.openFile(configPath()), description: 'Open config.json' },
      'keymap:open-as-text': { didDispatch: () => this.paneItems.openFile(ensureUserKeymap()), description: 'Edit the user keymap (keymap.json)' },
    });
  }

  // Open another folder as a project in this window (a folder picker, seeded at the
  // active workbench's root), then switch to it. Dedups an already-open root.
  private openProjectPicker(): void {
    const cwd = this.workbench.cwd;
    openFolderPicker(
      this.overlay,
      cwd,
      cwd,
      (folder) => this.workbenchManager.activateOwner(this.workbenchManager.addProject(folder)),
      { placeholder: 'Open project folder…', actionLabel: (dir) => `Open project: ${dir}` },
    );
  }

  // Close the active project and everything under it — its agents + default workbench
  // (never the last project).
  private closeActiveProject(): void {
    const owner = this.workbench.owner;
    if (!isProject(owner)) {
      this.toast('The active workbench is an agent, not a project');
      return;
    }
    if (this.workbenchManager.projects.length <= 1) {
      this.toast('Can’t close the last project');
      return;
    }
    this.workbenchManager.closeProject(owner);
  }

  // --- Session serialize / restore (multi-project) ---------------------------

  // Snapshot one workbench's restorable content (split layout + file-tree expansion +
  // its runnable action set, omitted when empty).
  private serializeWorkbench(wb: Workbench<Owner>): WorkbenchState {
    const state: WorkbenchState = {
      layout: wb.center.serializeLayout((w) => this.paneItems.serializeChild(w)),
      fileTree: { expanded: wb.fileTree.serializeExpanded() },
    };
    const actions = wb.actions.serialize();
    if (actions.length > 0) state.actions = actions;
    return state;
  }

  // Every open project (its default workbench + the agents grouped under it), in rail order.
  private serializeProjects(): ProjectState[] {
    return this.workbenchManager.projectGroups().map(({ project, agents }): ProjectState => {
      const pw = this.workbenches.get(project)!;
      return {
        root: pw.cwd,
        workbench: this.serializeWorkbench(pw),
        agents: agents.flatMap((agent): AgentState[] => {
          const aw = this.workbenches.get(agent);
          const identity = agent.serialize();
          if (!aw || !identity || identity.kind !== 'agent') return [];
          return [{ root: aw.cwd, workbench: this.serializeWorkbench(aw), agent: identity }];
        }),
      };
    });
  }

  // The focused owner as a { project, agent? } reference into the serialized projects.
  private activeOwnerRef(): SessionState['active'] {
    const owner = this.workbench.owner;
    const groups = this.workbenchManager.projectGroups();
    if (isProject(owner)) {
      const project = groups.findIndex((g) => g.project === owner);
      return { project: project < 0 ? 0 : project };
    }
    for (let project = 0; project < groups.length; project++) {
      const agent = groups[project].agents.indexOf(owner);
      if (agent >= 0) return { project, agent };
    }
    return { project: 0 };
  }

  // Rebuild the window from a saved session. The project set is rebuilt from the SAVED
  // roots (not forced into the cwd primary): `addProject` dedups by root — reusing the
  // primary when its root matches, opening the rest fresh — so a session saved for other
  // roots roots each project correctly (tree/git/title match its contents). Each project's
  // agents relaunch while it's active (so they associate with it). Leftover projects not
  // in the session (e.g. the cwd primary when opening a session rooted elsewhere) are then
  // closed, and the window-level docks/geometry + saved focus applied.
  private restoreSession(state: SessionState, buildChild: (tab: TabState) => RestoredChild | null): void {
    const restored: Project[] = [];
    // Coalesce the many addProject/closeProject/agent builds into a single rail rebuild.
    this.workbenchManager.batchProjectChanges(() => {
      state.projects.forEach((p, index) => {
        const project = this.workbenchManager.addProject(p.root);
        restored.push(project);
        const wb = this.workbenches.get(project);
        if (!wb) return;
        wb.center.restoreLayout(p.workbench.layout, buildChild);
        if (p.workbench.fileTree) wb.fileTree.restoreExpanded(p.workbench.fileTree.expanded);
        if (p.workbench.actions) wb.actions.restore(p.workbench.actions);
        this.workbenchManager.activateOwner(project); // active while its agents relaunch
        if (index === 0 && state.docks) this.applyDocks(state.docks); // window docks → the session's primary
        for (const agent of p.agents) this.agentController.restoreAgent(agent);
      });
      // Close any leftover project not in the session (safe — the session added ≥1, so the
      // last-project guard holds).
      for (const project of [...this.workbenchManager.projects]) {
        if (!restored.includes(project)) this.workbenchManager.closeProject(project);
      }
      // Restore the saved project order (addProject dedup + the cwd primary can scramble
      // it), so projects[0]/primary/the next serialize match the session.
      this.workbenchManager.reorderProjects(restored);
    });
    if (state.window) this.applyWindowGeometry(state.window);
    this.activateSavedOwner(state);
  }

  // Focus the owner active at save time. Resolve the active project by its saved root
  // (not the raw index — the cwd primary may have been reused or closed, shifting order).
  private activateSavedOwner(state: SessionState): void {
    const savedProject = state.projects[state.active.project];
    if (!savedProject) return;
    const project = this.workbenchManager.projects.find((p) => this.workbenches.get(p)?.cwd === savedProject.root);
    if (!project) return;
    const group = this.workbenchManager.projectGroups().find((g) => g.project === project);
    const owner = state.active.agent != null ? (group?.agents[state.active.agent] ?? project) : project;
    this.workbenchManager.activateOwner(owner);
  }

  // Apply window-level dock state (notification log, per-side visibility, resized extents)
  // to the active workbench.
  private applyDocks(docks: SessionDocks): void {
    if (docks.notificationLog && this.workbench.bottomDock !== 'notifications') this.workbenchView.toggleNotificationLog();
    // Apply per-side visibility *after* content is (re)established, so a side restored as
    // hidden stays hidden even though its content is present.
    if (docks.visible) for (const side of DOCK_SIDES) this.workbench.setDockVisible(side, docks.visible[side] !== false);
    // Restore resized dock extents last, once each side's visibility is settled.
    if (docks.sizes) this.workbench.setDockSizes(docks.sizes);
  }

  // Reflect the active session name in the window title (OS taskbar) and the sidebar
  // header. Null → the unnamed/default session shows the bare project name.
  private applySessionName(name: string | null): void {
    this.window.setTitle(name ?? this.projectTitle());
    this.sidebar.list.setSessionName(name);
  }

  // The active project's basename — the OS-title fallback for the unnamed/default session.
  // Read live off the active workbench (not a process.cwd() snapshot) so it tracks the
  // project actually shown rather than the launch dir.
  private projectTitle(): string {
    return Path.basename(this.workbench.cwd);
  }

  // --- Window chrome helpers -------------------------------------------------

  // Post an informational notification (also retained in the notification log).
  // The toast is rendered by the manager bridge (NotificationToasts) in the
  // constructor.
  private toast(message: string) {
    zym.notifications.addInfo(message);
  }
}

