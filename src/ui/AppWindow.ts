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
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
type Application = InstanceType<typeof Adw.Application>;
type ApplicationWindow = InstanceType<typeof Adw.ApplicationWindow>;
type ToastOverlay = InstanceType<typeof Adw.ToastOverlay>;
import { FileTree } from './FileTree.ts';
import { Panel } from './Panel.ts';
import { TextEditor } from './TextEditor/index.ts';
import { type AgentStatus, type AgentResume } from './AgentTerminal.ts';
import type { Agent } from '../agents/types.ts';
import { ensureProjectSettingsFile } from '../projectSettings.ts';
import { openActionRunner } from './workbench/ActionPicker.ts';
import { AgentConversation } from './AgentConversation.ts';
import { AGENT_CONFIGS, resolveAgentKind, type AgentKind } from '../agents/configs.ts';
import { listResumableSessions, recordSessionWorktree, relativeTime, relocateTranscriptToMainRoot, type AgentSession } from '../agentSessions.ts';
import { PROJECT_NAME } from './WorkbenchList.ts';
import { Sidebar } from './Sidebar.ts';
import { AgentSidebar } from './AgentSidebar.ts';
import { HeaderBar } from './HeaderBar.ts';
import { fileIconGlyph } from './fileIcons.ts';
import { acquireGitRepo, releaseGitRepo } from '../git.ts';
import { repoRoot, invalidateRepoRoot, listWorktrees } from '../git.ts';
import { openCommitDiff, openCommitPicker, openBranchDiff } from './diffViews.ts';
import { Workbench, DOCK_SIDES } from './workbench/Workbench.ts';
import { openScriptRunner } from './ScriptRunner.ts';
import { openDiffFilePicker } from './DiffFilePicker.ts';
import { openDiffCollapseGlobPicker } from './DiffCollapseGlobPicker.ts';
import { openSearchPicker } from './SearchPicker.ts';
import { openCommandPicker } from './CommandPicker.ts';
import { openThemePicker } from './ThemePicker.ts';
import { saveConfig } from '../config/load.ts';
import { WhichKey } from './WhichKey.ts';
import { openAgentPicker } from './AgentPicker.ts';
import { openWorkbenchPicker } from './WorkbenchPicker.ts';
import { openAgentLauncher, launchPrompt, type LauncherMode } from './AgentLauncher.ts';
import { openBranchPicker } from './git/BranchPicker.ts';
import { openGithubCIChecksPicker } from './GithubCIChecksPicker.ts';
import { openPicker } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { proseMarkup, escapeMarkup, PROSE_LINE_HEIGHT } from './proseMarkup.ts';
import { openConfigEditor } from './ConfigEditor.ts';
import { zym } from '../zym.ts';
import { fileTabsOf, type SessionParticipant, type WorkspaceState, type SessionState } from '../SessionManager.ts';
import { SessionController } from '../SessionController.ts';
import { type Notification } from '../Notification.ts';
import { NotificationLog } from './NotificationLog.ts';
import { KeymapPanel } from './KeymapPanel.ts';
import { DiagnosticsPanel } from '../lsp/diagnostics/DiagnosticsPanel.ts';
import { type LspConfig } from '../lsp/LspManager.ts';
import { NotificationToasts } from './NotificationToasts.ts';
import { loadKeymaps, ensureUserKeymap } from '../keymaps/load.ts';
import { loadConfig, configPath } from '../config/load.ts';
import { setUserInjectionRules } from '../syntax/grammar.ts';
import { parseInjectionRules } from '../syntax/userInjections.ts';
import { CompositeDisposable, Disposable, type DisposableLike } from '../util/eventKit.ts';
import { applyNotificationStyles } from './chromeStyles.ts';
import { addStyles } from '../styles.ts';
import { registerLspCommands } from './lspCommands.ts';
import { registerGitCommands } from './git/gitCommands.ts';
import { registerFileCommands } from './fileCommands.ts';
import { WorkbenchView, SIDEBAR_WIDTH, AGENT_SIDEBAR_WIDTH } from './workbench/WorkbenchView.ts';
import { PaneItems } from './workbench/PaneItems.ts';

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
  // Per-agent subscriptions (title/status/worktree/files), disposed in closeAgent.
  private readonly agentSubs = new Map<Agent, CompositeDisposable>();

  // The workbench sidebar: the full-height `.WorkbenchSidebar` column at the very left
  // of the window. Owns the `WorkbenchList` (`this.sidebar.list`); it's the start child
  // of `sidebarPaned`, whose width this window toggles on collapse/expand.
  private readonly sidebar: Sidebar;
  // Set once the user has confirmed an exit past unsaved work, so the re-entrant
  // close-request doesn't prompt again.
  private quitting = false;
  // The most recently focused agent — the default target for send-to-agent.
  private lastAgent: Agent | null = null;
  // The agent the user is currently looking at (its tab is the active one), so its
  // status counts as seen — clears the sidebar attention blink (see updateViewedAgent).
  private viewedAgent: Agent | null = null;
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
  // end. Its position is the sidebar width, toggled between expanded and collapsed by
  // the list's robot button (see setSidebarCollapsed).
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
  private workbench!: Workbench<'user' | Agent>;
  private readonly workbenches = new Map<'user' | Agent, Workbench<'user' | Agent>>();

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

  constructor(app: Application, onQuit: () => void, initialFile: string | undefined, explicitFile = false) {
    this.app = app;
    this.onQuit = onQuit;

    this.toastOverlay = new Adw.ToastOverlay();

    // The tab/item-registry spine. Built first — `buildWorkbench` below makes each
    // person's center through it. Its deps are lazy closures over `this`, so they
    // resolve the active workbench / sidebar once those exist.
    this.paneItems = new PaneItems({
      getWorkbench: () => this.workbench,
      activateWorkbench: (workbench) => this.activateWorkbench(workbench),
      activateOwner: (owner) => this.activateOwner(owner),
      onActiveTabChanged: () => this.onActiveTabChanged(),
      onReview: (message) => this.reviewToAgent(message),
      setModified: (modified) => this.sidebar.list.setModified(modified),
    });

    // Build the user's workbench first — its own center + Files/Source-Control +
    // bottom docks, and the (pooled) GitRepo for the window cwd that the header
    // chrome below binds to. Agents get their own (openAgent); no widget is shared
    // across workbenches, so a switch reparents nothing.
    const userWorkbench = this.buildWorkbench('user', process.cwd());
    this.workbench = userWorkbench; // the active workbench until a person is switched
    // Publish the active-workbench provider now, before any consumer (the header bar
    // below) reads it; activateWorkbench just re-points `this.workbench` behind it.
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
      ownsPath: (path) => this.ownerWorkbenchCwd(path) === this.workbench.cwd,
      ownsServer: (rootDir) => this.ownerWorkbenchCwd(rootDir) === this.workbench.cwd,
    });

    // Session save/restore/autosave is anchored to the user workbench (its center +
    // file tree). The builders construct (but don't attach) a tab during restore;
    // PanelGroup.restoreLayout places them into the tree.
    this.sessionController = new SessionController({
      root: process.cwd(),
      center: userWorkbench.center,
      fileTree: userWorkbench.fileTree,
      serializeChild: (widget) => this.paneItems.serializeChild(widget),
      createEditorTab: (path, restore) => this.paneItems.createEditorTab(path, restore),
      createTerminalTab: (cwd) => this.paneItems.createTerminalTab(cwd),
      getDocks: () => ({
        notificationLog: this.workbench.bottomDock === 'notifications',
        visible: this.workbench.dockVisibility(),
        sizes: this.workbench.dockSizes(),
      }),
      applyDocks: (docks) => {
        if (docks.notificationLog && this.workbench.bottomDock !== 'notifications') this.workbenchView.toggleNotificationLog();
        // Apply per-side visibility *after* any content has been (re)established above,
        // so a side restored as hidden stays hidden even though its content is present.
        if (docks.visible)
          for (const side of DOCK_SIDES) this.workbench.setDockVisible(side, docks.visible[side] !== false);
        // Restore resized dock extents last, once each side's visibility is settled.
        if (docks.sizes) this.workbench.setDockSizes(docks.sizes);
      },
      serializeUserActions: () => userWorkbench.actions.serialize(),
      restoreUserActions: (actions) => userWorkbench.actions.restore(actions),
      serializeAgentWorkspaces: () => this.serializeAgentWorkspaces(),
      restoreAgent: (ws) => this.restoreAgent(ws),
      getActiveWorkspace: () => this.activeWorkspaceIndex(),
      activateWorkspace: (index, restored) => {
        const agent = index > 0 ? (restored[index - 1] as Agent | null) : null;
        this.activateOwner(agent ?? 'user');
      },
      getWindow: () => ({
        width: this.window.getWidth(),
        height: this.window.getHeight(),
        maximized: this.window.isMaximized(),
      }),
      applyWindow: (geom) => this.applyWindowGeometry(geom),
      // Cache the unsaved contents of modified editors so a restore brings them back
      // (unsavedSnapshot also covers a restored tab not yet reopened).
      collectUnsaved: () =>
        this.paneItems.allEditors().flatMap((e) => {
          const text = e.unsavedSnapshot();
          return e.currentFile && text !== null ? [{ path: e.currentFile, text }] : [];
        }),
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
      onActivate: (agent) => this.showAgent(agent),
      onActivateUser: () => this.activateOwner('user'), // the user row → user workbench
      onRestart: (agent) => this.restartAgent(agent),
      onStop: (agent) => agent.kill(),
      onClose: (agent) => this.closeAgent(agent),
      onRename: (agent) => this.renameAgentPrompt(agent),
      onOpenChanges: (agent) => this.openAgentChanges(agent),
      onToggleCollapsed: (collapsed) => this.workbenchView.setSidebarCollapsed(collapsed),
    });

    // The agent "secondary sidebar" sits between the WorkbenchList and the content,
    // also full-height (outside the header). Its own split (`agentPaned`) gives it a
    // resizable width; it starts detached (start child null) — the user workbench shows
    // no agent — and AppWindow attaches/detaches it on workbench switch. Window resize
    // grows the content, not the agent column.
    this.agentSidebar = new AgentSidebar({
      onOpenChanges: (agent) => this.openAgentChanges(agent), // the header's edited-files button
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
    this.window.setTitle(PROJECT_NAME); // OS taskbar label — the project, not the bare "node"
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
      activeAgent: () => this.activeAgent,
      activeEditorFile: () => this.paneItems.activeEditor?.currentFile ?? null,
      focusContent: (widget) => this.paneItems.focusContent(widget),
      openFileView: (path, panel) => this.paneItems.openFileViewIn(path, panel),
      openFile: (path) => this.paneItems.openFile(path),
      buildCurrentChangesDiff: (workbench) => this.paneItems.buildCurrentChangesDiff(workbench),
      setTabCloseHandler: (widget, fn) => this.paneItems.setTabCloseHandler(widget, fn),
      scheduleAutosave: () => this.sessionController.scheduleAutosave(),
      toast: (message) => this.toast(message),
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
    zym.workspace.setReviewSink((message) => this.reviewToAgent(message));
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
    // The command modules read the active editor / workbench / picker host / file-open
    // straight off the `zym` globals (Atom-style); only their genuinely module-specific
    // collaborators are injected here.
    registerFileCommands({ activeSavableSurface: () => this.paneItems.activeSavableSurface() });
    registerGitCommands({ github: this.headerBar.github });
    this.registerNotificationCommands();
    this.registerConfigCommands();
    this.registerSessionCommands();
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
    // On a bare launch, restore the saved session if opted in; an explicit file
    // arg always suppresses restore. Window geometry must be applied *before*
    // present (GTK4 `setDefaultSize` no-ops once mapped), so do it here.
    const willRestore = !explicitFile && this.sessionController.shouldRestoreOnLaunch();
    if (willRestore) {
      const geom = this.sessionController.loadWindow();
      if (geom) this.applyWindowGeometry(geom);
    }
    this.window.present();

    // restore() re-focuses the workbench that was active when the session was saved
    // (the user workspace, or one of the relaunched agents) via activateWorkspace.
    const restored = willRestore && this.sessionController.restore();
    if (!restored && initialFile) this.paneItems.openFile(initialFile);
  }

  // Apply restored window geometry. Size only takes effect before the window is
  // mapped (a GTK4 constraint), so the launch path calls this pre-`present`; for a
  // session:restore on an already-shown window only `maximize` has visible effect.
  private applyWindowGeometry(geom: NonNullable<SessionState['window']>): void {
    if (geom.width > 0 && geom.height > 0) this.window.setDefaultSize(geom.width, geom.height);
    if (geom.maximized) this.window.maximize();
  }

  // --- Shutdown --------------------------------------------------------------

  // Dispose the window-level subscriptions and quit the application. Used by both
  // the clean-exit path and, after confirmation, the unsaved-work path.
  private teardownAndQuit() {
    this.sessionController.flush(); // final autosave before the workbench goes away
    this.headerBar.dispose();
    this.configWatcher.dispose();
    this.keymapWatcher.dispose();
    this.sidebar.dispose();
    this.agentSidebar.dispose();
    // Every workbench (the user's + each agent's) owns its dock/center Panels + content
    // and a refcounted pooled git repo — dispose them as units (a shared root is only
    // freed when its last workbench releases it).
    for (const wb of this.workbenches.values()) wb.dispose();
    // Drain any tab/agent subscriptions whose tabs weren't individually closed.
    this.paneItems.dispose();
    for (const subs of this.agentSubs.values()) subs.dispose();
    this.agentSubs.clear();
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
    const items = modified
      .map((p) => `• ${p.getModifiedLabel?.() ?? 'Unsaved work'}`)
      .join('\n');
    const dialog = new Adw.AlertDialog({
      heading: 'Unsaved work',
      body: `The following will be lost if you quit now:\n${items}`,
    });
    dialog.addResponse('cancel', 'Cancel');
    dialog.addResponse('discard', 'Discard');
    dialog.addResponse('save', 'Save All');
    dialog.setResponseAppearance('discard', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.setResponseAppearance('save', Adw.ResponseAppearance.SUGGESTED);
    dialog.setDefaultResponse('save');
    dialog.setCloseResponse('cancel');
    dialog.on('response', (response: string) => {
      if (response === 'cancel') return;
      if (response === 'save') {
        for (const participant of modified) participant.saveModified?.();
      }
      this.quitting = true; // bypass the re-entrant close-request check
      this.teardownAndQuit();
    });
    dialog.present(this.window);
  }

  /**
   * Launch (or resume) an agent in its own workbench. The kind is an explicit
   * `options.kind`, else `claude-tui` for a resume (only it resumes a
   * conversation), else the `agent.implementation` flag. `AGENT_CONFIGS` builds the
   * host; everything below is generic over the `Agent` surface, so the terminal and
   * headless kinds share this one launch path.
   *
   * The agent gets its own `Workbench` (its own center + Files/Git + bottom docks)
   * whose center pins the agent as an unsplittable leaf; everything it opens lands
   * in a split to its right. Activate the workbench *before* pinning — adding a tab
   * to a detached, unrooted Adw.TabView yields a blank page — then `start()` it (a
   * terminal already spawned in its constructor; the headless kind spawns here).
   */
  private openAgent(
    options: { kind?: AgentKind; prompt?: string; userPrompt?: string; resume?: AgentResume; title?: string; root?: string; command?: string[]; background?: boolean } = {},
  ): Agent {
    // Both kinds can resume now (claude-sdk rebuilds its transcript from disk), so a
    // resume no longer forces the terminal agent — it respects the configured kind
    // unless a caller pins one (e.g. restoreAgent passes the saved agent's kind).
    const kind = options.kind ?? resolveAgentKind(zym.config.get('agent.implementation'));
    // Invariant: the agent *process* always spawns in the editor's main dir, never a
    // worktree — its OS cwd then can't sit inside a worktree that gets removed (which
    // crashes the agent), and every transcript lands under one project dir so
    // `--resume` always resolves. A worktree is an editor concern only: `root` re-roots
    // the workbench (Files/Git/gutters) and seeds the agent's effectiveCwd, while the
    // agent itself works in it via set_worktree / its own `cd`. See docs/agents.md.
    const mainRoot = this.mainRoot();
    let root = options.root ?? mainRoot;
    if (root !== mainRoot && !Fs.existsSync(root)) root = mainRoot; // a vanished worktree → main dir
    const agent = AGENT_CONFIGS[kind].create({
      cwd: mainRoot, worktree: root, command: options.command, prompt: options.prompt, userPrompt: options.userPrompt, resume: options.resume, title: options.title,
      onOpenFile: (path) => this.paneItems.openFile(path),
    });
    // Track in the tab registry (terminal focus-routing / headless disposal key off these).
    this.paneItems.trackAgent(agent);
    // Background launch: build the agent's workbench and start it, but stay on the
    // current workbench and don't focus it (it's listed in the sidebar; switch to it later).
    const workbench = this.buildWorkbench(agent, root);
    // Pipe the agent's `set_actions` straight into its workbench's action set (the
    // agent keeps no copy). The set is shown as buttons in the window header bar when
    // this workbench is active; pruning stale terminal tabs is driven off the workbench
    // set change (wired in buildWorkbench).
    agent.bindActions(workbench.actions);
    // The agent widget lives in the "secondary sidebar" (a full-height column with its
    // own header) rather than the workbench center — uncloseable (no tab) and themed with
    // the secondarySidebar colors. It's hosted in the sidebar's stack now; activateWorkbench
    // makes it the visible one. The workbench center stays free as the work/review area.
    this.agentSidebar.addAgent(agent.root);
    if (!options.background) this.activateWorkbench(workbench); // shows + reveals the agent column
    if (!options.background) this.updateViewedAgent(); // its workbench is now active — mark it viewed
    // Keep the secondary-sidebar header title in sync when this agent is the shown one.
    const agentSubs = new CompositeDisposable();
    this.agentSubs.set(agent, agentSubs);
    // A running agent reports as modified, so it's consulted before exit. Tracked on the
    // agent's subscription bag (not a tab), torn down with the rest in closeAgent.
    agentSubs.add(zym.session.registerParticipant(agent));
    agentSubs.add(new Disposable(agent.onTitleChange(() => {
      if (this.activeAgent === agent) this.agentSidebar.setTitle(agent.title);
    })));
    // Notify when the agent needs attention while the user isn't looking at it.
    let previousStatus = agent.status;
    agentSubs.add(new Disposable(agent.onDidChangeStatus(() => {
      this.notifyAgentAttention(agent, previousStatus, agent.status);
      previousStatus = agent.status;
      // On settle, flag a worktree it created but never announced (validator).
      if (agent.status === 'idle') this.warnUnannouncedWorktree(agent);
    })));
    // The agent announced (via the set_worktree bridge tool) that it moved into a
    // different worktree — re-root its workbench to match.
    agentSubs.add(new Disposable(agent.onDidChangeWorktree(() => {
      this.reRootWorkbench(workbench, agent.effectiveCwd);
      // Persist the worktree as a sidecar under the spawn dir's transcript dir (the
      // main dir, where the transcript lives) so a later resume can re-root to it.
      if (agent.sessionId) recordSessionWorktree(mainRoot, agent.sessionId, agent.effectiveCwd);
    })));
    // When the agent edits files, re-check git now instead of waiting for the poll,
    // so its changes surface in Source Control / the branch indicator promptly, and
    // (when enabled) auto-open each newly-edited file in the agent's own workbench.
    // Seed from the current list so resuming an agent doesn't flood-open its history.
    const seenFiles = new Set<string>(agent.changedFiles);
    agentSubs.add(new Disposable(agent.onDidChangeFiles(() => {
      workbench.git.refresh(); // the agent's own workbench root, not the active one
      const autoOpen = zym.config.get('agent.autoOpenChangedFiles') === true;
      for (const path of agent.changedFiles) {
        if (seenFiles.has(path)) continue;
        seenFiles.add(path);
        if (autoOpen) this.autoOpenChangedFile(agent, path);
      }
    })));
    // Track the last-focused agent (the default target for send-to-agent).
    const focus = new Gtk.EventControllerFocus();
    focus.on('enter', () => { this.lastAgent = agent; });
    agentSubs.addController(agent.root, focus); // severed in closeAgent; `enter` captures the agent (rule 9)
    agent.start(); // terminal: no-op (already spawned); headless: spawn claude now
    if (!options.background) agent.focus(); // the workbench is already active (above); focus the agent
    return agent;
  }

  // The agent that send-to-agent targets: the active one, else the last focused,
  // else any still-running agent (skipping exited ones).
  private targetAgent(): Agent | null {
    for (const agent of [this.activeAgent, this.lastAgent]) {
      if (agent && !agent.exited) return agent;
    }
    return zym.agents.getAgents().find((agent) => !agent.exited) ?? null;
  }

  // The editor context the send-to-agent commands push: the current selection, or
  // the active file's path (cwd-relative, trailing space). Empty when unavailable.
  private editorSelectionText(): string {
    return this.paneItems.activeEditor?.getSelectedText() ?? '';
  }
  private editorFileText(): string {
    const file = this.paneItems.activeEditor?.currentFile;
    return file ? `${Path.relative(this.workbench.cwd, file)} ` : '';
  }

  // Feed `text` into `agent`'s prompt. With `submit`, send it as a turn immediately
  // (TUI: Enter submits). `reveal` (default true) shows + focuses the agent; pass
  // false to deliver in the background and leave focus where it is.
  private deliverToAgent(agent: Agent, text: string, options?: { submit?: boolean; reveal?: boolean }): void {
    const reveal = options?.reveal !== false;
    agent.deliver(text, { submit: options?.submit, focus: reveal });
    if (reveal) this.showAgent(agent);
  }

  // Send to the current agent (active → last-focused → any running).
  private sendToAgent(text: string, options?: { submit?: boolean; reveal?: boolean }): void {
    if (!text) return;
    const agent = this.targetAgent();
    if (!agent) {
      zym.notifications.addWarning('No running agent to send to');
      return;
    }
    this.deliverToAgent(agent, text, options);
  }

  // Deliver a diff review (one comment, or an accumulated batch) to an agent — the sink every
  // diff surface's `onSend` routes through (directly here, or via `zym.workspace.sendReviewToAgent`
  // for the decoupled commit/branch views). Sends it as a turn and REVEALS the agent so the review
  // visibly lands and the agent starts working on it (a background send left the user unsure it
  // arrived — and the diff often sits in a different workbench than the agent). With no agent
  // running, the picker chooses one — or starts a fresh agent with the review as its first turn.
  // So a review can ALWAYS reach an agent, on any diff.
  private reviewToAgent(message: string): void {
    if (!message) return;
    const agent = this.targetAgent();
    if (agent) {
      this.deliverToAgent(agent, message, { submit: true });
      return;
    }
    openAgentPicker(this.overlay, {
      placeholder: 'Send review to agent…',
      onActivate: (agent) => this.deliverToAgent(agent, message, { submit: true }),
      // A highlighted, always-present "Send to new agent" entry → the launcher (pick model /
      // permission / worktree), then deliver the review to the agent it starts.
      newAgent: { label: 'Send to new agent', run: () => this.launchAgentForReview(message) },
    });
  }

  // The "Send to new agent" review path: open the launcher (model / permission / worktree) with the
  // review PRE-FILLED as the prompt, so it's the agent's FIRST turn (the launch prompt is the spawn
  // argument, reliably delivered). It used to start the agent and then send the review as a separate
  // post-launch turn — that races with the just-spawned agent and is dropped, so the agent got the
  // launcher's prompt but not the review. The user can edit the pre-filled review or just launch.
  private launchAgentForReview(message: string): void {
    openAgentLauncher(this.overlay, {
      cwd: this.workbench.cwd,
      defaultKind: resolveAgentKind(zym.config.get('agent.implementation')),
      initialWorktree: 'current', // a review runs against the working tree by default
      initialPrompt: message, // the review is the prompt → delivered as the agent's first turn
      onLaunch: ({ prompt, command, cwd, kind, worktree, background }) => {
        const { agentPrompt, userPrompt } = launchPrompt(prompt, worktree);
        this.openAgent({ prompt: agentPrompt, userPrompt, command, root: cwd, kind, background });
      },
    });
  }

  // Send to an agent chosen from the picker (or a freshly started one).
  private pickAgentAndSend(text: string): void {
    if (!text) return;
    openAgentPicker(this.overlay, {
      placeholder: 'Send to agent…',
      onActivate: (agent) => this.deliverToAgent(agent, text),
      onStart: (prompt) => this.deliverToAgent(this.openAgent({ prompt }), text),
    });
  }

  // Compose a new agent's prompt: a list-less picker seeded with the editor
  // context (editable); submitting launches a NEW agent with that prompt.
  private composeNewAgent(seed: string): void {
    openPicker({
      host: this.overlay,
      placeholder: 'Prompt for new agent…',
      query: seed,
      items: [],
      onSelect: () => {},
      action: {
        label: (prompt) => `Start agent: ${prompt}`,
        run: (prompt) => this.openAgent({ prompt }),
      },
    });
  }

  // The project roots to look for resumable conversations in: the window cwd plus
  // every git worktree of its repo, so a conversation launched in a worktree (its
  // transcript lives under that worktree's project dir) is found too. Deduped.
  // The roots the resume picker scans: every worktree of this repo, **main worktree
  // first** — listResumableSessions treats roots[0] as the prefix anchor for also
  // recovering transcripts from worktrees that have since been removed. process.cwd()
  // is kept in case it isn't itself a worktree root (e.g. a subdir / non-repo run).
  private agentSessionRoots(): string[] {
    const roots = listWorktrees(process.cwd()).map((wt) => wt.path);
    if (roots.length === 0) roots.push(process.cwd());
    if (!roots.includes(process.cwd())) roots.push(process.cwd());
    return roots;
  }

  /** The directory every agent process spawns in: the editor's own root
   *  (`process.cwd()`), fixed for the process's life and never a throw-away worktree.
   *  Keeping every agent's OS cwd here means none sits inside a worktree that might be
   *  removed (which would crash it), and every transcript lands under one project dir
   *  so `--resume` always resolves. Worktree association is an editor re-root
   *  (set_worktree), not the process cwd. See docs/agents.md. */
  private mainRoot(): string {
    return process.cwd();
  }

  // `openAgent` options to resume `session`. The process spawns in the main dir (the
  // cwd invariant), so we only ensure the transcript is resolvable there (relocating
  // it if it lived under a worktree's dir). The editor re-roots to the worktree the
  // session worked in — a dynamic move (`effectiveCwd`) wins over the launch cwd —
  // by passing it as `root`, which `buildWorkbench` roots directly; no re-announce
  // prompt is needed (that just restored the view, which the seed now does), so a
  // resume restores the worktree silently. A removed worktree resumes in the main dir.
  private resumeOptions(session: AgentSession): { root?: string; resume: AgentResume; title: string } {
    const mainRoot = this.mainRoot();
    relocateTranscriptToMainRoot(session, mainRoot); // so `--resume <id>` resolves under the main dir
    const wt = session.effectiveCwd ?? session.cwd;
    const worktree = wt && wt !== mainRoot && Fs.existsSync(wt) ? wt : undefined;
    return {
      root: worktree,
      resume: { sessionId: session.id },
      title: truncate(session.label, 40),
    };
  }

  // One WorkspaceState per open agent workbench (its root + center layout + the
  // agent's relaunch identity), for the session. The layout is recorded for
  // forward-compat; restore currently only relaunches the agent (see restoreAgent).
  private serializeAgentWorkspaces(): WorkspaceState[] {
    const out: WorkspaceState[] = [];
    for (const agent of zym.agents.getAgents()) {
      const workbench = this.workbenches.get(agent);
      const state = agent.serialize();
      if (!workbench || !state || state.kind !== 'agent') continue;
      out.push({
        root: workbench.cwd,
        layout: workbench.center.serializeLayout((w) => this.paneItems.serializeChild(w)),
        fileTree: { expanded: workbench.fileTree.serializeExpanded() },
        actions: workbench.actions.serialize(),
        agent: state,
      });
    }
    return out;
  }

  // The index, into the serialized workspaces, of the workbench that currently has
  // focus: 0 for the user, else the active agent's position among the serialized
  // agent workspaces. Mirrors serializeAgentWorkspaces' ordering and skips so the
  // index lines up; an agent that didn't serialize falls back to the user (0).
  private activeWorkspaceIndex(): number {
    if (this.workbench.owner === 'user') return 0;
    let i = 1;
    for (const agent of zym.agents.getAgents()) {
      const workbench = this.workbenches.get(agent);
      const state = agent.serialize();
      if (!workbench || !state || state.kind !== 'agent') continue;
      if (agent === this.workbench.owner) return i;
      i++;
    }
    return 0;
  }

  // Relaunch an agent workbench from its saved workspace, resumed to its
  // conversation/worktree. Resolving the conversation via resumeOptions also
  // restores the worktree (and avoids re-running the original launch prompt); a
  // session that's since vanished falls back to a bare resume, and an agent that
  // never reported a session id is relaunched fresh with its original prompt.
  // Returns the relaunched agent (or null when it was skipped) so the caller can
  // re-focus the workbench that had focus when the session was saved.
  private restoreAgent(ws: WorkspaceState): Agent | null {
    const a = ws.agent;
    if (!a) return null;
    // Don't duplicate an agent that's already open (explicit restore over a live session).
    if (a.sessionId && zym.agents.getAgents().some((ag) => ag.sessionId === a.sessionId)) return null;
    // Restore as the kind that was saved (older sessions have no tag → claude-tui).
    const kind: AgentKind = a.agentKind ?? 'claude-tui';
    let agent: Agent;
    if (a.sessionId) {
      const session = listResumableSessions(this.agentSessionRoots()).find((s) => s.id === a.sessionId);
      // The saved workbench cwd (`ws.root`) is authoritative for where the editor
      // roots — `resumeOptions` still relocates the transcript and supplies the
      // resume id + title, but its transcript-derived root is overridden by the
      // recorded one, so restore needs no set_worktree re-announce from the agent.
      agent = session
        ? this.openAgent({ ...this.resumeOptions(session), root: ws.root, kind })
        : this.openAgent({ kind, root: ws.root, resume: { sessionId: a.sessionId } });
    } else {
      agent = this.openAgent({ kind, root: ws.root, prompt: a.prompt });
    }
    // Reopen the files that were in this agent's work area (its reviewed files). The
    // agent leaf itself is recreated by openAgent; the work-area split geometry
    // isn't preserved — we just reopen the file tabs, rooted in this workbench.
    const workbench = this.workbenches.get(agent);
    if (workbench) {
      // Restore the workbench's live action set (a resuming agent may re-report and
      // overwrite it on its next set_actions — that's the intended precedence).
      if (ws.actions) workbench.actions.restore(ws.actions);
      const panel = workbench.center.openPanel;
      for (const tab of fileTabsOf(ws.layout)) {
        if (Fs.existsSync(tab.path)) {
          this.paneItems.openFileIn(tab.path, panel, { focus: false, owner: workbench });
        }
      }
    }
    return agent;
  }

  // Resume a past conversation: pick one of the project's saved sessions (newest
  // first, excluding any currently live) and reopen it as `claude --resume <id>`.
  private resumeAgentPicker(): void {
    const live = new Set(zym.agents.getAgents().map((a) => a.sessionId).filter(Boolean));
    const sessions = listResumableSessions(this.agentSessionRoots()).filter((s) => !live.has(s.id));
    if (sessions.length === 0) {
      zym.notifications.addInfo('No past conversations to resume');
      return;
    }
    const byId = new Map(sessions.map((s) => [s.id, s]));
    openPicker({
      host: this.overlay,
      placeholder: 'Resume conversation…',
      proseEntry: true, // the query is prose, not a path/identifier
      // Match against the bare label; render it markdown-style (prose + inline
      // `code`) with the time muted in the right-aligned detail column. Untitled
      // sessions (labelled by their first message) are dimmed to set the named
      // ones apart.
      items: sessions.map((s) => ({ value: s.id, text: s.label })),
      renderRow: (item, positions) => {
        const session = byId.get(item.value);
        const ranElsewhere = session?.cwd && session.cwd !== process.cwd();
        const where = ranElsewhere ? `${escapeMarkup(Path.basename(session!.cwd!))} · ` : '';
        return renderRowSingleLine({
          main: proseMarkup(item.text, positions, !session?.titled),
          detail: `<span face="Sans" line_height="${PROSE_LINE_HEIGHT}">${where}${escapeMarkup(relativeTime(session?.modified ?? 0))}</span>`,
        });
      },
      onSelect: (id) => {
        const session = byId.get(id);
        if (session) this.openAgent(this.resumeOptions(session));
        else this.openAgent({ resume: { sessionId: id } });
      },
      // When the query matches no past conversation, offer to start a fresh agent
      // with the typed text as its prompt instead.
      action: {
        label: (query) => `Start agent: ${query}`,
        run: (query) => this.openAgent({ prompt: query }),
      },
      actionWhenEmpty: true,
    });
  }

  // Highlight an agent's row only while its terminal is the focused element AND
  // its tab is the active panel's active tab — so the highlight clears the moment
  // focus leaves the agent (e.g. into the picker) or its panel stops being active.
  // The sidebar selection follows the active workbench's owner (which person you're
  // viewing), not focus.
  private updateAgentHighlight(): void {
    this.sidebar.list.selectAgent(this.workbench.owner === 'user' ? null : this.workbench.owner);
  }

  // Tell each agent whether the user is currently looking at it — only the agent
  // whose tab is the active child of the active workbench counts as viewed. Viewing
  // acknowledges its status, clearing the sidebar attention blink; switching away
  // from a still-`waiting` agent lets it blink again to call the user back.
  private updateViewedAgent(): void {
    // The agent's widget is shown in the agent sidebar whenever its workbench is active —
    // so "viewed" is simply: its workbench is the active one.
    const viewed = this.activeAgent;
    if (viewed === this.viewedAgent) return;
    this.viewedAgent?.setViewed(false);
    this.viewedAgent = viewed;
    viewed?.setViewed(true);
  }

  /** The agent whose workbench is active, if any. */
  private get activeAgent(): Agent | null {
    return this.workbench.owner === 'user' ? null : this.workbench.owner;
  }

  /** Reveal the agent `delta` steps from the active one (wraps; first if none). */
  private focusAdjacentAgent(delta: number): void {
    const agents = zym.agents.getAgents();
    if (agents.length === 0) return;
    const index = this.activeAgent ? agents.indexOf(this.activeAgent) : -1;
    const next = agents[(((index + delta) % agents.length) + agents.length) % agents.length];
    if (next) this.showAgent(next);
  }

  // Surface an attention-worthy status change as a notification — but only when
  // the user isn't already watching that agent (its tab isn't the active one).
  // Clicking the notification reveals the agent.
  private notifyAgentAttention(agent: Agent, previous: AgentStatus, current: AgentStatus): void {
    if (this.activeAgent === agent) return; // already on this agent's workbench — its widget is on screen
    const reveal = () => this.showAgent(agent);
    if (current === 'waiting') {
      zym.notifications.addWarning(`${agent.title} needs your input`, { onDidClick: reveal });
    } else if (current === 'idle' && previous === 'working') {
      zym.notifications.addTrace(`${agent.title} finished`, { onDidClick: reveal });
    }
  }

  // The agent a lifecycle command acts on: the active one, else the last focused.
  private currentAgent(): Agent | null {
    return this.activeAgent ?? this.lastAgent;
  }

  private restartCurrentAgent(): void {
    const agent = this.currentAgent();
    if (agent) this.restartAgent(agent);
  }

  // Resume a stopped agent in its existing pane (vs restart, which retires the
  // old widget and opens a fresh one). Reveals the agent so its revived terminal
  // is in view.
  private resumeCurrentAgent(): void {
    const agent = this.currentAgent();
    if (!agent || !agent.exited) return;
    // The terminal agent revives its child in the same pane (reusing scrollback). The
    // headless agent's session is wired into views built at construction, so it can't
    // hot-swap a fresh process in place — restart it (a new widget that rebuilds the
    // transcript from disk and resumes the conversation by session id).
    if (agent instanceof AgentConversation) { this.restartAgent(agent); return; }
    agent.resume();
    this.showAgent(agent);
  }

  private closeCurrentAgent(): void {
    const agent = this.currentAgent();
    if (agent) this.closeAgent(agent);
  }

  // Branch the current agent: open a NEW agent/workbench whose claude session is
  // forked off the current agent's conversation (`--resume <id> --fork-session`).
  // The fork is a transcript copy, so the original agent keeps running, intact and
  // independent. Requires a claude agent that has reported its session id (the
  // fork has nothing to branch from otherwise).
  private branchCurrentAgent(): void {
    const agent = this.currentAgent();
    if (!agent) return;
    const sessionId = agent.sessionId;
    if (!sessionId) {
      zym.notifications.addWarning('No conversation to branch yet');
      return;
    }
    // Branch into the same kind as the source agent, its editor rooted at the same
    // worktree (the process spawns in the main dir, where `--resume` resolves).
    this.openAgent({
      kind: agent instanceof AgentConversation ? 'claude-sdk' : 'claude-tui',
      root: agent.effectiveCwd,
      resume: { sessionId, fork: true },
      title: `${agent.title} (branch)`,
    });
  }

  private renameCurrentAgent(): void {
    const agent = this.currentAgent();
    if (agent) this.renameAgentPrompt(agent);
  }

  private openChangesOfCurrentAgent(): void {
    const agent = this.currentAgent();
    if (agent) this.openAgentChanges(agent);
  }

  // Review the files an agent has edited this session: switch to its workbench and
  // open every edited file as a tab in the work area split beside the agent panel
  // (created on demand, to the right of the terminal).
  private openAgentChanges(agent: Agent): void {
    const files = agent.changedFiles;
    if (files.length === 0) {
      zym.notifications.addInfo(`${agent.title} hasn't edited any files yet`);
      return;
    }
    this.showAgent(agent); // this.workbench is now the agent's
    const panel = this.workbench.center.openPanel; // the work area (split right of the agent)
    // Open without focusing each in turn, then reveal the first one that landed in
    // the work area. A file already open elsewhere is revealed in place (one editor
    // per file), so it may not join the work area — skip it when choosing what to focus.
    let firstInPane: TextEditor | null = null;
    for (const path of files) {
      const editor = this.paneItems.openFileIn(path, panel, { focus: false });
      if (!firstInPane && panel.getChildren().includes(editor.root)) firstInPane = editor;
    }
    if (firstInPane) {
      this.paneItems.editorChildFor(firstInPane.root)?.select();
      firstInPane.focus();
    }
  }

  // Auto-open a file the agent just edited in *its own* workbench's work area,
  // without switching to that workbench. Mirrors openAgentChanges but targets a
  // (possibly inactive) workbench and never steals focus. A file already open
  // anywhere keeps its single editor.
  private autoOpenChangedFile(agent: Agent, path: string): void {
    const workbench = this.workbenches.get(agent);
    if (!workbench) return;
    if (this.paneItems.editorForPath(path)) return;
    // openPanel splits the agent panel to the right on the first file, then reuses
    // that work area for the rest. Pass the agent's workbench as owner so the editor's
    // gutter uses *its* (worktree) git, not the active workbench's.
    const panel = workbench.center.openPanel;
    // focus: false never grabs keyboard focus. select: only the first file reveals
    // itself — it fills the freshly-created (empty) work area so there's something to
    // see. Every later edit opens quietly as a background tab in the bar, so the agent's
    // edits never pull the view off whatever the user is looking at or editing.
    const select = panel.tabCount === 0;
    this.paneItems.openFileIn(path, panel, { focus: false, owner: workbench, select });
  }

  // Restart an agent: retire the old one and relaunch in place, resuming its claude
  // conversation (forking a still-live session so the original transcript isn't
  // clobbered). A pinned (renamed) title carries over.
  private restartAgent(agent: Agent): void {
    const kind: AgentKind = agent instanceof AgentConversation ? 'claude-sdk' : 'claude-tui';
    const title = agent.renamed ? agent.title : undefined;
    // Both kinds resume by session id now; fork a copy if the agent is still live so
    // the original keeps running. The editor re-roots to its (possibly moved)
    // worktree; the process spawns in the main dir, where `--resume` resolves.
    const resume = agent.sessionId ? { sessionId: agent.sessionId, fork: !agent.exited } : undefined;
    const root = agent.effectiveCwd;
    this.closeAgent(agent);
    this.openAgent({ kind, resume, title, root });
  }

  // Close an agent for good: SIGTERM a live child, drop its workbench (returning to
  // the user's workbench if it was active), and retire it from the registry.
  private closeAgent(agent: Agent): void {
    if (!agent.exited) agent.kill();
    const workbench = this.workbenches.get(agent);
    // Drop this workbench's action terminals (set_actions tabs in its center);
    // disposeChild won't reach them (they're terminals, not editors).
    if (workbench) this.paneItems.disposeWorkbenchActionTerminals(workbench);
    if (this.workbench.owner === agent) this.activateOwner('user'); // swap away first
    this.workbenches.delete(agent); // its workbench (center + Files/Git + bottom + tabs) goes
    if (workbench) {
      // Tear down the editors that lived in this workbench — closing it drops their
      // widgets but not their bookkeeping (gutter git subscription, LSP doc ref,
      // session participant, the editor→workbench entry that pins the workbench).
      this.paneItems.disposeWorkbenchEditors(workbench);
      workbench.dispose(); // tears down every widget it owns (file tree, Source-Control,
      // dock + center Panels, bottom-dock content) and releases its pooled git repo
    }
    this.agentSubs.get(agent)?.dispose(); // title/status/worktree/files subs + the session participant
    this.agentSubs.delete(agent);
    this.agentSidebar.removeAgent(agent.root); // drop its page from the secondary-sidebar stack
    this.paneItems.disposeAgentWidget(agent); // sever the Vte focus controller / kill the headless child
    // Drop the last-focused pointer if it named this agent — otherwise currentAgent()
    // would resolve a retired, disposed agent and agent:restart / agent:resume would
    // act on a ghost. With it cleared, the commands' `when` guards correctly disable.
    if (this.lastAgent === agent) this.lastAgent = null;
    zym.agents.remove(agent);
  }

  // Prompt for a new display name (pinned over the CLI's reported title). Reuses
  // the picker as a prose text prompt: the action row renames on Enter.
  private renameAgentPrompt(agent: Agent): void {
    openPicker({
      host: this.overlay,
      placeholder: 'Rename agent…',
      proseEntry: true,
      query: agent.title,
      items: [],
      onSelect: () => {},
      action: {
        label: (name) => `Rename to: ${name}`,
        run: (name) => agent.rename(name),
      },
    });
  }

  // Build a fresh center (one person's splittable editor area). Every center
  /**
   * Build a person's workbench rooted at `cwd`: acquire the (pooled) GitRepo for
   * that root, construct its own center, Files tree, and bottom-dock widgets, then
   * hand them to a `Workbench` (which docks the center, and the Files side dock for
   * the user). Source Control is created lazily on first reveal (see ensureGitPanel).
   * Nothing is shared with other workbenches, so a switch never reparents. Registers
   * and returns the `Workbench`.
   */
  private buildWorkbench(owner: 'user' | Agent, cwd: string): Workbench<'user' | Agent> {
    const git = acquireGitRepo(cwd);
    const center = this.paneItems.makeCenter();
    const fileTree = new FileTree({
      rootPath: cwd,
      onOpenFile: (path) => this.paneItems.openFile(path),
      git,
    });
    // The file tree is the only tab in this right-side dock. Source Control (GitPanel)
    // is created lazily on first reveal (ensureGitPanel / `git-panel:focus`) and opens
    // as a center tab — not here — so a workbench doesn't construct a git-subscribing
    // panel it may never open. The dock collapses out of the workbench when its last
    // tab closes (the reveal/focus path re-attaches it); the closure captures this
    // workbench's own `leftPanel`.
    const leftPanel = new Panel({ onEmpty: () => this.workbenchView.detachDock(leftPanel) });
    const filesTab = leftPanel.add(fileTree.root, { title: `${fileIconGlyph('', true)}  Files` });
    filesTab.select();

    // Each bottom dock is a single persistent view: closing its tab hides the dock
    // (its toggle brings it back) rather than destroying the page, so its widget/
    // state survive and reopening never shows an empty panel. hideBottomDock acts on
    // the active workbench — the only one whose tab can be interactively closed.
    const notificationLog = new NotificationLog();
    const notificationPanel = new Panel({ onTabCloseRequest: () => this.workbenchView.hideBottomDock('notifications') });
    notificationPanel.add(notificationLog.root, { title: 'Notifications' });
    // Scope this workbench's diagnostics to the files under its root (read live via
    // `owner`, so a re-root re-scopes it).
    const diagnosticsPanel = new DiagnosticsPanel(
      (target) => this.paneItems.openOrFocusFile(target.path, [target.line, target.character]),
      (path) => this.ownerWorkbenchCwd(path) === this.workbenches.get(owner)?.cwd,
    );
    const diagnosticsDock = new Panel({ onTabCloseRequest: () => this.workbenchView.hideBottomDock('diagnostics') });
    diagnosticsDock.add(diagnosticsPanel.root, { title: 'Diagnostics' });
    const keymapPanel = new KeymapPanel();
    const keymapDock = new Panel({ onTabCloseRequest: () => this.workbenchView.hideBottomDock('keymap') });
    keymapDock.add(keymapPanel.root, { title: 'Keybindings' });

    const workbench = new Workbench<'user' | Agent>(
      owner,
      {
        cwd, git, center, fileTree, leftPanel, filesTab,
        notificationLog, notificationPanel, diagnosticsPanel, diagnosticsDock,
        keymapPanel, keymapDock,
      },
      { showSideDock: owner === 'user' },
    );
    // The workbench owns its runtime action set (seeded from `<cwd>/.zym/settings.json`,
    // overwritable by an agent, run from `space x`); wire the terminal-action runner so
    // a `terminal` action runs in a tab here and reports its run/stop state (it needs
    // the workbench to host the tab), and prune orphaned action tabs when the set
    // shrinks. The subscriptions live on plain-JS emitters collected with the workbench
    // on dispose — hence the explicit `void` discard.
    workbench.actions.setTerminalRunner({
      run: (action) => this.paneItems.runWorkbenchActionInTerminal(workbench, action),
      stop: (actionId) => this.paneItems.findActionTerminal(workbench, actionId)?.terminal.kill(),
      isRunning: (actionId) => (this.paneItems.findActionTerminal(workbench, actionId)?.terminal.pid ?? null) !== null,
      onDidChangeRunning: (cb) => {
        const sub = this.paneItems.onActionTerminalChange((wb) => { if (wb === workbench) cb(); });
        return () => sub.dispose();
      },
    });
    void workbench.actions.onDidChange(() => this.paneItems.pruneActionTerminals(workbench));
    this.workbenches.set(owner, workbench);
    return workbench;
  }

  /** Activate the workbench owned by `owner`. */
  private activateOwner(owner: 'user' | Agent): void {
    const workbench = this.workbenches.get(owner);
    if (workbench) this.activateWorkbench(workbench);
  }

  // Step the active workbench by `step` (−1 / +1) through the workbench-list order
  // ([user, …agents]), wrapping around. No-op when the user is the only person.
  private cycleWorkbench(step: number): void {
    const owners: Array<'user' | Agent> = ['user', ...zym.agents.getAgents()];
    if (owners.length < 2) return;
    const current = owners.indexOf(this.workbench.owner);
    const next = (current + step + owners.length) % owners.length;
    this.activateOwner(owners[next]);
  }

  /**
   * Activate `workbench`: make it the visible one (`this.workbench`). Nothing is
   * reparented — every slot already belongs to it; the previously-active workbench is
   * detached but alive (its tabs/terminal/editor state persist). All per-person state
   * lives on the workbench itself, so there's nothing to save/restore on switch. Driven
   * by the WorkbenchList / openAgent.
   */
  private activateWorkbench(workbench: Workbench<'user' | Agent>): void {
    this.workbench = workbench;
    this.contentOverlay.setChild(workbench.root); // show this workbench
    this.sidebar.list.selectAgent(workbench.owner === 'user' ? null : workbench.owner);
    this.headerBar.rebind(); // header branch/GitHub now reflect this workbench's root
    this.headerBar.refreshStatus(); // diagnostics pill + LSP indicator → this workbench
    this.workbenchView.showAgentSidebar(this.activeAgent); // reveal this workbench's agent column (or hide it)
    this.updateViewedAgent();
    this.workbenchView.focusActivePane();
  }

  // The open workbench whose root (cwd) most specifically contains `path` — the
  // longest matching prefix, so a file (or server root) inside a nested worktree is
  // owned by that worktree, not its parent. Paths under no open root fall to the
  // user workbench. Used to scope per-workbench diagnostics + the header LSP status.
  private ownerWorkbenchCwd(path: string): string {
    let best = process.cwd(); // user workbench root / fallback for orphan paths
    for (const wb of this.workbenches.values()) {
      if (isUnderRoot(path, wb.cwd) && wb.cwd.length > best.length) best = wb.cwd;
    }
    return best;
  }

  // Re-root an agent's workbench after it moves into a worktree: swap the pooled
  // GitRepo and re-root the file tree + Source Control in place (the widgets/tabs
  // stay put); if it's the active workbench, re-point the header chrome too.
  private reRootWorkbench(workbench: Workbench<'user' | Agent>, newCwd: string): void {
    if (newCwd === workbench.cwd) return;
    // The worktree at newCwd may have been probed (and cached) as a non-repo before
    // it existed; drop that stale entry so repoRoot resolves the new checkout.
    invalidateRepoRoot(newCwd);
    const oldGit = workbench.git;
    const git = acquireGitRepo(newCwd); // acquire before release: a shared root keeps its repo
    workbench.cwd = newCwd;
    workbench.git = git;
    workbench.fileTree.setRoot(newCwd, git);
    workbench.gitPanel?.setRoot(newCwd, git); // null until lazily created; it'll pick up the new root on creation
    // Re-point the gutters of editors already open in this workbench at the new repo.
    this.paneItems.repointGutters(workbench, git);
    releaseGitRepo(oldGit);
    if (this.workbench === workbench) this.headerBar.rebind();
    // Diagnostics ownership shifts on a re-root (paths under the old/new root change
    // hands), so re-scope every workbench's panel and the active header status.
    for (const wb of this.workbenches.values()) wb.diagnosticsPanel.refresh();
    this.headerBar.refreshStatus();
  }

  // The cooperative-detection safety net: if an agent created a worktree (spotted
  // by the Bash validator) but never announced it via set_worktree, warn once when
  // it next settles — its workbench won't have re-rooted to the worktree.
  private warnUnannouncedWorktree(agent: Agent): void {
    const path = agent.unannouncedWorktree;
    if (!path) return;
    agent.clearUnannouncedWorktree();
    zym.notifications.addWarning(`${agent.title} switched worktree without telling the editor`, {
      detail:
        `It created a worktree (${path}) but didn't call the set_worktree tool, so its file tree ` +
        'and Source Control still point at the old root.',
    });
  }

  /** Show `agent`: activate its workbench (its widget lives in the agent sidebar). */
  private showAgent(agent: Agent): void {
    this.activateOwner(agent);
  }

  // --- Active-tab tracking ---------------------------------------------------

  // Fired when the active split/tab changes. The vim status now lives in the
  // editor widget itself, so this only re-evaluates the agent highlight.
  private onActiveTabChanged() {
    this.updateAgentHighlight();
    this.updateViewedAgent();
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
      'workbench:previous': { didDispatch: () => this.cycleWorkbench(-1), description: 'Switch to the previous workbench' },
      'workbench:next': { didDispatch: () => this.cycleWorkbench(1), description: 'Switch to the next workbench' },
      // Fuzzy-pick a workbench to switch to (the user / each agent) — same set the
      // cycle steps through; selecting one activates it.
      'workbench:picker': {
        didDispatch: () => openWorkbenchPicker(this.overlay, {
          workbenches: (['user', ...zym.agents.getAgents()] as Array<'user' | Agent>).flatMap((owner) => {
            const wb = this.workbenches.get(owner);
            return wb ? [{ owner: wb.owner, cwd: wb.cwd, active: wb === this.workbench }] : [];
          }),
          onActivate: (owner) => this.activateOwner(owner),
        }),
        description: 'Switch to a workbench (the user or an agent)',
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

  // Terminal command: open a shell in a new center-panel tab. Handler only;
  // bound to `space t` in the central keymap.
  private registerTerminalCommands() {
    // The launcher gathers the prompt + model / permission mode / effort / kind + a worktree
    // choice, then hands back the assembled argv. The worktree is set up by the agent itself
    // (it announces it via set_worktree, which re-roots the workbench) — see launchPrompt.
    // `mode` selects which worktree-scoped variant of the launcher to render.
    const launchAgent = (mode?: LauncherMode) =>
      openAgentLauncher(this.overlay, {
        cwd: this.workbench.cwd,
        defaultKind: resolveAgentKind(zym.config.get('agent.implementation')),
        mode,
        onLaunch: ({ prompt, command, cwd, kind, worktree, background }) => {
          const { agentPrompt, userPrompt } = launchPrompt(prompt, worktree);
          this.openAgent({ prompt: agentPrompt, userPrompt, command, root: cwd, kind, background });
        },
      });
    zym.commands.add('.AppWindow', {
      'terminal:new': { didDispatch: () => this.paneItems.openTerminal(), description: 'Open a new terminal' },
      'scripts:run': {
        didDispatch: () => openScriptRunner(this.overlay, this.workbench.cwd, (name) => this.paneItems.runScript(name)),
        description: 'Run a package.json script in a terminal',
      },
      'agent:new': { didDispatch: () => launchAgent(), description: 'Start a new agent' },
      // The three worktree-scoped launcher flows (the worktree itself is realized by the
      // agent — see launchPrompt): pick an existing branch, the current root, or a fresh one.
      'agent:new-in-worktree': { didDispatch: () => launchAgent('existing-worktree'), description: 'Start a new agent in an existing git worktree' },
      'agent:new-this-worktree': { didDispatch: () => launchAgent('this-worktree'), description: 'Start a new agent in the current git worktree' },
      'agent:new-worktree': { didDispatch: () => launchAgent('new-worktree'), description: 'Start a new agent in a new git worktree' },
      'agent:picker': {
        didDispatch: () => openAgentPicker(this.overlay, {
          onActivate: (agent) => this.showAgent(agent),
          sessionRoots: this.agentSessionRoots(),
          // Resume restoring the conversation's branch/worktree/cwd (see resumeOptions).
          onResume: (session) => this.openAgent(this.resumeOptions(session)),
          onStart: (prompt) => this.openAgent({ prompt }),
        }),
        description: 'Open the agent picker (agents, conversations, new)',
      },
      // Resume a stopped agent in place (current agent, if exited). Resuming a
      // past *conversation* as a fresh agent is agent:resume-conversation (a picker).
      'agent:resume': { didDispatch: () => this.resumeCurrentAgent(), description: 'Resume the stopped agent', when: () => this.currentAgent()?.exited === true },
      'agent:resume-conversation': { didDispatch: () => this.resumeAgentPicker(), description: 'Resume a past conversation…' },
      // Branch the current agent into a new agent/workbench: a fresh session
      // forked off its conversation (`--resume <id> --fork-session`), so the
      // original agent is left running and untouched.
      'agent:branch': { didDispatch: () => this.branchCurrentAgent(), description: 'Branch the agent into a new forked agent', when: () => this.currentAgent() !== null },
      // Lifecycle / navigation for the active agent. Stop SIGTERMs the child (the widget
      // lingers as exited, resumable); next/prev cycle through the running agents.
      // Closing an agent's tab never retires it — it just backgrounds it (the agent stays
      // listed whether running or stopped); retiring it from the list is a separate command.
      'agent:stop': { didDispatch: () => this.activeAgent?.kill(), description: 'Stop the active agent', when: () => this.activeAgent !== null },
      // Lifecycle on the current agent (active, else last focused).
      'agent:restart': { didDispatch: () => this.restartCurrentAgent(), description: 'Restart the agent (resume its conversation)', when: () => this.currentAgent() !== null },
      'agent:rename': { didDispatch: () => this.renameCurrentAgent(), description: 'Rename the agent', when: () => this.currentAgent() !== null },
      // Close for good: terminate the child if it's still running, then remove its
      // workbench and retire it from the list (unlike tab:close, which only backgrounds).
      'agent:close': { didDispatch: () => this.closeCurrentAgent(), description: 'Close the agent (terminate it and remove it from the list)', when: () => this.currentAgent() !== null },
      'agent:open-changes': { didDispatch: () => this.openChangesOfCurrentAgent(), description: "Open the agent's edited files", when: () => this.currentAgent() !== null },
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
      'agent:focus-next': { didDispatch: () => this.focusAdjacentAgent(1), description: 'Focus the next agent' },
      'agent:focus-prev': { didDispatch: () => this.focusAdjacentAgent(-1), description: 'Focus the previous agent' },
      // Push the active editor's context into an agent's prompt — the current
      // agent (send-*), or one chosen from the picker (send-*-to).
      'agent:send-selection': { didDispatch: () => this.sendToAgent(this.editorSelectionText()), description: 'Send the selection to the current agent' },
      'agent:send-file': { didDispatch: () => this.sendToAgent(this.editorFileText()), description: 'Send the file path to the current agent' },
      'agent:send-selection-to': { didDispatch: () => this.pickAgentAndSend(this.editorSelectionText()), description: 'Send the selection to an agent…' },
      'agent:send-file-to': { didDispatch: () => this.pickAgentAndSend(this.editorFileText()), description: 'Send the file path to an agent…' },
      'agent:send-selection-to-new': { didDispatch: () => this.composeNewAgent(this.editorSelectionText()), description: 'Send the selection to a new agent' },
      'agent:send-file-to-new': { didDispatch: () => this.composeNewAgent(this.editorFileText()), description: 'Send the file path to a new agent' },
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

  // Session: save or restore the workspace session explicitly. Autosave covers the
  // common case; these are manual controls (command palette / keymap).
  private registerSessionCommands() {
    zym.commands.add('.AppWindow', {
      'session:save': {
        didDispatch: () => {
          this.sessionController.saveNow();
          this.toast('Session saved');
        },
        description: 'Save the session',
      },
      'session:restore': {
        didDispatch: () => {
          // restore() re-focuses the saved active workbench (via activateWorkspace).
          if (!this.sessionController.restore()) this.toast('No saved session for this folder');
        },
        description: 'Restore the last session',
      },
    });
  }

  // --- Window chrome helpers -------------------------------------------------

  // Post an informational notification (also retained in the notification log).
  // The toast is rendered by the manager bridge (NotificationToasts) in the
  // constructor.
  private toast(message: string) {
    zym.notifications.addInfo(message);
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Whether `path` is `root` itself or lives beneath it (a `root + sep` prefix, so
// `/a/bc` doesn't count as under `/a/b`).
function isUnderRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(Path.sep) ? root : root + Path.sep);
}

