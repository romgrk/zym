/*
 * DiffView — a CONTINUOUS multi-file diff in one scrollable editor
 * (docs/text-editor/multibuffer.md, Phase 3b / G5). Each changed file is a filename header
 * then its diff windowed like a real diff (changed hunks + context, long unchanged runs elided
 * to a `⋯` gap; see `buildDiffMultiBuffer`): context + added rows over the NEW side, removed
 * rows over the OLD/HEAD blob, all stitched into one `CoordinatesMap`. Per-side syntax
 * highlighting (`ExcerptSyntaxProjection`), added/removed backgrounds (`applyDiffDecorations`),
 * old|new line gutters, and Enter/double-click → jump to the file.
 *
 * Two modes:
 *   - READ-ONLY (default): each side is a bare disk-snapshot buffer.
 *   - EDITABLE (G5): the NEW side is a LIVE `Document` from the registry, so editing a
 *     context/added row writes through to the file's model (open tab + save); removed (phantom,
 *     old-side) rows reject edits. After an edit settles, the diff is RE-COMPUTED and the view
 *     re-flowed via `Screen.retarget` — a minimal-churn splice (no whole-buffer
 *     re-materialize), so phantom rows appear/disappear without a flash or a caret jump.
 */
import Gdk from 'gi:Gdk-4.0';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
type SourceBuffer = InstanceType<typeof GtkSource.Buffer>;
import { theme } from '../theme/theme.ts';
import { TextEditor } from './TextEditor/TextEditor.ts';
import { Document } from './TextEditor/Document.ts';
import { DocumentRegistry } from './TextEditor/DocumentRegistry.ts';
import { DocumentSyntax } from '../syntax/DocumentSyntax.ts';
import { Screen } from './TextEditor/Screen.ts';
import { CoordinatesMap } from './TextEditor/CoordinatesMap.ts';
import { ExcerptSyntaxProjection } from './multibuffer/ExcerptSyntaxProjection.ts';
import { MultiBufferDocument } from './multibuffer/MultiBufferDocument.ts';
import { applyDiffDecorations } from './TextEditor/applyDiffDecorations.ts';
import { CombinedDiffLineNumberGutter } from './TextEditor/DiffLineNumberGutter.ts';
import { buildDiffMultiBuffer, type DiffFile, type DiffMultiBuffer } from './multibuffer/diffMultiBuffer.ts';
import { buildHeaderWidget, buildGapWidget } from './HeaderBands.ts';
import { createEmptyMessage } from './createEmptyMessage.ts';
import { DiffCommentBox, buildCommentCard } from './DiffCommentBox.ts';
import { formatAgentComment } from './agentComment.ts';
import type { BlockDecorationSpec, BlockDecorationSet, BlockDecorationAnchor } from './TextEditor/BlockDecorationSet.ts';
import type { StickyHeaderSpec } from './TextEditor/StickyHeaders.ts';
import { buildRowMap, computeHunks, formatHunkPatch, hunkContainsBufferRow, type Hunk } from '../util/hunkPatch.ts';
import { applyPatch, git, repoRoot, type GitDone, type GitRepo } from '../git.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import { compileGlobFilter } from '../util/glob.ts';
import { zym } from '../zym.ts';
import * as Path from 'node:path';

/** A review comment composed on a row/selection of the diff, to hand to the agent. */
export interface DiffComment {
  /** Absolute path of the commented file (the caller relativizes for display). */
  path: string;
  /** 1-based line to open for navigation (new side preferred, else old). */
  navLine: number;
  /** Precise target: per-side line ranges, and columns when the selection is sub-line.
   *  e.g. "new L42-43, old L40" or "new L42, cols 5-12". */
  locator: string;
  /** Unified-diff hunk of EXACTLY the selected rows (`@@` header + `-`/`+`/` ` lines), so the
   *  agent sees which lines are old/new/context without guessing. */
  patch: string;
  /** The comment text the user typed (trimmed, non-empty). */
  comment: string;
}

export interface DiffViewOptions {
  /** Changed files: base (old/HEAD) + current (new/working) content. */
  files: DiffFile[];
  cwd?: string;
  onActivate?: (location: { path: string; row: number }) => void;
  /** Deliver a formatted review message (one comment, or an accumulated batch) to the agent. The
   *  view does ALL formatting (`formatDiffComment`/`formatDiffReview`); the host just sends the
   *  string (typically `zym.workspace.sendReviewToAgent`, which targets the current agent or opens
   *  the picker). Wired on every diff — live or historical. Absent → commenting is disabled. */
  onSend?: (message: string) => void;
  /** Context prefixed to every review message — names the revision a HISTORICAL diff is of (e.g.
   *  ``Review of commit `a0c0365` (subject)``), so the agent knows the lines refer to that commit/
   *  branch, not the working tree. Omit for working-tree diffs (live / current-file). */
  reviewContext?: string;
  /** Edit-in-place: back the NEW side with live `Document`s (write-through + save + live
   *  re-diff) instead of disk snapshots. Requires `documents`. */
  editable?: boolean;
  /**
   * LIVE diff: this view tracks the working tree + index, so hunk staging is enabled — the gutter
   * shows the staged/unstaged marker and `git:hunk-stage`/`git:hunk-unstage`/`git:hunk-revert` apply. Only the
   * staging surface (`git:diff-current-changes`) is live; read-only diffs over historical blobs
   * (commit / branch / file) are NOT live and their gutter omits the staging section. Requires
   * `git` + `cwd` (a repo) to do anything; pairs with `editable` on the staging surface.
   */
  live?: boolean;
  /** The app's document registry — required when `editable`. */
  documents?: DocumentRegistry;
  /** The repo model — for a `live` diff: refreshes Source Control after a stage/unstage, and
   *  re-reads the index when it changes externally. */
  git?: GitRepo;
  /** Live diff only: recompute the current changed-file set (host-built), for `reconcileFiles`. */
  refreshFiles?: () => Promise<DiffFile[] | null>;
}

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);
const newKey = (path: string): string => `new:${path}`;
const oldKey = (path: string): string => `old:${path}`;
const REDIFF_DEBOUNCE_MS = 120;

/** Right-align line numbers into an equal-width gutter column; a null (the side a row doesn't exist
 *  on) is all spaces of that width, so the column stays aligned and the `[space][number][space]`
 *  cell background spans a consistent width. `minWidth` pins the column to the WHOLE diff's widest
 *  number (see `gutterWidths`) so collapsing/expanding files never re-sizes the gutter. */
function lineLabels(nums: readonly (number | null)[], minWidth = 1): string[] {
  let width = minWidth;
  for (const n of nums) if (n !== null) width = Math.max(width, String(n).length);
  return nums.map((n) => (n === null ? ' '.repeat(width) : String(n).padStart(width)));
}

/** Per-row gutter cell tints: the old column reddens removed rows, the new column greens added
 *  rows (the stronger `*Word` tint, so the gutter reads a bit deeper than the line background).
 *  Context rows (both numbers present) stay untinted. */
function gutterBg(dmb: DiffMultiBuffer, side: 'old' | 'new'): (string | null)[] {
  const want = side === 'old' ? 'removed' : 'added';
  const color = side === 'old' ? theme.ui.diff.removedWord : theme.ui.diff.addedWord;
  return dmb.rowKinds.map((kind) => (kind === want ? color : null));
}

/** The view rows that carry a header-widget band ABOVE them (each excerpt's first row) — the gutter
 *  bottom-aligns these so the line number lands on the text, not up in the filename widget's band. */
function headerRows(dmb: DiffMultiBuffer): Set<number> {
  return new Set(dmb.headerAnchors.map((h) => h.viewRow));
}

interface SourceEntry {
  buffer: SourceBuffer;
  syntax: DocumentSyntax;
  /** Editable mode, new side only: the live Document backing it (released on dispose). */
  document?: Document;
  /** Select the grammar + parse this side (deferred); run by the projection when the hunk nears
   *  the viewport (lazy syntax). */
  parse: () => void;
}

export class DiffView {
  // Live views keyed by their root widget, so the host can route the diff
  // fold/stage/review commands to the focused diff (`forRoot`) without tracking
  // views itself — works regardless of how the tab was opened. A WeakMap so a
  // closed view's entry is collected even if `dispose` somehow doesn't run.
  private static readonly byRoot = new WeakMap<InstanceType<typeof Gtk.Widget>, DiffView>();

  /** The diff view hosting `widget` as its root, or null. */
  static forRoot(widget: InstanceType<typeof Gtk.Widget>): DiffView | null {
    return DiffView.byRoot.get(widget) ?? null;
  }

  readonly root: InstanceType<typeof Gtk.Widget>;
  readonly editor: TextEditor;
  // The public `root`: a Stack swapping the diff editor ('diff') for an empty state ('empty', shown
  // when no file has any change). reDiff toggles it.
  private readonly stack: InstanceType<typeof Gtk.Stack>;
  private readonly files: DiffFile[];
  private readonly cwd?: string;
  private readonly sources = new Map<string, SourceEntry>();
  private readonly screen: Screen;
  private lineNumbers: CombinedDiffLineNumberGutter | null = null;
  // `⋯` gap widgets + review-comment cards as BlockDecoration bands (file headers ride the separate
  // sticky-header layer). Reconciled (not torn down) on each re-diff: a re-flow moves them and
  // changes their text (gap counts), but reusing the handles in place avoids the band collapse/
  // re-expand that flickers + jumps the text. Each entry keeps a CONTENT key so the widget rebuilds
  // only when its content changed. A computed surface: the structure (which gaps exist) is recomputed
  // per re-diff, so the bands carry direct VIEW-row anchors and are re-`set()` on every reDiff.
  private bands!: BlockDecorationSet;
  // Expand-context state: NEW-side rows the user forced visible, and a reveal-everything flag.
  // The current diff's anchors, kept for the keyboard `expandContextAtCursor`.
  private revealAll = false;
  private readonly revealedNewRows = new Set<number>();
  // Per-file collapse: paths the user has folded to a one-line header (stable across re-diff / live
  // re-diff / HEAD-move rebase — keyed by path, not view row). A collapsed file contributes only its
  // header row (see buildDiff → `collapsed`).
  private readonly collapsedFiles = new Set<string>();
  private gapAnchors: DiffMultiBuffer['gapAnchors'] = [];
  private headerAnchors: DiffMultiBuffer['headerAnchors'] = [];
  private readonly onActivate?: (location: { path: string; row: number }) => void;
  private readonly onSend?: (message: string) => void;
  private readonly reviewContext?: string;
  private commentBox: DiffCommentBox | null = null;
  // Review mode: while on, a submitted comment is ACCUMULATED (shown as an inline read-only card)
  // instead of sent; `submitReview` flushes the batch. Cards are folded into `installOverlays`'
  // band set with SOURCE anchors, so they survive re-diffs/edits. Default off (immediate send).
  private reviewMode = false;
  private readonly pending: { comment: DiffComment; anchor: BlockDecorationAnchor; id: string }[] = [];
  private pendingSeq = 0;
  // The pending comment currently being edited, if any: its inline card is suppressed while its
  // (prefilled) comment box is open, so the box replaces the card rather than stacking over it.
  private editingPendingId: string | null = null;
  private readonly reviewHandlers: Array<() => void> = [];
  private readonly editable: boolean;
  /** Whether this is a live diff (staging surface): hunk staging + the gutter marker are enabled.
   *  Public so the command layer can gate `git:hunk-stage`/`git:hunk-unstage` on it. */
  readonly live: boolean;
  private readonly registry?: DocumentRegistry;
  // Hunk staging: the repo root, the per-file staged (index) blob, the last-built diff (for the
  // caret→file/row lookup), and the repo model (refresh + external-change subscription).
  private readonly repo: string | null;
  private readonly gitRepo?: GitRepo;
  private readonly refreshFiles?: () => Promise<DiffFile[] | null>;
  // Drops a superseded reconcileFiles fetch when git changes burst.
  private reconcileGen = 0;
  private readonly indexText = new Map<string, string>();
  private dmb: DiffMultiBuffer;
  private gitUnsub?: () => void;
  // The HEAD commit the base (old) side was diffed against. A repo change that MOVES it (commit,
  // amend, reset, checkout) re-bases the diff — see onGitChange.
  private lastHead: string | null = null;
  // Bumped on each HEAD-move re-base so a superseded async blob fetch drops its stale result.
  private rebaseGen = 0;
  private reDiffTimer: NodeJS.Timeout | null = null;
  private suppressReDiff = false;
  private lastLineCount = 0; // view buffer line count, to detect line-count-changing edits
  private readonly modifiedHandlers: Array<() => void> = [];
  private readonly modifiedUnsubs: Array<() => void> = [];
  // Notified when the caret crosses into a different file's excerpt (see onCursorFileChanged);
  // `lastCursorFile` debounces it to file *changes*, not every cursor move.
  private readonly cursorFileHandlers: Array<(path: string) => void> = [];
  private lastCursorFile: string | null = null;
  private readonly disposables = new CompositeDisposable();
  private disposed = false;

  private get projection(): CoordinatesMap {
    return this.screen.view;
  }

  constructor(options: DiffViewOptions) {
    this.onActivate = options.onActivate;
    this.onSend = options.onSend;
    this.reviewContext = options.reviewContext;
    this.files = options.files;
    this.cwd = options.cwd;
    this.editable = !!options.editable;
    this.live = !!options.live;
    this.registry = options.documents;
    this.gitRepo = options.git;
    this.refreshFiles = options.refreshFiles;
    this.repo = options.cwd ? repoRoot(options.cwd) : null;
    if (this.editable && !this.registry) {
      throw new Error('DiffView: editable mode requires a DocumentRegistry');
    }

    // Resolve each side's source ONCE (live Document for the new side when editable, else a
    // disk snapshot; the old/base side is always a read-only blob), then diff + project.
    for (const file of this.files) this.ensureSources(file);
    // At open, fold large files (change ≥ editor.diffCollapseLines) so a big diff opens as a scannable
    // overview. The build folds them inline in a single pass; `seedAutoCollapse` then mirrors them into
    // collapsedFiles so later re-diffs keep them folded, while `z o` / `z r` still expand them.
    const autoCollapse = DiffView.autoCollapseThreshold();
    const dmb = this.buildDiff(autoCollapse);
    this.seedAutoCollapse(dmb, autoCollapse);
    this.dmb = dmb;

    const sourceBuffers = new Map([...this.sources].map(([key, e]) => [key, e.buffer] as const));
    // Lazy syntax: each side parses (deferred) when its hunk nears the viewport — TextEditor's
    // lazy-syntax driver runs the thunk, not all sides up front.
    const syntaxMap = new Map([...this.sources].map(([key, e]) => [key, { syntax: e.syntax, ensureParsed: e.parse }] as const));
    this.screen = new Screen(dmb.items, sourceBuffers);

    // One editor, natively backed by the multi-source projection (no buffer-mode shim): the
    // `MultiBufferDocument` supplies the view buffer, the per-excerpt syntax painter, and undo
    // (coordinating the touched sources). The editor disposes it on teardown.
    const painter = new ExcerptSyntaxProjection(() => this.projection, syntaxMap);
    this.editor = new TextEditor({ source: new MultiBufferDocument(this.screen, painter) });
    if (!this.editable) this.editor.model.setReadOnly(true);
    this.bands = this.editor.blockDecorations();
    // Wrap the editor in a Stack so a diff with no changes shows a friendly empty state instead of a
    // blank editor (a live diff re-diffs to empty once every change is staged / reverted). The Stack
    // is the public `root`, so the host tab + `forRoot` command routing see one stable widget.
    this.stack = new Gtk.Stack();
    this.stack.addNamed(this.editor.root, 'diff');
    this.stack.addNamed(
      createEmptyMessage({
        icon: 'check-plain-symbolic',
        title: 'No changes',
        description: "You're all caught up — there are no changes to show.",
      }),
      'empty',
    );
    this.stack.setVisibleChildName(dmb.headerAnchors.length === 0 ? 'empty' : 'diff');
    this.root = this.stack;
    DiffView.byRoot.set(this.root, this); // discoverable via `forRoot` for command routing
    // Scope the expand-context keymap to this surface: `.TextEditor.continuous-diff` is more
    // specific than vim's `.TextEditor`, so `z o`/`z R`/`z m` bind here while `z z` (scroll) etc.
    // still fall through to vim.
    this.editor.sourceView.addCssClass('continuous-diff');

    if (this.editable) {
      this.editor.model.setEditableCheck((s, e) => this.projection.isScreenRangeEditable(s, e));
      // A row-count reverse-sync (undo / external) can't be re-flowed by window arithmetic on a
      // diff (new-side + phantom segments interleave), so re-derive the diff from scratch instead.
      this.screen.setResyncHandler(() => this.reDiff());
    }

    this.applyDecorations(dmb);

    // ONE gutter renderer drawing both old + new columns (one PangoLayout/line, for perf). The
    // number columns are hidden by default (`editor.diffLineNumbers`); a live diff keeps its
    // staged/unstaged marker regardless.
    const gw = this.gutterWidths();
    this.lineNumbers = new CombinedDiffLineNumberGutter(
      this.editor.sourceView,
      lineLabels(dmb.oldNums, gw.old),
      lineLabels(dmb.newNums, gw.new),
      gutterBg(dmb, 'old'),
      gutterBg(dmb, 'new'),
      headerRows(dmb),
      this.live ? dmb.stagedState : null, // staging markers only on a live diff
      this.live,
      zym.config.get('editor.diffLineNumbers') === true,
    );
    // Live-toggle the number columns without reopening the diff (observe fires immediately, a
    // no-op re-set of the value already passed above). Also refresh the gap bands so the
    // `@@ … @@` ⇄ `⋯` swap tracks the toggle — skipping the immediate fire, since installOverlays
    // runs right below at construction.
    let firstLineNumberObserve = true;
    this.disposables.add(
      zym.config.observe('editor.diffLineNumbers', (v) => {
        this.lineNumbers?.setShowLineNumbers(v === true);
        if (firstLineNumberObserve) { firstLineNumberObserve = false; return; }
        this.installOverlays(this.dmb);
      }),
    );

    this.installOverlays(dmb);
    this.installNavigation();
    // Track which file the caret sits in, to notify onCursorFileChanged subscribers (the GitPanel
    // keeps its change-list selection in sync). Disposed with the view.
    this.disposables.add(this.editor.onDidChangeCursorPosition(() => this.emitCursorFile()));
    if (this.editable) {
      // Re-diff after an edit. A LINE-COUNT change (Enter / `o` / dd) reflows the diff and moves
      // the caret relative to the gaps, so re-diff IMMEDIATELY — debouncing it leaves the caret
      // briefly stranded next to a gap widget before the deferred reflow corrects it. A within-line
      // edit doesn't move gaps, so it stays debounced (the common per-keystroke case).
      this.lastLineCount = this.screen.buffer.getLineCount();
      this.editor.model.onDidChangeText(() => {
        if (this.suppressReDiff) return; // our own retarget edits
        const n = this.screen.buffer.getLineCount();
        const lineCountChanged = n !== this.lastLineCount;
        this.lastLineCount = n;
        // A line-count change reflows the diff; re-diff on a MICROTASK (after the full edit
        // command finishes placing the caret, but before the next paint) so the caret follows
        // with no visible flash — yet not synchronously, which would race vim's own cursor move.
        if (lineCountChanged) this.scheduleMicroReDiff();
        else this.scheduleReDiff();
      });
      for (const entry of this.sources.values()) this.watchNewSideModified(entry);
    }
    // Materializing the buffer (setText) leaves the caret at the END; start at the top.
    this.editor.model.setCursorBufferPosition({ row: 0, column: 0 });

    // Staging is only meaningful on a live diff inside a repo. Read each file's index blob (async)
    // so the gutter marker can show staged vs unstaged, and refresh it when the index moves out from
    // under us (someone stages elsewhere).
    if (this.live && this.repo) {
      this.lastHead = this.gitRepo?.getHead() ?? null;
      this.fetchIndexText(this.files.map((f) => f.path), () => this.refreshMarkers());
      this.gitUnsub = this.gitRepo?.onChange(() => this.onGitChange());
    }
  }

  /** Stable gutter column widths (digit counts) for the WHOLE diff — sized to the widest old / new
   *  file line number across EVERY file, from each side's full source buffer (line count is O(1) and,
   *  being the whole file, an upper bound on any visible number). Keeping the columns pinned to this
   *  means collapsing/expanding files — or revealing context — never re-sizes the gutter and shifts
   *  the layout. (Recomputed per rebuild so an edit that grows the new side still tracks.) */
  private gutterWidths(): { old: number; new: number } {
    let maxOld = 1;
    let maxNew = 1;
    for (const f of this.files) {
      maxOld = Math.max(maxOld, this.sources.get(oldKey(f.path))?.buffer.getLineCount() ?? 1);
      maxNew = Math.max(maxNew, this.sources.get(newKey(f.path))?.buffer.getLineCount() ?? 1);
    }
    return { old: String(maxOld).length, new: String(maxNew).length };
  }

  /** Build the windowed diff from each file's base blob + its CURRENT new-side text (the live
   *  Document's text when editable, else the snapshot passed in). */
  private buildDiff(autoCollapseAtLines?: number): DiffMultiBuffer {
    const files = this.files.map((f) => ({ ...f, newText: this.currentNewText(f), indexText: this.indexText.get(f.path) }));
    // Filename headers are widgets (not navigable buffer text), anchored above each file's rows.
    // `reveal` forces user-expanded (otherwise-elided) new-side rows visible (expand-context).
    // `autoCollapseAtLines` is passed only on the FIRST build (open); re-diffs omit it so they honor
    // the user's collapse set rather than re-folding a large file the user expanded.
    const reveal = this.revealAll ? () => true : (r: number) => this.revealedNewRows.has(r);
    return buildDiffMultiBuffer(files, this.cwd, { headers: 'widget', reveal, collapsed: (p) => this.collapsedFiles.has(p), autoCollapseAtLines });
  }

  // --- expand context (reveal elided unchanged lines) ------------------------
  private static readonly CHUNK = 10; // lines revealed per click / `zo`

  /** Reveal a chunk of a gap's elided rows. `fromTop` extends the window above the gap (the
   *  common case); else extends the window below (a leading gap). Re-diffs to re-flow. */
  private revealChunk(rows: number[], fromTop: boolean): void {
    if (!rows.length) return;
    const chunk = fromTop ? rows.slice(0, DiffView.CHUNK) : rows.slice(-DiffView.CHUNK);
    for (const r of chunk) this.revealedNewRows.add(r);
    this.reDiff();
  }

  /** Expand the gap nearest the caret, revealing TOWARD the caret: a gap below the caret reveals
   *  from its top (extends the caret's window down), a gap above reveals from its bottom (extends
   *  it up). Leading gaps (above a file's first row) join the same candidate set. So `zo` works
   *  whether the caret sits above or below the fold. */
  expandContextAtCursor(): void {
    const row = this.cursorRow();
    // Every gap (including the leading file-head gap) is a gapAnchor with a reference `viewRow`. The
    // keyboard reveals TOWARD the caret (above the gap → from its top; below → from its bottom).
    let best: { rows: number[]; fromTop: boolean; dist: number } | null = null;
    for (const g of this.gapAnchors) {
      const above = row <= g.viewRow; // is the caret above this gap?
      const dist = above ? g.viewRow - row : row - (g.viewRow + 1);
      if (!best || dist < best.dist) best = { rows: g.revealRows, fromTop: above, dist };
    }
    if (best) this.revealChunk(best.rows, best.fromTop);
  }

  /** Reveal every elided line (show the full files). */
  expandAll(): void {
    this.revealAll = true;
    this.reDiff();
  }

  /** Re-collapse all expanded context back to the windowed diff. */
  collapseContext(): void {
    this.revealAll = false;
    this.revealedNewRows.clear();
    this.reDiff();
  }

  // --- per-file collapse -----------------------------------------------------

  /** Collapse / expand `path` — collapsed, it folds to just its (navigable) header row; the caret
   *  recovers onto that header (see reDiff). Drives the header double-click and the cursor toggle. */
  toggleFileCollapse(path: string): void {
    if (this.collapsedFiles.has(path)) this.collapsedFiles.delete(path);
    else this.collapsedFiles.add(path);
    this.reDiff();
  }

  /** Collapse / expand the file under the cursor (`z a`). */
  toggleFileCollapseAtCursor(): void {
    const hit = this.fileAtViewRow(this.cursorRow());
    if (hit) this.toggleFileCollapse(hit.path);
  }

  /** Collapse the file under the cursor to its header (`z c`, vim's close-fold). No-op if already
   *  collapsed (or the caret isn't in a file). */
  collapseFileAtCursor(): void {
    const hit = this.fileAtViewRow(this.cursorRow());
    if (!hit || this.collapsedFiles.has(hit.path)) return;
    this.collapsedFiles.add(hit.path);
    this.reDiff();
  }

  /** Expand the file under the cursor back to its diff (`z o`, vim's open-fold). No-op if not
   *  collapsed. */
  expandFileAtCursor(): void {
    const hit = this.fileAtViewRow(this.cursorRow());
    if (!hit || !this.collapsedFiles.has(hit.path)) return;
    this.collapsedFiles.delete(hit.path);
    this.reDiff();
  }

  /** Collapse every file to its header — a one-line-per-file overview. */
  collapseAllFiles(): void {
    for (const f of this.files) this.collapsedFiles.add(f.path);
    this.reDiff();
  }

  /** Expand every collapsed file back to its windowed diff. */
  expandAllFiles(): void {
    if (this.collapsedFiles.size === 0) return;
    this.collapsedFiles.clear();
    this.reDiff();
  }

  /** The `editor.diffCollapseLines` auto-fold threshold (change ≥ N lines folds a file on open), or
   *  undefined when disabled (0 / unset). Read once at open and passed to the first `buildDiff`. */
  private static autoCollapseThreshold(): number | undefined {
    const n = zym.config.get('editor.diffCollapseLines');
    return typeof n === 'number' && n > 0 ? n : undefined;
  }

  /** Mirror the files the build auto-folded (change ≥ `threshold`) into `collapsedFiles`, so later
   *  re-diffs — which don't re-apply the threshold — keep them folded, while `z o` / `z r` still
   *  expand them. No-op when auto-folding is disabled (`threshold` undefined). */
  private seedAutoCollapse(dmb: DiffMultiBuffer, threshold: number | undefined): void {
    if (threshold === undefined) return;
    for (const h of dmb.headerAnchors) {
      if (h.added + h.removed >= threshold) this.collapsedFiles.add(h.path);
    }
  }

  /** The files whose (cwd-relative) path matches `pattern` — a comma-separated glob filter, each
   *  term `!`-prefixed to negate (see `compileGlobFilter`). Matched against the display label (the
   *  relative path the user sees), in view order. Non-mutating; drives the `z x` picker's preview. */
  filesMatching(pattern: string): { path: string; label: string }[] {
    const filter = compileGlobFilter(pattern);
    if (filter.isEmpty) return [];
    return this.dmb.headerAnchors.filter((h) => filter.test(h.label)).map((h) => ({ path: h.path, label: h.label }));
  }

  /** Collapse every file matching `pattern` (`z x`) — see `filesMatching` for the glob syntax.
   *  Already-collapsed files are left as-is; re-diffs once if anything changed. Returns the count. */
  collapseFilesMatching(pattern: string): number {
    let collapsed = 0;
    for (const { path } of this.filesMatching(pattern)) {
      if (!this.collapsedFiles.has(path)) {
        this.collapsedFiles.add(path);
        collapsed++;
      }
    }
    if (collapsed > 0) this.reDiff();
    return collapsed;
  }

  /** The header-row view position of the file owning `documentKey` (`new:<p>` / `old:<p>`) — the
   *  caret-recovery target when its own row was collapsed away. */
  private headerViewRowForDocumentKey(documentKey: string): { row: number; column: number } | null {
    const sep = documentKey.indexOf(':');
    const path = sep >= 0 ? documentKey.slice(sep + 1) : documentKey;
    const h = this.headerAnchors.find((a) => a.path === path);
    return h ? { row: h.viewRow, column: 0 } : null;
  }

  // --- hunk staging ----------------------------------------------------------

  /** Stage the hunk under the caret (its unstaged change → the index). */
  stageHunkAtCursor(): void {
    this.applyStaging('stage');
  }

  /** Unstage the staged hunk under the caret (its index change reverted out of the index). */
  unstageHunkAtCursor(): void {
    this.applyStaging('unstage');
  }

  /** Revert (discard) the unstaged hunk under the caret: restore its rows to the index version
   *  on the live new-side Document, as one undoable edit, then save so the working tree matches.
   *  Mirrors the gutter editor's `git:hunk-revert`, but edits the shared Document (not a git apply
   *  on disk) so the diff, any open editor, and the LSP all stay in sync. Live diffs only. */
  revertHunkAtCursor(): void {
    if (!this.repo) return void zym.notifications.addTrace('Not in a git repository');
    const ctx = this.caretFileContext();
    if (!ctx) return void zym.notifications.addTrace('No change under the cursor');
    const { path, indexLines, worktreeLines, worktreeRow } = ctx;

    // Unstaged hunks live in the index→worktree diff; the displayed new side IS the worktree, so
    // the caret's worktree row indexes them directly (mirrors `applyStaging('stage')`).
    const hunk = computeHunks(indexLines, worktreeLines).find((h) => hunkContainsBufferRow(h, worktreeRow));
    if (!hunk) return void zym.notifications.addTrace('No unstaged change under the cursor');

    const document = this.sources.get(newKey(path))?.document;
    if (!document) return void zym.notifications.addTrace('Cannot revert a hunk in this diff');

    // Replace the hunk's worktree rows with the index version (`oldLines`, each newline-terminated);
    // a pure deletion (no new rows) re-inserts the removed lines before `newStart`.
    const startRow = hunk.newStart;
    const endRow = hunk.newStart + hunk.newLines.length; // exclusive
    const restored = hunk.oldLines.map((line) => line + '\n').join('');
    document.replaceModelLineRange(startRow, endRow, restored);
    document.save();
    this.gitRepo?.refresh(); // working-tree change counts (Source Control panel); the model edit re-diffs the view
  }

  // --- hunk navigation -------------------------------------------------------

  /** Move the caret to the start of the next changed hunk and reveal it. `]h` (overrides vim's
   *  gutter-based MoveToNextHunk, which no-ops in this gutterless multibuffer). Spans files; a
   *  no-op at the last hunk. */
  nextHunk(): void {
    this.moveToHunk(1);
  }

  /** Move the caret to the start of the previous changed hunk and reveal it. `[h`. */
  prevHunk(): void {
    this.moveToHunk(-1);
  }

  /** Live diff: stage the hunk under the caret, then advance to the next one — a fast
   *  review-and-stage flow. Staging only re-marks rows (the worktree-vs-HEAD layout is unchanged),
   *  so the next-hunk position computed now stays valid through the async refresh. */
  stageHunkAndAdvance(): void {
    this.stageHunkAtCursor();
    this.nextHunk();
  }

  // The view rows that begin a changed hunk: a run of added/removed rows whose preceding row isn't
  // changed (so a removed-then-added block reads as one hunk; runs split by context are separate).
  private hunkStartRows(): number[] {
    const starts: number[] = [];
    let prevChanged = false;
    this.dmb.rowKinds.forEach((kind, r) => {
      const changed = kind === 'added' || kind === 'removed';
      if (changed && !prevChanged) starts.push(r);
      prevChanged = changed;
    });
    return starts;
  }

  private moveToHunk(dir: 1 | -1): void {
    const starts = this.hunkStartRows();
    if (!starts.length) return;
    const cur = this.cursorRow();
    const target = dir === 1 ? starts.find((r) => r > cur) : starts.reverse().find((r) => r < cur);
    if (target == null) return; // already at the first / last hunk
    this.editor.model.setCursorBufferPosition({ row: target, column: 0 });
    this.editor.model.scrollCursorOnscreen(); // reveal if offscreen (minimal scroll, keeps a margin)
  }

  /** Move the caret to the next file's header row and reveal it (`z j`). */
  nextFile(): void {
    this.moveToFile(1);
  }

  /** Move the caret to the previous file's header row and reveal it (`z k`). */
  previousFile(): void {
    this.moveToFile(-1);
  }

  private moveToFile(dir: 1 | -1): void {
    const headers = this.dmb.headerAnchors.map((h) => h.viewRow).sort((a, b) => a - b);
    if (!headers.length) return;
    const cur = this.cursorRow();
    const target = dir === 1 ? headers.find((r) => r > cur) : [...headers].reverse().find((r) => r < cur);
    if (target == null) return; // already at the first / last file
    this.editor.model.setCursorBufferPosition({ row: target, column: 0 });
    this.editor.model.scrollCursorOnscreen();
  }

  private applyStaging(mode: 'stage' | 'unstage'): void {
    if (!this.repo) return void zym.notifications.addTrace('Not in a git repository');
    const ctx = this.caretFileContext();
    if (!ctx) return void zym.notifications.addTrace('No change under the cursor');
    const { path, headLines, indexLines, worktreeLines, worktreeRow } = ctx;
    const relPath = Path.relative(this.repo, path);

    let hunk: Hunk | undefined;
    let opts: { cached: boolean; reverse?: boolean };
    if (mode === 'stage') {
      // Unstaged hunks live in the index→worktree diff; the displayed new side IS the worktree, so
      // the caret's worktree row indexes them directly.
      hunk = computeHunks(indexLines, worktreeLines).find((h) => hunkContainsBufferRow(h, worktreeRow));
      opts = { cached: true };
      if (!hunk) return void zym.notifications.addTrace('No unstaged change under the cursor');
    } else {
      // Staged hunks live in the HEAD→index diff (index coords); map the caret's worktree row into
      // index coords to find the one under the cursor (mirrors GitGutter).
      const wToIndex = buildRowMap(worktreeLines, indexLines);
      const indexRow = wToIndex[Math.min(worktreeRow, wToIndex.length - 1)] ?? indexLines.length - 1;
      hunk = computeHunks(headLines, indexLines).find((h) => hunkContainsBufferRow(h, indexRow));
      opts = { cached: true, reverse: true };
      if (!hunk) return void zym.notifications.addTrace('No staged change under the cursor');
    }

    const done: GitDone = (ok, _out, err) => {
      if (!ok) return void zym.notifications.addError(`Failed to ${mode} hunk`, { detail: err.trim() });
      this.gitRepo?.refresh(); // let the Source Control panel pick up the new index state
      this.fetchIndexText([path], () => this.refreshMarkers()); // re-read the index → repaint markers
    };
    applyPatch(this.repo, formatHunkPatch(relPath, hunk), opts, done);
  }

  /** The file + worktree row under the caret, with that file's HEAD/index/worktree line arrays —
   *  the inputs a staging op needs. Returns null when the caret isn't on a file's rows. */
  private caretFileContext(): {
    path: string;
    headLines: string[];
    indexLines: string[];
    worktreeLines: string[];
    worktreeRow: number;
  } | null {
    const hit = this.fileAtViewRow(this.cursorRow());
    if (!hit) return null;
    const file = this.files.find((f) => f.path === hit.path);
    if (!file) return null;
    return {
      path: hit.path,
      headLines: file.oldText.split('\n'),
      indexLines: (this.indexText.get(hit.path) ?? '').split('\n'),
      worktreeLines: this.currentNewText(file).split('\n'),
      worktreeRow: hit.worktreeRow,
    };
  }

  /** Which file a view row belongs to (via the header anchors) and a worktree row inside it a hunk
   *  can key off: the row's own new-side line, or — for a removed/phantom or header/gap row — the
   *  nearest new-side line in the same file (forward first, so a deletion anchors to the line that
   *  follows it; `hunkContainsBufferRow` tolerates the ±1). */
  private fileAtViewRow(viewRow: number): { path: string; worktreeRow: number } | null {
    const anchors = this.headerAnchors;
    if (!anchors.length) return null;
    let fi = 0;
    for (let i = 0; i < anchors.length; i++) if (anchors[i].viewRow <= viewRow) fi = i;
    const start = anchors[fi].viewRow;
    const end = fi + 1 < anchors.length ? anchors[fi + 1].viewRow : this.dmb.rowKinds.length;
    const newOf = (r: number): number | null => (r >= start && r < end ? this.dmb.newNums[r] : null);
    let wr = newOf(viewRow);
    for (let d = 1; wr == null && (viewRow + d < end || viewRow - d >= start); d++) {
      wr = newOf(viewRow + d) ?? newOf(viewRow - d);
    }
    return { path: anchors[fi].path, worktreeRow: wr != null ? wr - 1 : 0 };
  }

  /** React to a repo change on the live staging surface. A HEAD MOVE (commit / amend / reset /
   *  checkout) re-bases the diff: the base (old) side is re-fetched from the new HEAD, so a file now
   *  identical to the worktree produces no hunks and `buildDiffMultiBuffer` drops it — committing
   *  every change empties the view. A mere index move (staging / unstaging) leaves the worktree↔HEAD
   *  geometry untouched, so it only repaints the staged/unstaged markers (no re-flow, no caret jump
   *  — see refreshMarkers). The index blobs are refreshed either way. `reconcileFiles` additionally
   *  folds in any file that became changed since open. */
  private onGitChange(): void {
    if (this.disposed) return;
    const head = this.gitRepo?.getHead() ?? null;
    const headMoved = head !== this.lastHead;
    this.lastHead = head;
    this.reconcileFiles();
    const paths = this.files.map((f) => f.path);
    this.fetchIndexText(paths, () => {
      if (this.disposed) return;
      if (headMoved) this.rebaseToHead(paths);
      else this.refreshMarkers();
    });
  }

  /** Fold newly-changed files into the live set via the host-rebuilt `refreshFiles` → `setFiles`.
   *  Gated on the set actually GROWING so a content-only change pays nothing; `reconcileGen` drops a
   *  superseded fetch. (Files gone clean aren't removed — they already render nothing.) */
  private reconcileFiles(): void {
    if (this.disposed || !this.refreshFiles || !this.gitRepo) return;
    const known = new Set(this.files.map((f) => f.path));
    const grew = [...this.gitRepo.getFileStatuses().keys()].some((p) => !known.has(p));
    if (!grew) return;
    const gen = ++this.reconcileGen;
    void this.refreshFiles().then((files) => {
      if (this.disposed || gen !== this.reconcileGen || !files) return;
      this.setFiles(files);
    });
  }

  /** Re-fetch each file's HEAD blob (the base side) after a HEAD move, swap it into the read-only
   *  old-side buffers, and re-diff. Files whose base now equals the worktree fall out of the diff
   *  (no hunks), so a fully-committed tree empties the view. */
  private rebaseToHead(paths: string[]): void {
    if (this.disposed || !this.repo) return;
    const gen = ++this.rebaseGen;
    this.fetchHeadText(paths, (byPath) => {
      if (this.disposed || gen !== this.rebaseGen) return; // a newer re-base superseded this fetch
      // A bulk old-side replace would otherwise echo through reverse-sync into the view; suspend it
      // and re-flow once via reDiff (which reads the updated source buffers).
      this.screen.suspend();
      try {
        for (const file of this.files) {
          const head = byPath.get(file.path) ?? '';
          if (head === file.oldText) continue;
          file.oldText = head;
          this.sources.get(oldKey(file.path))?.buffer.setText(head, -1);
        }
      } finally {
        this.screen.resume();
      }
      this.reDiff();
    });
  }

  /** Read each path's HEAD blob (`git show HEAD:rel`) and hand the path→text map to `cb`. A path
   *  absent from HEAD (a newly added file) reads as empty (its whole content is added vs HEAD). */
  private fetchHeadText(paths: string[], cb: (byPath: Map<string, string>) => void): void {
    if (!this.repo || this.disposed) return;
    const byPath = new Map<string, string>();
    let pending = paths.length;
    if (pending === 0) return void cb(byPath);
    for (const path of paths) {
      const rel = Path.relative(this.repo, path);
      git(this.repo, ['show', `HEAD:${rel}`], (ok, out) => {
        if (this.disposed) return;
        byPath.set(path, ok ? out : '');
        if (--pending === 0) cb(byPath);
      });
    }
  }

  /** Read each path's staged (index) blob (`git show :rel`) into `indexText`, then run `cb`. A file
   *  absent from the index (untracked / staged-deleted) reads as empty (nothing staged there). */
  private fetchIndexText(paths: string[], cb: () => void): void {
    if (!this.repo || this.disposed) return;
    let pending = paths.length;
    if (pending === 0) return void cb();
    for (const path of paths) {
      const rel = Path.relative(this.repo, path);
      git(this.repo, ['show', `:${rel}`], (ok, out) => {
        if (this.disposed) return;
        this.indexText.set(path, ok ? out : '');
        if (--pending === 0) cb();
      });
    }
  }

  /** Rebuild the diff only to recompute the staged/unstaged classification and repaint the gutter
   *  markers. Geometry is worktree↔HEAD, unchanged by an index move, so this skips the retarget
   *  splice (no flash, no caret move). */
  private refreshMarkers(): void {
    if (this.disposed) return;
    const dmb = this.buildDiff();
    this.dmb = dmb;
    const gw = this.gutterWidths();
    this.lineNumbers?.setData(
      lineLabels(dmb.oldNums, gw.old),
      lineLabels(dmb.newNums, gw.new),
      gutterBg(dmb, 'old'),
      gutterBg(dmb, 'new'),
      headerRows(dmb),
      this.live ? dmb.stagedState : null,
    );
  }

  /** (Re)place the file-header widgets (OVER each file's navigable header row, via the sticky layer)
   *  + the `⋯` gap bands (the leading file-head gap and between-window gaps). All are real widgets,
   *  not navigable buffer rows.
   *
   *  RECONCILED by id, not torn down: a re-flow moves the bands and changes their text, but removing
   *  + re-adding every band collapses its reserved space and re-expands it a frame later, which
   *  flickers and jumps the text. Instead each handle is reused in place, rebuilding its widget only
   *  when its CONTENT key changed. A no-structure-change re-diff (typing within a line) updates
   *  nothing. */
  private static headerKey(h: DiffMultiBuffer['headerAnchors'][number], collapsed: boolean, modified: boolean): string {
    return `${h.path}\n${h.label}\n${collapsed ? 'c' : 'e'}\n${modified ? 'M' : ''}\n${h.added}\n${h.removed}\n${h.deleted ? 'D' : ''}`;
  }
  /** Whether `path`'s live new-side document has unsaved edits (drives the header's modified
   *  marker). Always false in read-only mode (no document). */
  private isFileModified(path: string): boolean {
    return this.sources.get(newKey(path))?.document?.isModified() ?? false;
  }
  private static gapKey(g: DiffMultiBuffer['gapAnchors'][number], label: string): string {
    return `${g.placement}\n${label}\n${g.revealRows.join(',')}`;
  }
  /** The gap band's text. When the line-number gutter is on (`editor.diffLineNumbers`), the
   *  `@@ -old +new @@` range just restates the gutter, so drop the range and keep only the trailing
   *  section (the enclosing function-context git appends) — a bare `⋯` when the hunk has no section,
   *  or for a trailing gap that never carried a range. */
  private static gapLabel(rawLabel: string, showLineNumbers: boolean): string {
    if (!showLineNumbers || !rawLabel.startsWith('@@')) return rawLabel;
    return rawLabel.replace(/^@@ .*? @@/, '').trim() || '⋯';
  }
  private installOverlays(dmb: DiffMultiBuffer): void {
    this.gapAnchors = dmb.gapAnchors; // kept for the keyboard expand (`expandContextAtCursor`)
    this.headerAnchors = dmb.headerAnchors;

    // File headers are STICKY block decorations placed OVER their (navigable) header row. Keyed by
    // PATH so a file keeps its widget across re-diffs; rebuilt only when its content key (label /
    // collapse / stats / modified) changes.
    const headerSpecs: StickyHeaderSpec[] = dmb.headerAnchors.map((h) => {
      const collapsed = this.collapsedFiles.has(h.path);
      const modified = this.isFileModified(h.path);
      const scope = new CompositeDisposable();
      return {
        id: `header:${h.path}`,
        key: DiffView.headerKey(h, collapsed, modified),
        viewRow: h.viewRow,
        build: () =>
          buildHeaderWidget(
            scope,
            h.label,
            h.path,
            // Single click does nothing (a header click no longer opens the file); a double-click
            // toggles the file's fold — the pointer equivalent of `z a`.
            (nPress) => { if (nPress === 2) this.toggleFileCollapse(h.path); },
            // Diff look: no file-type icon, bold the whole path, flag unsaved edits (warning + dot),
            // plus the collapse chevron + `+N −M` stats, and a `(deleted)` tag for a removed file.
            { icon: false, boldPath: true, modified, collapsed, added: h.added, removed: h.removed, deleted: h.deleted },
          ),
        dispose: () => scope.dispose(), // sever the header click controller when the widget is replaced/removed
      };
    });
    this.editor.stickyHeaders.setHeaders(headerSpecs);

    // `⋯` gaps (incl. the leading file-head gap, now its own band) + accumulated review-comment
    // cards stay ordinary (scrolling) block decorations.
    const specs: BlockDecorationSpec[] = [];
    // With the line-number gutter on (`editor.diffLineNumbers`) the `@@ -old +new @@` range restates
    // the gutter, so drop it and keep just the trailing section context (see `gapLabel`).
    const showDiffLineNumbers = zym.config.get('editor.diffLineNumbers') === true;
    dmb.gapAnchors.forEach((g, i) => {
      const scope = new CompositeDisposable();
      const label = DiffView.gapLabel(g.label, showDiffLineNumbers);
      specs.push({
        id: `gap:${i}`,
        key: DiffView.gapKey(g, label), // keyed on the DISPLAYED label so a live line-number toggle rebuilds it
        anchor: { viewRow: g.viewRow },
        placement: g.placement,
        // The `⋯ N unchanged lines` band spans the FULL content width and rides the text, so it stays
        // full-width at any horizontal scroll (like the file header above it, but scrolling not pinned).
        fullWidth: 'content',
        // Clicking the gap reveals a chunk of its elided lines (`fromTop` = which end first).
        build: () => buildGapWidget(scope, label, () => this.revealChunk(g.revealRows, g.fromTop)),
        dispose: () => scope.dispose(),
      });
    });
    // Accumulated review comments: a read-only card under each commented line (source-anchored, so
    // it tracks the line across re-diffs/edits). Reconciled in the same set by stable id.
    this.pending.forEach((p) => {
      if (p.id === this.editingPendingId) return;
      specs.push({
        id: p.id,
        key: p.comment.comment,
        anchor: p.anchor,
        placement: 'below',
        fullWidth: 'content', // see docs/text-editor/diff.md — the wrapping label needs a forced width
        build: () => buildCommentCard(p.comment.comment),
      });
    });
    this.bands.set(specs);
  }

  private currentNewText(file: DiffFile): string {
    return this.sources.get(newKey(file.path))?.document?.getText() ?? file.newText;
  }

  /** Editable mode: re-emit a new-side file's modified state (tab unsaved marker) and refresh the
   *  header bands when it toggles. No-op on the read-only base side. */
  private watchNewSideModified(entry: SourceEntry): void {
    if (!entry.document) return;
    this.modifiedUnsubs.push(
      entry.document.onModifiedChange(() => {
        this.emitModified();
        this.installOverlays(this.dmb);
      }),
    );
  }

  /** Fold newly-changed files into the live set (adds only; existing files keep their per-file state,
   *  which is keyed by path). Driven by `reconcileFiles` and reopen (`PaneItems.openLiveDiff`). */
  setFiles(files: DiffFile[]): void {
    if (this.disposed || !this.live) return;
    const known = new Set(this.files.map((f) => f.path));
    const added = files.filter((f) => !known.has(f.path));
    if (added.length === 0) return;
    for (const file of added) {
      this.files.push(file);
      this.ensureSources(file);
      this.watchNewSideModified(this.sources.get(newKey(file.path))!);
    }
    this.reDiff();
    // The added files' index blobs paint their staged/unstaged markers (mirrors the ctor).
    if (this.repo) this.fetchIndexText(added.map((f) => f.path), () => this.refreshMarkers());
  }

  /** Resolve the old (base, read-only blob) + new (live Document or snapshot) sides of `file`. */
  private ensureSources(file: DiffFile): void {
    if (!this.sources.has(oldKey(file.path))) {
      this.sources.set(oldKey(file.path), this.snapshotSource(file.oldText, file.path));
    }
    if (this.sources.has(newKey(file.path))) return;
    const entry = this.editable ? this.acquireNewSide(file) : this.snapshotSource(file.newText, file.path);
    if (entry) this.sources.set(newKey(file.path), entry);
  }

  /** A read-only blob buffer + its own (deferred) parse (the base side, and both sides when
   *  read-only). The parse is lazy — run when the hunk nears the viewport (see the projection). */
  private snapshotSource(text: string, path: string): SourceEntry {
    const buffer = new GtkSource.Buffer();
    buffer.setText(text, -1);
    const syntax = new DocumentSyntax(buffer);
    return { buffer, syntax, parse: () => syntax.setLanguageForPath(path, { deferParse: true }) };
  }

  /** Editable new side: the shared live Document's model buffer + its own parse (no double
   *  parse, deferred). Loads from disk only if not already open (preserving an open tab's unsaved
   *  edits). */
  private acquireNewSide(file: DiffFile): SourceEntry {
    const { document } = this.registry!.acquire(file.path);
    if (!document.isLoaded) document.loadFile(file.path);
    return {
      buffer: document.modelBuffer,
      syntax: document.syntax,
      document,
      parse: () => document.syntax.setLanguageForPath(file.path, { deferParse: true }),
    };
  }

  private scheduleReDiff(): void {
    if (this.suppressReDiff || this.disposed) return;
    if (this.reDiffTimer) clearTimeout(this.reDiffTimer);
    this.reDiffTimer = setTimeout(() => {
      this.reDiffTimer = null;
      this.reDiff();
    }, REDIFF_DEBOUNCE_MS);
  }

  // Re-diff on the next FRAME (a line-count-changing edit), via a GTK tick callback: it runs after
  // the edit command settles (so vim has placed the caret) but in the frame's update phase BEFORE
  // the paint, so the reflow + caret-follow happen with no visible flash. Supersedes a pending
  // debounce.
  //
  // The frame clock (not queueMicrotask/setTimeout) because it's the only scheduler that fires
  // *before paint* — required to avoid a visible flash. See docs/index.md "node-gtk event loop".
  private microReDiffTickId = 0;
  private scheduleMicroReDiff(): void {
    if (this.microReDiffTickId || this.disposed) return;
    if (this.reDiffTimer) { clearTimeout(this.reDiffTimer); this.reDiffTimer = null; }
    this.microReDiffTickId = this.editor.sourceView.addTickCallback(() => {
      this.microReDiffTickId = 0;
      if (!this.disposed && !this.suppressReDiff) this.reDiff();
      return false; // G_SOURCE_REMOVE — run once
    });
  }

  /** Recompute the windowed diff from the (edited) live new side and re-flow the view with a
   *  minimal splice — phantom/removed rows appear/disappear without a whole-buffer flash. */
  private reDiff(): void {
    if (this.disposed) return;
    // Anchor the caret to its SOURCE position: the reflow re-aligns rows (e.g. a just-typed line
    // is re-classified as added and moves past the removed block), so a view-row caret would be
    // left pointing at a different (often phantom) row — and edits would then land there.
    const caret = this.editor.model.getCursorBufferPosition();
    const anchor = this.projection.screenToDocument(caret.row, caret.column);
    // A caret resting ON a file header maps to a block row, not a document position, so the restore
    // below would skip it. Anchor it to that file's PATH and re-land it on the header after the
    // reflow — otherwise the splice drags it: the last file's header is the buffer's final,
    // unterminated line, so expanding it appends at the caret and the insert mark rides to the end.
    const headerPath =
      anchor.kind === 'block' && anchor.block === 'header' ? this.fileAtViewRow(caret.row)?.path ?? null : null;
    // Anchor the top visible line by its SOURCE position (stable across the reflow, unlike a pixel
    // offset), so rows spliced above the viewport don't jump the content under the reader. Captured
    // before the splice, restored after — the caret restore below doesn't scroll.
    const topAnchor = this.topScrollAnchor();
    const dmb = this.buildDiff();
    this.dmb = dmb;
    // No file has any change → show the empty state instead of an empty editor.
    this.stack.setVisibleChildName(dmb.headerAnchors.length === 0 ? 'empty' : 'diff');
    this.suppressReDiff = true; // retarget's view edits must not re-trigger a re-diff
    try {
      this.screen.retarget(dmb.items);
    } finally {
      this.suppressReDiff = false;
    }
    this.applyDecorations(dmb);
    const gw = this.gutterWidths();
    this.lineNumbers?.setData(lineLabels(dmb.oldNums, gw.old), lineLabels(dmb.newNums, gw.new), gutterBg(dmb, 'old'), gutterBg(dmb, 'new'), headerRows(dmb), this.live ? dmb.stagedState : null);
    this.installOverlays(dmb); // re-place header + gap widgets (counts/positions re-flowed)
    // retarget swapped rows but didn't repaint — re-highlight the spliced sections.
    this.editor.repaintSyntax();
    // Restore the caret to where its source position now shows (it followed the reflow). If its row
    // was collapsed away, fall back to the file's header row so the caret stays in the same file.
    if (anchor.kind === 'document') {
      const pos =
        this.projection.documentToScreen(anchor.documentKey, anchor.row, anchor.column) ??
        this.headerViewRowForDocumentKey(anchor.documentKey);
      if (pos) this.editor.model.setCursorBufferPosition(pos);
    } else if (headerPath) {
      const h = this.headerAnchors.find((a) => a.path === headerPath);
      if (h) this.editor.model.setCursorBufferPosition({ row: h.viewRow, column: 0 });
    }
    // Re-pin the anchored top line (skipped if it was collapsed/dropped — leave the scroll be).
    if (topAnchor) {
      const top = this.projection.documentToScreen(topAnchor.documentKey, topAnchor.row, topAnchor.column);
      if (top) this.editor.model.setTopBufferRow(top.row);
    }
    // (Header focus follows the caret automatically — owned by `editor.stickyHeaders`.)
    this.lastLineCount = this.screen.buffer.getLineCount(); // reflow changed it
  }

  /** The stable source anchor for the row to keep pinned to the viewport top across a reflow: the
   *  topmost visible row, or the first document row just below it when that's a header/gap block
   *  (which carries no source position). Null when nothing near the top maps to a source line. */
  private topScrollAnchor(): { documentKey: string; row: number; column: number } | null {
    const top = this.editor.model.getFirstVisibleScreenRow();
    const total = this.screen.buffer.getLineCount();
    for (let r = top; r < total && r < top + 8; r++) {
      const a = this.projection.screenToDocument(r, 0);
      if (a.kind === 'document') return { documentKey: a.documentKey, row: a.row, column: a.column };
    }
    return null;
  }

  /** Added/removed line backgrounds from the per-row diff kinds (header/blank/gap/context get
   *  none). The view buffer's last line is unterminated, so decorations span its content. */
  private applyDecorations(dmb: DiffMultiBuffer): void {
    const buffer = this.screen.buffer;
    const lines = dmb.rowKinds.map((kind, row) => ({
      kind: kind === 'added' || kind === 'removed' ? kind : 'context',
      text: this.lineText(buffer, row),
      wordRanges: dmb.wordRanges[row] ?? undefined, // intra-line word-add/word-del spans
    }));
    applyDiffDecorations(this.editor.decorations.layer('diff'), lines, /* terminated */ false);
    // (The read-only header rows hide the caret + read `.focused` — owned by `editor.stickyHeaders`.)
  }

  private lineText(buffer: any, row: number): string {
    const start = asIter(buffer.getIterAtLine(row));
    const end = start.copy();
    if (!end.endsLine()) end.forwardToLineEnd();
    return buffer.getText(start, end, true);
  }

  private installNavigation(): void {
    const view = this.editor.sourceView;
    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number) => {
      if (keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) return false;
      if (this.editable && view.getEditable()) return false; // insert mode: Enter is a newline
      // Enter opens the comment box where commenting is enabled (every diff now wires `onSend`);
      // `g d` always jumps to the file/line instead.
      if (this.canComment) this.startComment();
      else this.activateRow(this.cursorRow());
      return true;
    });
    this.disposables.addController(view, keys);

    if (this.editable) return; // double-click word-select stays while editing
    const click = new Gtk.GestureClick();
    click.on('pressed', (nPress: number, x: number, y: number) => {
      if (nPress < 2) return;
      const by = view.windowToBufferCoords(Gtk.TextWindowType.TEXT, x, y);
      const yBuf = Array.isArray(by) ? by[by.length - 1] : y;
      const r = view.getLineAtY(yBuf);
      this.activateRow(asIter(Array.isArray(r) ? r[0] : r).getLine());
    });
    this.disposables.addController(view, click);
  }

  private cursorRow(): number {
    const buffer = this.editor.sourceView.getBuffer();
    return asIter(buffer.getIterAtMark(buffer.getInsert())).getLine();
  }

  private activateRow(viewRow: number): void {
    const target = this.projection.screenToDocument(viewRow, 0);
    if (target.kind !== 'document') return;
    const sep = target.documentKey.indexOf(':'); // keys are `new:<path>` / `old:<path>`
    const path = sep >= 0 ? target.documentKey.slice(sep + 1) : target.documentKey;
    this.onActivate?.({ path, row: target.row });
  }

  /** Jump to the file/line under the cursor (the `g d` action — Enter is the comment box now). */
  openFileAtCursor(): void {
    this.activateRow(this.cursorRow());
  }

  /** Move the caret to the first row of `path`'s excerpt (falling back to the top when the file
   *  isn't present) and scroll it a quarter down the viewport. Used by the GitPanel's embedded diff
   *  to jump to the change selected in its list. `revealRow` scrolls via `scroll_to_mark` (deferred
   *  + validated), not `scroll_to_iter`, which undershoots on a freshly-embedded view. */
  revealFile(path: string): void {
    const anchor = this.headerAnchors.find((h) => h.path === path);
    const row = anchor ? anchor.viewRow : 0;
    this.editor.revealRow(row);
  }

  /** The files currently shown in the diff (absolute `path` + display `label`), in view order — for
   *  the `z /` file picker. */
  fileList(): { path: string; label: string }[] {
    return this.dmb.headerAnchors.map((h) => ({ path: h.path, label: h.label }));
  }

  /** Jump to `path`'s header — caret onto it + scroll into view + focus (the `z /` picker). */
  goToFile(path: string): void {
    const anchor = this.dmb.headerAnchors.find((h) => h.path === path);
    if (!anchor) return;
    this.editor.model.setCursorBufferPosition({ row: anchor.viewRow, column: 0 });
    this.revealFile(path); // scroll the header a quarter down (same reveal as the GitPanel jump)
    this.editor.focus();
  }

  /** Subscribe to the cursor crossing into a different file's excerpt — fires with that file's
   *  path (the absolute `DiffFile.path`). The GitPanel uses it to keep its change-list selection
   *  in sync with where the caret sits in the diff. Fires only on a *change* of file, not every
   *  cursor move. */
  onCursorFileChanged(callback: (path: string) => void): void {
    this.cursorFileHandlers.push(callback);
  }

  // Fire `onCursorFileChanged` when the caret moves into a different file than last reported.
  private emitCursorFile(): void {
    if (!this.cursorFileHandlers.length) return;
    const path = this.fileAtViewRow(this.cursorRow())?.path ?? null;
    if (path === this.lastCursorFile) return;
    this.lastCursorFile = path;
    if (path) for (const cb of this.cursorFileHandlers) cb(path);
  }

  // --- comment to agent ------------------------------------------------------

  /** Whether commenting-to-agent is enabled here — true whenever an `onSend` sink was wired, which
   *  every diff surface now does (live or historical). Gates the `enter` action + the `diff:*`
   *  review commands. */
  get canComment(): boolean {
    return !!this.onSend;
  }

  /** Whether review mode (accumulate, send later) is on. */
  get isReviewing(): boolean {
    return this.reviewMode;
  }

  /** Number of accumulated (not-yet-sent) review comments. */
  get reviewCount(): number {
    return this.pending.length;
  }

  /** Open the inline comment box (the `enter` action) on the cursor row or the active selection,
   *  anchored just below the targeted range. On submit: in review mode the comment is accumulated as
   *  an inline card; otherwise it's formatted + sent to the agent now (via `onSend`). No-op when
   *  already open or the selection isn't on any diff line. */
  startComment(): void {
    if (!this.canComment) return; // disabled (non-agent workbench)
    if (this.commentBox) this.closeComment(); // re-target: close any open box onto the cursor line
    // Enter on a line that already has a pending comment edits it, rather than starting a new one.
    const existing = this.pending.find((p) => this.anchorViewRow(p.anchor) === this.cursorRow());
    if (existing) return this.editPending(existing);

    const target = this.buildCommentTarget();
    if (!target) return void zym.notifications.addTrace('No diff line under the cursor');
    const { anchorRow, cardAnchor, ...rest } = target;

    const box = new DiffCommentBox({
      reviewing: this.reviewMode,
      onStartReview: () => this.setReviewMode(true),
      onSubmit: (text) => {
        const body = text.trim();
        this.closeComment();
        if (!body) return;
        const comment: DiffComment = { ...rest, comment: body };
        if (this.reviewMode) this.addPending(comment, cardAnchor);
        else this.sendReview([comment]);
      },
      onCancel: () => this.closeComment(),
    });
    this.openCommentBox(box, anchorRow);
  }

  /** Re-open the comment box on an existing pending comment, prefilled — Enter updates it in place
   *  (an empty submit deletes it). */
  private editPending(p: { comment: DiffComment; anchor: BlockDecorationAnchor; id: string }): void {
    const anchorRow = this.anchorViewRow(p.anchor) ?? this.cursorRow();
    this.editingPendingId = p.id;
    this.installOverlays(this.dmb);
    // onSubmit/onCancel only mutate `pending` then close; the peek's onClose re-renders (or drops) the
    // card from the resulting state — it's the single hook that fires for every close path.
    const box = new DiffCommentBox({
      reviewing: true, // a pending comment only exists in review mode
      editing: true,
      initialText: p.comment.comment,
      onStartReview: () => this.setReviewMode(true),
      onSubmit: (text) => {
        const body = text.trim();
        if (!body) {
          const idx = this.pending.findIndex((q) => q.id === p.id);
          if (idx >= 0) this.pending.splice(idx, 1); // cleared → delete
        } else {
          p.comment = { ...p.comment, comment: body };
        }
        this.closeComment();
        this.emitReview();
      },
      onCancel: () => this.closeComment(),
    });
    this.openCommentBox(box, anchorRow);
  }

  /** Show `box` in the focusable peek anchored below `anchorRow`, tracking it as the open box. */
  private openCommentBox(box: DiffCommentBox, anchorRow: number): void {
    this.commentBox = box;
    this.editor.showPeek({
      line: anchorRow,
      widget: box.root,
      height: box.height,
      alignLeft: true, // line up with the pending-comment cards (add_overlay at the text-window left)
      // Defer the box teardown off its own key-event dispatch (disposing the nested editor
      // synchronously is unsafe — see buildDefinitionPeek, which never disposes its peek editor).
      onClose: () => {
        if (this.commentBox === box) this.commentBox = null;
        const wasEditing = this.editingPendingId !== null;
        this.editingPendingId = null;
        if (this.disposed) return void box.dispose(); // view tearing down: don't tick a dead view
        if (wasEditing) this.installOverlays(this.dmb); // re-render the card now its edit box is gone
        this.editor.sourceView.addTickCallback(() => (box.dispose(), false));
      },
    });
    box.focus();
  }

  /** Close the comment box (remove the card; the box is disposed from the peek's onClose). */
  private closeComment(): void {
    if (!this.commentBox) return;
    this.editor.closePeek(); // removeOverlay synchronously (proven safe); onClose handles disposal
    this.editor.focus();
  }

  // --- review mode (accumulate, send later) ----------------------------------

  /** Toggle review mode: while on, a submitted comment is accumulated (shown inline) rather than
   *  sent immediately; `submitReview` sends the batch. */
  toggleReviewMode(): void {
    if (this.canComment) this.setReviewMode(!this.reviewMode);
  }

  /** Set review mode on/off (the `ctrl-enter` "start review" path comes through here). */
  private setReviewMode(on: boolean): void {
    if (this.reviewMode === on) return;
    this.reviewMode = on;
    zym.notifications.addTrace(`Review mode ${on ? 'on' : 'off'}`);
    this.emitReview();
  }

  /** Send all accumulated comments to the agent as one review message, then clear them. */
  submitReview(): void {
    if (!this.onSend) return;
    if (this.pending.length === 0) return void zym.notifications.addTrace('No review comments to send');
    this.sendReview(this.pending.map((p) => p.comment));
    this.pending.length = 0;
    this.installOverlays(this.dmb); // drop the inline cards
    this.emitReview();
  }

  /** Format a review (one comment or a batch) and deliver it to the agent, prefixing the diff's
   *  `reviewContext` (which revision a historical diff is of) when set. */
  private sendReview(comments: DiffComment[]): void {
    this.onSend?.(formatDiffReview(comments, this.cwd ?? process.cwd(), this.reviewContext));
  }

  /** Drop the accumulated comment whose card sits on the cursor's line (to fix a mistake). */
  removeCommentAtCursor(): void {
    const p = this.pending.find((p) => this.anchorViewRow(p.anchor) === this.cursorRow());
    if (!p) return void zym.notifications.addTrace('No review comment on this line');
    this.removePending(p.id);
  }

  private removePending(id: string): void {
    const idx = this.pending.findIndex((p) => p.id === id);
    if (idx < 0) return;
    this.pending.splice(idx, 1);
    this.installOverlays(this.dmb); // drop the inline card
    this.emitReview();
  }

  private addPending(comment: DiffComment, anchor: BlockDecorationAnchor): void {
    this.pending.push({ comment, anchor, id: `comment:${this.pendingSeq++}` });
    this.installOverlays(this.dmb); // place the new inline card
    this.emitReview();
  }

  /** The current view row of a block-decoration anchor (for matching the cursor to a card). */
  private anchorViewRow(anchor: BlockDecorationAnchor): number | null {
    if ('viewRow' in anchor) return anchor.viewRow;
    const pos = this.projection.documentToScreen(anchor.documentKey ?? '', anchor.row, 0);
    return pos ? pos.row : null;
  }

  /** Subscribe to review-state changes (mode toggled / a comment added/removed/sent). For the tab
   *  title's review count. */
  onReviewChange(callback: () => void): void {
    this.reviewHandlers.push(callback);
  }
  private emitReview(): void {
    for (const cb of this.reviewHandlers) cb();
  }

  /** Build the comment target from the current cursor/selection: a unified-diff hunk plus a precise
   *  locator and a navigation line. With a VISUAL selection the hunk is EXACTLY the selected rows
   *  (so the range is exact); with NO selection (a bare cursor) it's the whole surrounding diff hunk
   *  (the changed run + a little context) — a lone line has no context and reads as confusing.
   *  Returns null when there's no diff line near the cursor. */
  private buildCommentTarget(): (Omit<DiffComment, 'comment'> & { anchorRow: number; cardAnchor: BlockDecorationAnchor }) | null {
    const kinds = this.dmb.rowKinds;
    const isReal = (k: DiffMultiBuffer['rowKinds'][number]): boolean => k === 'context' || k === 'added' || k === 'removed';
    const range = this.editor.model.getSelectedBufferRange();
    const empty = range.start.row === range.end.row && range.start.column === range.end.column;
    let r0 = range.start.row;
    // An exclusive end at column 0 means the last row isn't actually selected (line-wise selection).
    let r1 = range.end.row > r0 && range.end.column === 0 ? range.end.row - 1 : range.end.row;
    // The box/card anchors at the cursor (or selection end) — captured BEFORE the hunk widening
    // below, which only widens the patch CONTENT, not where the editor appears.
    const anchorRow = r1;
    // No selection → widen to the surrounding hunk so the agent gets context, not a single line.
    if (empty) [r0, r1] = this.hunkRangeAt(r0);

    // The real diff rows in the selection; fall back to the nearest one (selection on a header/gap).
    let rows: number[] = [];
    for (let r = r0; r <= r1; r++) if (r >= 0 && r < kinds.length && isReal(kinds[r])) rows.push(r);
    if (rows.length === 0) {
      const n = this.nearestRealRow(r0);
      if (n == null) return null;
      rows = [n];
    }

    const hit = this.fileAtViewRow(rows[0]);
    if (!hit) return null;

    // Diff body: each selected row as a unified-diff line (+/-/space by kind).
    const buffer = this.screen.buffer;
    const body = rows.map((r) => {
      const prefix = kinds[r] === 'added' ? '+' : kinds[r] === 'removed' ? '-' : ' ';
      return prefix + this.lineText(buffer, r);
    });

    // `@@` header: each side's start = its first selected line number (nearest diff line when this
    // side is absent — a pure add/delete), count = how many selected rows carry that side.
    const olds = rows.map((r) => this.dmb.oldNums[r]).filter((n): n is number => n != null);
    const news = rows.map((r) => this.dmb.newNums[r]).filter((n): n is number => n != null);
    const oldStart = olds.length ? olds[0] : this.nearestNum(rows[0], 'old') ?? 0;
    const newStart = news.length ? news[0] : this.nearestNum(rows[0], 'new') ?? 0;
    const patch = [`@@ -${oldStart},${olds.length} +${newStart},${news.length} @@`, ...body].join('\n');

    // Precise locator: per-side line ranges, plus columns when the selection is within one line and
    // doesn't span it whole (where sub-line precision actually adds information).
    const span = (nums: number[]): string => {
      const a = Math.min(...nums), b = Math.max(...nums);
      return a === b ? `L${a}` : `L${a}-${b}`;
    };
    // Pin the line the comment is ON: a selection covers its rows; a bare cursor pins JUST the
    // cursor's line — not the whole context hunk the patch was widened to (else the agent can't tell
    // which line the user meant). For a cursor, the real row at/under it.
    const focusRows = empty
      ? [anchorRow >= 0 && anchorRow < kinds.length && isReal(kinds[anchorRow]) ? anchorRow : this.nearestRealRow(anchorRow) ?? rows[0]]
      : rows;
    const focusOlds = focusRows.map((r) => this.dmb.oldNums[r]).filter((n): n is number => n != null);
    const focusNews = focusRows.map((r) => this.dmb.newNums[r]).filter((n): n is number => n != null);
    const navNew = focusNews.length ? focusNews[0] : this.nearestNum(focusRows[0], 'new') ?? newStart;
    const parts: string[] = [];
    if (focusNews.length) parts.push(`new ${span(focusNews)}`);
    if (focusOlds.length) parts.push(`old ${span(focusOlds)}`);
    // Column precision only for an explicit sub-line selection (not the cursor-widened hunk).
    if (!empty && r0 === r1) {
      const sc = range.start.column, ec = range.end.column; // 0-based; selection covers [sc, ec)
      const len = this.lineText(buffer, r0).length;
      if (sc === ec) parts.push(`col ${sc + 1}`);
      else if (!(sc === 0 && ec >= len)) parts.push(`cols ${sc + 1}-${ec}`);
    }

    // Anchor a pending-comment card at the cursor/selection line (same spot the editor box sat) by
    // SOURCE position, so it tracks the line across re-diffs/edits; fall back to a direct view row.
    const src = this.projection.screenToDocument(anchorRow, 0);
    const cardAnchor: BlockDecorationAnchor =
      src.kind === 'document' ? { documentKey: src.documentKey, row: src.row } : { viewRow: anchorRow };

    return {
      path: hit.path,
      navLine: navNew, // the commented line on the new side (the file the agent opens)
      locator: parts.join(', '),
      patch,
      anchorRow,
      cardAnchor,
    };
  }

  /** The view-row range of the diff hunk at (or nearest) `row`: the contiguous run of changed
   *  (added/removed) rows around the cursor, plus a few context lines each side — bounded by the
   *  shown block (header/blank/gap rows stop the expansion), then capped to `COMMENT_MAX_LINES`
   *  around the anchor so a huge changed block doesn't send a wall of context (the comment still
   *  pins the cursor's own line via the locator). For the no-selection comment, so the agent sees a
   *  hunk with context rather than a lone line; a VISUAL selection bypasses this and is sent exactly. */
  private static readonly COMMENT_CONTEXT = 3;
  private static readonly COMMENT_MAX_LINES = 10;
  private hunkRangeAt(row: number): [number, number] {
    const kinds = this.dmb.rowKinds;
    const isReal = (r: number): boolean => r >= 0 && r < kinds.length && (kinds[r] === 'context' || kinds[r] === 'added' || kinds[r] === 'removed');
    const isChange = (r: number): boolean => kinds[r] === 'added' || kinds[r] === 'removed';
    const anchor = isReal(row) ? row : this.nearestRealRow(row);
    if (anchor == null) return [row, row]; // empty diff — buildCommentTarget will bail
    // The changed cluster around the anchor (just the anchor if it's a context line).
    let cs = anchor, ce = anchor;
    if (isChange(anchor)) {
      while (isChange(cs - 1)) cs--;
      while (isChange(ce + 1)) ce++;
    }
    // Pad with context, clamped to the contiguous shown block.
    let s = cs, e = ce;
    for (let k = 0; k < DiffView.COMMENT_CONTEXT && isReal(s - 1); k++) s--;
    for (let k = 0; k < DiffView.COMMENT_CONTEXT && isReal(e + 1); k++) e++;
    // Cap an over-long hunk to a window of at most COMMENT_MAX_LINES rows around the anchor.
    const max = DiffView.COMMENT_MAX_LINES;
    if (e - s + 1 > max) {
      const lo = s, hi = e, half = Math.floor(max / 2);
      s = Math.max(lo, anchor - half);
      e = Math.min(hi, s + max - 1);
      s = Math.max(lo, e - max + 1); // re-expand upward if the window hit the block's bottom
    }
    return [s, e];
  }

  /** The nearest view row to `row` that is a real diff line (context/added/removed), searching
   *  outward; null if there are none (an empty diff). */
  private nearestRealRow(row: number): number | null {
    const kinds = this.dmb.rowKinds;
    const isReal = (r: number): boolean => kinds[r] === 'context' || kinds[r] === 'added' || kinds[r] === 'removed';
    for (let d = 0; d < kinds.length; d++) {
      if (row + d < kinds.length && isReal(row + d)) return row + d;
      if (row - d >= 0 && isReal(row - d)) return row - d;
    }
    return null;
  }

  /** The nearest non-null line number on `side`, searching outward from `row` — the anchor for the
   *  absent side of a pure add/delete hunk. */
  private nearestNum(row: number, side: 'old' | 'new'): number | null {
    const arr = side === 'old' ? this.dmb.oldNums : this.dmb.newNums;
    for (let d = 0; d < arr.length; d++) {
      if (row + d < arr.length && arr[row + d] != null) return arr[row + d];
      if (row - d >= 0 && arr[row - d] != null) return arr[row - d];
    }
    return null;
  }

  /** Whether there's unsaved work the editor should prompt about before closing: any edited
   *  new-side file (editable mode) OR accumulated, not-yet-sent review comments. */
  isModified(): boolean {
    if (this.pending.length > 0) return true;
    for (const entry of this.sources.values()) if (entry.document?.isModified()) return true;
    return false;
  }

  /** Close-prompt label (SessionParticipant) describing what's unsaved. */
  getModifiedLabel(): string {
    const parts: string[] = [];
    for (const entry of this.sources.values()) if (entry.document?.isModified()) { parts.push('unsaved edits'); break; }
    if (this.pending.length) parts.push(`${this.pending.length} unsent comment${this.pending.length === 1 ? '' : 's'}`);
    return `Git diff (${parts.join(', ') || 'modified'})`;
  }

  /** Save every edited new-side file back to disk (editable mode; no-op read-only). Comments are not
   *  persistable, so a save leaves them — the close prompt still lists them. SessionParticipant. */
  save(): void {
    for (const entry of this.sources.values()) if (entry.document?.isModified()) entry.document.save();
  }
  saveModified(): void {
    this.save();
  }

  /** Subscribe to changes in this diff's unsaved state (any edited new-side file). For the tab's
   *  modified marker. */
  onModifiedChange(callback: () => void): void {
    this.modifiedHandlers.push(callback);
  }
  private emitModified(): void {
    for (const cb of this.modifiedHandlers) cb();
  }

  focus(): void {
    // A freshly-embedded view (the GitPanel's diff, attached this frame) isn't mapped yet, so
    // grab_focus would no-op and focus would stay on the list. When that's the case, grab focus
    // once it maps. One-shot; cleared on dispose if it never maps.
    const view = this.editor.sourceView;
    if (view.getMapped()) {
      this.editor.focus();
      return;
    }
    const scope = new CompositeDisposable();
    scope.connect(view, 'map', () => {
      scope.dispose();
      this.editor.focus();
    });
    this.disposables.add(scope);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    DiffView.byRoot.delete(this.root);
    this.commentBox?.dispose(); // close the inline comment box if open (idempotent)
    this.commentBox = null;
    if (this.reDiffTimer) clearTimeout(this.reDiffTimer);
    this.reDiffTimer = null;
    if (this.microReDiffTickId) this.editor.sourceView.removeTickCallback(this.microReDiffTickId);
    this.microReDiffTickId = 0;
    this.gitUnsub?.(); // stop listening for external index changes
    this.gitUnsub = undefined;
    for (const unsub of this.modifiedUnsubs) unsub(); // detach from the (possibly shared) Documents
    this.modifiedUnsubs.length = 0;
    this.pending.length = 0; // cards are torn down by bands.clear() below
    this.reviewHandlers.length = 0;
    this.bands.clear();
    this.editor.stickyHeaders.clear(); // sever the header click controllers (editor.dispose() also does)
    this.lineNumbers?.dispose();
    // The editor owns the Screen (via its MultiBufferDocument) and disposes it below.
    for (const entry of this.sources.values()) {
      // Editable new side: drop the shared ref (a file also open in a tab survives + keeps its
      // unsaved edit). Read-only / base blobs: this view owns the parse.
      if (entry.document) this.registry!.release(entry.document);
      else entry.syntax.dispose();
    }
    this.sources.clear();
    this.disposables.dispose(); // sever the nav controllers while the source view still exists
    this.editor.dispose();
  }
}

/** One comment as an agent prompt: a `path:line` reference, the targeted lines as a unified-diff
 *  hunk (so old/new is explicit), then `On <locator>:` + the comment. The shape is shared with the
 *  file-editor comment via `formatAgentComment` — here the fence is `diff` and the body is the hunk. */
function formatDiffComment(c: DiffComment, cwd: string): string {
  return formatAgentComment({
    rel: Path.relative(cwd, c.path),
    line: c.navLine,
    fence: 'diff',
    body: c.patch,
    locator: c.locator,
    comment: c.comment,
  });
}

/** A review as an agent prompt: a single comment formats as itself; a batch becomes a numbered list
 *  of the same per-comment blocks under a count header. `context` (set for a historical diff) names
 *  the revision being reviewed and is prefixed so the agent knows which version the lines refer to. */
function formatDiffReview(comments: DiffComment[], cwd: string, context?: string): string {
  if (comments.length === 1) {
    const body = formatDiffComment(comments[0], cwd);
    return context ? `${context}\n\n${body}` : body;
  }
  const blocks = comments.map((c, i) => `### Comment ${i + 1}\n\n${formatDiffComment(c, cwd)}`);
  const header = context ? `${context} — ${comments.length} comments:` : `Code review — ${comments.length} comments:`;
  return [header, '', ...blocks].join('\n\n');
}
