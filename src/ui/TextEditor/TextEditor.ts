/*
 * TextEditor — a single file's editor widget: a GtkSource.View + Buffer with
 * tree-sitter highlighting and folding (SyntaxController), custom vim modal
 * editing (the vendored vim-mode-plus core, via `attachVim`), and a minimap. One
 * TextEditor per open file (one per tab). It owns its file I/O, its fold-key
 * bindings, and follows the system light/dark scheme. The assembled widget is
 * exposed via `root`.
 *
 * Load/save failures are reported through the injected `onToast` callback (the
 * toast overlay is window-level).
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { SyntaxController } from '../../syntax/syntax-controller.ts';
import { theme } from '../../theme/theme.ts';
import { createSourceScheme } from '../../theme/createSourceScheme.ts';
import { addStyles } from '../../styles.ts';
import { EditorModel } from './EditorModel.ts';
import { attachVim } from './vim/index.ts';
import { quilx } from '../../quilx.ts';
import { DiagnosticsView } from '../../lsp/diagnostics/DiagnosticsView.ts';
import { markdownToPango } from '../markdownMarkup.ts';
import { monospaceFontFamily } from '../../fonts.ts';
import { highlightToMarkup } from '../../syntax/highlightToMarkup.ts';
import { langIdForPath } from '../../syntax/grammar.ts';
import { DecorationController } from './DecorationController.ts';
import { GitGutter } from './GitGutter.ts';
import { UnderlineOverlay } from './UnderlineOverlay.ts';
import { SearchController } from './SearchController.ts';
import { SearchBar } from './SearchBar.ts';
import { CompletionController } from './CompletionController.ts';
import { createBufferWordsSource } from './createBufferWordsSource.ts';
import { createLspCompletionSource } from './createLspCompletionSource.ts';
import type { LspDocument } from '../../lsp/LspManager.ts';
import type { GitRepo } from '../../git.ts';
import type { TabState } from '../../SessionManager.ts';
import {
  Adw,
  Gdk,
  Gtk,
  GtkSource,
  type SourceBuffer,
  type SourceView,
} from '../../gi.ts';

addStyles(`
  .quilx-editor { color: ${theme.ui.fg}; caret-color: ${theme.ui.fg}; }
  /* Pending-command preview ("showcmd"), floated in the editor's bottom-right. */
  .quilx-showcmd {
    background-color: ${theme.ui.bg ?? '#000'};
    color: ${theme.ui.fg};
    opacity: 0.75;
    padding: 1px 6px;
    margin: 4px;
    border-radius: 4px;
  }
  /* Hollow caret shown over the cursor's character while the editor is unfocused. */
  .quilx-unfocused-caret {
    border: 1.5px solid ${theme.ui.textMuted ?? theme.ui.lineNumber ?? theme.ui.fg};
    border-radius: 1px;
  }
  /* Filled caret block for positions with no glyph to reverse-video (empty line,
     past end-of-line, end-of-buffer). */
  .quilx-block-caret {
    background-color: ${theme.ui.fg};
    border-radius: 1px;
  }
  /* Buffer-only mode: greyed placeholder shown over an empty buffer. */
  .quilx-placeholder {
    color: ${theme.ui.textMuted ?? theme.ui.lineNumber ?? theme.ui.fg};
    opacity: 0.6;
  }
  /* LSP hover card: a floating tooltip over the editor. */
  .quilx-hover {
    background-color: ${theme.ui.popoverBg ?? theme.ui.bg ?? '#1e1e1e'};
    color: ${theme.ui.fg};
    border: 1px solid alpha(${theme.ui.fg}, 0.2);
    border-radius: 6px;
    padding: 6px 8px;
    box-shadow: 0 1px 3px alpha(black, 0.3);
  }
`);

const TAB_WIDTH = 4;
const RIGHT_MARGIN = 80;
// LSP hover card width (px) — set as a size request, since GtkFixed sizes its
// children to their *minimum* width (it ignores GtkLabel max-width-chars). The
// label fills this width and wraps. HOVER_GAP keeps the card clear of the cursor.
const HOVER_WIDTH_PX = 300;
const HOVER_GAP = 4;

type VimState = ReturnType<typeof attachVim>;

// The vim layer asks for multi-char (search) input through this seam; TextEditor
// fulfils it with the SearchBar. `matchStart` is null when the search is cancelled.
interface SearchInputRequest {
  reverse?: boolean;
  onConfirm(matchStart: import('../../text/Point.ts').Point | null): void;
  onCancel(): void;
}
type VimSearchBridge = { setSearchInput?(provider: (req: SearchInputRequest) => void): void };

// Search keybindings are registered once globally (per-view command handlers are
// added per editor in installSearch). Normal mode only: `/`/`?` open the bar,
// `n`/`N` repeat the last search.
let searchKeymapsRegistered = false;
function registerSearchKeymapsOnce(): void {
  if (searchKeymapsRegistered) return;
  searchKeymapsRegistered = true;
  quilx.keymaps.add('editor-search', {
    'GtkSourceView.normal-mode': {
      '/': 'editor:search-forward',
      '?': 'editor:search-backward',
      n: 'editor:search-next',
      N: 'editor:search-previous',
      '*': 'editor:search-word-forward',
      '#': 'editor:search-word-backward',
    },
  });
}

export interface TextEditorOptions {
  /** Surface a load/save message (the toast overlay is window-level). */
  onToast?: (message: string) => void;
  /**
   * Close request for this editor. Was fired by the `:q`/`:wq`/`:x` ex-commands;
   * dormant until the custom vim layer grows an ex-command line. Closing is
   * available meanwhile through the window's `tab:close`/`pane:close` commands.
   */
  onClose?: () => void;
  /**
   * Buffer-only mode: an editor with no file, LSP, line numbers, or minimap — a
   * plain text input for embedding (e.g. the Git commit-message editor). Keeps
   * the full editing experience (vim, syntax, search). Drive its text with
   * `getText`/`setText`; `loadFile`/`save` are no-ops.
   */
  buffer?: BufferEditorOptions;
  /** When given, draws a git change bar in the gutter (vs HEAD). File mode only. */
  git?: GitRepo;
}

export interface BufferEditorOptions {
  /** Greyed text shown over the empty buffer. */
  placeholder?: string;
  /** Initial buffer contents. */
  initialText?: string;
  /** Fired on the submit gesture (Ctrl+Enter) with the current text. */
  onSubmit?: (text: string) => void;
}

export class TextEditor {
  readonly root: InstanceType<typeof Gtk.Box>;

  private readonly buffer: SourceBuffer;
  private readonly view: SourceView;
  private readonly syntax: SyntaxController;
  private readonly editorModel: EditorModel;
  private readonly vimState: VimState;
  private readonly decorationController: DecorationController;
  private readonly search: SearchController;
  private completion!: CompletionController; // built in buildEditorArea (needs the overlay)
  private searchBar!: SearchBar; // built in buildEditorArea (needs the overlay)
  private underlineOverlay!: UnderlineOverlay; // drawn diagnostic squiggles; built in buildEditorArea
  private readonly onToast: (message: string) => void;

  // LSP: a document adapter the LspManager drives, and the per-editor diagnostics
  // renderer. Wired in `installLsp` once the model and root exist.
  private lspDocument!: LspDocument;
  private diagnostics!: DiagnosticsView;
  // Git change bar in the gutter; only present in file mode when a repo is given.
  private gitGutter: GitGutter | null = null;
  // The LSP hover card: a non-interactive overlay floated in `caretLayer` at the
  // cursor (the proven Fixed-overlay pattern, not a GtkPopover). Hidden until shown.
  private readonly hoverLabel = new Gtk.Label({ useMarkup: true, wrap: true, xalign: 0 });
  // Vertical box so the label fills (and wraps to) the card's fixed width.
  private readonly hoverCard = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  private contentOverlay!: InstanceType<typeof Gtk.Overlay>; // hosts the hover card

  // Editor-local overlays: the pending-command preview (showcmd) and the
  // hollow-rectangle caret shown while the view is unfocused.
  private readonly showcmdLabel = new Gtk.Label({ label: '' });
  private readonly caretLayer = new Gtk.Fixed();
  private readonly caret = new Gtk.Box();
  private showcmd = '';

  // Buffer-only mode config (null = a normal file editor), and the placeholder
  // label shown over the empty buffer (only built when a placeholder is given).
  private readonly bufferMode: BufferEditorOptions | null;
  private readonly gitRepo: GitRepo | null;
  private placeholderLabel: InstanceType<typeof Gtk.Label> | null = null;

  private _currentFile: string | null = null;
  private readonly titleHandlers: Array<() => void> = [];
  private readonly modifiedHandlers: Array<() => void> = [];

  constructor(options: TextEditorOptions = {}) {
    this.onToast = options.onToast ?? (() => {});
    this.bufferMode = options.buffer ?? null;
    this.gitRepo = options.git ?? null;

    this.buffer = this.createBuffer();
    // Surface the buffer's modified flag toggling (drives the tab/header dot).
    this.buffer.on('modified-changed', () => {
      for (const callback of this.modifiedHandlers) callback();
    });
    this.view = this.createView(this.buffer);
    // Tree-sitter highlighting + folding for this view/buffer.
    this.syntax = new SyntaxController(this.view, this.buffer, { lineNumbers: !this.bufferMode });
    // The buffer/cursor model the custom vim layer drives.
    this.editorModel = new EditorModel(this.view, this.buffer);
    // Let motions see/reveal folds (the fold state lives in SyntaxController).
    this.editorModel.setFoldProvider({
      isFoldedAtRow: (row) => this.syntax.isLineHidden(row),
      unfoldRow: (row) => this.syntax.unfoldRow(row),
    });

    // Modal editing runs through the vendored vim-mode-plus core.
    this.vimState = attachVim(this.editorModel);
    // Inline decoration surface (search highlights, inline diff) — consumers
    // reach it via `editor.decorations`.
    this.decorationController = new DecorationController(this.editorModel);
    // Search/replace engine; its `SearchBar` widget is built in buildEditorArea.
    this.search = new SearchController(this.editorModel, this.decorationController);

    this.root = this.buildEditorArea();
    this.root.setName('TextEditor'); // selector identity for command/keymap rules

    this.installFoldCommands();
    this.installCursorOverlay();
    this.installShowcmd();
    this.followSystemColorScheme();
    this.installLsp();
    this.installGitGutter();
    this.installSearch();
    if (this.bufferMode) this.installBufferMode(this.bufferMode);
  }

  // --- Buffer-only mode ------------------------------------------------------

  /** The current buffer text. */
  getText(): string {
    return this.editorModel.getText();
  }

  /** Replace the buffer text (clears the modified flag, cursor to start). */
  setText(text: string): void {
    this.buffer.setText(text, -1);
    this.buffer.setModified(false);
    this.buffer.placeCursor(this.buffer.getStartIter());
  }

  private installBufferMode(mode: BufferEditorOptions): void {
    if (mode.initialText) this.setText(mode.initialText);
    this.placeholderLabel?.setVisible(this.buffer.getCharCount() === 0);

    if (mode.onSubmit) {
      // Ctrl+Enter submits. Capture-phase on the view so it fires only when the
      // view is focused (not the search bar) and before a newline is inserted.
      const keys = new Gtk.EventControllerKey();
      keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
      keys.on('key-pressed', (keyval: number, _keycode: number, state: number) => {
        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        if (ctrl && (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter)) {
          mode.onSubmit!(this.getText());
          return true;
        }
        return false;
      });
      this.view.addController(keys);
    }
  }

  // --- Search (`/` `?` `n` `N` `*` `#`) --------------------------------------

  private installSearch() {
    registerSearchKeymapsOnce();
    quilx.commands.add(this.view, {
      'editor:search-forward': () => this.searchBar.open(false),
      'editor:search-backward': () => this.searchBar.open(true),
      // n/N outside the bar repeat the last search (no-op when none is active).
      'editor:search-next': () => {
        if (this.search.hasActiveSearch) this.search.next();
      },
      'editor:search-previous': () => {
        if (this.search.hasActiveSearch) this.search.previous();
      },
      // `*`/`#`: search the word under the cursor forward/backward.
      'editor:search-word-forward': () => this.searchWordUnderCursor(false),
      'editor:search-word-backward': () => this.searchWordUnderCursor(true),
    });

    // Search-as-motion (`d/foo`): the vim layer requests multi-char input through
    // this bridge, which drives the SearchBar in motion mode and hands the seated
    // match back to the pending operator.
    (this.vimState as unknown as VimSearchBridge).setSearchInput?.(({ reverse, onConfirm, onCancel }) => {
      this.searchBar.openMotion(Boolean(reverse), { onConfirm, onCancel });
    });
  }

  /** vim `*`/`#`: search for the keyword under (or next on the line after) the
   *  cursor. No-op when the line has no word at/after the cursor. */
  private searchWordUnderCursor(reverse: boolean): void {
    const pos = this.editorModel.getCursorBufferPosition();
    const line = this.editorModel.lineTextForBufferRow(pos.row);
    const wordRe = /\w+/g;
    let match: RegExpExecArray | null;
    while ((match = wordRe.exec(line))) {
      // match.index/length are UTF-16; columns are codepoints — compare in codepoints.
      const wordEndColumn = [...line.slice(0, match.index + match[0].length)].length;
      if (wordEndColumn > pos.column) {
        this.search.searchWord(match[0], reverse);
        return;
      }
    }
  }

  // --- LSP integration -------------------------------------------------------

  private installLsp() {
    if (this.bufferMode) return; // no file, no language server
    this.lspDocument = {
      getPath: () => this._currentFile,
      getText: () => this.editorModel.getText(),
      lineTextForRow: (row) => this.editorModel.lineTextForBufferRow(row),
      getCursorBufferPosition: () => this.editorModel.getCursorBufferPosition(),
    };
    this.diagnostics = new DiagnosticsView(this.view, this.underlineOverlay, this.editorModel, () => this._currentFile);
    // Full-text sync: any buffer edit re-sends the whole document.
    this.editorModel.onDidChangeText(() => quilx.lsp.didChange(this.lspDocument));
    // The hover popover is anchored to a fixed cursor position; dismiss it once
    // the cursor moves or the view scrolls (both no-ops when nothing is showing).
    this.buffer.on('notify::cursor-position', () => this.dismissHover());
    this.view.getVadjustment()?.on('value-changed', () => this.dismissHover());
    // Tear down with the widget: close the document and drop diagnostics.
    this.root.on('destroy', () => {
      this.dismissHover();
      quilx.lsp.didClose(this.lspDocument);
      this.diagnostics.dispose();
    });
  }

  // --- Git gutter ------------------------------------------------------------

  private installGitGutter() {
    if (this.bufferMode || !this.gitRepo) return; // file mode with a repo only
    this.gitGutter = new GitGutter(
      this.view,
      () => this._currentFile,
      () => this.editorModel.getText(),
      this.gitRepo,
    );
    // Live updates: re-diff the buffer (debounced) on every edit.
    this.editorModel.onDidChangeText(() => this.gitGutter?.scheduleUpdate());
    this.root.on('destroy', () => this.gitGutter?.dispose());
  }

  /** The LSP document adapter for this editor (used by `lsp:*` commands). */
  get lsp(): LspDocument {
    return this.lspDocument;
  }

  /**
   * Show LSP hover (type/docs) for the symbol at the cursor in a floating card at
   * the cursor. No-op for a fileless buffer or when the server returns nothing.
   */
  async hover() {
    if (!this.lspDocument) return; // buffer-only editor, no language server
    const markdown = await quilx.lsp.hover(this.lspDocument);
    this.dismissHover();
    if (!markdown) return;
    const rect = this.editorModel.pixelRectForBufferPosition(this.editorModel.getCursorBufferPosition());
    if (!rect) return;

    // Code spans use the editor's monospace font (prose stays proportional) and
    // are tree-sitter highlighted; unlabeled fences fall back to this file's
    // language so same-language signatures still get colors.
    const fallbackLang = this._currentFile ? langIdForPath(this._currentFile) ?? undefined : undefined;
    this.hoverLabel.setMarkup(
      markdownToPango(markdown, {
        codeFontFamily: monospaceFontFamily(),
        highlightCode: (code, lang) => highlightToMarkup(code, lang ?? fallbackLang),
      }),
    );
    // Position by margins + bottom-left alignment: the overlay places the card's
    // bottom edge `HOVER_GAP` above the cursor (it grows upward) and its left edge
    // at the cursor — no need to know the card's height. Coordinates match the
    // caret's (same overlay, same widget-relative pixels).
    const ow = this.contentOverlay.getWidth();
    const oh = this.contentOverlay.getHeight();
    const left = ow > 0 ? Math.max(0, Math.min(rect.x, ow - HOVER_WIDTH_PX)) : rect.x;
    const bottom = oh > 0 ? Math.max(0, oh - rect.y + HOVER_GAP) : HOVER_GAP;
    this.hoverCard.setMarginStart(left);
    this.hoverCard.setMarginBottom(bottom);
    this.hoverCard.setVisible(true);
  }

  private dismissHover() {
    this.hoverCard.setVisible(false);
  }

  /** The inline decoration surface (search highlights, inline diff). */
  get decorations(): DecorationController {
    return this.decorationController;
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
    view.setAutoIndent(true);
    view.setTabWidth(TAB_WIDTH);
    view.setVexpand(true);
    view.setHexpand(true);
    // Line numbers are drawn by SyntaxController's fold-aware gutter (not the
    // built-in one, which mashes folded line numbers together), gated on
    // !bufferMode where SyntaxController is given `lineNumbers: true`.
    if (this.bufferMode) {
      // A plain embedded input: no right margin or current-line highlight; a
      // little padding so the text doesn't hug the edges.
      view.setShowRightMargin(false);
      view.setHighlightCurrentLine(false);
      view.setLeftMargin(8);
      view.setTopMargin(6);
      view.setBottomMargin(6);
    } else {
      view.setHighlightCurrentLine(true);
      view.setShowRightMargin(true);
      view.setRightMarginPosition(RIGHT_MARGIN);
    }
    return view;
  }

  private buildEditorArea() {
    const scrolled = new Gtk.ScrolledWindow();
    scrolled.setChild(this.view);
    scrolled.setHexpand(true);

    // Overlay the scrolled view with the editor-local widgets: the diagnostic
    // squiggle layer (under the caret/showcmd), the showcmd preview
    // (bottom-right), and the hollow-caret layer (positioned per-cursor).
    const overlay = new Gtk.Overlay();
    overlay.setChild(scrolled);
    this.contentOverlay = overlay; // hosts the bottom-aligned hover card

    // Built here (after the view is in the ScrolledWindow, so its scroll
    // adjustments exist); fed by DiagnosticsView in installLsp.
    this.underlineOverlay = new UnderlineOverlay(this.view, this.editorModel);
    overlay.addOverlay(this.underlineOverlay.widget);

    // The search/replace bar floats at the top-right; it adds itself to `overlay`.
    this.searchBar = new SearchBar(overlay, this.search, this.view, { onInfo: this.onToast });

    // Autocompletion: the popup floats in this overlay; sources are registered
    // here (buffer words + LSP — Copilot lands later). It is dismissed whenever
    // the vim layer leaves insert mode. The LSP source no-ops for a fileless
    // buffer (`lspDocument` undefined) or until a server is up.
    this.completion = new CompletionController(this.editorModel, overlay, () => this.vimState.mode === 'insert');
    this.completion.addSource(createBufferWordsSource(() => this.editorModel.getText()));
    this.completion.addSource(createLspCompletionSource(quilx.lsp, () => this.lspDocument ?? null));
    this.vimState.onDidActivateMode(({ mode }: { mode: string }) => {
      if (mode !== 'insert') this.completion.dismiss();
    });

    this.showcmdLabel.addCssClass('quilx-showcmd');
    this.showcmdLabel.addCssClass('monospace');
    this.showcmdLabel.setHalign(Gtk.Align.END);
    this.showcmdLabel.setValign(Gtk.Align.END);
    this.showcmdLabel.setVisible(false);
    this.showcmdLabel.setCanTarget(false); // never steal clicks
    overlay.addOverlay(this.showcmdLabel);

    this.caret.addCssClass('quilx-unfocused-caret');
    this.caret.setCanTarget(false);
    this.caretLayer.setCanTarget(false);
    this.caretLayer.put(this.caret, 0, 0);
    this.caret.setVisible(false);
    overlay.addOverlay(this.caretLayer);

    // LSP hover card: a non-interactive overlay positioned by margins +
    // bottom-left alignment, so the overlay bottom-aligns it (bottom edge at the
    // cursor, growing upward) without us needing to read its height. Prose stays
    // in the proportional UI font; only code spans are monospace (<tt>). Fixed
    // width (the label fills + wraps to it).
    this.hoverCard.addCssClass('quilx-hover');
    this.hoverCard.setSizeRequest(HOVER_WIDTH_PX, -1);
    this.hoverCard.setHalign(Gtk.Align.START);
    this.hoverCard.setValign(Gtk.Align.END);
    this.hoverCard.setCanTarget(false);
    this.hoverCard.append(this.hoverLabel);
    this.hoverCard.setVisible(false);
    overlay.addOverlay(this.hoverCard);

    // Buffer-only mode: a greyed placeholder over the empty buffer, and no minimap.
    if (this.bufferMode?.placeholder) {
      this.placeholderLabel = new Gtk.Label({ label: this.bufferMode.placeholder });
      this.placeholderLabel.addCssClass('quilx-placeholder');
      this.placeholderLabel.addCssClass('monospace');
      this.placeholderLabel.setHalign(Gtk.Align.START);
      this.placeholderLabel.setValign(Gtk.Align.START);
      this.placeholderLabel.setMarginStart(8);
      this.placeholderLabel.setMarginTop(6);
      this.placeholderLabel.setCanTarget(false);
      overlay.addOverlay(this.placeholderLabel);
      this.buffer.on('changed', () =>
        this.placeholderLabel!.setVisible(this.buffer.getCharCount() === 0),
      );
    }

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    box.append(overlay);
    if (!this.bufferMode) {
      // The minimap mirrors the view and doubles as a scrollbar. Off by default;
      // `editor.minimap` toggles it live.
      const minimap = new GtkSource.Map();
      minimap.setView(this.view);
      box.append(minimap);
      const sub = quilx.config.observe('editor.minimap', (v) => minimap.setVisible(v === true));
      box.on('destroy', () => sub.dispose());
    }
    return box;
  }

  // --- Cursor overlay (hollow caret while unfocused) -------------------------

  private installCursorOverlay() {
    // EditorModel decides how the caret renders (reverse-video tag on a glyph,
    // or an overlay box at positions with none / when unfocused) and drives this
    // — including on cursor-position changes, so a mouse click repositions it.
    this.editorModel.onCursorOverlay = (kind, iter) => this.renderCursorOverlay(kind, iter);

    const focus = new Gtk.EventControllerFocus();
    focus.on('enter', () => this.editorModel.setFocused(true));
    focus.on('leave', () => {
      // The search bar is part of the editor: while it holds focus, keep the
      // active caret rather than switching to the unfocused (inactive) one.
      if (this.searchBar.isOpen) return;
      this.editorModel.setFocused(false);
    });
    this.view.addController(focus);
  }

  /**
   * Render the caret overlay box at `iter`: a hollow rectangle when the view is
   * unfocused, a filled block where there's no glyph to reverse-video (empty
   * line / past EOL / EOF). `hidden` (or an unrealized view) hides it.
   */
  private renderCursorOverlay(kind: 'hidden' | 'hollow' | 'filled', iter?: unknown) {
    if (kind === 'hidden' || !iter || !this.view.getRealized()) {
      this.caret.setVisible(false);
      return;
    }
    // getIterLocation gives the character cell (buffer coords); convert to the
    // view's widget coords (accounts for the gutter and scroll position).
    const cell = (this.view as any).getIterLocation(iter) as { x: number; y: number; width: number; height: number };
    const [winX, winY] = (this.view as any).bufferToWindowCoords(Gtk.TextWindowType.WIDGET, cell.x, cell.y);
    // An empty line / EOL has near-zero cell width; fall back to a slim block.
    const width = cell.width > 1 ? cell.width : Math.max(2, Math.round(cell.height * 0.5));
    this.caret.setSizeRequest(width, cell.height);
    this.caretLayer.move(this.caret, winX, winY);
    this.caret.removeCssClass(kind === 'filled' ? 'quilx-unfocused-caret' : 'quilx-block-caret');
    this.caret.addCssClass(kind === 'filled' ? 'quilx-block-caret' : 'quilx-unfocused-caret');
    this.caret.setVisible(true);
  }

  // --- Pending-command preview (showcmd) -------------------------------------

  private installShowcmd() {
    // Accumulate the keystrokes of the in-flight command and show them, the way
    // vim's `showcmd` echoes a partial command. A keymap listener sees every key
    // before dispatch; after each key we clear once the editor returns to a
    // resting state (no queued keystrokes, empty operation stack, no count or
    // pending register). Only active while this view is focused and not inserting.
    quilx.keymaps.addListener((key) => {
      if (!(this.view as any).hasFocus() || this.vimState.mode === 'insert') return false;
      if (!key.isModifier() && key.string && key.string.charCodeAt(0) >= 0x20) {
        this.setShowcmd(this.showcmd + key.string);
      }
      // Recompute after dispatch: if nothing is pending, the command resolved.
      queueMicrotask(() => {
        if (this.isVimIdle()) this.setShowcmd('');
      });
      return false; // never consume; this is display-only
    });
  }

  private isVimIdle(): boolean {
    const stack = this.vimState.operationStack;
    const register = (this.vimState as any).__register;
    return (
      quilx.keymaps.queuedKeystrokes.length === 0 &&
      stack.isEmpty() &&
      !stack.hasCount() &&
      !register?.name
    );
  }

  private setShowcmd(text: string) {
    if (text === this.showcmd) return;
    this.showcmd = text;
    this.showcmdLabel.setLabel(text);
    this.showcmdLabel.setVisible(text.length > 0);
  }

  // --- Folding commands (vim za/zo/zc/zR/zM, via the keymap's z-prefix) -------

  private installFoldCommands() {
    // The fold keys live in the vim keymap (normal-mode, z-prefix); they dispatch
    // these commands on this view, which drive the SyntaxController. Registered
    // per-view so a keystroke folds the focused editor.
    quilx.commands.add(this.view, {
      'fold:toggle': () => this.syntax.toggleFoldAtCursor(),
      'fold:open': () => this.syntax.setFoldAtCursor(false),
      'fold:close': () => this.syntax.setFoldAtCursor(true),
      'fold:open-all': () => this.syntax.unfoldAll(),
      'fold:close-all': () => this.syntax.foldAll(),
    });

    // Keep the cursor visible: if a move (w, /, G, a click, …) lands it inside a
    // folded body, open the fold (Vim's `foldopen`). Closing a fold moves the
    // cursor to the still-visible header, so this never fights `fold:close`.
    this.buffer.on('notify::cursor-position', () => {
      this.syntax.revealLine(this.editorModel.getCursorBufferPosition().row);
    });
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
    if (this.bufferMode) return; // buffer-only editors have no file
    try {
      // Close any previously-open document first; the setText below then fires a
      // change against the (now closed) old doc, which the manager ignores.
      quilx.lsp.didClose(this.lspDocument);
      const content = Fs.readFileSync(path, 'utf8');
      this.buffer.setText(content, -1);
      this.buffer.placeCursor(this.buffer.getStartIter());
      // setText marks the buffer modified; the freshly-loaded content matches
      // disk, so clear the flag — `isModified()` then tracks genuine edits.
      this.buffer.setModified(false);
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
      // Open the document with the language server and refresh diagnostics (clears
      // any tags carried over from a previously-loaded file).
      quilx.lsp.didOpen(this.lspDocument);
      this.diagnostics.render();
      this.gitGutter?.refresh();
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
      this.buffer.setModified(false);
      this._currentFile = path;
      quilx.lsp.didSave(this.lspDocument);
      this.gitGutter?.refresh();
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

  /** The currently selected text (empty string when there is no selection). */
  getSelectedText(): string {
    return this.editorModel.getSelectedText();
  }

  /** The tab/window title for this editor (file basename, or "Untitled"). */
  get title(): string {
    return this._currentFile ? Path.basename(this._currentFile) : 'Untitled';
  }

  focus() {
    this.view.grabFocus();
  }

  // --- Session integration ---------------------------------------------------

  /** Session state for this tab, or `null` for an unsaved/empty editor. */
  serialize(): TabState | null {
    if (!this._currentFile) return null;
    const cursor = this.editorModel.getCursorBufferPosition();
    return { kind: 'file', path: this._currentFile, cursor: [cursor.row, cursor.column] };
  }

  /** Restore a saved cursor position (clamped to the buffer) and reveal it. */
  restoreCursor(cursor: [number, number]) {
    this.editorModel.setCursorBufferPosition({ row: cursor[0], column: cursor[1] });
    this.view.scrollToMark(this.buffer.getInsert(), 0, true, 0.5, 0.5);
  }

  /** True while the buffer holds unsaved edits — drives the exit prompt. */
  isModified(): boolean {
    return this.buffer.getModified();
  }

  /** Exit-prompt label, e.g. "foo.ts (unsaved)". */
  getModifiedLabel(): string {
    return `${this.title} (unsaved)`;
  }

  /** Flush unsaved edits to the current file (no-op for an untitled buffer). */
  saveModified(): void {
    this.save();
  }

  /** Subscribe to title changes (fired when the editor's file changes). */
  onTitleChange(callback: () => void) {
    this.titleHandlers.push(callback);
  }

  private emitTitleChange() {
    for (const callback of this.titleHandlers) callback();
  }

  /** Subscribe to modified-state changes (the buffer's modified flag toggling). */
  onModifiedChange(callback: () => void) {
    this.modifiedHandlers.push(callback);
  }
}
