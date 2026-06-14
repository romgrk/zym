/*
 * AppWindow — the top-level application window. It owns the window chrome (the
 * Adwaita header bar and the vim status line, via Adw.ToolbarView), the toast
 * overlay, and the floating-picker overlay host. It composes the workbench
 * docks: the file tree in the left dock and the center editor Panel (one tab per
 * open file). Actions and accelerators are routed to the active tab's editor;
 * the window title and vim status line follow the active tab.
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
import { TextEditor } from './TextEditor.ts';
import { Workbench } from './Workbench.ts';
import { openFilePicker } from './FilePicker.ts';

const TITLE = 'quilx';
const DEFAULT_WIDTH = 1000;
const DEFAULT_HEIGHT = 800;
const TOAST_TIMEOUT = 3;

type Widget = InstanceType<typeof Gtk.Widget>;

export class AppWindow {
  private readonly app: Application;
  private readonly onQuit: () => void;

  // The center editor group. Each tab hosts one TextEditor, mapped from its root
  // widget so the active child can be resolved back to its editor.
  private readonly centerPanel: Panel;
  private readonly editors = new Map<Widget, TextEditor>();
  private readonly windowTitle: WindowTitle;
  private readonly toastOverlay: ToastOverlay;
  private readonly overlay: InstanceType<typeof Gtk.Overlay>;
  private readonly window: ApplicationWindow;

  // The vim status line: command bar (`:`, `/`) on the left, pending command
  // preview (e.g. "2dw") on the right. Re-synced to the active editor on switch.
  private readonly commandBar: InstanceType<typeof Gtk.Label>;
  private readonly commandPreview: InstanceType<typeof Gtk.Label>;

  constructor(app: Application, onQuit: () => void, initialFile: string) {
    this.app = app;
    this.onQuit = onQuit;

    this.windowTitle = new Adw.WindowTitle({ title: TITLE });
    this.toastOverlay = new Adw.ToastOverlay();
    this.commandBar = new Gtk.Label({ xalign: 0, hexpand: true });
    this.commandPreview = new Gtk.Label({ xalign: 1 });

    this.centerPanel = new Panel({
      onActiveChanged: () => this.onActiveEditorChanged(this.activeEditor),
      onClosed: (widget) => this.editors.delete(widget),
      onEmpty: () => this.onQuit(),
    });

    const workbench = new Workbench();
    const fileTree = new FileTree({
      rootPath: process.cwd(),
      onOpenFile: (path) => this.openFile(path),
    });
    const leftPanel = new Panel();
    leftPanel.add(fileTree.root);
    workbench.setLeft(leftPanel);
    workbench.setCenter(this.centerPanel);

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

    this.registerActions();

    this.window = new Adw.ApplicationWindow({ application: app });
    this.window.setDefaultSize(DEFAULT_WIDTH, DEFAULT_HEIGHT);
    this.window.setContent(this.toastOverlay);
    this.window.on('close-request', () => {
      this.onQuit();
      return false;
    });
    this.window.present();

    this.openFile(initialFile);
  }

  // --- Editor lifecycle ------------------------------------------------------

  /** The TextEditor backing the panel's active tab, if any. */
  private get activeEditor(): TextEditor | null {
    const widget = this.centerPanel.activeChild;
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
    child = this.centerPanel.add(editor.root, { title: editor.title });
    editor.onTitleChange(() => child.setTitle(editor.title));

    editor.loadFile(path);
    editor.focus();
    return editor;
  }

  // --- Active-editor wiring (status line + window title) ---------------------

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
    editor.onTitleChange(() => {
      if (this.activeEditor === editor) this.updateTitle(editor);
    });
  }

  private onActiveEditorChanged(editor: TextEditor | null) {
    const vim = editor?.vim as any;
    this.commandBar.setText(vim ? vim.getCommandBarText() : '');
    this.commandPreview.setText(vim ? vim.getCommandText() : '');
    this.updateTitle(editor);
  }

  private updateTitle(editor: TextEditor | null) {
    if (!editor) {
      this.windowTitle.setTitle(TITLE);
      this.windowTitle.setSubtitle('');
      return;
    }
    this.windowTitle.setTitle(editor.title);
    this.windowTitle.setSubtitle(editor.currentFile ? Path.dirname(editor.currentFile) : '');
  }

  // --- Header bar ------------------------------------------------------------

  private buildHeaderBar() {
    const header = new Adw.HeaderBar();
    header.setTitleWidget(this.windowTitle);

    const openButton = Gtk.Button.newFromIconName('document-open-symbolic');
    openButton.setTooltipText('Open (Ctrl+O)');
    openButton.setActionName('app.open');
    header.packStart(openButton);

    const saveButton = Gtk.Button.newFromIconName('document-save-symbolic');
    saveButton.setTooltipText('Save (Ctrl+S)');
    saveButton.setActionName('app.save');
    header.packEnd(saveButton);
    return header;
  }

  // --- Vim status line -------------------------------------------------------

  private buildStatusBar() {
    this.commandBar.addCssClass('monospace');
    this.commandPreview.addCssClass('monospace');

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 });
    box.setMarginStart(6);
    box.setMarginEnd(6);
    box.append(this.commandBar);
    box.append(this.commandPreview);
    return box;
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
  }

  private addAction(name: string, accel: string, callback: (...args: any[]) => any) {
    const action = Gio.SimpleAction.new(name, null);
    action.on('activate', callback);
    this.app.addAction(action);
    this.app.setAccelsForAction(`app.${name}`, [accel]);
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
