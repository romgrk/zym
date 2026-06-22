# Multibuffer — one editable, excerpt-backed editor substrate

**End-state:** every `TextEditor` renders a *projection* over an ordered
list of **excerpts** (each a source + a range), with one cursor and
continuous scroll. A normal file is the degenerate case — one full-file
excerpt. Stitched ranges from **many files** appear with filename
headers, each highlighted by its own grammar, editable, writing through
to the files. The forcing function is the multi-file diff/search surface
(it replaces `GitStagingView` and powers project-wide search-replace) —
like Zed's project-search / project-diff multibuffer, but editable and
per-language-correct.

Built on `GtkSourceView`: the view buffer is a *materialized projection*
of its sources, because GtkTextView needs real text. The editor has no
users; the single-file editor's behavior + the headless suite are the
regression net.

## Architecture

Three layers:

- **Source** — a parsed text unit: a `Document` (live/new side, via
  `DocumentRegistry`) or a parsed blob (old/base side). Owns its model
  buffer + shared `DocumentSyntax` parse + LSP doc + file I/O.
- **`ViewProjection`** (`src/ui/TextEditor/ViewProjection.ts`) — pure,
  GTK-free coordinate map over an ordered `Item[]` (`segment`s over
  sources + synthesized `block` rows). Maps **source `(sourceKey,row,
  col)` ↔ projection ↔ view**, with **folds composed as a second
  transform**. `segment = { source, range, editable, kind: 'real' |
  'phantom' }`. A single full-file segment with no folds `isIdentity` →
  every translation short-circuits (zero-cost single-file path). The
  editability gate (`isViewRangeEditable`) rejects block/phantom/
  cross-source/folded ranges. A no-fold **row-direct** fast path lets
  in-place edits skip the remap.
- **`ProjectionView`** (`src/ui/TextEditor/ProjectionView.ts`) — per-view
  materialize + bidirectional sync over a `ViewProjection`. Does
  write-through (view→source, clamped to one editable segment),
  reverse-sync (source→view, incremental mirror; `retarget` =
  minimal-churn splice re-diff for computed surfaces), incremental
  re-segmentation (`resegment`/`adjustItems`), `retarget` (re-derive
  items + splice), and is the **`UndoTarget`** coordinating a multi-file
  edit as one transaction. `setResyncHandler` lets a computed surface
  (the diff) re-derive from scratch on a row-count reverse-sync.
- **Painter** — `SyntaxController` highlights the view buffer two ways
  (`paintViewLines`):
  - **single-source** (a normal file): pulls the one `DocumentSyntax`'s
    captures and maps them **through the fold map**
    (`viewIterForModel`/`modelLineRange`) — **fold-aware**.
  - **projection** (a multibuffer): `ExcerptSyntaxProjection.paintSlices`
    pulls each excerpt's source captures and places them with a
    **linear** source→view mapping (`sliceIter`) — **NOT fold-aware**
    (see the invariant below).

**Surfaces** are thin orchestrators over a normal `TextEditor` natively
backed by a `MultiBufferDocument`, so vim/search/decorations come free.
UI classes carry no `MultiBuffer` in their name; that's the model layer
(`src/ui/multibuffer/`).
- `SearchResultsView` (project search) — `src/ui/SearchResultsView.ts`.
- `DiffView` (git diff) — `src/ui/DiffView.ts`;
  `buildDiffMultiBuffer` (`diffMultiBuffer.ts`, model) windows each file
  (context ±3, runs ≥2 elided to a `⋯` gap), `diffSegments.ts` does the
  line-diff → items (eq/ins → editable new-side, del → phantom old-blob
  rows).

`TextEditor` is natively backed by a `TextEditorSource`
(`src/ui/TextEditor/TextEditorSource.ts`) with two implementations:
`Document` (one file/source) or `MultiBufferDocument`
(`src/ui/multibuffer/MultiBufferDocument.ts`, N sources over one
`ProjectionView`). A multi-source backing reports `isMultiSource`; the
editor derives `embedded` from it (no own line numbers / minimap / LSP /
git gutter / folding). A peek view stays file-backed (keeps LSP + the
shared parse). Buffer-only mode (commit message, diff panes, picker) is a
file-less `Document` + `BufferEditorOptions` presentation knobs, pinned by
`src/ui/TextEditor/BufferEditor.test.ts`.

## What ships today

Single-file editing plus both multibuffer surfaces run on the
`ViewProjection`/`ProjectionView` substrate:

- **Editable everywhere** — single-file (identity), project search, and
  diff all write through to live `Document`s; replace-all across files is
  one transaction.
- **Folds as a transform** — single-file code folding; per-excerpt
  collapse is an item-level re-derive (not a view-fold).
- **Per-source-correct** — highlighting, line-number gutters
  (project-search `SourceLineNumberGutter`; diff
  `CombinedDiffLineNumberGutter`, old|new in one renderer), decorations.
- **Continuous multi-file editable diff** — write-through, phantom
  rejection, live re-diff (no flash/caret-jump), gutter alignment,
  expand-context (`zo`/`zr`/`zm`).
  - **Hunk staging** — each file's index blob (`git show :path`) is read
    and every changed row classified staged/unstaged against the index
    (staged = HEAD↔index, unstaged = index↔worktree, the same model
    `GitGutter` uses). A gutter marker bar shows it (info/blue = staged,
    warning/amber = unstaged). `space h s`/`space h u` →
    `git:stage-hunk`/`git:unstage-hunk` (the unified hunk commands, shared
    with the editor gutter; routed here via the focus chain since this
    embedded editor registers no gutter variant, and bare vim `s`/`u` stay
    substitute/undo) build the hunk patch (`formatHunkPatch`) and
    `applyPatch --cached` (`--reverse`
    for unstage), then re-read the index + repaint markers (no geometry
    reflow — staging doesn't touch the worktree↔HEAD diff). Partial-file
    (per-hunk) staging works; external index moves refresh via
    `git.onChange`. Tested by `DiffViewStaging.test.ts` (real
    temp-repo round-trip).
  - **Commit** — `space g c` → `git:start-commit` opens
    `.git/COMMIT_EDITMSG` in a tab (save+close commits).
  - `space g o` opens the diff multibuffer (the `GitStagingView`
    replacement).
- **Editable project search + replace-all** — `space *`; `file:save`
  routes to the active multibuffer.
- **Cross-source undo/redo** — `ProjectionView` is the `UndoTarget`;
  re-entrant user actions; a multi-file edit is one Ctrl-Z.
- **Multibuffer interaction** — vim works (real editor); expand-context
  (diff); copy is clean (headers AND gaps are widget bands in both
  surfaces, never buffer rows, so a yank across excerpts carries only
  real source lines, no copy-time filtering); per-excerpt collapse
  (`SearchResultsView`, `z a` toggle / `z M` all / `z R` none) re-derives
  the items so a collapsed file shows only its first source row (`▸`
  chevron). All three band consumers (diff, search, markdown image
  preview) declare their header/gap/image bands as SOURCE-anchored block
  decorations via `editor.blockDecorations()` — see
  `docs/text-editor/block-decorations.md`.

## Remaining / planned

- **Hunk-level discard on the diff surface** (G5 polish) — whole-file
  discard still lives on `GitPanel`.
- **Gutter band background** (G5 polish, blocked on node-gtk) — the
  gutter band beside the filename widget can't be painted the header
  color (node-gtk blocks gutter background drawing). See
  `docs/text-editor/gutter-cell-background.md`.
- **G4 remainder — per-source decorations across excerpts** —
  diagnostics/inlay/LSP key off one `Document` today; they must place
  through the unified map for multi-file. The block-decoration substrate
  is ready: `editor.blockDecorations()` already projects SOURCE anchors
  (`{sourceKey,row}`) through the unified map, so inline
  diagnostics/inlay/code-lens become another channel (see
  `block-decorations.md`).
- **G9 — more diff sources** — only working-tree vs HEAD today; commit /
  PR / range are TODO.
- **G10 — viewport virtualization** across thousands of excerpts — a
  sum-tree coordinate map, only if profiling demands it. Single-file
  identity is already zero-cost.
- **G11 — session persistence** — serialize/restore multibuffer tabs;
  also a close-confirmation for a file edited ONLY in a multibuffer
  (unsaved edits are otherwise discarded on close).
- **Projection painter fold-awareness** — making
  `ExcerptSyntaxProjection` fold-aware is the one thing gating
  folding-on multibuffers. Until then multibuffer stays folding-off (see
  Invariants); deliberately deferred, not a loose end. Folding the
  single-source painter into the one-segment projection case in
  `SyntaxController` is a related, low-value/high-risk cleanup.

## Invariants

- **Multibuffer is folding-OFF, by design.** The projection syntax
  painter (`ExcerptSyntaxProjection`) maps each excerpt's source rows to
  view rows **linearly** — it does NOT translate through a fold map. So a
  multibuffer surface MUST keep code folding off, and the editor enforces
  this: a multi-source backing (`isMultiSource`) sets `folding: false`
  and the `embedded` flag. Single-file editors fold normally — their
  *coordinates* go through the same fold-aware `ProjectionView`
  substrate, but their *highlighting* uses the separate fold-aware
  single-source painter path. **Do not enable folding on any multibuffer
  surface** — captures would land on the wrong rows once a region
  collapsed.

## Gotchas (still-relevant engineering constraints)

- **Scheduling re-flow under the GLib loop.** A re-diff/re-layout that
  must run *after the current command places the caret but before paint*
  MUST use a **GTK tick callback** (`addTickCallback`), NOT
  `queueMicrotask`/`Promise`/`setTimeout(0)` — Node drains microtasks
  only on a libuv turn, which never happens during the GLib main loop, so
  a microtask-scheduled re-diff silently never runs in the app
  (`DiffView.scheduleMicroReDiff`). Tests must drive a realized
  view + `GLib.MainContext.iteration(true)`, not `await`. See the
  `queuemicrotask-dead-under-glib-loop` memory.
  - **Two timings, two tools:** *before-paint* work (a re-diff that must
    land in the same frame as the caret move) → `addTickCallback`;
    *after-settle* work where the view buffer is ALREADY correct and only
    a derived map must catch up (a one-frame lag is invisible) → a
    macrotask is fine, and `setTimeout` DOES fire under the GLib loop
    (libuv is pumped every loop iteration — see the `js-timers-refactor`
    memory). `ProjectionView.scheduleSync` (the multi-source reverse-sync
    remap/rebuild for undo + cross-view edits) is the latter: it uses
    `setTimeout`, because the reverse-sync handlers already mirrored the
    exact edit into the view synchronously; only `this.projection` (the
    gutter/painter coordinate map) needs to catch up. It MUST NOT be a
    `queueMicrotask` — that never fires in the app, leaving the map stale
    until the next edit forces a synchronous resegment.
  - Corollary: anything that reads the coordinate map in reaction to a
    buffer `changed` (the search results' SYNTAX repaint, which paints
    each view row from its projected source) must NOT run while a remap
    is pending — a reverse-sync `changed` fires *during* the mirror, when
    the map is still stale. `SearchResultsView` skips its repaint when
    `ProjectionView.isSyncPending()` and re-runs it from
    `setReflowHandler` (after the deferred rebuild). Header/gap *bands*
    don't need this — they're source-anchored block decorations that ride
    their marks (see `docs/text-editor/block-decorations.md`).
- **Cross-segment edits must be rejected at the FUNNEL, not in
  write-through.** A view range can be contiguous yet map to a
  non-contiguous source range — two regions of one file are the same
  source in different segments, with hidden rows between them.
  `EditorModel.setTextInBufferRange`'s `editableAt` gate (→
  `ViewProjection.isViewRangeEditable`) requires a SINGLE SEGMENT, so
  such an edit is refused before GTK mutates the buffer. Rejecting later
  (in `ProjectionView.writeThrough*`) is too late: the
  `insert-text`/`delete-range` handlers are *before* handlers, so
  returning early skips the SOURCE write but GTK still applies the edit to
  the VIEW — view and source diverge.
- **Overlay bands (headers/gaps/images) are SOURCE-anchored block
  decorations.** Each consumer declares them via
  `editor.blockDecorations()` (a `BlockDecorationSet`) and calls
  `set(specs)` only on a logical-model change (collapse, re-diff, image
  re-scan) — NOT per edit. Positions then ride the decoration's anchor
  mark across every edit/undo/splice; reconcile matches by `id`, rebuilds
  a widget only when its `key` changed, and the editor re-projects only on
  a re-materialize. Full design + the mark-survival proof:
  `docs/text-editor/block-decorations.md`. Headers AND gaps are widget
  bands (never buffer rows).
- **Per-row gutter alignment.** A row that carries a band ABOVE it (a
  filename header, or the search `⋯` gap — anchored above the NEXT
  region's first row) bottom-aligns its gutter number (`yalign=1`) so it
  sits next to the text under the reserved band; a band BELOW a row
  top-aligns it (`yalign=0`). Toggled per row inside the renderer's
  `queryData` (the only gutter vfunc node-gtk invokes), via
  `BlockDecorations.placementAtLine`.
- **Anchor a separator band to the STABLE side.** The search `⋯` gap is
  anchored ABOVE the *next* region's first row, not below the previous
  region's last row. A below-anchor uses a left-gravity mark at the line
  *start*, but `o` inserts at the line *end* (after the mark), so the mark
  wouldn't ride the growth and the opened line would land below the gap.
  The next region's first row is stable content its mark tracks. (The
  filename header is naturally a start-anchor, so it never had this.)
- **Computed surfaces re-derive, they don't row-shift.** The diff's
  segment structure can't be maintained by row arithmetic through
  row-count changes that cross fragmented phantom/new segments; it
  re-derives via `setResyncHandler` → `reDiff` → `retarget`.

## Key code

- Substrate: `src/ui/TextEditor/ViewProjection.ts`, `ProjectionView.ts`;
  `src/syntax/DocumentSyntax.ts`, `SyntaxProjection.ts`,
  `syntax-controller.ts`; `Document.ts`, `DocumentRegistry.ts`.
- Surfaces (UI, `src/ui/`): `SearchResultsView.ts`,
  `DiffView.ts`, `SourceLineNumberGutter.ts`, `HeaderBands.ts`;
  plus `src/ui/TextEditor/DiffLineNumberGutter.ts`,
  `applyDiffDecorations.ts`.
- Block decorations: `src/ui/TextEditor/BlockDecorations.ts` (generic
  primitive), `BlockDecorationSet.ts` (declarative source-anchored layer)
  — full design in `block-decorations.md`.
- Model (`src/ui/multibuffer/`): `MultiBufferModel.ts`,
  `MultiBufferDocument.ts`, `diffMultiBuffer.ts`, `diffSegments.ts`,
  `projectSearch.ts`, `ExcerptSyntaxProjection.ts`.
- Wiring: `src/ui/AppWindow.ts` (`openSearchResults`/`space *`,
  `openContinuousDiff`/`space g d d`, `file:save` routing,
  `diff:expand-*`); read-only commit/branch diffs in `src/ui/diffViews.ts`.
- Reuse: `src/util/lineDiff.ts`, `DiffModel.ts`;
  `src/lsp/workspaceEdit.ts`.
