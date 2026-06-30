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
import { Panel, type PanelChild } from './Panel.ts';
import { PanelGroup, type RestoredChild } from './PanelGroup.ts';
import { TextEditor } from './TextEditor/index.ts';
import { DocumentRegistry } from './TextEditor/DocumentRegistry.ts';
import { Terminal, terminalTabTitle } from './Terminal.ts';
import { AgentTerminal, type AgentStatus, type AgentResume } from './AgentTerminal.ts';
import type { Agent } from '../agents/types.ts';
import { type Action } from '../actions.ts';
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
import { Icons } from './icons.ts';
import { acquireGitRepo, releaseGitRepo } from '../git.ts';
import { git, repoRoot, invalidateRepoRoot, listWorktrees } from '../git.ts';
import { openCommitDiff, openCommitPicker, openBranchDiff } from './diffViews.ts';
import { GitLogView } from './git/GitLogView.ts';
import { Workbench, DOCK_SIDES } from './workbench/Workbench.ts';
import { openScriptRunner, detectPackageManager } from './ScriptRunner.ts';
import { openDiffFilePicker } from './DiffFilePicker.ts';
import { openDiffCollapseGlobPicker } from './DiffCollapseGlobPicker.ts';
import { openSearchPicker } from './SearchPicker.ts';
import { SearchResultsView } from './SearchResultsView.ts';
import { ProjectSearchView } from './ProjectSearchView.ts';
import { DiffView } from './DiffView.ts';
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
import { type OpenTabOptions } from '../Workspace.ts';
import { fileTabsOf, type SessionParticipant, type TabState, type WorkspaceState, type SessionState } from '../SessionManager.ts';
import { SessionController, deserializeTab } from '../SessionController.ts';
import { type Notification } from '../Notification.ts';
import { NotificationLog } from './NotificationLog.ts';
import { KeymapPanel } from './KeymapPanel.ts';
import { DiagnosticsPanel } from '../lsp/diagnostics/DiagnosticsPanel.ts';
import { type LspConfig } from '../lsp/LspManager.ts';
import { normalizeWorkspaceEdit, applyTextEdits } from '../lsp/workspaceEdit.ts';
import { uriToPath, type PositionEncoding } from '../lsp/position.ts';
import type { WorkspaceEdit } from 'vscode-languageserver-protocol';
import { NotificationToasts } from './NotificationToasts.ts';
import { loadKeymaps, ensureUserKeymap } from '../keymaps/load.ts';
import { loadConfig, configPath } from '../config/load.ts';
import { setUserInjectionRules } from '../syntax/grammar.ts';
import { parseInjectionRules } from '../syntax/userInjections.ts';
import { CompositeDisposable, Disposable, Emitter, type DisposableLike } from '../util/eventKit.ts';
import { applyNotificationStyles } from './chromeStyles.ts';
import { addStyles } from '../styles.ts';
import { registerLspCommands } from './lspCommands.ts';
import { registerGitCommands } from './git/gitCommands.ts';
import { registerFileCommands } from './fileCommands.ts';
import { WorkbenchView, SIDEBAR_WIDTH, AGENT_SIDEBAR_WIDTH } from './workbench/WorkbenchView.ts';

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

  // Editor tabs in the active workbench's center, mapped from their root widget so the
  // active child can be resolved back to its editor regardless of which split it's in.
  private readonly editors = new Map<Widget, TextEditor>();
  // Which workbench each editor lives in, so a workbench re-root can re-point its
  // editors' git gutters (kept in lockstep with `editors`).
  private readonly editorOwners = new Map<Widget, Workbench<'user' | Agent>>();
  // Open documents (text model + undo + file I/O), ref-counted. Editor tabs are views
  // onto these — a split or the see-definition peek shares one document (A2 model).
  private readonly documents = new DocumentRegistry();
  // Per-editor `zym.workspace` registration (drives plugin `observeTextEditors`);
  // disposed when the tab closes (see disposeChild).
  private readonly editorRegistrations = new Map<Widget, Disposable>();
  // Tab-lifetime subscriptions on the editor/terminal source (title + modified
  // state), disposed in disposeChild so a closed tab leaves no handlers behind.
  private readonly tabSubs = new Map<Widget, CompositeDisposable>();
  // Per-agent subscriptions (title/status/worktree/files), disposed in closeAgent.
  private readonly agentSubs = new Map<Agent, CompositeDisposable>();
  // Terminal tabs share the center panel with editors; tracked separately so the
  // active child can be resolved back to its Terminal (it has no vim state).
  private readonly terminals = new Map<Widget, Terminal>();
  // Headless `claude-sdk` agents mounted as center tabs (keyed by their root
  // widget), disposed when their tab closes (see disposeChild).
  private readonly conversations = new Map<Widget, AgentConversation>();
  // Terminal tabs opened for a `terminal` workbench action, keyed by the terminal's
  // root widget. Re-running an action reuses its still-open tab (run the command in
  // place); the tab is closed when the action is cleared, its workbench is closed, or
  // the user closes the tab (see pruneActionTerminals / disposeChild).
  private readonly actionTerminals = new Map<Widget, { workbench: Workbench<'user' | Agent>; actionId: string; terminal: Terminal; child: PanelChild }>();
  // Fires (with the affected workbench) when a `terminal` action's command starts or
  // exits, so that workbench's WorkbenchActions can re-emit a running change and the
  // header bar's run/stop button updates. Driven by each action terminal's onRunningChange.
  private readonly actionTerminalChanges = new Emitter();

  // The workbench sidebar: the full-height `.WorkbenchSidebar` column at the very left
  // of the window. Owns the `WorkbenchList` (`this.sidebar.list`); it's the start child
  // of `sidebarPaned`, whose width this window toggles on collapse/expand.
  private readonly sidebar: Sidebar;
  // Maps an editor's root widget to its center tab handle, so a location jump can
  // reveal an already-open file instead of opening a duplicate tab.
  private readonly editorChildren = new Map<Widget, PanelChild>();
  // Tab-hosted project-search surfaces (the search-entry header + its results multibuffer),
  // keyed by root widget so the view is disposed (freeing its per-source DocumentSyntax parses)
  // when its tab closes.
  private readonly projectSearchViews = new Map<Widget, ProjectSearchView>();
  // Teardown for a center tab, keyed by its root widget — run (and cleared) when the
  // tab closes (see disposeChild). The generic seam behind `zym.workspace.openTab`'s
  // `onClose`; the continuous-diff views (editable + read-only commit/branch) use it
  // to dispose on close. DiffView.forRoot routes commands to the focused one.
  private readonly tabCloseHandlers = new Map<Widget, () => void>();
  // Session modified-status registrations (editors, running agents), keyed by the
  // tab's root widget so the registration is disposed when the tab closes.
  private readonly participants = new Map<Widget, DisposableLike>();
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
      serializeChild: (widget) => this.serializeChild(widget),
      createEditorTab: (path, restore) => this.createEditorTab(path, restore),
      createTerminalTab: (cwd) => this.createTerminalTab(cwd),
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
        [...this.editors.values()].flatMap((e) => {
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
      activeEditorFile: () => this.activeEditor?.currentFile ?? null,
      focusContent: (widget) => this.focusContent(widget),
      openFileView: (path, panel) => this.openFileViewIn(path, panel),
      openFile: (path) => this.openFile(path),
      buildCurrentChangesDiff: (workbench) => this.buildCurrentChangesDiff(workbench),
      setTabCloseHandler: (widget, fn) => this.tabCloseHandlers.set(widget, fn),
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
    // Expose file-opening app-wide (reveal-if-open by default — see openFile).
    zym.workspace.setOpener((path, options) => {
      const editor = this.openFile(path);
      if (options?.cursor) editor.restoreCursor(options.cursor);
    });
    zym.workspace.setActiveEditorProvider(() => this.activeEditor);
    // Expose closed-tab reopening app-wide; the history stack lives on the workspace.
    zym.workspace.setTabReopener((state) => this.reopenTab(state));
    zym.workspace.setTabHost((widget, options) => this.openCenterTab(widget, options));
    // Expose diff-review delivery app-wide so the decoupled commit/branch diff views (diffViews.ts)
    // can route comments to an agent without reaching into the AppWindow.
    zym.workspace.setReviewSink((message) => this.reviewToAgent(message));
    // The window-level overlay floating pickers mount into, and the workspace-edit
    // applier (its impl owns the editor registry) — app-wide so command modules reach
    // for the `zym.workspace` global instead of being handed these on every call.
    zym.workspace.setPickerHost(this.overlay);
    zym.workspace.setWorkspaceEditApplier((edit, encoding) => this.applyWorkspaceEdit(edit, encoding));
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
    registerFileCommands({ activeSavableSurface: () => this.activeSavableSurface() });
    registerGitCommands({ github: this.headerBar.github });
    this.registerNotificationCommands();
    this.registerConfigCommands();
    this.registerSessionCommands();
    registerLspCommands({ documents: this.documents });
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
    if (!restored && initialFile) this.openFile(initialFile);
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
    for (const subs of this.tabSubs.values()) subs.dispose();
    this.tabSubs.clear();
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

  // --- Editor lifecycle ------------------------------------------------------

  /** The TextEditor backing the focused tab, if any. Prefers whichever panel holds
   *  keyboard focus (so a right-dock review editor receives editor commands), else
   *  falls back to the center's active split. */
  private get activeEditor(): TextEditor | null {
    const focused = Panel.active?.activeChild;
    const focusedEditor = focused ? this.editors.get(focused) : undefined;
    if (focusedEditor) return focusedEditor;
    const centerChild = this.workbench.center.activePanel.activeChild;
    return centerChild ? this.editors.get(centerChild) ?? null : null;
  }

  /**
   * Open `path` in a center tab and focus it — revealing an already-open editor
   * for the file (in any split) instead of opening a duplicate tab. This is the
   * single funnel every file-open goes through, so reveal-if-open is the default
   * everywhere; it's also exposed app-wide as `zym.workspace.openFile`.
   */
  private openFile(path: string): TextEditor {
    return this.openFileIn(path, this.targetPanelForNewFile());
  }

  // Where a newly-opened file should land: the center's open panel — the active
  // split, or (in an agent workbench, when the agent panel itself is active) the
  // work area beside it, created on demand. Files opened while focus sits in the
  // file tree or a picker still follow the last active center split, since focusing
  // those docks doesn't change which center leaf is active.
  private targetPanelForNewFile(): Panel {
    return this.workbench.center.openPanel;
  }

  // Open `path` as a tab in `panel` (the center's active leaf, or the right-dock
  // editor group), revealing an already-open editor anywhere instead of opening a
  // duplicate — a file is only ever backed by one editor. `focus` (default true)
  // moves keyboard focus to it; callers opening several files at once suppress it
  // and focus the one they want at the end.
  private openFileIn(
    path: string,
    panel: Panel,
    options: { focus?: boolean; owner?: Workbench<'user' | Agent>; select?: boolean } = {},
  ): TextEditor {
    const focus = options.focus ?? true;
    const targetOwner = options.owner ?? this.workbench;
    const existing = [...this.editors.entries()].find(
      ([widget, editor]) => editor.currentFile === path && this.editorOwners.get(widget) === targetOwner,
    )?.[1];
    if (existing) {
      if (options.select !== false) this.editorChildren.get(existing.root)?.select();
      if (focus) existing.focus();
      return existing;
    }
    return this.openFileViewIn(path, panel, { focus, owner: options.owner, select: options.select });
  }

  // Open a *new* view of `path` in `panel` — no reveal-if-open, so the same file can
  // show in two panes as two views sharing one Document (live model + undo). Used by
  // splitPane; openFileIn reveals instead. `owner` is the workbench the editor lives
  // in (its git feeds the gutter); defaults to the active one.
  private openFileViewIn(path: string, panel: Panel, options: { focus?: boolean; owner?: Workbench<'user' | Agent>; select?: boolean } = {}): TextEditor {
    const { focus = true, owner = this.workbench, select } = options;
    const built = this.createEditorTab(path, { owner, focus });
    const child = panel.add(built.widget, {
      title: built.title,
      requireTabBar: built.requireTabBar,
      select,
    });
    built.onAttached?.(child);
    const editor = this.editors.get(built.widget)!;
    if (focus) editor.focus();
    return editor;
  }

  // Construct + wire a file editor tab WITHOUT attaching it to a panel. Shared by
  // openFile (which adds it to the active panel) and session restore (which places
  // it into the rebuilt workbench). The map is set before any attach so the first
  // onActiveChanged resolves the active editor.
  private createEditorTab(
    path: string,
    restore: {
      cursor?: [number, number];
      scroll?: number;
      unsavedText?: string;
      owner?: Workbench<'user' | Agent>;
      focus?: boolean;
    } = {},
  ): RestoredChild {
    const owner = restore.owner ?? this.workbench;
    let child: PanelChild | null = null;
    // A ref-counted shared Document from the registry: the first view to be *shown* loads
    // it; a second view (split / restore) attaches to the already-loaded shared model.
    const { document } = this.documents.acquire(path);
    const editor = new TextEditor({
      onClose: () => child?.close(),
      git: owner.git, // the owning workbench's repo draws the gutter (follows re-root)
      cwd: () => owner.cwd, // the LocationBar shortens paths against the workbench's (live) root
      document,
      onReleaseDocument: () => this.documents.release(document),
      // `enter` (normal mode / visual selection) comments the line to an agent — same seam every
      // diff's review routes through; with no agent running it opens the picker / launches one.
      onComment: (message) => this.reviewToAgent(message),
    });
    this.editors.set(editor.root, editor);
    this.editorOwners.set(editor.root, owner);
    this.participants.set(editor.root, zym.session.registerParticipant(editor));
    // Lazy open: assign the file now (title/dedup/serialize go live) but defer the read,
    // parse, highlight, and LSP until this tab is first shown — a background or
    // session-restored tab does no work until it's selected. The editor's activate()
    // decides load-vs-attach off the shared document's loaded state.
    editor.prepareFile(path, {
      cursor: restore.cursor,
      scroll: restore.scroll,
      unsavedText: restore.unsavedText,
      // focus: false (a background open — agent auto-open, session restore) loads and
      // renders when shown, but doesn't grab focus; default true takes it.
      focus: restore.focus,
      // Announce to the workspace so editor-observing plugins (color preview, …) can
      // attach; registered after load so their first pass sees the file's content.
      onActivate: () => this.editorRegistrations.set(editor.root, zym.workspace.addTextEditor(editor)),
    });
    return {
      widget: editor.root,
      title: this.editorTabTitle(editor),
      requireTabBar: true, // editors always show their filename tab, even when alone
      onAttached: (attached) => {
        child = attached;
        this.editorChildren.set(editor.root, attached);
        const sync = () => {
          attached.setTitle(this.editorTabTitle(editor));
          this.updateModifiedMarker();
        };
        this.tabSubs.get(editor.root)?.dispose(); // guard re-attach (tab moved between docks)
        this.tabSubs.set(editor.root, new CompositeDisposable(
          new Disposable(editor.onTitleChange(sync)),
          new Disposable(editor.onModifiedChange(sync)),
        ));
      },
    };
  }

  /** Open a new Terminal tab in the center panel and select it. */
  private openTerminal(): Terminal {
    const built = this.createTerminalTab(this.workbench.cwd);
    const child = this.workbench.center.add(built.widget, { title: built.title });
    built.onAttached?.(child);
    const terminal = this.terminals.get(built.widget)!;
    terminal.focus();
    return terminal;
  }

  // Run a `package.json` script in a new terminal tab via the detected package
  // manager. The shell runs `<pm> run <name>` then execs a login shell, so the
  // tab stays open on the script's output (and ready to re-run) instead of
  // closing the moment the script exits.
  private runScript(name: string): void {
    const cwd = this.workbench.cwd;
    const detect = zym.config.get('scriptRunner.detectPackageManager');
    const pm = detect ? detectPackageManager(cwd) : 'npm';
    const shell = process.env.SHELL || '/bin/bash';
    const run = `${pm} run ${name}`;
    const built = this.createTerminalTab(cwd, {
      command: [shell, '-l', '-c', `${run}; exec ${shell} -l`],
      title: run,
    });
    const child = this.workbench.center.add(built.widget, { title: built.title });
    built.onAttached?.(child);
    this.terminals.get(built.widget)!.focus();
  }

  // Open a `terminal` workbench action in a dedicated terminal tab in that
  // workbench's own center, so its output lands beside the work. The shell runs the
  // command once and the tab stays on its output when it exits (no fresh shell is
  // spawned). Re-running the same action reuses its still-open tab — the command
  // runs again in place — instead of piling up a tab per run. The tab is cleaned up
  // when the action is cleared (pruneActionTerminals) or its workbench is closed.
  // (Terminal-less actions run as background processes in WorkbenchActions, not here.)
  private runWorkbenchActionInTerminal(workbench: Workbench<'user' | Agent>, action: Action): void {
    this.activateWorkbench(workbench); // run beside its workbench — switch to it if needed
    const shell = process.env.SHELL || '/bin/bash';
    const command = [shell, '-l', '-c', action.command];

    // Reuse the action's existing tab if it's still around (it lingers on its output
    // after the command exits): bring it forward and re-run the command in place.
    const existing = this.findActionTerminal(workbench, action.id);
    if (existing) {
      existing.child.select();
      existing.terminal.run(command);
      existing.terminal.focus();
      return;
    }

    const built = this.createTerminalTab(workbench.cwd, {
      command,
      title: action.label,
      keepOpenOnExit: true, // stay on the output when the command exits; don't respawn a shell
      transient: true, // too short-lived to restore — keep it out of the session
      // Reflect the command's start/exit so the header run/stop button + icon update.
      onRunningChange: () => this.actionTerminalChanges.emit('change', workbench),
    });
    const child = workbench.center.add(built.widget, { title: built.title });
    built.onAttached?.(child);
    const terminal = this.terminals.get(built.widget)!;
    this.actionTerminals.set(built.widget, { workbench, actionId: action.id, terminal, child });
    terminal.focus();
  }

  // The still-open terminal tab for `workbench`'s action, or null. (Closed tabs are
  // dropped from the map by disposeChild, so a hit is always a live tab.)
  private findActionTerminal(workbench: Workbench<'user' | Agent>, actionId: string) {
    for (const entry of this.actionTerminals.values())
      if (entry.workbench === workbench && entry.actionId === actionId) return entry;
    return null;
  }

  // Close the terminal tabs of `workbench`'s actions that no longer exist — the set
  // changed (agent set_actions, a reset, or a file edit) and dropped these, so their
  // dedicated terminals are stale. Closing the tab tears down the rest via disposeChild.
  private pruneActionTerminals(workbench: Workbench<'user' | Agent>): void {
    const live = new Set(workbench.actions.actions.map((a) => a.id));
    for (const entry of [...this.actionTerminals.values()])
      if (entry.workbench === workbench && !live.has(entry.actionId)) entry.child.close();
  }

  // Construct + wire a terminal tab WITHOUT attaching it to a panel. Shared by
  // openTerminal, the script runner, and session restore (a restored terminal is
  // a fresh shell in cwd). `command`/`title` let a caller run something other than
  // a login shell (e.g. a package script).
  private createTerminalTab(cwd: string, options: { command?: string[]; title?: string; keepOpenOnExit?: boolean; transient?: boolean; onRunningChange?: () => void } = {}): RestoredChild {
    let child: PanelChild | null = null;
    const terminal = new Terminal({
      cwd,
      command: options.command,
      title: options.title,
      keepOpenOnExit: options.keepOpenOnExit,
      transient: options.transient,
      onRunningChange: options.onRunningChange,
      // The shell exiting (`exit`/Ctrl-D) closes its tab. A `keepOpenOnExit` tab
      // (an agent action) instead stays on its output and never fires this.
      onExit: () => child?.close(),
    });
    this.terminals.set(terminal.root, terminal);
    return {
      widget: terminal.root,
      title: terminalTabTitle(terminal),
      onAttached: (attached) => {
        child = attached;
        this.tabSubs.get(terminal.root)?.dispose(); // guard re-attach
        this.tabSubs.set(terminal.root, new CompositeDisposable(
          new Disposable(terminal.onTitleChange(() => attached.setTitle(terminalTabTitle(terminal)))),
        ));
      },
    };
  }

  // Serialize one center tab (editor/terminal/agent) to its session state, or
  // null for a tab that shouldn't persist.
  private serializeChild(widget: Widget): TabState | null {
    const editor = this.editors.get(widget);
    if (editor) return editor.serialize();
    const terminal = this.terminals.get(widget);
    if (terminal) return terminal.serialize();
    return null;
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
      onOpenFile: (path) => this.openFile(path),
    });
    // Track in the kind's map (terminal focus-routing / headless disposal key off these).
    if (agent instanceof AgentTerminal) this.terminals.set(agent.root, agent);
    else if (agent instanceof AgentConversation) this.conversations.set(agent.root, agent);
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
    // A running agent reports as modified, so it's consulted before exit.
    this.participants.set(agent.root, zym.session.registerParticipant(agent));
    // Keep the secondary-sidebar header title in sync when this agent is the shown one.
    const agentSubs = new CompositeDisposable();
    this.agentSubs.set(agent, agentSubs);
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
    return this.activeEditor?.getSelectedText() ?? '';
  }
  private editorFileText(): string {
    const file = this.activeEditor?.currentFile;
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
        layout: workbench.center.serializeLayout((w) => this.serializeChild(w)),
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
          this.openFileIn(tab.path, panel, { focus: false, owner: workbench });
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
      const editor = this.openFileIn(path, panel, { focus: false });
      if (!firstInPane && panel.getChildren().includes(editor.root)) firstInPane = editor;
    }
    if (firstInPane) {
      this.editorChildren.get(firstInPane.root)?.select();
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
    if ([...this.editors.values()].some((editor) => editor.currentFile === path)) return;
    // openPanel splits the agent panel to the right on the first file, then reuses
    // that work area for the rest. Pass the agent's workbench as owner so the editor's
    // gutter uses *its* (worktree) git, not the active workbench's.
    const panel = workbench.center.openPanel;
    // focus: false never grabs keyboard focus. select: only the first file reveals
    // itself — it fills the freshly-created (empty) work area so there's something to
    // see. Every later edit opens quietly as a background tab in the bar, so the agent's
    // edits never pull the view off whatever the user is looking at or editing.
    const select = panel.tabCount === 0;
    this.openFileIn(path, panel, { focus: false, owner: workbench, select });
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
    for (const entry of [...this.actionTerminals.values()])
      if (entry.workbench === workbench) this.disposeChild(entry.terminal.root);
    if (this.workbench.owner === agent) this.activateOwner('user'); // swap away first
    this.workbenches.delete(agent); // its workbench (center + Files/Git + bottom + tabs) goes
    if (workbench) {
      // Tear down the editors that lived in this workbench — closing it drops their
      // widgets but not their bookkeeping (gutter git subscription, LSP doc ref,
      // session participant, the editor→workbench entry that pins the workbench).
      // Copy first: disposeChild mutates editorOwners.
      for (const [widget, owner] of [...this.editorOwners]) {
        if (owner === workbench) this.disposeChild(widget);
      }
      workbench.dispose(); // tears down every widget it owns (file tree, Source-Control,
      // dock + center Panels, bottom-dock content) and releases its pooled git repo
    }
    this.participants.get(agent.root)?.dispose();
    this.participants.delete(agent.root);
    this.agentSubs.get(agent)?.dispose(); // title/status/worktree/files subscriptions
    this.agentSubs.delete(agent);
    this.agentSidebar.removeAgent(agent.root); // drop its page from the secondary-sidebar stack
    this.terminals.get(agent.root)?.dispose(); // sever the AgentTerminal's Vte focus controller
    this.terminals.delete(agent.root);
    this.conversations.get(agent.root)?.dispose(); // headless agent: kill child + IPC watchers
    this.conversations.delete(agent.root);
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
  // shares the same callbacks — they operate on the shared per-widget maps, and
  // only the *active* center fires interactive events (the others are detached).
  private makeCenter(): PanelGroup {
    return new PanelGroup({
      onActiveChanged: () => this.onActiveTabChanged(),
      onTabCloseRequest: (widget) => {
        // An agent's terminal tab is never closed/destroyed here, whatever its state:
        // closing it would kill a running agent and would drop a stopped one from the
        // list — neither is what tab:close should do (retiring an agent is a separate
        // command). Veto the close (the terminal stays put in its workbench, alive) and
        // just return to the user's workbench, so the agent is one switch away (re-select
        // it to bring it back). Defer the swap out of the close-page emission: it
        // reparents the agent workbench (an ancestor of the emitting tab view), unsafe
        // mid-emit.
        const terminal = this.terminals.get(widget);
        const owner: Agent | null = terminal instanceof AgentTerminal ? terminal : (this.conversations.get(widget) ?? null);
        if (owner) {
          if (this.workbench.owner === owner)
            setTimeout(() => {
              if (this.workbench.owner === owner) this.activateOwner('user');
            }, 0);
          return false;
        }
        return true;
      },
      // Agent tabs are vetoed above, so only editors / plain terminals reach here.
      // Snapshot the tab's restorable state before disposeChild tears it down, so
      // `tab:reopen-last` can rebuild it; tabs that don't persist (search-results /
      // diff views) serialize to null and aren't recorded.
      onClosed: (widget) => {
        const state = this.serializeChild(widget);
        if (state) zym.workspace.recordClosedTab(state);
        this.disposeChild(widget);
      },
    });
  }

  // Drop a closed tab's bookkeeping (editor/terminal/agent maps + session
  // registration) and run its close side effects. Shared by the center and the
  // right-dock editor group, which host the same kinds of tab.
  private disposeChild(widget: Widget): void {
    this.tabSubs.get(widget)?.dispose(); // editor/terminal title + modified-state subscriptions
    this.tabSubs.delete(widget);
    this.participants.get(widget)?.dispose();
    this.participants.delete(widget);
    this.editorRegistrations.get(widget)?.dispose(); // detach observing plugins
    this.editorRegistrations.delete(widget);
    this.editors.get(widget)?.dispose(); // explicit teardown, not reliant on the GTK destroy signal
    this.editors.delete(widget);
    this.projectSearchViews.get(widget)?.dispose(); // free its results' per-source parses
    this.projectSearchViews.delete(widget);
    this.tabCloseHandlers.get(widget)?.(); // generic tab teardown (e.g. dispose a hosted diff view)
    this.tabCloseHandlers.delete(widget);
    this.editorOwners.delete(widget);
    this.editorChildren.delete(widget);
    this.terminals.get(widget)?.dispose(); // sever the Vte focus controller (rule 9)
    this.terminals.delete(widget);
    // A workbench-action terminal: kill any still-running command (e.g. a dev server)
    // so a closed/cleared action leaves nothing behind, then drop it from the map and
    // notify so the run/stop button drops back to "start" (the tab is gone — disposing
    // the terminal severed its onRunningChange, so emit the change ourselves).
    const actionTerminal = this.actionTerminals.get(widget);
    actionTerminal?.terminal.kill();
    actionTerminal?.terminal.dispose();
    this.actionTerminals.delete(widget);
    if (actionTerminal) this.actionTerminalChanges.emit('change', actionTerminal.workbench);
    this.conversations.get(widget)?.dispose(); // kill the claude child + IPC watchers
    this.conversations.delete(widget);
    this.updateModifiedMarker(); // a closed editor no longer counts as unsaved
  }

  // Rebuild one closed tab from its serialized state — the reopener `zym.workspace`
  // calls (it owns the history stack; the panel tree lives here). Reuses the same
  // per-kind reconstruction as session restore (deserializeTab + the shared builders,
  // so cursor/scroll come back too), then attaches the rebuilt tab to the active pane
  // and focuses it. Returns false when it can't be rebuilt (e.g. a file deleted since
  // it was closed), so the workspace skips it and tries the next entry.
  private reopenTab(state: TabState): boolean {
    const built = deserializeTab(state, {
      createEditorTab: (path, restore) => this.createEditorTab(path, restore),
      createTerminalTab: (cwd) => this.createTerminalTab(cwd),
    });
    if (!built) return false;
    const child = this.workbench.center.add(built.widget, { title: built.title, requireTabBar: built.requireTabBar });
    built.onAttached?.(child);
    (this.editors.get(built.widget) ?? this.terminals.get(built.widget))?.focus();
    return true;
  }

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
    const center = this.makeCenter();
    const fileTree = new FileTree({
      rootPath: cwd,
      onOpenFile: (path) => this.openFile(path),
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
      (target) => this.openOrFocusFile(target.path, [target.line, target.character]),
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
      run: (action) => this.runWorkbenchActionInTerminal(workbench, action),
      stop: (actionId) => this.findActionTerminal(workbench, actionId)?.terminal.kill(),
      isRunning: (actionId) => (this.findActionTerminal(workbench, actionId)?.terminal.pid ?? null) !== null,
      onDidChangeRunning: (cb) => {
        const sub = this.actionTerminalChanges.on('change', (wb) => { if (wb === workbench) cb(); });
        return () => sub.dispose();
      },
    });
    void workbench.actions.onDidChange(() => this.pruneActionTerminals(workbench));
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
    for (const [root, owner] of this.editorOwners) {
      if (owner === workbench) this.editors.get(root)?.setGitRepo(git);
    }
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

  /** The tab title for an editor, prefixed with the modified dot when unsaved. */
  private editorTabTitle(editor: TextEditor): string {
    // A file changed underneath us takes precedence — it's the more urgent signal.
    if (editor.hasDiskChange()) return `${Icons.warning} ${editor.title}`;
    return editor.isModified() ? `${Icons.modified} ${editor.title}` : editor.title;
  }

  /** Show the sidebar-header unsaved dot when any open editor has unsaved edits. */
  private updateModifiedMarker() {
    const modified = [...this.editors.values()].some((e) => e.isModified());
    this.sidebar.list.setModified(modified);
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
    const diff = this.activeContinuousDiff();
    if (!diff) return;
    openDiffFilePicker(this.overlay, diff);
  }

  /** `diff:collapse-files-matching` (`z x`) — collapse every file in the active diff matching a
   *  comma-separated glob filter typed into a picker. */
  private diffCollapseGlobPicker() {
    const diff = this.activeContinuousDiff();
    if (!diff) return;
    openDiffCollapseGlobPicker(this.overlay, diff);
  }

  /**
   * Apply an LSP `WorkspaceEdit`: open editors are edited in their buffer (single
   * undo group, decorations refresh); files with no open editor are edited on
   * disk. Returns how many files were touched and how many resource operations
   * (create/rename/delete) were skipped. Shared by code actions / rename.
   */
  private applyWorkspaceEdit(edit: WorkspaceEdit, encoding: PositionEncoding): { applied: number; resourceOps: number } {
    const { files, resourceOps } = normalizeWorkspaceEdit(edit);
    for (const { uri, edits } of files) {
      const path = uriToPath(uri);
      const open = [...this.editors.values()].find((e) => e.currentFile === path);
      if (open) {
        open.applyLspEdits(edits, encoding);
      } else {
        try {
          Fs.writeFileSync(path, applyTextEdits(Fs.readFileSync(path, 'utf8'), edits, encoding));
        } catch {
          // unreadable / unwritable — skip
        }
      }
    }
    return { applied: files.length, resourceOps };
  }

  // Open `path` (revealing an already-open tab, since openFile dedupes) and place
  // the cursor. Used by location jumps (diagnostics, go-to-definition, search).
  private openOrFocusFile(path: string, cursor: [number, number]): void {
    this.openFile(path).restoreCursor(cursor);
  }

  // Window-level file/edit operations, surfaced in the command palette and (for
  // most) on the space leader. Handlers only; bindings live in the central keymap.
  private registerWindowCommands() {
    zym.commands.add('.AppWindow', {
      'project:search': {
        didDispatch: () =>
          openSearchPicker(this.overlay, this.workbench.cwd, (path, cursor) => this.openFile(path).restoreCursor(cursor)),
        description: 'Search file contents (ripgrep)',
      },
      'git:diff-current': {
        didDispatch: () => this.openCurrentFileDiff(),
        description: 'Diff the current file (working tree vs HEAD)',
        when: () => this.activeEditor?.currentFile != null,
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
        didDispatch: () => this.openProjectSearch(this.activeEditor?.getSelectedText().trim() ?? ''),
        description: 'Project search, seeded with the selected text (multibuffer)',
      },
      'project:search-open': {
        didDispatch: () => this.openProjectSearch(''),
        description: 'Open project search (full-text, ripgrep) in a multibuffer',
      },
      'git:diff-current-changes': {
        didDispatch: () => void this.openLiveDiff(),
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
        didDispatch: () => this.openGitLog(),
        description: 'Open the git log (history) viewer',
        when: () => this.workbench.git.getHead() !== null,
      },
      'diff:expand-context': {
        didDispatch: () => this.activeContinuousDiff()?.expandContextAtCursor(),
        description: 'Reveal more unchanged lines at the nearest gap',
        when: () => this.activeContinuousDiff() !== null,
      },
      'diff:expand-all': {
        didDispatch: () => this.activeContinuousDiff()?.expandAll(),
        description: 'Reveal all unchanged lines (show the full files)',
        when: () => this.activeContinuousDiff() !== null,
      },
      'diff:collapse-context': {
        didDispatch: () => this.activeContinuousDiff()?.collapseContext(),
        description: 'Re-collapse expanded context back to the windowed diff',
        when: () => this.activeContinuousDiff() !== null,
      },
      'diff:toggle-file': {
        didDispatch: () => this.activeContinuousDiff()?.toggleFileCollapseAtCursor(),
        description: 'Collapse / expand the file under the cursor',
        when: () => this.activeContinuousDiff() !== null,
      },
      'diff:collapse-file': {
        didDispatch: () => this.activeContinuousDiff()?.collapseFileAtCursor(),
        description: 'Collapse the file under the cursor to its header',
        when: () => this.activeContinuousDiff() !== null,
      },
      'diff:expand-file': {
        didDispatch: () => this.activeContinuousDiff()?.expandFileAtCursor(),
        description: 'Expand the file under the cursor back to its diff',
        when: () => this.activeContinuousDiff() !== null,
      },
      'diff:next-file': {
        didDispatch: () => this.activeContinuousDiff()?.nextFile(),
        description: 'Move to the next file in the diff',
        when: () => this.activeContinuousDiff() !== null,
      },
      'diff:prev-file': {
        didDispatch: () => this.activeContinuousDiff()?.previousFile(),
        description: 'Move to the previous file in the diff',
        when: () => this.activeContinuousDiff() !== null,
      },
      'diff:go-to-file': {
        didDispatch: () => this.diffFilePicker(),
        description: 'Jump to a file in the diff…',
        when: () => this.activeContinuousDiff() !== null,
      },
      'diff:collapse-all-files': {
        didDispatch: () => this.activeContinuousDiff()?.collapseAllFiles(),
        description: 'Collapse every file to a one-line header (overview)',
        when: () => this.activeContinuousDiff() !== null,
      },
      'diff:collapse-files-matching': {
        didDispatch: () => this.diffCollapseGlobPicker(),
        description: 'Collapse files matching a glob…',
        when: () => this.activeContinuousDiff() !== null,
      },
      'diff:expand-all-files': {
        didDispatch: () => this.activeContinuousDiff()?.expandAllFiles(),
        description: 'Expand every collapsed file back to its diff',
        when: () => this.activeContinuousDiff() !== null,
      },
      'search:toggle-collapse': {
        didDispatch: () => this.activeSearchResults()?.toggleCollapseAtCursor(),
        description: 'Collapse / expand the file under the cursor (search results)',
        when: () => this.activeSearchResults() !== null,
      },
      'search:collapse-all': {
        didDispatch: () => this.activeSearchResults()?.collapseAll(),
        description: 'Collapse every file (search results)',
        when: () => this.activeSearchResults() !== null,
      },
      'search:expand-all': {
        didDispatch: () => this.activeSearchResults()?.expandAll(),
        description: 'Expand every file (search results)',
        when: () => this.activeSearchResults() !== null,
      },
      // Unified hunk commands: the same `git:hunk-stage`/`git:hunk-unstage`/`git:hunk-revert`
      // (`space h s`/`u`/`r`) as the editor gutter, routed here for the continuous diff. The
      // continuous-diff editor is embedded (no gutter), so it never registers the editor's variant —
      // these AppWindow registrations are what the focus chain resolves while it's focused.
      'git:hunk-stage': {
        didDispatch: () => this.activeContinuousDiff()?.stageHunkAtCursor(),
        description: 'Stage the hunk under the cursor (continuous diff)',
        when: () => this.activeContinuousDiff()?.live === true, // staging is live-diff only
      },
      'git:hunk-unstage': {
        didDispatch: () => this.activeContinuousDiff()?.unstageHunkAtCursor(),
        description: 'Unstage the hunk under the cursor (continuous diff)',
        when: () => this.activeContinuousDiff()?.live === true, // staging is live-diff only
      },
      'git:hunk-revert': {
        didDispatch: () => this.activeContinuousDiff()?.revertHunkAtCursor(),
        description: 'Revert the hunk under the cursor (continuous diff)',
        when: () => this.activeContinuousDiff()?.live === true, // revert restores to the index → live-diff only
      },
      'git:hunk-stage-next': {
        didDispatch: () => this.activeContinuousDiff()?.stageHunkAndAdvance(),
        description: 'Stage the hunk under the cursor, then move to the next (continuous diff)',
        when: () => this.activeContinuousDiff()?.live === true, // staging is live-diff only
      },
      'diff:next-hunk': {
        didDispatch: () => this.activeContinuousDiff()?.nextHunk(),
        description: 'Move to the next changed hunk (continuous diff)',
        when: () => this.activeContinuousDiff() !== null,
      },
      'diff:prev-hunk': {
        didDispatch: () => this.activeContinuousDiff()?.prevHunk(),
        description: 'Move to the previous changed hunk (continuous diff)',
        when: () => this.activeContinuousDiff() !== null,
      },
      'diff:review-comment': {
        didDispatch: () => this.activeContinuousDiff()?.startComment(),
        description: 'Comment on the cursor/selection',
        when: () => this.activeContinuousDiff()?.canComment === true, // any diff (routes to an agent)
      },
      'diff:review-toggle': {
        didDispatch: () => this.activeContinuousDiff()?.toggleReviewMode(),
        description: 'Toggle review mode',
        when: () => this.activeContinuousDiff()?.canComment === true,
      },
      'diff:review-send': {
        didDispatch: () => this.activeContinuousDiff()?.submitReview(),
        description: 'Send the review',
        when: () => this.activeContinuousDiff()?.canComment === true,
      },
      'diff:review-remove': {
        didDispatch: () => this.activeContinuousDiff()?.removeCommentAtCursor(),
        description: 'Remove the comment under the cursor',
        when: () => this.activeContinuousDiff()?.canComment === true,
      },
      'diff:open-file': {
        didDispatch: () => this.activeContinuousDiff()?.openFileAtCursor(),
        description: 'Open the file/line under the cursor (continuous diff)',
        when: () => this.activeContinuousDiff() !== null,
      },
      'app:quit': { didDispatch: () => this.onQuit(), description: 'Quit zym' },
      'command-palette:toggle': { didDispatch: () => openCommandPicker(this.overlay), description: 'Show all commands' },
    });
  }

  /** Open a read-only diff of the active file (working tree vs git HEAD) in a tab. */
  private openCurrentFileDiff(): void {
    const editor = this.activeEditor;
    const path = editor?.currentFile;
    if (!editor || !path) return;
    const root = repoRoot(Path.dirname(path));
    if (!root) {
      this.toast('Not in a git repository');
      return;
    }
    const current = editor.getText();
    const rel = Path.relative(root, path);
    git(root, ['show', `HEAD:${rel}`], (ok, stdout) => {
      const head = ok ? stdout : ''; // untracked / new file → empty base (all added)
      if (head === current) {
        this.toast('No changes against HEAD');
        return;
      }
      // One-file diff on the unified surface: OLD = HEAD blob, NEW = the editor's current
      // text (incl. unsaved edits). Read-only snapshot (not backed by the live Document).
      const name = Path.basename(path);
      const view = new DiffView({
        files: [{ path, oldText: head, newText: current }],
        cwd: this.workbench.cwd,
        onActivate: ({ path, row }) => this.openFile(path).restoreCursor([row, 0]),
        onSend: (message) => this.reviewToAgent(message), // comment/review → agent
      });
      const child = this.workbench.center.add(view.root, { title: `± ${name}`, requireTabBar: true });
      this.tabCloseHandlers.set(view.root, () => view.dispose());
      // Consult the diff on window close so unsent review comments aren't lost (disposeChild
      // disposes this with the tab).
      this.participants.set(view.root, zym.session.registerParticipant(view));
      child.select();
      view.focus();
    });
  }

  /** Open the project-search surface in a tab: a debounced search entry + ripgrep flag
   *  toggles over an editable results multibuffer (docs/text-editor/multibuffer.md). Seeded
   *  with `initialQuery` (the editor selection for `space *`) or empty (`space p s`). */
  private openProjectSearch(initialQuery: string): void {
    const view = new ProjectSearchView({
      cwd: this.workbench.cwd,
      documents: this.documents,
      initialQuery,
      onActivate: ({ path, row }) => this.openFile(path).restoreCursor([row, 0]),
    });
    const title = initialQuery ? `${Icons.search}  ${initialQuery}` : `${Icons.search}  Search`;
    const child = this.workbench.center.add(view.root, { title, requireTabBar: true });
    this.projectSearchViews.set(view.root, view); // disposeChild tears it down on close
    child.select();
    view.focus();
  }

  /** Host `widget` as a center tab: select, focus, and register its `onClose` teardown
   *  (disposeChild runs it on close). Backs `zym.workspace.openTab` for any component. */
  private openCenterTab(widget: Widget, options: OpenTabOptions): void {
    const child = this.workbench.center.add(widget, { title: options.title, requireTabBar: options.requireTabBar });
    if (options.onClose) this.tabCloseHandlers.set(widget, options.onClose);
    child.select();
    widget.grabFocus();
  }

  /** Build a live, editable working-tree DiffView for `workbench`'s changes: NEW side = each
   *  changed file's current text (an open document's live text incl. unsaved edits, else from
   *  disk; a deleted file → empty) backed by a live Document, OLD side = the HEAD blob. Null only
   *  outside a repo; a clean working tree yields an empty diff (its "No changes" empty state).
   *  Shared by the `git:diff-current-changes` center tab and the GitPanel's embedded diff (which
   *  calls it through GitPanelOptions.buildDiffView). */
  private async buildCurrentChangesDiff(workbench: Workbench<'user' | Agent>): Promise<DiffView | null> {
    const cwd = workbench.cwd;
    const root = repoRoot(cwd);
    if (!root) return null;
    const paths = [...workbench.git.getFileStatuses().keys()].sort();
    const showHead = (rel: string): Promise<string> =>
      new Promise((resolve) => git(root, ['show', `HEAD:${rel}`], (ok, out) => resolve(ok ? out : '')));
    const files = await Promise.all(
      paths.map(async (path) => {
        const oldText = await showHead(Path.relative(root, path));
        const open = this.documents.find(path);
        let newText = open ? open.getText() : '';
        let deleted = false;
        if (!open) {
          try {
            newText = Fs.readFileSync(path, 'utf8');
          } catch {
            deleted = true; // gone from the working tree (and not held open) → a deletion
          }
        }
        return { path, oldText, newText, deleted };
      }),
    );
    return new DiffView({
      files,
      cwd,
      editable: true,
      live: true, // the staging surface: live worktree+index → staging markers + `space h s`/`space h u`
      documents: this.documents,
      git: workbench.git, // enables the staged/unstaged gutter marker + `space h s`/`space h u`
      onActivate: ({ path, row }) => this.openFile(path).restoreCursor([row, 0]),
      // The view formats the comment/review; the host just delivers the string. `reviewToAgent`
      // sends to the current agent (or opens the picker to choose/start one when none runs), so a
      // review always reaches an agent — even from the user workbench.
      onSend: (message) => this.reviewToAgent(message),
    });
  }

  /** Show every changed file (working tree vs HEAD) as ONE continuous diff in a tab — the live,
   *  editable staging surface (multibuffer; docs/text-editor/multibuffer.md). */
  private async openLiveDiff(): Promise<void> {
    const view = await this.buildCurrentChangesDiff(this.workbench);
    if (!view) {
      this.toast('Not in a git repository'); // a clean tree still opens the diff (its empty state)
      return;
    }
    const title = () => {
      const mod = view.isModified() ? `${Icons.modified} ` : '';
      const review = view.reviewCount > 0 ? `  ${Icons.comment} ${view.reviewCount}` : '';
      return `${mod}${Icons.git}  Diff${review}`;
    };
    const child = this.workbench.center.add(view.root, {
      title: title(),
      requireTabBar: true,
    });
    this.tabCloseHandlers.set(view.root, () => view.dispose()); // disposeChild tears it down on close
    // Consult the diff on window close (unsaved edits OR unsent review comments). disposeChild
    // disposes this registration with the tab.
    this.participants.set(view.root, zym.session.registerParticipant(view));
    view.onModifiedChange(() => child.setTitle(title())); // show the unsaved marker on edit/save
    view.onReviewChange(() => child.setTitle(title())); // show the accumulated-review count
    child.select();
    view.focus();
  }

  // `git:log` — open the git history viewer as a single center tab. The viewer is a
  // self-contained split (commit list | selected commit's diff); it hosts and disposes
  // the embedded diff itself, so the host just opens + focuses the tab.
  private openGitLog(): void {
    const cwd = this.workbench.cwd;
    if (!repoRoot(cwd)) {
      this.toast('Not in a git repository');
      return;
    }
    const view = new GitLogView({ cwd, git: this.workbench.git });
    this.openCenterTab(view.root, {
      title: `${Icons.git}  Log`,
      requireTabBar: true,
      onClose: () => view.dispose(),
    });
    view.focus(); // openCenterTab focuses the tab root; move focus into the commit list
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
      'terminal:new': { didDispatch: () => this.openTerminal(), description: 'Open a new terminal' },
      'scripts:run': {
        didDispatch: () => openScriptRunner(this.overlay, this.workbench.cwd, (name) => this.runScript(name)),
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
        didDispatch: () => this.openFile(ensureProjectSettingsFile(this.workbench.cwd)),
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
      'config:open-as-text': { didDispatch: () => this.openFile(configPath()), description: 'Open config.json' },
      'keymap:open-as-text': { didDispatch: () => this.openFile(ensureUserKeymap()), description: 'Edit the user keymap (keymap.json)' },
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

  // Focus the editor/terminal backing a center-tab content widget — the tail of the
  // active-pane focus that WorkbenchView delegates back here, since the editor/terminal
  // maps (the tab registry) live on the AppWindow.
  private focusContent(widget: Widget): void {
    const editor = this.editors.get(widget);
    if (editor) { editor.focus(); return; }
    this.terminals.get(widget)?.focus();
  }

  // --- Active editable surfaces (resolved from the focused tab) --------------

  /** The active center/focused child resolved to a widget, for surface lookups. */
  private activeChildWidget(): Widget | null {
    return Panel.active?.activeChild ?? this.workbench.center.activePanel.activeChild ?? null;
  }

  /** The project-search results multibuffer hosted by the active child, if any. */
  private activeMultibuffer(): SearchResultsView | null {
    const focused = Panel.active?.activeChild;
    const focusedMb = focused ? this.projectSearchViews.get(focused)?.results : undefined;
    if (focusedMb) return focusedMb;
    const centerChild = this.workbench.center.activePanel.activeChild;
    return centerChild ? this.projectSearchViews.get(centerChild)?.results ?? null : null;
  }

  /** The active editable surface (project-search or diff multibuffer) that owns a `save()`. */
  private activeSavableSurface(): { save(): void } | null {
    const widget = this.activeChildWidget();
    if (!widget) return null;
    return this.projectSearchViews.get(widget) ?? DiffView.forRoot(widget) ?? null;
  }

  /** The diff multibuffer the diff commands act on. Prefer the DiffView containing keyboard focus
   *  (found by walking up from the focused widget) — that covers an *embedded* diff like the
   *  GitPanel's, which isn't itself a center tab, so `activeChildWidget` (tab content) would resolve
   *  to its host panel and miss it. Falls back to the active center tab's content. */
  private activeContinuousDiff(): DiffView | null {
    for (let w: Widget | null = this.window.getFocus(); w; w = w.getParent()) {
      const diff = DiffView.forRoot(w);
      if (diff) return diff;
    }
    const widget = this.activeChildWidget();
    return widget ? DiffView.forRoot(widget) : null;
  }

  /** The search-results multibuffer hosted by the active child, if any (for the collapse commands). */
  private activeSearchResults(): SearchResultsView | null {
    const widget = this.activeChildWidget();
    return widget ? this.projectSearchViews.get(widget)?.results ?? null : null;
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

