/*
 * AppWindow — the top-level application window. It owns the window chrome (the
 * Adwaita header bar and the vim status line, via Adw.ToolbarView), the toast
 * overlay, and the floating-picker overlay host. It composes the workbench
 * docks: the file tree in the left dock and the splittable center PanelGroup (a
 * tree of editor groups, one tab per open file). Actions and accelerators are
 * routed to the active split's active tab; the window title and vim status line
 * follow it.
 *
 * One window per application instance. It is given the Adw.Application (for
 * registering actions/accelerators) and an `onQuit` callback so it never has to
 * know how the application shuts itself down.
 */
import * as Path from 'node:path';
import {
  Adw,
  Gtk,
  type Application,
  type ApplicationWindow,
  type ToastOverlay,
  type WindowTitle,
} from '../gi.ts';
import { FileTree } from './FileTree.ts';
import { Panel, type PanelChild } from './Panel.ts';
import { PanelGroup, type Direction } from './PanelGroup.ts';
import { TextEditor } from './TextEditor/index.ts';
import { Terminal } from './Terminal.ts';
import { AgentTerminal } from './AgentTerminal.ts';
import { AgentList } from './AgentList.ts';
import { BranchButton } from './BranchButton.ts';
import { openGitRepo, type GitRepo } from '../git.ts';
import { Workbench } from './Workbench.ts';
import { openFilePicker } from './FilePicker.ts';
import { openCommandPicker } from './CommandPicker.ts';
import { openAgentPicker } from './AgentPicker.ts';
import { openConfigEditor } from './ConfigEditor.ts';
import { quilx } from '../quilx.ts';
import { type Notification } from '../Notification.ts';
import { NotificationLog } from './NotificationLog.ts';
import { NotificationToasts } from './NotificationToasts.ts';
import { loadKeymaps } from '../keymaps/load.ts';
import { loadConfig, configPath } from '../config/load.ts';
import { type DisposableLike } from '../util/eventKit.ts';
import { styles } from '../styles.ts';
import { theme } from '../theme/theme.ts';

// The header-bar title is the project name: the last path component of the cwd.
const PROJECT_NAME = Path.basename(process.cwd());
const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 950;
const TOAST_TIMEOUT = 15;
// Initial divider (px from top) between the file tree and the agent list — the
// file tree gets a compact top section so the agent list takes the rest.
const LEFT_SPLIT_POSITION = 260;

type Widget = InstanceType<typeof Gtk.Widget>;

export class AppWindow {
  private readonly app: Application;
  private readonly onQuit: () => void;

  // The splittable center: a tree of editor groups. Each tab hosts one
  // TextEditor, mapped from its root widget so the active child can be resolved
  // back to its editor regardless of which split it lives in.
  private readonly center: PanelGroup;
  private readonly editors = new Map<Widget, TextEditor>();
  // Terminal tabs share the center panel with editors; tracked separately so the
  // active child can be resolved back to its Terminal (it has no vim state).
  private readonly terminals = new Map<Widget, Terminal>();

  // The left dock: file tree above, agent list below (a vertical split). Kept as
  // fields so the pane-switching commands can move focus between the docks.
  private readonly leftPanel: Panel;
  private readonly fileTree: FileTree;
  private readonly agentList: AgentList;
  // Maps an agent's root widget to its center tab handle, so the agent list can
  // reveal (select) the agent's tab on activation.
  private readonly agentChildren = new Map<Widget, PanelChild>();
  private readonly windowTitle: WindowTitle;
  private readonly toastOverlay: ToastOverlay;
  private readonly overlay: InstanceType<typeof Gtk.Overlay>;
  private readonly window: ApplicationWindow;

  // Transient notification toasts, stacked in the bottom-right of the content
  // overlay (severity-colored). The log keeps the full history; these come and go.
  private readonly notificationToasts: NotificationToasts;

  // The notification log lives in the bottom dock, hidden until toggled. Held
  // (with its dock host) so `notifications:toggle-log` can dock/undock it.
  private readonly workbench: Workbench;
  private readonly notificationLog: NotificationLog;
  private readonly notificationPanel: Panel;
  private notificationLogVisible = false;

  // Git integration for the header-bar branch indicator.
  private readonly git: GitRepo;
  private readonly branchButton: BranchButton;
  // Last-seen upstream "behind" count, to fire the pull notification only on the
  // transition into being behind (not on every status poll while behind).
  private lastBehind = 0;

  // Watches the user config file and syncs edits into quilx.config; cancelled on
  // close.
  private readonly configWatcher: DisposableLike;

  // The vim status line: command bar (`:`, `/`) on the left, pending command
  // preview (e.g. "2dw") on the right. Re-synced to the active editor on switch.
  private readonly commandBar: InstanceType<typeof Gtk.Label>;
  private readonly commandPreview: InstanceType<typeof Gtk.Label>;

  constructor(app: Application, onQuit: () => void, initialFile: string) {
    this.app = app;
    this.onQuit = onQuit;

    this.windowTitle = new Adw.WindowTitle({ title: PROJECT_NAME });
    this.toastOverlay = new Adw.ToastOverlay();
    this.commandBar = new Gtk.Label({ xalign: 0, hexpand: true });
    this.commandPreview = new Gtk.Label({ xalign: 1 });

    this.git = openGitRepo(process.cwd());
    this.branchButton = new BranchButton(this.git);

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
        this.editors.delete(widget);
        this.terminals.delete(widget);
        this.agentChildren.delete(widget);
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
    this.leftPanel = new Panel();
    this.leftPanel.add(this.fileTree.root);

    // The agent list sits below the file tree in the left dock. A vertical Paned
    // of two Panels (the same Paned-of-Panels shape PanelGroup builds), so the
    // side dock is a natural step toward becoming fully splittable.
    this.agentList = new AgentList({ onActivate: (agent) => this.showAgent(agent) });
    const agentPanel = new Panel();
    agentPanel.add(this.agentList.root, { title: 'Agents' });

    const leftPaned = new Gtk.Paned({ orientation: Gtk.Orientation.VERTICAL });
    leftPaned.setStartChild(this.leftPanel.root);
    leftPaned.setEndChild(agentPanel.root);
    leftPaned.setPosition(LEFT_SPLIT_POSITION);
    leftPaned.setResizeStartChild(false); // window resize grows the agent list, not the tree

    this.workbench.setLeft({ root: leftPaned });
    this.workbench.setCenter(this.center);

    // The notification log: built now (so it backfills history), wrapped in a
    // Panel for its title tab, but only docked into the bottom slot on toggle.
    this.notificationLog = new NotificationLog();
    this.notificationPanel = new Panel();
    this.notificationPanel.add(this.notificationLog.root, { title: 'Notifications' });

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
    toolbarView.addBottomBar(this.buildStatusBar());
    this.toastOverlay.setChild(toolbarView);

    // Bridge the notification manager to the toast stack: every posted
    // notification pops a transient, severity-colored toast. The manager retains
    // the full history for the log; the toast is just the ephemeral view.
    quilx.notifications.onDidAddNotification((n) => this.notificationToasts.show(n as Notification));

    this.applyChromeStyles();
    this.applyNotificationStyles();

    this.window = new Adw.ApplicationWindow({ application: app });
    this.window.setName('AppWindow'); // selector identity for command/keymap rules
    this.window.setDefaultSize(DEFAULT_WIDTH, DEFAULT_HEIGHT);
    this.window.setContent(this.toastOverlay);

    // Publish the window on the global registry and start the keymap manager's
    // CAPTURE-phase key controller.
    quilx.window = this.window;
    quilx.keymaps.initialize();
    // Components register their commands; the keymap (bindings) is loaded
    // centrally from src/keymaps (default table + optional user override).
    this.registerPaneCommands();
    this.registerWindowCommands();
    this.registerTerminalCommands();
    this.registerGitCommands();
    this.registerNotificationCommands();
    this.registerConfigCommands();
    loadKeymaps();

    // Seed/load the user config and keep it in sync with on-disk edits. Done
    // before the first file opens so editors read live config values.
    this.configWatcher = loadConfig();

    // Watch the upstream sync state: when the branch falls behind its upstream
    // (e.g. a fetch brought in remote commits), offer to pull. Seed from the
    // current state so an already-behind repo doesn't toast on launch.
    this.lastBehind = this.git.getAheadBehind()?.behind ?? 0;
    this.git.onChange(() => this.checkUpstream());

    this.window.on('close-request', () => {
      this.branchButton.dispose();
      this.git.dispose();
      this.configWatcher.dispose();
      this.agentList.dispose();
      this.notificationLog.dispose();
      this.onQuit();
      return false;
    });
    this.window.present();

    this.openFile(initialFile);
  }

  // --- Editor lifecycle ------------------------------------------------------

  /** The TextEditor backing the active split's active tab, if any. */
  private get activeEditor(): TextEditor | null {
    const widget = this.center.activePanel.activeChild;
    return widget ? this.editors.get(widget) ?? null : null;
  }

  /** Open `path` in a new center tab, wiring it to the window, and select it. */
  private openFile(path: string): TextEditor {
    let child: PanelChild;
    const editor = new TextEditor({
      onToast: (message) => this.toast(message),
      onClose: () => child.close(),
    });
    // Register before adding: selecting the new tab fires onActiveChanged, which
    // resolves the active editor through this map.
    this.editors.set(editor.root, editor);
    this.wireEditor(editor);
    child = this.center.add(editor.root, { title: editor.title });
    editor.onTitleChange(() => child.setTitle(editor.title));

    editor.loadFile(path);
    editor.focus();
    return editor;
  }

  /** Open a new Terminal tab in the center panel and select it. */
  private openTerminal(): Terminal {
    let child: PanelChild;
    const terminal = new Terminal({
      cwd: process.cwd(),
      // The shell exiting (`exit`/Ctrl-D) closes its tab.
      onExit: () => child.close(),
    });
    // Register before adding: selecting the new tab fires onActiveChanged, which
    // resolves the active terminal through this map.
    this.terminals.set(terminal.root, terminal);
    child = this.center.add(terminal.root, { title: terminal.title });
    terminal.onTitleChange(() => child.setTitle(terminal.title));
    terminal.focus();
    return terminal;
  }

  /** Launch a new agent (the configured CLI) and show it in a center tab. */
  private openAgent(prompt?: string): AgentTerminal {
    const agent = new AgentTerminal({
      cwd: process.cwd(),
      prompt,
      // No onExit: when the agent process exits the widget stays put (it prints a
      // "process exited" notice and flips to an exited status). After that, Enter
      // closes the agent's current tab.
      onCloseRequest: () => this.agentChildren.get(agent.root)?.close(),
    });
    // One persistent title binding that updates whichever tab currently shows the
    // agent (survives close/reopen, since it reads agentChildren on each change).
    agent.onTitleChange(() => this.agentChildren.get(agent.root)?.setTitle(agent.title));
    // Focusing the agent's terminal selects its row in the agent list.
    const focus = new Gtk.EventControllerFocus();
    focus.on('enter', () => this.agentList.selectAgent(agent));
    agent.root.addController(focus);
    this.showAgent(agent);
    return agent;
  }

  /**
   * Show `agent` in the center: select its existing tab, or — if it has none
   * (its tab was closed while the process kept running) — reattach its persisted
   * terminal widget to a fresh tab. Driven by openAgent and the agent list.
   */
  private showAgent(agent: AgentTerminal): void {
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
    const child = this.center.add(agent.root, { title: agent.title });
    this.agentChildren.set(agent.root, child);
    agent.focus();
  }

  // --- Active-editor wiring (vim status line) --------------------------------

  // Connect an editor's vim signals once, at creation. The handlers update the
  // shared status labels only while that editor is active, so no disconnect is
  // needed when tabs switch. The active-switch path re-syncs the labels.
  private wireEditor(editor: TextEditor) {
    const vim = editor.vim as any;
    vim.on('notify::command-bar-text', () => {
      if (this.activeEditor === editor) this.commandBar.setText(vim.getCommandBarText());
    });
    vim.on('notify::command-text', () => {
      if (this.activeEditor === editor) this.commandPreview.setText(vim.getCommandText());
    });
  }

  // Route a tab switch to the editor or terminal handler based on what the
  // active child is. Terminals carry no vim state, so they take a separate path.
  private onActiveTabChanged() {
    const widget = this.center.activePanel.activeChild;
    const terminal = widget ? this.terminals.get(widget) ?? null : null;
    if (terminal) {
      this.commandBar.setText('');
      this.commandPreview.setText('');
      return;
    }
    this.onActiveEditorChanged(this.activeEditor);
  }

  private onActiveEditorChanged(editor: TextEditor | null) {
    const vim = editor?.vim as any;
    this.commandBar.setText(vim ? vim.getCommandBarText() : '');
    this.commandPreview.setText(vim ? vim.getCommandText() : '');
  }

  // --- Header bar ------------------------------------------------------------

  private buildHeaderBar() {
    const header = new Adw.HeaderBar();
    header.setName('Header'); // CSS identity (#Header)
    header.setTitleWidget(this.windowTitle);
    header.packStart(this.branchButton.root);
    return header;
  }

  // --- Vim status line -------------------------------------------------------

  private buildStatusBar() {
    this.commandBar.addCssClass('monospace');
    this.commandPreview.addCssClass('monospace');

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 });
    box.setName('StatusBar'); // CSS identity (#StatusBar)
    box.setMarginStart(6);
    box.setMarginEnd(6);
    box.append(this.commandBar);
    box.append(this.commandPreview);
    return box;
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
      `#StatusBar { background-color: ${bg}; }`,
      `#FileTree, #FileTree listview { background-color: ${bg}; }`,
      `#NotificationLog, #NotificationLog list { background-color: ${bg}; }`,
      `#AgentList, #AgentList list { background-color: ${bg}; }`,
      `#AgentRow { padding: 2px 12px; }`,
      `#Panel tabbar .box,
       #Panel tabbar tabbox,
       #Panel tabbar tab { background-color: ${bg}; }`,
      `#Panel tabbar .box {
        box-shadow: none;
        padding: 0;
        min-height: 0;
        border-bottom: 1px solid ${border};
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
    const { info, success, warning, error, popoverBg, border } = theme.ui;
    const colors: Record<string, string> = {
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
      // Clickable toasts (default action) get a pointer cursor and hover tint.
      `.NotificationToast.activatable { cursor: pointer; }`,
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
    });
  }

  // Window-level file/edit operations, surfaced in the command palette and (for
  // most) on the space leader. Handlers only; bindings live in the central keymap.
  private registerWindowCommands() {
    quilx.commands.add('#AppWindow', {
      'file:open': () => this.openDialog(),
      'file:find': () => openFilePicker(this.overlay, (path) => this.openFile(path)),
      'file:save': () => this.saveActive(),
      'file:save-as': () => this.saveAsDialog(),
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
        onStart: (prompt) => this.openAgent(prompt),
      }),
    });
  }

  // Git network operations. They run through GitRepo.run (Gio.Subprocess, non-
  // blocking), so the branch button's spinner reflects progress automatically;
  // the result is surfaced as a toast.
  private registerGitCommands() {
    quilx.commands.add('#AppWindow', {
      'git:fetch': () => this.runGit(['fetch'], 'Fetch'),
      'git:pull': () => this.runGit(['pull', '--ff-only'], 'Pull'),
      'git:push': () => this.runGit(['push'], 'Push'),
    });
  }

  private runGit(args: string[], label: string) {
    this.git.run(args, (ok) => this.toast(ok ? `${label} succeeded` : `${label} failed`));
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

  // Dock the log into the bottom slot (and focus it) or remove it, tracking the
  // state so the command is a true toggle.
  private toggleNotificationLog() {
    this.notificationLogVisible = !this.notificationLogVisible;
    if (this.notificationLogVisible) {
      this.workbench.setBottom(this.notificationPanel);
      this.notificationLog.focus();
    } else {
      this.workbench.setBottom(null);
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

  // Close the active center pane and focus whatever pane takes its place.
  private closePane() {
    this.center.closeActivePanel();
    this.focusActivePane();
  }

  // Directional focus across center splits, with dock fallbacks at the edges:
  // from the file tree, `l` enters the center; from the center's left edge, `h`
  // returns to the file tree.
  private navPane(direction: Direction) {
    if (this.isFocusWithin(this.leftPanel.root)) {
      if (direction === 'right') this.focusActivePane();
      return;
    }
    if (this.center.focusDirection(direction)) {
      this.focusActivePane();
    } else if (direction === 'left') {
      this.fileTree.focus();
    }
  }

  private focusNextPane() {
    if (this.isFocusWithin(this.leftPanel.root)) {
      this.focusActivePane();
      return;
    }
    if (this.center.focusNext()) this.focusActivePane();
    else this.fileTree.focus();
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
    const editor = this.editors.get(widget);
    if (editor) {
      editor.focus();
      return;
    }
    this.terminals.get(widget)?.focus();
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
