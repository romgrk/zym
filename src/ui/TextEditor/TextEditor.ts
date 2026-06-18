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
import { SyntaxController, type RevealedRange } from '../../syntax/syntax-controller.ts';
import { detectIndentation } from './detectIndentation.ts';
import { handleAutoPairInsert, handleAutoPairBackspace } from './autoPair.ts';
import { handleTagAutoClose } from './tagClose.ts';
import { Range } from '../../text/Range.ts';
import { Point } from '../../text/Point.ts';
import type { DiffFoldInfo } from '../../util/DiffModel.ts';
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
import { TextDecorations } from './TextDecorations.ts';
import { BlockDecorations } from './BlockDecorations.ts';
import { OverlayDecoration } from './OverlayDecoration.ts';
import { Peek, type PeekOptions } from './Peek.ts';
import { GitGutter } from './GitGutter.ts';
import { IndentGuides } from './IndentGuides.ts';
import { SearchController } from './SearchController.ts';
import { SearchBar } from './SearchBar.ts';
import { Leap, type LeapRequest } from './Leap.ts';
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
  /* On-disk change warning banner, pinned above the editor content. The warning
     color is mostly muted into the UI background (just a tint) so it isn't garish;
     text/button keep the normal foreground. Compact button keeps the bar slim. */
  .quilx-disk-banner {
    background-color: mix(${theme.ui.bg ?? theme.ui.popoverBg}, ${theme.ui.warning}, 0.25);
    color: ${theme.ui.fg};
    padding: 2px 8px;
  }
  .quilx-disk-banner label {
    font-weight: bold;
  }
  .quilx-disk-banner button {
    color: ${theme.ui.fg};
    min-height: 0;
    padding: 1px 8px;
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
  /** Folding (chevron gutter + projection). Defaults on. Diff panes leave it on but
   *  switch to the diff fold *method* (`setDiffFolds`) — unchanged runs, not code
   *  structure; peek/preview panes set it false to disable folding entirely. */
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

export class TextEditor implements DocumentHost {
  readonly root: InstanceType<typeof Gtk.Box>;

  // Guards dispose(): cleanup may be driven both explicitly (the tab-close path
  // calls dispose() directly) and by the GTK `destroy` signal fallback below, so
  // tearing down twice must be a no-op.
  private disposed = false;

  // Disconnects this editor's handler on the *global* Adw.StyleManager. It must
  // run from dispose() (the tab-close teardown path), not only the widget
  // `destroy` signal: on close the root is detached, not destroyed, so `destroy`
  // never fires — and the global singleton would otherwise pin the whole editor
  // (buffer, tree-sitter tree, widgets) via the captured closure forever.
  private detachStyleScheme?: () => void;

  // The document this editor is a *view* onto (owns the text model + undo + file I/O +
  // LSP). `this.buffer` is this view's own GtkSource.Buffer, kept in sync by the
  // document — separate from other views' buffers, so cursor/selection/folds/decorations
  // are native and independent per view (the A2 document-model architecture).
  private readonly document: Document;
  private readonly releaseDocument: (() => void) | null;
  private readonly buffer: SourceBuffer;
  private readonly view: SourceView;
  // Drives the vim `fold:*` commands and owns the fold projection. A diff pane
  // switches it to the diff fold method (unchanged-run folds) via `setDiffFolds`,
  // which suppresses tree-sitter fold discovery — same machinery either way.
  private readonly syntax: SyntaxController;
  private readonly editorModel: EditorModel;
  private readonly vimState: VimState;
  private readonly textDecorations: TextDecorations;
  private readonly blockDecorations: BlockDecorations;
  private readonly search: SearchController;
  private leap!: Leap; // built in buildEditorArea (needs the overlay)
  private completion!: CompletionController; // built in buildEditorArea (needs the overlay)
  private searchBar!: SearchBar; // built in buildEditorArea (needs the overlay)
  // On-disk change warning, pinned above the content (a Revealer wrapping a
  // left-aligned label + button); the button reloads (changed) or saves (deleted)
  // per `diskBannerState`. Wired up in buildEditorArea.
  private readonly diskBanner = new Gtk.Revealer();
  private readonly diskBannerLabel = new Gtk.Label({ xalign: 0 });
  private readonly diskBannerButton = new Gtk.Button();
  private diskBannerState: 'synced' | 'changed' | 'deleted' = 'synced';
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
  // The floating card holding hoverLabel; built in buildEditorArea (needs the overlay).
  private hoverOverlay!: OverlayDecoration;
  private contentOverlay!: InstanceType<typeof Gtk.Overlay>; // hosts the floating cards
  private inlinePeek!: Peek; // focusable inline peek (see-definition); built in buildEditorArea
  // The signature-help card: shown live while typing a call's arguments. Same
  // floating-card pattern as hover; `signatureSeq` drops stale async responses.
  private readonly signatureLabel = new Gtk.Label({ useMarkup: true, wrap: true, xalign: 0 });
  private signatureOverlay!: OverlayDecoration;
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
  // The git repo for the change gutter — swapped via `setGitRepo` when this editor's
  // workbench re-roots into a worktree.
  private gitRepo: GitRepo | null;
  private placeholderLabel: InstanceType<typeof Gtk.Label> | null = null;

  // File I/O, disk-watching, modified-state, title, and the LSP document all live on
  // `this.document` now; this getter keeps the many `_currentFile` read sites unchanged.
  private get _currentFile(): string | null {
    return this.document.currentFile;
  }
  // Caret captured before a silent reload (so the post-load host hook restores it).
  private pendingReloadCaret: [number, number] | null = null;

  // Lazy open (file mode): the file is assigned up front but its content/parse/highlight/
  // LSP are deferred until this view is first shown (mapped). `activated` guards the
  // one-shot, `pendingCursor` is the cursor to restore once loaded, `onActivate` lets the
  // owner (AppWindow) do its post-load wiring, and `mapHandler` is detached after firing.
  private activated = false;
  private pendingCursor: [number, number] | null = null;
  // Like pendingCursor, applied once the (lazily-opened) doc loads: a restored
  // scroll offset (top buffer row) and restored unsaved content (session restore).
  private pendingScroll: number | null = null;
  private pendingUnsaved: string | null = null;
  private onActivate: (() => void) | null = null;
  private mapHandler: (() => void) | null = null;

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
      folds: this.document, // folding collapses view ranges through the model projection
    });
    // The buffer/cursor model the custom vim layer drives.
    this.editorModel = new EditorModel(this.view, this.buffer);
    // Undo/redo run on the document model (this view's buffer has native undo off).
    this.editorModel.setUndoTarget(this.document);
    // The [...] placeholder is atomic + non-editable, and search runs over the whole
    // document — give the model access to the syntax controller's folds.
    this.editorModel.setFoldAccess({
      placeholderRanges: () => this.syntax.placeholderRanges(),
      unfoldAt: (off) => this.syntax.unfoldAtViewOffset(off),
      unfoldAll: () => this.syntax.unfoldAll(),
      viewPointFromModel: (p) => this.document.viewPointFromModel(this.buffer, p),
      modelLineText: (row) => this.document.modelLineText(row),
      revealFoldsMatching: (test) => this.syntax.revealFoldsMatching(test),
    });
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
    this.textDecorations = new TextDecorations(this.editorModel);
    // Inline block surface (virtual content between lines: the diff fold placeholder).
    this.blockDecorations = new BlockDecorations(this.view);
    // Search/replace engine; its `SearchBar` widget is built in buildEditorArea.
    this.search = new SearchController(this.editorModel, this.textDecorations);

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
    // the Leap reads the chars, paints labels, and resolves a Point.
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
    this.diagnostics = new DiagnosticsView(this.view, this.textDecorations, this.editorModel, () => this._currentFile);
    // Inlay hints (parameter names / inferred types) trailing each line, per view.
    this.inlayHints = new InlayHintController(
      this.view,
      () => this.lspDocument ?? null,
      (line) => this.document.viewLineForModelLine(this.buffer, line),
    );
    quilx.config.observe('editor.inlayHints', () => void this.inlayHints.refresh());
    // A fold open/close shifts the view lines under the model-positioned decorations
    // (diagnostic squiggles + gutter + error lens, inlay hints) — re-place them at the
    // new view positions (cached, no LSP round-trip).
    this.syntax.onFoldsChanged(() => {
      this.diagnostics?.render();
      this.inlayHints?.rerender();
    });
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
      if (this.signatureOverlay.visible) this.scheduleSignatureRequest();
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
    this.detachStyleScheme?.(); // drop the global StyleManager handler (else it pins this editor)
    this.detachStyleScheme = undefined;
    if (this.mapHandler) {
      (this.view as any).off('map', this.mapHandler);
      this.mapHandler = null;
    }
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
    if (!this.signatureOverlay.visible && !typedTrigger) return;
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
      // Anchor at the callee name's start (fall back to the cursor if not found),
      // shifting left by the card's content inset so the text lines up with the code
      // column rather than the card's edge. Stays put as further arguments are typed.
      const cursor = this.editorModel.getCursorBufferPosition();
      const line = [...this.editorModel.lineTextForBufferRow(cursor.row)];
      const nameCol = callNameStartColumn(line, cursor.column);
      const anchor = nameCol !== null ? { row: cursor.row, column: nameCol } : cursor;
      if (!this.signatureOverlay.anchorAbove(anchor, CARD_CONTENT_INSET_PX)) return; // off-screen → retry
      this.signatureAnchored = true;
    } else {
      this.signatureOverlay.show();
    }
  }

  private dismissSignature() {
    if (this.signatureTimer) {
      GLib.sourceRemove(this.signatureTimer);
      this.signatureTimer = 0;
    }
    this.signatureSeq++; // invalidate any in-flight request
    this.signatureAnchored = false; // the next call re-anchors at its own site
    this.signatureOverlay.hide();
  }

  // --- Git gutter ------------------------------------------------------------

  /** Re-point the change gutter at a different repo when this editor's workbench
   *  re-roots into a worktree (a no-op in buffer mode or before a gutter exists). */
  setGitRepo(git: GitRepo): void {
    this.gitRepo = git;
    this.gitGutter?.setGit(git);
  }

  private installGitGutter() {
    if (this.bufferMode || !this.gitRepo) return; // file mode with a repo only
    this.gitGutter = new GitGutter(
      this.view,
      () => this._currentFile,
      () => this.document.getText(), // diff against the MODEL (full file), not the collapsed view
      this.gitRepo,
      (line) => this.document.modelLineForViewLine(this.buffer, line),
    );
    // Let the vim layer reach the gutter's hunk ranges (for `]h`/`[h`). Hunk rows are
    // MODEL/file rows; translate to view rows (folded ones collapse onto one line).
    this.editorModel.setHunkProvider(() => [
      ...new Set((this.gitGutter?.hunkStartRows() ?? []).map((r) => this.document.viewLineForModelLine(this.buffer, r))),
    ]);
    // Live updates: re-diff the buffer (debounced) on every edit.
    this.editorModel.onDidChangeText(() => this.gitGutter?.scheduleUpdate());
    this.root.on('destroy', () => this.gitGutter?.dispose());

    // Hunk-level staging on the hunk under the cursor (gutter bars). Bound to the
    // `space h …` leader; the gutter does the index `git apply`, revert is an
    // in-buffer edit (so it's a single undo).
    quilx.commands.add(this.view, {
      'git:stage-hunk': () => this.stageHunkAtCursor(),
      'git:unstage-hunk': () => this.unstageHunkAtCursor(),
      'git:revert-hunk': () => this.revertHunkAtCursor(),
    });
  }

  // Save first (the user's choice) so the index/buffer/worktree agree before any
  // hunk op, then run `action` with the gutter and the cursor's buffer row.
  private withHunkGutter(action: (gutter: GitGutter, row: number) => void): void {
    if (!this.gitGutter) return;
    // Hunks are computed in MODEL/file rows; reveal folds so view==model and both the
    // lookup-by-cursor-row and any in-buffer revert act on the right lines.
    this.syntax.unfoldAll();
    if (this.isModified()) this.save();
    action(this.gitGutter, this.editorModel.getCursorBufferPosition().row);
  }

  private stageHunkAtCursor(): void {
    this.withHunkGutter((gutter, row) => {
      const hunk = gutter.unstagedHunkAtRow(row);
      if (!hunk) return quilx.notifications.addTrace('No unstaged hunk under the cursor');
      gutter.stageHunk(hunk, (ok, error) => {
        if (!ok) quilx.notifications.addError('Failed to stage hunk', { detail: error.trim() });
      });
    });
  }

  private unstageHunkAtCursor(): void {
    this.withHunkGutter((gutter, row) => {
      const hunk = gutter.stagedHunkAtRow(row);
      if (!hunk) return quilx.notifications.addTrace('No staged hunk under the cursor');
      gutter.unstageHunk(hunk, (ok, error) => {
        if (!ok) quilx.notifications.addError('Failed to unstage hunk', { detail: error.trim() });
      });
    });
  }

  // Revert (discard) the unstaged hunk under the cursor: replace its buffer rows
  // with the index version (`hunk.oldLines`), as one undoable edit, then save so
  // the working tree matches.
  private revertHunkAtCursor(): void {
    this.withHunkGutter((gutter, row) => {
      const hunk = gutter.unstagedHunkAtRow(row);
      if (!hunk) return quilx.notifications.addTrace('No unstaged hunk under the cursor');
      const startRow = hunk.newStart;
      const endRow = hunk.newStart + hunk.newLines.length; // exclusive
      // Restored text: the index lines, each newline-terminated. A pure deletion
      // (no buffer rows) re-inserts the removed lines before `startRow`.
      const restored = hunk.oldLines.map((line) => line + '\n').join('');
      const range = new Range(new Point(startRow, 0), new Point(endRow, 0));
      this.editorModel.setTextInBufferRange(range, restored);
      this.editorModel.setCursorBufferPosition(new Point(startRow, 0));
      this.save();
      this.gitGutter?.refresh();
    });
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
    // Float the card just above the cursor; it follows scroll via the overlay.
    this.hoverOverlay.anchorAbove(this.editorModel.getCursorBufferPosition());
  }

  private dismissHover() {
    this.hoverOverlay.hide();
  }

  /** The inline decoration surface (search highlights, inline diff). */
  get decorations(): TextDecorations {
    return this.textDecorations;
  }

  /** The editor model (Atom-`TextEditor`-shaped buffer API) — for features and
   *  plugins that scan or observe text, e.g. the color-preview plugin's tinting. */
  get model(): EditorModel {
    return this.editorModel;
  }

  /** The inline-block surface (virtual content between lines, e.g. the diff fold
   *  placeholder) — overlay widgets in a reserved gap, zero buffer footprint. */
  get inlineBlocks(): BlockDecorations {
    return this.blockDecorations;
  }

  /** Open a focusable inline peek (e.g. see-definition) below `line` — defaults to
   *  the cursor's line. Replaces any current peek. Returns nothing; `closePeek()`
   *  dismisses it (and clicking a close button in `widget` should call it). */
  showPeek(options: Omit<PeekOptions, 'line'> & { line?: number }): void {
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
    this.inlinePeek = new Peek(this.view, overlay);

    // Indent guides sit lowest (behind the squiggles/caret), in the whitespace.
    overlay.addOverlay(new IndentGuides(this.view, this.editorModel).widget);

    // Built here (after the view is in the ScrolledWindow, so its scroll
    // adjustments exist); fed by DiagnosticsView in installLsp.
    overlay.addOverlay(this.textDecorations.underlineWidget); // squiggles live inside TextDecorations

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
    this.leap = new Leap({
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
    this.hoverOverlay = new OverlayDecoration(this.editorModel, { cssClass: 'quilx-hover', widthPx: HOVER_WIDTH_PX, gapPx: HOVER_GAP });
    this.hoverOverlay.content.append(this.hoverLabel);
    this.hoverOverlay.attach(overlay);

    // The signature-help card reuses the hover card's look (floated above the cursor).
    this.signatureOverlay = new OverlayDecoration(this.editorModel, { cssClass: 'quilx-hover', widthPx: HOVER_WIDTH_PX, gapPx: HOVER_GAP });
    this.signatureOverlay.content.append(this.signatureLabel);
    this.signatureOverlay.attach(overlay);

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

    // On-disk change banner pinned above the content (replaces a transient toast,
    // so the warning persists until the user acts). A centered message + button;
    // the button's action depends on the state (`onDiskStateChanged` keeps the label,
    // button label, and `diskBannerState` in sync). A custom Revealer+Box rather than
    // Adw.Banner so we control the layout (full-width tint, centered content).
    this.diskBannerButton.on('clicked', () => {
      const path = this.document.currentFile;
      if (!path) return;
      if (this.diskBannerState === 'deleted') this.document.save();
      else this.document.loadFile(path);
    });
    // Label + button group, centered within the full-width tinted band: `content`
    // expands to fill but `halign: center` keeps it at natural width, centered.
    const content = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 16 });
    content.setHexpand(true);
    content.setHalign(Gtk.Align.CENTER);
    content.append(this.diskBannerLabel);
    content.append(this.diskBannerButton);
    const bannerBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    bannerBox.addCssClass('quilx-disk-banner');
    bannerBox.append(content);
    this.diskBanner.setChild(bannerBox);
    this.diskBanner.setRevealChild(false);

    box.setVexpand(true);
    box.setHexpand(true);
    const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    outer.append(this.diskBanner);
    outer.append(box);
    return outer;
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
    // these commands on this view, which drive the SyntaxController fold machinery
    // (tree-sitter folds, or a diff pane's unchanged-run folds). Registered per-view
    // so a keystroke folds the focused editor.
    quilx.commands.add(this.view, {
      'fold:toggle': () => this.selectRevealedFold(this.syntax.toggleFoldAtCursor()),
      'fold:open': () => this.selectRevealedFold(this.syntax.setFoldAtCursor(false)),
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

  /** Switch this view to the diff fold method: fold the given unchanged runs (via
   *  the same projection + chevron as code folding), suppressing syntax folding. */
  setDiffFolds(regions: readonly DiffFoldInfo[]): void {
    this.syntax.setDiffFolds(regions);
  }

  /** Side-by-side lockstep: toggle the same diff-fold index in a sibling pane. */
  setDiffFoldMirror(cb: (index: number) => void): void {
    this.syntax.setDiffFoldMirror(cb);
  }
  toggleDiffFoldIndex(index: number): void {
    this.syntax.toggleDiffFoldIndex(index);
  }

  /** VIEW line → MODEL line through the fold projection (the diff gutter keys by it). */
  modelLineForViewLine(line: number): number {
    return this.document.modelLineForViewLine(this.buffer, line);
  }
  /** MODEL line → VIEW line (a folded run's model lines have no view line). */
  viewLineForModelLine(line: number): number {
    return this.document.viewPointFromModel(this.buffer, new Point(line, 0)).row;
  }

  /** Highlight the text a fold revealed (when the caret was on its marker) — `zo`
   *  shows what was unfolded, as if the marker-cursor expanded onto the body. */
  private selectRevealedFold(range: RevealedRange | null): void {
    if (range) this.editorModel.setSelectedBufferRange(range);
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
    // alive forever, leaking one whole editor per file ever opened. Disconnect from
    // dispose() (the reliable teardown — the root is detached, not destroyed, on tab
    // close, so the `destroy` fallback never fires); idempotent, so both are safe.
    styleManager.on('notify::dark', apply);
    this.detachStyleScheme = () => styleManager.off('notify::dark', apply);
    this.root.on('destroy', () => this.detachStyleScheme?.());
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

  /**
   * Lazy open: assign `path` now (so the tab title, `currentFile` dedup, and `serialize`
   * are immediately live) but defer the file read, tree-sitter parse/highlight, and LSP
   * until this view is first shown. Adw.TabView leaves background pages unmapped, so the
   * one-shot `map` handler fires when the tab is first selected — the foreground tab maps
   * right away, a background/session-restored one only when visited.
   *
   * `opts.cursor` is restored after load; `opts.onActivate` runs once, post-load, for the
   * owner's wiring (e.g. registering the editor with the workspace once it has content).
   */
  prepareFile(
    path: string,
    opts: { cursor?: [number, number]; scroll?: number; unsavedText?: string; onActivate?: () => void } = {},
  ): void {
    if (this.bufferMode) return;
    this.document.assignPath(path);
    this.pendingCursor = opts.cursor ?? null;
    this.pendingScroll = opts.scroll ?? null;
    this.pendingUnsaved = opts.unsavedText ?? null;
    this.onActivate = opts.onActivate ?? null;
    const onMap = () => this.activate();
    this.mapHandler = onMap;
    (this.view as any).on('map', onMap);
  }

  /** First-show hook (one-shot): load the file's content if no sibling view has yet, else
   *  attach to the already-loaded shared document; then restore the cursor and run the
   *  owner's post-load wiring. Detaches the map handler so re-showing the tab is free. */
  private activate(): void {
    if (this.activated || this.disposed) return;
    this.activated = true;
    if (this.mapHandler) {
      (this.view as any).off('map', this.mapHandler);
      this.mapHandler = null;
    }
    // A shared document already loaded by another view → just wire this view onto it;
    // otherwise we are the first view, so read + parse + open the LSP now (didLoad does
    // the per-view setup). ensureLoaded is idempotent either way.
    if (this.document.isLoaded) this.attachToLoadedDocument();
    else this.document.ensureLoaded();
    // Restored unsaved content first (it replaces the buffer + resets the cursor),
    // then the saved cursor, then the saved scroll (overrides cursor-centering).
    if (this.pendingUnsaved !== null) {
      this.document.restoreUnsaved(this.pendingUnsaved);
      this.pendingUnsaved = null;
    }
    if (this.pendingCursor) {
      this.restoreCursor(this.pendingCursor);
      this.pendingCursor = null;
    }
    if (this.pendingScroll !== null) {
      this.editorModel.scrollToBufferPosition({ row: this.pendingScroll, column: 0 });
      this.pendingScroll = null;
    }
    this.onActivate?.();
    this.onActivate = null;
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

  /** @internal Show (or hide) the on-disk change banner above the content. */
  onDiskStateChanged(state: 'synced' | 'changed' | 'deleted', path: string | null): void {
    this.diskBannerState = state;
    if (state === 'synced' || !path) {
      this.diskBanner.setRevealChild(false);
      return;
    }
    if (state === 'deleted') {
      this.diskBannerLabel.setLabel('file deleted on disk');
      this.diskBannerButton.setLabel('Save');
    } else {
      this.diskBannerLabel.setLabel('file changed on disk');
      this.diskBannerButton.setLabel('Reload');
    }
    this.diskBanner.setRevealChild(true);
  }

  /** @internal The cursor for an LSP request (anchors completion/hover at this view).
   *  Translated to model space — inline fold anchors shift view columns past them. */
  lspCursor(): Point {
    return this.document.modelPointFromView(this.buffer, this.editorModel.getCursorBufferPosition());
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
    // A lazily-opened tab that was never shown has an empty model, so fall back to its
    // pending (saved) cursor rather than reporting 0,0.
    let cursor: [number, number];
    let scroll: number;
    if (this.document.isLoaded) {
      const c = this.editorModel.getCursorBufferPosition();
      cursor = [c.row, c.column];
      scroll = this.editorModel.getFirstVisibleScreenRow();
    } else {
      cursor = this.pendingCursor ?? [0, 0];
      scroll = this.pendingScroll ?? 0;
    }
    // `dirty` flags an editor with unsaved edits; the host caches its text so a
    // restore brings the edits back (see SessionManager.writeBuffers).
    const dirty = this.unsavedSnapshot() !== null;
    return { kind: 'file', path: this._currentFile, cursor, scroll, ...(dirty ? { dirty: true } : {}) };
  }

  /** The text to cache for restore: the live buffer when modified, or the pending
   *  restored-unsaved text for a tab restored-but-not-yet-shown; null when there's
   *  nothing unsaved. (Covers the lazy case so a save doesn't prune its cache.) */
  unsavedSnapshot(): string | null {
    if (this.bufferMode || !this._currentFile) return null;
    if (this.pendingUnsaved !== null) return this.pendingUnsaved;
    return this.isModified() ? this.getText() : null;
  }

  /** Restore a saved scroll offset — put `row` at the top of the viewport. Deferred
   *  to `activate` for a lazily-opened tab whose view isn't realized yet. */
  restoreScroll(row: number): void {
    if (!this.bufferMode && !this.document.isLoaded) {
      this.pendingScroll = row;
      return;
    }
    this.editorModel.scrollToBufferPosition({ row, column: 0 });
  }

  /** Restore unsaved content (session restore): replace the buffer and keep it
   *  modified. Deferred for a lazily-opened tab. */
  restoreUnsaved(text: string): void {
    if (!this.bufferMode && !this.document.isLoaded) {
      this.pendingUnsaved = text;
      return;
    }
    this.document.restoreUnsaved(text);
  }

  /** Restore a saved cursor position (clamped to the buffer) and reveal it. For a lazily-
   *  opened tab not yet shown the model is still empty, so the cursor is stashed and
   *  `activate()` applies it once the content loads (otherwise it'd land in an empty buffer
   *  and be reset to 0,0 by the load). */
  restoreCursor(cursor: [number, number]) {
    if (!this.bufferMode && !this.document.isLoaded) {
      this.pendingCursor = cursor;
      return;
    }
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
