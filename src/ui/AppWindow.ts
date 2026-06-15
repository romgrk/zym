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
  GLib,
  Gtk,
  type Application,
  type ApplicationWindow,
  type ToastOverlay,
  type WindowTitle,
} from '../gi.ts';
import { FileTree } from './FileTree.ts';
import { Panel, type PanelChild } from './Panel.ts';
import { PanelGroup, type Direction, type RestoredChild } from './PanelGroup.ts';
import { TextEditor } from './TextEditor/index.ts';
import { Terminal } from './Terminal.ts';
import { AgentTerminal, type AgentStatus, type AgentResume } from './AgentTerminal.ts';
import { listAgentSessions } from '../agentSessions.ts';
import { AgentList } from './AgentList.ts';
import { GitPanel } from './GitPanel.ts';
import { fileIconGlyph } from './fileIcons.ts';
import { Icons, iconLabel } from './icons.ts';
import { BranchButton } from './BranchButton.ts';
import { GithubButtons } from './GithubButtons.ts';
import { openGitRepo, type GitRepo } from '../git.ts';
import { repoRoot, commitMsgPath, commit } from '../git/cli.ts';
import { Workbench } from './Workbench.ts';
import { openFilePicker } from './FilePicker.ts';
import { openCommandPicker } from './CommandPicker.ts';
import { WhichKey } from './WhichKey.ts';
import { openAgentPicker } from './AgentPicker.ts';
import { openBranchPicker } from './BranchPicker.ts';
import { openPicker } from './Picker.ts';
import { proseMarkup, escapeMarkup, PROSE_LINE_HEIGHT } from './proseMarkup.ts';
import { openConfigEditor } from './ConfigEditor.ts';
import { quilx } from '../quilx.ts';
import { type SessionParticipant, type TabState } from '../SessionManager.ts';
import { SessionController } from '../SessionController.ts';
import { type Notification } from '../Notification.ts';
import { NotificationLog } from './NotificationLog.ts';
import { KeymapPanel } from './KeymapPanel.ts';
import { LocationList } from './LocationList.ts';
import { DiagnosticsPanel } from '../lsp/diagnostics/DiagnosticsPanel.ts';
import { type NavigationKind, type LspConfig } from '../lsp/LspManager.ts';
import { NotificationToasts } from './NotificationToasts.ts';
import { loadKeymaps } from '../keymaps/load.ts';
import { loadConfig, configPath } from '../config/load.ts';
import { type DisposableLike } from '../util/eventKit.ts';
import { styles, addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';

// The unsaved/modified marker (a small dot) — warning-colored in the header bar.
addStyles(`.quilx-modified-dot { color: ${theme.ui.warning ?? '#e5a50a'}; }`);

// The header-bar title is the project name: the last path component of the cwd.
const PROJECT_NAME = Path.basename(process.cwd());
const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 950;
const TOAST_TIMEOUT = 15;
// Initial height (px) of the tabbed Files/Source-Control panel atop the left
// dock; the agent list takes the remainder below it. Kept modest so the agent
// list gets the larger share of the dock by default.
const LEFT_SPLIT_POSITION = 360;

type Widget = InstanceType<typeof Gtk.Widget>;
// What currently occupies the (otherwise empty) bottom dock.
type BottomDock = 'notifications' | 'diagnostics' | 'references' | 'keymap' | null;

export class AppWindow {
  private readonly app: Application;
  private readonly onQuit: () => void;

  // Per-tab focus memory: the widget that last held keyboard focus inside each
  // panel-tab child, so re-activating a panel restores focus to the exact same
  // widget (e.g. an editor's search bar, not just the editor view). Keyed by the
  // tab's content widget (the `.is-panel-child`); a WeakMap so closed tabs drop.
  private readonly focusMemory = new WeakMap<Widget, Widget>();

  // The splittable center: a tree of editor groups. Each tab hosts one
  // TextEditor, mapped from its root widget so the active child can be resolved
  // back to its editor regardless of which split it lives in.
  private readonly center: PanelGroup;
  private readonly editors = new Map<Widget, TextEditor>();
  // Terminal tabs share the center panel with editors; tracked separately so the
  // active child can be resolved back to its Terminal (it has no vim state).
  private readonly terminals = new Map<Widget, Terminal>();

  // The left dock: Source Control on top, file tree in the middle, agent list at
  // the bottom (nested vertical splits). Kept as fields so the pane-switching
  // commands can move focus between the docks.
  private readonly leftPanel: Panel;
  private readonly fileTree: FileTree;
  private readonly agentList: AgentList;
  private readonly gitPanel: GitPanel;
  // The agent-list dock (left column, below the file/git panel) and the vertical
  // paned holding both, kept as fields so a dock that collapsed when emptied can
  // be re-attached on demand (its reveal/focus path re-adds it).
  private readonly agentPanel: Panel;
  private leftPaned!: InstanceType<typeof Gtk.Paned>;
  // Tab handles for the file tree and Source Control (siblings in `leftPanel`),
  // so the focus commands can reveal either tab. Reassigned when a tab is re-added
  // after the left dock was collapsed (its last tab closed).
  private filesTab: PanelChild;
  private gitTab: PanelChild;
  // Commit-message editor tabs: the message file each is bound to, so closing the
  // tab can commit (git-style: write the message, save, close to commit).
  private readonly commitEditors = new Map<Widget, { repo: string; msgPath: string }>();
  // Maps an agent's root widget to its center tab handle, so the agent list can
  // reveal (select) the agent's tab on activation.
  private readonly agentChildren = new Map<Widget, PanelChild>();
  // Maps an editor's root widget to its center tab handle, so a location jump can
  // reveal an already-open file instead of opening a duplicate tab.
  private readonly editorChildren = new Map<Widget, PanelChild>();
  // Session modified-status registrations (editors, running agents), keyed by the
  // tab's root widget so the registration is disposed when the tab closes.
  private readonly participants = new Map<Widget, DisposableLike>();
  // Set once the user has confirmed an exit past unsaved work, so the re-entrant
  // close-request doesn't prompt again.
  private quitting = false;
  // The most recently focused agent — the default target for send-to-agent.
  private lastAgent: AgentTerminal | null = null;
  private readonly windowTitle: WindowTitle;
  // Header-bar unsaved marker: visible whenever any open editor is modified.
  private modifiedDot!: InstanceType<typeof Gtk.Label>;
  private readonly toastOverlay: ToastOverlay;
  private readonly overlay: InstanceType<typeof Gtk.Overlay>;
  private readonly window: ApplicationWindow;

  // Transient notification toasts, stacked in the bottom-right of the content
  // overlay (severity-colored). The log keeps the full history; these come and go.
  private readonly notificationToasts: NotificationToasts;

  // The top/bottom docks are empty by default. The notification log and the
  // Diagnostics list each have their own panel that docks into the bottom slot on
  // toggle (they don't share a panel); `bottomDock` tracks which is shown.
  private readonly workbench: Workbench;
  private readonly notificationLog: NotificationLog;
  private readonly notificationPanel: Panel;
  private readonly diagnosticsPanel: DiagnosticsPanel;
  private readonly diagnosticsDock: Panel;
  // The references results list (LSP find-references), its own bottom-dock panel.
  private readonly referencesList: LocationList;
  private readonly referencesDock: Panel;
  // The keybinding reference list, its own bottom-dock panel.
  private readonly keymapPanel: KeymapPanel;
  private readonly keymapDock: Panel;
  private bottomDock: BottomDock = null;

  // Git integration for the header-bar branch indicator.
  private readonly git: GitRepo;
  private readonly branchButton: BranchButton;
  // Header-bar links to the repository / PR / issue on GitHub.
  private readonly githubButtons: GithubButtons;
  // Last-seen upstream "behind" count, to fire the pull notification only on the
  // transition into being behind (not on every status poll while behind).
  private lastBehind = 0;

  // Watches the user config file and syncs edits into quilx.config; cancelled on
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

    this.windowTitle = new Adw.WindowTitle({ title: PROJECT_NAME });
    this.toastOverlay = new Adw.ToastOverlay();

    this.git = openGitRepo(process.cwd());
    this.branchButton = new BranchButton(this.git);
    this.githubButtons = new GithubButtons({ git: this.git, cwd: process.cwd() });

    this.center = new PanelGroup({
      onActiveChanged: () => this.onActiveTabChanged(),
      onClosed: (widget) => {
        // Closing an agent's tab after its process exited retires the agent for
        // good, so drop it from the agent list. While the process is still alive a
        // closed tab is just detached (the widget persists and can be reopened via
        // the agent list), so we keep it registered in that case.
        const terminal = this.terminals.get(widget);
        if (terminal instanceof AgentTerminal && terminal.exited) {
          quilx.agents.remove(terminal);
        }
        this.participants.get(widget)?.dispose();
        this.participants.delete(widget);
        this.editors.delete(widget);
        this.editorChildren.delete(widget);
        this.terminals.delete(widget);
        this.agentChildren.delete(widget);
        this.updateModifiedMarker(); // a closed editor no longer counts as unsaved
        // A closed commit-message tab finalizes the commit (if a message was saved).
        const commitInfo = this.commitEditors.get(widget);
        if (commitInfo) {
          this.commitEditors.delete(widget);
          this.finishCommit(commitInfo.repo, commitInfo.msgPath);
        }
        // The closed agent is gone from the active tab; recompute the highlight.
        this.updateAgentHighlight();
      },
      // No onEmpty/quit: emptying the last panel leaves it showing the empty
      // state. The app quits via the window close button or `app:quit`.
    });

    this.workbench = new Workbench();
    this.fileTree = new FileTree({
      rootPath: process.cwd(),
      onOpenFile: (path) => this.openFile(path),
      git: this.git,
    });
    // Source Control shares the top section with the file tree, as sibling tabs.
    this.gitPanel = new GitPanel({
      cwd: process.cwd(),
      git: this.git,
      onOpenFile: (path) => this.openFile(path),
      onCommit: () => this.startCommit(),
    });

    // The file tree and git panel are tabs in one panel; the tab handles are
    // kept so the focus commands can reveal (select) either tab. Tab icons are
    // Nerd Font glyphs embedded in the title (Adw.TabView renders a GIcon, not a
    // font glyph, so the icon goes in the text — see ui/icons.ts).
    // A dock panel collapses out of the layout when its last tab closes (rather
    // than showing the empty-state placeholder, which is reserved for the center
    // splittable area). The reveal/focus path for each dock re-attaches it.
    this.leftPanel = new Panel({ onEmpty: () => this.detachDock(this.leftPanel) });
    this.filesTab = this.leftPanel.add(this.fileTree.root, { title: `${fileIconGlyph('', true)}  Files` });
    this.gitTab = this.leftPanel.add(this.gitPanel.root, { title: `${Icons.git}  Git` });
    // add() selects each tab as it's added, so Git (added last) would win. Default to Files.
    this.filesTab.select();

    // The agent list sits below that tabbed panel in the left dock.
    this.agentList = new AgentList({
      onActivate: (agent) => this.showAgent(agent),
      onRestart: (agent) => this.restartAgent(agent),
      onClose: (agent) => this.closeAgent(agent),
      onRename: (agent) => this.renameAgentPrompt(agent),
      onOpenChanges: (agent) => this.openAgentChanges(agent),
    });
    this.agentPanel = new Panel({ onEmpty: () => this.detachDock(this.agentPanel) });
    this.agentPanel.add(this.agentList.root, { title: 'Agents' });

    this.leftPaned = new Gtk.Paned({ orientation: Gtk.Orientation.VERTICAL });
    this.leftPaned.setStartChild(this.leftPanel.root);
    this.leftPaned.setEndChild(this.agentPanel.root);
    this.leftPaned.setPosition(LEFT_SPLIT_POSITION);
    this.leftPaned.setResizeEndChild(false); // window resize grows the tabbed panel, not the agent list
    this.leftPaned.setShrinkEndChild(false);

    this.workbench.setLeft({ root: this.leftPaned });
    this.workbench.setCenter(this.center);

    // Session save/restore/autosave. The builders construct (but don't attach) a
    // tab during restore; PanelGroup.restoreLayout places them into the tree.
    this.sessionController = new SessionController({
      root: process.cwd(),
      center: this.center,
      fileTree: this.fileTree,
      serializeChild: (widget) => this.serializeChild(widget),
      createEditorTab: (path, cursor) => this.createEditorTab(path, cursor),
      createTerminalTab: (cwd) => this.createTerminalTab(cwd),
      getDocks: () => ({ notificationLog: this.bottomDock === 'notifications' }),
      applyDocks: (docks) => {
        if (docks.notificationLog && this.bottomDock !== 'notifications') this.toggleNotificationLog();
      },
    });

    // The notification log: built now (so it backfills history), wrapped in its
    // own Panel for its title tab, docked into the bottom slot only on toggle.
    this.notificationLog = new NotificationLog();
    // Each bottom dock is a single persistent view: closing its tab hides the
    // dock (its toggle brings it back) rather than destroying the page, so the
    // view's widget/state survive and reopening never shows an empty panel.
    this.notificationPanel = new Panel({
      onTabCloseRequest: () => this.hideBottomDock('notifications'),
    });
    this.notificationPanel.add(this.notificationLog.root, { title: 'Notifications' });
    // The Diagnostics list gets its own bottom-dock panel (separate from the log).
    this.diagnosticsPanel = new DiagnosticsPanel((target) =>
      this.openOrFocusFile(target.path, [target.line, target.character]),
    );
    this.diagnosticsDock = new Panel({
      onTabCloseRequest: () => this.hideBottomDock('diagnostics'),
    });
    this.diagnosticsDock.add(this.diagnosticsPanel.root, { title: 'Diagnostics' });
    // The references results list shares the shared LocationList component.
    this.referencesList = new LocationList({
      emptyText: 'No references',
      onActivate: (item) => this.openOrFocusFile(item.path, [item.line, item.character]),
    });
    this.referencesDock = new Panel({
      onTabCloseRequest: () => this.hideBottomDock('references'),
    });
    this.referencesDock.add(this.referencesList.root, { title: 'References' });
    // The keybinding reference list (every binding + its source).
    this.keymapPanel = new KeymapPanel();
    this.keymapDock = new Panel({
      onTabCloseRequest: () => this.hideBottomDock('keymap'),
    });
    this.keymapDock.add(this.keymapPanel.root, { title: 'Keybindings' });

    const toolbarView = new Adw.ToolbarView();
    toolbarView.addTopBar(this.buildHeaderBar());
    // Overlay host for transient widgets (e.g. the fuzzy file picker). It wraps
    // only the content, so the picker floats over the workbench below the header
    // bar rather than over the whole window.
    this.overlay = new Gtk.Overlay();
    this.overlay.setChild(this.workbench.root);
    // Notification toasts float in the bottom-right of the content area.
    this.notificationToasts = new NotificationToasts({ timeout: TOAST_TIMEOUT });
    this.overlay.addOverlay(this.notificationToasts.root);
    toolbarView.setContent(this.overlay);
    this.toastOverlay.setChild(toolbarView);

    // Bridge the notification manager to the toast stack. Only actionable
    // severities (warning/error/fatal) pop a transient toast; quieter levels
    // (trace/info/success) accumulate in the log only, so traces never interrupt.
    // The manager retains the full history for the log regardless.
    const TOAST_TYPES = new Set(['warning', 'error', 'fatal']);
    quilx.notifications.onDidAddNotification((n) => {
      const notification = n as Notification;
      if (TOAST_TYPES.has(notification.getType())) this.notificationToasts.show(notification);
    });

    this.applyChromeStyles();
    this.applyNotificationStyles();

    this.window = new Adw.ApplicationWindow({ application: app });
    this.window.setName('AppWindow'); // selector identity for command/keymap rules
    this.window.setDefaultSize(DEFAULT_WIDTH, DEFAULT_HEIGHT);
    this.window.setContent(this.toastOverlay);
    // Track the focused widget per panel tab so each panel can restore focus to
    // exactly where it was when it is re-activated (see focusMemory).
    this.window.on('notify::focus-widget', () => this.rememberFocus());

    // Publish the window on the global registry and start the keymap manager's
    // CAPTURE-phase key controller.
    quilx.window = this.window;
    // Expose file-opening app-wide (reveal-if-open by default — see openFile).
    quilx.workspace.setOpener((path, options) => {
      const editor = this.openFile(path);
      if (options?.cursor) editor.restoreCursor(options.cursor);
    });
    quilx.keymaps.initialize();
    // which-key hint: shows the continuations after a queued prefix (e.g. Space).
    this.whichKey = new WhichKey(this.overlay);
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
    this.registerCommandDescriptions();
    this.keymapWatcher = loadKeymaps();

    // Seed/load the user config and keep it in sync with on-disk edits. Done
    // before the first file opens so editors read live config values.
    this.configWatcher = loadConfig();

    // Configure language servers from `lsp.*` config (and on live edits).
    this.configureLsp();
    for (const key of ['lsp.enable', 'lsp.disabledLanguages', 'lsp.servers']) {
      quilx.config.onDidChange(key, () => this.configureLsp());
    }

    // Surface major LSP events (server start/ready/exit/failure) in the
    // notification log; trace-level so they stay out of the way.
    quilx.lsp.onNotice(({ level, message, detail }) => {
      const text = `LSP: ${message}`;
      const opts = detail ? { description: detail } : undefined;
      if (level === 'error') quilx.notifications.addError(text, opts);
      else if (level === 'warning') quilx.notifications.addWarning(text, opts);
      else if (level === 'info') quilx.notifications.addInfo(text, opts);
      else quilx.notifications.addTrace(text, opts);
    });

    // Watch the upstream sync state: when the branch falls behind its upstream
    // (e.g. a fetch brought in remote commits), offer to pull. Seed from the
    // current state so an already-behind repo doesn't toast on launch.
    this.lastBehind = this.git.getAheadBehind()?.behind ?? 0;
    this.git.onChange(() => this.checkUpstream());

    // Closing the window consults the session's modified participants first: an
    // editor with unsaved edits or a running agent blocks the quit behind a
    // confirm prompt (Save all / Discard / Cancel). Returning true keeps the
    // window open while the dialog decides; the dialog drives the actual quit.
    this.window.on('close-request', () => {
      if (this.quitting) return false;
      const modified = quilx.session.collectModified();
      if (modified.length === 0 || quilx.config.get('session.promptOnExitWhenModified') !== true) {
        this.teardownAndQuit();
        return false;
      }
      this.promptModifiedThenQuit(modified);
      return true;
    });
    this.window.present();

    // On a bare launch, restore the saved session if opted in; an explicit file
    // arg always suppresses restore. Fall back to opening the initial file.
    const restored =
      !explicitFile &&
      this.sessionController.shouldRestoreOnLaunch() &&
      this.sessionController.restore();
    if (!restored && initialFile) this.openFile(initialFile);
  }

  // --- Shutdown --------------------------------------------------------------

  // Dispose the window-level subscriptions and quit the application. Used by both
  // the clean-exit path and, after confirmation, the unsaved-work path.
  private teardownAndQuit() {
    this.sessionController.flush(); // final autosave before the workbench goes away
    this.branchButton.dispose();
    this.githubButtons.dispose();
    this.git.dispose();
    this.configWatcher.dispose();
    this.keymapWatcher.dispose();
    this.agentList.dispose();
    this.gitPanel.dispose();
    this.notificationLog.dispose();
    this.keymapPanel.dispose();
    this.onQuit();
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

  /** The TextEditor backing the active split's active tab, if any. */
  private get activeEditor(): TextEditor | null {
    const widget = this.center.activePanel.activeChild;
    return widget ? this.editors.get(widget) ?? null : null;
  }

  /**
   * Open `path` in a center tab and focus it — revealing an already-open editor
   * for the file (in any split) instead of opening a duplicate tab. This is the
   * single funnel every file-open goes through, so reveal-if-open is the default
   * everywhere; it's also exposed app-wide as `quilx.workspace.openFile`.
   */
  private openFile(path: string): TextEditor {
    const existing = [...this.editors.values()].find((editor) => editor.currentFile === path);
    if (existing) {
      this.editorChildren.get(existing.root)?.select();
      existing.focus();
      return existing;
    }
    const built = this.createEditorTab(path);
    const child = this.center.add(built.widget, {
      title: built.title,
      requireTabBar: built.requireTabBar,
    });
    built.onAttached?.(child);
    const editor = this.editors.get(built.widget)!;
    editor.focus();
    return editor;
  }

  // Construct + wire a file editor tab WITHOUT attaching it to a panel. Shared by
  // openFile (which adds it to the active panel) and session restore (which places
  // it into the rebuilt layout). The map is set before any attach so the first
  // onActiveChanged resolves the active editor.
  private createEditorTab(path: string, cursor?: [number, number]): RestoredChild {
    let child: PanelChild | null = null;
    const editor = new TextEditor({
      onToast: (message) => this.toast(message),
      onClose: () => child?.close(),
      git: this.git, // draws the git change bar in the gutter
    });
    this.editors.set(editor.root, editor);
    this.participants.set(editor.root, quilx.session.registerParticipant(editor));
    editor.loadFile(path);
    if (cursor) editor.restoreCursor(cursor);
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
        editor.onTitleChange(sync);
        editor.onModifiedChange(sync);
      },
    };
  }

  /** Open a new Terminal tab in the center panel and select it. */
  private openTerminal(): Terminal {
    const built = this.createTerminalTab(process.cwd());
    const child = this.center.add(built.widget, { title: built.title });
    built.onAttached?.(child);
    const terminal = this.terminals.get(built.widget)!;
    terminal.focus();
    return terminal;
  }

  // Construct + wire a terminal tab WITHOUT attaching it to a panel. Shared by
  // openTerminal and session restore (a restored terminal is a fresh shell in cwd).
  private createTerminalTab(cwd: string): RestoredChild {
    let child: PanelChild | null = null;
    const terminal = new Terminal({
      cwd,
      // The shell exiting (`exit`/Ctrl-D) closes its tab.
      onExit: () => child?.close(),
    });
    this.terminals.set(terminal.root, terminal);
    return {
      widget: terminal.root,
      title: terminal.title,
      onAttached: (attached) => {
        child = attached;
        terminal.onTitleChange(() => attached.setTitle(terminal.title));
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

  /** Launch (or resume) an agent and show it in a center tab. */
  private openAgent(options: { prompt?: string; resume?: AgentResume; title?: string } = {}): AgentTerminal {
    const agent = new AgentTerminal({
      cwd: process.cwd(),
      prompt: options.prompt,
      resume: options.resume,
      title: options.title,
      // No onExit: when the agent process exits the widget stays put (it prints a
      // "process exited" notice and flips to an exited status). After that, Enter
      // closes the agent's current tab.
      onCloseRequest: () => this.agentChildren.get(agent.root)?.close(),
    });
    // A running agent reports as modified, so it's consulted before exit.
    this.participants.set(agent.root, quilx.session.registerParticipant(agent));
    // One persistent tab binding that updates whichever tab currently shows the
    // agent (survives close/reopen, since it reads agentChildren on each change).
    // The tab carries a status glyph prefix + an attention highlight, so it
    // refreshes on status too.
    agent.onTitleChange(() => this.updateAgentTab(agent));
    // Notify when the agent needs attention while the user isn't looking at it.
    let previousStatus = agent.status;
    agent.onDidChangeStatus(() => {
      this.updateAgentTab(agent);
      this.notifyAgentAttention(agent, previousStatus, agent.status);
      previousStatus = agent.status;
    });
    // When the agent edits files, re-check git now instead of waiting for the poll,
    // so its changes surface in Source Control / the branch indicator promptly.
    agent.onDidChangeFiles(() => this.git.refresh());
    // The list highlight follows focus: recompute it whenever this terminal gains
    // or loses focus (the highlight is gated on the agent being focused + active —
    // see updateAgentHighlight).
    const focus = new Gtk.EventControllerFocus();
    focus.on('enter', () => {
      this.lastAgent = agent; // the "current" agent for send-to-agent
      this.updateAgentHighlight();
    });
    focus.on('leave', () => this.updateAgentHighlight());
    agent.root.addController(focus);
    this.showAgent(agent);
    return agent;
  }

  // The agent that send-to-agent targets: the active one, else the last focused,
  // else any still-running agent (skipping exited ones).
  private targetAgent(): AgentTerminal | null {
    for (const agent of [this.activeAgent, this.lastAgent]) {
      if (agent && !agent.exited) return agent;
    }
    return quilx.agents.getAgents().find((agent) => !agent.exited) ?? null;
  }

  // The editor context the send-to-agent commands push: the current selection, or
  // the active file's path (cwd-relative, trailing space). Empty when unavailable.
  private editorSelectionText(): string {
    return this.activeEditor?.getSelectedText() ?? '';
  }
  private editorFileText(): string {
    const file = this.activeEditor?.currentFile;
    return file ? `${Path.relative(process.cwd(), file)} ` : '';
  }

  // Feed `text` into `agent`'s prompt and reveal it.
  private deliverToAgent(agent: AgentTerminal, text: string): void {
    agent.feedChild(text);
    this.showAgent(agent);
  }

  // Send to the current agent (active → last-focused → any running).
  private sendToAgent(text: string): void {
    if (!text) return;
    const agent = this.targetAgent();
    if (!agent) {
      quilx.notifications.addWarning('No running agent to send to');
      return;
    }
    this.deliverToAgent(agent, text);
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

  // Resume a past conversation: pick one of the project's saved sessions (newest
  // first, excluding any currently live) and reopen it as `claude --resume <id>`.
  private resumeAgentPicker(): void {
    const live = new Set(quilx.agents.getAgents().map((a) => a.sessionId).filter(Boolean));
    const sessions = listAgentSessions(process.cwd()).filter((s) => !live.has(s.id));
    if (sessions.length === 0) {
      quilx.notifications.addInfo('No past conversations to resume');
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
        return {
          main: proseMarkup(item.text, positions, !session?.titled),
          detail: `<span face="Sans" line_height="${PROSE_LINE_HEIGHT}">${escapeMarkup(relativeTime(session?.modified ?? 0))}</span>`,
        };
      },
      onSelect: (id) => {
        const session = byId.get(id);
        this.openAgent({ resume: { sessionId: id }, title: session ? truncate(session.label, 40) : undefined });
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
  private updateAgentHighlight(): void {
    const activeChild = this.center.activePanel.activeChild;
    const terminal = activeChild ? this.terminals.get(activeChild) : undefined;
    const focused =
      activeChild && terminal instanceof AgentTerminal && this.isFocusWithin(activeChild)
        ? terminal
        : null;
    this.agentList.selectAgent(focused);
  }

  /** The agent backing the active center tab, if that tab hosts one. */
  private get activeAgent(): AgentTerminal | null {
    const widget = this.center.activePanel.activeChild;
    const terminal = widget ? this.terminals.get(widget) : undefined;
    return terminal instanceof AgentTerminal ? terminal : null;
  }

  /** Reveal the agent `delta` steps from the active one (wraps; first if none). */
  private focusAdjacentAgent(delta: number): void {
    const agents = quilx.agents.getAgents();
    if (agents.length === 0) return;
    const index = this.activeAgent ? agents.indexOf(this.activeAgent) : -1;
    const next = agents[(((index + delta) % agents.length) + agents.length) % agents.length];
    if (next) this.showAgent(next);
  }

  // Surface an attention-worthy status change as a notification — but only when
  // the user isn't already watching that agent (its tab isn't the active one).
  // Clicking the notification reveals the agent.
  private notifyAgentAttention(agent: AgentTerminal, previous: AgentStatus, current: AgentStatus): void {
    if (this.center.activePanel.activeChild === agent.root) return;
    const reveal = () => this.showAgent(agent);
    if (current === 'waiting') {
      quilx.notifications.addWarning(`${agent.title} needs your input`, { onDidClick: reveal });
    } else if (current === 'idle' && previous === 'working') {
      quilx.notifications.addInfo(`${agent.title} finished`, { onDidClick: reveal });
    }
  }

  // The agent a lifecycle command acts on: the active one, else the last focused.
  private currentAgent(): AgentTerminal | null {
    return this.activeAgent ?? this.lastAgent;
  }

  private restartCurrentAgent(): void {
    const agent = this.currentAgent();
    if (agent) this.restartAgent(agent);
  }

  private renameCurrentAgent(): void {
    const agent = this.currentAgent();
    if (agent) this.renameAgentPrompt(agent);
  }

  private closeCurrentAgent(): void {
    const agent = this.currentAgent();
    if (agent) this.closeAgent(agent);
  }

  private openChangesOfCurrentAgent(): void {
    const agent = this.currentAgent();
    if (agent) this.openAgentChanges(agent);
  }

  // Open the files an agent has edited this session: one opens directly, several
  // go through a picker (newest edits first, so its latest work is at the top).
  private openAgentChanges(agent: AgentTerminal): void {
    const files = agent.changedFiles;
    if (files.length === 0) {
      quilx.notifications.addInfo(`${agent.title} hasn't edited any files yet`);
      return;
    }
    if (files.length === 1) {
      this.openFile(files[0]);
      return;
    }
    const cwd = process.cwd();
    openPicker({
      host: this.overlay,
      placeholder: 'Open edited file…',
      items: files
        .slice()
        .reverse()
        .map((path) => {
          const text = Path.relative(cwd, path) || path;
          return { value: path, text, boostFrom: text.lastIndexOf('/') + 1 };
        }),
      onSelect: (path) => this.openFile(path),
    });
  }

  // Restart an agent: retire the old one and relaunch with the same cwd, resuming
  // its claude conversation (forking a still-live session so the original
  // transcript isn't clobbered). A pinned (renamed) title carries over.
  private restartAgent(agent: AgentTerminal): void {
    const resume = agent.sessionId ? { sessionId: agent.sessionId, fork: !agent.exited } : undefined;
    const title = agent.renamed ? agent.title : undefined;
    this.closeAgent(agent);
    this.openAgent({ resume, title });
  }

  // Close an agent for good: SIGTERM a live child, close its tab, and retire it
  // from the registry (idempotent — the exited-tab path already retires on close).
  private closeAgent(agent: AgentTerminal): void {
    if (!agent.exited) agent.kill();
    this.agentChildren.get(agent.root)?.close();
    quilx.agents.remove(agent);
  }

  // Prompt for a new display name (pinned over the CLI's reported title). Reuses
  // the picker as a prose text prompt: the action row renames on Enter.
  private renameAgentPrompt(agent: AgentTerminal): void {
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

  /**
   * Show `agent` in the center: select its existing tab, or — if it has none
   * (its tab was closed while the process kept running) — reattach its persisted
   * terminal widget to a fresh tab. Driven by openAgent and the agent list.
   */
  private showAgent(agent: AgentTerminal): void {
    // Agent activity brings the agent-list dock back if it had been collapsed.
    this.ensureAgentDock();
    // Gate on whether the widget is actually attached to a window, NOT on the
    // bookkeeping map. The map can desync — a spurious page-detached drops a live
    // tab's handle, a closed tab can leave a stale one — and trusting it caused
    // two failures: force-unparenting a still-live tab ("the agent closed for no
    // reason") and stranding the agent forever ("can't reopen by any mean").
    //
    // getRoot() is non-null for any live tab — even an unselected background one —
    // and null once the tab is closed, even though Adw leaves the widget parented
    // to a not-yet-finalized "zombie" page (so getParent() alone is unreliable).
    if (agent.root.getRoot() !== null) {
      this.agentChildren.get(agent.root)?.select(); // best effort; focus always lands
      agent.focus();
      return;
    }

    // Closed (or never shown): reattach to a fresh tab. Only now is unparenting
    // safe — getRoot() is null, so we're detaching from a dead zombie page rather
    // than ripping the widget out of a live tab.
    this.agentChildren.delete(agent.root);
    if (agent.root.getParent()) agent.root.unparent();

    this.terminals.set(agent.root, agent);
    const child = this.center.add(agent.root, { title: agentTabTitle(agent) });
    this.agentChildren.set(agent.root, child);
    this.updateAgentTab(agent);
    agent.focus();
  }

  // Refresh the agent's tab: its glyph-prefixed title, plus Adw's accent-coloured
  // `needs-attention` highlight while it's waiting for input (the tab title text
  // itself can't be colour-coded like the sidebar dot).
  private updateAgentTab(agent: AgentTerminal): void {
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
    // Tab add/close/switch and split changes all route through here — a good,
    // cheap signal to (debounced-)persist the session.
    this.sessionController?.scheduleAutosave();
  }

  // --- Header bar ------------------------------------------------------------

  private buildHeaderBar() {
    const header = new Adw.HeaderBar();
    header.setName('Header'); // CSS identity (#Header)
    header.packStart(this.branchButton.root);
    header.packStart(this.githubButtons.root);

    // Unsaved marker — a warning-colored dot shown next to the title when any open
    // editor is modified. Toggled via opacity (not visibility) so its slot is
    // always reserved and the title never shifts when it appears/disappears.
    this.modifiedDot = iconLabel(Icons.modified);
    this.modifiedDot.addCssClass('quilx-modified-dot');
    this.modifiedDot.setTooltipText('Unsaved changes');
    this.modifiedDot.setOpacity(0);
    this.modifiedDot.setCanTarget(false); // no stray tooltip while invisible

    const title = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    title.setHalign(Gtk.Align.CENTER);
    title.append(this.windowTitle);
    title.append(this.modifiedDot);
    header.setTitleWidget(title);
    return header;
  }

  /** The tab title for an editor, prefixed with the modified dot when unsaved. */
  private editorTabTitle(editor: TextEditor): string {
    return editor.isModified() ? `${Icons.modified} ${editor.title}` : editor.title;
  }

  /** Show the header-bar unsaved dot when any open editor has unsaved edits. */
  private updateModifiedMarker() {
    const modified = [...this.editors.values()].some((e) => e.isModified());
    this.modifiedDot.setOpacity(modified ? 1 : 0); // opacity keeps the title fixed
    this.modifiedDot.setCanTarget(modified);
  }

  // --- Theme chrome ----------------------------------------------------------

  // Paint the window chrome (header bar, file tree, status/command bar, panel tab
  // bars) plus popover surfaces (pickers) and selected entries with the theme's
  // colors. Installed as a single keyed, replaceable stylesheet so a future theme
  // switch can re-apply it. Themes without their own background (ui.bg unset)
  // leave the chrome to the system Adwaita styling.
  private applyChromeStyles() {
    const { bg, popoverBg, selectedBg } = theme.ui;
    if (!bg) {
      styles.remove('theme-chrome');
      return;
    }
    const border = theme.ui.border ?? 'rgba(0, 0, 0, 0.3)';
    // De-emphasized text for the empty-panel placeholder; fall back to a faded
    // foreground when the theme defines no explicit muted color.
    const muted = theme.ui.textMuted ?? `alpha(${theme.ui.fg}, 0.55)`;
    const rules = [
      `#Header {
        background: ${bg};
        box-shadow: none;
        border-bottom: 1px solid ${border};
      }`,
      `#FileTree, #FileTree listview { background-color: ${bg}; }`,
      `#NotificationLog, #NotificationLog list { background-color: ${bg}; }`,
      `#KeymapPanel, #KeymapPanel list { background-color: ${bg}; }`,
      `#LocationList, #LocationList list { background-color: ${bg}; }`,
      `#AgentList, #AgentList list { background-color: ${bg}; }`,
      `#GitPanel, #GitPanel list { background-color: ${bg}; }`,
      `#AgentRow { padding: 2px 12px; }`,
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
      `#PanelEmptyText.is-active, #PanelEmptyEmoticon.is-active { color: ${theme.ui.fg}; }`,
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
         #AgentList list row:selected { background-color: ${selectedBg}; }`,
      );
    }

    styles.set(rules.join('\n'), { key: 'theme-chrome' });
  }

  // Severity styling shared by the toasts and the log: each `notification-<type>`
  // colors its icon, and a toast card gets a matching left accent border, so the
  // severity is legible at a glance. Colors come from the theme's semantic keys
  // (fatal reuses error), with Adwaita-ish fallbacks; applied independently of
  // the chrome so it works even for themes that leave the chrome to Adwaita.
  private applyNotificationStyles() {
    const { info, success, warning, error, textMuted, popoverBg, border } = theme.ui;
    const colors: Record<string, string> = {
      trace: textMuted ?? '#9a9996',
      info: info ?? '#3584e4',
      success: success ?? '#2ec27e',
      warning: warning ?? '#e5a50a',
      error: error ?? '#e01b24',
      fatal: error ?? '#e01b24',
    };

    const rules = [
      `.NotificationToast {
        background-color: ${popoverBg ?? '@popover_bg_color'};
        border: 1px solid ${border ?? 'rgba(0, 0, 0, 0.3)'};
        border-radius: 12px;
        padding: 8px 10px;
        min-width: 260px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
      }`,
      // Clickable toasts (default action) get a hover tint.
      `.NotificationToast.activatable:hover { background-color: shade(${popoverBg ?? '@popover_bg_color'}, 1.15); }`,
    ];
    for (const [type, color] of Object.entries(colors)) {
      rules.push(`.notification-${type} .notification-icon { color: ${color}; }`);
      rules.push(`.NotificationToast.notification-${type} { border-left: 4px solid ${color}; }`);
      rules.push(`#NotificationRow.notification-${type} { border-left: 3px solid ${color}; padding-left: 6px; }`);
    }

    styles.set(rules.join('\n'), { key: 'notification-colors' });
  }

  // --- Commands --------------------------------------------------------------
  // Each group registers its command handlers; the key bindings that invoke them
  // live in the central keymap (src/keymaps/default.ts), loaded once at startup.

  // --- Pane switching (demo of the ported command/keymap managers) -----------

  // Vim-style window (split) management. Handlers only; bindings (ctrl-w v/s/c,
  // ctrl-w h/j/k/l, ctrl-w w) live in the central keymap under `#AppWindow`.
  //
  // Directional focus stays within the center; at the left edge `pane:focus-left`
  // falls back to the file-tree dock, and from the file tree `pane:focus-right`
  // returns to it.
  // Human descriptions for the command palette, keyed by command name (so
  // commands registered by other components — tabs, file tree, git panel — can be
  // described here too). Commands without an entry still show, name only.
  private registerCommandDescriptions() {
    quilx.commands.describe({
      // File / app
      'file:open': 'Open a file (dialog)',
      'file:find': 'Find a file by name',
      'file:save': 'Save the current file',
      'file:save-as': 'Save the current file as…',
      'app:quit': 'Quit quilx',
      'command-palette:toggle': 'Show all commands',
      // Panes / splits
      'pane:split-right': 'Split the pane to the right',
      'pane:split-down': 'Split the pane downward',
      'pane:close': 'Close the active pane',
      'pane:focus-left': 'Focus the pane to the left',
      'pane:focus-right': 'Focus the pane to the right',
      'pane:focus-up': 'Focus the pane above',
      'pane:focus-down': 'Focus the pane below',
      'pane:focus-next': 'Cycle to the next pane',
      'file-tree:focus': 'Focus the file tree',
      'git-panel:focus': 'Focus Source Control',
      'agent-list:focus': 'Focus the agent list',
      // Tabs
      'tab:next': 'Next tab',
      'tab:previous': 'Previous tab',
      'tab:go-to': 'Go to tab by index',
      'tab:go-to-last': 'Go to the last tab',
      'tab:move-backward': 'Move tab before',
      'tab:move-forward': 'Move tab after',
      'tab:close': 'Close the active tab',
      // File tree
      'core:down': 'Move down',
      'core:up': 'Move up',
      'core:left': 'Collapse / go to parent',
      'core:right': 'Expand / open',
      'tree:toggle-hidden-files': 'Toggle hidden files',
      'tree:toggle-untracked-files': 'Toggle untracked files',
      // Terminal / agents
      'terminal:new': 'Open a new terminal',
      'terminal:insert-mode': 'Terminal: enter insert mode (type into the child)',
      'terminal:normal-mode': 'Terminal: enter normal mode (app shortcuts)',
      'terminal:send-escape': 'Terminal: send Escape to the child',
      'agent:new': 'Start a new agent',
      'agent:switch': 'Switch to an agent',
      'agent:resume': 'Resume a past conversation…',
      'agent:continue': 'Continue the latest conversation',
      'agent:kill': 'Stop the active agent',
      'agent:restart': 'Restart the agent (resume its conversation)',
      'agent:rename': 'Rename the agent',
      'agent:close': 'Close the agent',
      'agent:open-changes': "Open the agent's edited files",
      'agent:focus-next': 'Focus the next agent',
      'agent:focus-prev': 'Focus the previous agent',
      'agent:send-selection': 'Send the selection to the current agent',
      'agent:send-file': 'Send the file path to the current agent',
      'agent:send-selection-to': 'Send the selection to an agent…',
      'agent:send-file-to': 'Send the file path to an agent…',
      'agent:send-selection-to-new': 'Send the selection to a new agent',
      'agent:send-file-to-new': 'Send the file path to a new agent',
      // Git
      'git:fetch': 'Fetch from the remote',
      'git:pull': 'Pull from upstream (fast-forward)',
      'git:push': 'Push to the remote',
      'git:switch-branch': 'Switch or create a branch…',
      'git:commit': 'Commit staged changes',
      'git:discard': 'Discard changes',
      'git:stage': 'Stage changes',
      'git:unstage': 'Unstage changes',
      // LSP
      'lsp:go-to-definition': 'Go to definition',
      'lsp:go-to-declaration': 'Go to declaration',
      'lsp:go-to-type-definition': 'Go to type definition',
      'lsp:go-to-implementation': 'Go to implementation',
      'lsp:find-references': 'Find references',
      'lsp:hover': 'Show hover (type / docs)',
      'lsp:toggle-diagnostics-panel': 'Toggle the Diagnostics panel',
      'keymap:show': 'Show all keybindings and their source',
      // Notifications / config / session
      'notifications:toggle-log': 'Toggle the notification log',
      'notifications:clear': 'Clear notifications',
      'config:open': 'Open preferences',
      'config:open-as-text': 'Open config.json',
      'session:save': 'Save the session',
      'session:restore': 'Restore the last session',
    });
  }

  private registerPaneCommands() {
    quilx.commands.add('#AppWindow', {
      'pane:split-right': () => this.splitPane('right'),
      'pane:split-down': () => this.splitPane('down'),
      'pane:close': () => this.closePane(),
      'pane:focus-left': () => this.navPane('left'),
      'pane:focus-right': () => this.navPane('right'),
      'pane:focus-up': () => this.navPane('up'),
      'pane:focus-down': () => this.navPane('down'),
      'pane:focus-next': () => this.focusNextPane(),
      // Reveal+focus a specific left-dock tab (re-adding it if the dock had been
      // collapsed away by closing its last tab).
      'file-tree:focus': () => this.revealLeftTab('files'),
      'git-panel:focus': () => this.revealLeftTab('git'),
      'agent-list:focus': () => this.agentList.focus(),
    });
  }

  // --- LSP commands ----------------------------------------------------------

  private registerLspCommands() {
    quilx.commands.add('#AppWindow', {
      'lsp:go-to-definition': () => void this.goto('definition'),
      'lsp:go-to-declaration': () => void this.goto('declaration'),
      'lsp:go-to-type-definition': () => void this.goto('typeDefinition'),
      'lsp:go-to-implementation': () => void this.goto('implementation'),
      'lsp:find-references': () => void this.findReferences(),
      'lsp:hover': () => void this.activeEditor?.hover(),
      'lsp:toggle-diagnostics-panel': () => this.toggleDiagnosticsPanel(),
      'keymap:show': () => this.toggleKeymapPanel(),
    });
  }

  // Toggle the Diagnostics panel in the bottom dock (replacing whatever was there).
  private toggleDiagnosticsPanel() {
    if (this.bottomDock === 'diagnostics') {
      this.setBottomDock(null);
    } else {
      this.setBottomDock('diagnostics');
      this.diagnosticsPanel.focus();
    }
  }

  // Toggle the keybinding reference list in the bottom dock.
  private toggleKeymapPanel() {
    if (this.bottomDock === 'keymap') {
      this.setBottomDock(null);
    } else {
      this.setBottomDock('keymap');
      this.keymapPanel.focus();
    }
  }

  // Dock the given panel into the bottom slot (or clear it), tracking which is shown.
  private setBottomDock(which: BottomDock) {
    this.bottomDock = which;
    const panel =
      which === 'notifications' ? this.notificationPanel :
      which === 'diagnostics' ? this.diagnosticsDock :
      which === 'references' ? this.referencesDock :
      which === 'keymap' ? this.keymapDock :
      null;
    this.workbench.setBottom(panel);
  }

  // Hide the named bottom dock if it's the one shown (its tab-close request), and
  // veto the underlying page close so the view persists for the next reopen.
  // Returns false so Panel keeps the page intact. The hide is deferred out of the
  // close-page signal emission, since it reparents the dock (an ancestor of the
  // emitting tab view) and that's unsafe to do mid-emission.
  private hideBottomDock(which: Exclude<BottomDock, null>): boolean {
    GLib.idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (this.bottomDock === which) this.setBottomDock(null);
      return GLib.SOURCE_REMOVE;
    });
    return false;
  }

  // Detach a collapsed left-column dock (its last tab was closed) from its
  // vertical paned, so the sibling reclaims the space instead of the dock showing
  // the empty-state placeholder. The reveal/focus path re-attaches and repopulates
  // it. Runs from onEmpty (page-detached, after the close completes), where the
  // reparent is safe and synchronous (no one-frame flash of the empty state).
  private detachDock(panel: Panel) {
    const widget = panel.root;
    if (this.leftPaned.getStartChild() === widget) this.leftPaned.setStartChild(null);
    else if (this.leftPaned.getEndChild() === widget) this.leftPaned.setEndChild(null);
  }

  // Reveal a left-dock tab, re-attaching the left panel and re-adding the tab if
  // they were collapsed away by closing the dock's last tab, then focus it. The
  // panel is re-attached (rooted) *before* any re-add: adding to a detached,
  // unrooted Adw.TabView yields a blank page.
  private revealLeftTab(which: 'files' | 'git') {
    if (this.leftPanel.root.getParent() !== this.leftPaned)
      this.leftPaned.setStartChild(this.leftPanel.root);
    const present = this.leftPanel.getChildren();
    if (which === 'files') {
      if (!present.includes(this.fileTree.root)) {
        if (this.fileTree.root.getParent()) this.fileTree.root.unparent(); // drop any closed page
        this.filesTab = this.leftPanel.add(this.fileTree.root, {
          title: `${fileIconGlyph('', true)}  Files`,
        });
      }
      this.filesTab.select();
      this.fileTree.focus();
    } else {
      if (!present.includes(this.gitPanel.root)) {
        if (this.gitPanel.root.getParent()) this.gitPanel.root.unparent();
        this.gitTab = this.leftPanel.add(this.gitPanel.root, { title: `${Icons.git}  Git` });
      }
      this.gitTab.select();
      this.gitPanel.focus();
    }
  }

  // Ensure the agent-list dock is attached and populated, so agent activity brings
  // the list back after it was collapsed. Re-attach (root) before re-adding the
  // tab so the add never targets a detached, unrooted tab view.
  private ensureAgentDock() {
    if (this.agentPanel.root.getParent() !== this.leftPaned)
      this.leftPaned.setEndChild(this.agentPanel.root);
    if (this.agentPanel.tabCount === 0) {
      if (this.agentList.root.getParent()) this.agentList.root.unparent();
      this.agentPanel.add(this.agentList.root, { title: 'Agents' });
    }
  }

  // Apply `lsp.*` config to the language-server manager.
  private configureLsp() {
    quilx.lsp.configure({
      enable: quilx.config.get('lsp.enable') as boolean,
      disabledLanguages: quilx.config.get('lsp.disabledLanguages') as string[],
      serverOverrides: quilx.config.get('lsp.servers') as LspConfig['serverOverrides'],
    });
  }

  // Resolve a navigation (definition/declaration/type-def/impl) at the active
  // editor's cursor and jump there, opening/revealing the target file.
  private async goto(kind: NavigationKind) {
    const editor = this.activeEditor;
    if (!editor) return;
    const target = await quilx.lsp.goto(editor.lsp, kind);
    if (!target) return;
    this.openOrFocusFile(target.path, [target.point.row, target.point.column]);
  }

  // Find references to the symbol at the cursor and list them in the bottom dock.
  private async findReferences() {
    const editor = this.activeEditor;
    if (!editor) return;
    const refs = await quilx.lsp.references(editor.lsp);
    if (refs.length === 0) {
      quilx.notifications.addInfo('No references found');
      return;
    }
    this.referencesList.setItems(
      refs.map((r) => ({
        path: r.path,
        line: r.point.row,
        character: r.point.column,
        location: `${Path.basename(r.path)}:${r.point.row + 1}`,
        text: r.lineText.trim(),
      })),
    );
    this.setBottomDock('references');
    this.referencesList.focus();
  }

  // Open `path` (revealing an already-open tab, since openFile dedupes) and place
  // the cursor. Used by location jumps (diagnostics, go-to-definition, search).
  private openOrFocusFile(path: string, cursor: [number, number]): void {
    this.openFile(path).restoreCursor(cursor);
  }

  // Focus whichever left-dock tab is currently active (file tree or Source
  // Control); reveal Files if the dock had been collapsed away.
  private focusSidePanel() {
    if (this.leftPanel.root.getParent() !== this.leftPaned || this.leftPanel.tabCount === 0) {
      this.revealLeftTab('files');
      return;
    }
    const child = this.leftPanel.activeChild;
    if (child && this.restoreTabFocus(child)) return;
    if (this.leftPanel.activeChild === this.gitPanel.root) this.gitPanel.focus();
    else this.fileTree.focus();
  }

  // Window-level file/edit operations, surfaced in the command palette and (for
  // most) on the space leader. Handlers only; bindings live in the central keymap.
  private registerWindowCommands() {
    quilx.commands.add('#AppWindow', {
      'file:open': () => this.openDialog(),
      'file:find': () => openFilePicker(this.overlay, (path) => this.openFile(path)),
      // Save commands only apply with an editor open.
      'file:save': { didDispatch: () => this.saveActive(), when: () => this.activeEditor !== null },
      'file:save-as': { didDispatch: () => this.saveAsDialog(), when: () => this.activeEditor !== null },
      'app:quit': () => this.onQuit(),
      'command-palette:toggle': () => openCommandPicker(this.overlay),
    });
  }

  // Terminal command: open a shell in a new center-panel tab. Handler only;
  // bound to `space t` in the central keymap.
  private registerTerminalCommands() {
    quilx.commands.add('#AppWindow', {
      'terminal:new': () => this.openTerminal(),
      'agent:new': () => this.openAgent(),
      'agent:switch': () => openAgentPicker(this.overlay, {
        onActivate: (agent) => this.showAgent(agent),
        onStart: (prompt) => this.openAgent({ prompt }),
      }),
      // Resume a past conversation: pick one (agent:resume) or pick up the latest
      // in this folder (agent:continue).
      'agent:resume': () => this.resumeAgentPicker(),
      'agent:continue': () => this.openAgent({ resume: { continue: true } }),
      // Lifecycle / navigation for the active agent. Kill SIGTERMs the child (the
      // widget lingers as exited); next/prev cycle through the running agents.
      'agent:kill': { didDispatch: () => this.activeAgent?.kill(), when: () => this.activeAgent !== null },
      // Lifecycle on the current agent (active, else last focused).
      'agent:restart': { didDispatch: () => this.restartCurrentAgent(), when: () => this.currentAgent() !== null },
      'agent:rename': { didDispatch: () => this.renameCurrentAgent(), when: () => this.currentAgent() !== null },
      'agent:close': { didDispatch: () => this.closeCurrentAgent(), when: () => this.currentAgent() !== null },
      'agent:open-changes': { didDispatch: () => this.openChangesOfCurrentAgent(), when: () => this.currentAgent() !== null },
      'agent:focus-next': () => this.focusAdjacentAgent(1),
      'agent:focus-prev': () => this.focusAdjacentAgent(-1),
      // Push the active editor's context into an agent's prompt — the current
      // agent (send-*), or one chosen from the picker (send-*-to).
      'agent:send-selection': () => this.sendToAgent(this.editorSelectionText()),
      'agent:send-file': () => this.sendToAgent(this.editorFileText()),
      'agent:send-selection-to': () => this.pickAgentAndSend(this.editorSelectionText()),
      'agent:send-file-to': () => this.pickAgentAndSend(this.editorFileText()),
      'agent:send-selection-to-new': () => this.composeNewAgent(this.editorSelectionText()),
      'agent:send-file-to-new': () => this.composeNewAgent(this.editorFileText()),
    });
  }

  // Git network operations. They run through GitRepo.run (Gio.Subprocess, non-
  // blocking), so the branch button's spinner reflects progress automatically;
  // the result is surfaced as a toast.
  private registerGitCommands() {
    quilx.commands.add('#AppWindow', {
      // Git commands only apply inside a repository (a resolvable branch).
      'git:fetch': { didDispatch: () => this.runGit(['fetch'], 'Fetch'), when: () => this.git.getBranch() !== null },
      'git:pull': { didDispatch: () => this.runGit(['pull', '--ff-only'], 'Pull'), when: () => this.git.getBranch() !== null },
      'git:push': { didDispatch: () => this.runGit(['push'], 'Push'), when: () => this.git.getBranch() !== null },
      'git:switch-branch': {
        didDispatch: () => openBranchPicker(this.overlay, process.cwd()),
        when: () => this.git.getBranch() !== null,
      },
    });
  }

  private runGit(args: string[], label: string) {
    this.git.run(args, (ok) => this.toast(ok ? `${label} succeeded` : `${label} failed`));
  }

  // Start a commit: open the message file (`.git/COMMIT_EDITMSG`) in an editor
  // tab. Closing the tab finalizes it — git-style: write the message, save, close
  // to commit (close without a saved message aborts). Reuses the normal editor.
  private startCommit() {
    const repo = repoRoot(process.cwd());
    if (!repo) return;
    const msgPath = commitMsgPath(repo);
    try {
      Fs.writeFileSync(msgPath, ''); // fresh, empty message
    } catch (error) {
      quilx.notifications.addError('Could not start commit', { detail: (error as Error).message });
      return;
    }
    const editor = this.openFile(msgPath);
    this.commitEditors.set(editor.root, { repo, msgPath });
  }

  // Finalize a commit when its message tab closes: commit the saved message, or
  // abort if it is empty. Routed through quilx.notifications.
  private finishCommit(repo: string, msgPath: string) {
    let message = '';
    try {
      message = Fs.readFileSync(msgPath, 'utf8');
    } catch {
      // file gone — nothing to commit
    }
    if (!message.trim()) {
      quilx.notifications.addInfo('Commit aborted (empty message)');
      return;
    }
    commit(repo, msgPath, (ok, _out, err) => {
      if (ok) quilx.notifications.addSuccess('Committed');
      else quilx.notifications.addError('Commit failed', { detail: err.trim() });
    });
  }

  // On the transition into being behind the upstream, post an info notification
  // offering to pull. Only fires when `behind` goes from 0 to positive, so a
  // repo that stays behind across status polls isn't re-toasted every tick.
  private checkUpstream() {
    const behind = this.git.getAheadBehind()?.behind ?? 0;
    if (behind > 0 && this.lastBehind === 0) {
      const commits = behind === 1 ? 'commit' : 'commits';
      quilx.notifications.addInfo(`Upstream is ahead by ${behind} ${commits}`, {
        detail: 'Your branch is behind its upstream — pull to update.',
        buttons: [{ text: 'Pull', onDidClick: () => this.runGit(['pull', '--ff-only'], 'Pull') }],
      });
    }
    this.lastBehind = behind;
  }

  // Notification log: show/hide the bottom-dock history, and clear it. Handlers
  // only; bindings (`space n`, and `c` while the log is focused) live in the
  // central keymap.
  private registerNotificationCommands() {
    quilx.commands.add('#AppWindow', {
      'notifications:toggle-log': () => this.toggleNotificationLog(),
      'notifications:clear': () => quilx.notifications.clear(),
      // Run the default action of the most recent notification that has one.
      'notifications:activate': () => quilx.notifications.activateLast(),
      // Demo commands (command palette only): post one notification of each
      // severity so the toast styling and the log can be exercised by hand.
      'notifications:test-info': () =>
        quilx.notifications.addInfo('Info notification', {
          detail: 'Click me to run a default action.',
          onDidClick: () => quilx.notifications.addSuccess('Default action ran'),
        }),
      'notifications:test-success': () =>
        quilx.notifications.addSuccess('Success notification', { detail: 'Something worked.' }),
      'notifications:test-warning': () =>
        quilx.notifications.addWarning('Warning notification', { detail: 'Something looks off.' }),
      'notifications:test-error': () =>
        quilx.notifications.addError('Error notification', { detail: 'Something failed.' }),
      'notifications:test-fatal': () =>
        quilx.notifications.addFatalError('Fatal notification', {
          detail: 'Something failed badly.',
          dismissable: true,
        }),
    });
  }

  // Settings: open the Adwaita preferences window over the config schema, or the
  // raw config.json in an editor tab. Handlers only; `config:open` is bound to
  // `space ,` in the central keymap.
  private registerConfigCommands() {
    quilx.commands.add('#AppWindow', {
      'config:open': () => openConfigEditor(this.window),
      'config:open-as-text': () => this.openFile(configPath()),
    });
  }

  // Session: save or restore the workspace session explicitly. Autosave covers the
  // common case; these are manual controls (command palette / keymap).
  private registerSessionCommands() {
    quilx.commands.add('#AppWindow', {
      'session:save': () => {
        this.sessionController.saveNow();
        this.toast('Session saved');
      },
      'session:restore': () => {
        if (!this.sessionController.restore()) this.toast('No saved session for this folder');
      },
    });
  }

  // Toggle the notification log in the bottom dock (replacing whatever was there).
  private toggleNotificationLog() {
    if (this.bottomDock === 'notifications') {
      this.setBottomDock(null);
    } else {
      this.setBottomDock('notifications');
      this.notificationLog.focus();
    }
  }

  // Split the active center pane, opening the active editor's file in the new
  // pane (vim-style) when there is one; otherwise leave it empty and focused.
  private splitPane(direction: Direction) {
    const path = this.activeEditor?.currentFile ?? null;
    this.center.split(direction); // the new empty pane becomes active
    if (path) this.openFile(path); // opens into (and focuses) the new pane
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
    this.center.closeActivePanel();
    this.focusActivePane();
  }

  // The dock panel (left / agent / bottom) that currently holds keyboard focus, or
  // null when focus is in the center or nowhere.
  private focusedDockPanel(): Panel | null {
    const docks: Panel[] = [this.leftPanel, this.agentPanel];
    if (this.bottomDock === 'notifications') docks.push(this.notificationPanel);
    else if (this.bottomDock === 'diagnostics') docks.push(this.diagnosticsDock);
    else if (this.bottomDock === 'references') docks.push(this.referencesDock);
    else if (this.bottomDock === 'keymap') docks.push(this.keymapDock);
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
      { root: this.leftPanel.root, focus: () => this.focusSidePanel() },
      {
        root: this.agentList.root,
        focus: () => {
          this.ensureAgentDock(); // restore the dock if it had been hidden
          this.focusDock(this.agentPanel, () => this.agentList.focus());
        },
      },
      { root: this.center.root, focus: () => this.focusActivePane() },
    ];
    if (this.bottomDock === 'notifications')
      zones.push({
        root: this.notificationPanel.root,
        focus: () => this.focusDock(this.notificationPanel, () => this.notificationLog.focus()),
      });
    else if (this.bottomDock === 'diagnostics')
      zones.push({
        root: this.diagnosticsDock.root,
        focus: () => this.focusDock(this.diagnosticsDock, () => this.diagnosticsPanel.focus()),
      });
    else if (this.bottomDock === 'references')
      zones.push({
        root: this.referencesDock.root,
        focus: () => this.focusDock(this.referencesDock, () => this.referencesList.focus()),
      });
    else if (this.bottomDock === 'keymap')
      zones.push({
        root: this.keymapDock.root,
        focus: () => this.focusDock(this.keymapDock, () => this.keymapPanel.focus()),
      });
    return zones;
  }

  // Directional focus: move between the center's splits first; on reaching the
  // center's edge (or from a dock section) move to the nearest zone in that
  // direction by on-screen geometry, so any dock arrangement works.
  private navPane(direction: Direction) {
    if (this.isFocusWithin(this.center.root) && this.center.focusDirection(direction)) {
      this.focusActivePane();
      return;
    }
    const zones = this.focusZones();
    // The origin zone is wherever focus sits; when focus isn't clearly in any zone
    // (e.g. an empty center pane that couldn't take keyboard focus) fall back to
    // the center so directional navigation still has somewhere to start from.
    const from =
      zones.find((z) => this.isFocusWithin(z.root)) ??
      zones.find((z) => z.root === this.center.root) ??
      null;
    // When leaving the center, navigate from the active leaf's rect (not the whole
    // center area) so the adjacent dock is found relative to where focus sits.
    const fromRect =
      from && from.root === this.center.root
        ? this.rectOf(this.center.activePanel.root)
        : from
          ? this.rectOf(from.root)
          : null;
    if (!fromRect) return;
    this.nearestZone(zones, from, fromRect, direction)?.focus();
  }

  // Cycle focus to the next zone (`ctrl-w w`): within the center, cycle its
  // splits; otherwise advance to the next zone in order, wrapping around.
  private focusNextPane() {
    if (this.isFocusWithin(this.center.root) && this.center.focusNext()) {
      this.focusActivePane();
      return;
    }
    const zones = this.focusZones();
    const i = zones.findIndex((z) => this.isFocusWithin(z.root));
    // Default the starting point to the center when focus isn't in any zone, so
    // the cycle still advances from a sensible place.
    const start = i >= 0 ? i : zones.findIndex((z) => z.root === this.center.root);
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
    const widget = this.center.activePanel.activeChild;
    if (!widget) {
      this.center.activePanel.focusEmptyState();
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
    if (child && child !== focus) this.focusMemory.set(child, focus);
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
    const editor = this.activeEditor;
    if (!editor) return;
    if (editor.currentFile) editor.save();
    else this.saveAsDialog();
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
    quilx.notifications.addInfo(message);
  }
}

// Overlap length of two 1-D segments [a0, a0+aLen] and [b0, b0+bLen]; <= 0 means
// they don't overlap. Used by directional pane navigation to require cross-axis
// alignment between zones.
function span(a0: number, aLen: number, b0: number, bLen: number): number {
  return Math.min(a0 + aLen, b0 + bLen) - Math.max(a0, b0);
}

// The same indicators the AgentList uses: nf-md-cog-sync while working, else a
// round dot. Adw tab titles are plain text (no markup, no colour), so the dot
// can't be colour-coded like the sidebar — the waiting state instead drives Adw's
// native `needs-attention` tab highlight (see updateAgentTab).
const AGENT_WORKING_GLYPH = String.fromCodePoint(0xf1978);
const AGENT_STATUS_DOT = '●';

/** An agent tab's title: the AgentList status glyph prefixed to the agent's name. */
function agentTabTitle(agent: AgentTerminal): string {
  const glyph = agent.status === 'working' ? AGENT_WORKING_GLYPH : AGENT_STATUS_DOT;
  return `${glyph} ${agent.title}`;
}

// A compact "time ago" for a past timestamp (epoch ms): 12s / 5m / 3h / 2d / 4w.
function relativeTime(epochMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  const units: [number, string][] = [
    [604800, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm'], [1, 's'],
  ];
  for (const [size, suffix] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${suffix} ago`;
  }
  return 'just now';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

