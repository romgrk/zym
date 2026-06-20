/*
 * DiffMultiBufferView — a CONTINUOUS multi-file diff in one scrollable editor
 * (tasks/code-editing/multibuffer.md, Phase 3b / G5). Each changed file is a filename header
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
import { Gdk, Gtk, GtkSource, type SourceBuffer } from '../../gi.ts';
import { theme } from '../../theme/theme.ts';
import { TextEditor } from '../TextEditor/TextEditor.ts';
import { Document } from '../TextEditor/Document.ts';
import { DocumentRegistry } from '../TextEditor/DocumentRegistry.ts';
import { DocumentSyntax } from '../../syntax/DocumentSyntax.ts';
import { ProjectionView } from '../TextEditor/ProjectionView.ts';
import { ViewProjection } from '../TextEditor/ViewProjection.ts';
import { ExcerptSyntaxProjection } from './ExcerptSyntaxProjection.ts';
import { applyDiffDecorations } from '../TextEditor/applyDiffDecorations.ts';
import { CombinedDiffLineNumberGutter } from '../TextEditor/DiffLineNumberGutter.ts';
import { buildDiffMultiBuffer, type DiffFile, type DiffMultiBuffer } from './diffMultiBuffer.ts';
import { buildHeaderWidget, buildGapWidget } from './MultiBufferHeader.ts';
import type { BlockDecorationHandle } from '../TextEditor/BlockDecorations.ts';
import { buildRowMap, computeHunks, formatHunkPatch, hunkContainsBufferRow, type Hunk } from '../../util/hunkPatch.ts';
import { applyPatch, git, repoRoot, type GitDone, type GitRepo } from '../../git.ts';
import { quilx } from '../../quilx.ts';
import * as Path from 'node:path';

export interface DiffMultiBufferOptions {
  /** Changed files: base (old/HEAD) + current (new/working) content. */
  files: DiffFile[];
  cwd?: string;
  onActivate?: (location: { path: string; row: number }) => void;
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

export class DiffMultiBufferView {
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
  private headerOverlays: Array<{ handle: BlockDecorationHandle; key: string }> = [];
  private gapOverlays: Array<{ handle: BlockDecorationHandle; key: string }> = [];
  // Expand-context state: NEW-side rows the user forced visible, and a reveal-everything flag.
  // The current diff's anchors, kept for the keyboard `expandContextAtCursor`.
  private revealAll = false;
  private readonly revealedNewRows = new Set<number>();
  private gapAnchors: DiffMultiBuffer['gapAnchors'] = [];
  private headerAnchors: DiffMultiBuffer['headerAnchors'] = [];
  private readonly onActivate?: (location: { path: string; row: number }) => void;
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

  constructor(options: DiffMultiBufferOptions) {
    this.onActivate = options.onActivate;
    this.files = options.files;
    this.cwd = options.cwd;
    this.editable = !!options.editable;
    this.registry = options.documents;
    this.gitRepo = options.git;
    this.repo = options.cwd ? repoRoot(options.cwd) : null;
    if (this.editable && !this.registry) {
      throw new Error('DiffMultiBufferView: editable mode requires a DocumentRegistry');
    }

    // Resolve each side's source ONCE (live Document for the new side when editable, else a
    // disk snapshot; the old/base side is always a read-only blob), then diff + project.
    for (const file of this.files) this.ensureSources(file);
    const dmb = this.buildDiff();
    this.dmb = dmb;

    const sourceBuffers = new Map([...this.sources].map(([key, e]) => [key, e.buffer] as const));
    const syntaxMap = new Map([...this.sources].map(([key, e]) => [key, e.syntax] as const));
    this.projectionView = new ProjectionView(dmb.items, sourceBuffers);

    this.editor = new TextEditor({
      buffer: {
        readOnly: !this.editable,
        folding: false,
        syntaxProjection: new ExcerptSyntaxProjection(() => this.projection, syntaxMap),
        externalBuffer: this.projectionView.buffer,
        undoTarget: this.editable ? this.projectionView : undefined,
      },
    });
    this.root = this.editor.root;
    // Scope the expand-context keymap to this surface: `#TextEditor.diff-multibuffer` is more
    // specific than vim's `#TextEditor`, so `z o`/`z R`/`z m` bind here while `z z` (scroll) etc.
    // still fall through to vim.
    (this.editor.sourceView as any).addCssClass('diff-multibuffer');

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
    const chunk = fromTop ? rows.slice(0, DiffMultiBufferView.CHUNK) : rows.slice(-DiffMultiBufferView.CHUNK);
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
    if (!this.repo) return void quilx.notifications.addTrace('Not in a git repository');
    const ctx = this.caretFileContext();
    if (!ctx) return void quilx.notifications.addTrace('No change under the cursor');
    const { path, headLines, indexLines, worktreeLines, worktreeRow } = ctx;
    const relPath = Path.relative(this.repo, path);

    let hunk: Hunk | undefined;
    let opts: { cached: boolean; reverse?: boolean };
    if (mode === 'stage') {
      // Unstaged hunks live in the index→worktree diff; the displayed new side IS the worktree, so
      // the caret's worktree row indexes them directly.
      hunk = computeHunks(indexLines, worktreeLines).find((h) => hunkContainsBufferRow(h, worktreeRow));
      opts = { cached: true };
      if (!hunk) return void quilx.notifications.addTrace('No unstaged change under the cursor');
    } else {
      // Staged hunks live in the HEAD→index diff (index coords); map the caret's worktree row into
      // index coords to find the one under the cursor (mirrors GitGutter).
      const wToIndex = buildRowMap(worktreeLines, indexLines);
      const indexRow = wToIndex[Math.min(worktreeRow, wToIndex.length - 1)] ?? indexLines.length - 1;
      hunk = computeHunks(headLines, indexLines).find((h) => hunkContainsBufferRow(h, indexRow));
      opts = { cached: true, reverse: true };
      if (!hunk) return void quilx.notifications.addTrace('No staged change under the cursor');
    }

    const done: GitDone = (ok, _out, err) => {
      if (!ok) return void quilx.notifications.addError(`Failed to ${mode} hunk`, { detail: err.trim() });
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
    this.reconcileOverlays(
      this.headerOverlays,
      dmb.headerAnchors,
      DiffMultiBufferView.headerKey,
      (h) => h.viewRow,
      (h) => buildHeaderWidget(h.label, h.path, () => this.onActivate?.({ path: h.path, row: 0 }), h.subtitle),
      'above',
    );
    this.reconcileOverlays(
      this.gapOverlays,
      dmb.gapAnchors,
      DiffMultiBufferView.gapKey,
      (g) => g.viewRow,
      // Clicking the gap reveals a chunk of its elided lines (extends the window above it).
      (g) => buildGapWidget(g.label, () => this.revealChunk(g.revealRows, true)),
      'below',
    );
  }

  /** Reconcile one band kind (headers or gaps) against its new anchors, reusing handles in place. */
  private reconcileOverlays<A>(
    entries: Array<{ handle: BlockDecorationHandle; key: string }>,
    anchors: A[],
    keyOf: (a: A) => string,
    lineOf: (a: A) => number,
    build: (a: A) => InstanceType<typeof Gtk.Widget>,
    placement: 'above' | 'below',
  ): void {
    for (let i = 0; i < anchors.length; i++) {
      const key = keyOf(anchors[i]);
      const line = lineOf(anchors[i]);
      if (i < entries.length) {
        // Reuse: move it; swap the widget only if its content changed (else keep the live one).
        const widget = entries[i].key === key ? undefined : build(anchors[i]);
        entries[i].handle.update({ line, widget });
        entries[i].key = key;
      } else {
        entries.push({ handle: this.editor.inlineBlocks.add({ line, widget: build(anchors[i]), placement }), key });
      }
    }
    while (entries.length > anchors.length) entries.pop()!.handle.remove();
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
      this.activateRow(this.cursorRow());
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

  /** Whether any edited new-side file has unsaved changes (editable mode). */
  isModified(): boolean {
    for (const entry of this.sources.values()) if (entry.document?.isModified()) return true;
    return false;
  }

  /** Save every edited new-side file back to disk (editable mode; no-op read-only). */
  save(): void {
    for (const entry of this.sources.values()) if (entry.document?.isModified()) entry.document.save();
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
    if (this.reDiffTimer) clearTimeout(this.reDiffTimer);
    this.reDiffTimer = null;
    if (this.microReDiffTickId) (this.editor.sourceView as any).removeTickCallback(this.microReDiffTickId);
    this.microReDiffTickId = 0;
    this.gitUnsub?.(); // stop listening for external index changes
    this.gitUnsub = undefined;
    for (const unsub of this.modifiedUnsubs) unsub(); // detach from the (possibly shared) Documents
    this.modifiedUnsubs.length = 0;
    for (const { handle } of [...this.headerOverlays, ...this.gapOverlays]) handle.remove();
    this.headerOverlays = [];
    this.gapOverlays = [];
    this.lineNumbers?.dispose();
    this.projectionView.dispose();
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
