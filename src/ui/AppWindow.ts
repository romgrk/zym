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
import { PanelGroup, type Direction, type RestoredChild } from './PanelGroup.ts';
import { TextEditor } from './TextEditor/index.ts';
import { DocumentRegistry } from './TextEditor/DocumentRegistry.ts';
import { buildDefinitionPeek, wrapPeekBody, LIVE_PEEK_HEIGHT } from './TextEditor/buildDefinitionPeek.ts';
import { Terminal, terminalTabTitle } from './Terminal.ts';
import { AgentTerminal, type AgentStatus, type AgentResume } from './AgentTerminal.ts';
import type { Agent } from '../agents/types.ts';
import { ensureProjectActionsFile, type Action } from '../actions.ts';
import { openActionRunner } from './workbench/ActionPicker.ts';
import { AgentConversation } from './AgentConversation.ts';
import { AGENT_CONFIGS, resolveAgentKind, type AgentKind } from '../agents/configs.ts';
import { listResumableSessions, recordSessionWorktree, relativeTime, resolveResumeCwd, type AgentSession } from '../agentSessions.ts';
import { PROJECT_NAME } from './WorkbenchList.ts';
import { Sidebar } from './Sidebar.ts';
import { AgentSidebar } from './AgentSidebar.ts';
import { HeaderBar } from './HeaderBar.ts';
import { GitPanel } from './GitPanel.ts';
import { fileIconGlyph } from './fileIcons.ts';
import { Icons } from './icons.ts';
import { acquireGitRepo, releaseGitRepo, type GitOpResult } from '../git.ts';
import { git, repoRoot, invalidateRepoRoot, commitMsgPath, listWorktrees, lastCommitMessage } from '../git.ts';
import { stage, unstage, stageAll, unstageAll, type GitDone } from '../git.ts';
import { openCommitDiff, openCommitPicker, openBranchDiff } from './diffViews.ts';
import { GitLogView } from './GitLogView.ts';
import { registerGithubCommands } from './githubCommands.ts';
import { Workbench, DOCK_SIDES, type BottomDock, type DockSide } from './workbench/Workbench.ts';
import { openFilePicker } from './FilePicker.ts';
import { openFileOpener, openFolderPicker, openRenamePicker } from './FileOpener.ts';
import { tildify } from '../util/tilde.ts';
import { openScriptRunner, detectPackageManager } from './ScriptRunner.ts';
import { openWorkspaceSymbolPicker } from './WorkspaceSymbolPicker.ts';
import { openDocumentSymbolPicker } from './DocumentSymbolPicker.ts';
import { openSearchPicker } from './SearchPicker.ts';
import { SearchResultsView } from './SearchResultsView.ts';
import { ProjectSearchView } from './ProjectSearchView.ts';
import { DiffView } from './DiffView.ts';
import { openReferencesPicker } from './ReferencesPicker.ts';
import { openCommandPicker } from './CommandPicker.ts';
import { openThemePicker } from './ThemePicker.ts';
import { saveConfig } from '../config/load.ts';
import { WhichKey } from './WhichKey.ts';
import { openAgentPicker } from './AgentPicker.ts';
import { openWorkbenchPicker } from './WorkbenchPicker.ts';
import { openAgentLauncher, launchPrompt, type LauncherMode } from './AgentLauncher.ts';
import {
  openBranchPicker,
  openDeleteBranchPicker,
  openMergeBranchPicker,
  openRenameBranchPicker,
} from './BranchPicker.ts';
import { openStashPicker } from './StashPicker.ts';
import { openGithubCIChecksPicker } from './GithubCIChecksPicker.ts';
import { openPicker, highlightSegment } from './Picker.ts';
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
import { PluginManagerPanel } from './PluginManagerPanel.ts';
import { type NavigationKind, type LspConfig, type LspDocument } from '../lsp/LspManager.ts';
import { normalizeWorkspaceEdit, applyTextEdits } from '../lsp/workspaceEdit.ts';
import { uriToPath, type PositionEncoding } from '../lsp/position.ts';
import type { WorkspaceEdit, CodeAction, Command } from 'vscode-languageserver-protocol';
import { CancellationTokenSource } from 'vscode-languageserver-protocol';
import { NotificationToasts } from './NotificationToasts.ts';
import { loadKeymaps, ensureUserKeymap } from '../keymaps/load.ts';
import { loadConfig, configPath } from '../config/load.ts';
import { setUserInjectionRules } from '../syntax/grammar.ts';
import { parseInjectionRules } from '../syntax/userInjections.ts';
import { CompositeDisposable, Disposable, Emitter, type DisposableLike } from '../util/eventKit.ts';
import { applyNotificationStyles } from './chromeStyles.ts';
import { addStyles } from '../styles.ts';

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
// Expanded width (px) of the workbench sidebar — the full-height column at the very
// left of the window, outside (left of) the header bar — and its collapsed width
// (icons only). These are the two positions of the top-level sidebar↔content split.
const SIDEBAR_WIDTH = 280;
const SIDEBAR_COLLAPSED_WIDTH = 48;
// Default width of the agent "secondary sidebar" column (the agent widget). Wider
// than the file/Source-Control dock; resizable, and a dragged width is remembered
// for the rest of the session (`agentSidebarWidth`).
const AGENT_SIDEBAR_WIDTH = 480;

addStyles(/* css */`
  .AppWindow--paned > separator { opacity: 0; }
`)

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
  private sidebarHidden = false; // user toggle (sidebar:toggle, `ctrl-w g s`); detaches the column entirely
  private sidebarShownWidth = SIDEBAR_WIDTH; // split position captured on hide, re-applied on show
  // Commit-message editor tabs: the message file each is bound to, so closing the
  // tab can commit (git-style: write the message, save, close to commit).
  private readonly commitEditors = new Map<Widget, { repo: string; msgPath: string; amend: boolean }>();
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
  // The plugin manager center tab handle; null after it is closed.
  private pluginManagerTab: { root: Widget; child: PanelChild } | null = null;
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
  private agentSidebarWidth = AGENT_SIDEBAR_WIDTH; // last dragged width, re-applied on show
  private agentSidebarHidden = false; // user toggle (agent-sidebar:toggle); hides the column even with an agent active
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
      onOpenDiagnostics: () => this.toggleDiagnosticsPanel(),
      onOpenLog: () => this.toggleNotificationLog(),
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
        if (docks.notificationLog && this.workbench.bottomDock !== 'notifications') this.toggleNotificationLog();
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
      onToggleCollapsed: (collapsed) => this.setSidebarCollapsed(collapsed),
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
    this.agentPaned.setPosition(this.agentSidebarWidth);
    this.agentPaned.setResizeStartChild(false);
    this.agentPaned.setShrinkStartChild(false);
    // Remember a dragged width so it survives switching away and back.
    this.agentPaned.on('notify::position', () => {
      if (this.agentPaned.getStartChild()) this.agentSidebarWidth = this.agentPaned.getPosition();
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
    // Track the focused widget per panel tab so each panel can restore focus to
    // exactly where it was when it is re-activated (see focusMemory).
    this.window.on('notify::focus-widget', () => this.rememberFocus());
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

  // Apply the sidebar collapse/expand width to the top-level split: the list's robot
  // button toggles between icons-only and icons+text and forwards the new state here.
  private setSidebarCollapsed(collapsed: boolean): void {
    this.sidebarPaned.setPosition(collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH);
  }

  // Toggle the workbench sidebar's visibility (sidebar:toggle, `ctrl-w g s`). Mirrors
  // toggleAgentSidebar: detach/attach the top-level split's start child — rather than
  // toggling `visible` — so an absent column leaves no stray handle, restoring its last
  // width (collapsed or expanded) on show. Steers focus to the center when it hides out
  // from under focus, into the list when freshly revealed.
  private toggleSidebar(): void {
    const focusWasInside = this.isFocusWithin(this.sidebar.root);
    this.sidebarHidden = !this.sidebarHidden;
    if (this.sidebarHidden) {
      this.sidebarShownWidth = this.sidebarPaned.getPosition();
      this.sidebarPaned.setStartChild(null);
      if (focusWasInside) this.focusActivePane(); // it hid out from under focus
    } else {
      this.sidebarPaned.setStartChild(this.sidebar.root);
      this.sidebarPaned.setPosition(this.sidebarShownWidth);
      this.sidebar.list.focus(); // freshly revealed — focus into it
    }
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
    options: { kind?: AgentKind; prompt?: string; userPrompt?: string; resume?: AgentResume; title?: string; cwd?: string; command?: string[]; background?: boolean } = {},
  ): Agent {
    // Both kinds can resume now (claude-sdk rebuilds its transcript from disk), so a
    // resume no longer forces the terminal agent — it respects the configured kind
    // unless a caller pins one (e.g. restoreAgent passes the saved agent's kind).
    const kind = options.kind ?? resolveAgentKind(zym.config.get('agent.implementation'));
    const cwd = options.cwd ?? process.cwd();
    const agent = AGENT_CONFIGS[kind].create({
      cwd, command: options.command, prompt: options.prompt, userPrompt: options.userPrompt, resume: options.resume, title: options.title,
      onOpenFile: (path) => this.openFile(path),
    });
    // Track in the kind's map (terminal focus-routing / headless disposal key off these).
    if (agent instanceof AgentTerminal) this.terminals.set(agent.root, agent);
    else if (agent instanceof AgentConversation) this.conversations.set(agent.root, agent);
    // Background launch: build the agent's workbench and start it, but stay on the
    // current workbench and don't focus it (it's listed in the sidebar; switch to it later).
    const workbench = this.buildWorkbench(agent, cwd);
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
        this.openAgent({ prompt: agentPrompt, userPrompt, command, cwd, kind, background });
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

  /** This repo's main worktree — where a resume falls back to when the session's
   *  own (worktree) cwd is gone. */
  private repoRoot(): string {
    return this.agentSessionRoots()[0] ?? process.cwd();
  }

  // `openAgent` options to resume `session`, restoring its branch/worktree/cwd:
  // spawn in the cwd Claude recorded (where `--resume` resolves the session and the
  // workbench roots). If the agent had moved into a worktree *dynamically* (a sidecar
  // `effectiveCwd` differing from the transcript cwd), tell it to re-announce that
  // worktree via the bridge so the editor re-roots — and to do nothing else, so a
  // resume just restores the view without kicking off work.
  private resumeOptions(session: AgentSession): { cwd?: string; resume: AgentResume; prompt?: string; title: string } {
    // Spawn where Claude recorded the session; if that worktree is gone, the
    // transcript is relocated under the main repo and we resume there instead.
    const cwd = resolveResumeCwd(session, this.repoRoot());
    const relocated = cwd !== session.cwd;
    // The dynamic-worktree re-announce only makes sense when we're still in the
    // original tree — a relocated resume's worktree is gone too, so skip it.
    const moved =
      !relocated && session.effectiveCwd && session.effectiveCwd !== session.cwd ? session.effectiveCwd : null;
    return {
      cwd,
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
      agent = session
        ? this.openAgent({ ...this.resumeOptions(session), kind })
        : this.openAgent({ kind, cwd: a.cwd, resume: { sessionId: a.sessionId } });
    } else {
      agent = this.openAgent({ kind, cwd: a.cwd, prompt: a.prompt });
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
    // Branch into the same kind as the source agent, rooted where it ran (so
    // `--resume` resolves the transcript and the workbench roots correctly).
    this.openAgent({
      kind: agent instanceof AgentConversation ? 'claude-sdk' : 'claude-tui',
      cwd: agent.effectiveCwd,
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

  // Restart an agent: retire the old one and relaunch with the same cwd, resuming
  // its claude conversation (forking a still-live session so the original
  // transcript isn't clobbered). A pinned (renamed) title carries over.
  private restartAgent(agent: Agent): void {
    const kind: AgentKind = agent instanceof AgentConversation ? 'claude-sdk' : 'claude-tui';
    const title = agent.renamed ? agent.title : undefined;
    // Both kinds resume by session id now; fork a copy if the agent is still live so
    // the original keeps running. A headless agent restarts in its own (possibly
    // moved) cwd, which is also where --resume resolves its transcript.
    const resume = agent.sessionId ? { sessionId: agent.sessionId, fork: !agent.exited } : undefined;
    const cwd = kind === 'claude-sdk' ? agent.effectiveCwd : undefined;
    this.closeAgent(agent);
    this.openAgent({ kind, resume, title, cwd });
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
    // A closed commit-message tab finalizes the commit (if a message was saved).
    const commitInfo = this.commitEditors.get(widget);
    if (commitInfo) {
      this.commitEditors.delete(widget);
      this.finishCommit(commitInfo.repo, commitInfo.msgPath, commitInfo.amend);
    }
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
    // The workbench owns its runtime action set (seeded from `<cwd>/.zym/actions.json`,
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
    this.showAgentSidebar(this.activeAgent); // reveal this workbench's agent column (or hide it)
    this.updateViewedAgent();
    this.focusActivePane();
  }

  // Reveal the agent "secondary sidebar" for `agent` (its widget becomes the visible
  // stack child + the column is attached at its last width), or detach the column —
  // when there's no agent (the user workbench) or the user has toggled it hidden
  // (`agentSidebarHidden`). Attaching/detaching the Paned start child — rather than
  // toggling visibility — keeps the column free of a stray handle when absent.
  private showAgentSidebar(agent: Agent | null): void {
    if (agent) this.agentSidebar.show(agent); // keep the stack on the active agent (+ its edited-files badge)
    else this.agentSidebar.clearActive(); // user workbench — no agent to track
    const show = agent !== null && !this.agentSidebarHidden;
    if (show && !this.agentPaned.getStartChild()) {
      this.agentPaned.setStartChild(this.agentSidebar.root);
      this.agentPaned.setPosition(this.agentSidebarWidth);
    } else if (!show && this.agentPaned.getStartChild()) {
      this.agentPaned.setStartChild(null);
    }
  }

  // Toggle the agent "secondary sidebar" visibility (agent-sidebar:toggle, `ctrl-w g a`).
  // No-op + toast on the user workbench (nothing to toggle). Mirrors toggleDockSide:
  // focus the agent when revealing, fall back to the center when hiding out from under
  // focus.
  private toggleAgentSidebar(): void {
    const agent = this.activeAgent;
    if (!agent) {
      this.toast('No agent sidebar to toggle');
      return;
    }
    const focusWasInside = this.isFocusWithin(this.agentSidebar.root);
    this.agentSidebarHidden = !this.agentSidebarHidden;
    this.showAgentSidebar(agent);
    if (this.agentSidebarHidden) {
      if (focusWasInside) this.focusActivePane(); // it hid out from under focus
    } else {
      agent.focus(); // freshly revealed — focus into it
    }
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

  // The Panel currently shown in the bottom dock (`this.workbench.bottomDock`), or null.
  private bottomDockPanel(): { root: Widget } | null {
    switch (this.workbench.bottomDock) {
      case 'notifications': return this.workbench.notificationPanel;
      case 'diagnostics': return this.workbench.diagnosticsDock;
      case 'keymap': return this.workbench.keymapDock;
      default: return null;
    }
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
      'pane:split-right': { didDispatch: () => this.splitPane('right'), description: 'Split the pane to the right' },
      'pane:split-down': { didDispatch: () => this.splitPane('down'), description: 'Split the pane downward' },
      'pane:close': { didDispatch: () => this.closePane(), description: 'Close the active pane' },
      // The lifecycle counterpart to closing a tab: rebuild the most recently closed
      // one from the workspace's reopen stack (cross-panel, so it lives here, not in
      // Panel's per-panel tab commands).
      'tab:reopen-last': { didDispatch: () => zym.workspace.reopenLastTab(), description: 'Reopen the last closed tab' },
      'pane:focus-left': { didDispatch: () => this.navPane('left'), description: 'Focus the pane to the left' },
      'pane:focus-right': { didDispatch: () => this.navPane('right'), description: 'Focus the pane to the right' },
      'pane:focus-up': { didDispatch: () => this.navPane('up'), description: 'Focus the pane above' },
      'pane:focus-down': { didDispatch: () => this.navPane('down'), description: 'Focus the pane below' },
      'pane:focus-next': { didDispatch: () => this.focusNextPane(), description: 'Cycle to the next pane' },
      // Reveal+focus the file tree (re-adding it if the right dock had been collapsed
      // away by closing its last tab); Source Control opens as a center tab.
      'file-tree:focus': { didDispatch: () => this.revealFileTree(), description: 'Focus the file tree' },
      'git-panel:focus': { didDispatch: () => this.revealGitPanel(), description: 'Focus Source Control' },
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
      'dock:toggle-left': { didDispatch: () => this.toggleDockSide('left'), description: 'Toggle the left dock' },
      'dock:toggle-right': { didDispatch: () => this.toggleDockSide('right'), description: 'Toggle the right dock (Files / Source Control)' },
      'dock:toggle-top': { didDispatch: () => this.toggleDockSide('top'), description: 'Toggle the top dock' },
      'dock:toggle-bottom': { didDispatch: () => this.toggleDockSide('bottom'), description: 'Toggle the bottom dock' },
      'agent-sidebar:toggle': { didDispatch: () => this.toggleAgentSidebar(), description: 'Toggle the agent sidebar' },
      'sidebar:toggle': { didDispatch: () => this.toggleSidebar(), description: 'Toggle the workbench sidebar' },
      'theme:select': { didDispatch: () => this.selectTheme(), description: 'Select the editor theme' },
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
    zym.commands.add('.AppWindow', {
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
        data: s.name.length,
      };
    });
    openPicker({
      host: this.overlay,
      placeholder: 'Install language server',
      items,
      renderRow: (item, positions) => {
        const split = item.data as number;
        return renderRowSingleLine({
          main: highlightSegment(item.text, 0, split, positions),
          detail: highlightSegment(item.text, split + 2, item.text.length, positions),
        });
      },
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
    // Sever the panel's command reg + per-row switch handlers when its tab closes
    // (disposeChild fires this), else the whole panel leaks per open/close (rule 2).
    this.tabCloseHandlers.set(manager.root, () => { manager.dispose(); this.pluginManagerTab = null; });
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

  // Reveal+focus the file tree in the right-side dock, re-attaching the dock panel
  // and re-adding the tab if they were collapsed away by closing the dock's last
  // tab. The panel is re-attached (rooted) *before* any re-add: adding to a
  // detached, unrooted Adw.TabView yields a blank page.
  private revealFileTree() {
    if (this.workbench.leftPanel.root.getParent() === null)
      this.workbench.setRight({ root: this.workbench.leftPanel.root });
    if (!this.workbench.leftPanel.getChildren().includes(this.workbench.fileTree.root)) {
      if (this.workbench.fileTree.root.getParent()) this.workbench.fileTree.root.unparent(); // drop any closed page
      this.workbench.filesTab = this.workbench.leftPanel.add(this.workbench.fileTree.root, {
        title: `${fileIconGlyph('', true)}  Files`,
      });
    }
    this.workbench.filesTab.select();
    this.workbench.fileTree.focus();
  }

  // Open (or reveal) Source Control as a tab in the active center panel — a normal
  // tab, no longer docked on the right. Reveals the existing tab when it is still
  // hosted in a panel; otherwise (re)adds it, unparenting any closed page first (the
  // zombie rule). The GitPanel is lazily built once per workbench (ensureGitPanel)
  // and reused across close/reopen.
  private revealGitPanel() {
    const gitPanel = this.ensureGitPanel(this.workbench);
    if (this.workbench.center.reveal(gitPanel.root)) {
      gitPanel.focus();
      return;
    }
    if (gitPanel.root.getParent()) gitPanel.root.unparent(); // drop any closed/orphaned page
    this.workbench.gitTab = this.workbench.center.add(gitPanel.root, {
      title: `${Icons.git}  Git`,
      requireTabBar: true,
    });
    gitPanel.focus();
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
      // Build the embedded live diff against THIS workbench's repo (l/enter/o reveals the
      // selected change in it); the panel owns its lifecycle.
      buildDiffView: () => this.buildCurrentChangesDiff(workbench),
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

  // Apply `editor.languageInjections` to the grammar registry, then repaint open
  // editors so the change is visible live (the highlighter re-gathers injections
  // each paint, so no reparse is needed). Bad rules are dropped during parsing.
  private configureInjections() {
    setUserInjectionRules(parseInjectionRules(zym.config.get('editor.languageInjections')));
    for (const editor of zym.workspace.getTextEditors()) editor.repaintSyntax();
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
    }, editor.root);
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

  // Focus the file tree in the right-side dock; reveal it if the dock had been
  // collapsed away. (Source Control is no longer a dock tab — it opens in the
  // center via revealGitPanel.)
  private focusSidePanel() {
    if (this.workbench.leftPanel.root.getParent() === null || this.workbench.leftPanel.tabCount === 0) {
      this.revealFileTree();
      return;
    }
    const child = this.workbench.leftPanel.activeChild;
    if (child && this.restoreTabFocus(child)) return;
    this.workbench.fileTree.focus();
  }

  // Window-level file/edit operations, surfaced in the command palette and (for
  // most) on the space leader. Handlers only; bindings live in the central keymap.
  private registerWindowCommands() {
    zym.commands.add('.AppWindow', {
      'file:open': { didDispatch: () => this.openDialog(), description: 'Open a file (dialog)' },
      'file:find': {
        didDispatch: () => openFilePicker(this.overlay, this.workbench.cwd, (path) => this.openFile(path)),
        description: 'Find a file by name',
      },
      'file:open-path': {
        didDispatch: () => openFileOpener(this.overlay, this.workbench.cwd, (path) => this.openFile(path)),
        description: 'Open a file by path',
      },
      'file:move': {
        didDispatch: () => this.moveActiveFile(),
        description: 'Move the current file to another folder',
        when: () => this.activeEditor?.currentFile != null,
      },
      'file:rename': {
        didDispatch: () => this.renameActiveFile(),
        description: 'Rename (or relocate) the current file',
        when: () => this.activeEditor?.currentFile != null,
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
      'diff:collapse-all-files': {
        didDispatch: () => this.activeContinuousDiff()?.collapseAllFiles(),
        description: 'Collapse every file to a one-line header (overview)',
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

  // Stage / unstage the active editor's file. `git add -- <path>` when staging,
  // `git restore --staged -- <path>` when unstaging; the repo root is resolved
  // from the file itself (the active editor may belong to a nested repo).
  private stageCurrentFile(staging: boolean): void {
    const path = this.activeEditor?.currentFile;
    if (!path) return;
    const root = repoRoot(Path.dirname(path));
    if (!root) {
      this.toast('Not in a git repository');
      return;
    }
    const rel = Path.relative(root, path);
    const name = Path.basename(path);
    const verb = staging ? 'Stage' : 'Unstage';
    const op = staging ? stage : unstage;
    op(root, rel, this.gitStageDone(`${verb} ${name}`));
  }

  // Stage / unstage the whole working tree: `git add -A` / `git reset -q`.
  private stageEverything(staging: boolean): void {
    const root = repoRoot(this.workbench.cwd);
    if (!root) {
      this.toast('Not in a git repository');
      return;
    }
    const op = staging ? stageAll : unstageAll;
    op(root, this.gitStageDone(staging ? 'Stage all' : 'Unstage all'));
  }

  // Refresh the cached repo so the gutter, Source Control panel, and branch
  // indicator update immediately; report only failures (success is silent).
  private gitStageDone(label: string): GitDone {
    return (ok, _out, err) => {
      if (!ok) zym.notifications.addError(`${label} failed`, { detail: err.trim() });
      this.workbench.git.refresh();
    };
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
   *  disk; a deleted file → empty) backed by a live Document, OLD side = the HEAD blob. Null
   *  outside a repo or when there are no changes. Shared by the `git:diff-current-changes` center
   *  tab and the GitPanel's embedded diff (which calls it through GitPanelOptions.buildDiffView). */
  private async buildCurrentChangesDiff(workbench: Workbench<'user' | Agent>): Promise<DiffView | null> {
    const cwd = workbench.cwd;
    const root = repoRoot(cwd);
    if (!root) return null;
    const paths = [...workbench.git.getFileStatuses().keys()].sort();
    if (paths.length === 0) return null;
    const showHead = (rel: string): Promise<string> =>
      new Promise((resolve) => git(root, ['show', `HEAD:${rel}`], (ok, out) => resolve(ok ? out : '')));
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
      this.toast(repoRoot(this.workbench.cwd) ? 'No changes against HEAD' : 'Not in a git repository');
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
          this.openAgent({ prompt: agentPrompt, userPrompt, command, cwd, kind, background });
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
        didDispatch: () => this.openFile(ensureProjectActionsFile(this.workbench.cwd)),
        description: 'Edit the workbench actions (.zym/actions.json)',
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

  // Git network operations. They run through GitRepo.run (Gio.Subprocess, non-
  // blocking), so the branch button's spinner reflects progress automatically;
  // the result is surfaced as a toast.
  private registerGitCommands() {
    zym.commands.add('.AppWindow', {
      // Staging from anywhere (not just the Source Control panel): the current
      // editor file, or the whole tree. These shell out to git directly — like the
      // panel's row actions — then refresh the cached repo so the gutter and branch
      // indicator update at once.
      'git:stage-current': {
        didDispatch: () => this.stageCurrentFile(true),
        description: 'Stage the current file (git add)',
        when: () => this.activeEditor?.currentFile != null,
      },
      'git:unstage-current': {
        didDispatch: () => this.stageCurrentFile(false),
        description: 'Unstage the current file',
        when: () => this.activeEditor?.currentFile != null,
      },
      'git:stage-all': {
        didDispatch: () => this.stageEverything(true),
        description: 'Stage all changes (git add -A)',
        when: () => this.workbench.git.getBranch() !== null,
      },
      'git:unstage-all': {
        didDispatch: () => this.stageEverything(false),
        description: 'Unstage all changes',
        when: () => this.workbench.git.getBranch() !== null,
      },
      // Git commands only apply inside a repository (a resolvable branch).
      'git:fetch': { didDispatch: () => this.runGit(() => this.workbench.git.fetch(), 'Fetch'), description: 'Fetch from the remote', when: () => this.workbench.git.getBranch() !== null },
      'git:pull': { didDispatch: () => this.runGit(() => this.workbench.git.pull(), 'Pull'), description: 'Pull from upstream (fast-forward)', when: () => this.workbench.git.getBranch() !== null },
      'git:push': {
        // After a successful push, GitHub re-runs the PR's checks; schedule a CI
        // refresh ~10s out. The service stays busy until then, so the CI segment
        // shows the in-progress (loading) look in the meantime. The first push of a
        // new branch sets its upstream to this remote (the fork's), per `git.remotes.origin`.
        didDispatch: () => {
          const remote = (zym.config.get('git.remotes.origin') as string) || 'origin';
          this.runGit(() => this.workbench.git.push(remote), 'Push', () => this.headerBar.github.scheduleRefresh(10000));
        },
        description: 'Push to the remote (sets the upstream on a new branch)',
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
    });
    // GitHub-specific commands (pickers + open-on-web) live in their own module.
    registerGithubCommands({
      overlay: this.overlay,
      github: this.headerBar.github,
      cwd: () => this.workbench.cwd,
      git: () => this.workbench.git,
      toast: (message) => this.toast(message),
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

  // Stash the working-tree changes (visible success, since it's a manual action).
  private async stashChanges() {
    const result = await this.workbench.git.stash();
    if (result.isOk()) zym.notifications.addSuccess('Stashed changes');
    else zym.notifications.addError('Stash failed', { detail: result.unwrapErr().message.trim() });
  }

  // Start a commit: open the message file (`.git/COMMIT_EDITMSG`) in an editor
  // tab. Closing the tab finalizes it — git-style: write the message, save, close
  // to commit (close without a saved message aborts). Reuses the normal editor.
  // `amend` rewrites HEAD and prefills the tab with the last commit's message.
  private startCommit(amend = false) {
    const repo = repoRoot(this.workbench.cwd);
    if (!repo) return;
    commitMsgPath(repo, (msgPath) => {
      const open = (initial: string) => {
        try {
          Fs.writeFileSync(msgPath, initial);
        } catch (error) {
          zym.notifications.addError('Could not start commit', { detail: (error as Error).message });
          return;
        }
        const editor = this.openFile(msgPath);
        this.commitEditors.set(editor.root, { repo, msgPath, amend });
      };
      // Amend prefills the existing message so the user can edit it; a plain
      // commit starts blank.
      if (amend) lastCommitMessage(repo, open);
      else open('');
    });
  }

  // Finalize a commit when its message tab closes: commit the saved message, or
  // abort if it is empty. Routed through zym.notifications.
  private finishCommit(repo: string, msgPath: string, amend: boolean) {
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
    void this.workbench.git.commit(msgPath, amend).then((result) => {
      if (result.isOk()) zym.notifications.addSuccess(amend ? 'Amended HEAD' : 'Committed');
      else zym.notifications.addError(amend ? 'Amend failed' : 'Commit failed', { detail: result.unwrapErr().message.trim() });
    });
  }

  // Notification log: show/hide the bottom-dock history, and clear it. Handlers
  // only; bindings (`space n`, and `c` while the log is focused) live in the
  // central keymap.
  private registerNotificationCommands() {
    zym.commands.add('.AppWindow', {
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
      // The file tree lives in the right-side dock (one zone); entering it focuses
      // the tree (Source Control is a center tab now, not a dock tab).
      { root: this.workbench.leftPanel.root, focus: () => this.focusSidePanel() },
      // The agent list is its own full-height sidebar (left of everything); its
      // geometry makes it the leftmost zone for directional pane navigation.
      { root: this.sidebar.list.root, focus: () => this.sidebar.list.focus() },
      { root: this.workbench.center.root, focus: () => this.focusActivePane() },
    ];
    // The agent "secondary sidebar" (when an agent workbench is active) is a zone too —
    // its geometry (between the list and the center) places it for ctrl-w h/l.
    if (this.activeAgent) {
      const agent = this.activeAgent;
      zones.push({ root: this.agentSidebar.root, focus: () => agent.focus() });
    }
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
      const result: any = widget.computeBounds(this.workbench.root);
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
      // An agent workbench's center starts empty (the agent lives in the agent sidebar) —
      // focus the agent rather than the welcome placeholder.
      if (this.activeAgent) { this.activeAgent.focus(); return; }
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

  /** Move the current file into a folder chosen from the directory-navigating
   *  picker (folders only), keeping its name. */
  private moveActiveFile() {
    const editor = this.activeEditor;
    const file = editor?.currentFile;
    if (!editor || !file) return;
    openFolderPicker(this.overlay, this.workbench.cwd, Path.dirname(file), (destDir) =>
      this.relocateFile(editor, file, Path.join(destDir, Path.basename(file))),
    );
  }

  /** Rename (or relocate) the current file by editing its full path in the picker. */
  private renameActiveFile() {
    const editor = this.activeEditor;
    const file = editor?.currentFile;
    if (!editor || !file) return;
    openRenamePicker(this.overlay, this.workbench.cwd, file, (target) => this.relocateFile(editor, file, target));
  }

  /** Move/rename `from` → `to` on disk, prompting before clobbering an existing
   *  file, then hand off to `performRelocate`. A no-op when the destination equals
   *  the source (e.g. "move here" into the same folder, or rename to the same name). */
  private relocateFile(editor: TextEditor, from: string, to: string) {
    if (to === from) return;
    if (Fs.existsSync(to)) {
      const dialog = new Adw.AlertDialog({
        heading: 'Overwrite file?',
        body: `${tildify(to)} already exists. Replace it?`,
      });
      dialog.addResponse('cancel', 'Cancel');
      dialog.addResponse('overwrite', 'Overwrite');
      dialog.setResponseAppearance('overwrite', Adw.ResponseAppearance.DESTRUCTIVE);
      dialog.setDefaultResponse('cancel');
      dialog.setCloseResponse('cancel');
      dialog.on('response', (response: string) => {
        if (response === 'overwrite') void this.performRelocate(editor, from, to);
      });
      dialog.present(this.window);
      return;
    }
    void this.performRelocate(editor, from, to);
  }

  /**
   * The move behind `relocateFile`, run after any overwrite confirmation. First
   * asks the language server how the move rewrites references in other files
   * (`willRenameFiles`, cancellable, with a confirm before applying); then creates
   * missing parents (mkdir -p), moves the file (copy+unlink across filesystems —
   * EXDEV), re-points the open editor, and notifies the server (`didRenameFiles`).
   */
  private async performRelocate(editor: TextEditor, from: string, to: string) {
    const rename = await this.collectRenameEdit(editor, from, to);
    if (rename.cancelled) return; // user cancelled the willRename request

    let refFiles = 0;
    let refEdits = 0;
    if (rename.edit) {
      const { files } = normalizeWorkspaceEdit(rename.edit);
      refFiles = files.length;
      refEdits = files.reduce((n, f) => n + f.edits.length, 0);
      // Confirm before touching other files; declining aborts the whole move so we
      // never leave the file renamed with its references dangling.
      if (refFiles > 0 && !(await this.confirmReferenceUpdate(from, refFiles, refEdits))) return;
    }

    // Apply the reference rewrites while everything is still at its old path (open
    // files in their buffer, closed files on disk), then move + re-point + notify.
    if (rename.edit) this.applyWorkspaceEdit(rename.edit, rename.encoding);
    try {
      Fs.mkdirSync(Path.dirname(to), { recursive: true });
      try {
        Fs.renameSync(from, to);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        Fs.copyFileSync(from, to); // cross-device: rename can't, so copy then drop the original
        Fs.unlinkSync(from);
      }
    } catch (error) {
      zym.notifications.addError('Move failed', { detail: (error as Error).message });
      return;
    }
    editor.renameTo(to); // the open editor follows the file (keeps buffer/undo/cursor)
    zym.lsp.didRenameFiles(from, to);
    const inPlace = Path.dirname(from) === Path.dirname(to);
    const base = inPlace ? `Renamed to ${Path.basename(to)}` : `Moved to ${tildify(to)}`;
    const refs = refFiles > 0
      ? ` — updated ${refEdits} reference${refEdits === 1 ? '' : 's'} in ${refFiles} file${refFiles === 1 ? '' : 's'}`
      : '';
    zym.notifications.addInfo(base + refs);
  }

  /**
   * Ask the primary server how moving `from` → `to` rewrites other files. Shows a
   * cancellable "Updating references…" toast — but only if the request is slow
   * enough to outlast a short delay, so quick renames don't flash it. Returns the
   * edit (possibly null when no server cares), or `{ cancelled }` if the user bailed.
   */
  private async collectRenameEdit(
    editor: TextEditor,
    from: string,
    to: string,
  ): Promise<{ cancelled: true } | { cancelled: false; edit: WorkspaceEdit | null; encoding: PositionEncoding }> {
    const source = new CancellationTokenSource();
    let cancelled = false;
    let toast: ReturnType<typeof zym.notifications.addInfo> | undefined;
    const spinner = setTimeout(() => {
      toast = zym.notifications.addInfo('Updating references…', {
        loading: true,
        dismissable: true,
        buttons: [{ text: 'Cancel', onDidClick: () => { cancelled = true; source.cancel(); } }],
      });
    }, 300);
    let edit: WorkspaceEdit | null = null;
    try {
      edit = await zym.lsp.willRenameFiles(from, to, source.token);
    } catch {
      // Cancellation or a server error — fall through (a server error proceeds as a
      // plain move; an explicit cancel is caught by the flag below).
    } finally {
      clearTimeout(spinner);
      toast?.dismiss();
    }
    if (cancelled) return { cancelled: true };
    return { cancelled: false, edit, encoding: zym.lsp.completionPositionEncoding(editor.lsp) ?? 'utf-16' };
  }

  /** Confirm applying the cross-file reference rewrites of a move (Move & Update / Cancel). */
  private confirmReferenceUpdate(from: string, fileCount: number, editCount: number): Promise<boolean> {
    return new Promise((resolve) => {
      const dialog = new Adw.AlertDialog({
        heading: 'Update references?',
        body:
          `Moving ${Path.basename(from)} updates ${editCount} reference${editCount === 1 ? '' : 's'} ` +
          `across ${fileCount} file${fileCount === 1 ? '' : 's'}.`,
      });
      dialog.addResponse('cancel', 'Cancel');
      dialog.addResponse('move', 'Move & Update');
      dialog.setResponseAppearance('move', Adw.ResponseAppearance.SUGGESTED);
      dialog.setDefaultResponse('move');
      dialog.setCloseResponse('cancel');
      dialog.on('response', (response: string) => resolve(response === 'move'));
      dialog.present(this.window);
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

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Whether `path` is `root` itself or lives beneath it (a `root + sep` prefix, so
// `/a/bc` doesn't count as under `/a/b`).
function isUnderRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(Path.sep) ? root : root + Path.sep);
}

