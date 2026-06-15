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
import { LayoutList } from './LayoutList.ts';
import { GitPanel } from './GitPanel.ts';
import { fileIconGlyph } from './fileIcons.ts';
import { Icons, iconLabel } from './icons.ts';
import { BranchButton } from './BranchButton.ts';
import { GithubButtons } from './GithubButtons.ts';
import { openGitRepo, type GitRepo } from '../git.ts';
import { git, repoRoot, commitMsgPath, commit, stashPush } from '../git/cli.ts';
import { computeDiff } from '../util/DiffModel.ts';
import { DiffViewer } from './TextEditor/DiffViewer.ts';
import { Layout } from './Layout.ts';
import { openFilePicker } from './FilePicker.ts';
import { openCommandPicker } from './CommandPicker.ts';
import { WhichKey } from './WhichKey.ts';
import { openAgentPicker } from './AgentPicker.ts';
import {
  openBranchPicker,
  openDeleteBranchPicker,
  openMergeBranchPicker,
  openRenameBranchPicker,
} from './BranchPicker.ts';
import { openStashPicker } from './StashPicker.ts';
import { openGithubFailedCIPicker } from './GithubFailedCIPicker.ts';
import { openGithubPrPicker, checkoutGithubPrPicker } from './GithubPrPicker.ts';
import { openGithubIssuePicker } from './GithubIssuePicker.ts';
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
import { type NavigationKind, type LspConfig, type LspDocument } from '../lsp/LspManager.ts';
import { normalizeWorkspaceEdit, applyTextEdits } from '../lsp/workspaceEdit.ts';
import { uriToPath, type PositionEncoding } from '../lsp/position.ts';
import type { WorkspaceEdit, CodeAction, Command } from 'vscode-languageserver-protocol';
import { NotificationToasts } from './NotificationToasts.ts';
import { loadKeymaps } from '../keymaps/load.ts';
import { loadConfig, configPath } from '../config/load.ts';
import { type DisposableLike } from '../util/eventKit.ts';
import { styles, addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';

// The unsaved/modified marker (a small dot) — warning-colored in the header bar.
addStyles(`.quilx-modified-dot { color: ${theme.ui.warning ?? '#e5a50a'}; }`);

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

// The header-bar title is the project name: the last path component of the cwd.
const PROJECT_NAME = Path.basename(process.cwd());
const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 950;
const TOAST_TIMEOUT = 15;
// Shared `replaceKey` for the upstream-pull lifecycle, so the "behind" prompt,
// the "pulling…" spinner, and the result all transform one toast in place.
const PULL_NOTICE_KEY = 'git:pull';
// Expanded width (px) of the layout sidebar — the full-height column at the very
// left of the window, outside (left of) the header bar.
const LAYOUT_SIDEBAR_WIDTH = 240;
// Collapsed sidebar width (icons only) — toggled by the robot button.
const LAYOUT_SIDEBAR_COLLAPSED_WIDTH = 48;

type Widget = InstanceType<typeof Gtk.Widget>;
// What currently occupies the (otherwise empty) bottom dock.
type BottomDock = 'notifications' | 'diagnostics' | 'references' | 'keymap' | null;

// One person's layout and every widget filling its dock slots. Built per person by
// `buildLayout`; the active bundle's widgets are mirrored onto the `this.*` fields
// (applyBundle) so the rest of AppWindow keeps addressing "the active layout". The
// mutable fields (filesTab/gitTab/bottomDock) are written back on switch-out
// (saveActiveBundle), since reveal/toggle reassign them while a layout is active.
interface LayoutBundle {
  owner: 'user' | AgentTerminal;
  layout: Layout<'user' | AgentTerminal>;
  center: PanelGroup;
  fileTree: FileTree;
  gitPanel: GitPanel;
  leftPanel: Panel;
  filesTab: PanelChild;
  gitTab: PanelChild;
  notificationLog: NotificationLog;
  notificationPanel: Panel;
  diagnosticsPanel: DiagnosticsPanel;
  diagnosticsDock: Panel;
  referencesList: LocationList;
  referencesDock: Panel;
  keymapPanel: KeymapPanel;
  keymapDock: Panel;
  bottomDock: BottomDock;
}

export class AppWindow {
  private readonly app: Application;
  private readonly onQuit: () => void;

  // Per-tab focus memory: the widget that last held keyboard focus inside each
  // panel-tab child, so re-activating a panel restores focus to the exact same
  // widget (e.g. an editor's search bar, not just the editor view). Keyed by the
  // tab's content widget (the `.is-panel-child`); a WeakMap so closed tabs drop.
  private readonly focusMemory = new WeakMap<Widget, Widget>();

  // The splittable center of the *active* layout: a tree of editor groups. Each
  // tab hosts one TextEditor, mapped from its root widget so the active child can
  // be resolved back to its editor regardless of which split it lives in.
  // Reassigned when the active layout changes (see activateLayout).
  private center!: PanelGroup;
  private activeOwner: 'user' | AgentTerminal = 'user';
  private readonly editors = new Map<Widget, TextEditor>();
  // Terminal tabs share the center panel with editors; tracked separately so the
  // active child can be resolved back to its Terminal (it has no vim state).
  private readonly terminals = new Map<Widget, Terminal>();

  // The left dock: Source Control on top, file tree in the middle, agent list at
  // the bottom (nested vertical splits). Kept as fields so the pane-switching
  // commands can move focus between the docks.
  private leftPanel!: Panel;
  private fileTree!: FileTree;
  private readonly layoutList: LayoutList;
  // The top-level split whose start child is the layout sidebar; its position is
  // the sidebar width (toggled between expanded / collapsed by the robot button).
  private sidebarSplit!: InstanceType<typeof Gtk.Paned>;
  private gitPanel!: GitPanel;
  // Tab handles for the file tree and Source Control (siblings in `leftPanel`),
  // so the focus commands can reveal either tab. Reassigned when a tab is re-added
  // after the left dock was collapsed (its last tab closed).
  private filesTab!: PanelChild;
  private gitTab!: PanelChild;
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

  // Each person owns a Layout (dock frame) plus the full set of widgets that fill
  // its slots — see LayoutBundle. Nothing is shared or reparented across layouts;
  // switching person swaps the whole Layout and reassigns the `this.*` fields below
  // to that person's instances (see buildLayout / applyBundle / activateLayout).
  // `layout` / `bottomDock` etc. always refer to the *active* layout's widgets.
  private layout!: Layout<'user' | AgentTerminal>;
  private activeBundle!: LayoutBundle;
  private readonly bundles = new Map<'user' | AgentTerminal, LayoutBundle>();
  // The top/bottom docks are empty by default. The notification log and the
  // Diagnostics list each have their own panel that docks into the bottom slot on
  // toggle (they don't share a panel); `bottomDock` tracks which is shown.
  private notificationLog!: NotificationLog;
  private notificationPanel!: Panel;
  private diagnosticsPanel!: DiagnosticsPanel;
  private diagnosticsDock!: Panel;
  // The references results list (LSP find-references), its own bottom-dock panel.
  private referencesList!: LocationList;
  private referencesDock!: Panel;
  // The keybinding reference list, its own bottom-dock panel.
  private keymapPanel!: KeymapPanel;
  private keymapDock!: Panel;
  private bottomDock: BottomDock = null;

  // Git integration for the header-bar branch indicator.
  private readonly git: GitRepo;
  private readonly branchButton: BranchButton;
  // Header-bar links to the repository / PR / issue on GitHub.
  private readonly githubButtons: GithubButtons;
  // Last-seen upstream "behind" count, to fire the pull notification only on the
  // transition into being behind (not on every status poll while behind).
  private lastBehind = 0;
  // Background `git fetch` timer (a GLib timeout id; 0 when disabled).
  private autoFetchTimer = 0;

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
    this.branchButton = new BranchButton(this.git, () => openBranchPicker(this.overlay, process.cwd()));
    this.githubButtons = new GithubButtons({ git: this.git, cwd: process.cwd() });

    // Build the user's layout — its own center + Files/Source-Control + bottom
    // docks — and make it the active one. Agents get their own (openAgent); no
    // widget is shared across layouts, so a switch reparents nothing.
    const userBundle = this.buildLayout('user');
    this.applyBundle(userBundle); // mirrors its widgets onto this.layout/center/fileTree/…

    // The layout list lives in its own full-height sidebar at the very left of the
    // window (built into the top-level split below), not in the workbench dock.
    this.layoutList = new LayoutList({
      onActivate: (agent) => this.showAgent(agent),
      onActivateUser: () => this.activateOwner('user'), // the user row → user layout
      onToggleCollapsed: (collapsed) =>
        this.sidebarSplit.setPosition(collapsed ? LAYOUT_SIDEBAR_COLLAPSED_WIDTH : LAYOUT_SIDEBAR_WIDTH),
      onRestart: (agent) => this.restartAgent(agent),
      onClose: (agent) => this.closeAgent(agent),
      onRename: (agent) => this.renameAgentPrompt(agent),
      onOpenChanges: (agent) => this.openAgentChanges(agent),
    });

    // Session save/restore/autosave is anchored to the user layout (its center +
    // file tree). The builders construct (but don't attach) a tab during restore;
    // PanelGroup.restoreLayout places them into the tree.
    this.sessionController = new SessionController({
      root: process.cwd(),
      center: userBundle.center,
      fileTree: userBundle.fileTree,
      serializeChild: (widget) => this.serializeChild(widget),
      createEditorTab: (path, cursor) => this.createEditorTab(path, cursor),
      createTerminalTab: (cwd) => this.createTerminalTab(cwd),
      getDocks: () => ({ notificationLog: this.bottomDock === 'notifications' }),
      applyDocks: (docks) => {
        if (docks.notificationLog && this.bottomDock !== 'notifications') this.toggleNotificationLog();
      },
    });

    const toolbarView = new Adw.ToolbarView();
    toolbarView.addTopBar(this.buildHeaderBar());
    // Overlay host for transient widgets (e.g. the fuzzy file picker). It wraps
    // only the content, so the picker floats over the workbench below the header
    // bar rather than over the whole window.
    this.overlay = new Gtk.Overlay();
    this.overlay.setChild(this.layout.root);
    // Notification toasts float in the bottom-right of the content area.
    this.notificationToasts = new NotificationToasts({ timeout: TOAST_TIMEOUT });
    this.overlay.addOverlay(this.notificationToasts.root);
    toolbarView.setContent(this.overlay);
    this.toastOverlay.setChild(toolbarView);

    // Layout sidebar: a full-height column at the very left of the window, *outside*
    // the header bar. A top-level horizontal paned splits it from everything else
    // (the header bar + workbench, wrapped by the toast overlay), so it spans from
    // the window's top edge to its bottom; its width (the split position) is toggled
    // between expanded / collapsed by the robot button.
    const layoutSidebar = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    layoutSidebar.setName('LayoutSidebar'); // selector identity for CSS
    this.layoutList.root.setHexpand(true);
    this.layoutList.root.setVexpand(true); // fill the sidebar (height + width)
    layoutSidebar.append(this.layoutList.root);
    this.sidebarSplit = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
    this.sidebarSplit.setStartChild(layoutSidebar);
    this.sidebarSplit.setEndChild(this.toastOverlay);
    this.sidebarSplit.setPosition(LAYOUT_SIDEBAR_WIDTH);
    this.sidebarSplit.setResizeStartChild(false); // window resize grows the content, not the sidebar
    this.sidebarSplit.setShrinkStartChild(false);

    // Bridge the notification manager to the toast stack. Only actionable
    // User-facing severities (info/success/warning/error/fatal) pop a transient
    // toast; only `trace` (the debug level) is log-only, so traces never interrupt.
    // The manager retains the full history for the log regardless.
    const TOAST_TYPES = new Set(['info', 'success', 'warning', 'error', 'fatal']);
    quilx.notifications.onDidAddNotification((n) => {
      const notification = n as Notification;
      if (TOAST_TYPES.has(notification.getType())) this.notificationToasts.show(notification);
    });

    this.applyChromeStyles();
    this.applyNotificationStyles();

    this.window = new Adw.ApplicationWindow({ application: app });
    this.window.setName('AppWindow'); // selector identity for command/keymap rules
    this.window.setDefaultSize(DEFAULT_WIDTH, DEFAULT_HEIGHT);
    this.window.setContent(this.sidebarSplit);
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
    for (const key of ['lsp.enable', 'lsp.disabledLanguages', 'lsp.servers', 'lsp.autoInstall']) {
      quilx.config.onDidChange(key, () => this.configureLsp());
    }

    // Surface major LSP events (server start/ready/exit/failure) in the
    // notification log; trace-level so they stay out of the way.
    quilx.lsp.onNotice(({ level, message, detail, action, replaceKey, sticky, loading }) => {
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
      if (level === 'error') quilx.notifications.addError(text, opts);
      else if (level === 'warning') quilx.notifications.addWarning(text, opts);
      else if (level === 'success') quilx.notifications.addSuccess(text, opts);
      else if (level === 'info') quilx.notifications.addInfo(text, opts);
      else quilx.notifications.addTrace(text, opts);
    });

    // Watch the upstream sync state: when the branch falls behind its upstream
    // (e.g. a fetch brought in remote commits), offer to pull. Seed from the
    // current state so an already-behind repo doesn't toast on launch.
    this.lastBehind = this.git.getAheadBehind()?.behind ?? 0;
    this.git.onChange(() => this.checkUpstream());
    this.startAutoFetch();

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
    if (this.autoFetchTimer) GLib.sourceRemove(this.autoFetchTimer);
    this.branchButton.dispose();
    this.githubButtons.dispose();
    this.git.dispose();
    this.configWatcher.dispose();
    this.keymapWatcher.dispose();
    this.layoutList.dispose();
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
    });
    // When the agent process exits, the agent and its layout linger (the terminal
    // shows an "exited" notice); the user restarts or closes it from the layout list.
    // The agent gets its own layout: a fresh `Layout` (its own center + Files/Git +
    // bottom docks) whose center opens the terminal as the initial tab (the user can
    // open files / split inside it too). Activate (show) the layout *before* adding
    // the terminal — adding a tab to a detached, unrooted Adw.TabView yields a blank
    // page.
    const bundle = this.buildLayout(agent);
    this.activateLayout(bundle.layout);
    this.terminals.set(agent.root, agent);
    const child = bundle.center.add(agent.root, { title: agentTabTitle(agent) });
    this.agentChildren.set(agent.root, child);
    // A running agent reports as modified, so it's consulted before exit.
    this.participants.set(agent.root, quilx.session.registerParticipant(agent));
    // The agent's tab carries a status glyph prefix + attention highlight.
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
    // Track the last-focused agent (the default target for send-to-agent).
    const focus = new Gtk.EventControllerFocus();
    focus.on('enter', () => { this.lastAgent = agent; });
    agent.root.addController(focus);
    agent.focus(); // the layout is already active (above); focus the terminal
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
  // The sidebar selection follows the active layout's owner (which person you're
  // viewing), not focus.
  private updateAgentHighlight(): void {
    this.layoutList.selectAgent(this.activeOwner === 'user' ? null : this.activeOwner);
  }

  /** The agent whose layout is active, if any. */
  private get activeAgent(): AgentTerminal | null {
    return this.activeOwner === 'user' ? null : this.activeOwner;
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
      quilx.notifications.addTrace(`${agent.title} finished`, { onDidClick: reveal });
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

  // Close an agent for good: SIGTERM a live child, drop its layout (returning to
  // the user's layout if it was active), and retire it from the registry.
  private closeAgent(agent: AgentTerminal): void {
    if (!agent.exited) agent.kill();
    if (this.activeOwner === agent) this.activateOwner('user'); // swap away first
    this.bundles.delete(agent); // its layout (center + Files/Git + bottom + tabs) goes
    this.participants.get(agent.root)?.dispose();
    this.participants.delete(agent.root);
    this.agentChildren.delete(agent.root);
    this.terminals.delete(agent.root);
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

  // Build a fresh center (one person's splittable editor area). Every center
  // shares the same callbacks — they operate on the shared per-widget maps, and
  // only the *active* center fires interactive events (the others are detached).
  private makeCenter(): PanelGroup {
    return new PanelGroup({
      onActiveChanged: () => this.onActiveTabChanged(),
      onClosed: (widget) => {
        // Closing an agent's tab after its process exited retires the agent.
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
      },
    });
  }

  /**
   * Build a person's layout: a `Layout` plus its own center, Files/Source-Control,
   * and bottom-dock widgets. Nothing here is shared with other layouts, so a switch
   * never reparents — it only swaps the visible Layout and re-points the `this.*`
   * fields (applyBundle). Registers and returns the bundle.
   */
  private buildLayout(owner: 'user' | AgentTerminal): LayoutBundle {
    const layout = new Layout<'user' | AgentTerminal>();
    layout.owner = owner;
    const center = this.makeCenter();
    const fileTree = new FileTree({
      rootPath: process.cwd(),
      onOpenFile: (path) => this.openFile(path),
      git: this.git,
    });
    // Source Control shares the top section with the file tree, as sibling tabs.
    const gitPanel = new GitPanel({
      cwd: process.cwd(),
      git: this.git,
      onOpenFile: (path) => this.openFile(path),
      onCommit: () => this.startCommit(),
    });
    // The file tree and git panel are sibling tabs in one panel (Nerd Font glyphs
    // embedded in the title — Adw.TabView renders a GIcon, not a font glyph). A dock
    // panel collapses out of the layout when its last tab closes (the reveal/focus
    // path re-attaches it); the closure captures this bundle's own `leftPanel`.
    const leftPanel = new Panel({ onEmpty: () => this.detachDock(leftPanel) });
    const filesTab = leftPanel.add(fileTree.root, { title: `${fileIconGlyph('', true)}  Files` });
    const gitTab = leftPanel.add(gitPanel.root, { title: `${Icons.git}  Git` });
    filesTab.select(); // add() selects each tab as added; default to Files, not Git

    // Each bottom dock is a single persistent view: closing its tab hides the dock
    // (its toggle brings it back) rather than destroying the page, so its widget/
    // state survive and reopening never shows an empty panel. hideBottomDock acts on
    // the active layout — the only one whose tab can be interactively closed.
    const notificationLog = new NotificationLog();
    const notificationPanel = new Panel({ onTabCloseRequest: () => this.hideBottomDock('notifications') });
    notificationPanel.add(notificationLog.root, { title: 'Notifications' });
    const diagnosticsPanel = new DiagnosticsPanel((target) =>
      this.openOrFocusFile(target.path, [target.line, target.character]),
    );
    const diagnosticsDock = new Panel({ onTabCloseRequest: () => this.hideBottomDock('diagnostics') });
    diagnosticsDock.add(diagnosticsPanel.root, { title: 'Diagnostics' });
    const referencesList = new LocationList({
      emptyText: 'No references',
      onActivate: (item) => this.openOrFocusFile(item.path, [item.line, item.character]),
    });
    const referencesDock = new Panel({ onTabCloseRequest: () => this.hideBottomDock('references') });
    referencesDock.add(referencesList.root, { title: 'References' });
    const keymapPanel = new KeymapPanel();
    const keymapDock = new Panel({ onTabCloseRequest: () => this.hideBottomDock('keymap') });
    keymapDock.add(keymapPanel.root, { title: 'Keybindings' });

    // The center is splittable. The user's layout shows Files/Source-Control in the
    // RIGHT dock; an agent's layout opens *without* it (just the terminal) — the
    // panel is still built so reveal-on-demand (file-tree:focus / git commands) and
    // the active-layout `this.*` fields keep working. The bottom slot is empty until
    // a dock is toggled (per-layout); the left dock stays empty.
    if (owner === 'user') layout.setRight({ root: leftPanel.root });
    layout.setCenter(center);

    const bundle: LayoutBundle = {
      owner, layout, center, fileTree, gitPanel, leftPanel, filesTab, gitTab,
      notificationLog, notificationPanel, diagnosticsPanel, diagnosticsDock,
      referencesList, referencesDock, keymapPanel, keymapDock, bottomDock: null,
    };
    this.bundles.set(owner, bundle);
    return bundle;
  }

  // Mirror a bundle's widgets onto the `this.*` fields so the rest of AppWindow
  // addresses "the active layout" without knowing which person owns it.
  private applyBundle(bundle: LayoutBundle): void {
    this.activeBundle = bundle;
    this.activeOwner = bundle.owner;
    this.layout = bundle.layout;
    this.center = bundle.center;
    this.fileTree = bundle.fileTree;
    this.gitPanel = bundle.gitPanel;
    this.leftPanel = bundle.leftPanel;
    this.filesTab = bundle.filesTab;
    this.gitTab = bundle.gitTab;
    this.notificationLog = bundle.notificationLog;
    this.notificationPanel = bundle.notificationPanel;
    this.diagnosticsPanel = bundle.diagnosticsPanel;
    this.diagnosticsDock = bundle.diagnosticsDock;
    this.referencesList = bundle.referencesList;
    this.referencesDock = bundle.referencesDock;
    this.keymapPanel = bundle.keymapPanel;
    this.keymapDock = bundle.keymapDock;
    this.bottomDock = bundle.bottomDock;
  }

  // Write the mutable per-layout state back into the active bundle before switching
  // away (reveal/toggle reassign filesTab/gitTab/bottomDock while a layout is live).
  private saveActiveBundle(): void {
    if (!this.activeBundle) return;
    this.activeBundle.filesTab = this.filesTab;
    this.activeBundle.gitTab = this.gitTab;
    this.activeBundle.bottomDock = this.bottomDock;
  }

  /** Activate the layout owned by `owner` (resolves to its `Layout`). */
  private activateOwner(owner: 'user' | AgentTerminal): void {
    const bundle = this.bundles.get(owner);
    if (bundle) this.activateLayout(bundle.layout);
  }

  // Step the active layout by `step` (−1 / +1) through the layout-list order
  // ([user, …agents]), wrapping around. No-op when the user is the only person.
  private cycleLayout(step: number): void {
    const owners: Array<'user' | AgentTerminal> = ['user', ...quilx.agents.getAgents()];
    if (owners.length < 2) return;
    const current = owners.indexOf(this.activeOwner);
    const next = (current + step + owners.length) % owners.length;
    this.activateOwner(owners[next]);
  }

  /**
   * Activate `layout`: show it and re-point the `this.*` fields to its widgets
   * (applyBundle). Nothing is reparented — every slot already belongs to this
   * layout; the previously-active layout is detached but alive (its tabs/terminal/
   * state persist). Driven by the LayoutList / openAgent.
   */
  private activateLayout(layout: Layout<'user' | AgentTerminal>): void {
    const bundle = this.bundles.get(layout.owner);
    if (!bundle) return;
    this.saveActiveBundle();
    this.applyBundle(bundle);
    this.overlay.setChild(layout.root); // show this layout
    this.layoutList.selectAgent(bundle.owner === 'user' ? null : bundle.owner);
    this.focusActivePane();
  }

  // The Panel currently shown in the bottom dock (`this.bottomDock`), or null.
  private bottomDockPanel(): { root: Widget } | null {
    switch (this.bottomDock) {
      case 'notifications': return this.notificationPanel;
      case 'diagnostics': return this.diagnosticsDock;
      case 'references': return this.referencesDock;
      case 'keymap': return this.keymapDock;
      default: return null;
    }
  }

  /** Show `agent`: activate its layout (its terminal lives there). */
  private showAgent(agent: AgentTerminal): void {
    this.activateOwner(agent);
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
    // The branch button and the GitHub PR pill are separate controls.
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
    // A file changed underneath us takes precedence — it's the more urgent signal.
    if (editor.hasDiskChange()) return `${Icons.warning} ${editor.title}`;
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
      `#Header, #LayoutList .layout-header {
        background: ${bg};
        box-shadow: none;
        border-bottom: 1px solid ${border};
      }`,
      `#FileTree, #FileTree listview { background-color: ${bg}; }`,
      `#NotificationLog, #NotificationLog list { background-color: ${bg}; }`,
      `#KeymapPanel, #KeymapPanel viewport { background-color: ${bg}; }`,
      `#LocationList, #LocationList list { background-color: ${bg}; }`,
      `#LayoutList, #LayoutList list { background-color: ${bg}; }`,
      `#GitPanel, #GitPanel list { background-color: ${bg}; }`,
      `#LayoutRow { padding: 2px 12px; }`,
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
         #LayoutList list row:selected { background-color: ${selectedBg}; }`,
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
      'layout-list:focus': 'Focus the layout sidebar',
      'layout:previous': 'Switch to the previous layout',
      'layout:next': 'Switch to the next layout',
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
      'git:delete-branch': 'Delete a branch…',
      'git:merge-branch': 'Merge a branch into current…',
      'git:rename-branch': 'Rename the current branch…',
      'git:stash-push': 'Stash changes',
      'git:stash-pop': 'Pop a stash…',
      'git:stash-apply': 'Apply a stash…',
      'git:stash-drop': 'Drop a stash…',
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
      'lsp:code-action': 'Code action / quick fix…',
      'lsp:rename': 'Rename symbol…',
      'lsp:format': 'Format document',
      'lsp:toggle-diagnostics-panel': 'Toggle the Diagnostics panel',
      'lsp:install-server': 'Install a language server…',
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
      'layout-list:focus': () => this.layoutList.focus(),
      // Cycle the active layout through [user, …agents] (the layout-list order).
      'layout:previous': () => this.cycleLayout(-1),
      'layout:next': () => this.cycleLayout(1),
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
      'lsp:code-action': () => void this.codeActionMenu(),
      'lsp:rename': () => this.renamePrompt(),
      'lsp:format': () => void this.formatActive(),
      'lsp:toggle-diagnostics-panel': () => this.toggleDiagnosticsPanel(),
      'lsp:install-server': () => this.installServerPicker(),
      'keymap:show': () => this.toggleKeymapPanel(),
    });
  }

  // Pick a language server to install (into the quilx-managed dir). Already-
  // installed and in-progress servers are shown dimmed with a status note.
  private installServerPicker() {
    const items = quilx.lsp.installableServers().map((s) => {
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
      onSelect: (name) => void quilx.lsp.installByName(name),
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

  // Dock the given panel into the active layout's bottom slot (or clear it),
  // tracking which is shown. The dock follows the user across layout switches.
  private setBottomDock(which: BottomDock) {
    this.bottomDock = which;
    this.layout.setBottom(this.bottomDockPanel());
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

  // Collapse the left dock when its last tab is closed, so the center reclaims the
  // space instead of showing the empty-state placeholder. The reveal/focus path
  // re-attaches and repopulates it. Runs from onEmpty (page-detached, after the
  // close completes), where the reparent is safe and synchronous (no one-frame
  // flash of the empty state).
  private detachDock(panel: Panel) {
    if (panel === this.leftPanel) this.layout.setRight(null);
  }

  // Reveal a left-dock tab, re-attaching the left panel and re-adding the tab if
  // they were collapsed away by closing the dock's last tab, then focus it. The
  // panel is re-attached (rooted) *before* any re-add: adding to a detached,
  // unrooted Adw.TabView yields a blank page.
  private revealLeftTab(which: 'files' | 'git') {
    if (this.leftPanel.root.getParent() === null)
      this.layout.setRight({ root: this.leftPanel.root });
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

  // Apply `lsp.*` config to the language-server manager.
  private configureLsp() {
    quilx.lsp.configure({
      enable: quilx.config.get('lsp.enable') as boolean,
      disabledLanguages: quilx.config.get('lsp.disabledLanguages') as string[],
      serverOverrides: quilx.config.get('lsp.servers') as LspConfig['serverOverrides'],
      autoInstall: quilx.config.get('lsp.autoInstall') as boolean,
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

  // Offer code actions / quick-fixes at the cursor in a picker; apply the chosen one.
  private async codeActionMenu() {
    const editor = this.activeEditor;
    if (!editor || !editor.currentFile) return;
    const actions = await quilx.lsp.codeActions(editor.lsp);
    if (actions.length === 0) {
      quilx.notifications.addInfo('No code actions available');
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
      quilx.notifications.addWarning(`LSP: "${action.title}" needs command execution (not yet supported)`);
      return;
    }
    const resolved = await quilx.lsp.resolveCodeAction(editor.lsp, action as CodeAction);
    if (!resolved.edit) {
      quilx.notifications.addWarning(`LSP: "${action.title}" needs command execution (not yet supported)`);
      return;
    }
    const encoding = quilx.lsp.completionPositionEncoding(editor.lsp) ?? 'utf-16';
    const { resourceOps } = this.applyWorkspaceEdit(resolved.edit, encoding);
    if (resourceOps > 0) {
      quilx.notifications.addWarning(`LSP: "${action.title}" includes ${resourceOps} file operation(s) not yet applied`);
    }
  }

  // Prompt for a new name (prefilled with the symbol under the cursor) and rename.
  private renamePrompt() {
    const editor = this.activeEditor;
    if (!editor || !editor.currentFile) return;
    if (!quilx.lsp.canRename(editor.lsp)) {
      quilx.notifications.addInfo('Rename is not available here');
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

  private async runRename(editor: TextEditor, newName: string) {
    if (!newName) return;
    const edit = await quilx.lsp.rename(editor.lsp, newName);
    if (!edit) {
      quilx.notifications.addInfo('Rename produced no changes');
      return;
    }
    const encoding = quilx.lsp.completionPositionEncoding(editor.lsp) ?? 'utf-16';
    const { applied, resourceOps } = this.applyWorkspaceEdit(edit, encoding);
    if (resourceOps > 0) quilx.notifications.addWarning(`Rename: ${resourceOps} file operation(s) not yet applied`);
    else quilx.notifications.addInfo(`Renamed across ${applied} file${applied === 1 ? '' : 's'}`);
  }

  // Format the active document and apply the edits to its buffer.
  private async formatActive() {
    const editor = this.activeEditor;
    if (!editor || !editor.currentFile) return;
    const options = {
      tabSize: (quilx.config.get('editor.tabLength') as number) ?? 2,
      insertSpaces: (quilx.config.get('editor.insertSpaces') as boolean) ?? true,
    };
    const edits = await quilx.lsp.format(editor.lsp, options);
    if (edits.length === 0) {
      quilx.notifications.addInfo('No formatting changes');
      return;
    }
    editor.applyLspEdits(edits, quilx.lsp.completionPositionEncoding(editor.lsp) ?? 'utf-16');
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
    if (this.leftPanel.root.getParent() === null || this.leftPanel.tabCount === 0) {
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
      'git:diff-current': {
        didDispatch: () => this.diffActiveAgainstHead(),
        description: 'Diff the current file (working tree vs HEAD)',
        when: () => this.activeEditor?.currentFile != null,
      },
      'app:quit': () => this.onQuit(),
      'command-palette:toggle': () => openCommandPicker(this.overlay),
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
      this.center.add(viewer.root, { title: `± ${name}`, requireTabBar: true });
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
      'git:delete-branch': {
        didDispatch: () => openDeleteBranchPicker(this.overlay, process.cwd()),
        when: () => this.git.getBranch() !== null,
      },
      'git:merge-branch': {
        didDispatch: () => openMergeBranchPicker(this.overlay, process.cwd()),
        when: () => this.git.getBranch() !== null,
      },
      'git:rename-branch': {
        didDispatch: () => openRenameBranchPicker(this.overlay, process.cwd()),
        when: () => this.git.getBranch() !== null,
      },
      'git:stash-push': {
        didDispatch: () => this.stashChanges(),
        when: () => this.git.getBranch() !== null,
      },
      'git:stash-pop': {
        didDispatch: () => openStashPicker(this.overlay, process.cwd(), 'pop'),
        when: () => this.git.getBranch() !== null,
      },
      'git:stash-apply': {
        didDispatch: () => openStashPicker(this.overlay, process.cwd(), 'apply'),
        when: () => this.git.getBranch() !== null,
      },
      'git:stash-drop': {
        didDispatch: () => openStashPicker(this.overlay, process.cwd(), 'drop'),
        when: () => this.git.getBranch() !== null,
      },
      'github:issue-picker': {
        didDispatch: () => openGithubIssuePicker(this.overlay, process.cwd()),
        when: () => this.git.getBranch() !== null,
      },
      'github:failed-ci-picker': {
        didDispatch: () => openGithubFailedCIPicker(this.overlay, process.cwd()),
        when: () => this.git.getBranch() !== null,
      },
      'github:pr-open': {
        didDispatch: () => openGithubPrPicker(this.overlay, process.cwd()),
        when: () => this.git.getBranch() !== null,
      },
      'github:pr-checkout': {
        didDispatch: () => checkoutGithubPrPicker(this.overlay, process.cwd()),
        when: () => this.git.getBranch() !== null,
      },
    });
  }

  private runGit(args: string[], label: string) {
    // Success is quiet (a trace, recorded in the log only); failures pop a toast.
    this.git.run(args, (ok) => {
      if (ok) quilx.notifications.addTrace(`${label} succeeded`);
      else quilx.notifications.addError(`${label} failed`);
    });
  }

  // Like `runGit`, but surfaces progress as a single in-place toast: a sticky
  // loading notice that transforms into success/error when the operation finishes
  // (the LSP install flow). All three share one `replaceKey` so the prompt that
  // triggered it, the spinner, and the result are the same card.
  private runGitWithProgress(args: string[], label: string, replaceKey: string) {
    quilx.notifications.addInfo(`${label}…`, { replaceKey, loading: true, dismissable: true });
    this.git.run(args, (ok) => {
      if (ok) quilx.notifications.addSuccess(`${label} succeeded`, { replaceKey });
      else quilx.notifications.addError(`${label} failed`, { replaceKey });
    });
  }

  // Stash the working-tree changes (visible success, since it's a manual action).
  private stashChanges() {
    const root = repoRoot(process.cwd());
    if (!root) return;
    stashPush(root, (ok, _out, stderr) => {
      if (ok) quilx.notifications.addSuccess('Stashed changes');
      else quilx.notifications.addError('Stash failed', { detail: stderr.trim() });
    });
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
      // Sticky + a shared `replaceKey` so the prompt persists until acted on and
      // clicking Pull transforms this same toast into pulling…→pulled (mirrors the
      // LSP install flow).
      quilx.notifications.addInfo(`Upstream is ahead by ${behind} ${commits}`, {
        detail: 'Your branch is behind its upstream — pull to update.',
        replaceKey: PULL_NOTICE_KEY,
        dismissable: true,
        buttons: [{ text: 'Pull', onDidClick: () => this.runGitWithProgress(['pull', '--ff-only'], 'Pull', PULL_NOTICE_KEY) }],
      });
    }
    this.lastBehind = behind;
  }

  // Periodically `git fetch` in the background so the upstream-behind check sees
  // remote activity. Quiet (no success notification); the resulting onChange
  // drives the branch button and `checkUpstream`. `git.autoFetchMinutes` of 0
  // disables it. (Read once at startup.)
  private startAutoFetch() {
    const minutes = Number(quilx.config.get('git.autoFetchMinutes') ?? 0);
    if (!(minutes > 0)) return;
    this.autoFetchTimer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT_IDLE, minutes * 60_000, () => {
      if (this.git.getBranch() !== null) this.git.run(['fetch']);
      return true; // keep fetching
    });
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
    const docks: Panel[] = [this.leftPanel];
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
      // The agent list is its own full-height sidebar (left of everything); its
      // geometry makes it the leftmost zone for directional pane navigation.
      { root: this.layoutList.root, focus: () => this.layoutList.focus() },
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
      const result: any = (widget as any).computeBounds(this.layout.root);
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

// The same indicators the LayoutList uses: nf-md-cog-sync while working, else a
// round dot. Adw tab titles are plain text (no markup, no colour), so the dot
// can't be colour-coded like the sidebar — the waiting state instead drives Adw's
// native `needs-attention` tab highlight (see updateAgentTab).
const AGENT_WORKING_GLYPH = String.fromCodePoint(0xf1978);
const AGENT_STATUS_DOT = '●';

/** An agent tab's title: the LayoutList status glyph prefixed to the agent's name. */
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

