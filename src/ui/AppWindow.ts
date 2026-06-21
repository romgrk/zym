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
import {
  Adw,
  Gtk,
  type Application,
  type ApplicationWindow,
  type ToastOverlay,
} from '../gi.ts';
import { FileTree } from './FileTree.ts';
import { Panel, type PanelChild } from './Panel.ts';
import { PanelGroup, type Direction, type RestoredChild } from './PanelGroup.ts';
import { TextEditor } from './TextEditor/index.ts';
import { DocumentRegistry } from './TextEditor/DocumentRegistry.ts';
import { buildDefinitionPeek, wrapPeekBody, LIVE_PEEK_HEIGHT } from './TextEditor/buildDefinitionPeek.ts';
import { Terminal } from './Terminal.ts';
import { AgentTerminal, type AgentStatus, type AgentResume } from './AgentTerminal.ts';
import type { Agent } from '../agents/types.ts';
import { defaultAction, type AgentAction } from '../agents/actions.ts';
import { openActionRunner } from './ActionPicker.ts';
import { AgentConversation } from './AgentConversation.ts';
import { AGENT_CONFIGS, resolveAgentKind, type AgentKind } from '../agents/configs.ts';
import { listResumableSessions, recordSessionWorktree, relativeTime, type AgentSession } from '../agentSessions.ts';
import { WorkbenchList, PROJECT_NAME } from './WorkbenchList.ts';
import { WorkbenchStatus } from './WorkbenchStatus.ts';
import { GitPanel } from './GitPanel.ts';
import { fileIconGlyph } from './fileIcons.ts';
import { Icons } from './icons.ts';
import { NERDFONT } from './nerdfont.ts';
import { GitBranchButton } from './GitBranchButton.ts';
import { GithubButtons } from './GithubButtons.ts';
import { acquireGitRepo, releaseGitRepo, type GitOpResult } from '../git.ts';
import { git, repoRoot, invalidateRepoRoot, commitMsgPath, listWorktrees } from '../git.ts';
import { openGithubService, type GithubService } from '../github.ts';
import { computeDiff } from '../util/DiffModel.ts';
import { DiffViewer } from './TextEditor/DiffViewer.ts';
import { Workbench, DOCK_SIDES, type BottomDock, type DockSide } from './Workbench.ts';
import { openFilePicker } from './FilePicker.ts';
import { openFileOpener } from './FileOpener.ts';
import { openScriptRunner, detectPackageManager } from './ScriptRunner.ts';
import { openWorkspaceSymbolPicker } from './WorkspaceSymbolPicker.ts';
import { openDocumentSymbolPicker } from './DocumentSymbolPicker.ts';
import { openSearchPicker } from './SearchPicker.ts';
import { SearchResultsView } from './SearchResultsView.ts';
import { ContinuousDiffView } from './ContinuousDiffView.ts';
import { runProjectSearch, matchesToExcerptInputs } from './multibuffer/projectSearch.ts';
import { openReferencesPicker } from './ReferencesPicker.ts';
import { openCommandPicker } from './CommandPicker.ts';
import { WhichKey } from './WhichKey.ts';
import { openAgentPicker } from './AgentPicker.ts';
import { openWorktreePicker } from './WorktreePicker.ts';
import { openAgentLauncher } from './AgentLauncher.ts';
import {
  openBranchPicker,
  openDeleteBranchPicker,
  openMergeBranchPicker,
  openRenameBranchPicker,
} from './BranchPicker.ts';
import { openStashPicker } from './StashPicker.ts';
import { openGithubFailedCIPicker } from './GithubFailedCIPicker.ts';
import { openGithubCIChecksPicker } from './GithubCIChecksPicker.ts';
import { switchToGithubPrPicker } from './GithubPrPicker.ts';
import { openGithubIssuePicker } from './GithubIssuePicker.ts';
import { openPicker } from './Picker.ts';
import { proseMarkup, escapeMarkup, PROSE_LINE_HEIGHT } from './proseMarkup.ts';
import { openConfigEditor } from './ConfigEditor.ts';
import { zym } from '../zym.ts';
import { type SessionParticipant, type TabState, type WorkspaceState, type SessionState, type PanelNode } from '../SessionManager.ts';
import { SessionController } from '../SessionController.ts';
import { type Notification } from '../Notification.ts';
import { NotificationLog } from './NotificationLog.ts';
import { KeymapPanel } from './KeymapPanel.ts';
import { DiagnosticsPanel } from '../lsp/diagnostics/DiagnosticsPanel.ts';
import { PluginManagerPanel } from './PluginManagerPanel.ts';
import { type NavigationKind, type LspConfig, type LspDocument } from '../lsp/LspManager.ts';
import { normalizeWorkspaceEdit, applyTextEdits } from '../lsp/workspaceEdit.ts';
import { uriToPath, type PositionEncoding } from '../lsp/position.ts';
import type { WorkspaceEdit, CodeAction, Command } from 'vscode-languageserver-protocol';
import { NotificationToasts } from './NotificationToasts.ts';
import { loadKeymaps, ensureUserKeymap } from '../keymaps/load.ts';
import { loadConfig, configPath } from '../config/load.ts';
import { CompositeDisposable, Disposable, type DisposableLike } from '../util/eventKit.ts';
import { styles } from '../styles.ts';
import { theme } from '../theme/theme.ts';

// The identifier under the cursor (for prefilling the rename prompt). Codepoint-
// aware: columns are codepoints, so index the line as codepoints.
function wordUnderCursor(doc: LspDocument): string {
  const cursor = doc.getCursorBufferPosition();
  const cp = [...doc.lineTextForRow(cursor.row)];
  let start = cursor.column;
  let end = cursor.column;
  while (start > 0 && /\w/.test(cp[start - 1])) start--;
  while (end < cp.length && /\w/.test(cp[end])) end++;
  return cp.slice(start, end).join('');
}

const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 950;
const TOAST_TIMEOUT = 15;
// Shared `replaceKey` for the upstream-pull lifecycle, so the "behind" prompt,
// the "pulling…" spinner, and the result all transform one toast in place.
const PULL_NOTICE_KEY = 'git:pull';
// Expanded width (px) of the workbench sidebar — the full-height column at the very
// left of the window, outside (left of) the header bar.
const LAYOUT_SIDEBAR_WIDTH = 280;
// Collapsed sidebar width (icons only) — toggled by the robot button.
const LAYOUT_SIDEBAR_COLLAPSED_WIDTH = 48;

type Widget = InstanceType<typeof Gtk.Widget>;

export class AppWindow {
  private readonly app: Application;
  private readonly onQuit: () => void;

  // Per-tab focus memory: the widget that last held keyboard focus inside each
  // panel-tab child, so re-activating a panel restores focus to the exact same
  // widget (e.g. an editor's search bar, not just the editor view). Keyed by the
  // tab's content widget (the `.is-panel-child`); a WeakMap so closed tabs drop.
  private readonly focusMemory = new WeakMap<Widget, Widget>();

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

  private readonly workbenchList: WorkbenchList;
  // The top-level split whose start child is the workbench sidebar; its position is
  // the sidebar width (toggled between expanded / collapsed by the robot button).
  private sidebarSplit!: InstanceType<typeof Gtk.Paned>;
  // Commit-message editor tabs: the message file each is bound to, so closing the
  // tab can commit (git-style: write the message, save, close to commit).
  private readonly commitEditors = new Map<Widget, { repo: string; msgPath: string }>();
  // Maps an agent's root widget to its center tab handle, so the agent list can
  // reveal (select) the agent's tab on activation.
  private readonly agentChildren = new Map<Widget, PanelChild>();
  // Maps an editor's root widget to its center tab handle, so a location jump can
  // reveal an already-open file instead of opening a duplicate tab.
  private readonly editorChildren = new Map<Widget, PanelChild>();
  // Tab-hosted multibuffers (project:search-results), keyed by root widget so the view
  // is disposed (freeing its per-source DocumentSyntax parses) when its tab closes.
  private readonly searchResultsViews = new Map<Widget, SearchResultsView>();
  // Tab-hosted continuous multi-file diff views (git:continuous-diff), same lifecycle.
  private readonly continuousDiffViews = new Map<Widget, ContinuousDiffView>();
  // Session modified-status registrations (editors, running agents), keyed by the
  // tab's root widget so the registration is disposed when the tab closes.
  private readonly participants = new Map<Widget, DisposableLike>();
  // Set once the user has confirmed an exit past unsaved work, so the re-entrant
  // close-request doesn't prompt again.
  private quitting = false;
  // The plugin manager center tab handle; null after it is closed.
  private pluginManagerTab: { root: Widget; child: PanelChild } | null = null;
  // The most recently focused agent — the default target for send-to-agent.
  private lastAgent: Agent | null = null;
  // The agent the user is currently looking at (its tab is the active one), so its
  // status counts as seen — clears the sidebar attention blink (see updateViewedAgent).
  private viewedAgent: Agent | null = null;
  private readonly toastOverlay: ToastOverlay;
  // Content-area overlay: hosts the active workbench (swapped on agent switch) and
  // the notification toasts — floats below the header bar, right of the sidebar.
  private readonly contentOverlay: InstanceType<typeof Gtk.Overlay>;
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

  // Header-bar git chrome. The GitRepo itself lives on the active workbench
  // (`this.workbench.git`); these widgets are re-pointed at it on switch.
  private readonly branchButton: GitBranchButton;
  // Reactive GitHub PR/CI model (busy-aware) shared by the header buttons.
  private readonly github: GithubService;
  // Header-bar links to the repository / PR / issue on GitHub.
  private readonly githubButtons: GithubButtons;
  // Right-aligned header cluster: diagnostics pill + LSP status indicator.
  private readonly workbenchStatus: WorkbenchStatus;
  // Last-seen upstream "behind" count, to fire the pull notification only on the
  // transition into being behind (not on every status poll while behind).
  private lastBehind = 0;
  // Unsubscribe for the upstream-behind watch on the active workbench's git;
  // swapped by `rebindGitChrome` on every workbench switch.
  private upstreamUnsub: (() => void) | null = null;
  // Background git fetch interval timer (null when disabled).
  private autoFetchTimer: NodeJS.Timeout | null = null;

  // Watches the user config file and syncs edits into zym.config; cancelled on
  // close.
  private readonly configWatcher: DisposableLike;
  // Watches the user keymap file and re-registers it live; cancelled on close.
  private readonly keymapWatcher: DisposableLike;
  // which-key hint overlay (continuations after a queued keymap prefix).
  private readonly whichKey: WhichKey;

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

    // Header-bar git chrome targets the *active* workbench's git/cwd;
    // activateWorkbench re-points it (setRepo/rebind) on a person switch. The
    // click/picker closures read `this.workbench` lazily, so they always act on
    // the workbench shown when invoked.
    this.branchButton = new GitBranchButton(this.workbench.git,
      () => openBranchPicker(this.overlay, this.workbench.cwd, this.workbench.git));
    this.github = openGithubService(this.workbench.git, {
      cwd: this.workbench.cwd,
      remoteNames: () => {
        const upstream = (zym.config.get('git.remotes.upstream') as string) || 'upstream';
        const origin = (zym.config.get('git.remotes.origin') as string) || 'origin';
        return [upstream, origin];
      },
    });
    this.githubButtons = new GithubButtons({
      git: this.workbench.git,
      github: this.github,
      cwd: this.workbench.cwd,
      onShowChecks: () => openGithubCIChecksPicker(this.overlay, this.workbench.cwd),
    });
    this.workbenchStatus = new WorkbenchStatus({
      onOpenDiagnostics: () => this.toggleDiagnosticsPanel(),
      onOpenLog: () => this.toggleNotificationLog(),
      // Pill + LSP indicator scope to the active workbench's worktree.
      ownsPath: (path) => this.ownerWorkbenchCwd(path) === this.workbench.cwd,
      ownsServer: (rootDir) => this.ownerWorkbenchCwd(rootDir) === this.workbench.cwd,
    });

    // The workbench list lives in its own full-height sidebar at the very left of the
    // window (built into the top-level split below), not in the workbench dock.
    this.workbenchList = new WorkbenchList({
      onActivate: (agent) => this.showAgent(agent),
      onActivateUser: () => this.activateOwner('user'), // the user row → user workbench
      onToggleCollapsed: (collapsed) =>
        this.sidebarSplit.setPosition(collapsed ? LAYOUT_SIDEBAR_COLLAPSED_WIDTH : LAYOUT_SIDEBAR_WIDTH),
      onRestart: (agent) => this.restartAgent(agent),
      onStop: (agent) => agent.kill(),
      onClose: (agent) => this.closeAgent(agent),
      onRename: (agent) => this.renameAgentPrompt(agent),
      onOpenChanges: (agent) => this.openAgentChanges(agent),
      gitFor: (agent) => this.workbenches.get(agent)?.git ?? null,
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
      }),
      applyDocks: (docks) => {
        if (docks.notificationLog && this.workbench.bottomDock !== 'notifications') this.toggleNotificationLog();
        // Apply per-side visibility *after* any content has been (re)established above,
        // so a side restored as hidden stays hidden even though its content is present.
        if (docks.visible)
          for (const side of DOCK_SIDES) this.workbench.setDockVisible(side, docks.visible[side] !== false);
      },
      serializeAgentWorkspaces: () => this.serializeAgentWorkspaces(),
      restoreAgent: (ws) => this.restoreAgent(ws),
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
    toolbarView.addTopBar(this.buildHeaderBar());
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

    // Workbench sidebar: a full-height column at the very left of the window, *outside*
    // the header bar. A top-level horizontal paned splits it from everything else
    // (the header bar + workbench, wrapped by the toast overlay), so it spans from
    // the window's top edge to its bottom; its width (the split position) is toggled
    // between expanded / collapsed by the robot button.
    const workbenchSidebar = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    workbenchSidebar.setName('WorkbenchSidebar'); // selector identity for CSS
    this.workbenchList.root.setHexpand(true);
    this.workbenchList.root.setVexpand(true); // fill the sidebar (height + width)
    workbenchSidebar.append(this.workbenchList.root);
    this.sidebarSplit = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
    this.sidebarSplit.setStartChild(workbenchSidebar);
    this.sidebarSplit.setEndChild(this.toastOverlay);
    this.sidebarSplit.setPosition(LAYOUT_SIDEBAR_WIDTH);
    this.sidebarSplit.setResizeStartChild(false); // window resize grows the content, not the sidebar
    this.sidebarSplit.setShrinkStartChild(false);

    // Window-level overlay over the whole layout (sidebar + header + content), so
    // floating pickers cover the entire window rather than being clipped to the
    // content area (where they slid under the sidebar).
    this.overlay = new Gtk.Overlay();
    this.overlay.setChild(this.sidebarSplit);

    // Bridge the notification manager to the toast stack. Only actionable
    // User-facing severities (info/success/warning/error/fatal) pop a transient
    // toast; only `trace` (the debug level) is log-only, so traces never interrupt.
    // The manager retains the full history for the log regardless.
    const TOAST_TYPES = new Set(['info', 'success', 'warning', 'error', 'fatal']);
    zym.notifications.onDidAddNotification((n) => {
      const notification = n as Notification;
      if (TOAST_TYPES.has(notification.getType())) this.notificationToasts.show(notification);
    });

    this.applyChromeStyles();
    this.applyNotificationStyles();

    this.window = new Adw.ApplicationWindow({ application: app });
    this.window.setName('AppWindow'); // selector identity for command/keymap rules
    this.window.setTitle(PROJECT_NAME); // OS taskbar label — the project, not the bare "node"
    this.window.setDefaultSize(DEFAULT_WIDTH, DEFAULT_HEIGHT);
    this.window.setContent(this.overlay);
    // Track the focused widget per panel tab so each panel can restore focus to
    // exactly where it was when it is re-activated (see focusMemory).
    this.window.on('notify::focus-widget', () => this.rememberFocus());

    // Publish the window on the global registry and start the keymap manager's
    // CAPTURE-phase key controller.
    zym.window = this.window;
    // Expose file-opening app-wide (reveal-if-open by default — see openFile).
    zym.workspace.setOpener((path, options) => {
      const editor = this.openFile(path);
      if (options?.cursor) editor.restoreCursor(options.cursor);
    });
    zym.keymaps.initialize();
    // which-key hint: shows the continuations after a queued prefix (e.g. Space).
    this.whichKey = new WhichKey(this.contentOverlay);
    // Components register their commands; the keymap (bindings) is loaded
    // centrally from src/keymaps (default table + optional user override).
    this.registerPaneCommands();
    this.registerWindowCommands();
    this.registerTerminalCommands();
    this.registerGitCommands();
    this.registerNotificationCommands();
    this.registerConfigCommands();
    this.registerSessionCommands();
    this.registerLspCommands();
    this.keymapWatcher = loadKeymaps();

    // Seed/load the user config and keep it in sync with on-disk edits. Done
    // before the first file opens so editors read live config values.
    this.configWatcher = loadConfig();

    // Configure language servers from `lsp.*` config (and on live edits).
    this.configureLsp();
    for (const key of ['lsp.enable', 'lsp.disabledLanguages', 'lsp.servers', 'lsp.autoInstall']) {
      zym.config.onDidChange(key, () => this.configureLsp());
    }

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
    // re-points them on a person switch. Seeds lastBehind so an already-behind
    // repo doesn't toast on launch.
    this.rebindGitChrome();
    this.startAutoFetch();

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

    const restored = willRestore && this.sessionController.restore();
    // Relaunching agents activates each in turn; settle back on the user workbench.
    if (restored) this.activateOwner('user');
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
    if (this.autoFetchTimer) clearInterval(this.autoFetchTimer);
    this.upstreamUnsub?.();
    this.branchButton.dispose();
    this.githubButtons.dispose();
    this.workbenchStatus.dispose();
    this.github.dispose();
    // Release every workbench's pooled GitRepo (refcounted — a shared root is only
    // disposed when its last workbench releases it).
    for (const wb of this.workbenches.values()) releaseGitRepo(wb.git);
    this.configWatcher.dispose();
    this.keymapWatcher.dispose();
    this.workbenchList.dispose();
    this.workbench.gitPanel?.dispose();
    this.workbench.notificationLog.dispose();
    this.workbench.keymapPanel.dispose();
    // Drain any tab/agent subscriptions whose tabs weren't individually closed.
    for (const subs of this.tabSubs.values()) subs.dispose();
    this.tabSubs.clear();
    for (const subs of this.agentSubs.values()) subs.dispose();
    this.agentSubs.clear();
    this.onQuit();
    // node-gtk keeps Node's event loop interleaved with GLib's, so quitting the
    // GLib loop + app doesn't unwind `app.run()` and lingering handles (LSP
    // child processes, fetch/autofetch timers) keep the process alive. Exit
    // explicitly once teardown has run so closing the window ends the process.
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
    options: { focus?: boolean; owner?: Workbench<'user' | Agent> } = {},
  ): TextEditor {
    const focus = options.focus ?? true;
    const targetOwner = options.owner ?? this.workbench;
    const existing = [...this.editors.entries()].find(
      ([widget, editor]) => editor.currentFile === path && this.editorOwners.get(widget) === targetOwner,
    )?.[1];
    if (existing) {
      this.editorChildren.get(existing.root)?.select();
      if (focus) existing.focus();
      return existing;
    }
    return this.openFileViewIn(path, panel, { focus, owner: options.owner });
  }

  // Open a *new* view of `path` in `panel` — no reveal-if-open, so the same file can
  // show in two panes as two views sharing one Document (live model + undo). Used by
  // splitPane; openFileIn reveals instead. `owner` is the workbench the editor lives
  // in (its git feeds the gutter); defaults to the active one.
  private openFileViewIn(path: string, panel: Panel, options: { focus?: boolean; owner?: Workbench<'user' | Agent> } = {}): TextEditor {
    const { focus = true, owner = this.workbench } = options;
    const built = this.createEditorTab(path, { owner });
    const child = panel.add(built.widget, {
      title: built.title,
      requireTabBar: built.requireTabBar,
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

  // Open a `terminal` agent action (set_actions) in a terminal tab in the agent's
  // own workbench, so its output lands beside the agent. Like runScript, the shell
  // runs the command then execs a login shell, keeping the tab open on the output.
  // (Terminal-less actions run as background processes inside the host, not here.)
  private runAgentActionInTerminal(agent: Agent, action: AgentAction): void {
    this.showAgent(agent); // activate the agent's workbench — the action runs beside it
    const shell = process.env.SHELL || '/bin/bash';
    const built = this.createTerminalTab(agent.effectiveCwd, {
      command: [shell, '-l', '-c', `${action.command}; exec ${shell} -l`],
      title: action.label,
    });
    const child = this.workbench.center.add(built.widget, { title: built.title });
    built.onAttached?.(child);
    this.terminals.get(built.widget)!.focus();
  }

  // Construct + wire a terminal tab WITHOUT attaching it to a panel. Shared by
  // openTerminal, the script runner, and session restore (a restored terminal is
  // a fresh shell in cwd). `command`/`title` let a caller run something other than
  // a login shell (e.g. a package script).
  private createTerminalTab(cwd: string, options: { command?: string[]; title?: string } = {}): RestoredChild {
    let child: PanelChild | null = null;
    const terminal = new Terminal({
      cwd,
      command: options.command,
      title: options.title,
      // The shell exiting (`exit`/Ctrl-D) closes its tab.
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
    options: { kind?: AgentKind; prompt?: string; resume?: AgentResume; title?: string; cwd?: string; command?: string[] } = {},
  ): Agent {
    const kind = options.kind ?? (options.resume ? 'claude-tui' : resolveAgentKind(zym.config.get('agent.implementation')));
    const cwd = options.cwd ?? process.cwd();
    const agent = AGENT_CONFIGS[kind].create({
      cwd, command: options.command, prompt: options.prompt, resume: options.resume, title: options.title,
      onOpenFile: (path) => this.openFile(path),
      onRunInTerminal: (action) => this.runAgentActionInTerminal(agent, action),
    });
    // Track in the kind's map (terminal focus-routing / headless disposal key off these).
    if (agent instanceof AgentTerminal) this.terminals.set(agent.root, agent);
    else if (agent instanceof AgentConversation) this.conversations.set(agent.root, agent);
    const workbench = this.buildWorkbench(agent, cwd);
    this.activateWorkbench(workbench);
    const child = workbench.center.pinChild(agent.root, { title: agentTabTitle(agent) });
    this.agentChildren.set(agent.root, child);
    this.updateViewedAgent(); // the agent's tab is now the active one — mark it viewed
    // A running agent reports as modified, so it's consulted before exit.
    this.participants.set(agent.root, zym.session.registerParticipant(agent));
    // The agent's tab carries a status glyph prefix + attention highlight.
    const agentSubs = new CompositeDisposable();
    this.agentSubs.set(agent, agentSubs);
    agentSubs.add(new Disposable(agent.onTitleChange(() => this.updateAgentTab(agent))));
    // Notify when the agent needs attention while the user isn't looking at it.
    let previousStatus = agent.status;
    agentSubs.add(new Disposable(agent.onDidChangeStatus(() => {
      this.updateAgentTab(agent);
      this.notifyAgentAttention(agent, previousStatus, agent.status);
      previousStatus = agent.status;
      // On settle, flag a worktree it created but never announced (validator).
      if (agent.status === 'idle') this.warnUnannouncedWorktree(agent);
    })));
    // The agent announced (via the set_worktree bridge tool) that it moved into a
    // different worktree — re-root its workbench to match.
    agentSubs.add(new Disposable(agent.onDidChangeWorktree(() => {
      this.reRootWorkbench(workbench, agent.effectiveCwd);
      // Persist the dynamically-entered worktree (keyed under the launch cwd's
      // transcript dir) so a later resume can send the agent back to it.
      if (agent.sessionId) recordSessionWorktree(cwd, agent.sessionId, agent.effectiveCwd);
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
    agent.root.addController(focus);
    agent.start(); // terminal: no-op (already spawned); headless: spawn claude now
    agent.focus(); // the workbench is already active (above); focus the agent
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
  // false to deliver in the background and leave focus where it is (a diff comment).
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
  private agentSessionRoots(): string[] {
    const roots = new Set<string>([process.cwd()]);
    for (const wt of listWorktrees(process.cwd())) roots.add(wt.path);
    return [...roots];
  }

  // `openAgent` options to resume `session`, restoring its branch/worktree/cwd:
  // spawn in the cwd Claude recorded (where `--resume` resolves the session and the
  // workbench roots). If the agent had moved into a worktree *dynamically* (a sidecar
  // `effectiveCwd` differing from the transcript cwd), tell it to re-announce that
  // worktree via the bridge so the editor re-roots — and to do nothing else, so a
  // resume just restores the view without kicking off work.
  private resumeOptions(session: AgentSession): { cwd?: string; resume: AgentResume; prompt?: string; title: string } {
    const moved =
      session.effectiveCwd && session.effectiveCwd !== session.cwd ? session.effectiveCwd : null;
    return {
      cwd: session.cwd ?? undefined,
      resume: { sessionId: session.id },
      prompt: moved
        ? `Call the set_worktree tool with the path ${moved} now, and do nothing else — ` +
          `no other tools, commands, or commentary. Then stop and wait for my next instruction.`
        : undefined,
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
        agent: state,
      });
    }
    return out;
  }

  // Relaunch an agent workbench from its saved workspace, resumed to its
  // conversation/worktree. Resolving the conversation via resumeOptions also
  // restores the worktree (and avoids re-running the original launch prompt); a
  // session that's since vanished falls back to a bare resume, and an agent that
  // never reported a session id is relaunched fresh with its original prompt.
  private restoreAgent(ws: WorkspaceState): void {
    const a = ws.agent;
    if (!a) return;
    // Don't duplicate an agent that's already open (explicit restore over a live session).
    if (a.sessionId && zym.agents.getAgents().some((ag) => ag.sessionId === a.sessionId)) return;
    let agent: Agent;
    if (a.sessionId) {
      const session = listResumableSessions(this.agentSessionRoots()).find((s) => s.id === a.sessionId);
      agent = session ? this.openAgent(this.resumeOptions(session)) : this.openAgent({ cwd: a.cwd, resume: { sessionId: a.sessionId } });
    } else {
      // Restored agents are always claude-tui (the headless kind doesn't serialize).
      agent = this.openAgent({ kind: 'claude-tui', cwd: a.cwd, prompt: a.prompt });
    }
    // Reopen the files that were in this agent's work area (its reviewed files). The
    // agent leaf itself is recreated by openAgent; the work-area split geometry
    // isn't preserved — we just reopen the file tabs, rooted in this workbench.
    const workbench = this.workbenches.get(agent);
    if (workbench) {
      const panel = workbench.center.openPanel;
      for (const tab of fileTabsOf(ws.layout)) {
        if (Fs.existsSync(tab.path)) {
          this.openFileIn(tab.path, panel, { focus: false, owner: workbench });
        }
      }
    }
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
      formatMain: (item, positions) => {
        const session = byId.get(item.value);
        const ranElsewhere = session?.cwd && session.cwd !== process.cwd();
        const where = ranElsewhere ? `${escapeMarkup(Path.basename(session!.cwd!))} · ` : '';
        return {
          main: proseMarkup(item.text, positions, !session?.titled),
          detail: `<span face="Sans" line_height="${PROSE_LINE_HEIGHT}">${where}${escapeMarkup(relativeTime(session?.modified ?? 0))}</span>`,
        };
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
    this.workbenchList.selectAgent(this.workbench.owner === 'user' ? null : this.workbench.owner);
  }

  // Tell each agent whether the user is currently looking at it — only the agent
  // whose tab is the active child of the active workbench counts as viewed. Viewing
  // acknowledges its status, clearing the sidebar attention blink; switching away
  // from a still-`waiting` agent lets it blink again to call the user back.
  private updateViewedAgent(): void {
    const active = this.activeAgent;
    const viewed = active && this.workbench.center.activePanel.activeChild === active.root
      ? active
      : null;
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
    if (this.workbench.center.activePanel.activeChild === agent.root) return;
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
    this.openAgent({
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
    // that work area for the rest. Pass the agent's workbench as owner so the
    // editor's gutter uses *its* (worktree) git, not the active workbench's.
    this.openFileIn(path, workbench.center.openPanel, { focus: false, owner: workbench });
  }

  // Restart an agent: retire the old one and relaunch with the same cwd, resuming
  // its claude conversation (forking a still-live session so the original
  // transcript isn't clobbered). A pinned (renamed) title carries over.
  private restartAgent(agent: Agent): void {
    const kind: AgentKind = agent instanceof AgentConversation ? 'claude-sdk' : 'claude-tui';
    const title = agent.renamed ? agent.title : undefined;
    // Resume is claude-tui only; a headless agent restarts fresh in its own cwd.
    const resume = kind === 'claude-tui' && agent.sessionId ? { sessionId: agent.sessionId, fork: !agent.exited } : undefined;
    const cwd = kind === 'claude-sdk' ? agent.effectiveCwd : undefined;
    this.closeAgent(agent);
    this.openAgent({ kind, resume, title, cwd });
  }

  // Close an agent for good: SIGTERM a live child, drop its workbench (returning to
  // the user's workbench if it was active), and retire it from the registry.
  private closeAgent(agent: Agent): void {
    if (!agent.exited) agent.kill();
    if (this.workbench.owner === agent) this.activateOwner('user'); // swap away first
    const workbench = this.workbenches.get(agent);
    this.workbenches.delete(agent); // its workbench (center + Files/Git + bottom + tabs) goes
    if (workbench) {
      // Tear down the editors that lived in this workbench — closing it drops their
      // widgets but not their bookkeeping (gutter git subscription, LSP doc ref,
      // session participant, the editor→workbench entry that pins the workbench).
      // Copy first: disposeChild mutates editorOwners.
      for (const [widget, owner] of [...this.editorOwners]) {
        if (owner === workbench) this.disposeChild(widget);
      }
      workbench.fileTree.dispose(); // also holds a git subscription
      workbench.gitPanel?.dispose();
      // The bottom-dock panels subscribe to global signals (diagnostics store,
      // notifications, keymap) — dispose them so a closed agent leaves nothing behind.
      workbench.diagnosticsPanel.dispose();
      workbench.notificationLog.dispose();
      workbench.keymapPanel.dispose();
      releaseGitRepo(workbench.git); // refcounted; the shared user/worktree repo survives
    }
    this.participants.get(agent.root)?.dispose();
    this.participants.delete(agent.root);
    this.agentSubs.get(agent)?.dispose(); // title/status/worktree/files subscriptions
    this.agentSubs.delete(agent);
    this.agentChildren.delete(agent.root);
    this.terminals.delete(agent.root);
    this.conversations.get(agent.root)?.dispose(); // headless agent: kill child + IPC watchers
    this.conversations.delete(agent.root);
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
      onClosed: (widget) => this.disposeChild(widget),
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
    this.searchResultsViews.get(widget)?.dispose(); // free its per-source parses
    this.searchResultsViews.delete(widget);
    this.continuousDiffViews.get(widget)?.dispose();
    this.continuousDiffViews.delete(widget);
    this.editorOwners.delete(widget);
    this.editorChildren.delete(widget);
    this.terminals.delete(widget);
    this.conversations.get(widget)?.dispose(); // kill the claude child + IPC watchers
    this.conversations.delete(widget);
    this.agentChildren.delete(widget);
    this.updateModifiedMarker(); // a closed editor no longer counts as unsaved
    // A closed commit-message tab finalizes the commit (if a message was saved).
    const commitInfo = this.commitEditors.get(widget);
    if (commitInfo) {
      this.commitEditors.delete(widget);
      this.finishCommit(commitInfo.repo, commitInfo.msgPath);
    }
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
    // The file tree is the only tab created up front. Source Control (GitPanel) is a
    // sibling tab created lazily on first reveal (ensureGitPanel / `git-panel:focus`),
    // so a workbench doesn't construct a git-subscribing panel it may never open. A
    // dock panel collapses out of the workbench when its last tab closes (the
    // reveal/focus path re-attaches it); the closure captures this workbench's own
    // `leftPanel`.
    const leftPanel = new Panel({ onEmpty: () => this.detachDock(leftPanel) });
    const filesTab = leftPanel.add(fileTree.root, { title: `${fileIconGlyph('', true)}  Files` });
    filesTab.select();

    // Each bottom dock is a single persistent view: closing its tab hides the dock
    // (its toggle brings it back) rather than destroying the page, so its widget/
    // state survive and reopening never shows an empty panel. hideBottomDock acts on
    // the active workbench — the only one whose tab can be interactively closed.
    const notificationLog = new NotificationLog();
    const notificationPanel = new Panel({ onTabCloseRequest: () => this.hideBottomDock('notifications') });
    notificationPanel.add(notificationLog.root, { title: 'Notifications' });
    // Scope this workbench's diagnostics to the files under its root (read live via
    // `owner`, so a re-root re-scopes it).
    const diagnosticsPanel = new DiagnosticsPanel(
      (target) => this.openOrFocusFile(target.path, [target.line, target.character]),
      (path) => this.ownerWorkbenchCwd(path) === this.workbenches.get(owner)?.cwd,
    );
    const diagnosticsDock = new Panel({ onTabCloseRequest: () => this.hideBottomDock('diagnostics') });
    diagnosticsDock.add(diagnosticsPanel.root, { title: 'Diagnostics' });
    const keymapPanel = new KeymapPanel();
    const keymapDock = new Panel({ onTabCloseRequest: () => this.hideBottomDock('keymap') });
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
    this.workbenchList.selectAgent(workbench.owner === 'user' ? null : workbench.owner);
    this.rebindGitChrome(); // header branch/GitHub now reflect this workbench's root
    this.workbenchStatus.refresh(); // diagnostics pill + LSP indicator → this workbench
    this.updateViewedAgent();
    this.focusActivePane();
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

  // Re-point the header git chrome (branch button, GitHub model + buttons) and the
  // upstream-behind watch at the active workbench's git/cwd. Idempotent (the
  // widgets no-op when the repo is unchanged), so it also seeds the initial bind.
  private rebindGitChrome(): void {
    const { git, cwd } = this.workbench;
    this.branchButton.setRepo(git);
    this.github.rebind(git, cwd);
    this.githubButtons.setRepo(git, cwd);
    this.upstreamUnsub?.();
    this.lastBehind = git.getAheadBehind()?.behind ?? 0;
    this.upstreamUnsub = git.onChange(() => this.checkUpstream());
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
    // Sidebar branch line: re-read + re-subscribe now that the git is swapped (the
    // row can't observe the swap itself without racing the re-root).
    if (workbench.owner !== 'user') this.workbenchList.refreshAgent(workbench.owner);
    if (this.workbench === workbench) this.rebindGitChrome();
    // Diagnostics ownership shifts on a re-root (paths under the old/new root change
    // hands), so re-scope every workbench's panel and the active header status.
    for (const wb of this.workbenches.values()) wb.diagnosticsPanel.refresh();
    this.workbenchStatus.refresh();
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

  // The Panel currently shown in the bottom dock (`this.workbench.bottomDock`), or null.
  private bottomDockPanel(): { root: Widget } | null {
    switch (this.workbench.bottomDock) {
      case 'notifications': return this.workbench.notificationPanel;
      case 'diagnostics': return this.workbench.diagnosticsDock;
      case 'keymap': return this.workbench.keymapDock;
      default: return null;
    }
  }

  /** Show `agent`: activate its workbench (its terminal lives there). */
  private showAgent(agent: Agent): void {
    this.activateOwner(agent);
  }

  // Refresh the agent's tab: its glyph-prefixed title, plus Adw's accent-coloured
  // `needs-attention` highlight while it's waiting for input (the tab title text
  // itself can't be colour-coded like the sidebar dot).
  private updateAgentTab(agent: Agent): void {
    const child = this.agentChildren.get(agent.root);
    if (!child) return;
    child.setTitle(agentTabTitle(agent));
    child.setNeedsAttention(agent.status === 'waiting');
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

  // --- Header bar ------------------------------------------------------------

  private buildHeaderBar() {
    const header = new Adw.HeaderBar();
    header.setName('Header'); // CSS identity (#Header)
    // The branch button and the GitHub PR pill are separate controls.
    header.packStart(this.branchButton.root);
    header.packStart(this.githubButtons.root);

    // Per-workbench health signals (diagnostics + LSP) sit at the right edge,
    // opposite the git/GitHub controls.
    header.packEnd(this.workbenchStatus.root);

    // The project name and the unsaved-changes marker live in the sidebar
    // (WorkbenchList) header, so the centre title slot would otherwise fall back
    // to the window title ("node"/project name) — duplicative. Clear it with an
    // empty widget so the bar shows only its packed controls.
    header.setTitleWidget(new Gtk.Box());
    return header;
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
    this.workbenchList.setModified(modified);
  }

  // --- Theme chrome ----------------------------------------------------------

  // Paint the window chrome (header bar, file tree, status/command bar, panel tab
  // bars) plus popover surfaces (pickers) and selected entries with the theme's
  // colors. Installed as a single keyed, replaceable stylesheet so a future theme
  // switch can re-apply it. Themes without their own background (ui.bg unset)
  // leave the chrome to the system Adwaita styling.
  private applyChromeStyles() {
    const { editor: { background: bg }, surface: { popover: popoverBg, selected: selectedBg } } = theme.ui;
    // A theme that follows the system scheme leaves the chrome to Adwaita.
    if (theme.followSystemScheme) {
      styles.remove('theme-chrome');
      return;
    }
    const border = theme.ui.border;
    // De-emphasized text for the empty-panel placeholder.
    const muted = theme.ui.text.muted;
    const rules = [
      `#Header, #WorkbenchList .workbench-header {
        background: ${bg};
        box-shadow: none;
        border-bottom: 1px solid ${border};
      }`,
      `#FileTree, #FileTree listview { background-color: ${bg}; }`,
      `#NotificationLog, #NotificationLog list { background-color: ${bg}; }`,
      `#KeymapPanel, #KeymapPanel viewport { background-color: ${bg}; }`,
      `#PluginManagerPanel, #PluginManagerPanel viewport { background-color: ${bg}; }`,
      `#LocationList, #LocationList list { background-color: ${bg}; }`,
      `#WorkbenchList, #WorkbenchList list { background-color: ${bg}; }`,
      `#GitPanel, #GitPanel list { background-color: ${bg}; }`,
      `#WorkbenchRow { padding: 2px 12px; }`,
      `#Panel tabbar .box,
       #Panel tabbar tabbox,
       #Panel tabbar tab { background-color: ${bg}; }`,
      `#Panel tabbar .box {
        box-shadow: none;
        padding: 0;
        min-height: 0;
      }`,
      `#Panel tabbar tabbox { padding: 0; min-height: 0; }`,
      // Square (un-rounded) tabs, separated by vertical borders.
      `#Panel tabbar tab {
        min-height: 0;
        padding: 2px 12px;
        border-radius: 0;
        border-right: 1px solid ${border};
      }`,
      `#Panel tabbar tab:first-child { border-left: 1px solid ${border}; }`,
      `#Panel tabbar tab:hover { background-color: shade(${bg}, 1.2); }`,
      `#Panel tabbar tab:selected {
        background-color: shade(${bg}, 1.6);
        box-shadow: inset 0 -2px ${border};
      }`,
      // The empty-panel placeholder blends into the app background; its text and
      // idle face are de-emphasized, and the face brightens to the foreground
      // color when this is the active panel.
      `#PanelEmptyState { background-color: ${bg}; }`,
      `#PanelEmptyText, #PanelEmptyEmoticon { color: ${muted}; }`,
      `#PanelEmptyText.is-active, #PanelEmptyEmoticon.is-active { color: ${theme.ui.editor.foreground}; }`,
    ];

    // Popover surfaces: the picker card, its search entry, and result list.
    if (popoverBg) {
      rules.push(
        `#Picker,
         #PickerEntry,
         #PickerList,
         #PickerList list { background-color: ${popoverBg}; }`,
      );
    }

    // Selected entries in lists (file tree, picker results). The file-tree
    // selection is painted only while the tree is focused (`:focus-within`); an
    // unfocused tree drops it — see FileTree's `:not(:focus-within)` rule — so the
    // selected row reads as inactive. Pickers are always focused when shown.
    if (selectedBg) {
      rules.push(
        `#FileTree:focus-within listview row:selected,
         #PickerList row:selected,
         #WorkbenchList list row:selected { background-color: ${selectedBg}; }`,
      );
    }

    styles.set(rules.join('\n'), { key: 'theme-chrome' });
  }

  // Severity styling shared by the toasts and the log: each `notification-<type>`
  // colors its icon, and a toast card gets a matching left accent border, so the
  // severity is legible at a glance. Colors come from the theme's semantic keys
  // (fatal reuses error); applied independently of the chrome so it works even
  // for themes that leave the chrome to Adwaita.
  private applyNotificationStyles() {
    const { status: { info, success, warning, error }, text: { muted: textMuted }, surface: { popover: popoverBg }, border, shadow } = theme.ui;
    const colors: Record<string, string> = {
      trace: textMuted,
      info,
      success,
      warning,
      error,
      fatal: error,
    };

    const rules = [
      `.NotificationToast {
        background-color: ${popoverBg};
        border: 1px solid ${border};
        border-radius: 12px;
        padding: 8px 10px;
        min-width: 260px;
        box-shadow: 0 2px 8px ${shadow};
      }`,
      // Clickable toasts (default action) get a hover tint.
      `.NotificationToast.activatable:hover { background-color: shade(${popoverBg}, 1.15); }`,
    ];
    for (const [type, color] of Object.entries(colors)) {
      rules.push(`.notification-${type} .notification-icon { color: ${color}; }`);
      rules.push(`.NotificationToast.notification-${type} { border-left: 4px solid ${color}; }`);
      rules.push(`#NotificationRow.notification-${type} { border-left: 3px solid ${color}; padding-left: 6px; }`);
    }

    styles.set(rules.join('\n'), { key: 'notification-colors' });
  }

  // --- Commands --------------------------------------------------------------
  // Each group registers its command handlers together with their palette
  // descriptions (the `{ didDispatch, description }` form); the key bindings that
  // invoke them live in the central keymap (src/keymaps/default.ts), loaded once
  // at startup. Commands owned by other widgets (tabs, file tree, git panel,
  // editor, …) declare their own action+description in those widgets' modules.

  // --- Pane switching (demo of the ported command/keymap managers) -----------

  // Vim-style window (split) management. Handlers only; bindings (ctrl-w v/s/c,
  // ctrl-w h/j/k/l, ctrl-w w) live in the central keymap under `#AppWindow`.
  //
  // Directional focus stays within the center; at the left edge `pane:focus-left`
  // falls back to the file-tree dock, and from the file tree `pane:focus-right`
  // returns to it.
  private registerPaneCommands() {
    zym.commands.add('#AppWindow', {
      'pane:split-right': { didDispatch: () => this.splitPane('right'), description: 'Split the pane to the right' },
      'pane:split-down': { didDispatch: () => this.splitPane('down'), description: 'Split the pane downward' },
      'pane:close': { didDispatch: () => this.closePane(), description: 'Close the active pane' },
      'pane:focus-left': { didDispatch: () => this.navPane('left'), description: 'Focus the pane to the left' },
      'pane:focus-right': { didDispatch: () => this.navPane('right'), description: 'Focus the pane to the right' },
      'pane:focus-up': { didDispatch: () => this.navPane('up'), description: 'Focus the pane above' },
      'pane:focus-down': { didDispatch: () => this.navPane('down'), description: 'Focus the pane below' },
      'pane:focus-next': { didDispatch: () => this.focusNextPane(), description: 'Cycle to the next pane' },
      // Reveal+focus a specific left-dock tab (re-adding it if the dock had been
      // collapsed away by closing its last tab).
      'file-tree:focus': { didDispatch: () => this.revealLeftTab('files'), description: 'Focus the file tree' },
      'git-panel:focus': { didDispatch: () => this.revealLeftTab('git'), description: 'Focus Source Control' },
      'workbench-list:focus': { didDispatch: () => this.workbenchList.focus(), description: 'Focus the workbench sidebar' },
      // Cycle the active workbench through [user, …agents] (the workbench-list order).
      'workbench:previous': { didDispatch: () => this.cycleWorkbench(-1), description: 'Switch to the previous workbench' },
      'workbench:next': { didDispatch: () => this.cycleWorkbench(1), description: 'Switch to the next workbench' },
      // Show/hide each dock side without discarding the panels it holds.
      'dock:toggle-left': { didDispatch: () => this.toggleDockSide('left'), description: 'Toggle the left dock' },
      'dock:toggle-right': { didDispatch: () => this.toggleDockSide('right'), description: 'Toggle the right dock (Files / Source Control)' },
      'dock:toggle-top': { didDispatch: () => this.toggleDockSide('top'), description: 'Toggle the top dock' },
      'dock:toggle-bottom': { didDispatch: () => this.toggleDockSide('bottom'), description: 'Toggle the bottom dock' },
    });
  }

  // Show / hide a dock side (the dock-visibility toggle), keeping its panels intact.
  // Showing moves focus into the dock; hiding falls focus back to the center when it
  // was inside the dock. An empty side has nothing to toggle (reports a toast). The
  // new layout is autosaved so it survives a restore.
  private toggleDockSide(side: DockSide) {
    if (!this.workbench.isDockOccupied(side)) {
      this.toast(`No ${side} dock to toggle`);
      return;
    }
    const focusWasInside = this.isFocusWithin(this.workbench.root) && this.isDockSideFocused(side);
    this.workbench.toggleDock(side);
    if (this.workbench.isDockVisible(side)) this.focusDockSide(side);
    else if (focusWasInside) this.focusActivePane(); // dock hid out from under focus
    this.sessionController.scheduleAutosave();
  }

  // Whether keyboard focus currently sits inside the named dock side's content.
  private isDockSideFocused(side: DockSide): boolean {
    if (side === 'right') return this.isFocusWithin(this.workbench.leftPanel.root);
    if (side === 'bottom') {
      const panel = this.bottomDockPanel();
      return panel ? this.isFocusWithin(panel.root) : false;
    }
    return false; // left / top carry no built-in content yet
  }

  // Move focus into a freshly-shown dock side's content.
  private focusDockSide(side: DockSide) {
    if (side === 'right') {
      this.focusSidePanel();
    } else if (side === 'bottom') {
      const panel = this.bottomDockPanel();
      if (panel) this.focusDock(panel as Panel, () => this.focusBottomDockContent());
    }
    // left / top have no built-in content to focus yet.
  }

  // Focus whatever view currently fills the bottom dock.
  private focusBottomDockContent() {
    if (this.workbench.bottomDock === 'notifications') this.workbench.notificationLog.focus();
    else if (this.workbench.bottomDock === 'diagnostics') this.workbench.diagnosticsPanel.focus();
    else if (this.workbench.bottomDock === 'keymap') this.workbench.keymapPanel.focus();
  }

  // --- LSP commands ----------------------------------------------------------

  private registerLspCommands() {
    zym.commands.add('#AppWindow', {
      'lsp:go-to-definition': { didDispatch: () => void this.goto('definition'), description: 'Go to definition' },
      'lsp:peek-definition': { didDispatch: () => void this.peekDefinition(), description: 'Peek definition (inline)' },
      'lsp:go-to-declaration': { didDispatch: () => void this.goto('declaration'), description: 'Go to declaration' },
      'lsp:go-to-type-definition': { didDispatch: () => void this.goto('typeDefinition'), description: 'Go to type definition' },
      'lsp:go-to-implementation': { didDispatch: () => void this.goto('implementation'), description: 'Go to implementation' },
      'lsp:find-references': { didDispatch: () => void this.findReferences(), description: 'Find references' },
      'lsp:workspace-symbols': { didDispatch: () => this.workspaceSymbolPicker(), description: 'Go to workspace symbol…' },
      'lsp:document-symbols': { didDispatch: () => void this.documentSymbolPicker(), description: 'Go to symbol in document…' },
      'lsp:hover': { didDispatch: () => void this.activeEditor?.hover(), description: 'Show hover (type / docs)' },
      'lsp:code-action': { didDispatch: () => void this.codeActionMenu(), description: 'Code action / quick fix…' },
      'lsp:rename': { didDispatch: () => this.renamePrompt(), description: 'Rename symbol…' },
      'tag:rename': { didDispatch: () => this.renameTagPrompt(), description: 'Rename JSX/HTML tag pair…' },
      'lsp:format': { didDispatch: () => void this.formatActive(), description: 'Format document' },
      'lsp:toggle-diagnostics-panel': { didDispatch: () => this.toggleDiagnosticsPanel(), description: 'Toggle the Diagnostics panel' },
      'lsp:install-server': { didDispatch: () => this.installServerPicker(), description: 'Install a language server…' },
      'keymap:show': { didDispatch: () => this.toggleKeymapPanel(), description: 'Show all keybindings and their source' },
      'plugin:open-manager': { didDispatch: () => this.openPluginManager(), description: 'Open the Plugin Manager' },
    });
  }

  // Pick a language server to install (into the zym-managed dir). Already-
  // installed and in-progress servers are shown dimmed with a status note.
  private installServerPicker() {
    const items = zym.lsp.installableServers().map((s) => {
      const status = s.installing ? 'installing…' : s.installed ? 'installed' : 'not installed';
      const text = `${s.name}  ${status}`;
      return {
        value: s.name,
        text,
        display: { main: [0, s.name.length] as [number, number], detail: [s.name.length + 2, text.length] as [number, number] },
      };
    });
    openPicker({
      host: this.overlay,
      placeholder: 'Install language server',
      items,
      onSelect: (name) => void zym.lsp.installByName(name),
    });
  }

  // Toggle the Diagnostics panel in the bottom dock (replacing whatever was there).
  // Only closes when it's already the *shown* content — if it's selected but the
  // bottom dock was hidden (via the dock-visibility toggle), this re-reveals it.
  private toggleDiagnosticsPanel() {
    if (this.workbench.bottomDock === 'diagnostics' && this.workbench.isDockVisible('bottom')) {
      this.setBottomDock(null);
    } else {
      this.setBottomDock('diagnostics');
      this.workbench.diagnosticsPanel.focus();
    }
  }

  // Toggle the keybinding reference list in the bottom dock.
  private toggleKeymapPanel() {
    if (this.workbench.bottomDock === 'keymap' && this.workbench.isDockVisible('bottom')) {
      this.setBottomDock(null);
    } else {
      this.setBottomDock('keymap');
      this.workbench.keymapPanel.focus();
    }
  }

  // Open (or reveal) the Plugin Manager as a center tab. Reveals the existing tab
  // when it is still hosted in a panel; opens a fresh one otherwise.
  private openPluginManager() {
    if (this.pluginManagerTab && Panel.containing(this.pluginManagerTab.root)) {
      this.pluginManagerTab.child.select();
      this.pluginManagerTab.root.grabFocus();
      return;
    }
    const manager = new PluginManagerPanel();
    const child = this.workbench.center.add(manager.root, { title: 'Plugin Manager', requireTabBar: true });
    this.pluginManagerTab = { root: manager.root, child };
    manager.root.grabFocus();
  }

  // Dock the given panel into the active workbench's bottom slot (or clear it),
  // tracking which is shown on the workbench itself (`workbench.bottomDock`). Each
  // workbench owns its bottom dock independently, so it does NOT carry across to
  // another person's workbench — switching simply shows that workbench's own slot.
  private setBottomDock(which: BottomDock) {
    this.workbench.bottomDock = which;
    this.workbench.setBottom(this.bottomDockPanel());
  }

  // Hide the named bottom dock if it's the one shown (its tab-close request), and
  // veto the underlying page close so the view persists for the next reopen.
  // Returns false so Panel keeps the page intact. The hide is deferred out of the
  // close-page signal emission, since it reparents the dock (an ancestor of the
  // emitting tab view) and that's unsafe to do mid-emission.
  private hideBottomDock(which: Exclude<BottomDock, null>): boolean {
    setTimeout(() => {
      if (this.workbench.bottomDock === which) this.setBottomDock(null);
    }, 0);
    return false;
  }

  // Collapse the left dock when its last tab is closed, so the center reclaims the
  // space instead of showing the empty-state placeholder. The reveal/focus path
  // re-attaches and repopulates it. Runs from onEmpty (page-detached, after the
  // close completes), where the reparent is safe and synchronous (no one-frame
  // flash of the empty state).
  private detachDock(panel: Panel) {
    if (panel === this.workbench.leftPanel) this.workbench.setRight(null);
  }

  // Reveal a left-dock tab, re-attaching the left panel and re-adding the tab if
  // they were collapsed away by closing the dock's last tab, then focus it. The
  // panel is re-attached (rooted) *before* any re-add: adding to a detached,
  // unrooted Adw.TabView yields a blank page.
  private revealLeftTab(which: 'files' | 'git') {
    if (this.workbench.leftPanel.root.getParent() === null)
      this.workbench.setRight({ root: this.workbench.leftPanel.root });
    const present = this.workbench.leftPanel.getChildren();
    if (which === 'files') {
      if (!present.includes(this.workbench.fileTree.root)) {
        if (this.workbench.fileTree.root.getParent()) this.workbench.fileTree.root.unparent(); // drop any closed page
        this.workbench.filesTab = this.workbench.leftPanel.add(this.workbench.fileTree.root, {
          title: `${fileIconGlyph('', true)}  Files`,
        });
      }
      this.workbench.filesTab.select();
      this.workbench.fileTree.focus();
    } else {
      const gitPanel = this.ensureGitPanel(this.workbench);
      if (!present.includes(gitPanel.root)) {
        if (gitPanel.root.getParent()) gitPanel.root.unparent();
        this.workbench.gitTab = this.workbench.leftPanel.add(gitPanel.root, { title: `${Icons.git}  Git` });
      }
      this.workbench.gitTab?.select();
      gitPanel.focus();
    }
  }

  // Lazily create this workbench's Source Control panel on first reveal — it isn't
  // built at startup, so a workbench opens no git subscription until the user asks
  // for it. Idempotent: returns the existing panel once created.
  private ensureGitPanel(workbench: Workbench<'user' | Agent>): GitPanel {
    if (workbench.gitPanel) return workbench.gitPanel;
    const gitPanel = new GitPanel({
      cwd: workbench.cwd,
      git: workbench.git,
      onOpenFile: (path) => this.openFile(path),
      onCommit: () => this.startCommit(),
    });
    workbench.gitPanel = gitPanel;
    return gitPanel;
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

  // Resolve a navigation (definition/declaration/type-def/impl) at the active
  // editor's cursor and jump there, opening/revealing the target file.
  private async goto(kind: NavigationKind) {
    const editor = this.activeEditor;
    if (!editor) return;
    const target = await zym.lsp.goto(editor.lsp, kind);
    if (!target) return;
    this.openOrFocusFile(target.path, [target.point.row, target.point.column]);
  }

  // See-definition: inline the definition in a focusable peek below the cursor,
  // instead of jumping. Toggles closed if one is already open.
  private async peekDefinition() {
    const editor = this.activeEditor;
    if (!editor) return;
    if (editor.peekOpen) {
      editor.closePeek();
      return;
    }
    const target = await zym.lsp.goto(editor.lsp, 'definition');
    if (!target) return;

    // If the definition's file is already open, peek a *live* read-only view onto its
    // shared Document — edits in the open file show in the peek and vice versa.
    const openDoc = this.documents.find(target.path);
    if (openDoc) {
      this.documents.acquire(target.path); // hold a ref so closing the source tab won't dispose it
      const peekEditor = new TextEditor({
        document: openDoc,
        onReleaseDocument: () => this.documents.release(openDoc),
        peek: true,
      });
      peekEditor.revealPeekRow(target.point.row);
      const { widget, height } = wrapPeekBody(target, peekEditor.root, LIVE_PEEK_HEIGHT, () => editor.closePeek());
      editor.showPeek({ widget, height });
      return;
    }

    // Otherwise fall back to a read-only snapshot slice read from disk.
    let content: string;
    try {
      content = Fs.readFileSync(target.path, 'utf8');
    } catch {
      this.toast(`Can't read ${target.path}`);
      return;
    }
    const { widget, height } = buildDefinitionPeek(target, content, () => editor.closePeek());
    editor.showPeek({ widget, height });
  }

  // Find references to the symbol at the cursor and present them in a picker (with
  // a source preview) to jump to one.
  private async findReferences() {
    const editor = this.activeEditor;
    if (!editor) return;
    const refs = await zym.lsp.references(editor.lsp);
    if (refs.length === 0) {
      zym.notifications.addInfo('No references found');
      return;
    }
    openReferencesPicker(this.overlay, refs, (path, cursor) => this.openOrFocusFile(path, cursor));
  }

  // Search project-wide symbols (via the active file's language server) in a
  // picker and jump to the chosen one.
  private workspaceSymbolPicker() {
    const editor = this.activeEditor;
    if (!editor) return;
    if (!zym.lsp.canWorkspaceSymbols(editor.lsp)) {
      zym.notifications.addInfo('No workspace symbol support for this file');
      return;
    }
    openWorkspaceSymbolPicker(this.overlay, editor.lsp, this.workbench.cwd, (path, cursor) =>
      this.openOrFocusFile(path, cursor),
    );
  }

  // List the current file's symbol outline (via its language server) in a picker
  // and jump to the chosen one within the active editor.
  private async documentSymbolPicker() {
    const editor = this.activeEditor;
    if (!editor) return;
    if (!zym.lsp.canDocumentSymbols(editor.lsp)) {
      zym.notifications.addInfo('No document symbol support for this file');
      return;
    }
    await openDocumentSymbolPicker(this.overlay, editor.lsp, (cursor) => {
      editor.restoreCursor(cursor);
      editor.focus();
    });
  }

  // Offer code actions / quick-fixes at the cursor in a picker; apply the chosen one.
  private async codeActionMenu() {
    const editor = this.activeEditor;
    if (!editor || !editor.currentFile) return;
    const actions = await zym.lsp.codeActions(editor.lsp);
    if (actions.length === 0) {
      zym.notifications.addInfo('No code actions available');
      return;
    }
    openPicker({
      host: this.overlay,
      placeholder: 'Code action',
      items: actions.map((a, i) => ({ value: String(i), text: a.title })),
      onSelect: (value) => void this.runCodeAction(editor, actions[Number(value)]),
    });
  }

  // Apply a chosen code action: resolve its lazy edit, then apply it. Command-only
  // actions (workspace/executeCommand) and file resource ops aren't wired yet.
  private async runCodeAction(editor: TextEditor, action: Command | CodeAction) {
    const isBareCommand = typeof (action as Command).command === 'string' && !('kind' in action) && !('edit' in action);
    if (isBareCommand) {
      zym.notifications.addWarning(`LSP: "${action.title}" needs command execution (not yet supported)`);
      return;
    }
    const resolved = await zym.lsp.resolveCodeAction(editor.lsp, action as CodeAction);
    if (!resolved.edit) {
      zym.notifications.addWarning(`LSP: "${action.title}" needs command execution (not yet supported)`);
      return;
    }
    const encoding = zym.lsp.completionPositionEncoding(editor.lsp) ?? 'utf-16';
    const { resourceOps } = this.applyWorkspaceEdit(resolved.edit, encoding);
    if (resourceOps > 0) {
      zym.notifications.addWarning(`LSP: "${action.title}" includes ${resourceOps} file operation(s) not yet applied`);
    }
  }

  // Prompt for a new name (prefilled with the symbol under the cursor) and rename.
  private renamePrompt() {
    const editor = this.activeEditor;
    if (!editor || !editor.currentFile) return;
    if (!zym.lsp.canRename(editor.lsp)) {
      zym.notifications.addInfo('Rename is not available here');
      return;
    }
    openPicker({
      host: this.overlay,
      placeholder: 'New name',
      query: wordUnderCursor(editor.lsp),
      items: [],
      actionWhenEmpty: true,
      onSelect: () => {}, // no items — the action row drives the rename
      action: { label: (q) => `Rename to "${q}"`, run: (q) => void this.runRename(editor, q.trim()) },
    });
  }

  // Rename the JSX/HTML tag at the cursor — both halves of the pair together.
  private renameTagPrompt() {
    const editor = this.activeEditor;
    if (!editor) return;
    const names = editor.tagNamesAtCursor();
    if (!names) {
      zym.notifications.addInfo('Not on a JSX/HTML tag');
      return;
    }
    openPicker({
      host: this.overlay,
      placeholder: 'New tag name',
      query: names[0].text,
      items: [],
      actionWhenEmpty: true,
      onSelect: () => {},
      action: {
        label: (q) => `Rename tag to "${q}"`,
        run: (q) => { const n = q.trim(); if (n) editor.applyTagRename(names, n); },
      },
    });
  }

  private async runRename(editor: TextEditor, newName: string) {
    if (!newName) return;
    const edit = await zym.lsp.rename(editor.lsp, newName);
    if (!edit) {
      zym.notifications.addInfo('Rename produced no changes');
      return;
    }
    const encoding = zym.lsp.completionPositionEncoding(editor.lsp) ?? 'utf-16';
    const { applied, resourceOps } = this.applyWorkspaceEdit(edit, encoding);
    if (resourceOps > 0) zym.notifications.addWarning(`Rename: ${resourceOps} file operation(s) not yet applied`);
    else zym.notifications.addInfo(`Renamed across ${applied} file${applied === 1 ? '' : 's'}`);
  }

  // Format the active document and apply the edits to its buffer.
  private async formatActive() {
    const editor = this.activeEditor;
    if (!editor || !editor.currentFile) return;
    const options = {
      tabSize: (zym.config.get('editor.tabLength') as number) ?? 2,
      insertSpaces: (zym.config.get('editor.insertSpaces') as boolean) ?? true,
    };
    const edits = await zym.lsp.format(editor.lsp, options);
    if (edits.length === 0) {
      zym.notifications.addInfo('No formatting changes');
      return;
    }
    editor.applyLspEdits(edits, zym.lsp.completionPositionEncoding(editor.lsp) ?? 'utf-16');
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

  // Focus whichever left-dock tab is currently active (file tree or Source
  // Control); reveal Files if the dock had been collapsed away.
  private focusSidePanel() {
    if (this.workbench.leftPanel.root.getParent() === null || this.workbench.leftPanel.tabCount === 0) {
      this.revealLeftTab('files');
      return;
    }
    const child = this.workbench.leftPanel.activeChild;
    if (child && this.restoreTabFocus(child)) return;
    if (this.workbench.gitPanel && this.workbench.leftPanel.activeChild === this.workbench.gitPanel.root)
      this.workbench.gitPanel.focus();
    else this.workbench.fileTree.focus();
  }

  // Window-level file/edit operations, surfaced in the command palette and (for
  // most) on the space leader. Handlers only; bindings live in the central keymap.
  private registerWindowCommands() {
    zym.commands.add('#AppWindow', {
      'file:open': { didDispatch: () => this.openDialog(), description: 'Open a file (dialog)' },
      'file:find': {
        didDispatch: () => openFilePicker(this.overlay, this.workbench.cwd, (path) => this.openFile(path)),
        description: 'Find a file by name',
      },
      'file:open-path': {
        didDispatch: () => openFileOpener(this.overlay, this.workbench.cwd, (path) => this.openFile(path)),
        description: 'Open a file by path',
      },
      'project:search': {
        didDispatch: () =>
          openSearchPicker(this.overlay, this.workbench.cwd, (path, cursor) => this.openFile(path).restoreCursor(cursor)),
        description: 'Search file contents (ripgrep)',
      },
      // Save commands only apply with an editor open.
      'file:save': {
        didDispatch: () => this.saveActive(),
        description: 'Save the current file',
        when: () => this.activeEditor !== null || this.activeSavableSurface() !== null,
      },
      'file:save-as': { didDispatch: () => this.saveAsDialog(), description: 'Save the current file as…', when: () => this.activeEditor !== null },
      'git:diff-current': {
        didDispatch: () => this.diffActiveAgainstHead(),
        description: 'Diff the current file (working tree vs HEAD)',
        when: () => this.activeEditor?.currentFile != null,
      },
      'git:start-commit': {
        didDispatch: () => this.startCommit(),
        description: 'Commit staged changes (edit the message in a tab)',
      },
      'project:search-results': {
        didDispatch: () => this.openSearchResults(),
        description: 'Search the selected text across the project, shown as a multibuffer',
        when: () => this.activeEditor !== null,
      },
      'git:continuous-diff': {
        didDispatch: () => void this.openContinuousDiff(),
        description: 'Show every changed file as one continuous diff (multibuffer)',
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
      'diff:stage-hunk': {
        didDispatch: () => this.activeContinuousDiff()?.stageHunkAtCursor(),
        description: 'Stage the hunk under the cursor (continuous diff)',
        when: () => this.activeContinuousDiff() !== null,
      },
      'diff:unstage-hunk': {
        didDispatch: () => this.activeContinuousDiff()?.unstageHunkAtCursor(),
        description: 'Unstage the hunk under the cursor (continuous diff)',
        when: () => this.activeContinuousDiff() !== null,
      },
      'diff:review-comment': {
        didDispatch: () => this.activeContinuousDiff()?.startComment(),
        description: 'Comment on the cursor/selection',
        when: () => this.activeContinuousDiff()?.canComment === true, // agent workbench only
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
  private diffActiveAgainstHead(): void {
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
      const model = computeDiff(head, current);
      if (model.hunks.length === 0) {
        this.toast('No changes against HEAD');
        return;
      }
      const name = Path.basename(path);
      const viewer = new DiffViewer(model, { title: `${name} (working tree ↔ HEAD)`, languagePath: path });
      this.workbench.center.add(viewer.root, { title: `± ${name}`, requireTabBar: true });
    });
  }

  /** Search the project for the active editor's selected text and show every match,
   *  grouped by file with context, in a continuous read-only multibuffer tab. Phase 1a
   *  of the multibuffer (docs/text-editor/multibuffer.md). */
  private openSearchResults(): void {
    const query = this.activeEditor?.getSelectedText().trim() ?? '';
    if (query === '') {
      this.toast('Select text to search for');
      return;
    }
    const cwd = this.workbench.cwd;
    runProjectSearch(cwd, query, (result) => {
      if (result.error) {
        this.toast(result.error);
        return;
      }
      const files = result.files ?? [];
      if (files.length === 0) {
        this.toast(`No results for “${query}”`);
        return;
      }
      const excerpts = matchesToExcerptInputs(files, { context: 2 });
      const view = new SearchResultsView({
        excerpts,
        cwd,
        // Editable results: edit in place (write-through to each file's live Document + save),
        // and replace across files as undo-coordinated steps (G6). NORMAL-mode Enter still
        // jumps to the file; INSERT-mode Enter is a newline.
        editable: true,
        documents: this.documents,
        onActivate: ({ path, row }) => this.openFile(path).restoreCursor([row, 0]),
      });
      const child = this.workbench.center.add(view.root, {
        title: `${Icons.search}  ${query}`,
        requireTabBar: true,
      });
      this.searchResultsViews.set(view.root, view); // disposeChild tears it down on close
      child.select();
      view.focus();
    });
  }

  /** Show every changed file (working tree vs HEAD) as ONE continuous diff in a tab — the
   *  multibuffer diff surface (read-only for now; docs/text-editor/multibuffer.md, G5). */
  private async openContinuousDiff(): Promise<void> {
    const cwd = this.workbench.cwd;
    const root = repoRoot(cwd);
    if (!root) {
      this.toast('Not in a git repository');
      return;
    }
    const paths = [...this.workbench.git.getFileStatuses().keys()].sort();
    if (paths.length === 0) {
      this.toast('No changes against HEAD');
      return;
    }
    const showHead = (rel: string): Promise<string> =>
      new Promise((resolve) => git(root, ['show', `HEAD:${rel}`], (ok, out) => resolve(ok ? out : '')));
    // Editable diff: NEW side = the file's current text (an open document's live text, incl.
    // unsaved edits, else from disk) backed by a live Document (edit in place + save + live
    // re-diff), OLD side = the HEAD blob. A deleted file → empty new.
    const files = await Promise.all(
      paths.map(async (path) => {
        const oldText = await showHead(Path.relative(root, path));
        const open = this.documents.find(path);
        let newText = open ? open.getText() : '';
        if (!open) {
          try {
            newText = Fs.readFileSync(path, 'utf8');
          } catch {
            /* deleted on disk */
          }
        }
        return { path, oldText, newText };
      }),
    );
    const view = new ContinuousDiffView({
      files,
      cwd,
      editable: true,
      documents: this.documents,
      git: this.workbench.git, // enables the staged/unstaged gutter marker + `space h s`/`space h u`
      onActivate: ({ path, row }) => this.openFile(path).restoreCursor([row, 0]),
      // The view formats the comment/review; the host just delivers the string to the agent as a
      // turn (submit directly — TUI: Enter submits — and don't steal focus from the diff). Only
      // wired in an agent's workbench: no agent to address from the user workbench, so commenting is
      // disabled there (`canComment` is false → Enter falls back to jump-to-file).
      onSend: this.workbench.owner === 'user'
        ? undefined
        : (message) => this.sendToAgent(message, { submit: true, reveal: false }),
    });
    const title = () => {
      const mod = view.isModified() ? `${Icons.modified} ` : '';
      const review = view.reviewCount > 0 ? `  ${Icons.comment} ${view.reviewCount}` : '';
      return `${mod}${Icons.git}  Diff${review}`;
    };
    const child = this.workbench.center.add(view.root, {
      title: title(),
      requireTabBar: true,
    });
    this.continuousDiffViews.set(view.root, view); // disposeChild tears it down on close
    // Consult the diff on window close (unsaved edits OR unsent review comments). disposeChild
    // disposes this registration with the tab.
    this.participants.set(view.root, zym.session.registerParticipant(view));
    view.onModifiedChange(() => child.setTitle(title())); // show the unsaved marker on edit/save
    view.onReviewChange(() => child.setTitle(title())); // show the accumulated-review count
    child.select();
    view.focus();
  }

  // Terminal command: open a shell in a new center-panel tab. Handler only;
  // bound to `space t` in the central keymap.
  private registerTerminalCommands() {
    zym.commands.add('#AppWindow', {
      'terminal:new': { didDispatch: () => this.openTerminal(), description: 'Open a new terminal' },
      'scripts:run': {
        didDispatch: () => openScriptRunner(this.overlay, this.workbench.cwd, (name) => this.runScript(name)),
        description: 'Run a package.json script in a terminal',
      },
      'agent:new': {
        // The launcher gathers the prompt + model / permission mode / worktree /
        // kind, then hands back the assembled argv for openAgent.
        didDispatch: () =>
          openAgentLauncher(this.overlay, {
            cwd: this.workbench.cwd,
            defaultKind: resolveAgentKind(zym.config.get('agent.implementation')),
            onLaunch: ({ prompt, command, cwd, kind }) =>
              this.openAgent({ prompt: prompt || undefined, command, cwd, kind }),
          }),
        description: 'Start a new agent',
      },
      // Pick an existing worktree to launch the agent in (its workbench is rooted
      // there). New worktrees are created by the agent itself, then detected live.
      'agent:new-in-worktree': {
        didDispatch: () => openWorktreePicker(this.overlay, this.workbench.cwd, (cwd) => this.openAgent({ cwd })),
        description: 'Start a new agent in a chosen git worktree',
      },
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
      // past *conversation* as a fresh agent is agent:resume-conversation (a
      // picker); agent:continue picks up the latest conversation in this folder.
      'agent:resume': { didDispatch: () => this.resumeCurrentAgent(), description: 'Resume the stopped agent', when: () => this.currentAgent()?.exited === true },
      'agent:resume-conversation': { didDispatch: () => this.resumeAgentPicker(), description: 'Resume a past conversation…' },
      'agent:continue': { didDispatch: () => this.openAgent({ resume: { continue: true } }), description: 'Continue the latest conversation' },
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
      // Run an action the agent registered (set_actions) — the default one, or one
      // chosen from a picker. The agent routes it: a `terminal` action opens a
      // terminal tab, a terminal-less one (re)starts its background process.
      'agent:action-run-default': {
        didDispatch: () => {
          const agent = this.currentAgent();
          const action = defaultAction(agent?.actions);
          if (agent && action) agent.runAction(action);
        },
        description: "Run the agent's default action",
        when: () => (this.currentAgent()?.actions.length ?? 0) > 0,
      },
      'agent:action-picker': {
        didDispatch: () => {
          const agent = this.currentAgent();
          if (agent) openActionRunner(this.overlay, agent.actions, (action) => agent.runAction(action));
        },
        description: "Run one of the agent's actions…",
        when: () => (this.currentAgent()?.actions.length ?? 0) > 0,
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

  // Git network operations. They run through GitRepo.run (Gio.Subprocess, non-
  // blocking), so the branch button's spinner reflects progress automatically;
  // the result is surfaced as a toast.
  private registerGitCommands() {
    zym.commands.add('#AppWindow', {
      // Git commands only apply inside a repository (a resolvable branch).
      'git:fetch': { didDispatch: () => this.runGit(() => this.workbench.git.fetch(), 'Fetch'), description: 'Fetch from the remote', when: () => this.workbench.git.getBranch() !== null },
      'git:pull': { didDispatch: () => this.runGit(() => this.workbench.git.pull(), 'Pull'), description: 'Pull from upstream (fast-forward)', when: () => this.workbench.git.getBranch() !== null },
      'git:push': {
        // After a successful push, GitHub re-runs the PR's checks; schedule a CI
        // refresh ~10s out. The service stays busy until then, so the CI segment
        // shows the in-progress (loading) look in the meantime.
        didDispatch: () =>
          this.runGit(() => this.workbench.git.push(), 'Push', () => this.github.scheduleRefresh(10000)),
        description: 'Push to the remote',
        when: () => this.workbench.git.getBranch() !== null,
      },
      'git:branch-switch': {
        didDispatch: () => openBranchPicker(this.overlay, this.workbench.cwd, this.workbench.git),
        description: 'Switch or create a branch…',
        when: () => this.workbench.git.getBranch() !== null,
      },
      'git:branch-delete': {
        didDispatch: () => openDeleteBranchPicker(this.overlay, this.workbench.cwd, this.workbench.git),
        description: 'Delete a branch…',
        when: () => this.workbench.git.getBranch() !== null,
      },
      'git:branch-merge': {
        didDispatch: () => openMergeBranchPicker(this.overlay, this.workbench.cwd, this.workbench.git),
        description: 'Merge a branch into current…',
        when: () => this.workbench.git.getBranch() !== null,
      },
      'git:branch-rename': {
        didDispatch: () => openRenameBranchPicker(this.overlay, this.workbench.cwd, this.workbench.git),
        description: 'Rename the current branch…',
        when: () => this.workbench.git.getBranch() !== null,
      },
      'git:stash-push': {
        didDispatch: () => this.stashChanges(),
        description: 'Stash changes',
        when: () => this.workbench.git.getBranch() !== null,
      },
      'git:stash-pop': {
        didDispatch: () => openStashPicker(this.overlay, this.workbench.cwd, 'pop', this.workbench.git),
        description: 'Pop a stash…',
        when: () => this.workbench.git.getBranch() !== null,
      },
      'git:stash-apply': {
        didDispatch: () => openStashPicker(this.overlay, this.workbench.cwd, 'apply', this.workbench.git),
        description: 'Apply a stash…',
        when: () => this.workbench.git.getBranch() !== null,
      },
      'git:stash-drop': {
        didDispatch: () => openStashPicker(this.overlay, this.workbench.cwd, 'drop', this.workbench.git),
        description: 'Drop a stash…',
        when: () => this.workbench.git.getBranch() !== null,
      },
      'github:issue-picker': {
        didDispatch: () => openGithubIssuePicker(this.overlay, this.workbench.cwd),
        description: 'Open a GitHub issue…',
        when: () => this.workbench.git.getBranch() !== null,
      },
      'github:failed-ci-picker': {
        didDispatch: () => openGithubFailedCIPicker(this.overlay, this.workbench.cwd),
        description: 'Open a failed CI check…',
        when: () => this.workbench.git.getBranch() !== null,
      },
      'github:ci-checks': {
        didDispatch: () => openGithubCIChecksPicker(this.overlay, this.workbench.cwd),
        description: 'Show CI checks for this branch…',
        when: () => this.workbench.git.getBranch() !== null,
      },
      'github:pull-request-checkout': {
        didDispatch: () => switchToGithubPrPicker(this.overlay, this.workbench.cwd, this.workbench.git),
        description: 'Check out a pull request…',
        when: () => this.workbench.git.getBranch() !== null,
      },
    });
  }

  // Run a coordinated git operation (e.g. `() => this.workbench.git.fetch()`) and report.
  // Success is quiet (a trace, recorded in the log only); failures pop a toast.
  private async runGit(op: () => Promise<GitOpResult>, label: string, onSuccess?: () => void) {
    const result = await op();
    if (result.isOk()) {
      zym.notifications.addTrace(`${label} succeeded`);
      onSuccess?.();
    } else zym.notifications.addError(`${label} failed`);
  }

  // Like `runGit`, but surfaces progress as a single in-place toast: a sticky
  // loading notice that transforms into success/error when the operation finishes
  // (the LSP install flow). All three share one `replaceKey` so the prompt that
  // triggered it, the spinner, and the result are the same card.
  private async runGitWithProgress(
    op: () => Promise<GitOpResult>,
    label: string,
    replaceKey: string,
  ) {
    zym.notifications.addInfo(`${label}…`, { replaceKey, loading: true, dismissable: true });
    const result = await op();
    if (result.isOk()) zym.notifications.addSuccess(`${label} succeeded`, { replaceKey });
    else zym.notifications.addError(`${label} failed`, { replaceKey });
  }

  // Stash the working-tree changes (visible success, since it's a manual action).
  private async stashChanges() {
    const result = await this.workbench.git.stash();
    if (result.isOk()) zym.notifications.addSuccess('Stashed changes');
    else zym.notifications.addError('Stash failed', { detail: result.unwrapErr().message.trim() });
  }

  // Start a commit: open the message file (`.git/COMMIT_EDITMSG`) in an editor
  // tab. Closing the tab finalizes it — git-style: write the message, save, close
  // to commit (close without a saved message aborts). Reuses the normal editor.
  private startCommit() {
    const repo = repoRoot(this.workbench.cwd);
    if (!repo) return;
    commitMsgPath(repo, (msgPath) => {
      try {
        Fs.writeFileSync(msgPath, ''); // fresh, empty message
      } catch (error) {
        zym.notifications.addError('Could not start commit', { detail: (error as Error).message });
        return;
      }
      const editor = this.openFile(msgPath);
      this.commitEditors.set(editor.root, { repo, msgPath });
    });
  }

  // Finalize a commit when its message tab closes: commit the saved message, or
  // abort if it is empty. Routed through zym.notifications.
  private finishCommit(repo: string, msgPath: string) {
    let message = '';
    try {
      message = Fs.readFileSync(msgPath, 'utf8');
    } catch {
      // file gone — nothing to commit
    }
    if (!message.trim()) {
      zym.notifications.addInfo('Commit aborted (empty message)');
      return;
    }
    void this.workbench.git.commit(msgPath).then((result) => {
      if (result.isOk()) zym.notifications.addSuccess('Committed');
      else zym.notifications.addError('Commit failed', { detail: result.unwrapErr().message.trim() });
    });
  }

  // On the transition into being behind the upstream, post an info notification
  // offering to pull. Only fires when `behind` goes from 0 to positive, so a
  // repo that stays behind across status polls isn't re-toasted every tick.
  private checkUpstream() {
    const behind = this.workbench.git.getAheadBehind()?.behind ?? 0;
    if (behind > 0 && this.lastBehind === 0) {
      const commits = behind === 1 ? 'commit' : 'commits';
      // Sticky + a shared `replaceKey` so the prompt persists until acted on and
      // clicking Pull transforms this same toast into pulling…→pulled (mirrors the
      // LSP install flow).
      zym.notifications.addInfo(`Upstream is ahead by ${behind} ${commits}`, {
        detail: 'Your branch is behind its upstream — pull to update.',
        replaceKey: PULL_NOTICE_KEY,
        dismissable: true,
        buttons: [{ text: 'Pull', onDidClick: () => this.runGitWithProgress(() => this.workbench.git.pull(), 'Pull', PULL_NOTICE_KEY) }],
      });
    }
    this.lastBehind = behind;
  }

  // Periodically `git fetch` in the background so the upstream-behind check sees
  // remote activity. Quiet (no success notification); the resulting onChange
  // drives the branch button and `checkUpstream`. `git.autoFetchMinutes` of 0
  // disables it. (Read once at startup.)
  private startAutoFetch() {
    const minutes = Number(zym.config.get('git.autoFetchMinutes') ?? 0);
    if (!(minutes > 0)) return;
    this.autoFetchTimer = setInterval(() => {
      if (this.workbench.git.getBranch() !== null) void this.workbench.git.fetch();
    }, minutes * 60_000);
  }

  // Notification log: show/hide the bottom-dock history, and clear it. Handlers
  // only; bindings (`space n`, and `c` while the log is focused) live in the
  // central keymap.
  private registerNotificationCommands() {
    zym.commands.add('#AppWindow', {
      'notifications:toggle-log': { didDispatch: () => this.toggleNotificationLog(), description: 'Toggle the notification log' },
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
    zym.commands.add('#AppWindow', {
      'config:open-editor': { didDispatch: () => openConfigEditor(this.window), description: 'Open preferences' },
      'config:open-as-text': { didDispatch: () => this.openFile(configPath()), description: 'Open config.json' },
      'keymap:open-as-text': { didDispatch: () => this.openFile(ensureUserKeymap()), description: 'Edit the user keymap (keymap.json)' },
    });
  }

  // Session: save or restore the workspace session explicitly. Autosave covers the
  // common case; these are manual controls (command palette / keymap).
  private registerSessionCommands() {
    zym.commands.add('#AppWindow', {
      'session:save': {
        didDispatch: () => {
          this.sessionController.saveNow();
          this.toast('Session saved');
        },
        description: 'Save the session',
      },
      'session:restore': {
        didDispatch: () => {
          if (this.sessionController.restore()) this.activateOwner('user'); // settle on user after agent relaunches
          else this.toast('No saved session for this folder');
        },
        description: 'Restore the last session',
      },
    });
  }

  // Toggle the notification log in the bottom dock (replacing whatever was there).
  private toggleNotificationLog() {
    if (this.workbench.bottomDock === 'notifications' && this.workbench.isDockVisible('bottom')) {
      this.setBottomDock(null);
    } else {
      this.setBottomDock('notifications');
      this.workbench.notificationLog.focus();
    }
  }

  // Split the active center pane, opening the active editor's file in the new
  // pane (vim-style) when there is one; otherwise leave it empty and focused.
  private splitPane(direction: Direction) {
    const path = this.activeEditor?.currentFile ?? null;
    const pane = this.workbench.center.split(direction); // the new empty pane becomes active
    // A second *view* of the same file (shared Document/model), not a reveal — so a
    // split shows it side by side with independent cursors / scroll / folds.
    if (path) this.openFileViewIn(path, pane);
    else this.focusActivePane();
  }

  // `ctrl-w c` acts on the focused zone. In a dock it closes that dock's active
  // tab — the dock collapses itself once its last tab goes, so focus then falls
  // back to the center. In the center it closes the active split pane and focuses
  // whatever pane takes its place.
  private closePane() {
    const dock = this.focusedDockPanel();
    if (dock) {
      dock.closeActiveTab();
      if (dock.root.getParent() === null) this.focusActivePane(); // dock collapsed away
      return;
    }
    this.workbench.center.closeActivePanel();
    this.focusActivePane();
  }

  // The dock panel (left / agent / bottom) that currently holds keyboard focus, or
  // null when focus is in the center or nowhere.
  private focusedDockPanel(): Panel | null {
    const docks: Panel[] = [this.workbench.leftPanel];
    if (this.workbench.bottomDock === 'notifications') docks.push(this.workbench.notificationPanel);
    else if (this.workbench.bottomDock === 'diagnostics') docks.push(this.workbench.diagnosticsDock);
    else if (this.workbench.bottomDock === 'keymap') docks.push(this.workbench.keymapDock);
    return docks.find((p) => this.isFocusWithin(p.root)) ?? null;
  }

  // The top-level focus zones: each dock section and the center, with how to move
  // focus into each. Directional and cyclic pane navigation operate over these
  // (within the center, navigation first moves between its own splits). Whatever
  // currently occupies the bottom dock counts as a zone (so `ctrl-w j` reaches it).
  private focusZones(): { root: Widget; focus: () => void }[] {
    const zones: { root: Widget; focus: () => void }[] = [
      // The file tree and Source Control are tabs in one panel (one zone); entering
      // it focuses whichever tab is active.
      { root: this.workbench.leftPanel.root, focus: () => this.focusSidePanel() },
      // The agent list is its own full-height sidebar (left of everything); its
      // geometry makes it the leftmost zone for directional pane navigation.
      { root: this.workbenchList.root, focus: () => this.workbenchList.focus() },
      { root: this.workbench.center.root, focus: () => this.focusActivePane() },
    ];
    if (this.workbench.bottomDock === 'notifications')
      zones.push({
        root: this.workbench.notificationPanel.root,
        focus: () => this.focusDock(this.workbench.notificationPanel, () => this.workbench.notificationLog.focus()),
      });
    else if (this.workbench.bottomDock === 'diagnostics')
      zones.push({
        root: this.workbench.diagnosticsDock.root,
        focus: () => this.focusDock(this.workbench.diagnosticsDock, () => this.workbench.diagnosticsPanel.focus()),
      });
    else if (this.workbench.bottomDock === 'keymap')
      zones.push({
        root: this.workbench.keymapDock.root,
        focus: () => this.focusDock(this.workbench.keymapDock, () => this.workbench.keymapPanel.focus()),
      });
    return zones;
  }

  // Directional focus: move between the center's splits first; on reaching the
  // center's edge (or from a dock section) move to the nearest zone in that
  // direction by on-screen geometry, so any dock arrangement works.
  private navPane(direction: Direction) {
    if (this.isFocusWithin(this.workbench.center.root) && this.workbench.center.focusDirection(direction)) {
      this.focusActivePane();
      return;
    }
    const zones = this.focusZones();
    // The origin zone is wherever focus sits; when focus isn't clearly in any zone
    // (e.g. an empty center pane that couldn't take keyboard focus) fall back to
    // the center so directional navigation still has somewhere to start from.
    const from =
      zones.find((z) => this.isFocusWithin(z.root)) ??
      zones.find((z) => z.root === this.workbench.center.root) ??
      null;
    // When leaving the center, navigate from the active leaf's rect (not the whole
    // center area) so the adjacent dock is found relative to where focus sits.
    const fromRect =
      from && from.root === this.workbench.center.root
        ? this.rectOf(this.workbench.center.activePanel.root)
        : from
          ? this.rectOf(from.root)
          : null;
    if (!fromRect) return;
    this.nearestZone(zones, from, fromRect, direction)?.focus();
  }

  // Cycle focus to the next zone (`ctrl-w w`): within the center, cycle its
  // splits; otherwise advance to the next zone in order, wrapping around.
  private focusNextPane() {
    if (this.isFocusWithin(this.workbench.center.root) && this.workbench.center.focusNext()) {
      this.focusActivePane();
      return;
    }
    const zones = this.focusZones();
    const i = zones.findIndex((z) => this.isFocusWithin(z.root));
    // Default the starting point to the center when focus isn't in any zone, so
    // the cycle still advances from a sensible place.
    const start = i >= 0 ? i : zones.findIndex((z) => z.root === this.workbench.center.root);
    zones[(start + 1) % zones.length]?.focus();
  }

  // The nearest zone to `fromRect` in `direction`: its center must lie that way
  // and it must overlap on the cross axis; ties favor the most-overlapping zone.
  // (Same scoring as PanelGroup.focusDirection, applied across top-level zones.)
  private nearestZone(
    zones: { root: Widget; focus: () => void }[],
    from: { root: Widget } | null,
    fromRect: { x: number; y: number; w: number; h: number },
    direction: Direction,
  ): { focus: () => void } | null {
    const fromCx = fromRect.x + fromRect.w / 2;
    const fromCy = fromRect.y + fromRect.h / 2;
    let best: { focus: () => void } | null = null;
    let bestScore = Infinity;
    for (const zone of zones) {
      if (zone === from) continue;
      const r = this.rectOf(zone.root);
      if (!r || r.w <= 0 || r.h <= 0) continue;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      let distance: number;
      let overlap: number;
      switch (direction) {
        case 'left':
          if (cx >= fromCx) continue;
          distance = fromCx - cx;
          overlap = span(fromRect.y, fromRect.h, r.y, r.h);
          break;
        case 'right':
          if (cx <= fromCx) continue;
          distance = cx - fromCx;
          overlap = span(fromRect.y, fromRect.h, r.y, r.h);
          break;
        case 'up':
          if (cy >= fromCy) continue;
          distance = fromCy - cy;
          overlap = span(fromRect.x, fromRect.w, r.x, r.w);
          break;
        case 'down':
          if (cy <= fromCy) continue;
          distance = cy - fromCy;
          overlap = span(fromRect.x, fromRect.w, r.x, r.w);
          break;
      }
      if (overlap <= 0) continue;
      const score = distance - overlap * 0.001;
      if (score < bestScore) {
        bestScore = score;
        best = zone;
      }
    }
    return best;
  }

  // A widget's bounds relative to the workbench root (the common ancestor of all
  // zones), or null if unavailable.
  private rectOf(widget: Widget): { x: number; y: number; w: number; h: number } | null {
    try {
      const result: any = (widget as any).computeBounds(this.workbench.root);
      const rect = Array.isArray(result) ? result[1] : result;
      if (!rect) return null;
      return { x: rect.getX(), y: rect.getY(), w: rect.getWidth(), h: rect.getHeight() };
    } catch {
      return null;
    }
  }

  // Move keyboard focus to the content of the active center pane (its editor or
  // terminal); fall back to the panel's empty-state placeholder when it has no
  // tabs, so an empty pane steals focus from whatever held it.
  private focusActivePane() {
    const widget = this.workbench.center.activePanel.activeChild;
    if (!widget) {
      this.workbench.center.activePanel.focusEmptyState();
      return;
    }
    if (this.restoreTabFocus(widget)) return; // restore where focus last sat in this tab
    const editor = this.editors.get(widget);
    if (editor) {
      editor.focus();
      return;
    }
    this.terminals.get(widget)?.focus();
  }

  // Record the currently focused widget against the panel tab that contains it,
  // for restoreTabFocus. Driven by the window's notify::focus-widget.
  private rememberFocus() {
    const focus = this.window.getFocus();
    if (!focus) return;
    const child = this.panelChildAncestor(focus);
    if (!child) return;
    // Focus on the tab's own root (a terminal in normal mode, an empty pane) has no
    // distinct inner target — drop any stale entry rather than leave one behind, so
    // a later restore re-derives focus from the tab itself. Otherwise a terminal
    // left in normal mode would resurrect the Vte it held in a previous insert
    // session, focusing the child while the mode says normal (see Terminal).
    if (child === focus) this.focusMemory.delete(child);
    else this.focusMemory.set(child, focus);
  }

  // The panel-tab content widget (`.is-panel-child`, set by Panel.add) that
  // contains `widget`, or null when it isn't inside a panel tab.
  private panelChildAncestor(widget: Widget): Widget | null {
    let cur: Widget | null = widget;
    while (cur) {
      if (cur.hasCssClass('is-panel-child')) return cur;
      cur = cur.getParent();
    }
    return null;
  }

  // Restore focus to the widget that last held it inside `child`'s tab, if still
  // valid (present in the window). Returns whether focus was restored, so callers
  // can fall back to their default focus target.
  private restoreTabFocus(child: Widget): boolean {
    const remembered = this.focusMemory.get(child);
    if (!remembered || remembered === child || remembered.getRoot() === null) return false;
    return remembered.grabFocus();
  }

  // Focus a dock panel's active tab, restoring its remembered focus when known,
  // else running the tab's default focus action.
  private focusDock(panel: Panel, fallback: () => void) {
    const child = panel.activeChild;
    if (child && this.restoreTabFocus(child)) return;
    fallback();
  }

  /** Whether keyboard focus currently sits inside `root`'s widget subtree. */
  private isFocusWithin(root: Widget): boolean {
    let current: Widget | null = this.window.getFocus();
    while (current) {
      if (current === root) return true;
      current = current.getParent();
    }
    return false;
  }

  // --- File operations (routed to the active editor) -------------------------

  private saveActive() {
    // An editable multibuffer (project search OR diff) saves every file it touched, not one Document.
    const surface = this.activeSavableSurface();
    if (surface) {
      surface.save();
      return;
    }
    const editor = this.activeEditor;
    if (!editor) return;
    if (editor.currentFile) editor.save();
    else this.saveAsDialog();
  }

  /** The active center/focused child resolved to a widget, for surface lookups. */
  private activeChildWidget(): Widget | null {
    return Panel.active?.activeChild ?? this.workbench.center.activePanel.activeChild ?? null;
  }

  /** The project-search multibuffer hosted by the active child, if any. */
  private activeMultibuffer(): SearchResultsView | null {
    const focused = Panel.active?.activeChild;
    const focusedMb = focused ? this.searchResultsViews.get(focused) : undefined;
    if (focusedMb) return focusedMb;
    const centerChild = this.workbench.center.activePanel.activeChild;
    return centerChild ? this.searchResultsViews.get(centerChild) ?? null : null;
  }

  /** The active editable surface (project-search or diff multibuffer) that owns a `save()`. */
  private activeSavableSurface(): { save(): void } | null {
    const widget = this.activeChildWidget();
    if (!widget) return null;
    return this.searchResultsViews.get(widget) ?? this.continuousDiffViews.get(widget) ?? null;
  }

  /** The diff multibuffer hosted by the active child, if any (for the expand-context commands). */
  private activeContinuousDiff(): ContinuousDiffView | null {
    const widget = this.activeChildWidget();
    return widget ? this.continuousDiffViews.get(widget) ?? null : null;
  }

  /** The search-results multibuffer hosted by the active child, if any (for the collapse commands). */
  private activeSearchResults(): SearchResultsView | null {
    const widget = this.activeChildWidget();
    return widget ? this.searchResultsViews.get(widget) ?? null : null;
  }

  private openDialog() {
    const dialog = new Gtk.FileDialog();
    dialog.setTitle('Open File');
    dialog.open(this.window, null, (self: any, result: any) => {
      try {
        const file = self.openFinish(result);
        if (file) this.openFile(file.getPath());
      } catch {
        // The user dismissed the dialog; nothing to do.
      }
    });
  }

  private saveAsDialog() {
    const editor = this.activeEditor;
    if (!editor) return;
    const dialog = new Gtk.FileDialog();
    dialog.setTitle('Save File As');
    if (editor.currentFile) dialog.setInitialName(Path.basename(editor.currentFile));
    dialog.save(this.window, null, (self: any, result: any) => {
      try {
        const file = self.saveFinish(result);
        if (file) editor.saveAs(file.getPath());
      } catch {
        // Cancelled.
      }
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

// Overlap length of two 1-D segments [a0, a0+aLen] and [b0, b0+bLen]; <= 0 means
// they don't overlap. Used by directional pane navigation to require cross-axis
// alignment between zones.
function span(a0: number, aLen: number, b0: number, bLen: number): number {
  return Math.min(a0 + aLen, b0 + bLen) - Math.max(a0, b0);
}

// The same indicators the WorkbenchList uses: nf-md-cog-sync while working, else a
// round dot. Adw tab titles are plain text (no markup, no colour), so the dot
// can't be colour-coded like the sidebar — the waiting state instead drives Adw's
// native `needs-attention` tab highlight (see updateAgentTab).
const AGENT_WORKING_GLYPH = NERDFONT.STATUS.SYNC;
const AGENT_STATUS_DOT = '●';

/** An agent tab's title: the WorkbenchList status glyph prefixed to the agent's name. */
function agentTabTitle(agent: Agent): string {
  const glyph = agent.status === 'working' ? AGENT_WORKING_GLYPH : AGENT_STATUS_DOT;
  return `${glyph} ${agent.title}`;
}

// A terminal tab is prefixed with the shell glyph (the Adw tab-icon convention is
// a glyph embedded in the title; see icons.ts), mirroring how editor/agent tabs
// carry their own marker.
function terminalTabTitle(terminal: Terminal): string {
  return `${Icons.terminal} ${terminal.title}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Whether `path` is `root` itself or lives beneath it (a `root + sep` prefix, so
// `/a/bc` doesn't count as under `/a/b`).
function isUnderRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(Path.sep) ? root : root + Path.sep);
}

// The `file` tabs in a saved center layout, depth-first — used to reopen an agent
// workbench's reviewed files on restore (the agent leaf is recreated separately).
function fileTabsOf(node: PanelNode): Extract<TabState, { kind: 'file' }>[] {
  if (node.type === 'leaf') {
    return node.tabs.filter((t): t is Extract<TabState, { kind: 'file' }> => t.kind === 'file');
  }
  return [...fileTabsOf(node.start), ...fileTabsOf(node.end)];
}

