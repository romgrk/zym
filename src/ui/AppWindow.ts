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
  Gio,
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
import { BranchButton } from './BranchButton.ts';
import { openGitRepo, type GitRepo } from '../git.ts';
import { Workbench } from './Workbench.ts';
import { openFilePicker } from './FilePicker.ts';
import { openCommandPicker } from './CommandPicker.ts';
import { quilx } from '../quilx.ts';
import { loadConfig } from '../config/load.ts';
import { type DisposableLike } from '../util/eventKit.ts';
import { styles } from '../styles.ts';
import { theme } from '../theme/theme.ts';

// The header-bar title is the project name: the last path component of the cwd.
const PROJECT_NAME = Path.basename(process.cwd());
const DEFAULT_WIDTH = 1000;
const DEFAULT_HEIGHT = 800;
const TOAST_TIMEOUT = 3;

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

  // The left dock (file tree), kept as fields so the pane-switching demo
  // commands can move focus between the docks.
  private readonly leftPanel: Panel;
  private readonly fileTree: FileTree;
  private readonly windowTitle: WindowTitle;
  private readonly toastOverlay: ToastOverlay;
  private readonly overlay: InstanceType<typeof Gtk.Overlay>;
  private readonly window: ApplicationWindow;

  // Git integration for the header-bar branch indicator.
  private readonly git: GitRepo;
  private readonly branchButton: BranchButton;

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
        this.editors.delete(widget);
        this.terminals.delete(widget);
      },
      onEmpty: () => this.onQuit(),
    });

    const workbench = new Workbench();
    this.fileTree = new FileTree({
      rootPath: process.cwd(),
      onOpenFile: (path) => this.openFile(path),
    });
    this.fileTree.root.addCssClass('quilx-filetree');
    this.leftPanel = new Panel();
    this.leftPanel.add(this.fileTree.root);
    workbench.setLeft(this.leftPanel);
    workbench.setCenter(this.center);

    const toolbarView = new Adw.ToolbarView();
    toolbarView.addTopBar(this.buildHeaderBar());
    // Overlay host for transient widgets (e.g. the fuzzy file picker). It wraps
    // only the content, so the picker floats over the workbench below the header
    // bar rather than over the whole window.
    this.overlay = new Gtk.Overlay();
    this.overlay.setChild(workbench.root);
    toolbarView.setContent(this.overlay);
    toolbarView.addBottomBar(this.buildStatusBar());
    this.toastOverlay.setChild(toolbarView);

    this.applyChromeStyles();
    this.registerActions();

    this.window = new Adw.ApplicationWindow({ application: app });
    this.window.setName('AppWindow'); // selector identity for command/keymap rules
    this.window.setDefaultSize(DEFAULT_WIDTH, DEFAULT_HEIGHT);
    this.window.setContent(this.toastOverlay);

    // Publish the window on the global registry and start the keymap manager's
    // CAPTURE-phase key controller.
    quilx.window = this.window;
    quilx.keymaps.initialize();
    this.registerPaneCommands();
    this.registerWindowCommands();
    this.registerTerminalCommands();

    // Seed/load the user config and keep it in sync with on-disk edits. Done
    // before the first file opens so editors read live config values.
    this.configWatcher = loadConfig();

    this.window.on('close-request', () => {
      this.branchButton.dispose();
      this.git.dispose();
      this.configWatcher.dispose();
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
    header.addCssClass('quilx-headerbar');
    header.setTitleWidget(this.windowTitle);
    header.packStart(this.branchButton.root);
    return header;
  }

  // --- Vim status line -------------------------------------------------------

  private buildStatusBar() {
    this.commandBar.addCssClass('monospace');
    this.commandPreview.addCssClass('monospace');

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 });
    box.addCssClass('quilx-statusbar');
    box.setMarginStart(6);
    box.setMarginEnd(6);
    box.append(this.commandBar);
    box.append(this.commandPreview);
    return box;
  }

  // --- Theme chrome ----------------------------------------------------------

  // Paint the window chrome (header bar, file tree, status/command bar) with the
  // theme's background. Installed as a single keyed, replaceable stylesheet so a
  // future theme switch can re-apply it. Themes without their own background
  // (ui.bg unset) leave the chrome to the system Adwaita styling.
  private applyChromeStyles() {
    const bg = theme.ui.bg;
    if (!bg) {
      styles.remove('theme-chrome');
      return;
    }
    const border = theme.ui.border ?? 'rgba(0, 0, 0, 0.3)';
    styles.set(
      `
        headerbar.quilx-headerbar {
          background: ${bg};
          box-shadow: none;
          border-bottom: 1px solid ${border};
        }
        .quilx-statusbar { background-color: ${bg}; }
        .quilx-filetree, .quilx-filetree listview { background-color: ${bg}; }
        .quilx-panel tabbar .box,
        .quilx-panel tabbar tabbox,
        .quilx-panel tabbar tab { background-color: ${bg}; }
        .quilx-panel tabbar .box { box-shadow: none; padding: 0; min-height: 0; }
        .quilx-panel tabbar tabbox { padding: 0; min-height: 0; }
        .quilx-panel tabbar tab { min-height: 0; padding: 2px 12px; }
        .quilx-panel tabbar tab:hover { background-color: shade(${bg}, 1.2); }
        .quilx-panel tabbar tab:selected {
          background-color: shade(${bg}, 1.6);
          box-shadow: inset 0 -2px ${border};
        }
      `,
      { key: 'theme-chrome' },
    );
  }

  // --- Actions & keyboard shortcuts ------------------------------------------

  private registerActions() {
    this.addAction('open', '<Control>o', () => this.openDialog());
    this.addAction('find-file', '<Alt>o', () =>
      openFilePicker(this.overlay, (path) => this.openFile(path)),
    );
    this.addAction('save', '<Control>s', () => this.saveActive());
    this.addAction('save-as', '<Control><Shift>s', () => this.saveAsDialog());
    this.addAction('quit', '<Control>q', () => this.onQuit());
    this.addAction('command-palette', '<Control><Shift>p', () =>
      openCommandPicker(this.overlay),
    );
  }

  private addAction(name: string, accel: string, callback: (...args: any[]) => any) {
    const action = Gio.SimpleAction.new(name, null);
    action.on('activate', callback);
    this.app.addAction(action);
    this.app.setAccelsForAction(`app.${name}`, [accel]);
  }

  // --- Pane switching (demo of the ported command/keymap managers) -----------

  // Vim-style window (split) management wired through the ported CommandManager
  // + KeymapManager. The bindings target the `AppWindow` selector (the window's
  // widget name), which is always an ancestor of the focused widget, so the
  // CAPTURE-phase keymap controller matches them no matter what is focused:
  //
  //   ctrl-w v          split right (side by side)
  //   ctrl-w s          split down (stacked)
  //   ctrl-w c          close the active split
  //   ctrl-w h/j/k/l    focus the split left/down/up/right
  //   ctrl-w w          cycle through the splits
  //   ctrl-w ctrl-w     cycle through the splits
  //
  // Directional focus stays within the center; at the left edge `ctrl-w h` falls
  // back to the file-tree dock, and from the file tree `ctrl-w l` returns to it.
  private registerPaneCommands() {
    quilx.commands.add('AppWindow', {
      'pane:split-right': () => this.splitPane('right'),
      'pane:split-down': () => this.splitPane('down'),
      'pane:close': () => this.closePane(),
      'pane:focus-left': () => this.navPane('left'),
      'pane:focus-right': () => this.navPane('right'),
      'pane:focus-up': () => this.navPane('up'),
      'pane:focus-down': () => this.navPane('down'),
      'pane:focus-next': () => this.focusNextPane(),
    });
    quilx.keymaps.add('AppWindow', {
      AppWindow: {
        'ctrl-w v': 'pane:split-right',
        'ctrl-w s': 'pane:split-down',
        'ctrl-w c': 'pane:close',
        'ctrl-w h': 'pane:focus-left',
        'ctrl-w j': 'pane:focus-down',
        'ctrl-w k': 'pane:focus-up',
        'ctrl-w l': 'pane:focus-right',
        'ctrl-w w': 'pane:focus-next',
        'ctrl-w ctrl-w': 'pane:focus-next',
      },
    });
  }

  // Window-level file/edit operations registered as commands so they appear in
  // the command palette (Ctrl+Shift+P). They share the same handlers as the Gio
  // actions/accelerators above, so both entry points stay in sync.
  private registerWindowCommands() {
    quilx.commands.add('AppWindow', {
      'file:open': () => this.openDialog(),
      'file:find': () => openFilePicker(this.overlay, (path) => this.openFile(path)),
      'file:save': () => this.saveActive(),
      'file:save-as': () => this.saveAsDialog(),
      'app:quit': () => this.onQuit(),
    });
  }

  // Terminal commands: open a shell in a new center-panel tab. Registered on the
  // window's widget class so the command is always available (command palette)
  // and bound to ctrl-shift-t.
  private registerTerminalCommands() {
    quilx.commands.add('AppWindow', {
      'terminal:new': () => this.openTerminal(),
    });
    quilx.keymaps.add('AppWindow', {
      AppWindow: {
        'ctrl-shift-t': 'terminal:new',
      },
    });
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
  // terminal); fall back to the panel itself when it has no tabs.
  private focusActivePane() {
    const widget = this.center.activePanel.activeChild;
    if (!widget) {
      this.center.activePanel.root.grabFocus();
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

  private toast(message: string) {
    this.toastOverlay.addToast(new Adw.Toast({ title: message, timeout: TOAST_TIMEOUT }));
  }
}
