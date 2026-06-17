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
import { detectIndentation } from './detectIndentation.ts';
import { handleAutoPairInsert, handleAutoPairBackspace } from './autoPair.ts';
import { handleTagAutoClose } from './tagClose.ts';
import { Range } from '../../text/Range.ts';
import { Point } from '../../text/Point.ts';
import type { TagName } from '../../syntax/tags.ts';
import { theme } from '../../theme/theme.ts';
import { createSourceScheme } from '../../theme/createSourceScheme.ts';
import { addStyles } from '../../styles.ts';
import { EditorModel } from './EditorModel.ts';
import { Document, type DocumentHost } from './Document.ts';
import { InlayHintController } from './InlayHintController.ts';
import { attachVim } from './vim/index.ts';
import { quilx } from '../../quilx.ts';
import { DiagnosticsView } from '../../lsp/diagnostics/DiagnosticsView.ts';
import { markdownToPango } from '../markdownMarkup.ts';
import { fonts } from '../../fonts.ts';
import { highlightToMarkup } from '../../syntax/highlightToMarkup.ts';
import { langIdForPath } from '../../syntax/grammar.ts';
import { DecorationController } from './DecorationController.ts';
import { InlineBlockController } from './InlineBlockController.ts';
import { InlinePeek, type InlinePeekOptions } from './InlinePeek.ts';
import { GitGutter } from './GitGutter.ts';
import { UnderlineOverlay } from './UnderlineOverlay.ts';
import { IndentGuideOverlay } from './IndentGuideOverlay.ts';
import { SearchController } from './SearchController.ts';
import { SearchBar } from './SearchBar.ts';
import { LeapController, type LeapRequest } from './LeapController.ts';
import { CompletionController } from './CompletionController.ts';
import { createBufferWordsSource } from './createBufferWordsSource.ts';
import { createLspCompletionSource } from './createLspCompletionSource.ts';
import type { LspDocument } from '../../lsp/LspManager.ts';
import { lspToRange } from '../../lsp/position.ts';
import { replaceOverwrite, replaceBackspace } from './replaceMode.ts';
import type { PositionEncoding } from '../../lsp/position.ts';
import type { TextEdit, SignatureHelp, ParameterInformation } from 'vscode-languageserver-protocol';
import { escapeMarkup } from '../Picker.ts';
import type { GitRepo } from '../../git.ts';
import type { TabState } from '../../SessionManager.ts';
import {
  Adw,
  Gdk,
  GLib,
  Gtk,
  GtkSource,
  type SourceBuffer,
  type SourceView,
} from '../../gi.ts';

addStyles(`
  .quilx-editor { color: ${theme.ui.fg}; caret-color: ${theme.ui.fg}; }
  /* Pending-command preview ("showcmd"), floated in the editor's bottom-right. */
  .quilx-showcmd {
    background-color: ${theme.ui.bg ?? theme.ui.popoverBg};
    color: ${theme.ui.fg};
    opacity: 0.75;
    padding: 1px 6px;
    margin: 4px;
    border-radius: 4px;
  }
  /* Hollow caret shown over the cursor's character while the editor is unfocused. */
  .quilx-unfocused-caret {
    border: 1.5px solid ${theme.ui.textMuted};
    border-radius: 1px;
  }
  /* Filled caret block for positions with no glyph to reverse-video (empty line,
     past end-of-line, end-of-buffer). */
  .quilx-block-caret {
    background-color: ${theme.ui.fg};
    border-radius: 1px;
  }
  /* Beam caret for extra (multi-cursor) carets in insert mode — a thin vertical
     bar, like the primary insert-mode caret. */
  .quilx-beam-caret {
    background-color: ${theme.ui.fg};
  }
  /* Buffer-only mode: greyed placeholder shown over an empty buffer. */
  .quilx-placeholder {
    color: ${theme.ui.textMuted};
    opacity: 0.6;
  }
  /* LSP hover card: a floating tooltip over the editor. */
  .quilx-hover {
    background-color: ${theme.ui.popoverBg};
    color: ${theme.ui.fg};
    border: 1px solid alpha(${theme.ui.fg}, 0.2);
    border-radius: 6px;
    padding: 6px 8px;
    box-shadow: 0 1px 3px ${theme.ui.shadow};
  }
`);

const TAB_WIDTH = 4;
const RIGHT_MARGIN = 80;
// LSP hover card width (px) — set as a size request, since GtkFixed sizes its
// children to their *minimum* width (it ignores GtkLabel max-width-chars). The
// label fills this width and wraps. HOVER_GAP keeps the card clear of the cursor.
const HOVER_WIDTH_PX = 300;
const HOVER_GAP = 4;
// Left inset of a `.quilx-hover` card's text (1px border + 8px padding); the
// signature card shifts left by this so its text lines up with the code column.
const CARD_CONTENT_INSET_PX = 9;
// Settle the autopair `()` insert + cursor move before requesting signature help.
const SIGNATURE_DEBOUNCE_MS = 40;

type VimState = ReturnType<typeof attachVim>;

// The vim layer asks for multi-char (search) input through this seam; TextEditor
// fulfils it with the SearchBar. `matchStart` is null when the search is cancelled.
interface SearchInputRequest {
  reverse?: boolean;
  onConfirm(matchStart: import('../../text/Point.ts').Point | null): void;
  onCancel(): void;
}
type VimSearchBridge = { setSearchInput?(provider: (req: SearchInputRequest) => void): void };
type VimLeapBridge = { setLeapInput?(provider: (req: LeapRequest) => void): void };
type VimGlobalStateBridge = { globalState?: { set(key: string, value: unknown): void } };

// Search keybindings are registered once globally (per-view command handlers are
// added per editor in installSearch). Normal mode only: `/`/`?` open the bar,
// `n`/`N` repeat the last search.
let searchKeymapsRegistered = false;
function registerSearchKeymapsOnce(): void {
  if (searchKeymapsRegistered) return;
  searchKeymapsRegistered = true;
  quilx.keymaps.add('editor-search', {
    '#TextEditor.normal-mode': {
      '/': 'editor:search-forward',
      '?': 'editor:search-backward',
      n: 'editor:search-next',
      N: 'editor:search-previous',
      '*': 'editor:search-word-forward',
      'g /': 'editor:search-word-forward', // same as `*`
      '#': 'editor:search-word-backward',
      'g *': 'editor:search-word-forward-loose',
      'g #': 'editor:search-word-backward-loose',
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
  /** The shared `Document` this view attaches to (from `quilx.documents`). When given,
   *  this view is one of N onto it and releases its ref on teardown via
   *  `onReleaseDocument`; when omitted, the editor owns a private scratch document. */
  document?: Document;
  /** Called on teardown for a registry-owned `document` (drop this view's ref). */
  onReleaseDocument?: () => void;
  /** Read-only, compact view onto the given `document` — the live see-definition peek
   *  (a second view of an open file). Requires `document`. */
  peek?: boolean;
}

export interface BufferEditorOptions {
  /** Greyed text shown over the empty buffer. */
  placeholder?: string;
  /** Initial buffer contents. */
  initialText?: string;
  /** Fired on the submit gesture (Ctrl+Enter) with the current text. */
  onSubmit?: (text: string) => void;
  /** Non-editable view (vim navigation only) — for diff panes and other viewers. */
  readOnly?: boolean;
  /** A file path/name whose extension selects the tree-sitter grammar, so an
   *  embedded buffer (e.g. a diff pane) still gets syntax highlighting. */
  languagePath?: string;
  /** Tree-sitter code folding (chevron gutter). Defaults on; diff panes turn it
   *  off — they fold by unchanged-region (DiffFold), not by code structure. */
  folding?: boolean;
}

// Syntax-highlight a signature fragment (falling back to plain escaped text when
// the language has no grammar). The whole label is the language's code.
function highlightFragment(text: string, lang: string | undefined): string {
  return (lang && highlightToMarkup(text, lang)) || escapeMarkup(text);
}

// Codepoint column where the active call's callee name begins, so the signature
// card anchors at the function name (not the `(`). Walks left from `cursorCol`
// to the call's open paren (depth-aware, so nested calls resolve to the innermost
// enclosing one), then back over the callee chain (`foo`, `obj.method`). Returns
// null when the open paren / a name isn't on this line (then we fall back).
function callNameStartColumn(line: string[], cursorCol: number): number | null {
  let depth = 0;
  let i = cursorCol - 1;
  for (; i >= 0; i--) {
    const ch = line[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      if (depth === 0) break;
      depth--;
    }
  }
  if (i < 0 || line[i] !== '(') return null;
  let end = i;
  while (end > 0 && /\s/.test(line[end - 1])) end--; // skip whitespace before `(`
  let start = end;
  while (start > 0 && /[\w$.]/.test(line[start - 1])) start--; // the callee name chain
  return start < end ? start : null;
}

// Build Pango markup for a signature label: syntax-highlighted, with the active
// parameter bolded. `param.label` is either a substring of the signature or
// `[start, end]` offsets into it (labelOffsetSupport, which we advertise).
function signatureMarkup(
  label: string,
  parameters: ParameterInformation[] | undefined,
  activeParam: number | undefined,
  lang: string | undefined,
): string {
  const param = activeParam !== undefined ? parameters?.[activeParam] : undefined;
  let range: [number, number] | undefined;
  if (param) {
    if (Array.isArray(param.label)) range = [param.label[0], param.label[1]];
    else {
      const idx = label.indexOf(param.label);
      if (idx >= 0) range = [idx, idx + param.label.length];
    }
  }
  if (!range) return highlightFragment(label, lang);
  const [start, end] = range;
  return (
    highlightFragment(label.slice(0, start), lang) +
    `<b>${highlightFragment(label.slice(start, end), lang)}</b>` +
    highlightFragment(label.slice(end), lang)
  );
}

/** What the editor's `fold:*` commands drive — SyntaxController by default, or a
 *  diff pane's DiffFold. (SyntaxController already satisfies this structurally.) */
export interface FoldProvider {
  toggleFoldAtCursor(): void;
  setFoldAtCursor(folded: boolean): void;
  foldAll(): void;
  unfoldAll(): void;
  revealLine(row: number): void;
}

export class TextEditor implements DocumentHost {
  readonly root: InstanceType<typeof Gtk.Box>;

  // Guards dispose(): cleanup may be driven both explicitly (the tab-close path
  // calls dispose() directly) and by the GTK `destroy` signal fallback below, so
  // tearing down twice must be a no-op.
  private disposed = false;

  // The document this editor is a *view* onto (owns the text model + undo + file I/O +
  // LSP). `this.buffer` is this view's own GtkSource.Buffer, kept in sync by the
  // document — separate from other views' buffers, so cursor/selection/folds/decorations
  // are native and independent per view (the A2 document-model architecture).
  private readonly document: Document;
  private readonly releaseDocument: (() => void) | null;
  private readonly buffer: SourceBuffer;
  private readonly view: SourceView;
  private readonly syntax: SyntaxController;
  // What the vim `fold:*` commands drive. Defaults to the tree-sitter folder
  // (SyntaxController); a diff pane swaps in its own DiffFold (unchanged-region
  // folds) via `setFoldProvider`, since it runs SyntaxController folding off.
  private foldProvider: FoldProvider | null = null;
  private readonly editorModel: EditorModel;
  private readonly vimState: VimState;
  private readonly decorationController: DecorationController;
  private readonly inlineBlockController: InlineBlockController;
  private readonly search: SearchController;
  private leap!: LeapController; // built in buildEditorArea (needs the overlay)
  private completion!: CompletionController; // built in buildEditorArea (needs the overlay)
  private searchBar!: SearchBar; // built in buildEditorArea (needs the overlay)
  private underlineOverlay!: UnderlineOverlay; // drawn diagnostic squiggles; built in buildEditorArea
  private readonly onToast: (message: string) => void;

  // LSP: a document adapter the LspManager drives, and the per-editor diagnostics
  // renderer. Wired in `installLsp` once the model and root exist.
  private lspDocument!: LspDocument;
  private diagnostics!: DiagnosticsView;
  private inlayHints!: InlayHintController;
  // Git change bar in the gutter; only present in file mode when a repo is given.
  private gitGutter: GitGutter | null = null;
  // The LSP hover card: a non-interactive overlay floated in `caretLayer` at the
  // cursor (the proven Fixed-overlay pattern, not a GtkPopover). Hidden until shown.
  private readonly hoverLabel = new Gtk.Label({ useMarkup: true, wrap: true, xalign: 0 });
  // Vertical box so the label fills (and wraps to) the card's fixed width.
  private readonly hoverCard = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  private contentOverlay!: InstanceType<typeof Gtk.Overlay>; // hosts the hover card
  private inlinePeek!: InlinePeek; // focusable inline peek (see-definition); built in buildEditorArea
  // The signature-help card: shown live while typing a call's arguments. Same
  // floating-card pattern as hover; `signatureSeq` drops stale async responses.
  private readonly signatureLabel = new Gtk.Label({ useMarkup: true, wrap: true, xalign: 0 });
  private readonly signatureCard = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  private signatureSeq = 0;
  private signatureTimer = 0;
  // Whether the signature card's position is fixed for the current call (set on
  // first show, cleared on dismiss) — so it stays put as arguments are typed.
  private signatureAnchored = false;

  // Editor-local overlays: the pending-command preview (showcmd) and the
  // hollow-rectangle caret shown while the view is unfocused.
  private readonly showcmdLabel = new Gtk.Label({ label: '' });
  private readonly caretLayer = new Gtk.Fixed();
  private readonly caret = new Gtk.Box();
  // The leap (`g s`) jump-label overlay: floated single-char labels live here.
  private readonly leapLayer = new Gtk.Fixed();
  // Pool of caret widgets for the extra (multi-cursor) carets, grown on demand
  // and hidden when unused. Driven by `editorModel.onExtraCursors`.
  private readonly extraCarets: InstanceType<typeof Gtk.Box>[] = [];
  private showcmd = '';

  // Buffer-only mode config (null = a normal file editor), and the placeholder
  // label shown over the empty buffer (only built when a placeholder is given).
  private readonly bufferMode: BufferEditorOptions | null;
  // A read-only, compact view onto a shared Document — the live see-definition peek (a
  // second view of an open file). File-backed (unlike bufferMode), but not edited.
  private readonly peekMode: boolean;
  private readonly gitRepo: GitRepo | null;
  private placeholderLabel: InstanceType<typeof Gtk.Label> | null = null;

  // File I/O, disk-watching, modified-state, title, and the LSP document all live on
  // `this.document` now; this getter keeps the many `_currentFile` read sites unchanged.
  private get _currentFile(): string | null {
    return this.document.currentFile;
  }
  // Caret captured before a silent reload (so the post-load host hook restores it).
  private pendingReloadCaret: [number, number] | null = null;

  constructor(options: TextEditorOptions = {}) {
    this.onToast = options.onToast ?? (() => {});
    this.bufferMode = options.buffer ?? null;
    this.peekMode = options.peek ?? false;
    this.gitRepo = options.git ?? null;

    // A registry-owned document is shared (this view releases its ref on teardown); a
    // buffer-only editor owns a private scratch document. Either way this view gets its
    // OWN buffer from the document, kept in sync with the model and the other views.
    this.document = options.document ?? new Document();
    this.releaseDocument = options.document ? (options.onReleaseDocument ?? null) : null;
    this.buffer = this.document.createView();
    this.lspDocument = this.document.lspDocument;
    this.view = this.createView(this.buffer);
    // Tree-sitter highlighting + folding for this view/buffer. A buffer-only or peek
    // view is compact: no line-number gutter, folding off.
    const compact = !!this.bufferMode || this.peekMode;
    this.syntax = new SyntaxController(this.view, this.buffer, {
      lineNumbers: !compact,
      folding: this.bufferMode?.folding ?? (this.peekMode ? false : undefined),
    });
    // The buffer/cursor model the custom vim layer drives.
    this.editorModel = new EditorModel(this.view, this.buffer);
    // Undo/redo run on the document model (this view's buffer has native undo off).
    this.editorModel.setUndoTarget(this.document);
    // Real (tree-sitter) indent source for `=`/paste-reindent/new lines.
    this.editorModel.setIndentSource((row) => this.syntax.indentLevelForRow(row));
    // Default indentation from config; `loadFile` detects and overrides per file.
    this.editorModel.setIndentation({
      useSpaces: quilx.config.get('editor.insertSpaces') !== false,
      width: (quilx.config.get('editor.tabLength') as number) || TAB_WIDTH,
    });
    // Let motions see/reveal folds (the fold state lives in SyntaxController).
    this.editorModel.setFoldProvider({
      isFoldedAtRow: (row) => this.syntax.isLineHidden(row),
      unfoldRow: (row) => this.syntax.unfoldRow(row),
      foldableRanges: () => this.syntax.foldRegions(),
      functionRangeAt: (row, column) => this.syntax.functionRangeAt(row, column),
      classRangeAt: (row, column) => this.syntax.classRangeAt(row, column),
    });

    // Modal editing runs through the vendored vim-mode-plus core.
    this.vimState = attachVim(this.editorModel);
    // Inline decoration surface (search highlights, inline diff) — consumers
    // reach it via `editor.decorations`.
    this.decorationController = new DecorationController(this.editorModel);
    // Inline block surface (virtual content between lines: the diff fold placeholder).
    this.inlineBlockController = new InlineBlockController(this.view);
    // Search/replace engine; its `SearchBar` widget is built in buildEditorArea.
    this.search = new SearchController(this.editorModel, this.decorationController);

    this.root = this.buildEditorArea();
    // The inner view is the `#TextEditor` selector subject (it holds focus + the
    // mode CSS classes — see EditorModel); the wrapping area gets its own name so
    // the two don't both answer to `#TextEditor`.
    this.root.setName('TextEditorArea');

    this.installFoldCommands();
    this.installAutoPair();
    this.installCursorOverlay();
    this.installShowcmd();
    this.followSystemColorScheme();
    // The document routes load/save reactions + the LSP cursor here; this view becomes
    // active on focus. A document can have several views (split / peek).
    this.document.addHost(this);
    this.installLsp();
    this.installGitGutter();
    this.installSearch();
    if (this.bufferMode) this.installBufferMode(this.bufferMode);
    if (this.peekMode) {
      // Read-only viewer onto the shared buffer; start unfocused so it shows no caret
      // until the user clicks into it.
      this.view.setEditable(false);
      this.editorModel.setFocused(false);
    }
    // Fallback teardown: the tab-close path disposes us explicitly, but also tear
    // down if the widget is destroyed by any other route (dispose() is idempotent).
    this.root.on('destroy', () => this.dispose());
  }

  // --- Buffer-only mode ------------------------------------------------------

  /** The current buffer text. */
  getText(): string {
    return this.editorModel.getText();
  }

  /** Replace the text (clears the modified flag, cursor to start). Routes through the
   *  document so the model + every view + the modified flag stay consistent. */
  setText(text: string): void {
    this.document.setText(text);
    this.editorModel.setCursorBufferPosition({ row: 0, column: 0 });
  }

  /** Switch tree-sitter highlighting to match `path`'s file type (buffer/preview mode). */
  setLanguageForPath(path: string): void {
    this.syntax.setLanguageForPath(path);
  }

  private installBufferMode(mode: BufferEditorOptions): void {
    if (mode.initialText) this.setText(mode.initialText);
    this.placeholderLabel?.setVisible(this.buffer.getCharCount() === 0);
    // Tree-sitter highlighting from the compared file's type (after the text is set,
    // so the first parse sees it). Grammars must be preloaded (preloadGrammars).
    if (mode.languagePath) this.syntax.setLanguageForPath(mode.languagePath);
    // Read-only viewer (e.g. a diff pane): block edits at the view; vim normal-mode
    // navigation still works, and insert-mode keystrokes simply do nothing. Start
    // unfocused so a freshly-shown pane has no caret until it's actually focused
    // (otherwise both side-by-side panes would show one at creation).
    if (mode.readOnly) {
      this.view.setEditable(false);
      this.editorModel.setFocused(false);
    }

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
      // `*`/`#`: whole-word search of the word under the cursor; `g*`/`g#` match
      // substrings too.
      'editor:search-word-forward': () => this.searchWordUnderCursor(false, true),
      'editor:search-word-backward': () => this.searchWordUnderCursor(true, true),
      'editor:search-word-forward-loose': () => this.searchWordUnderCursor(false, false),
      'editor:search-word-backward-loose': () => this.searchWordUnderCursor(true, false),
    });

    // Search-as-motion (`d/foo`): the vim layer requests multi-char input through
    // this bridge, which drives the SearchBar in motion mode and hands the seated
    // match back to the pending operator.
    (this.vimState as unknown as VimSearchBridge).setSearchInput?.(({ reverse, onConfirm, onCancel }) => {
      this.searchBar.openMotion(Boolean(reverse), { onConfirm, onCancel });
    });

    // Publish the active search pattern to the vim layer so the `gn`/`gN`
    // (SearchMatch) text objects — e.g. `cgn`, `dgn` — operate on it.
    this.search.setPatternListener((regex) =>
      (this.vimState as unknown as VimGlobalStateBridge).globalState?.set('lastSearchPattern', regex),
    );

    // `:noh`-style clear: reset-normal-mode (Esc) drops the search highlights when
    // `clearHighlightSearchOnResetNormalMode` is on. The query is kept, so `n`/`N`
    // re-highlight on demand.
    this.vimState.onDidRequestClearSearchHighlight(() => this.search.clear());

    // Leap (`g s` / `g S`): the vim motion requests a target through this bridge;
    // the LeapController reads the chars, paints labels, and resolves a Point.
    (this.vimState as unknown as VimLeapBridge).setLeapInput?.((req) => {
      void this.leap.start(req);
    });
  }

  /** vim `*`/`#`: search for the keyword under (or next on the line after) the
   *  cursor. No-op when the line has no word at/after the cursor. */
  private searchWordUnderCursor(reverse: boolean, wholeWord: boolean): void {
    const pos = this.editorModel.getCursorBufferPosition();
    const line = this.editorModel.lineTextForBufferRow(pos.row);
    const wordRe = /\w+/g;
    let match: RegExpExecArray | null;
    while ((match = wordRe.exec(line))) {
      // match.index/length are UTF-16; columns are codepoints — compare in codepoints.
      const wordEndColumn = [...line.slice(0, match.index + match[0].length)].length;
      if (wordEndColumn > pos.column) {
        this.search.searchWord(match[0], reverse, wholeWord);
        return;
      }
    }
  }

  // --- LSP integration -------------------------------------------------------

  private installLsp() {
    if (this.bufferMode) return; // no file, no language server
    // The LSP document lives on `this.document` (one per file; didOpen/didChange/
    // didClose are driven there off the model). This view contributes the diagnostics
    // renderer and signature help.
    this.diagnostics = new DiagnosticsView(this.view, this.underlineOverlay, this.editorModel, () => this._currentFile);
    // Inlay hints (parameter names / inferred types) trailing each line, per view.
    this.inlayHints = new InlayHintController(this.view, () => this.lspDocument ?? null);
    quilx.config.observe('editor.inlayHints', () => void this.inlayHints.refresh());
    // Signature help is a per-view concern (the active view shows the card while
    // typing); the document drives didChange, so this only triggers signature help.
    this.editorModel.onDidChangeText((event) => {
      this.maybeSignatureHelp(event);
      this.inlayHints.scheduleRefresh(); // hints shift as the text changes
    });
    // The hover popover is anchored to a fixed cursor position; dismiss it once
    // the cursor moves or the view scrolls (both no-ops when nothing is showing).
    this.buffer.on('notify::cursor-position', () => {
      this.dismissHover();
      if (this.signatureCard.getVisible()) this.scheduleSignatureRequest();
    });
    this.view.getVadjustment()?.on('value-changed', () => {
      this.dismissHover();
      this.dismissSignature();
    });
    // Leaving insert mode (or destroying) closes the signature card.
    this.vimState.onDidActivateMode(({ mode }: { mode: string }) => {
      if (mode !== 'insert') this.dismissSignature();
    });
  }

  /** Tear this view down: detach from the document (the registry disposes it — closing
   *  the shared LSP doc + file monitor — only when the last view goes; a scratch
   *  buffer-only document is disposed directly), and drop the diagnostics renderer. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dismissHover();
    this.dismissSignature();
    this.syntax.dispose(); // detach buffer/view signal handlers + free the tree-sitter tree
    this.document.removeHost(this);
    this.document.removeView(this.buffer);
    if (this.releaseDocument) this.releaseDocument();
    else this.document.dispose();
    this.diagnostics?.dispose(); // undefined for a buffer-only editor (installLsp skipped)
    this.inlayHints?.dispose();
  }

  // Request signature help when typing inside a call. Triggered when a trigger
  // char (`(`, `,`) appears in the *typed text* — not the char before the cursor,
  // which autopair leaves as the auto-inserted `)` — or while the card is already
  // up (to track the active parameter / detect leaving the call). Debounced so the
  // autopair's `()` insert + cursor move settle before we ask; the request then
  // uses the settled cursor, and a null result (cursor left the call) hides it.
  private maybeSignatureHelp(event: { changes: { newText: string }[] }) {
    if (this.vimState.mode !== 'insert') return;
    const triggers = quilx.lsp.signatureHelpTriggerCharacters(this.lspDocument);
    const typed = event.changes.map((c) => c.newText).join('');
    const typedTrigger = [...typed].some((ch) => triggers.includes(ch));
    if (!this.signatureCard.getVisible() && !typedTrigger) return;
    this.scheduleSignatureRequest();
  }

  // Debounced (re)request — coalesces the autopair edits + cursor moves of one
  // keystroke into a single request against the settled cursor.
  private scheduleSignatureRequest() {
    if (this.signatureTimer) GLib.sourceRemove(this.signatureTimer);
    this.signatureTimer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, SIGNATURE_DEBOUNCE_MS, () => {
      this.signatureTimer = 0;
      this.requestSignatureHelp();
      return false;
    });
  }

  private requestSignatureHelp() {
    const seq = ++this.signatureSeq;
    void quilx.lsp.signatureHelp(this.lspDocument).then((help) => {
      if (seq !== this.signatureSeq) return; // superseded by a newer keystroke
      if (help && help.signatures.length > 0) this.showSignature(help);
      else this.dismissSignature();
    });
  }

  // Render the active signature (syntax-highlighted, active parameter bolded).
  // The card is anchored to the call site once (when it first opens) and stays
  // there as you type arguments — only its content updates — rather than drifting
  // right with the cursor. The anchor is cleared on dismiss / re-evaluated on the
  // next call.
  private showSignature(help: SignatureHelp) {
    const sig = help.signatures[help.activeSignature ?? 0] ?? help.signatures[0];
    if (!sig) return;
    const activeParam = sig.activeParameter ?? help.activeParameter ?? undefined;
    const lang = this._currentFile ? langIdForPath(this._currentFile) ?? undefined : undefined;
    this.signatureLabel.setMarkup(
      `<span face="${fonts.monospaceFamily}">${signatureMarkup(sig.label, sig.parameters, activeParam, lang)}</span>`,
    );
    if (!this.signatureAnchored) {
      // Anchor at the callee name's start (fall back to the cursor if not found).
      const cursor = this.editorModel.getCursorBufferPosition();
      const line = [...this.editorModel.lineTextForBufferRow(cursor.row)];
      const nameCol = callNameStartColumn(line, cursor.column);
      const anchor = nameCol !== null ? { row: cursor.row, column: nameCol } : cursor;
      const rect = this.editorModel.pixelRectForBufferPosition(anchor);
      if (!rect) return;
      const ow = this.contentOverlay.getWidth();
      const oh = this.contentOverlay.getHeight();
      // Shift left by the card's content inset (border + padding) so the signature
      // text lines up with the code column rather than the card's edge.
      const x = rect.x - CARD_CONTENT_INSET_PX;
      this.signatureCard.setMarginStart(ow > 0 ? Math.max(0, Math.min(x, ow - HOVER_WIDTH_PX)) : Math.max(0, x));
      this.signatureCard.setMarginBottom(oh > 0 ? Math.max(0, oh - rect.y + HOVER_GAP) : HOVER_GAP);
      this.signatureAnchored = true;
    }
    this.signatureCard.setVisible(true);
  }

  private dismissSignature() {
    if (this.signatureTimer) {
      GLib.sourceRemove(this.signatureTimer);
      this.signatureTimer = 0;
    }
    this.signatureSeq++; // invalidate any in-flight request
    this.signatureAnchored = false; // the next call re-anchors at its own site
    this.signatureCard.setVisible(false);
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
    // Let the vim layer reach the gutter's hunk ranges (for `]h`/`[h`).
    this.editorModel.setHunkProvider(() => this.gitGutter?.hunkStartRows() ?? []);
    // Live updates: re-diff the buffer (debounced) on every edit.
    this.editorModel.onDidChangeText(() => this.gitGutter?.scheduleUpdate());
    this.root.on('destroy', () => this.gitGutter?.dispose());
  }

  /** The LSP document adapter for this editor (used by `lsp:*` commands). */
  get lsp(): LspDocument {
    return this.lspDocument;
  }

  /**
   * Apply LSP `TextEdit`s (a code action / rename / format result) to this
   * editor's buffer. Converts each range with the negotiated `encoding` and
   * applies last-first, so earlier ranges stay valid; goes through the normal
   * buffer edit path (so it's a single undo group and updates decorations).
   */
  applyLspEdits(edits: TextEdit[], encoding: PositionEncoding): void {
    const lineAt = (row: number) => this.editorModel.lineTextForBufferRow(row);
    const ranges = edits
      .map((e) => ({ range: lspToRange(e.range, lineAt, encoding), text: e.newText }))
      .sort((a, b) => b.range.start.compare(a.range.start));
    for (const { range, text } of ranges) this.editorModel.setTextInBufferRange(range, text);
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
        codeFontFamily: fonts.monospaceFamily,
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

  /** The editor model (Atom-`TextEditor`-shaped buffer API) — for features and
   *  plugins that scan or observe text, e.g. the color-preview plugin's tinting. */
  get model(): EditorModel {
    return this.editorModel;
  }

  /** The inline-block surface (virtual content between lines, e.g. the diff fold
   *  placeholder) — overlay widgets in a reserved gap, zero buffer footprint. */
  get inlineBlocks(): InlineBlockController {
    return this.inlineBlockController;
  }

  /** Open a focusable inline peek (e.g. see-definition) below `line` — defaults to
   *  the cursor's line. Replaces any current peek. Returns nothing; `closePeek()`
   *  dismisses it (and clicking a close button in `widget` should call it). */
  showPeek(options: Omit<InlinePeekOptions, 'line'> & { line?: number }): void {
    const line = options.line ?? this.editorModel.getCursorBufferPosition().row;
    this.inlinePeek.show({ ...options, line });
  }

  /** Dismiss the inline peek, if open. */
  closePeek(): void {
    this.inlinePeek.close();
  }

  /** Reveal `row` near the top of this (peek) view. `map` fires before the first
   *  layout pass (line geometry is still 0), so scroll on a tick callback that retries
   *  until the view has a real height. */
  revealPeekRow(row: number): void {
    this.editorModel.setCursorBufferPosition({ row, column: 0 });
    let frames = 0;
    const tick = () => {
      if (this.view.getRealized() && this.view.getHeight() > 0) {
        this.editorModel.scrollToBufferPosition({ row, column: 0 });
        return false; // G_SOURCE_REMOVE
      }
      return ++frames < 120; // keep trying ~2s then give up
    };
    (this.view as any).on('map', () => (this.view as any).addTickCallback(tick));
  }

  /** Whether an inline peek is currently open. */
  get peekOpen(): boolean {
    return this.inlinePeek.isOpen;
  }

  /** The underlying GtkSource.View — for attaching gutter renderers (e.g. the
   *  diff gutter) the way `GitGutter` does. */
  get sourceView(): SourceView {
    return this.view;
  }

  // --- Source view & buffer --------------------------------------------------

  /** Whether the current file's language uses JSX/HTML tags (gates tag auto-close
   *  — so plain `.ts` generics like `Array<T>` never auto-close). */
  private isTagLanguage(): boolean {
    const lang = this._currentFile ? langIdForPath(this._currentFile) : null;
    return lang !== null && /^(tsx|html|xml|vue|svelte)$/.test(lang);
  }

  /** The JSX/HTML tag-name ranges (opening + closing, or one self-closing) at the
   *  cursor — for `tag:rename`. Null when not on a tag. */
  tagNamesAtCursor(): TagName[] | null {
    const pos = this.editorModel.getCursorBufferPosition();
    return this.syntax.tagNamesAt(pos.row, pos.column);
  }

  /** Replace every given tag-name range with `newName`, as a single undo step
   *  (last → first so earlier ranges keep their positions). */
  applyTagRename(names: TagName[], newName: string): void {
    const ordered = [...names].sort((a, b) => b.startRow - a.startRow || b.startColumn - a.startColumn);
    this.editorModel.transact(() => {
      for (const n of ordered) {
        this.editorModel.setTextInBufferRange(
          new Range(new Point(n.startRow, n.startColumn), new Point(n.endRow, n.endColumn)),
          newName,
        );
      }
    });
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
      // Soft-wrap (live-toggled by `editor.softWrap`): wrap long lines to the
      // editor width instead of scrolling horizontally. Vim display-line motion
      // (j/k, gj/gk) is wrap-aware via EditorModel.displayLineMove.
      const applyWrap = (v: unknown) =>
        view.setWrapMode(v === false ? Gtk.WrapMode.NONE : Gtk.WrapMode.WORD_CHAR);
      const wrapSub = quilx.config.observe('editor.softWrap', applyWrap);
      view.on('destroy', () => wrapSub.dispose());
    }
    return view;
  }

  private buildEditorArea() {
    const scrolled = new Gtk.ScrolledWindow();
    scrolled.setChild(this.view);
    scrolled.setHexpand(true);

    // Scroll-past-end (`editor.scrollPastEnd`): GtkSourceView has no native option,
    // so we emulate it with a dynamic bottom margin sized to ~one viewport minus a
    // line — enough that the last line can scroll up to the top. The vadjustment
    // fires `changed` whenever the viewport (page-size) or content height shifts,
    // which covers resizes, font changes, and edits. Buffer-mode keeps its small
    // fixed margin (set in createView) and opts out.
    if (!this.bufferMode) {
      const vadj = scrolled.getVadjustment();
      let pastEndEnabled = quilx.config.get('editor.scrollPastEnd') !== false;
      let lastMargin = -1;
      let pendingId = 0;
      const applyPastEnd = () => {
        const margin = pastEndEnabled
          ? Math.max(0, Math.round(vadj.getPageSize() - this.editorModel.getLineHeightInPixels()))
          : 0;
        if (margin === lastMargin) return;
        lastMargin = margin;
        this.view.setBottomMargin(margin);
      };
      // The vadjustment `changed` signal is emitted *during* GtkTextView's
      // size-allocate (while it validates onscreen). Calling setBottomMargin from
      // inside that emission re-enters allocation and trips
      // `gtk_text_view_validate_onscreen: assertion failed (onscreen_validated)`,
      // aborting the process. Defer the mutation to an idle so it runs after the
      // allocation cycle settles. One pending pass at a time.
      const scheduleApply = () => {
        if (pendingId) return;
        pendingId = GLib.idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
          pendingId = 0;
          applyPastEnd();
          return false; // G_SOURCE_REMOVE
        });
      };
      vadj.on('changed', scheduleApply);
      this.view.on('destroy', () => {
        if (pendingId) GLib.sourceRemove(pendingId);
      });
      const pastEndSub = quilx.config.observe('editor.scrollPastEnd', (v) => {
        pastEndEnabled = v !== false;
        applyPastEnd();
      });
      this.view.on('destroy', () => pastEndSub.dispose());
    }

    // Overlay the scrolled view with the editor-local widgets: the diagnostic
    // squiggle layer (under the caret/showcmd), the showcmd preview
    // (bottom-right), and the hollow-caret layer (positioned per-cursor).
    const overlay = new Gtk.Overlay();
    overlay.setChild(scrolled);
    this.contentOverlay = overlay; // hosts the bottom-aligned hover card
    // Focusable inline peek (see-definition) — lives in this sibling overlay.
    this.inlinePeek = new InlinePeek(this.view, overlay);

    // Indent guides sit lowest (behind the squiggles/caret), in the whitespace.
    overlay.addOverlay(new IndentGuideOverlay(this.view, this.editorModel).widget);

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
    this.completion = new CompletionController(
      this.editorModel,
      overlay,
      () => this.vimState.mode === 'insert',
      // Tree-sitter highlight code blocks in completion docs, like the hover card;
      // unlabeled fences fall back to this file's language.
      (code, lang) => {
        const fallbackLang = this._currentFile ? langIdForPath(this._currentFile) ?? undefined : undefined;
        return highlightToMarkup(code, lang ?? fallbackLang);
      },
    );
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

    // Leap jump labels float on their own layer, above the carets. The controller
    // reads its chars through the vim layer's single-char input (so it shares the
    // `input-char-waiting` grab) and resolves a target Point to the leap motion.
    this.leapLayer.setCanTarget(false);
    overlay.addOverlay(this.leapLayer);
    this.leap = new LeapController({
      editor: this.editorModel,
      labelLayer: this.leapLayer,
      readChar: () =>
        new Promise((resolve) =>
          this.vimState.readChar({ onConfirm: (c: string) => resolve(c), onCancel: () => resolve(null) }),
        ),
    });

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

    // The signature-help card reuses the hover card's look (floated above the cursor).
    this.signatureCard.addCssClass('quilx-hover');
    this.signatureCard.setSizeRequest(HOVER_WIDTH_PX, -1);
    this.signatureCard.setHalign(Gtk.Align.START);
    this.signatureCard.setValign(Gtk.Align.END);
    this.signatureCard.setCanTarget(false);
    this.signatureCard.append(this.signatureLabel);
    this.signatureCard.setVisible(false);
    overlay.addOverlay(this.signatureCard);

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
    this.editorModel.onExtraCursors = (carets) => this.renderExtraCarets(carets);

    const focus = new Gtk.EventControllerFocus();
    focus.on('enter', () => {
      this.editorModel.setFocused(true);
      // This view is now the active one of its (possibly shared) document, so the LSP
      // cursor / dialogs / load-save reactions route here.
      this.document.setActiveHost(this);
      // Gaining focus is the moment to surface a disk change we noticed earlier.
      if (this.document.hasDiskChange()) this.document.promptDiskChange();
    });
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

  /**
   * Render the extra (multi-cursor) carets the model can't paint with a tag: beam
   * carets in insert mode (a thin bar) and block carets where there's no glyph to
   * reverse-video. Reuses a widget pool; surplus widgets are hidden.
   */
  private renderExtraCarets(carets: Array<{ iter: unknown; beam: boolean }>) {
    const realized = this.view.getRealized();
    for (let i = 0; i < carets.length; i++) {
      let widget = this.extraCarets[i];
      if (!widget) {
        widget = new Gtk.Box();
        widget.setCanTarget(false);
        this.caretLayer.put(widget, 0, 0);
        this.extraCarets[i] = widget;
      }
      if (!realized) {
        widget.setVisible(false);
        continue;
      }
      const cell = (this.view as any).getIterLocation(carets[i].iter) as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      const [winX, winY] = (this.view as any).bufferToWindowCoords(Gtk.TextWindowType.WIDGET, cell.x, cell.y);
      const beam = carets[i].beam;
      const width = beam ? 2 : cell.width > 1 ? cell.width : Math.max(2, Math.round(cell.height * 0.5));
      widget.setSizeRequest(width, cell.height);
      this.caretLayer.move(widget, winX, winY);
      widget.removeCssClass(beam ? 'quilx-block-caret' : 'quilx-beam-caret');
      widget.addCssClass(beam ? 'quilx-beam-caret' : 'quilx-block-caret');
      widget.setVisible(true);
    }
    for (let i = carets.length; i < this.extraCarets.length; i++) this.extraCarets[i].setVisible(false);
  }

  // --- Pending-command preview (showcmd) -------------------------------------

  private installShowcmd() {
    // Accumulate the keystrokes of the in-flight command and show them, the way
    // vim's `showcmd` echoes a partial command. A keymap listener sees every key
    // before dispatch; after each key we clear once the editor returns to a
    // resting state (no queued keystrokes, empty operation stack, no count or
    // pending register). Only active while this view is focused and not inserting.
    // The listener is global (it sees every key in every widget), so it must be
    // removed when this view goes away — otherwise each opened editor leaks a
    // listener that runs on every keystroke for the life of the process.
    const sub = quilx.keymaps.addListener((key) => {
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
    this.root.on('destroy', () => sub.dispose());
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
    // these commands on this view, which drive the fold provider (SyntaxController,
    // or a diff pane's DiffFold). Registered per-view so a keystroke folds the
    // focused editor.
    quilx.commands.add(this.view, {
      'fold:toggle': () => this.foldController.toggleFoldAtCursor(),
      'fold:open': () => this.foldController.setFoldAtCursor(false),
      'fold:close': () => this.foldController.setFoldAtCursor(true),
      'fold:open-all': () => this.foldController.unfoldAll(),
      'fold:close-all': () => this.foldController.foldAll(),
    });

    // Keep the cursor visible: if a move (w, /, G, a click, …) lands it inside a
    // folded body, open the fold (Vim's `foldopen`). Closing a fold moves the
    // cursor to the still-visible header, so this never fights `fold:close`.
    this.buffer.on('notify::cursor-position', () => {
      this.foldController.revealLine(this.editorModel.getCursorBufferPosition().row);
    });
  }

  /** Swap in a custom fold provider (a diff pane uses its DiffFold). */
  setFoldProvider(provider: FoldProvider): void {
    this.foldProvider = provider;
  }

  private get foldController(): FoldProvider {
    return this.foldProvider ?? this.syntax;
  }

  // --- Auto-close brackets / quotes (insert mode) ----------------------------

  private installAutoPair() {
    // A capture-phase key controller on the view: in insert mode it intercepts
    // openers/closers/backspace before GtkSourceView's own text input. The
    // window-level KeymapManager runs first (also capture) and leaves these
    // unbound keys to fall through here.
    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number, _keycode: number, state: number) => {
      if (this.vimState.mode !== 'insert') return false;
      if ((state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK)) !== 0) return false;
      // Replace (R) submode: overwrite the character under the cursor on type, and
      // restore the overwritten one on backspace (handled before auto-pairing).
      if (this.vimState.submode === 'replace') {
        if (keyval === Gdk.KEY_BackSpace) return this.replaceModeBackspace();
        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) return false; // newline falls through
        const ch = Gdk.keyvalToUnicode(keyval);
        if (!ch || ch < 0x20) return false;
        return this.replaceModeOverwrite(String.fromCharCode(ch));
      }
      if (quilx.config.get('editor.autoCloseBrackets') === false) return false;
      if (keyval === Gdk.KEY_BackSpace) return handleAutoPairBackspace(this.editorModel);
      const code = Gdk.keyvalToUnicode(keyval);
      if (!code) return false;
      const ch = String.fromCharCode(code);
      // JSX/HTML tag auto-close (`>` → `</name>`) before plain bracket pairing.
      if (handleTagAutoClose(this.editorModel, ch, this.isTagLanguage())) return true;
      return handleAutoPairInsert(this.editorModel, ch);
    });
    this.view.addController(keys);

    // Reset the replace-mode undo stack each time `R` (re)enters replace mode.
    this.vimState.onDidActivateMode(({ mode, submode }: { mode: string; submode: string | null }) => {
      if (mode === 'insert' && submode === 'replace') this.replaceStack = [];
    });
  }

  // --- Replace (R) mode ------------------------------------------------------
  // Overwrites the character under the cursor as you type; backspace walks back,
  // restoring the originally-overwritten characters (vim's `R`). The stack holds
  // one entry per typed character: the replaced char, or '' if it was appended
  // past end-of-line (nothing to restore).
  private replaceStack: string[] = [];

  private replaceModeOverwrite(ch: string): boolean {
    replaceOverwrite(this.editorModel, this.replaceStack, ch);
    return true;
  }

  private replaceModeBackspace(): boolean {
    replaceBackspace(this.editorModel, this.replaceStack);
    return true;
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
    // styleManager is the global Adw.StyleManager singleton; without disconnecting
    // on teardown it would keep this editor (its buffer, tree-sitter tree, widgets)
    // alive forever, leaking one whole editor per file ever opened.
    styleManager.on('notify::dark', apply);
    this.root.on('destroy', () => styleManager.off('notify::dark', apply));
  }

  // --- File operations -------------------------------------------------------

  /** Match the editor's indentation to the loaded file's own style; if the file
   *  has no detectable indentation, keep the config default set in `createView`.
   *  A tab-indented file keeps the configured *display* width. */
  private applyDetectedIndentation(content: string): void {
    const detected = detectIndentation(content);
    if (!detected) return;
    const width = detected.width ?? ((quilx.config.get('editor.tabLength') as number) || TAB_WIDTH);
    this.editorModel.setIndentation({ useSpaces: detected.useSpaces, width });
  }

  // --- File I/O (delegated to the document) ----------------------------------

  loadFile(path: string, opts: { silent?: boolean } = {}) {
    if (this.bufferMode) return; // buffer-only editors have no file
    this.document.loadFile(path, opts);
  }
  save() {
    this.document.save();
  }
  saveAs(path: string) {
    this.document.saveAs(path);
  }
  /** True once the open file has been changed or deleted on disk underneath us. */
  hasDiskChange(): boolean {
    return this.document.hasDiskChange();
  }

  // --- DocumentHost (the active view's reactions to load/save) ---------------

  /** @internal Capture the caret before a silent reload so didLoad can restore it. */
  willReplaceContent(reload: boolean): void {
    this.pendingReloadCaret = reload
      ? ((c) => [c.row, c.column] as [number, number])(this.editorModel.getCursorBufferPosition())
      : null;
  }

  /** @internal View-side setup after the document loaded content: cursor, indentation,
   *  syntax language, diagnostics, git gutter, focus. (Syntax follows the buffer too.) */
  didLoad(content: string, path: string, reload: boolean): void {
    if (reload && this.pendingReloadCaret) this.restoreCursor(this.pendingReloadCaret);
    else this.editorModel.setCursorBufferPosition({ row: 0, column: 0 });
    this.pendingReloadCaret = null;
    this.applyDetectedIndentation(content);
    if (!reload) this.view.grabFocus(); // a background reload mustn't steal focus
    this.applyViewSyntaxForPath(path);
    this.diagnostics.render();
    this.inlayHints.scheduleRefresh();
    this.gitGutter?.refresh();
  }

  /** Set up this view for an already-loaded shared `Document` — a second view (split /
   *  peek) onto a file open elsewhere. Its buffer is seeded by `createView`; this only
   *  does the per-view work the load reactions would: pick the grammar, place the
   *  cursor, render diagnostics, focus. No text load (the model already has it). */
  attachToLoadedDocument(): void {
    const path = this.document.currentFile;
    if (!path) return;
    this.applyViewSyntaxForPath(path);
    this.editorModel.setCursorBufferPosition({ row: 0, column: 0 });
    this.applyDetectedIndentation(this.getText());
    this.diagnostics?.render();
    this.inlayHints?.scheduleRefresh();
    this.gitGutter?.refresh();
    this.view.grabFocus();
  }

  /** Pick this view's grammar for `path` — tree-sitter when we have it, else the
   *  GtkSourceView `.lang` engine. (Per-view buffer, so its tags are its own.) */
  private applyViewSyntaxForPath(path: string): void {
    const handled = this.syntax.setLanguageForPath(path);
    if (handled) {
      this.buffer.setLanguage(null); // keep the .lang engine off
    } else {
      const langManager = GtkSource.LanguageManager.getDefault();
      this.buffer.setHighlightSyntax(true);
      this.buffer.setLanguage(langManager.guessLanguage(path, null));
    }
  }

  /** @internal Refresh the git gutter after a save (LSP didSave is document-level). */
  didSave(_path: string): void {
    this.gitGutter?.refresh();
  }

  /** @internal Present a modal dialog parented to this editor. */
  presentDialog(dialog: InstanceType<typeof Adw.AlertDialog>): void {
    dialog.present(this.root);
  }

  /** @internal Whether this view currently holds focus. */
  hasFocus(): boolean {
    return (this.view as any).hasFocus();
  }

  /** @internal Surface a load/save error. */
  toast(message: string): void {
    this.onToast(message);
  }

  /** @internal The cursor for an LSP request (anchors completion/hover at this view). */
  lspCursor(): Point {
    return this.editorModel.getCursorBufferPosition();
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
    return this.document.title;
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

  /** True while the document holds unsaved edits — drives the exit prompt. */
  isModified(): boolean {
    return this.document.isModified();
  }

  /** Exit-prompt label, e.g. "foo.ts (unsaved)". */
  getModifiedLabel(): string {
    return `${this.title} (unsaved)`;
  }

  /** Flush unsaved edits to the current file (no-op for an untitled buffer). */
  saveModified(): void {
    this.save();
  }

  /** Subscribe to title changes (the document's file / disk state changing). */
  onTitleChange(callback: () => void) {
    this.document.onTitleChange(callback);
  }

  /** Subscribe to modified-state changes (the document's modified flag toggling). */
  onModifiedChange(callback: () => void) {
    this.document.onModifiedChange(callback);
  }
}
