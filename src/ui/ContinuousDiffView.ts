/*
 * ContinuousDiffView — a CONTINUOUS multi-file diff in one scrollable editor
 * (docs/text-editor/multibuffer.md, Phase 3b / G5). Each changed file is a filename header
 * then its diff windowed like a real diff (changed hunks + context, long unchanged runs elided
 * to a `⋯` gap; see `buildDiffMultiBuffer`): context + added rows over the NEW side, removed
 * rows over the OLD/HEAD blob, all stitched into one `ViewProjection`. Per-side syntax
 * highlighting (`ExcerptSyntaxProjection`), added/removed backgrounds (`applyDiffDecorations`),
 * old|new line gutters, and Enter/double-click → jump to the file.
 *
 * Two modes:
 *   - READ-ONLY (default): each side is a bare disk-snapshot buffer.
 *   - EDITABLE (G5): the NEW side is a LIVE `Document` from the registry, so editing a
 *     context/added row writes through to the file's model (open tab + save); removed (phantom,
 *     old-side) rows reject edits. After an edit settles, the diff is RE-COMPUTED and the view
 *     re-flowed via `ProjectionView.retarget` — a minimal-churn splice (no whole-buffer
 *     re-materialize), so phantom rows appear/disappear without a flash or a caret jump.
 */
import { Gdk, Gtk, GtkSource, type SourceBuffer } from '../gi.ts';
import { theme } from '../theme/theme.ts';
import { TextEditor } from './TextEditor/TextEditor.ts';
import { Document } from './TextEditor/Document.ts';
import { DocumentRegistry } from './TextEditor/DocumentRegistry.ts';
import { DocumentSyntax } from '../syntax/DocumentSyntax.ts';
import { ProjectionView } from './TextEditor/ProjectionView.ts';
import { ViewProjection } from './TextEditor/ViewProjection.ts';
import { ExcerptSyntaxProjection } from './multibuffer/ExcerptSyntaxProjection.ts';
import { MultiBufferDocument } from './multibuffer/MultiBufferDocument.ts';
import { applyDiffDecorations } from './TextEditor/applyDiffDecorations.ts';
import { CombinedDiffLineNumberGutter } from './TextEditor/DiffLineNumberGutter.ts';
import { buildDiffMultiBuffer, type DiffFile, type DiffMultiBuffer } from './multibuffer/diffMultiBuffer.ts';
import { buildHeaderWidget, buildGapWidget } from './HeaderBands.ts';
import { DiffCommentBox, buildCommentCard } from './DiffCommentBox.ts';
import type { BlockDecorationSpec, BlockDecorationSet, BlockDecorationAnchor } from './TextEditor/BlockDecorationSet.ts';
import { buildRowMap, computeHunks, formatHunkPatch, hunkContainsBufferRow, type Hunk } from '../util/hunkPatch.ts';
import { applyPatch, git, repoRoot, type GitDone, type GitRepo } from '../git.ts';
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

export interface ContinuousDiffOptions {
  /** Changed files: base (old/HEAD) + current (new/working) content. */
  files: DiffFile[];
  cwd?: string;
  onActivate?: (location: { path: string; row: number }) => void;
  /** Deliver a formatted review message (one comment, or an accumulated batch) to the agent. The
   *  view does ALL formatting (`formatDiffComment`/`formatDiffReview`); the host just sends the
   *  string. Absent → commenting is disabled (no agent to address — e.g. the user workbench). */
  onSend?: (message: string) => void;
  /** Edit-in-place: back the NEW side with live `Document`s (write-through + save + live
   *  re-diff) instead of disk snapshots. Requires `documents`. */
  editable?: boolean;
  /** The app's document registry — required when `editable`. */
  documents?: DocumentRegistry;
  /** The repo model — enables hunk staging (the gutter marker + `s`/`u`): refreshes Source Control
   *  after a stage/unstage, and re-reads the index when it changes externally. */
  git?: GitRepo;
}

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);
const newKey = (path: string): string => `new:${path}`;
const oldKey = (path: string): string => `old:${path}`;
const REDIFF_DEBOUNCE_MS = 120;

/** Right-align line numbers into an equal-width gutter column; a null (the side a row doesn't exist
 *  on) is all spaces of that width, so the column stays aligned and the `[space][number][space]`
 *  cell background spans a consistent width. */
function lineLabels(nums: readonly (number | null)[]): string[] {
  let width = 1;
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
}

export class ContinuousDiffView {
  readonly root: InstanceType<typeof Gtk.Widget>;
  readonly editor: TextEditor;
  private readonly files: DiffFile[];
  private readonly cwd?: string;
  private readonly sources = new Map<string, SourceEntry>();
  private readonly projectionView: ProjectionView;
  private lineNumbers: CombinedDiffLineNumberGutter | null = null;
  // Header + `⋯` gap widgets (BlockDecoration bands). Reconciled (not torn down) on each re-diff:
  // a re-flow moves them and changes their text (gap counts, leading-gap subtitle), but reusing the
  // handles in place avoids the band collapse/re-expand that flickers + jumps the text. Each entry
  // keeps the anchor's CONTENT key so we only rebuild the widget when its content actually changed.
  // Header (filename, above each file's first row) + `⋯` gap (below the last shown row before each
  // elision) widget bands, reconciled in place on each re-diff via a declarative block-decoration
  // set. A computed surface: the structure (which gaps exist, header rows) is recomputed per re-diff,
  // so the bands carry direct VIEW-row anchors and are re-`set()` on every reDiff.
  private bands!: BlockDecorationSet;
  // Expand-context state: NEW-side rows the user forced visible, and a reveal-everything flag.
  // The current diff's anchors, kept for the keyboard `expandContextAtCursor`.
  private revealAll = false;
  private readonly revealedNewRows = new Set<number>();
  private gapAnchors: DiffMultiBuffer['gapAnchors'] = [];
  private headerAnchors: DiffMultiBuffer['headerAnchors'] = [];
  private readonly onActivate?: (location: { path: string; row: number }) => void;
  private readonly onSend?: (message: string) => void;
  private commentBox: DiffCommentBox | null = null;
  // Review mode: while on, a submitted comment is ACCUMULATED (shown as an inline read-only card)
  // instead of sent; `submitReview` flushes the batch. Cards are folded into `installOverlays`'
  // band set with SOURCE anchors, so they survive re-diffs/edits. Default off (immediate send).
  private reviewMode = false;
  private readonly pending: { comment: DiffComment; anchor: BlockDecorationAnchor; id: string }[] = [];
  private pendingSeq = 0;
  private readonly reviewHandlers: Array<() => void> = [];
  private readonly editable: boolean;
  private readonly registry?: DocumentRegistry;
  // Hunk staging: the repo root, the per-file staged (index) blob, the last-built diff (for the
  // caret→file/row lookup), and the repo model (refresh + external-change subscription).
  private readonly repo: string | null;
  private readonly gitRepo?: GitRepo;
  private readonly indexText = new Map<string, string>();
  private dmb: DiffMultiBuffer;
  private gitUnsub?: () => void;
  private reDiffTimer: NodeJS.Timeout | null = null;
  private suppressReDiff = false;
  private lastLineCount = 0; // view buffer line count, to detect line-count-changing edits
  private readonly modifiedHandlers: Array<() => void> = [];
  private readonly modifiedUnsubs: Array<() => void> = [];
  private disposed = false;

  private get projection(): ViewProjection {
    return this.projectionView.view;
  }

  constructor(options: ContinuousDiffOptions) {
    this.onActivate = options.onActivate;
    this.onSend = options.onSend;
    this.files = options.files;
    this.cwd = options.cwd;
    this.editable = !!options.editable;
    this.registry = options.documents;
    this.gitRepo = options.git;
    this.repo = options.cwd ? repoRoot(options.cwd) : null;
    if (this.editable && !this.registry) {
      throw new Error('ContinuousDiffView: editable mode requires a DocumentRegistry');
    }

    // Resolve each side's source ONCE (live Document for the new side when editable, else a
    // disk snapshot; the old/base side is always a read-only blob), then diff + project.
    for (const file of this.files) this.ensureSources(file);
    const dmb = this.buildDiff();
    this.dmb = dmb;

    const sourceBuffers = new Map([...this.sources].map(([key, e]) => [key, e.buffer] as const));
    const syntaxMap = new Map([...this.sources].map(([key, e]) => [key, e.syntax] as const));
    this.projectionView = new ProjectionView(dmb.items, sourceBuffers);

    // One editor, natively backed by the multi-source projection (no buffer-mode shim): the
    // `MultiBufferDocument` supplies the view buffer, the per-excerpt syntax painter, and undo
    // (coordinating the touched sources). The editor disposes it on teardown.
    const painter = new ExcerptSyntaxProjection(() => this.projection, syntaxMap);
    this.editor = new TextEditor({ source: new MultiBufferDocument(this.projectionView, painter) });
    if (!this.editable) this.editor.model.setReadOnly(true);
    this.bands = this.editor.blockDecorations();
    this.root = this.editor.root;
    // Scope the expand-context keymap to this surface: `#TextEditor.continuous-diff` is more
    // specific than vim's `#TextEditor`, so `z o`/`z R`/`z m` bind here while `z z` (scroll) etc.
    // still fall through to vim.
    (this.editor.sourceView as any).addCssClass('continuous-diff');

    if (this.editable) {
      this.editor.model.setEditableCheck((s, e) => this.projection.isViewRangeEditable(s, e));
      // A row-count reverse-sync (undo / external) can't be re-flowed by window arithmetic on a
      // diff (new-side + phantom segments interleave), so re-derive the diff from scratch instead.
      this.projectionView.setResyncHandler(() => this.reDiff());
    }

    this.applyDecorations(dmb);

    // ONE gutter renderer drawing both old + new columns (one PangoLayout/line, for perf).
    this.lineNumbers = new CombinedDiffLineNumberGutter(
      this.editor.sourceView,
      lineLabels(dmb.oldNums),
      lineLabels(dmb.newNums),
      gutterBg(dmb, 'old'),
      gutterBg(dmb, 'new'),
      headerRows(dmb),
      dmb.stagedState,
    );

    this.installOverlays(dmb);
    this.installNavigation();
    if (this.editable) {
      // Re-diff after an edit. A LINE-COUNT change (Enter / `o` / dd) reflows the diff and moves
      // the caret relative to the gaps, so re-diff IMMEDIATELY — debouncing it leaves the caret
      // briefly stranded next to a gap widget before the deferred reflow corrects it. A within-line
      // edit doesn't move gaps, so it stays debounced (the common per-keystroke case).
      this.lastLineCount = (this.projectionView.buffer as any).getLineCount();
      this.editor.model.onDidChangeText(() => {
        if (this.suppressReDiff) return; // our own retarget edits
        const n = (this.projectionView.buffer as any).getLineCount();
        const lineCountChanged = n !== this.lastLineCount;
        this.lastLineCount = n;
        // A line-count change reflows the diff; re-diff on a MICROTASK (after the full edit
        // command finishes placing the caret, but before the next paint) so the caret follows
        // with no visible flash — yet not synchronously, which would race vim's own cursor move.
        if (lineCountChanged) this.scheduleMicroReDiff();
        else this.scheduleReDiff();
      });
      // Surface each new-side file's modified state as one event (for the tab's unsaved marker).
      for (const entry of this.sources.values()) {
        if (entry.document) this.modifiedUnsubs.push(entry.document.onModifiedChange(() => this.emitModified()));
      }
    }
    // Materializing the buffer (setText) leaves the caret at the END; start at the top.
    this.editor.model.setCursorBufferPosition({ row: 0, column: 0 });

    // Staging is only meaningful inside a repo with the live worktree. Read each file's index blob
    // (async) so the gutter marker can show staged vs unstaged, and refresh it when the index moves
    // out from under us (someone stages elsewhere).
    if (this.editable && this.repo) {
      this.fetchIndexText(this.files.map((f) => f.path), () => this.refreshMarkers());
      this.gitUnsub = this.gitRepo?.onChange(() => this.fetchIndexText(this.files.map((f) => f.path), () => this.refreshMarkers()));
    }
  }

  /** Build the windowed diff from each file's base blob + its CURRENT new-side text (the live
   *  Document's text when editable, else the snapshot passed in). */
  private buildDiff(): DiffMultiBuffer {
    const files = this.files.map((f) => ({ ...f, newText: this.currentNewText(f), indexText: this.indexText.get(f.path) }));
    // Filename headers are widgets (not navigable buffer text), anchored above each file's rows.
    // `reveal` forces user-expanded (otherwise-elided) new-side rows visible (expand-context).
    const reveal = this.revealAll ? () => true : (r: number) => this.revealedNewRows.has(r);
    return buildDiffMultiBuffer(files, this.cwd, { headers: 'widget', reveal });
  }

  // --- expand context (reveal elided unchanged lines) ------------------------
  private static readonly CHUNK = 10; // lines revealed per click / `zo`

  /** Reveal a chunk of a gap's elided rows. `fromTop` extends the window above the gap (the
   *  common case); else extends the window below (a leading gap). Re-diffs to re-flow. */
  private revealChunk(rows: number[], fromTop: boolean): void {
    if (!rows.length) return;
    const chunk = fromTop ? rows.slice(0, ContinuousDiffView.CHUNK) : rows.slice(-ContinuousDiffView.CHUNK);
    for (const r of chunk) this.revealedNewRows.add(r);
    this.reDiff();
  }

  /** Expand the gap nearest the caret, revealing TOWARD the caret: a gap below the caret reveals
   *  from its top (extends the caret's window down), a gap above reveals from its bottom (extends
   *  it up). Leading gaps (above a file's first row) join the same candidate set. So `zo` works
   *  whether the caret sits above or below the fold. */
  expandContextAtCursor(): void {
    const row = this.cursorRow();
    // Each gap sits just below `viewRow` (the last shown row before it); a leading gap sits above
    // the file's first content row (`header.viewRow`), i.e. just below `header.viewRow - 1`.
    const gaps: Array<{ rows: number[]; viewRow: number }> = [
      ...this.gapAnchors.map((g) => ({ rows: g.revealRows, viewRow: g.viewRow })),
      ...this.headerAnchors.flatMap((h) => (h.leadingRevealRows?.length ? [{ rows: h.leadingRevealRows, viewRow: h.viewRow - 1 }] : [])),
    ];
    let best: { rows: number[]; fromTop: boolean; dist: number } | null = null;
    for (const g of gaps) {
      const above = row <= g.viewRow; // is the caret above this gap?
      const dist = above ? g.viewRow - row : row - (g.viewRow + 1);
      if (!best || dist < best.dist) best = { rows: g.rows, fromTop: above, dist };
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

  // --- hunk staging ----------------------------------------------------------

  /** Stage the hunk under the caret (its unstaged change → the index). */
  stageHunkAtCursor(): void {
    this.applyStaging('stage');
  }

  /** Unstage the staged hunk under the caret (its index change reverted out of the index). */
  unstageHunkAtCursor(): void {
    this.applyStaging('unstage');
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
    this.lineNumbers?.setData(
      lineLabels(dmb.oldNums),
      lineLabels(dmb.newNums),
      gutterBg(dmb, 'old'),
      gutterBg(dmb, 'new'),
      headerRows(dmb),
      dmb.stagedState,
    );
  }

  /** (Re)place the header widgets (above each file's first row) + the `⋯` gap bands (below the
   *  last shown row before each elision). Both are real widgets, not navigable buffer rows.
   *
   *  RECONCILED by ordinal, not torn down: a re-flow moves the bands and changes their text, but
   *  removing + re-adding every band collapses its reserved space and re-expands it a frame later,
   *  which flickers and jumps the text. Instead we reuse each handle in place (`update`), rebuilding
   *  its widget only when the anchor's CONTENT key changed, and add/remove just the count delta. A
   *  no-structure-change re-diff (typing within a line) updates nothing. */
  private static headerKey(h: DiffMultiBuffer['headerAnchors'][number]): string {
    return `${h.path}\n${h.label}\n${h.subtitle ?? ''}`;
  }
  private static gapKey(g: DiffMultiBuffer['gapAnchors'][number]): string {
    return `${g.label}\n${g.revealRows.join(',')}`;
  }
  private installOverlays(dmb: DiffMultiBuffer): void {
    this.gapAnchors = dmb.gapAnchors; // kept for the keyboard expand (`expandContextAtCursor`)
    this.headerAnchors = dmb.headerAnchors;
    const specs: BlockDecorationSpec[] = [];
    dmb.headerAnchors.forEach((h, i) =>
      specs.push({
        id: `header:${i}`, // reconcile by ordinal: count changes by delta, content-key rebuilds the widget
        key: ContinuousDiffView.headerKey(h),
        anchor: { viewRow: h.viewRow },
        placement: 'above',
        build: () =>
          buildHeaderWidget(
            h.label,
            h.path,
            () => this.onActivate?.({ path: h.path, row: 0 }),
            h.subtitle,
            // A leading gap reveals TOWARD the content below it (extend the window up from its
            // bottom), like clicking any other gap.
            h.leadingRevealRows?.length ? () => this.revealChunk(h.leadingRevealRows!, false) : undefined,
          ),
      }),
    );
    dmb.gapAnchors.forEach((g, i) =>
      specs.push({
        id: `gap:${i}`,
        key: ContinuousDiffView.gapKey(g),
        anchor: { viewRow: g.viewRow },
        placement: 'below',
        // Clicking the gap reveals a chunk of its elided lines (extends the window above it).
        build: () => buildGapWidget(g.label, () => this.revealChunk(g.revealRows, true)),
      }),
    );
    // Accumulated review comments: a read-only card under each commented line (source-anchored, so
    // it tracks the line across re-diffs/edits). Reconciled in the same set by stable id.
    this.pending.forEach((p) =>
      specs.push({
        id: p.id,
        key: p.comment.comment,
        anchor: p.anchor,
        placement: 'below',
        build: () => buildCommentCard(p.comment.comment),
      }),
    );
    this.bands.set(specs);
  }

  private currentNewText(file: DiffFile): string {
    return this.sources.get(newKey(file.path))?.document?.getText() ?? file.newText;
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

  /** A read-only blob buffer + its own parse (the base side, and both sides when read-only). */
  private snapshotSource(text: string, path: string): SourceEntry {
    const buffer = new GtkSource.Buffer();
    buffer.setText(text, -1);
    const syntax = new DocumentSyntax(buffer);
    syntax.setLanguageForPath(path);
    return { buffer, syntax };
  }

  /** Editable new side: the shared live Document's model buffer + its own parse (no double
   *  parse). Loads from disk only if not already open (preserving an open tab's unsaved edits). */
  private acquireNewSide(file: DiffFile): SourceEntry {
    const { document } = this.registry!.acquire(file.path);
    if (!document.isLoaded) document.loadFile(file.path);
    document.syntax.setLanguageForPath(file.path);
    return { buffer: document.modelBuffer, syntax: document.syntax, document };
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
  // A `queueMicrotask`/`Promise` is WRONG here: Node drains microtasks only on a libuv turn, which
  // under node-gtk's GLib main loop can come many paints later (or not until idle), so the re-diff
  // never ran in the app — the inserted line stayed unreflowed with the caret stranded on the
  // pre-reflow row (e.g. `O` on an excerpt's first line left the caret where the leading `⋯` fold
  // marker sat). The frame clock is the only scheduler that fires under the GLib loop before paint.
  private microReDiffTickId = 0;
  private scheduleMicroReDiff(): void {
    if (this.microReDiffTickId || this.disposed) return;
    if (this.reDiffTimer) { clearTimeout(this.reDiffTimer); this.reDiffTimer = null; }
    this.microReDiffTickId = (this.editor.sourceView as any).addTickCallback(() => {
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
    const anchor = this.projection.viewToSource(caret.row, caret.column);
    const dmb = this.buildDiff();
    this.dmb = dmb;
    this.suppressReDiff = true; // retarget's view edits must not re-trigger a re-diff
    try {
      this.projectionView.retarget(dmb.items);
    } finally {
      this.suppressReDiff = false;
    }
    this.applyDecorations(dmb);
    this.lineNumbers?.setData(lineLabels(dmb.oldNums), lineLabels(dmb.newNums), gutterBg(dmb, 'old'), gutterBg(dmb, 'new'), headerRows(dmb), dmb.stagedState);
    this.installOverlays(dmb); // re-place header + gap widgets (counts/positions re-flowed)
    // retarget swapped rows but didn't repaint — re-highlight the spliced sections.
    this.editor.repaintSyntax();
    // Restore the caret to where its source position now shows (it followed the reflow).
    if (anchor.kind === 'source') {
      const pos = this.projection.sourceToView(anchor.sourceKey, anchor.row, anchor.column);
      if (pos) this.editor.model.setCursorBufferPosition(pos);
    }
    this.lastLineCount = (this.projectionView.buffer as any).getLineCount(); // reflow changed it
  }

  /** Added/removed line backgrounds from the per-row diff kinds (header/blank/gap/context get
   *  none). The view buffer's last line is unterminated, so decorations span its content. */
  private applyDecorations(dmb: DiffMultiBuffer): void {
    const buffer = this.projectionView.buffer as any;
    const lines = dmb.rowKinds.map((kind, row) => ({
      kind: kind === 'added' || kind === 'removed' ? kind : 'context',
      text: this.lineText(buffer, row),
    }));
    applyDiffDecorations(this.editor.decorations.layer('diff'), lines, /* terminated */ false);
  }

  private lineText(buffer: any, row: number): string {
    const start = asIter(buffer.getIterAtLine(row));
    const end = start.copy();
    if (!end.endsLine()) end.forwardToLineEnd();
    return buffer.getText(start, end, true);
  }

  private installNavigation(): void {
    const view = this.editor.sourceView as any;
    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number) => {
      if (keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) return false;
      if (this.editable && view.getEditable()) return false; // insert mode: Enter is a newline
      // Enter opens the comment box where commenting is enabled (an agent workbench); elsewhere it
      // keeps the original jump-to-file behaviour. `g d` always jumps.
      if (this.canComment) this.startComment();
      else this.activateRow(this.cursorRow());
      return true;
    });
    view.addController(keys);

    if (this.editable) return; // double-click word-select stays while editing
    const click = new Gtk.GestureClick();
    click.on('pressed', (nPress: number, x: number, y: number) => {
      if (nPress < 2) return;
      const by = view.windowToBufferCoords(Gtk.TextWindowType.TEXT, x, y);
      const yBuf = Array.isArray(by) ? by[by.length - 1] : y;
      const r = view.getLineAtY(yBuf);
      this.activateRow(asIter(Array.isArray(r) ? r[0] : r).getLine());
    });
    view.addController(click);
  }

  private cursorRow(): number {
    const buffer = (this.editor.sourceView as any).getBuffer();
    return asIter(buffer.getIterAtMark(buffer.getInsert())).getLine();
  }

  private activateRow(viewRow: number): void {
    const target = this.projection.viewToSource(viewRow, 0);
    if (target.kind !== 'source') return;
    const sep = target.sourceKey.indexOf(':'); // keys are `new:<path>` / `old:<path>`
    const path = sep >= 0 ? target.sourceKey.slice(sep + 1) : target.sourceKey;
    this.onActivate?.({ path, row: target.row });
  }

  /** Jump to the file/line under the cursor (the `g d` action — Enter is the comment box now). */
  openFileAtCursor(): void {
    this.activateRow(this.cursorRow());
  }

  // --- comment to agent ------------------------------------------------------

  /** Whether commenting-to-agent is enabled here — only when an `onSend` sink was wired (i.e. the
   *  diff lives in an agent's workbench). Gates the `enter` action + the `diff:*` review commands. */
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
        else this.onSend?.(formatDiffReview([comment], this.cwd ?? process.cwd()));
      },
      onCancel: () => this.closeComment(),
    });
    this.openCommentBox(box, anchorRow);
  }

  /** Re-open the comment box on an existing pending comment, prefilled — Enter updates it in place
   *  (an empty submit deletes it). */
  private editPending(p: { comment: DiffComment; anchor: BlockDecorationAnchor; id: string }): void {
    const box = new DiffCommentBox({
      reviewing: true, // a pending comment only exists in review mode
      editing: true,
      initialText: p.comment.comment,
      onStartReview: () => this.setReviewMode(true),
      onSubmit: (text) => {
        const body = text.trim();
        this.closeComment();
        if (!body) return void this.removePending(p.id); // cleared → delete
        p.comment = { ...p.comment, comment: body };
        this.installOverlays(this.dmb); // rebuild the card with the new text
        this.emitReview();
      },
      onCancel: () => this.closeComment(),
    });
    this.openCommentBox(box, this.anchorViewRow(p.anchor) ?? this.cursorRow());
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
        if (this.disposed) return void box.dispose(); // view tearing down: don't tick a dead view
        (this.editor.sourceView as any).addTickCallback(() => (box.dispose(), false));
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
    this.onSend(formatDiffReview(this.pending.map((p) => p.comment), this.cwd ?? process.cwd()));
    this.pending.length = 0;
    this.installOverlays(this.dmb); // drop the inline cards
    this.emitReview();
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
    const pos = this.projection.sourceToView(anchor.sourceKey ?? '', anchor.row, 0);
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
    const buffer = this.projectionView.buffer as any;
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
    const parts: string[] = [];
    if (news.length) parts.push(`new ${span(news)}`);
    if (olds.length) parts.push(`old ${span(olds)}`);
    // Column precision only for an explicit sub-line selection (not the cursor-widened hunk).
    if (!empty && r0 === r1) {
      const sc = range.start.column, ec = range.end.column; // 0-based; selection covers [sc, ec)
      const len = this.lineText(buffer, r0).length;
      if (sc === ec) parts.push(`col ${sc + 1}`);
      else if (!(sc === 0 && ec >= len)) parts.push(`cols ${sc + 1}-${ec}`);
    }

    // Anchor a pending-comment card at the cursor/selection line (same spot the editor box sat) by
    // SOURCE position, so it tracks the line across re-diffs/edits; fall back to a direct view row.
    const src = this.projection.viewToSource(anchorRow, 0);
    const cardAnchor: BlockDecorationAnchor =
      src.kind === 'source' ? { sourceKey: src.sourceKey, row: src.row } : { viewRow: anchorRow };

    return {
      path: hit.path,
      navLine: newStart, // always a new-side line (the working-tree file the agent opens)
      locator: parts.join(', '),
      patch,
      anchorRow,
      cardAnchor,
    };
  }

  /** The view-row range of the diff hunk at (or nearest) `row`: the contiguous run of changed
   *  (added/removed) rows around the cursor, plus a few context lines each side — bounded by the
   *  shown block (header/blank/gap rows stop the expansion). For the no-selection comment, so the
   *  agent sees a hunk with context rather than a lone line. */
  private static readonly COMMENT_CONTEXT = 3;
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
    for (let k = 0; k < ContinuousDiffView.COMMENT_CONTEXT && isReal(s - 1); k++) s--;
    for (let k = 0; k < ContinuousDiffView.COMMENT_CONTEXT && isReal(e + 1); k++) e++;
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
    this.editor.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.commentBox?.dispose(); // close the inline comment box if open (idempotent)
    this.commentBox = null;
    if (this.reDiffTimer) clearTimeout(this.reDiffTimer);
    this.reDiffTimer = null;
    if (this.microReDiffTickId) (this.editor.sourceView as any).removeTickCallback(this.microReDiffTickId);
    this.microReDiffTickId = 0;
    this.gitUnsub?.(); // stop listening for external index changes
    this.gitUnsub = undefined;
    for (const unsub of this.modifiedUnsubs) unsub(); // detach from the (possibly shared) Documents
    this.modifiedUnsubs.length = 0;
    this.pending.length = 0; // cards are torn down by bands.clear() below
    this.reviewHandlers.length = 0;
    this.bands.clear();
    this.lineNumbers?.dispose();
    // The editor owns the ProjectionView (via its MultiBufferDocument) and disposes it below.
    for (const entry of this.sources.values()) {
      // Editable new side: drop the shared ref (a file also open in a tab survives + keeps its
      // unsaved edit). Read-only / base blobs: this view owns the parse.
      if (entry.document) this.registry!.release(entry.document);
      else entry.syntax.dispose();
    }
    this.sources.clear();
    this.editor.dispose();
  }
}

/** One comment as an agent prompt: a `path:line (locator)` reference, the targeted lines as a
 *  unified-diff hunk (so old/new is explicit), then the comment text. */
function formatDiffComment(c: DiffComment, cwd: string): string {
  const rel = Path.relative(cwd, c.path);
  return [`${rel}:${c.navLine} (${c.locator})`, '', '```diff', c.patch, '```', '', c.comment].join('\n');
}

/** A review as an agent prompt: a single comment formats as itself; a batch becomes a numbered list
 *  of the same per-comment blocks under a count header. */
function formatDiffReview(comments: DiffComment[], cwd: string): string {
  if (comments.length === 1) return formatDiffComment(comments[0], cwd);
  const blocks = comments.map((c, i) => `### Comment ${i + 1}\n\n${formatDiffComment(c, cwd)}`);
  return [`Code review — ${comments.length} comments:`, '', ...blocks].join('\n\n');
}
