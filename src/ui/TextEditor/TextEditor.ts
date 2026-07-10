/*
 * TextEditor — a single file's editor widget: a GtkSource.View + Buffer with
 * tree-sitter highlighting and folding (SyntaxController), custom vim modal
 * editing (the vendored vim-mode-plus core, via `attachVim`), and a minimap. One
 * TextEditor per open file (one per tab). It owns its file I/O, its fold-key
 * bindings, and follows the system light/dark scheme. The assembled widget is
 * exposed via `root`.
 */
import { SyntaxController, type RevealedRange } from '../../syntax/SyntaxController.ts';
import { detectIndentation } from './detectIndentation.ts';
import { handleAutoPairInsert, handleAutoPairBackspace } from './autoPair.ts';
import { handleTagAutoClose } from './tagClose.ts';
import { Range } from '../../text/Range.ts';
import { Point } from '../../text/Point.ts';
import type { TagName } from '../../syntax/tags.ts';
import * as Color from 'color-bits/string';
import { theme } from '../../theme/theme.ts';
import { createSourceScheme } from '../../theme/createSourceScheme.ts';
import { addStyles } from '../../styles.ts';
import { EditorModel } from './EditorModel.ts';
import { Document, type DocumentHost } from './Document.ts';
import type { TextEditorSource } from './TextEditorSource.ts';
import type { Screen } from './Screen.ts';
import { InlayHintController } from './InlayHintController.ts';
import { attachVim } from './vim/index.ts';
import { zym } from '../../zym.ts';
import { CompositeDisposable, Disposable } from '../../util/eventKit.ts';
import { DiagnosticsView } from '../../lsp/diagnostics/DiagnosticsView.ts';
import { MarkupCard } from './MarkupCard.ts';
import { fonts } from '../../fonts.ts';
import { highlightToMarkup } from '../../syntax/highlightToMarkup.ts';
import { langIdForPath } from '../../syntax/grammar.ts';
import { languages } from '../../lang/index.ts';
import { TextDecorations } from './TextDecorations.ts';
import { BlockDecorations } from './BlockDecorations.ts';
import { BlockDecorationSet } from './BlockDecorationSet.ts';
import { EditorPopover } from './EditorPopover.ts';
import { Peek, type PeekOptions } from './Peek.ts';
import { StickyHeaders } from './StickyHeaders.ts';
import { GitGutter } from './GitGutter.ts';
import { IndentGuides } from './IndentGuides.ts';
import { SearchController } from './SearchController.ts';
import { SearchBar } from './SearchBar.ts';
import { LocationBar } from './LocationBar.ts';
import { Leap, type LeapRequest } from './Leap.ts';
import { CompletionController } from './CompletionController.ts';
import { createBufferWordsSource } from './createBufferWordsSource.ts';
import { createLspCompletionSource } from './createLspCompletionSource.ts';
import type { CompletionSource } from './CompletionSource.ts';
import type { LspDocument } from '../../lsp/LspManager.ts';
import { lspToRange } from '../../lsp/position.ts';
import { replaceOverwrite, replaceBackspace } from './replaceMode.ts';
import type { PositionEncoding } from '../../lsp/position.ts';
import type { TextEdit, SignatureHelp, ParameterInformation } from 'vscode-languageserver-protocol';
import { escapeMarkup } from '../Picker.ts';
import { DiffCommentBox } from '../DiffCommentBox.ts';
import { formatAgentComment } from '../agentComment.ts';
import type { GitRepo } from '../../git.ts';
import * as Path from 'node:path';
import type { TabState } from '../../SessionManager.ts';
import Gdk from 'gi:Gdk-4.0';
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import Graphene from 'gi:Graphene-1.0';
import GtkSource from 'gi:GtkSource-5';
import { EditorSourceView } from './EditorSourceView.ts';
type SourceBuffer = InstanceType<typeof GtkSource.Buffer>;
type SourceView = InstanceType<typeof GtkSource.View>;

addStyles(/* css */`
  .zym-editor {
    font: var(--t-font-monospace);
    color: var(--t-ui-editor-foreground);
    caret-color: var(--t-ui-editor-foreground);
    background-color: var(--view-bg-colo);
  }
  /* Pending-command preview ("showcmd"), floated in the editor's bottom-right. */
  .zym-showcmd {
    font: var(--t-font-monospace);
    background-color: var(--view-bg-color);
    color: var(--t-ui-editor-foreground);
    opacity: 0.75;
    padding: 1px 6px;
    margin: 4px;
    border-radius: 4px;
  }
  /* Hollow caret shown over the cursor's character while the editor is unfocused. */
  .zym-unfocused-caret {
    border: 1.5px solid var(--t-ui-text-muted);
    border-radius: 1px;
  }
  /* Filled caret block for positions with no glyph to reverse-video (empty line,
     past end-of-line, end-of-buffer). */
  .zym-block-caret {
    background-color: var(--view-fg-color);
    border-radius: 1px;
  }
  /* Beam caret for extra (multi-cursor) carets in insert mode — a thin vertical
     bar, like the primary insert-mode caret. */
  .zym-beam-caret {
    background-color: var(--view-fg-color);
  }
  /* Buffer-only mode: greyed placeholder shown over an empty buffer. */
  .zym-placeholder {
    font: var(--t-font-monospace);
    color: var(--t-ui-text-muted);
    opacity: 0.6;
  }
  /* Info banner pinned above the editor content. Color tint is mostly muted into
     the UI background so it isn't garish; text/buttons keep the normal foreground.
     Compact buttons keep the bar slim. Two variants: warning (disk change) and
     error (load/save failure). */
  .zym-banner-warning,
  .zym-banner-error {
    color: var(--t-ui-editor-foreground);
    padding: 2px 8px;
  }
  .zym-banner-warning { background-color: mix(var(--view-bg-color), var(--t-ui-status-warning), 0.25); }
  .zym-banner-error   { background-color: mix(var(--view-bg-color), var(--t-ui-status-error),   0.25); }
  .zym-banner-warning label,
  .zym-banner-error   label { font-weight: bold; }
  .zym-banner-warning button,
  .zym-banner-error   button {
    color: var(--t-ui-editor-foreground);
    min-height: 0;
    padding: 1px 8px;
  }
`);

const TAB_WIDTH = 4;
const RIGHT_MARGIN = 80;
// Inner padding (px) around the text of an embedded/input editor
export const INPUT_PADDING = 8;

// A line this many characters or longer makes GtkTextView's per-paragraph PangoLayout
// pathological (minified/generated files, big one-line JSON, base64 blobs). When a file
// has one, we disable soft-wrap (re-flowing a giant line every layout is the worst cost)
// and tree-sitter highlighting (a minified line is thousands of tag applies), and warn —
// so the file opens and scrolls instead of hanging. Matches VS Code's long-line
// degradation threshold (`editor.maxTokenizationLineLength`, default 20000).
const LONG_LINE_THRESHOLD = 20_000;

// Whether `text` contains a line at least `threshold` chars long. Scans newline gaps and
// bails on the first long one, so a minified one-liner is detected immediately.
function hasLongLine(text: string, threshold: number): boolean {
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) return text.length - start >= threshold;
    if (nl - start >= threshold) return true;
    start = nl + 1;
  }
}
// LSP hover / signature card min width (px) — a size request the label wraps to.
const HOVER_WIDTH_PX = 300;
// Max card width (chars): a long code line soft-wraps to this readable column instead of
// stretching the card across the screen. Chars (not px) so it tracks the editor font size.
const HOVER_MAX_WIDTH_CHARS = 80;
// The card's horizontal chrome (1px popover border + 8px contents padding). EditorPopover
// shifts the card left by this so its text lines up with the code column, not the edge.
const CARD_CONTENT_INSET_PX = 9;
// Settle the autopair `()` insert + cursor move before requesting signature help.
const SIGNATURE_DEBOUNCE_MS = 40;

// Lazy multibuffer syntax (see docs/text-editor/multibuffer.md): coalesce scroll bursts before
// re-checking which excerpt sources to parse, and parse a margin beyond the viewport so an
// excerpt is highlighted by the time it scrolls in (mirrors the painter's VIEWPORT_MARGIN_LINES).
const LAZY_SYNTAX_THROTTLE_MS = 50;
const LAZY_SYNTAX_MARGIN_ROWS = 100;

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
  zym.keymaps.add('editor-search', {
    '.TextEditor.normal-mode': {
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

// Line-editing commands bound in normal mode. `y d`/`y u` (d = down, u = up)
// duplicate the current line below/above. Their `y` prefix collides with the vim
// Yank operator; the KeymapManager's longest-match deferral resolves it (it waits
// to see if `d`/`u` follows, falling back to bare Yank otherwise — exactly like
// the `y s` surround binding).
// `ctrl-/` toggles line comments (the VS Code stroke) in every mode, including
// insert; the vim strokes (`g c` operator, `g c c`) live in the vim keymap.
let editingKeymapsRegistered = false;
function registerEditingKeymapsOnce(): void {
  if (editingKeymapsRegistered) return;
  editingKeymapsRegistered = true;
  zym.keymaps.add('editor-editing', {
    '.TextEditor.normal-mode': {
      'y d': 'editor:duplicate-line-below',
      'y u': 'editor:duplicate-line-above',
    },
    '.TextEditor': {
      'ctrl-/': 'editor:toggle-line-comments',
    },
  });
}

export interface TextEditorOptions {
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
  /** Resolves the owning workbench's root directory — the base the LocationBar shortens the
   *  file path against. A getter (not a value) so a worktree re-root, which reassigns the
   *  workbench's cwd, is followed automatically. Defaults to the active workbench's cwd. */
  cwd?: () => string;
  /** The shared `Document` this view attaches to (from `zym.documents`). When given,
   *  this view is one of N onto it and releases its ref on teardown via
   *  `onReleaseDocument`; when omitted, the editor owns a private scratch document. */
  document?: Document;
  /** A multi-source backing (the search-results / continuous-diff surfaces): a
   *  `MultiBufferDocument` over one `Screen`. Mutually exclusive with `document`; the
   *  editor owns it (disposes it on teardown) and renders it as a first-class multi-source case. */
  source?: TextEditorSource;
  /** Called on teardown for a registry-owned `document` (drop this view's ref). */
  onReleaseDocument?: () => void;
  /** Enables "comment to agent" on this editor (a file editor): `enter` in normal mode / on a
   *  visual selection opens an inline box whose submit is formatted (`path:line` + fenced code +
   *  `On <locator>:` + text) and handed to this sink — the same seam diffs use (`reviewToAgent`).
   *  Omitted on inputs / peeks / multibuffers, so the feature is file-editor-only. */
  onComment?: (message: string) => void;
  /** Read-only, compact view onto the given `document` — the live see-definition peek
   *  (a second view of an open file). Requires `document`. */
  peek?: boolean;
  /** Soft-wrap long lines. Overrides the global `editor.softWrap` config for this one
   *  editor; when omitted, a file editor follows (and live-tracks) the config and an
   *  embedded/buffer editor defaults off. Use it for inputs that should always wrap. */
  softWrap?: boolean;
  /** Extra CSS class set on the inner view, alongside `zym-editor`. Lets styles and
   *  keymaps target a specific flavour of editor (e.g. `zym-input`) — keymap selectors
   *  match on CSS classes (see util/selectors.ts). */
  cssClass?: string;
  /** Inner padding (px) around the text, applied symmetrically on all four sides.
   * Defaults to `INPUT_PADDING` for input editors, and to `0` for the rest.
   */
  padding?: number;
  /** Auto-height: size the editor to its content instead of filling its allocation, so the
   *  input grows as the user types (an auto-growing textarea). Embedded editors only. Pair
   *  with `maxLines`/`maxHeight` to cap the growth — past it the editor scrolls internally. */
  grow?: boolean;
  /** Cap the auto-height at N *text* lines (padding-aware); beyond it the editor scrolls.
   *  Preferred over `maxHeight`, which it overrides. */
  maxLines?: number;
  /** Cap (px) on the auto-height growth when `grow` is set; beyond it the editor scrolls.
   *  A raw-px alternative to `maxLines`. Unbounded growth when both are omitted. */
  maxHeight?: number;
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
  /** Folding (chevron gutter + projection). Defaults on. Peek/preview panes set it
   *  false to disable folding entirely. */
  folding?: boolean;
}

/** Options for `createInput()` — the buffer-only input flavour. Extends the buffer
 *  options with input-specific knobs; everything has an input-friendly default. */
export interface InputEditorOptions extends BufferEditorOptions {
  /** Soft-wrap long lines. Defaults to `true` for inputs (wrapping, not h-scroll). */
  softWrap?: boolean;
  /** Extra CSS class on the view, added alongside the shared `zym-input` class — so a
   *  given input (e.g. the agent prompt) can be targeted by its own styles/keymaps. */
  cssClass?: string;
  /** Inner text padding (px) on all four sides. Defaults to `INPUT_PADDING`. */
  padding?: number;
  /** Grow the input's height with its text instead of filling its allocation. Pair with
   *  `maxLines`/`maxHeight` to cap the growth (past it the input scrolls). */
  grow?: boolean;
  /** Cap `grow` at N text lines (padding-aware); overrides `maxHeight`. */
  maxLines?: number;
  /** Cap (px) on `grow`; a raw-px alternative to `maxLines`. Unbounded when both omitted. */
  maxHeight?: number;
  /** Close request, passed through to the editor. */
  onClose?: () => void;
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

  // Every node-gtk GObject signal handler and global-registry subscription
  // (config/keymaps) this editor installs goes in here. node-gtk roots each
  // connected signal's JS callback in a Global handle for the GObject's lifetime,
  // and that closure captures `this` — so a SINGLE un-disconnected handler pins the
  // whole editor (buffer, tree-sitter tree, widgets) forever, exactly the way the
  // Adw.StyleManager handler did. The owned widgets are detached (not destroyed) on
  // tab close, so they never finalize on their own — `dispose()` must cut these by
  // hand. Disposed as a unit; see docs/lifecycle-and-disposal.md. Use `connect()`
  // for signals and `subs.add(...)` for registry Disposables.
  private readonly subs = new CompositeDisposable();
  // Lazy multibuffer syntax: the scroll adjustment the viewport trigger is bound to (re-bound
  // when the ScrolledWindow swaps it in), and the throttle for re-checking which sources to parse.
  private lazySyntaxAdj: any = null;
  private lazySyntaxThrottleId: ReturnType<typeof setTimeout> | null = null;

  // The document this editor is a *view* onto (owns the text model + undo + file I/O +
  // LSP). `this.buffer` is this view's own GtkSource.Buffer, kept in sync by the
  // document — separate from other views' buffers, so cursor/selection/folds/decorations
  // are native and independent per view (the A2 document-model architecture).
  private readonly document: TextEditorSource;
  private readonly releaseDocument: (() => void) | null;
  // This view's buffer↔screen projection (folds + the multibuffer stitch); `this.buffer` is its
  // backing GtkSource.Buffer. The fold/translation surface SyntaxController + the cursor model use.
  private readonly screen: Screen;
  private readonly buffer: SourceBuffer;
  private readonly view: SourceView;
  // Drives the vim `fold:*` commands and owns the fold projection.
  private readonly syntax: SyntaxController;
  // Top-of-editor location bar (file path + tree-sitter breadcrumb). Main editors only —
  // embedded/multibuffer surfaces keep their per-excerpt HeaderBands. Null when embedded.
  private locationBar: LocationBar | null = null;
  private locationBarTimer: NodeJS.Timeout | null = null;
  private readonly editorModel: EditorModel;
  private readonly vimState: VimState;
  private readonly textDecorations: TextDecorations;
  private readonly blockDecorationController: BlockDecorations;
  // Whitespace indent-guide overlay; built in buildEditorArea (needs the overlay). Held so
  // dispose() can detach its signal handlers, which would otherwise pin the editor.
  private indentGuides: IndentGuides | null = null;
  // Declarative block-decoration sets created via `blockDecorations()`, re-projected on materialize.
  private readonly decorationSets: BlockDecorationSet[] = [];
  private decorationMaterializeSub: (() => void) | null = null;
  private readonly search: SearchController;
  private leap!: Leap; // built in buildEditorArea (needs the overlay)
  private completion!: CompletionController; // built in buildEditorArea (needs the overlay)
  private searchBar!: SearchBar; // built in buildEditorArea (needs the overlay)
  // Info banner pinned above the content: a single Revealer used for disk-change
  // warnings, load errors, and save errors. `showBanner` / `hideBanner` drive it.
  private readonly banner = new Gtk.Revealer();
  private readonly bannerLabel = new Gtk.Label({ xalign: 0 });
  private readonly bannerButton = new Gtk.Button();
  private readonly bannerBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
  private bannerAction: (() => void) | null = null;

  // LSP: a document adapter the LspManager drives, and the per-editor diagnostics
  // renderer. Wired in `installLsp` once the model and root exist.
  private lspDocument: LspDocument | null = null;
  private diagnostics!: DiagnosticsView;
  private inlayHints!: InlayHintController;
  // External subscribers to fold open/close (e.g. git blame), fanned out from the
  // single `syntax.onFoldsChanged` so they get a real unsubscribe (`onDidChangeFolds`).
  private readonly foldsChangedHandlers = new Set<() => void>();
  // Git change bar in the gutter; only present in file mode when a repo is given.
  private gitGutter: GitGutter | null = null;
  // The LSP hover card: a MarkupCard in an EditorPopover anchored at the cursor cell (also
  // reused for the git-blame commit message via `showHoverMarkup`). Built in buildEditorArea.
  private hoverCard!: MarkupCard;
  private hoverPopover!: EditorPopover;
  private contentOverlay!: InstanceType<typeof Gtk.Overlay>; // hosts the floating cards
  private inlinePeek!: Peek; // focusable inline peek (see-definition); built in buildEditorArea
  private stickyHeaderController!: StickyHeaders; // reusable per-excerpt sticky headers (diff / search)
  // The signature-help card: shown live while typing a call's arguments. Same
  // MarkupCard/EditorPopover as hover; `signatureSeq` drops stale async responses.
  private signatureCard!: MarkupCard;
  private signaturePopover!: EditorPopover;
  private signatureSeq = 0;
  private signatureTimer: NodeJS.Timeout | null = null;
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
  // Buffer-space (scroll-independent) geometry of the overlay carets currently shown, so a
  // scroll can re-place them. The overlay box lives on a `Gtk.Fixed` at *window* coords,
  // which the view scrolls out from under it — unlike the reverse-video tag caret, which is
  // part of the text and scrolls natively. Null / null entry ⇒ no overlay box for that slot
  // (the common glyph-caret case caches nothing). See `repositionOverlayCarets`.
  private caretBufferGeom: { x: number; y: number; width: number; height: number } | null = null;
  private readonly extraCaretGeom: Array<{ x: number; y: number; width: number; height: number; beam: boolean } | null> = [];
  private showcmd = '';

  // Buffer-only mode config (null = a normal file editor), and the placeholder
  // label shown over the empty buffer (only built when a placeholder is given).
  private readonly bufferMode: BufferEditorOptions | null;
  // The backing stitches N sources through one Screen (a multibuffer surface): the editor
  // suppresses its own line numbers / minimap / LSP / git gutter / folding and paints via the
  // source's `syntaxProjection`. `embedded` is the wider "not a normal file editor" flag
  // (buffer-only OR peek OR multi-source) driving the compact presentation.
  private readonly multiSource: boolean;
  private readonly embedded: boolean;
  // A read-only, compact view onto a shared Document — the live see-definition peek (a
  // second view of an open file). File-backed (unlike bufferMode), but not edited.
  private readonly peekMode: boolean;
  // The git repo for the change gutter — swapped via `setGitRepo` when this editor's
  // workbench re-roots into a worktree.
  private gitRepo: GitRepo | null;
  // Resolves the owning workbench's root directory — the base the LocationBar shortens the
  // file path against. A getter so a worktree re-root (which reassigns the workbench cwd) is
  // followed without re-wiring.
  private readonly workbenchCwd: () => string;
  private placeholderLabel: InstanceType<typeof Gtk.Label> | null = null;

  // File I/O, disk-watching, modified-state, title, and the LSP document all live on
  // `this.document` now; this getter keeps the many `_currentFile` read sites unchanged.
  private get _currentFile(): string | null {
    return this.document.currentFile;
  }
  // Caret captured before a silent reload (so the post-load host hook restores it). Only the
  // full-replace fallback path uses this; a minimal-splice reload preserves the caret in place.
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
  // Whether to take keyboard focus once the content loads. The lazy load fires when
  // the tab is shown, which is the deferred companion to the synchronous focus() a
  // foreground open does — so a foreground open lands focus here. A background open
  // (focus: false — session restore, an agent auto-opening a file it edited) still
  // loads and renders when shown, but leaves this false so the load doesn't yank
  // focus out of wherever the user is.
  private focusOnLoad = true;

  // Set when the loaded file has a pathologically long line (see LONG_LINE_THRESHOLD):
  // soft-wrap and tree-sitter highlighting are then disabled for it. `applyWrap` re-applies
  // the wrap mode from the config *and* this flag (set up in createView; file mode only).
  private longLineMode = false;
  private applyWrap: () => void = () => {};

  // Per-editor soft-wrap override (undefined = follow the `editor.softWrap` config, file
  // mode only) and an optional extra CSS class on the view (style/keymap targeting).
  private readonly softWrapOverride: boolean | undefined;
  private readonly cssClass: string | undefined;
  // Inner text padding for an embedded/input editor (px); undefined → INPUT_PADDING.
  private readonly paddingOverride: number | undefined;
  // Auto-height (input grows with its text) and an optional cap on that growth, expressed
  // as text lines (`growMaxLines`, padding-aware) or raw px (`growMaxHeight`).
  private readonly growToContent: boolean;
  private readonly growMaxHeight: number | undefined;
  private readonly growMaxLines: number | undefined;
  // Comment-to-agent sink (file editors only); when set, `installComment` wires the `editor:comment`
  // command. `commentBox` is the one open inline box (mirrors DiffView's single-box invariant).
  private readonly onComment: ((message: string) => void) | undefined;
  private commentBox: DiffCommentBox | null = null;

  constructor(options: TextEditorOptions = {}) {
    this.bufferMode = options.buffer ?? null;
    this.peekMode = options.peek ?? false;
    this.gitRepo = options.git ?? null;
    this.softWrapOverride = options.softWrap;
    this.cssClass = options.cssClass;
    this.paddingOverride = options.padding;
    this.growToContent = options.grow ?? false;
    this.growMaxHeight = options.maxHeight;
    this.growMaxLines = options.maxLines;
    this.onComment = options.onComment;
    // Auxiliary editors (peek, etc.) omit `cwd`; shorten their paths against the active
    // workbench's root rather than the launch dir, so a non-primary project reads correctly.
    this.workbenchCwd = options.cwd ?? (() => zym.workspace.getActiveWorkbench()?.cwd ?? process.cwd());

    // The backing this editor is a view onto: a multi-source `MultiBufferDocument` (the
    // search-results / continuous-diff surfaces), a shared registry `Document` (a file open in N
    // views, released on teardown), or a private scratch `Document` (a file-less buffer-only input).
    this.document = options.source ?? options.document ?? new Document();
    this.releaseDocument = options.document ? (options.onReleaseDocument ?? null) : null;
    // The view buffer comes from the backing — a `Screen` over one full-file segment for a
    // single source, or over N stitched sources for a multibuffer (identical seam either way).
    this.screen = this.document.createView();
    this.buffer = this.screen.buffer;
    // `embedded` = no single-file backing (a buffer-only input OR a multi-source surface): the
    // editor suppresses its own line numbers / minimap / scroll-past-end / LSP / git gutter / file
    // I/O. A peek view is file-backed (keeps LSP + the shared parse), only compact in presentation.
    this.multiSource = this.document.isMultiSource;
    this.embedded = !!this.bufferMode || this.multiSource;
    this.lspDocument = this.document.lspDocument;
    this.view = this.createView(this.buffer);
    this.syntax = new SyntaxController(this.view, this.buffer, {
      lineNumbers: !(this.embedded || this.peekMode),
      folding: this.multiSource ? false : (this.bufferMode?.folding ?? (this.peekMode ? false : undefined)),
      screen: this.screen, // folding collapses view ranges through this view's screen projection
      // File / peek views share the document's ONE parse (model coords) — so a file open in N
      // views parses once. Buffer-only panes keep a private parse over their own view buffer; a
      // multibuffer paints its many sources stitched together via the projection instead.
      documentSyntax: this.embedded ? undefined : (this.document.documentSyntax ?? undefined),
      projection: this.document.syntaxProjection ?? undefined,
    });
    // The buffer/cursor model the custom vim layer drives.
    this.editorModel = new EditorModel(this.view, this.buffer);
    // Undo/redo run on the backing (this view's buffer has native undo off): the document model for
    // a single source, or — for a multibuffer — its `Screen`, coordinating the sources.
    this.editorModel.setUndoTarget(this.document);
    // The [...] placeholder is atomic + non-editable, and search runs over the whole
    // document — give the model access to the syntax controller's folds.
    this.editorModel.setFoldAccess({
      placeholderRanges: () => this.syntax.placeholderRanges(),
      unfoldAt: (off) => this.syntax.unfoldAtViewOffset(off),
      unfoldAll: () => this.syntax.unfoldAll(),
      screenPointFromDocument: (p) => this.screen.screenPointFromDocument(p),
      documentPointFromScreen: (p) => this.screen.documentPointFromScreen(p),
      documentLineForScreenLine: (row) => this.screen.documentLineForScreenLine(row),
      screenLineForDocumentLine: (row) => this.screen.screenLineForDocumentLine(row),
      documentLineText: (row) => this.document.documentLineText(row),
      documentLineCount: () => this.document.documentLineCount(),
      documentTextInRange: (start, end) => this.document.documentTextInRange(start, end),
      documentText: () => this.document.getText(),
      revealFoldsMatching: (test) => this.syntax.revealFoldsMatching(test),
    });
    // A multibuffer keeps `buffer == screen` (folding off), so the buffer↔screen fold transform
    // stays identity there — its FoldAccess translators model a single document, not the stitch.
    this.editorModel.setMultiSource(this.multiSource);
    // Real (tree-sitter) indent source for `=`/paste-reindent/new lines.
    this.editorModel.setIndentSource((row) => this.syntax.indentLevelForRow(row));
    // Comment delimiters for `g c` / `editor:toggle-line-comments`, from the
    // file's language. No file (inputs, multibuffers) → no spec → toggling no-ops.
    this.editorModel.setCommentSpecSource(() => {
      const lang = this._currentFile ? langIdForPath(this._currentFile) : null;
      return lang ? languages.commentsFor(lang) : null;
    });
    // Default indentation from config; `loadFile` detects and overrides per file.
    this.editorModel.setIndentation({
      useSpaces: zym.config.get('editor.insertSpaces') !== false,
      width: (zym.config.get('editor.tabLength') as number) || TAB_WIDTH,
    });
    // Let motions see/reveal folds (the fold state lives in SyntaxController).
    // The vim layer speaks `buffer` (== document for a single file), so fold queries are in
    // document rows: a closed fold's whole span counts as one line (j/k skip it), and a motion
    // landing inside a fold reveals it.
    this.editorModel.setFoldProvider({
      isFoldedAtRow: (row) => this.syntax.documentFoldRangeAtRow(row) != null,
      foldRangeAtRow: (row) => this.syntax.documentFoldRangeAtRow(row),
      unfoldRow: (row) => this.syntax.unfoldDocumentRow(row),
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
    this.blockDecorationController = new BlockDecorations(this.view);
    // Reusable per-excerpt sticky headers (diff / project-search) — over the block surface, plus the
    // caret-follow focus + no-cursor decoration it owns (hence the model + decorations).
    this.stickyHeaderController = new StickyHeaders(this.blockDecorationController, this.editorModel, this.textDecorations);
    // Search/replace engine; its `SearchBar` widget is built in buildEditorArea.
    this.search = new SearchController(this.editorModel, this.textDecorations);

    this.root = this.buildEditorArea();
    // The inner view is the `.TextEditor` selector subject (it holds focus + the
    // mode CSS classes — see EditorModel); the wrapping area gets its own name so
    // the two don't both answer to `.TextEditor`.
    this.root.addCssClass('TextEditorArea');

    this.installFoldCommands();
    this.installEditingCommands();
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
    if (this.onComment) this.installComment();
    if (this.bufferMode) this.installBufferMode(this.bufferMode);
    // A multibuffer paints its stitched projection directly (there's no single-language
    // first-parse step to trigger it). Its excerpt sources parse lazily as they near the
    // viewport (installLazyProjectionSyntax) — the initial paint is a no-op until the first
    // source parses. The surface re-materializes + repaints on re-diff via `repaintSyntax`.
    if (this.multiSource) {
      this.syntax.paint();
      this.installLazyProjectionSyntax();
    }
    if (this.peekMode) {
      // Read-only viewer onto the shared buffer; start unfocused so it shows no caret
      // until the user clicks into it.
      this.editorModel.setReadOnly(true);
      this.editorModel.setFocused(false);
    }
    // Fallback teardown: the tab-close path disposes us explicitly, but also tear
    // down if the widget is destroyed by any other route (dispose() is idempotent).
    // Tracked so dispose() disconnects it — left connected it would itself pin the
    // editor via root's Global handle (the closure captures `this`).
    this.subs.connect(this.root, 'destroy', () => this.dispose());
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

  /** Insert `text` at the cursor / over the selection (e.g. a soft newline in an
   *  embedded prompt buffer). */
  insertText(text: string): void {
    this.editorModel.insertText(text);
  }

  /** Register an extra completion source (beyond the built-in buffer-words / LSP),
   *  e.g. slash commands for an embedded prompt input. */
  addCompletionSource(source: CompletionSource): void {
    this.completion.addSource(source);
  }

  /** Switch tree-sitter highlighting to match `path`'s file type (buffer/preview mode). */
  setLanguageForPath(path: string): void {
    this.syntax.setLanguageForPath(path);
  }

  /** Repaint syntax highlighting (multibuffer/projection mode) — e.g. after the owner
   *  re-materializes the view buffer, which clears tags the painter must reapply. */
  repaintSyntax(): void {
    this.syntax.paint();
  }

  private installBufferMode(mode: BufferEditorOptions): void {
    if (mode.initialText) this.setText(mode.initialText);
    this.placeholderLabel?.setVisible(this.buffer.getCharCount() === 0);
    // Tree-sitter highlighting from the compared file's type (after the text is set, so the first
    // parse sees it). Grammars must be preloaded (preloadGrammars).
    if (mode.languagePath) this.syntax.setLanguageForPath(mode.languagePath);
    // Read-only viewer (e.g. a diff pane): block edits at the view; vim normal-mode
    // navigation still works, and insert-mode keystrokes simply do nothing. Start
    // unfocused so a freshly-shown pane has no caret until it's actually focused
    // (otherwise both side-by-side panes would show one at creation).
    if (mode.readOnly) {
      this.editorModel.setReadOnly(true); // reject vim edits too, not just native input
      this.editorModel.setFocused(false);
    }

    if (mode.onSubmit) {
      // Ctrl+Enter submits. Capture-phase on the view so it fires only when the
      // view is focused (not the search bar) and before a newline is inserted.
      const keys = new Gtk.EventControllerKey();
      keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
      this.subs.connect(keys, 'key-pressed', (keyval: number, _keycode: number, state: number) => {
        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        if (ctrl && (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter)) {
          mode.onSubmit!(this.getText());
          return true;
        }
        return false;
      });
      this.subs.addController(this.view, keys);
    }
  }

  // --- Search (`/` `?` `n` `N` `*` `#`) --------------------------------------

  private installSearch() {
    registerSearchKeymapsOnce();
    zym.commands.add(this.view, {
      'editor:search-forward': { didDispatch: () => this.searchBar.open(false), description: 'Search forward' },
      'editor:search-backward': { didDispatch: () => this.searchBar.open(true), description: 'Search backward' },
      // n/N outside the bar repeat the last search (no-op when none is active).
      'editor:search-next': {
        didDispatch: () => {
          if (!this.search.hasActiveSearch) return;
          const from = this.editorModel.getCursorBufferPosition();
          this.search.next();
          this.recordSearchJump(from);
        },
        description: 'Repeat the search forward',
      },
      'editor:search-previous': {
        didDispatch: () => {
          if (!this.search.hasActiveSearch) return;
          const from = this.editorModel.getCursorBufferPosition();
          this.search.previous();
          this.recordSearchJump(from);
        },
        description: 'Repeat the search backward',
      },
      // `*`/`#`: whole-word search of the word under the cursor; `g*`/`g#` match
      // substrings too.
      'editor:search-word-forward': { didDispatch: () => this.searchWordUnderCursor(false, true), description: 'Search the word under the cursor forward' },
      'editor:search-word-backward': { didDispatch: () => this.searchWordUnderCursor(true, true), description: 'Search the word under the cursor backward' },
      'editor:search-word-forward-loose': { didDispatch: () => this.searchWordUnderCursor(false, false), description: 'Search the word under the cursor forward (substring)' },
      'editor:search-word-backward-loose': { didDispatch: () => this.searchWordUnderCursor(true, false), description: 'Search the word under the cursor backward (substring)' },
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

    // Occurrence↔search bridge: `g o` arms occurrence on the search matches —
    // either the active search, or one seeded here from the cursor word / selection
    // without moving the cursor. See docs/text-editor/occurrence-search.md.
    this.vimState.setOccurrenceSearchProvider({
      armFromCursor: () => this.armSearchFromCursor(),
      armFromText: (text) => {
        if (!text) return null;
        const regex = this.search.setQueryStatic(text, { wholeWord: false });
        this.searchBar.reflectQuery(text);
        return regex;
      },
      getActivePattern: () => this.search.activePattern,
      refresh: () => this.search.rehighlight(),
    });
    // The search renders purple iff occurrence is armed — single source of truth, so
    // the highlight and the operator behaviour can never disagree.
    this.search.setArmedProvider(() => this.vimState.isOccurrenceArmed());

    // `:noh`-style clear: reset-normal-mode (Esc) drops the search highlights when
    // `clearHighlightSearchOnResetNormalMode` is on. The query is kept, so `n`/`N`
    // re-highlight on demand.
    this.vimState.onDidRequestClearSearchHighlight(() => this.search.clear());

    // Leap (`g s` / `g S`): the vim motion requests a target through this bridge;
    // the Leap reads the chars, paints labels, and resolves a Point.
    (this.vimState as unknown as VimLeapBridge).setLeapInput?.((req) => {
      void this.leap.start(req);
    });

    // `vim-mode-plus:jump-backward`/`-forward` walk the single workspace jump list;
    // route them to the same command GlobalJumpList registers (ctrl-o / ctrl-i).
    this.vimState.setJumpNavigator({
      backward: () => zym.commands.dispatch(this.view, 'workspace:jump-backward'),
      forward: () => zym.commands.dispatch(this.view, 'workspace:jump-forward'),
    });
  }

  /** The word under (or next on the line after) the cursor, or null when none —
   *  shared by `*`/`#` and `g o`'s cursor-word arming. */
  private wordAtOrAfterCursor(): string | null {
    const pos = this.editorModel.getCursorBufferPosition();
    const line = this.editorModel.lineTextForBufferRow(pos.row);
    const wordRe = /\w+/g;
    let match: RegExpExecArray | null;
    while ((match = wordRe.exec(line))) {
      // match.index/length are UTF-16; columns are codepoints — compare in codepoints.
      const wordEndColumn = [...line.slice(0, match.index + match[0].length)].length;
      if (wordEndColumn > pos.column) return match[0];
    }
    return null;
  }

  /** vim `*`/`#`: search for the keyword under (or next on the line after) the
   *  cursor. No-op when the line has no word at/after the cursor. */
  private searchWordUnderCursor(reverse: boolean, wholeWord: boolean): void {
    const word = this.wordAtOrAfterCursor();
    if (!word) return;
    const from = this.editorModel.getCursorBufferPosition();
    this.search.searchWord(word, reverse, wholeWord);
    // Mirror the searched word into the search bar so its value tracks the active
    // search, like vim setting the `/` register on `*`/`#`.
    this.searchBar.reflectQuery(word);
    this.recordSearchJump(from);
  }

  /** Hint the jump list that a search navigation (`*`/`#`/`n`/`N`) departed `from`,
   *  but only if it actually moved the caret. Search is a jump at any distance
   *  (vim treats it so); without this hint a match nearer than
   *  `jumpListMinLines` would slip past the caret-distance detector and `ctrl-o`
   *  wouldn't return to before the search. */
  private recordSearchJump(from: Point): void {
    if (!this.editorModel.getCursorBufferPosition().isEqual(from)) {
      this.vimState.emitDidRecordJump(from);
    }
  }

  /** `g o` arm from the cursor: a *visible* search wins (you can see the amber, so
   *  arming it is predictable); otherwise (re-)seed the search from the cursor word
   *  without moving the cursor. To re-target a new word after a search, clear it
   *  first with `ctrl-l`. Returns the chosen regex, or null when there's no word and
   *  no visible search. */
  private armSearchFromCursor(): RegExp | null {
    if (this.search.hasVisibleMatches) return this.search.activePattern;
    const word = this.wordAtOrAfterCursor();
    if (!word) return null;
    const regex = this.search.setQueryStatic(word, { wholeWord: true });
    this.searchBar.reflectQuery(word);
    return regex;
  }

  // --- LSP integration -------------------------------------------------------

  private installLsp() {
    if (this.embedded) return; // buffer-only / multibuffer: no single file, no language server
    // The LSP document lives on `this.document` (one per file; didOpen/didChange/
    // didClose are driven there off the model). This view contributes the diagnostics
    // renderer and signature help.
    this.diagnostics = new DiagnosticsView(this.view, this.syntax, this.textDecorations, this.editorModel, () => this._currentFile);
    // Let the vim layer reach diagnostic positions (for `]d`/`[d`); already view-space.
    this.editorModel.setDiagnosticProvider(() => this.diagnostics.diagnosticPositions());
    // Inlay hints (parameter names / inferred types) trailing each line, per view.
    this.inlayHints = new InlayHintController(
      this.view,
      () => this.lspDocument ?? null,
      (line) => this.screen.screenLineForDocumentLine(line),
    );
    this.subs.add(zym.config.observe('editor.inlayHints', () => void this.inlayHints.refresh()));
    // A fold open/close shifts the view lines under the model-positioned decorations
    // (diagnostic squiggles + gutter + error lens, inlay hints) — re-place them at the
    // new view positions (cached, no LSP round-trip). External fold-dependent features
    // (git blame, via `onDidChangeFolds`) re-place themselves the same way.
    this.syntax.onFoldsChanged(() => {
      this.diagnostics?.render();
      this.inlayHints?.rerender();
      this.foldsChangedHandlers.forEach((h) => h());
    });
    // Signature help is a per-view concern (the active view shows the card while
    // typing); the document drives didChange, so this only triggers signature help.
    this.editorModel.onDidChangeText((event) => {
      this.maybeSignatureHelp(event);
      this.inlayHints.scheduleRefresh(); // hints shift as the text changes
    });
    // The hover popover is anchored to a fixed cursor position; dismiss it once
    // the cursor moves or the view scrolls (both no-ops when nothing is showing).
    this.subs.connect(this.buffer, 'notify::cursor-position', () => {
      this.dismissHover();
      if (this.signaturePopover.visible) this.scheduleSignatureRequest();
      this.scheduleLocationBarUpdate();
    });
    const hoverVadj = this.view.getVadjustment();
    if (hoverVadj)
      this.subs.connect(hoverVadj, 'value-changed', () => {
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
    // Disconnect every node-gtk GObject signal + global-registry subscription this
    // editor installed (the StyleManager / config / keymap-listener handlers, the
    // cursor/focus/key/scroll/banner signals). Each is a Global handle whose closure
    // captures `this`; left connected, ANY ONE pins the whole editor — and the owned
    // widgets are detached, not destroyed, on tab close, so they never finalize to
    // release these on their own. This is the dominant native-memory leak. See `subs`.
    this.subs.dispose();
    if (this.mapHandler) {
      this.view.off('map', this.mapHandler);
      this.mapHandler = null;
    }
    this.dismissSignature();
    this.hoverPopover.dispose(); // hide + unparent (a setParent'd popover must be unparented)
    this.signaturePopover.dispose();
    this.completion?.dispose(); // unparents the completion popover from the view
    this.searchBar?.dispose(); // sever the search bar's panel controllers + entry/button handlers
    this.decorationMaterializeSub?.(); // drop the materialize re-projection subscription
    this.decorationMaterializeSub = null;
    this.syntax.dispose(); // detach buffer/view signal handlers + free the tree-sitter tree
    // The inline overlays/decorations install their own view/buffer/adjustment signal handlers
    // (outside `subs`); each un-disconnected one pins this editor, so tear them down explicitly.
    this.textDecorations.dispose(); // drops the diagnostic-squiggle overlay's handlers + marks
    this.stickyHeaderController?.dispose(); // drop its header handles + sever each header's click controller (rides the block surface)
    this.blockDecorationController.dispose(); // drops map/changed/vadjustment handlers + tick callbacks
    this.indentGuides?.dispose(); // drops adjustment/view/buffer handlers + the config observer
    this.indentGuides = null;
    this.editorModel.dispose(); // sever the buffer cursor/insert/delete/changed handlers (each pins this editor)
    this.commentBox?.dispose(); // close any open comment box (idempotent; also dropped via the peek's onClose)
    this.commentBox = null;
    this.inlinePeek?.dispose(); // sever the peek's overlay/adjustment handlers + drop its gap tag
    this.document.removeHost(this);
    this.document.removeView(this.screen);
    if (this.releaseDocument) this.releaseDocument();
    else this.document.dispose();
    this.diagnostics?.dispose(); // undefined for a buffer-only editor (installLsp skipped)
    this.inlayHints?.dispose();
    // The gutter holds a git.onChange subscription living in GitRepo.listeners; tab-close
    // DETACHES the root (never destroys it), so a `destroy` handler wouldn't fire. Dispose
    // it explicitly, else the subscription pins the gutter → view → buffer → this editor
    // forever (and keeps closed editors in the git notify fan-out).
    this.gitGutter?.dispose();
    this.gitGutter = null;
  }

  // Request signature help when typing inside a call. Triggered when a trigger
  // char (`(`, `,`) appears in the *typed text* — not the char before the cursor,
  // which autopair leaves as the auto-inserted `)` — or while the card is already
  // up (to track the active parameter / detect leaving the call). Debounced so the
  // autopair's `()` insert + cursor move settle before we ask; the request then
  // uses the settled cursor, and a null result (cursor left the call) hides it.
  private maybeSignatureHelp(event: { changes: { newText: string }[] }) {
    if (this.vimState.mode !== 'insert' || !this.lspDocument) return;
    const triggers = zym.lsp.signatureHelpTriggerCharacters(this.lspDocument);
    const typed = event.changes.map((c) => c.newText).join('');
    const typedTrigger = [...typed].some((ch) => triggers.includes(ch));
    if (!this.signaturePopover.visible && !typedTrigger) return;
    this.scheduleSignatureRequest();
  }

  // Debounced (re)request — coalesces the autopair edits + cursor moves of one
  // keystroke into a single request against the settled cursor.
  private scheduleSignatureRequest() {
    if (this.signatureTimer) clearTimeout(this.signatureTimer);
    this.signatureTimer = setTimeout(() => {
      this.signatureTimer = null;
      this.requestSignatureHelp();
    }, SIGNATURE_DEBOUNCE_MS);
  }

  private requestSignatureHelp() {
    if (!this.lspDocument) return;
    const seq = ++this.signatureSeq;
    void zym.lsp.signatureHelp(this.lspDocument).then((help) => {
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
    this.signatureCard.setMarkup(
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
      if (!this.signaturePopover.showAt(anchor)) return; // off-screen → retry
      this.signatureAnchored = true;
    } else {
      this.signaturePopover.show();
    }
  }

  private dismissSignature() {
    if (this.signatureTimer) {
      clearTimeout(this.signatureTimer);
      this.signatureTimer = null;
    }
    this.signatureSeq++; // invalidate any in-flight request
    this.signatureAnchored = false; // the next call re-anchors at its own site
    this.signaturePopover.hide();
  }

  // --- Git gutter ------------------------------------------------------------

  /** Re-point the change gutter at a different repo when this editor's workbench re-roots
   *  into a worktree (a no-op in buffer mode or before a gutter exists). The LocationBar's
   *  base cwd follows the re-root on its own — it reads the workbench cwd through a getter. */
  setGitRepo(git: GitRepo): void {
    this.gitRepo = git;
    this.gitGutter?.setGit(git);
  }

  private installGitGutter() {
    if (this.embedded || !this.gitRepo) return; // file mode with a repo only
    this.gitGutter = new GitGutter(
      this.syntax, // feed the change-bar cell into the editor's single composite gutter
      () => this._currentFile,
      () => this.document.getText(), // diff against the MODEL (full file), not the collapsed view
      this.gitRepo,
      (line) => this.screen.documentLineForScreenLine(line),
      () => this.root.getMapped(), // off-screen editors defer their git-show refresh
    );
    // When this editor is shown again (tab activated / dock revealed), run any
    // refresh deferred while it was off-screen so the bars catch up.
    this.subs.connect(this.root, 'map', () => this.gitGutter?.notifyVisible());
    // Let the vim layer reach the gutter's hunk ranges (for `]h`/`[h`). Hunk rows are
    // MODEL/file rows; translate to view rows (folded ones collapse onto one line).
    this.editorModel.setHunkProvider(() => [
      ...new Set((this.gitGutter?.hunkStartRows() ?? []).map((r) => this.screen.screenLineForDocumentLine(r))),
    ]);
    // Live updates: re-diff the buffer (debounced) on every edit.
    this.editorModel.onDidChangeText(() => this.gitGutter?.scheduleUpdate());
    // dispose() disposes the gutter explicitly (and nulls it); no `destroy` handler
    // here — `destroy` never fires on tab-close detach, and it would itself pin us.

    // Hunk-level staging on the hunk under the cursor (gutter bars). Bound to the
    // `space h …` leader; the gutter does the index `git apply`, revert is an
    // in-buffer edit (so it's a single undo).
    zym.commands.add(this.view, {
      'git:hunk-stage': { didDispatch: () => this.stageHunkAtCursor(), description: 'Stage the hunk under the cursor' },
      'git:hunk-unstage': { didDispatch: () => this.unstageHunkAtCursor(), description: 'Unstage the hunk under the cursor' },
      'git:hunk-revert': { didDispatch: () => this.revertHunkAtCursor(), description: 'Revert the hunk under the cursor' },
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
      if (!hunk) return zym.notifications.addTrace('No unstaged hunk under the cursor');
      gutter.stageHunk(hunk, (ok, error) => {
        if (!ok) zym.notifications.addError('Failed to stage hunk', { detail: error.trim() });
      });
    });
  }

  private unstageHunkAtCursor(): void {
    this.withHunkGutter((gutter, row) => {
      const hunk = gutter.stagedHunkAtRow(row);
      if (!hunk) return zym.notifications.addTrace('No staged hunk under the cursor');
      gutter.unstageHunk(hunk, (ok, error) => {
        if (!ok) zym.notifications.addError('Failed to unstage hunk', { detail: error.trim() });
      });
    });
  }

  // Revert (discard) the unstaged hunk under the cursor: replace its buffer rows
  // with the index version (`hunk.oldLines`), as one undoable edit, then save so
  // the working tree matches.
  private revertHunkAtCursor(): void {
    this.withHunkGutter((gutter, row) => {
      const hunk = gutter.unstagedHunkAtRow(row);
      if (!hunk) return zym.notifications.addTrace('No unstaged hunk under the cursor');
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

  /** The LSP document adapter for this editor (used by `lsp:*` commands). Only ever read on a
   *  file editor — buffer-only / multibuffer editors (where it's null) aren't the `activeEditor`
   *  these commands target, so the non-null contract holds for every caller. */
  get lsp(): LspDocument {
    return this.lspDocument!;
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
    const markdown = await zym.lsp.hover(this.lspDocument);
    this.dismissHover();
    if (!markdown) return;
    this.hoverCard.setMarkdown(markdown);
    this.hoverPopover.showAt(this.editorModel.getCursorBufferPosition());
  }

  private dismissHover() {
    this.hoverPopover.hide();
  }

  /** Syntax-highlight a card's fenced code block (hover / signature / completion doc): the
   *  fence's language, falling back to this file's so same-language code still gets colors. */
  private cardHighlight(code: string, lang: string | undefined): string | null {
    const fallback = this._currentFile ? langIdForPath(this._currentFile) ?? undefined : undefined;
    return highlightToMarkup(code, lang ?? fallback);
  }

  /** The canonical `TextEditorSource` text (the whole file, or the multibuffer's text) —
   *  distinct from `getText()`, which returns the view buffer where an inline fold has
   *  swapped its range for a `[N]` placeholder. File-line-coordinate features (git blame)
   *  need the source so a folded line isn't misread as changed. */
  get sourceText(): string {
    return this.document.getText();
  }

  /** Show arbitrary Pango markup in the hover popover, left-aligned at the cursor (the LSP
   *  hover card, reused for non-LSP popups like the git-blame commit message). */
  showHoverMarkup(markup: string): void {
    this.hoverCard.setMarkup(markup);
    this.hoverPopover.showAt(this.editorModel.getCursorBufferPosition());
  }

  /** Subscribe to cursor-position changes (Atom `onDidChangeCursorPosition` shape). For
   *  editor-observing features that follow the caret, e.g. current-line git blame. */
  onDidChangeCursorPosition(callback: () => void): Disposable {
    this.buffer.on('notify::cursor-position', callback);
    return new Disposable(() => this.buffer.off('notify::cursor-position', callback));
  }

  /** Subscribe to fold open/close — view rows shift under model-positioned decorations,
   *  so fold-aware features re-place themselves (no model round-trip). */
  onDidChangeFolds(callback: () => void): Disposable {
    this.foldsChangedHandlers.add(callback);
    return new Disposable(() => this.foldsChangedHandlers.delete(callback));
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

  /** The generic block-decoration primitive (virtual content between lines, e.g. the diff fold
   *  placeholder) — a widget in a reserved gap, zero buffer footprint, anchored by a view line. */
  get inlineBlocks(): BlockDecorations {
    return this.blockDecorationController;
  }

  /** A declarative, SOURCE-anchored block-decoration set over this editor (the search/diff header
   *  + gap bands, markdown inline images). Declare specs via `set()`; the set reconciles them and
   *  projects each `{documentKey?, row}` anchor onto its view line. Positions then ride the
   *  primitive's marks across edits; the editor re-projects the set only on a re-materialize. */
  blockDecorations(): BlockDecorationSet {
    const set = new BlockDecorationSet(this.blockDecorationController, (anchor) =>
      'viewRow' in anchor ? anchor.viewRow : this.document.screenRowForDocument(this.screen, anchor.documentKey, anchor.row),
    );
    this.decorationSets.push(set);
    this.decorationMaterializeSub ??= this.document.onDidMaterialize(() => {
      for (const s of this.decorationSets) s.reproject();
    });
    return set;
  }

  /** Reusable per-excerpt sticky headers (the multi-file diff, project-search next) — a multibuffer
   *  surface drives it via `setHeaders()`; it owns the pinning + caret-follow focus + no-cursor
   *  decoration. Inert (no headers) for every other editor. */
  get stickyHeaders(): StickyHeaders {
    return this.stickyHeaderController;
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

  // --- Comment to agent ------------------------------------------------------
  // The same inline box + message format the diff uses (DiffCommentBox / formatAgentComment), but on
  // an ordinary file editor: `enter` in normal mode (or on a visual selection) opens the box and the
  // submit is delivered to `onComment`. Single comment only — no review-mode accumulation (that
  // stays diff-only). See docs/text-editor/comment-to-agent.md.

  /** Register the `editor:comment` command (the `enter`/visual action). Wired only when `onComment`
   *  was provided — i.e. on file editors, not inputs/peeks/multibuffers. */
  private installComment(): void {
    this.subs.add(
      zym.commands.add(this.view, {
        'editor:comment': {
          didDispatch: () => this.startComment(),
          description: 'Comment on this line / selection to the agent',
        },
      }),
    );
  }

  /** Open the inline comment box on the cursor row or the active selection; on submit, format the
   *  `path:line` + code + text and hand it to the agent (`onComment`). No-op without a file path. */
  startComment(): void {
    const onComment = this.onComment;
    if (!onComment) return;
    if (this.commentBox) this.closeComment(); // re-target onto the current row
    const hadSelection = !this.editorModel.getSelectedBufferRange().isEmpty();
    const target = this.buildEditorCommentTarget();
    if (!target) return void zym.notifications.addTrace('No file line to comment on');
    const { anchorRow, ...parts } = target;

    const box = new DiffCommentBox({
      reviewable: false, // single comment only on a file editor
      onSubmit: (text) => {
        const comment = text.trim();
        this.closeComment();
        if (!comment) return;
        // Sending consumes a visual selection — drop it (back to normal mode, like Esc) so the
        // commented range isn't left highlighted. A bare-cursor comment leaves the cursor as-is.
        if (hadSelection) this.vimState.resetNormalMode();
        onComment(formatAgentComment({ ...parts, comment }));
      },
      onCancel: () => this.closeComment(),
    });
    this.commentBox = box;
    this.showPeek({
      line: anchorRow,
      widget: box.root,
      height: box.height,
      alignLeft: true,
      // Defer box teardown off its own key dispatch (disposing the nested editor synchronously is
      // unsafe — see Peek); when the view itself is tearing down, dispose now (no tick on a dead view).
      onClose: () => {
        if (this.commentBox === box) this.commentBox = null;
        if (this.disposed) return void box.dispose();
        this.view.addTickCallback(() => (box.dispose(), false));
      },
    });
    box.focus();
  }

  private closeComment(): void {
    if (!this.commentBox) return;
    this.closePeek(); // the peek's onClose disposes the box
    this.focus();
  }

  /** Build the comment target from the cursor / selection: the file-relative `path:line`, the
   *  selected lines as plain code, a `L…`/`cols…` locator, and the view row to anchor the box below.
   *  Line numbers are DOCUMENT lines (fold-correct). Returns null when the editor has no file. */
  private buildEditorCommentTarget(): { rel: string; line: number; fence: string; body: string; locator: string; anchorRow: number } | null {
    const path = this._currentFile;
    if (!path) return null;
    const range = this.editorModel.getSelectedBufferRange();
    const empty = range.isEmpty();
    const r0 = range.start.row;
    // An exclusive end at column 0 means the last row isn't actually selected (line-wise selection).
    const r1 = !empty && range.end.row > r0 && range.end.column === 0 ? range.end.row - 1 : range.end.row;

    // View rows → document lines (fold-correct), clamped to the file.
    const docCount = this.document.documentLineCount();
    const toDoc = (viewRow: number): number =>
      Math.max(0, Math.min(docCount - 1, this.screen.documentPointFromScreen(new Point(viewRow, 0)).row));
    const docStart = toDoc(r0);
    const docEnd = Math.max(docStart, toDoc(r1));

    const body = Array.from({ length: docEnd - docStart + 1 }, (_, i) => this.document.documentLineText(docStart + i)).join('\n');
    // Locator: line span, plus columns for an explicit sub-line selection (where it adds information).
    const span = docStart === docEnd ? `L${docStart + 1}` : `L${docStart + 1}-${docEnd + 1}`;
    const cols: string[] = [];
    if (!empty && r0 === r1) {
      const sc = range.start.column, ec = range.end.column; // selection covers [sc, ec)
      const len = this.document.documentLineText(docStart).length;
      if (sc === ec) cols.push(`col ${sc + 1}`);
      else if (!(sc === 0 && ec >= len)) cols.push(`cols ${sc + 1}-${ec}`);
    }
    return {
      rel: Path.relative(this.workbenchCwd(), path),
      line: docStart + 1, // 1-based file line
      fence: langIdForPath(path) ?? '',
      body,
      locator: [span, ...cols].join(', '),
      anchorRow: r1,
    };
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
    this.subs.connect(this.view, 'map', () => this.view.addTickCallback(tick));
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
    const view = new EditorSourceView({ buffer });
    // Paint the indent guides (below text) + diagnostic squiggles (above text)
    // inside the view's own snapshot, so they scroll with the text instead of
    // repainting viewport-pinned overlays every frame (see paintLayer).
    view.layerPainter = (layer, snapshot) => this.paintLayer(layer, snapshot);
    view.addCssClass('zym-editor'); // monospace font applied via CSS (font store)
    if (this.cssClass) for (const c of this.cssClass.split(/\s+/)) if (c) view.addCssClass(c);
    view.setAutoIndent(true);
    view.setTabWidth(TAB_WIDTH);
    view.setVexpand(!this.growToContent); // auto-height: size to content, don't fill
    view.setHexpand(true);
    // Line numbers are drawn by SyntaxController's fold-aware gutter (not the
    // built-in one, which mashes folded line numbers together), gated on
    // !bufferMode where SyntaxController is given `lineNumbers: true`.
    if (this.embedded) {
      // An embedded surface (a buffer input or a multibuffer): no right-margin guide or
      // current-line highlight, and a symmetric `padding` inset on all four sides. The inset
      // defaults to 0, so a surface with its own left gutter (the diff/search multibuffers) sits
      // flush against it; inputs that want breathing room pass `padding` (`createInput` does).
      view.setShowRightMargin(false);
      view.setHighlightCurrentLine(false);
      const padding = this.paddingOverride ?? 0;
      view.setLeftMargin(padding);
      view.setRightMargin(padding);
      view.setTopMargin(padding);
      view.setBottomMargin(padding);
    } else {
      view.setHighlightCurrentLine(true);
      view.setShowRightMargin(true);
      view.setRightMarginPosition(RIGHT_MARGIN);
    }

    // Soft-wrap: wrap long lines to the editor width instead of scrolling horizontally.
    // Vim display-line motion (j/k, gj/gk) is wrap-aware via EditorModel.displayLineMove.
    // Forced off in long-line mode (wrapping a giant line re-flows it on every layout).
    // The enabled state has three sources, in priority order: an explicit per-editor
    // `softWrap` option (wins, and opts out of live config tracking); otherwise the
    // `editor.softWrap` config for a file editor (live-toggled); otherwise off for an
    // embedded editor (diff panes, search results — they never wrapped). Inputs created
    // via `createInput()` pass `softWrap: true` to wrap regardless of the config.
    const configDefault = this.embedded ? false : zym.config.get('editor.softWrap') !== false;
    let wrapEnabled = this.softWrapOverride ?? configDefault;
    this.applyWrap = () =>
      view.setWrapMode(this.longLineMode || !wrapEnabled ? Gtk.WrapMode.NONE : Gtk.WrapMode.WORD_CHAR);
    if (this.softWrapOverride === undefined && !this.embedded) {
      this.subs.add(
        zym.config.observe('editor.softWrap', (v) => {
          wrapEnabled = v !== false;
          this.applyWrap();
        }),
      );
    } else {
      this.applyWrap();
    }
    return view;
  }

  private buildEditorArea() {
    const scrolled = new Gtk.ScrolledWindow();
    scrolled.setChild(this.view);
    scrolled.setHexpand(true);

    // Auto-height: request the view's natural (content) height so the input grows with its
    // text instead of filling its allocation. A cap (`maxLines` or `maxHeight`) clamps it —
    // past the cap the ScrolledWindow keeps that height and scrolls internally. The outer box
    // opts out of vexpand below so the natural height propagates up to the editor root.
    if (this.growToContent) {
      // propagate-natural-height makes the ScrolledWindow size to the view's content, so
      // the input grows/shrinks with its text (cap below). That handles edits natively and
      // exactly — no manual height math.
      scrolled.setPropagateNaturalHeight(true);
      const padding = this.paddingOverride ?? 0;
      // Cap at N *text* lines (line-heights + the top+bottom padding the natural height
      // also includes) or a raw max height; past it the ScrolledWindow scrolls.
      const capValue = (): number | undefined =>
        this.growMaxLines !== undefined
          ? Math.round(this.growMaxLines * this.editorModel.getLineHeightInPixels() + 2 * padding)
          : this.growMaxHeight;
      const applyCap = () => {
        const cap = capValue();
        if (cap !== undefined) scrolled.setMaxContentHeight(cap);
      };
      // A min-height *floor* from the line count, so the first (stale) natural-height
      // allocation isn't collapsed — without it the input flickers from collapsed to its
      // real height on the first frame. Only a floor: propagate-natural-height still gives
      // the true height (≥ this, so wrapped lines and the exact size win), and it tracks
      // edits so shrinking isn't blocked.
      const applyFloor = () => {
        const cap = capValue();
        const h = Math.round(Math.max(1, this.editorModel.getLineCount()) * this.editorModel.getLineHeightInPixels() + 2 * padding);
        scrolled.setMinContentHeight(cap !== undefined ? Math.min(h, cap) : h);
      };
      applyCap();
      applyFloor();
      this.editorModel.onDidChangeText(applyFloor);
      // The view's first natural-height allocation can still come out stale; force one
      // relayout after map so propagate settles on the exact height (the floor only guards
      // the very first frame).
      this.subs.connect(this.view, 'map', () => {
        applyCap();
        applyFloor();
        let frames = 0;
        this.view.addTickCallback(() => { this.view.queueResize(); return ++frames < 2; });
      });
    }

    // Scroll-past-end (`editor.scrollPastEnd`): GtkSourceView has no native option,
    // so we emulate it with a dynamic bottom margin sized to ~one viewport minus a
    // line — enough that the last line can scroll up to the top. The vadjustment
    // fires `changed` whenever the viewport (page-size) or content height shifts,
    // which covers resizes, font changes, and edits. Buffer-mode keeps its small
    // fixed margin (set in createView) and opts out.
    if (!this.embedded) {
      const vadj = scrolled.getVadjustment();
      let pastEndEnabled = zym.config.get('editor.scrollPastEnd') !== false;
      let lastMargin = -1;
      let pendingId: NodeJS.Timeout | null = null;
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
        pendingId = setTimeout(() => {
          pendingId = null;
          applyPastEnd();
        }, 0);
      };
      this.subs.connect(vadj, 'changed', scheduleApply);
      this.subs.add(
        new Disposable(() => {
          if (pendingId) clearTimeout(pendingId);
        }),
      );
      this.subs.add(
        zym.config.observe('editor.scrollPastEnd', (v) => {
          pastEndEnabled = v !== false;
          applyPastEnd();
        }),
      );
    }

    // Overlay the scrolled view with the editor-local widgets: the diagnostic
    // squiggle layer (under the caret/showcmd), the showcmd preview
    // (bottom-right), and the hollow-caret layer (positioned per-cursor).
    const overlay = new Gtk.Overlay();
    overlay.setChild(scrolled);
    this.contentOverlay = overlay; // hosts the bottom-aligned hover card
    // Focusable inline peek (see-definition) — lives in this sibling overlay.
    this.inlinePeek = new Peek(this.view, overlay);

    // Indent guides + diagnostic squiggles are painted INSIDE the view's snapshot
    // (paintLayer / EditorSourceView), not as overlay widgets — so they scroll with
    // the text instead of repainting every frame. Held so `dispose()` can detach the
    // guides' buffer/config handlers (they'd pin the editor).
    this.indentGuides = new IndentGuides(this.view, this.editorModel);

    // The search/replace bar floats at the top-right; it adds itself to `overlay`.
    this.searchBar = new SearchBar(overlay, this.search, this.view);

    this.showcmdLabel.addCssClass('zym-showcmd');
    this.showcmdLabel.setHalign(Gtk.Align.END);
    this.showcmdLabel.setValign(Gtk.Align.END);
    this.showcmdLabel.setVisible(false);
    this.showcmdLabel.setCanTarget(false); // never steal clicks
    overlay.addOverlay(this.showcmdLabel);

    this.caret.addCssClass('zym-unfocused-caret');
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

    // Autocompletion: the popup floats in this overlay; sources are registered
    // here (buffer words + LSP — Copilot lands later). It is dismissed whenever
    // the vim layer leaves insert mode. The LSP source no-ops for a fileless
    // buffer (`lspDocument` undefined) or until a server is up.
    // Built *after* `caretLayer`/`leapLayer` so the popup (which adds itself to
    // `overlay` in its constructor) stacks above the carets — GtkOverlay paints
    // children in add order, so an earlier popup would sit under the secondary
    // multi-cursor carets.
    this.completion = new CompletionController(
      this.editorModel,
      this.view,
      () => this.vimState.mode === 'insert',
      // Tree-sitter highlight code blocks in completion docs, like the hover card;
      // unlabeled fences fall back to this file's language.
      (code, lang) => {
        const fallbackLang = this._currentFile ? langIdForPath(this._currentFile) ?? undefined : undefined;
        return highlightToMarkup(code, lang ?? fallbackLang);
      },
    );
    // Buffer-words completion is disabled for now (kept for reference / quick re-enable):
    // this.completion.addSource(createBufferWordsSource(() => this.editorModel.getText()));
    void createBufferWordsSource; // keep the import live while the source is disabled
    this.completion.addSource(createLspCompletionSource(zym.lsp, () => this.lspDocument ?? null));
    this.vimState.onDidActivateMode(({ mode }: { mode: string }) => {
      if (mode !== 'insert') this.completion.dismiss();
    });

    // LSP hover + signature help: MarkupCards in EditorPopovers pointed at the cursor cell.
    // Prose stays in the proportional UI font; only code spans are monospace; the card has a
    // fixed min width and left-aligns (see showHoverMarkup).
    this.hoverCard = new MarkupCard({ widthPx: HOVER_WIDTH_PX, maxWidthChars: HOVER_MAX_WIDTH_CHARS, highlight: (c, l) => this.cardHighlight(c, l) });
    this.hoverPopover = new EditorPopover(this.editorModel, this.view, this.hoverCard.label, { chrome: CARD_CONTENT_INSET_PX });

    this.signatureCard = new MarkupCard({ widthPx: HOVER_WIDTH_PX, maxWidthChars: HOVER_MAX_WIDTH_CHARS, highlight: (c, l) => this.cardHighlight(c, l) });
    this.signaturePopover = new EditorPopover(this.editorModel, this.view, this.signatureCard.label, { chrome: CARD_CONTENT_INSET_PX });

    // Buffer-only mode: a greyed placeholder over the empty buffer, and no minimap.
    if (this.bufferMode?.placeholder) {
      this.placeholderLabel = new Gtk.Label({ label: this.bufferMode.placeholder });
      this.placeholderLabel.addCssClass('zym-placeholder');
      this.placeholderLabel.setHalign(Gtk.Align.START);
      this.placeholderLabel.setValign(Gtk.Align.START);
      // Align the placeholder with where typed text lands: the view's inner padding.
      const padding = this.paddingOverride ?? 0;
      this.placeholderLabel.setMarginStart(padding);
      this.placeholderLabel.setMarginTop(padding);
      this.placeholderLabel.setCanTarget(false);
      overlay.addOverlay(this.placeholderLabel);
      this.subs.connect(this.buffer, 'changed', () =>
        this.placeholderLabel!.setVisible(this.buffer.getCharCount() === 0),
      );
    }

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    box.append(overlay);
    if (!this.embedded) {
      // The minimap mirrors the view and doubles as a scrollbar. Off by default;
      // `editor.minimap` toggles it live.
      const minimap = new GtkSource.Map();
      minimap.setView(this.view);
      box.append(minimap);
      this.subs.add(zym.config.observe('editor.minimap', (v) => minimap.setVisible(v === true)));
    }

    // Unified info banner: disk-change warnings, load errors, and save errors all use
    // this single Revealer. `showBanner` sets the color class, message, and optional
    // action button; `hideBanner` collapses it. A custom Revealer+Box rather than
    // Adw.Banner so we control the layout (full-width tint, centered content).
    this.subs.connect(this.bannerButton, 'clicked', () => this.bannerAction?.());
    const bannerDismiss = new Gtk.Button({ label: 'Dismiss' });
    this.subs.connect(bannerDismiss, 'clicked', () => this.banner.setRevealChild(false));
    const bannerContent = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 16 });
    bannerContent.setHexpand(true);
    bannerContent.setHalign(Gtk.Align.CENTER);
    bannerContent.append(this.bannerLabel);
    bannerContent.append(this.bannerButton);
    bannerContent.append(bannerDismiss);
    this.bannerBox.append(bannerContent);
    this.banner.setChild(this.bannerBox);
    this.banner.setRevealChild(false);

    box.setVexpand(!this.growToContent); // auto-height inputs hug their content
    box.setHexpand(true);
    const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    outer.append(this.banner);
    // Location bar (file path + breadcrumb), pinned above the content. Main editors only;
    // it hides itself until a file is loaded and refreshes on cursor move / reparse.
    if (!this.embedded) {
      this.locationBar = new LocationBar(this.workbenchCwd);
      this.locationBar.widget.setVisible(false);
      outer.append(this.locationBar.widget);
      this.subs.add(
        zym.config.observe('editor.locationBar', (v) => this.applyLocationBarConfig(v !== false)),
      );
      const reparseUnsub = this.document.documentSyntax?.onDidReparse(() => this.scheduleLocationBarUpdate());
      if (reparseUnsub) this.subs.add(new Disposable(reparseUnsub));
      this.subs.add(new Disposable(() => {
        if (this.locationBarTimer) clearTimeout(this.locationBarTimer);
        this.locationBarTimer = null;
      }));
      this.scheduleLocationBarUpdate();
    }
    outer.append(box);
    return outer;
  }

  // Whether the user has the location bar enabled; gates visibility on top of the
  // "hide while fileless" rule the bar applies itself.
  private locationBarEnabled = true;

  private applyLocationBarConfig(enabled: boolean): void {
    this.locationBarEnabled = enabled;
    this.scheduleLocationBarUpdate();
  }

  /** Coalesce the (high-frequency) cursor-move / reparse refreshes into one pass before the
   *  next paint. Recomputes the path and the breadcrumb from the current cursor scope. */
  private scheduleLocationBarUpdate(): void {
    if (!this.locationBar || this.locationBarTimer) return;
    this.locationBarTimer = setTimeout(() => {
      this.locationBarTimer = null;
      if (this.disposed || !this.locationBar) return;
      if (!this.locationBarEnabled) {
        this.locationBar.widget.setVisible(false);
        return;
      }
      this.locationBar.setFile(this.currentFile);
      const { row, column } = this.editorModel.getCursorBufferPosition();
      this.locationBar.setBreadcrumb(this.syntax.breadcrumbAt(row, column));
    }, 0);
  }

  // --- Cursor overlay (hollow caret while unfocused) -------------------------

  private installCursorOverlay() {
    // EditorModel decides how the caret renders (reverse-video tag on a glyph,
    // or an overlay box at positions with none / when unfocused) and drives this
    // — including on cursor-position changes, so a mouse click repositions it.
    this.editorModel.onCursorOverlay = (kind, iter) => this.renderCursorOverlay(kind, iter);
    this.editorModel.onExtraCursors = (carets) => this.renderExtraCarets(carets);
    // Suppress the caret where a `no-cursor` decoration is set (the diff's read-only header rows).
    this.editorModel.shouldHideCursorAt = (iter) => this.textDecorations.isCursorHiddenAt(iter);
    // Keep the caret below any sticky block pinned at the viewport top (the diff's pinned header), so
    // scrolloff/motions don't park it underneath. 0 for a plain editor (no sticky bands).
    this.editorModel.topInsetProvider = () => this.blockDecorationController.stickyTopInset();

    // The overlay caret is placed from view geometry, which is all-zero until the
    // first size-allocate — so the caret painted during load (cursor at 0,0 on an
    // empty/EOL line) lands over the gutter and only corrects on the next cursor
    // move. `map` fires before that first layout pass (line geometry still 0, per
    // revealPeekRow), so re-render on a tick that waits for a real height.
    this.subs.connect(this.view, 'map', () => {
      let frames = 0;
      this.view.addTickCallback(() => {
        if (this.view.getRealized() && this.view.getHeight() > 0) {
          this.editorModel.refreshCursorStyle();
          return false; // G_SOURCE_REMOVE
        }
        return ++frames < 120; // keep trying ~2s then give up
      });
    });

    // The overlay carets sit on a `Gtk.Fixed` at window coords that the view scrolls out from
    // under, so re-place them on every scroll (the reverse-video tag caret scrolls natively).
    // Rebind on notify::v/hadjustment: the ScrolledWindow swaps in its own adjustments when
    // the view is parented, so a one-time binding can catch a throwaway adjustment whose
    // value-changed never fires (mirrors IndentGuides / UnderlineOverlay).
    const reposition = () => this.repositionOverlayCarets();
    const bindScroll = (getter: 'getVadjustment' | 'getHadjustment', notify: string) => {
      let bound: ReturnType<SourceView[typeof getter]> | null = null;
      const rebind = () => {
        const adj = this.view[getter]?.();
        if (!adj || adj === bound) return;
        if (bound) bound.off('value-changed', reposition); // drop the stale binding first
        bound = adj;
        adj.on('value-changed', reposition);
      };
      rebind();
      this.view.on(notify, rebind);
      this.subs.add(new Disposable(() => {
        this.view.off(notify, rebind);
        if (bound) bound.off('value-changed', reposition);
      }));
    };
    bindScroll('getVadjustment', 'notify::vadjustment');
    bindScroll('getHadjustment', 'notify::hadjustment');

    const focus = new Gtk.EventControllerFocus();
    this.subs.connect(focus, 'enter', () => {
      this.editorModel.setFocused(true);
      // This view is now the active one of its (possibly shared) document, so the LSP
      // cursor / dialogs / load-save reactions route here.
      this.document.setActiveHost(this);
    });
    this.subs.connect(focus, 'leave', () => {
      // The search bar is part of the editor: while it holds focus, keep the
      // active caret rather than switching to the unfocused (inactive) one.
      if (this.searchBar.isOpen) return;
      this.editorModel.setFocused(false);
    });
    this.subs.addController(this.view, focus);
  }

  /**
   * Paint the editor's snapshot layers (`EditorSourceView.layerPainter`): the
   * current-line highlight + indent guides on the BELOW_TEXT layer, diagnostic
   * squiggles on ABOVE_TEXT. The snapshot is in buffer coordinates, so each painter
   * draws at iter locations directly (no buffer→window conversion). Folding this into
   * the view's own snapshot lets them scroll with the text for free (the view
   * re-snapshots on scroll; no per-frame overlay widget repaint).
   *
   * The current-line highlight is re-drawn here because EditorSourceView's
   * `snapshot_layer` override replaces GtkSourceView's own (node-gtk can't chain up
   * to super — see EditorSourceView). GtkSourceView's right-margin guide is also
   * replaced, but it is imperceptible with our scheme, so it isn't re-drawn.
   */
  private paintLayer(layer: any, snapshot: any): void {
    const below = layer === Gtk.TextViewLayer.BELOW_TEXT;
    const above = layer === Gtk.TextViewLayer.ABOVE_TEXT;
    if (!below && !above) return;
    if (!this.view.getRealized()) return;
    const rect = this.view.getVisibleRect();
    if (!rect || !rect.height) return;
    const bounds = new Graphene.Rect();
    bounds.init(rect.x, rect.y, rect.width, rect.height);
    const cr = snapshot.appendCairo(bounds);
    if (below) {
      this.paintCurrentLine(cr, rect);
      this.indentGuides?.paint(cr);
    } else {
      this.textDecorations.paintUnderlines(cr);
    }
  }

  // Current-line highlight color: GtkSourceView's default tint is the editor
  // background lightened a touch (sampled #2c2c30 from the stock renderer; lighten
  // 0.05 reproduces it). Parsed once.
  private currentLineRgba: InstanceType<typeof Gdk.RGBA> | null = null;

  /** Re-draw the current-line highlight that GtkSourceView would have painted in its
   *  own `snapshot_layer` (a full-width band on the insert line), in buffer coords.
   *  Reads the *display* caret position, not the raw insert mark — in a linewise
   *  visual selection the mark sits at the next line's start, which painted the
   *  band one row below the caret. */
  private paintCurrentLine(cr: any, rect: { x: number; width: number }): void {
    if (!(this.view as any).getHighlightCurrentLine?.()) return;
    const iter = this.editorModel.cursorDisplayIter();
    const loc = (this.view as any).getIterLocation(iter);
    if (!this.currentLineRgba) {
      this.currentLineRgba = new Gdk.RGBA();
      this.currentLineRgba.parse(Color.lighten(theme.ui.view.bg, 0.05));
    }
    const c = this.currentLineRgba;
    cr.setSourceRgba(c.red, c.green, c.blue, c.alpha);
    cr.rectangle(rect.x, loc.y, rect.width, loc.height); // full visible width, one line tall
    cr.fill();
  }

  /**
   * Render the caret overlay box at `iter`: a hollow rectangle when the view is
   * unfocused, a filled block where there's no glyph to reverse-video (empty
   * line / past EOL / EOF). `hidden` (or a view not yet realized + laid out) hides it.
   */
  private renderCursorOverlay(kind: 'hidden' | 'hollow' | 'filled', iter?: unknown) {
    // `bufferToWindowCoords` reads view geometry that is all-zero until the first
    // size-allocate, so painting before then drops the caret at widget (0,0) — over
    // the gutter. Stay hidden until the view is actually laid out; the post-map tick
    // in installCursorOverlay re-renders once geometry is real.
    if (kind === 'hidden' || !iter || !this.view.getRealized() || this.view.getHeight() <= 0) {
      this.caret.setVisible(false);
      this.caretBufferGeom = null;
      return;
    }
    // getIterLocation gives the character cell (buffer coords); convert to the
    // view's widget coords (accounts for the gutter and scroll position).
    const cell = (this.view as any).getIterLocation(iter) as { x: number; y: number; width: number; height: number };
    // An empty line / EOL has near-zero cell width; fall back to a slim block.
    const width = cell.width > 1 ? cell.width : Math.max(2, Math.round(cell.height * 0.5));
    // Cache the buffer-space geometry so a later scroll can re-place the box.
    this.caretBufferGeom = { x: cell.x, y: cell.y, width, height: cell.height };
    const [winX, winY] = this.view.bufferToWindowCoords(Gtk.TextWindowType.WIDGET, cell.x, cell.y);
    this.caret.setSizeRequest(width, cell.height);
    this.caretLayer.move(this.caret, winX, winY);
    this.caret.removeCssClass(kind === 'filled' ? 'zym-unfocused-caret' : 'zym-block-caret');
    this.caret.addCssClass(kind === 'filled' ? 'zym-block-caret' : 'zym-unfocused-caret');
    this.caret.setVisible(true);
  }

  /**
   * Render the extra (multi-cursor) carets the model can't paint with a tag: beam
   * carets in insert mode (a thin bar) and block carets where there's no glyph to
   * reverse-video. Reuses a widget pool; surplus widgets are hidden.
   */
  private renderExtraCarets(carets: Array<{ iter: unknown; beam: boolean }>) {
    // As in renderCursorOverlay: geometry is zero until the first allocation, so
    // treat a not-yet-laid-out view as un-renderable (hide the pool) to avoid
    // stacking extra carets at (0,0).
    const realized = this.view.getRealized() && this.view.getHeight() > 0;
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
        this.extraCaretGeom[i] = null;
        continue;
      }
      const cell = (this.view as any).getIterLocation(carets[i].iter) as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      const beam = carets[i].beam;
      // Secondary insert-mode carets render as a 1px beam (thinner than the main
      // caret) so they read as subordinate, nudged 1px left to sit on the gap
      // between glyphs rather than the cell's left edge.
      const width = beam ? 1 : cell.width > 1 ? cell.width : Math.max(2, Math.round(cell.height * 0.5));
      // Cache buffer-space geometry so a scroll can re-place this caret (see renderCursorOverlay).
      this.extraCaretGeom[i] = { x: cell.x, y: cell.y, width, height: cell.height, beam };
      const [winX, winY] = this.view.bufferToWindowCoords(Gtk.TextWindowType.WIDGET, cell.x, cell.y);
      widget.setSizeRequest(width, cell.height);
      this.caretLayer.move(widget, beam ? winX - 1 : winX, winY);
      widget.removeCssClass(beam ? 'zym-block-caret' : 'zym-beam-caret');
      widget.addCssClass(beam ? 'zym-beam-caret' : 'zym-block-caret');
      widget.setVisible(true);
    }
    for (let i = carets.length; i < this.extraCarets.length; i++) {
      this.extraCarets[i].setVisible(false);
      this.extraCaretGeom[i] = null;
    }
  }

  /**
   * Re-place the overlay carets after a scroll. The block/hollow overlay box and the
   * multi-cursor carets live on a `Gtk.Fixed` at *window* coordinates, so they stay put when
   * the view scrolls beneath them — unlike the reverse-video tag caret, which is part of the
   * text and scrolls natively. Recompute window coords from the cached buffer-space geometry
   * (cheap arithmetic in `bufferToWindowCoords`) and move only the boxes that are shown;
   * a glyph caret caches nothing, so the common case does no work.
   */
  /** Drive a multibuffer projection's lazy syntax: parse the excerpt sources whose excerpts
   *  overlap the viewport, on scroll + first layout, instead of all up front (a broad project
   *  search / large diff can stitch hundreds of files; parsing each is O(file)). No-op unless the
   *  source is a multibuffer whose projection supports it (`ensureParsedForRange`). The
   *  ScrolledWindow swaps the view's vadjustment in after construction, so re-bind on
   *  notify::vadjustment (mirrors the overlay-caret bindScroll); the adjustment's `changed` fires
   *  on size-allocate, catching the first real viewport. A parsed source repaints via the
   *  painter's `onDidReparse` subscription. */
  private installLazyProjectionSyntax(): void {
    if (!this.document.syntaxProjection?.ensureParsedForRange) return;
    const schedule = () => {
      if (this.lazySyntaxThrottleId || this.disposed) return;
      this.lazySyntaxThrottleId = setTimeout(() => {
        this.lazySyntaxThrottleId = null;
        this.parseVisibleProjectionSources();
      }, LAZY_SYNTAX_THROTTLE_MS);
    };
    const rebind = () => {
      const adj = this.view.getVadjustment?.();
      if (!adj || adj === this.lazySyntaxAdj) return;
      if (this.lazySyntaxAdj) { this.lazySyntaxAdj.off('value-changed', schedule); this.lazySyntaxAdj.off('changed', schedule); }
      this.lazySyntaxAdj = adj;
      adj.on('value-changed', schedule); // scroll
      adj.on('changed', schedule); // size-allocate / content height (first real viewport)
    };
    rebind();
    this.view.on('notify::vadjustment', rebind);
    this.subs.add(new Disposable(() => {
      this.view.off('notify::vadjustment', rebind);
      if (this.lazySyntaxAdj) { this.lazySyntaxAdj.off('value-changed', schedule); this.lazySyntaxAdj.off('changed', schedule); }
      if (this.lazySyntaxThrottleId) clearTimeout(this.lazySyntaxThrottleId);
    }));
    if (this.view.getMapped()) this.parseVisibleProjectionSources();
    else this.subs.connect(this.view, 'map', () => this.parseVisibleProjectionSources());
  }

  /** Parse the projection sources whose excerpts overlap the viewport (± a margin). */
  private parseVisibleProjectionSources(): void {
    // Unrealized, the model reports the WHOLE buffer as visible — which would parse every source
    // and defeat the laziness. The triggers all fire post-realize; guard regardless.
    if (this.disposed || !this.view.getRealized()) return;
    const top = Math.max(0, this.editorModel.getFirstVisibleScreenRow() - LAZY_SYNTAX_MARGIN_ROWS);
    const bottom = this.editorModel.getLastVisibleScreenRow() + LAZY_SYNTAX_MARGIN_ROWS;
    this.ensureProjectionSyntax(top, bottom);
  }

  /** Parse the multibuffer projection's excerpt syntax for sources overlapping screen rows
   *  `[from, to]` (lazy-by-viewport). The viewport trigger calls this; exposed for pre-warming a
   *  range or for tests. No-op for a single-document editor. */
  ensureProjectionSyntax(from: number, to: number): void {
    if (from > to) return;
    this.document.syntaxProjection?.ensureParsedForRange?.(from, to);
  }

  private repositionOverlayCarets(): void {
    if (!this.view.getRealized()) return;
    if (this.caretBufferGeom) {
      const g = this.caretBufferGeom;
      const [winX, winY] = this.view.bufferToWindowCoords(Gtk.TextWindowType.WIDGET, g.x, g.y);
      this.caretLayer.move(this.caret, winX, winY);
    }
    for (let i = 0; i < this.extraCaretGeom.length; i++) {
      const g = this.extraCaretGeom[i];
      if (!g) continue;
      const [winX, winY] = this.view.bufferToWindowCoords(Gtk.TextWindowType.WIDGET, g.x, g.y);
      this.caretLayer.move(this.extraCarets[i], g.beam ? winX - 1 : winX, winY);
    }
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
    this.subs.add(
      zym.keymaps.addListener((key) => {
        if (!(this.view as any).hasFocus() || this.vimState.mode === 'insert') return false;
        if (!key.isModifier() && key.string && key.string.charCodeAt(0) >= 0x20) {
          this.setShowcmd(this.showcmd + key.string);
        }
        // Recompute after dispatch: if nothing is pending, the command resolved.
        queueMicrotask(() => {
          if (this.isVimIdle()) this.setShowcmd('');
        });
        return false; // never consume; this is display-only
      }),
    );
  }

  private isVimIdle(): boolean {
    const stack = this.vimState.operationStack;
    const register = this.vimState.__register;
    return (
      zym.keymaps.queuedKeystrokes.length === 0 &&
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

  // --- Line-editing commands (vim `y d`/`y u`, via the keymap) ---------------

  private installEditingCommands() {
    registerEditingKeymapsOnce();
    // Registered per-view so the keystroke duplicates the focused editor's line.
    zym.commands.add(this.view, {
      'editor:duplicate-line-below': { didDispatch: () => this.editorModel.duplicateLineBelow(), description: 'Duplicate the current line below' },
      'editor:duplicate-line-above': { didDispatch: () => this.editorModel.duplicateLineAbove(), description: 'Duplicate the current line above' },
      'editor:toggle-line-comments': { didDispatch: () => this.toggleLineComments(), description: 'Toggle line comments on the current line / selection' },
    });
  }

  /** `editor:toggle-line-comments` (`ctrl-/`): toggle line comments on the
   *  current line / selection, in any mode. Normal/visual mode runs the vim
   *  operator — it normalizes the visual selection (the raw range runs one row
   *  past a bottom-anchored linewise selection), restores the cursor onto the
   *  operated rows, and registers for `.` repeat. The direct path covers insert
   *  mode (ctrl-/ while typing). */
  private toggleLineComments(): void {
    const { vimState } = this;
    if (vimState.mode === 'visual') return void vimState.operationStack.run('ToggleLineComments');
    if (vimState.mode === 'normal') return void vimState.operationStack.run('ToggleLineCommentsCurrentLine');
    const model = this.editorModel;
    model.transact(() => {
      for (const range of model.getSelectedBufferRanges()) {
        let endRow = range.end.row;
        // A selection tail at column 0 doesn't include its row.
        if (endRow > range.start.row && range.end.column === 0) endRow -= 1;
        model.toggleLineCommentsForBufferRows(range.start.row, endRow);
      }
    });
  }

  // --- Folding commands (vim za/zo/zc/zr/zm, via the keymap's z-prefix) -------

  private installFoldCommands() {
    // The fold keys live in the vim keymap (normal-mode, z-prefix); they dispatch
    // these commands on this view, which drive the SyntaxController fold machinery
    // (tree-sitter folds, or a diff pane's unchanged-run folds). Registered per-view
    // so a keystroke folds the focused editor.
    zym.commands.add(this.view, {
      'fold:toggle': { didDispatch: () => this.placeCaretInRevealedFold(this.syntax.toggleFoldAtCursor()), description: 'Toggle the fold at the cursor' },
      'fold:open': { didDispatch: () => this.placeCaretInRevealedFold(this.syntax.setFoldAtCursor(false)), description: 'Open the fold at the cursor' },
      'fold:close': { didDispatch: () => this.syntax.setFoldAtCursor(true), description: 'Close the fold at the cursor' },
      'fold:open-recursive': { didDispatch: () => this.placeCaretInRevealedFold(this.syntax.setFoldAtCursorRecursive(false)), description: 'Open the fold at the cursor and all folds nested inside it' },
      'fold:close-recursive': { didDispatch: () => this.syntax.setFoldAtCursorRecursive(true), description: 'Close the fold at the cursor and all folds nested inside it' },
      'fold:open-all': { didDispatch: () => this.syntax.unfoldAll(), description: 'Open all folds' },
      'fold:close-all': { didDispatch: () => this.syntax.foldAll(), description: 'Close all folds' },
    });

    // Keep the cursor visible: if a move (w, /, G, a click, …) lands it inside a
    // folded body, open the fold (Vim's `foldopen`). Closing a fold moves the
    // cursor to the still-visible header, so this never fights `fold:close`.
    this.subs.connect(this.buffer, 'notify::cursor-position', () => {
      this.syntax.revealLine(this.editorModel.getCursorBufferPosition().row);
    });
  }

  /** VIEW line → MODEL line through the fold projection (the diff gutter keys by it). */
  documentLineForScreenLine(line: number): number {
    return this.screen.documentLineForScreenLine(line);
  }
  /** MODEL line → VIEW line (a folded run's model lines have no view line). */
  screenLineForDocumentLine(line: number): number {
    return this.screen.screenPointFromDocument(new Point(line, 0)).row;
  }

  /** After `zo`/`za` opens a fold, drop the caret (no selection) on the first non-blank
   *  character of the region it revealed — Vim leaves you at the top of what was unfolded. */
  private placeCaretInRevealedFold(range: RevealedRange | null): void {
    if (!range) return;
    // `RevealedRange` is in SCREEN coords (view offsets); the cursor/editor speak `buffer`, so
    // translate the restored body span to buffer rows before scanning for its first non-blank char.
    const [[sScreenRow, sScreenCol], [eScreenRow, eScreenCol]] = range;
    const start = this.editorModel.bufferPositionForScreenPosition(new Point(sScreenRow, sScreenCol));
    const end = this.editorModel.bufferPositionForScreenPosition(new Point(eScreenRow, eScreenCol));
    for (let row = start.row; row <= end.row; row++) {
      const text = this.editorModel.lineTextForBufferRow(row);
      const from = row === start.row ? start.column : 0;
      const to = row === end.row ? end.column : text.length;
      const rel = text.slice(from, to).search(/\S/);
      if (rel >= 0) return this.editorModel.setCursorBufferPosition(new Point(row, from + rel));
    }
    // Wholly-blank revealed region (shouldn't happen for code): rest at its start.
    this.editorModel.setCursorBufferPosition(start);
  }

  // --- Auto-close brackets / quotes (insert mode) ----------------------------

  private installAutoPair() {
    // A capture-phase key controller on the view: in insert mode it intercepts
    // openers/closers/backspace before GtkSourceView's own text input. The
    // window-level KeymapManager runs first (also capture) and leaves these
    // unbound keys to fall through here.
    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    this.subs.connect(keys, 'key-pressed', (keyval: number, _keycode: number, state: number) => {
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
      if (zym.config.get('editor.autoCloseBrackets') === false) return false;
      if (keyval === Gdk.KEY_BackSpace) return handleAutoPairBackspace(this.editorModel);
      const code = Gdk.keyvalToUnicode(keyval);
      if (!code) return false;
      const ch = String.fromCharCode(code);
      // JSX/HTML tag auto-close (`>` → `</name>`) before plain bracket pairing.
      if (handleTagAutoClose(this.editorModel, ch, this.isTagLanguage())) return true;
      return handleAutoPairInsert(this.editorModel, ch);
    });
    this.subs.addController(this.view, keys);

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
    // light/dark. Otherwise (followSystemScheme) we follow the Adwaita light/dark scheme.
    const themeScheme = theme.followSystemScheme ? null : createSourceScheme(theme);
    const apply = () => {
      const scheme =
        themeScheme ?? schemeManager.getScheme(styleManager.getDark() ? 'Adwaita-dark' : 'Adwaita');
      this.buffer.setStyleScheme(scheme);
      this.syntax.restyle(); // keep tree-sitter tag colors in sync with the scheme
    };
    apply();
    // styleManager is the global Adw.StyleManager singleton; without disconnecting
    // on teardown it would keep this editor (its buffer, tree-sitter tree, widgets)
    // alive forever, leaking one whole editor per file ever opened. `connect` routes
    // the disconnect through `subs`, torn down in dispose() (the reliable teardown —
    // the root is detached, not destroyed, on tab close, so a `destroy` handler never
    // fires).
    this.subs.connect(styleManager, 'notify::dark', apply);
  }

  // --- File operations -------------------------------------------------------

  /** Match the editor's indentation to the loaded file's own style; if the file
   *  has no detectable indentation, keep the config default set in `createView`.
   *  A tab-indented file keeps the configured *display* width. */
  private applyDetectedIndentation(content: string): void {
    const detected = detectIndentation(content);
    if (!detected) return;
    const width = detected.width ?? ((zym.config.get('editor.tabLength') as number) || TAB_WIDTH);
    this.editorModel.setIndentation({ useSpaces: detected.useSpaces, width });
  }

  // --- File I/O (delegated to the document) ----------------------------------

  loadFile(path: string, opts: { silent?: boolean } = {}) {
    if (this.embedded) return; // buffer-only editors have no file
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
   * `opts.focus` (default true) is whether the load grabs keyboard focus — a foreground
   * open takes it, a background one (focus: false) loads and renders without stealing it.
   */
  prepareFile(
    path: string,
    opts: { cursor?: [number, number]; scroll?: number; unsavedText?: string; onActivate?: () => void; focus?: boolean } = {},
  ): void {
    if (this.embedded) return;
    this.document.assignPath(path);
    this.pendingCursor = opts.cursor ?? null;
    this.pendingScroll = opts.scroll ?? null;
    this.pendingUnsaved = opts.unsavedText ?? null;
    this.onActivate = opts.onActivate ?? null;
    this.focusOnLoad = opts.focus ?? true;
    const onMap = () => this.activate();
    this.mapHandler = onMap;
    this.view.on('map', onMap);
  }

  /** First-show hook (one-shot): load the file's content if no sibling view has yet, else
   *  attach to the already-loaded shared document; then restore the cursor and run the
   *  owner's post-load wiring. Detaches the map handler so re-showing the tab is free. */
  private activate(): void {
    if (this.activated || this.disposed) return;
    this.activated = true;
    if (this.mapHandler) {
      this.view.off('map', this.mapHandler);
      this.mapHandler = null;
    }
    // A shared document already loaded by another view → just wire this view onto it;
    // otherwise we are the first view, so read + parse + open the LSP now (didLoad does
    // the per-view setup). ensureLoaded is idempotent either way.
    if (this.document.isLoaded) this.attachToLoadedDocument();
    else this.document.ensureLoaded();
    // Restored unsaved content first (it replaces the buffer + resets the cursor),
    // then the saved cursor, then the saved scroll. With a saved scroll we place the
    // cursor WITHOUT revealing it and pin the viewport to the saved top row directly:
    // the cursor was on-screen within that saved viewport already, so a reveal would
    // only fight the scroll restore (and `scroll_to_mark`'s deferred reveal could land
    // after it, re-centering the cursor and undoing the restore).
    if (this.pendingUnsaved !== null) {
      this.document.restoreUnsaved(this.pendingUnsaved);
      this.pendingUnsaved = null;
    }
    if (this.pendingCursor) {
      const [row, column] = this.pendingCursor;
      this.editorModel.setCursorBufferPosition({ row, column });
      if (this.pendingScroll === null) this.editorModel.scrollCursorOnscreen(); // no saved scroll → reveal it
      this.pendingCursor = null;
    }
    if (this.pendingScroll !== null) {
      this.applyRestoredScroll(this.pendingScroll);
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
  /** Re-point at `path` after the open file was moved/renamed on disk (keeps the
   *  buffer, undo, and cursor); see `Document.renameTo`. */
  renameTo(path: string) {
    this.document.renameTo(path);
  }
  /** True once the open file has been changed or deleted on disk underneath us. */
  hasDiskChange(): boolean {
    return this.document.hasDiskChange();
  }

  // --- DocumentHost (the active view's reactions to load/save) ---------------

  /** @internal Capture the caret before a full-replace reload so didLoad can restore it. */
  willReplaceContent(reload: boolean): void {
    this.pendingReloadCaret = reload
      ? ((c) => [c.row, c.column] as [number, number])(this.editorModel.getCursorBufferPosition())
      : null;
  }

  /** @internal A minimal-splice reload replaced only the changed lines, so the caret, scroll,
   *  folds and selection are already intact — just refresh the view-side derived state that keys
   *  off content (syntax/long-line mode, diagnostics, inlay hints, git gutter). No cursor move,
   *  no focus grab, no scroll: that is the whole point of the splice path. */
  didReload(content: string, path: string): void {
    this.applyDetectedIndentation(content);
    this.applySyntaxOrLongLineMode(content, path);
    this.diagnostics.render();
    this.inlayHints.scheduleRefresh();
    this.gitGutter?.refresh();
  }

  /** @internal View-side setup after the document loaded content: cursor, indentation,
   *  syntax language, diagnostics, git gutter, focus. (Syntax follows the buffer too.) */
  didLoad(content: string, path: string, reload: boolean): void {
    if (reload && this.pendingReloadCaret) this.restoreCursor(this.pendingReloadCaret);
    else this.editorModel.setCursorBufferPosition({ row: 0, column: 0 });
    this.pendingReloadCaret = null;
    this.applyDetectedIndentation(content);
    // Focus on the first load, unless this is a background open (focusOnLoad false) —
    // then the file still renders, it just doesn't pull focus. A silent disk-change
    // reload never grabs.
    if (!reload && this.focusOnLoad) this.view.grabFocus();
    this.applySyntaxOrLongLineMode(content, path);
    this.diagnostics.render();
    this.inlayHints.scheduleRefresh();
    this.gitGutter?.refresh();
  }

  /** Highlight `path` normally, unless its content has a pathologically long line — then
   *  enter long-line mode (no soft-wrap, no tree-sitter highlighting) so it opens instead
   *  of hanging. Used by both the initial load and a split/peek of an already-open file. */
  private applySyntaxOrLongLineMode(content: string, path: string): void {
    const longLines = !this.embedded && hasLongLine(content, LONG_LINE_THRESHOLD);
    if (longLines === this.longLineMode && longLines) return; // already degraded (e.g. reload)
    this.longLineMode = longLines;
    this.applyWrap(); // force wrap off (or restore the config value when leaving the mode)
    if (longLines) {
      // Drop all highlighting (tree-sitter and the .lang fallback); keep the line-number gutter.
      this.buffer.setHighlightSyntax(false);
      this.buffer.setLanguage(null);
      this.syntax.disableHighlighting();
      this.showBanner('Long lines detected — syntax highlighting and soft-wrap disabled for performance.', 'warning');
    } else {
      this.applyViewSyntaxForPath(path);
    }
  }

  /** Set up this view for an already-loaded shared `Document` — a second view (split /
   *  peek) onto a file open elsewhere. Its buffer is seeded by `createView`; this only
   *  does the per-view work the load reactions would: pick the grammar, place the
   *  cursor, render diagnostics, focus. No text load (the model already has it). */
  attachToLoadedDocument(): void {
    const path = this.document.currentFile;
    if (!path) return;
    this.applySyntaxOrLongLineMode(this.getText(), path);
    this.editorModel.setCursorBufferPosition({ row: 0, column: 0 });
    this.applyDetectedIndentation(this.getText());
    this.diagnostics?.render();
    this.inlayHints?.scheduleRefresh();
    this.gitGutter?.refresh();
    if (this.focusOnLoad) this.view.grabFocus(); // background opens render without stealing focus
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

  /** @internal Show a persistent info banner above the content. */
  showBanner(message: string, kind: 'error' | 'warning', action?: { label: string; onClick: () => void }): void {
    this.bannerBox.removeCssClass('zym-banner-warning');
    this.bannerBox.removeCssClass('zym-banner-error');
    this.bannerBox.addCssClass(`zym-banner-${kind}`);
    this.bannerLabel.setLabel(message);
    this.bannerAction = action?.onClick ?? null;
    this.bannerButton.setLabel(action?.label ?? '');
    this.bannerButton.setVisible(action != null);
    this.banner.setRevealChild(true);
  }

  /** @internal Hide the info banner. */
  hideBanner(): void {
    this.banner.setRevealChild(false);
  }

  /** @internal The cursor for an LSP request (anchors completion/hover at this view).
   *  Translated screen→document — folds shift the lines and columns under the caret,
   *  so `documentPointFromScreen` must be fed the *screen* cursor, not the buffer one. */
  lspCursor(): Point {
    return this.screen.documentPointFromScreen(this.editorModel.getCursorScreenPosition());
  }

  // --- Identity --------------------------------------------------------------

  get currentFile(): string | null {
    return this._currentFile;
  }

  /** The currently selected text (empty string when there is no selection). */
  getSelectedText(): string {
    return this.editorModel.getSelectedText();
  }

  /** The `\w+` identifier under (or touching) the cursor, '' when none — for seeding
   *  a search or rename prompt. Codepoint-aware: columns are codepoints, so the line
   *  is indexed as codepoints. */
  getWordUnderCursor(): string {
    const cursor = this.editorModel.getCursorBufferPosition();
    const cp = [...this.editorModel.lineTextForBufferRow(cursor.row)];
    let start = cursor.column;
    let end = cursor.column;
    while (start > 0 && /\w/.test(cp[start - 1])) start--;
    while (end < cp.length && /\w/.test(cp[end])) end++;
    return cp.slice(start, end).join('');
  }

  /** The primary cursor's buffer position — the read workspace-level features
   *  (e.g. the global jump list) use without reaching into the model. */
  getCursorBufferPosition(): Point {
    return this.editorModel.getCursorBufferPosition();
  }

  /** Fires with the departed buffer position each time a vim jump motion runs —
   *  the semantic-jump hint the workspace-wide jump list (GlobalJumpList) folds in
   *  alongside its own cursor-distance detection. */
  onDidRecordJump(fn: (point: Point) => void): Disposable {
    return this.vimState.onDidRecordJump(fn);
  }

  /** The tab/window title for this editor (file basename, or "Untitled"). */
  get title(): string {
    return this.document.title;
  }

  focus() {
    this.view.grabFocus();
  }

  /** Focus the editor and switch to insert mode — for embedded prompt inputs
   *  (e.g. a chat box) where the user expects to type immediately, not land in
   *  vim normal mode. */
  focusInsert() {
    this.view.grabFocus();
    this.vimState.activate('insert');
  }

  /** Select the whole buffer (e.g. a restored draft, ready to keep or overtype). */
  selectAll() {
    const [start, end] = this.buffer.getBounds();
    this.buffer.selectRange(start, end);
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
    if (this.embedded || !this._currentFile) return null;
    if (this.pendingUnsaved !== null) return this.pendingUnsaved;
    return this.isModified() ? this.getText() : null;
  }

  /** Restore a saved scroll offset — put `row` at the top of the viewport. Deferred
   *  to `activate` for a lazily-opened tab whose view isn't realized yet. */
  restoreScroll(row: number): void {
    if (!this.embedded && !this.document.isLoaded) {
      this.pendingScroll = row;
      return;
    }
    this.applyRestoredScroll(row);
  }

  /** Pin `row` to the top of the viewport with a direct, instant scroll (no animation
   *  toward the cursor). When a restored tab is first shown the view often has no
   *  geometry yet (`getHeight()` 0), so `setTopBufferRow` would no-op — retry on tick
   *  callbacks until it's laid out, then set it once and stop. `activate` runs from the
   *  view's `map`, so it is already mapped here and tick callbacks fire; if ever called
   *  before map, arm on map instead (a tick added while unmapped wouldn't run). */
  private applyRestoredScroll(row: number): void {
    let frames = 0;
    const apply = () => {
      if (this.view.getRealized() && this.view.getHeight() > 0) {
        this.editorModel.setTopBufferRow(row);
        return false; // G_SOURCE_REMOVE
      }
      return ++frames < 120; // keep trying ~2s then give up
    };
    if (!apply()) return; // already laid out → set once, done
    if (this.view.getMapped()) this.view.addTickCallback(apply);
    else this.subs.connect(this.view, 'map', () => this.view.addTickCallback(apply));
  }

  /** Place the caret at the start of `row` and scroll its line `yalign` down the viewport
   *  (default the configured `editor.centerFraction`, a quarter from the top) via
   *  `scroll_to_mark` (`scrollCursorToFraction`) — which GTK
   *  defers + validates incrementally until the mark is reached, so it lands accurately on a
   *  freshly-embedded multibuffer, where the estimate-based `setTopBufferRow` / `scroll_to_iter`
   *  undershoot. Robust to an unmapped / not-yet-laid-out view (retries on tick / arms on `map`),
   *  then **re-asserts for a few frames** so a post-layout reflow (the diff's header-band
   *  decorations sizing, a first live re-diff) can't leave the target stranded. Public so an
   *  embedder (e.g. the GitPanel's diff) can jump to a row right after attaching the view. */
  revealRow(row: number, yalign = this.editorModel.getCenterFraction()): void {
    this.editorModel.setCursorBufferPosition({ row, column: 0 });
    this.revealCursorCentered(yalign);
  }

  private revealCursorCentered(yalign = this.editorModel.getCenterFraction()): void {
    let frames = 0;
    let settled = 0;
    const apply = () => {
      if (!this.view.getRealized() || this.view.getHeight() <= 0) return ++frames < 120; // not laid out yet
      this.editorModel.scrollCursorToFraction(yalign);
      return ++settled < 6; // re-assert ~6 frames against a late reflow, then stop
    };
    if (!apply()) return; // already laid out + settled → done
    if (this.view.getMapped()) this.view.addTickCallback(apply);
    else this.subs.connect(this.view, 'map', () => this.view.addTickCallback(apply));
  }

  /** Restore unsaved content (session restore): replace the buffer and keep it
   *  modified. Deferred for a lazily-opened tab. */
  restoreUnsaved(text: string): void {
    if (!this.embedded && !this.document.isLoaded) {
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
    if (!this.embedded && !this.document.isLoaded) {
      this.pendingCursor = cursor;
      return;
    }
    this.editorModel.setCursorBufferPosition({ row: cursor[0], column: cursor[1] });
    // Reveal the restored/jumped-to cursor centered. The horizontal scroll is left put unless the
    // cursor is off-screen (then revealed at the nearer edge) — a far-column jump still lands in
    // view, without sliding the screen sideways otherwise. See docs/text-editor/index.md (Centering).
    this.revealCursorCentered();
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

  /** Subscribe to title changes (the document's file / disk state changing). Returns a disposer. */
  onTitleChange(callback: () => void) {
    return this.document.onTitleChange(callback);
  }

  /** Subscribe to modified-state changes (the document's modified flag toggling). Returns a
   *  disposer. */
  onModifiedChange(callback: () => void) {
    return this.document.onModifiedChange(callback);
  }
}

/**
 * Build a transient "input"-flavour editor — a short text field (commit messages, the
 * agent prompt, pickers) as opposed to a full "textarea"/file editor. Sets up the input
 * defaults so callers don't repeat them:
 *   - buffer-only mode (no file, LSP, line numbers, or minimap);
 *   - folding off, so no gutter is installed at all (a short input has no code structure
 *     to fold, and the lone fold-chevron column would just be empty margin) — overridable;
 *   - soft-wrap on (wraps instead of h-scrolling), overridable;
 *   - symmetric inner text padding (`padding`, default `INPUT_PADDING`);
 *   - a `zym-input` CSS class so styles and keymaps can target inputs as a group
 *     (and an optional `cssClass` for one specific input).
 * The buffer knobs (placeholder, initialText, onSubmit, readOnly, …) pass straight
 * through. Prefer this over `new TextEditor({ buffer: … })` for embedded inputs.
 */
export function createInput(options: InputEditorOptions = {}): TextEditor {
  const { softWrap = true, cssClass, onClose, padding = INPUT_PADDING, grow, maxLines, maxHeight, folding = false, ...buffer } = options;
  return new TextEditor({
    buffer: { ...buffer, folding },
    softWrap,
    cssClass: cssClass ? `zym-input ${cssClass}` : 'zym-input',
    padding,
    grow,
    maxLines,
    maxHeight,
    onClose,
  });
}
