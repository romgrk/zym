/*
 * TextEditor — a single file's editor widget: a GtkSource.View + Buffer with
 * tree-sitter highlighting and folding (SyntaxController), vim modal editing
 * (GtkSource.VimIMContext), and a minimap. One TextEditor per open file (one per
 * tab). It owns its file I/O, its fold-key bindings, and follows the system
 * light/dark scheme. The assembled widget is exposed via `root`.
 *
 * Load/save failures are reported through the injected `onToast` callback (the
 * toast overlay is window-level), and `onClose` is fired by the vim `:q`/`:wq`/
 * `:x` ex-commands.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { SyntaxController } from '../../syntax/syntax-controller.ts';
import { theme } from '../../theme/theme.ts';
import { createSourceScheme } from '../../theme/createSourceScheme.ts';
import { addStyles } from '../../styles.ts';
import { EditorModel } from './EditorModel.ts';
import { attachVim } from './vim/index.ts';
import {
  Adw,
  Gtk,
  GtkSource,
  type SourceBuffer,
  type SourceView,
  type VimContext,
} from '../../gi.ts';

addStyles(`.quilx-editor { color: ${theme.ui.fg}; }`);

const TAB_WIDTH = 4;
const RIGHT_MARGIN = 80;

// Opt-in toggle for the custom (vendored vim-mode-plus) modal layer. Off by
// default: the editor keeps GtkSource.VimIMContext until the port reaches
// parity. Run with `QUILX_CUSTOM_VIM=1` to drive the new layer instead.
const USE_CUSTOM_VIM = process.env.QUILX_CUSTOM_VIM === '1';

// AppWindow's status line subscribes to the VimIMContext's command-bar signals.
// Under the custom layer there is no VimIMContext yet, so we hand the window an
// inert stand-in; the real command-line/status wiring lands in a later phase.
function createVimStatusShim(): VimContext {
  return {
    on() {},
    getCommandBarText() {
      return '';
    },
    getCommandText() {
      return '';
    },
  } as unknown as VimContext;
}

export interface TextEditorOptions {
  /** Surface a load/save message (the toast overlay is window-level). */
  onToast?: (message: string) => void;
  /** Fired by the vim `:q`/`:wq`/`:x` ex-commands. */
  onClose?: () => void;
}

export class TextEditor {
  readonly root: InstanceType<typeof Gtk.Box>;
  readonly vim: VimContext;

  private readonly buffer: SourceBuffer;
  private readonly view: SourceView;
  private readonly syntax: SyntaxController;
  private readonly editorModel: EditorModel;
  private readonly onToast: (message: string) => void;

  private _currentFile: string | null = null;
  private readonly titleHandlers: Array<() => void> = [];

  constructor(options: TextEditorOptions = {}) {
    this.onToast = options.onToast ?? (() => {});

    this.buffer = this.createBuffer();
    this.view = this.createView(this.buffer);
    // Tree-sitter highlighting + folding for this view/buffer.
    this.syntax = new SyntaxController(this.view, this.buffer);
    // The buffer/cursor model the custom vim layer drives.
    this.editorModel = new EditorModel(this.view, this.buffer);

    if (USE_CUSTOM_VIM) {
      // Drive modal editing through the vendored vim-mode-plus core. The
      // VimIMContext is not created, so it doesn't contend for keystrokes.
      attachVim(this.editorModel);
      this.vim = createVimStatusShim();
    } else {
      this.vim = this.createVim(this.view, options.onClose);
    }

    this.root = this.buildEditorArea();
    this.root.setName('TextEditor'); // selector identity for command/keymap rules

    this.installFoldKeys();
    this.followSystemColorScheme();
  }

  // --- Source view & buffer --------------------------------------------------

  private createBuffer(): SourceBuffer {
    const buffer = new GtkSource.Buffer();
    buffer.setHighlightSyntax(true);
    return buffer;
  }

  private createView(buffer: SourceBuffer): SourceView {
    const view = new GtkSource.View({ buffer });
    view.addCssClass('quilx-editor');
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

  // --- Folding key bindings (vim za/zo/zc/zR/zM) -----------------------------

  private installFoldKeys() {
    // Attached to this editor's root box (an ancestor of the view) in the
    // CAPTURE phase: capture propagates toplevel→focused, so this fires before
    // the view's VimIMContext controller and can claim the `z` fold prefix.
    // Gated to only act while this view is focused and in normal mode (overwrite
    // == not insert).
    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number) => {
      // hasFocus() is typed as a property in the generated bindings; the runtime
      // method exists, so call through `any`.
      if (!(this.view as any).hasFocus()) return false;
      return this.syntax.handleFoldKey(keyval, this.view.getOverwrite());
    });
    this.root.addController(keys);
  }

  // --- Vim modal editing (GtkSource.VimIMContext) ----------------------------

  private createVim(view: SourceView, onClose?: () => void): VimContext {
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
      const target = path || this._currentFile;
      if (target) this.loadFile(target);
    });
    // `:w [path]` — save to the given path, or the current file.
    vim.on('write', (_view: any, path: string) => {
      const target = path || this._currentFile;
      if (target) this.saveAs(target);
    });
    // Catch-all for ex commands; we only need to implement quit.
    vim.on('execute-command', (command: string) => {
      if (/^\s*(wq|x|q)a?!?\s*$/.test(command)) {
        onClose?.();
        return true;
      }
      return false;
    });
    return vim;
  }

  // --- Style scheme: follow the system light/dark preference -----------------

  private followSystemColorScheme() {
    const styleManager = Adw.StyleManager.getDefault();
    const schemeManager = GtkSource.StyleSchemeManager.getDefault();
    // A theme that defines its own background owns the whole editor scheme
    // (background + line numbers); built once since it doesn't vary by system
    // light/dark. Otherwise we follow the Adwaita light/dark scheme.
    const themeScheme = theme.ui.bg ? createSourceScheme(theme) : null;
    const apply = () => {
      const scheme =
        themeScheme ?? schemeManager.getScheme(styleManager.getDark() ? 'Adwaita-dark' : 'Adwaita');
      this.buffer.setStyleScheme(scheme);
      this.syntax.restyle(); // keep tree-sitter tag colors in sync with the scheme
    };
    apply();
    styleManager.on('notify::dark', apply);
  }

  // --- File operations -------------------------------------------------------

  loadFile(path: string) {
    try {
      const content = Fs.readFileSync(path, 'utf8');
      this.buffer.setText(content, -1);
      this.buffer.placeCursor(this.buffer.getStartIter());
      this._currentFile = path;
      this.view.grabFocus();

      // Prefer tree-sitter; fall back to GtkSourceView's `.lang` engine for
      // languages we don't have a grammar for.
      const handled = this.syntax.setLanguageForPath(path);
      if (handled) {
        this.buffer.setLanguage(null); // ensure the .lang engine stays off
      } else {
        const langManager = GtkSource.LanguageManager.getDefault();
        this.buffer.setHighlightSyntax(true);
        this.buffer.setLanguage(langManager.guessLanguage(path, null));
      }
      this.emitTitleChange();
    } catch (error) {
      this.onToast(`Could not open ${Path.basename(path)}: ${(error as Error).message}`);
    }
  }

  /** Save to the current file. No-op if the editor has no file yet. */
  save() {
    if (this._currentFile) this.saveAs(this._currentFile);
  }

  saveAs(path: string) {
    const content = this.buffer.getText(
      this.buffer.getStartIter(),
      this.buffer.getEndIter(),
      false,
    );
    try {
      Fs.writeFileSync(path, content);
      this._currentFile = path;
      this.emitTitleChange();
      this.onToast(`Saved ${Path.basename(path)}`);
    } catch (error) {
      this.onToast(`Could not save: ${(error as Error).message}`);
    }
  }

  // --- Identity --------------------------------------------------------------

  get currentFile(): string | null {
    return this._currentFile;
  }

  /** The tab/window title for this editor (file basename, or "Untitled"). */
  get title(): string {
    return this._currentFile ? Path.basename(this._currentFile) : 'Untitled';
  }

  focus() {
    this.view.grabFocus();
  }

  /** Subscribe to title changes (fired when the editor's file changes). */
  onTitleChange(callback: () => void) {
    this.titleHandlers.push(callback);
  }

  private emitTitleChange() {
    for (const callback of this.titleHandlers) callback();
  }
}
