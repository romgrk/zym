/*
 * EditorWindow — assembles and owns the editor UI: the source view and buffer,
 * the header bar, the vim status line, and the file open/save operations.
 *
 * One window per application instance. It is given the Adw.Application (for
 * registering actions/accelerators) and an `onQuit` callback so it never has to
 * know how the application shuts itself down.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { openFilePicker } from './file-picker.ts';
import {
  Adw, Gio, Gtk, GtkSource,
  type Application, type ApplicationWindow, type SourceBuffer,
  type SourceView, type ToastOverlay, type VimContext, type WindowTitle,
} from './gi.ts';

const TITLE = 'quilx';
const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 600;
const TAB_WIDTH = 4;
const RIGHT_MARGIN = 80;
const TOAST_TIMEOUT = 3;
const SIDEBAR_WIDTH = 220;
const SIDEBAR_ATTRS = 'standard::name,standard::type';

export class EditorWindow {
  private readonly app: Application;
  private readonly onQuit: () => void;
  private currentFile: string | null = null;

  private readonly buffer: SourceBuffer;
  private readonly view: SourceView;
  private readonly vim: VimContext;
  private readonly windowTitle: WindowTitle;
  private readonly toastOverlay: ToastOverlay;
  private readonly window: ApplicationWindow;

  constructor(app: Application, onQuit: () => void, initialFile: string) {
    this.app = app;
    this.onQuit = onQuit;

    this.buffer = this.createBuffer();
    this.view = this.createView(this.buffer);
    this.vim = this.createVim(this.view);
    this.windowTitle = new Adw.WindowTitle({ title: TITLE });
    this.toastOverlay = new Adw.ToastOverlay();

    const toolbarView = new Adw.ToolbarView();
    toolbarView.addTopBar(this.buildHeaderBar());
    toolbarView.setContent(this.buildContent());
    toolbarView.addBottomBar(this.buildStatusBar());
    this.toastOverlay.setChild(toolbarView);

    this.registerActions();
    this.followSystemColorScheme();

    this.window = new Adw.ApplicationWindow({ application: app });
    this.window.setDefaultSize(DEFAULT_WIDTH, DEFAULT_HEIGHT);
    this.window.setContent(this.toastOverlay);
    this.window.on('close-request', () => {
      this.onQuit();
      return false;
    });
    this.window.present();

    this.loadFile(initialFile);
  }

  // --- Source view & buffer --------------------------------------------------

  private createBuffer(): SourceBuffer {
    const buffer = new GtkSource.Buffer();
    buffer.setHighlightSyntax(true);
    return buffer;
  }

  private createView(buffer: SourceBuffer): SourceView {
    const view = new GtkSource.View({ buffer });
    view.setMonospace(true);
    view.setShowLineNumbers(true);
    view.setHighlightCurrentLine(true);
    view.setAutoIndent(true);
    view.setTabWidth(TAB_WIDTH);
    view.setShowRightMargin(true);
    view.setRightMarginPosition(RIGHT_MARGIN);
    view.setVexpand(true);
    view.setHexpand(true);
    return view;
  }

  private buildEditorArea() {
    const scrolled = new Gtk.ScrolledWindow();
    scrolled.setChild(this.view);
    scrolled.setHexpand(true);

    // The minimap mirrors the view and doubles as a scrollbar.
    const minimap = new GtkSource.Map();
    minimap.setView(this.view);

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    box.append(scrolled);
    box.append(minimap);
    return box;
  }

  private buildContent() {
    const paned = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
    paned.setStartChild(this.buildSidebar());
    paned.setEndChild(this.buildEditorArea());
    paned.setPosition(SIDEBAR_WIDTH);
    paned.setResizeStartChild(false);
    paned.setShrinkStartChild(false);
    return paned;
  }

  // --- File tree sidebar (current working directory) -------------------------

  private buildSidebar() {
    // A lazily-expanding tree of the cwd: GtkDirectoryList feeds a
    // GtkTreeListModel whose rows reveal a fresh DirectoryList per directory.
    const root = new Gtk.DirectoryList({ attributes: SIDEBAR_ATTRS });
    root.setFile(Gio.File.newForPath(process.cwd()));

    const tree = Gtk.TreeListModel.new(root, false, false, (item: any) => {
      if (item.getFileType() !== Gio.FileType.DIRECTORY) return null;
      const children = new Gtk.DirectoryList({ attributes: SIDEBAR_ATTRS });
      children.setFile(item.getAttributeObject('standard::file') as any);
      return children;
    });
    const selection = new Gtk.SingleSelection({ model: tree });

    // Each row is a TreeExpander (for the disclosure triangle) wrapping a label.
    const factory = new Gtk.SignalListItemFactory();
    factory.on('setup', (listItem: any) => {
      const expander = new Gtk.TreeExpander();
      expander.setChild(new Gtk.Label({ xalign: 0 }));
      listItem.setChild(expander);
    });
    factory.on('bind', (listItem: any) => {
      const row = listItem.getItem();
      const expander = listItem.getChild();
      expander.setListRow(row);
      expander.getChild().setText(row.getItem().getName());
    });

    const list = new Gtk.ListView({ model: selection, factory });
    list.on('activate', (position: number) => {
      const row = tree.getRow(position);
      if (!row) return;
      const info: any = row.getItem();
      if (info.getFileType() === Gio.FileType.DIRECTORY) {
        row.setExpanded(!row.getExpanded());
      } else {
        const path = (info.getAttributeObject('standard::file') as any)?.getPath();
        if (path) this.loadFile(path);
      }
    });

    const scrolled = new Gtk.ScrolledWindow();
    scrolled.setChild(list);
    scrolled.setVexpand(true);
    return scrolled;
  }

  // --- Vim modal editing (GtkSource.VimIMContext) ----------------------------

  private createVim(view: SourceView): VimContext {
    // VimIMContext is a Gtk.IMContext that turns the view into a modal (vim)
    // editor. It must be driven by a key controller in the CAPTURE phase so it
    // sees keystrokes before the view inserts them as text.
    const vim = new GtkSource.VimIMContext();
    vim.setClientWidget(view);

    const keys = new Gtk.EventControllerKey();
    keys.setImContext(vim);
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    view.addController(keys);

    // `:e [path]` — open a file, or reload the current one when path is empty.
    vim.on('edit', (_view: any, path: string) => {
      const target = path || this.currentFile;
      if (target) this.loadFile(target);
    });
    // `:w [path]` — save to the given path, or the current file.
    vim.on('write', (_view: any, path: string) => {
      const target = path || this.currentFile;
      if (target) this.saveTo(target);
    });
    // Catch-all for ex commands; we only need to implement quit.
    vim.on('execute-command', (command: string) => {
      if (/^\s*(wq|x|q)a?!?\s*$/.test(command)) {
        this.onQuit();
        return true;
      }
      return false;
    });
    return vim;
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
    // Command bar (`:`, `/`) on the left, pending command preview (e.g. "2dw")
    // on the right — mirroring Vim's bottom row.
    const commandBar = new Gtk.Label({ xalign: 0, hexpand: true });
    const commandPreview = new Gtk.Label({ xalign: 1 });
    commandBar.addCssClass('monospace');
    commandPreview.addCssClass('monospace');
    this.vim.on('notify::command-bar-text', () => commandBar.setText(this.vim.getCommandBarText()));
    this.vim.on('notify::command-text', () => commandPreview.setText(this.vim.getCommandText()));

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 });
    box.setMarginStart(6);
    box.setMarginEnd(6);
    box.append(commandBar);
    box.append(commandPreview);
    return box;
  }

  // --- Style scheme: follow the system light/dark preference -----------------

  private followSystemColorScheme() {
    const styleManager = Adw.StyleManager.getDefault();
    const schemeManager = GtkSource.StyleSchemeManager.getDefault();
    const apply = () => {
      const id = styleManager.getDark() ? 'Adwaita-dark' : 'Adwaita';
      this.buffer.setStyleScheme(schemeManager.getScheme(id));
    };
    apply();
    styleManager.on('notify::dark', apply);
  }

  // --- Actions & keyboard shortcuts ------------------------------------------

  private registerActions() {
    this.addAction('open', '<Control>o', () => this.openDialog());
    this.addAction('find-file', '<Alt>o', () =>
      openFilePicker(this.window, (path) => this.loadFile(path)));
    this.addAction('save', '<Control>s', () =>
      this.currentFile ? this.saveTo(this.currentFile) : this.saveAsDialog());
    this.addAction('save-as', '<Control><Shift>s', () => this.saveAsDialog());
    this.addAction('quit', '<Control>q', () => this.onQuit());
  }

  private addAction(name: string, accel: string, callback: (...args: any[]) => any) {
    const action = Gio.SimpleAction.new(name, null);
    action.on('activate', callback);
    this.app.addAction(action);
    this.app.setAccelsForAction(`app.${name}`, [accel]);
  }

  // --- File operations -------------------------------------------------------

  loadFile(path: string) {
    const langManager = GtkSource.LanguageManager.getDefault();
    try {
      const content = Fs.readFileSync(path, 'utf8');
      this.buffer.setLanguage(langManager.guessLanguage(path, null));
      this.buffer.setText(content, -1);
      this.buffer.placeCursor(this.buffer.getStartIter());
      this.currentFile = path;
      this.setTitle(Path.basename(path));
      this.view.grabFocus();
    } catch (error) {
      this.toast(`Could not open ${Path.basename(path)}: ${(error as Error).message}`);
    }
  }

  private saveTo(path: string) {
    const content = this.buffer.getText(this.buffer.getStartIter(), this.buffer.getEndIter(), false);
    try {
      Fs.writeFileSync(path, content);
      this.currentFile = path;
      this.setTitle(Path.basename(path));
      this.toast(`Saved ${Path.basename(path)}`);
    } catch (error) {
      this.toast(`Could not save: ${(error as Error).message}`);
    }
  }

  private openDialog() {
    const dialog = new Gtk.FileDialog();
    dialog.setTitle('Open File');
    dialog.open(this.window, null, (self: any, result: any) => {
      try {
        const file = self.openFinish(result);
        if (file) this.loadFile(file.getPath());
      } catch {
        // The user dismissed the dialog; nothing to do.
      }
    });
  }

  private saveAsDialog() {
    const dialog = new Gtk.FileDialog();
    dialog.setTitle('Save File As');
    if (this.currentFile) dialog.setInitialName(Path.basename(this.currentFile));
    dialog.save(this.window, null, (self: any, result: any) => {
      try {
        const file = self.saveFinish(result);
        if (file) this.saveTo(file.getPath());
      } catch {
        // Cancelled.
      }
    });
  }

  // --- Window chrome helpers -------------------------------------------------

  private setTitle(title: string) {
    this.windowTitle.setTitle(title);
    this.windowTitle.setSubtitle(this.currentFile ? Path.dirname(this.currentFile) : '');
  }

  private toast(message: string) {
    this.toastOverlay.addToast(new Adw.Toast({ title: message, timeout: TOAST_TIMEOUT }));
  }
}
