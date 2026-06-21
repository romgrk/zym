# Multibuffer — one editable, excerpt-backed editor substrate

**End-state:** every `TextEditor` renders a *projection* over an ordered list of **excerpts**
(each a source + a range), with one cursor and continuous scroll. A normal file is the
degenerate case — one full-file excerpt. Stitched ranges from **many files** appear with
filename headers, each highlighted by its own grammar, editable, writing through to the files.
The forcing function is the multi-file diff/search surface (replacing `GitStagingView` and
powering project-wide search-replace) — like Zed's project-search / project-diff multibuffer,
but editable and per-language-correct.

Built **hard parts first**, on `GtkSourceView` (the view buffer is a *materialized projection*
of its sources, because GtkTextView needs real text). The editor has no users; the single-file
editor's behavior + the headless suite are the regression net.

Branch: `feat/multibuffer-staging` (G5 staging + G1 one-editor merge + the block-decoration
consolidation) — merges to `master`.

## Architecture (as built)

Three layers — all shipped and live:

- **Source** — a parsed text unit: a `Document` (live/new side, via `DocumentRegistry`) or a
  parsed blob (old/base side). Owns its model buffer + shared `DocumentSyntax` parse + LSP doc +
  file I/O. `Document` no longer owns view/sync/fold logic.
- **`ViewProjection`** (`src/ui/TextEditor/ViewProjection.ts`) — pure, GTK-free coordinate map
  over an ordered `Item[]` (`segment`s over sources + synthesized `block` rows). Maps
  **source `(sourceKey,row,col)` ↔ projection ↔ view**, with **folds composed as a second
  transform**. `segment = { source, range, editable, kind: 'real' | 'phantom' }`. A single
  full-file segment with no folds `isIdentity` → every translation short-circuits (zero-cost
  single-file path). Editability gate (`isViewRangeEditable`) rejects block/phantom/cross-source/
  folded ranges. No-fold **row-direct** fast path so in-place edits need no remap.
- **`ProjectionView`** (`src/ui/TextEditor/ProjectionView.ts`) — per-view materialize +
  bidirectional sync over a `ViewProjection`. Write-through (view→source, clamped to one editable
  segment), reverse-sync (source→view, incremental mirror; `retarget` = minimal-churn splice
  re-diff for computed surfaces), incremental re-segmentation (`resegment`/`adjustItems`),
  `retarget` (re-derive items + splice), and is the **`UndoTarget`** coordinating a multi-file
  edit as one transaction. `setResyncHandler` lets a computed surface (the diff) re-derive from
  scratch on a row-count reverse-sync.
- **Painter** — `SyntaxController` highlights the view buffer two ways (`paintViewLines`):
  - **single-source** (a normal file): pulls the one `DocumentSyntax`'s captures and maps them
    **through the fold map** (`viewIterForModel`/`modelLineRange`) — **fold-aware**.
  - **projection** (a multibuffer): `ExcerptSyntaxProjection.paintSlices` pulls each excerpt's
    source captures and places them with a **linear** source→view mapping (`sliceIter`) — **NOT
    fold-aware** (see the invariant below).

**Surfaces** (thin orchestrators over a normal `TextEditor` natively backed by a
`MultiBufferDocument`, so vim/search/decorations come free — UI classes carry no `MultiBuffer` in
their name; that's the model layer):
- `SearchResultsView` (project search) — `src/ui/SearchResultsView.ts` (UI lives in `src/ui/`; the
  `multibuffer/` dir is the MODEL layer only).
- `ContinuousDiffView` (git diff) — `src/ui/ContinuousDiffView.ts`;
  `buildDiffMultiBuffer` (`diffMultiBuffer.ts`, model) windows each file (context ±3, runs ≥2 elided
  to a `⋯` gap), `diffSegments.ts` does the line-diff → items (eq/ins → editable new-side, del →
  phantom old-blob rows).

## Status (G1–G11)

- **G1 — One substrate.** ✅ **Done.** Single-file + both multibuffer surfaces run on
  `ViewProjection`/`ProjectionView`, and `TextEditor` is now natively backed by a `TextEditorSource`
  (`src/ui/TextEditor/TextEditorSource.ts`): `Document` (one file/source) or `MultiBufferDocument`
  (`src/ui/multibuffer/`, N sources over one `ProjectionView`). The buffer-mode duality is gone —
  the `externalBuffer`/`syntaxProjection`/`undoTarget` injection knobs and the scratch-`Document`
  shim are deleted; a multi-source backing reports `isMultiSource` and the editor derives `embedded`
  (no own line numbers / minimap / LSP / git gutter / folding) from it. Buffer-only mode (commit
  message, diff panes, picker) stays a clean file-less `Document` + `BufferEditorOptions`
  (`src/ui/TextEditor/BufferEditor.test.ts` pins it). **By design, the one remaining painter branch
  stays:** `SyntaxController` keeps a fold-aware single-source path and a fold-naive projection
  path, because **multibuffer is folding-off** (see Invariants). Unifying them = making the
  projection painter fold-aware, the only thing gating folding-on multibuffers — deliberately
  deferred, not a loose end.
- **G2 — Editable everywhere.** ✅ single-file (identity), project search, and diff all write
  through to live `Document`s; replace-all across files is one transaction.
- **G3 — Folds are a transform.** ✅ single-file (code folding); per-excerpt collapse done as an
  item-level re-derive (G8), not a view-fold.
- **G4 — Per-source-correct.** ✅ highlighting, line-number gutters (project-search
  `SourceLineNumberGutter`; diff `CombinedDiffLineNumberGutter` — old|new in one renderer), decorations.
  *Diagnostics / LSP across excerpts = Phase 4.*
- **G5 — Continuous multi-file editable diff.** ✅ surface built + GUI-verified (write-through,
  phantom rejection, live re-diff with no flash/caret-jump, gutter alignment, expand-context
  `zo`/`zr`/`zm`). **Hunk staging ✅** (`feat/multibuffer-staging`): each file's index blob (`git
  show :p`) is read and every changed row classified staged/unstaged (the same model `GitGutter`
  uses — staged = HEAD↔index, unstaged = index↔worktree); a gutter marker bar shows it (info/blue =
  staged, warning/amber = unstaged). `space h s`/`space h u` (scoped to `#TextEditor.continuous-diff`
  so bare vim `s`/`u` stay substitute/undo) → `diff:stage-hunk`/`diff:unstage-hunk` build the hunk
  patch (`formatHunkPatch`) and `applyPatch --cached` (`--reverse` for unstage), then re-read the
  index + repaint markers (no geometry reflow — staging doesn't touch the worktree↔HEAD diff).
  Partial-file (per-hunk) staging works; external index moves refresh via `git.onChange`. Tested:
  `ContinuousDiffStaging.test.ts` (real temp-repo round-trip). **Commit ✅** — `space g c` →
  `git:start-commit` opens `.git/COMMIT_EDITMSG` in a tab (save+close commits). **`GitStagingView`
  retired ✅** — view + `openStagingView`/`stagingViews` + `git:open-staging` + the `#GitStagingView`
  keymaps deleted; `space g o` now opens the diff multibuffer (the replacement). *Remaining polish:
  hunk-level discard on the surface (whole-file discard still lives on `GitPanel`).* Also one
  deferred polish: the gutter band beside the filename
  widget can't be painted the header color (node-gtk blocks gutter background drawing) — see
  `tasks/code-editing/gutter-cell-background.md`.
- **G6 — Editable project search + replace-all.** ✅ (`space *`; `file:save` routes to the active
  multibuffer).
- **G7 — Cross-source undo/redo.** ✅ `ProjectionView` is the `UndoTarget`; re-entrant user
  actions; multi-file edit = one Ctrl-Z.
- **G8 — Multibuffer interaction.** ✅ vim works (real editor); expand-context (diff); **copy is
  clean** — headers AND gaps are now widget bands in BOTH surfaces (no block rows in any buffer; the
  search `⋯` gap stopped being buffer text), so a yank across excerpts carries only real source
  lines, with no copy-time filtering; **per-excerpt collapse** (`SearchResultsView`, `z a` toggle /
  `z M` all / `z R` none) re-derives the items so a collapsed file shows only its first source row
  (`▸` chevron) — an item-level transform, NOT a view-fold (keeps the painter fold-naive per the
  Invariant). All three band consumers (diff, search, markdown image preview) declare their header/
  gap/image bands as SOURCE-anchored block decorations via `editor.blockDecorations()` — see
  `tasks/code-editing/block-decorations.md` (generic primitive + declarative `BlockDecorationSet`).
- **G9 — Multiple diff sources.** ☐ only working-tree vs HEAD today; commit / PR / range TODO.
- **G10 — Performance.** ◐ single-file identity is zero-cost. *Viewport virtualization across many
  excerpts = TODO if profiling demands.*
- **G11 — Session persistence.** ☐ serialize/restore multibuffer tabs; also a close-confirmation
  for a file edited ONLY in a multibuffer (unsaved edits discarded on close).

## Next pickup

### ~~Task A — finish G5: staging ops on the editable diff, then retire `GitStagingView`~~ ✅ DONE

Shipped on `feat/multibuffer-staging` (see G5 above). The design question resolved to: **keep the one
worktree↔HEAD editable surface**, classify each changed row staged/unstaged against the index, and
show it with a **gutter marker bar** (info/blue = staged, warning/amber = unstaged) — not sections.
`space h s`/`space h u` stage/unstage the hunk at the caret; `space g c` commits; `GitStagingView`
is deleted (`space g o` now opens the diff multibuffer). *Only remaining bit: hunk-level discard on
the surface (whole-file discard still lives on `GitPanel`).*

### ~~Task B — merge `TextEditor` and the multibuffer surfaces into one (the G1 cleanup)~~ ✅ DONE

`TextEditor` is now backed by a `TextEditorSource` interface (`src/ui/TextEditor/TextEditorSource.ts`)
with two implementations: `Document` (one file/source) and `MultiBufferDocument`
(`src/ui/multibuffer/MultiBufferDocument.ts`, N sources over one `ProjectionView`). The surfaces pass
`source: new MultiBufferDocument(pv, painter)` and shrank to thin orchestrators. **Deleted:** the
`externalBuffer`/`syntaxProjection`/`undoTarget` knobs on `BufferEditorOptions` and the scratch-
`Document` shim. A multi-source backing reports `isMultiSource`; the editor derives `embedded`
(no own line numbers / minimap / LSP / git gutter / folding) from it, while a peek view stays
file-backed (keeps LSP + the shared parse). Buffer-only mode (commit message, diff panes, picker) is
unchanged — a file-less `Document` + the `BufferEditorOptions` presentation knobs — and pinned by
`src/ui/TextEditor/BufferEditor.test.ts`. The naming rule held throughout: UI carries no
`MultiBuffer` (`SearchResultsView`/`ContinuousDiffView`/`SourceLineNumberGutter`/`HeaderBands`;
commands `project:search-results`/`git:continuous-diff`); the model keeps it (`MultiBufferModel`,
`MultiBufferDocument`, `buildDiffMultiBuffer`, `ViewProjection`/`ProjectionView`).

*Optional remainder (deferred): fold the single-source painter into the one-segment projection case
in `SyntaxController` — a clean internal `documentSyntax`-vs-`syntaxProjection` branch, not the
duality, so low-value / high-risk to touch.*

### Backlog (after the two pickups)

- **Gutter band background** (G5 polish, blocked on node-gtk) — `tasks/code-editing/gutter-cell-background.md`.
- **G9** more diff sources (commit / PR / range); **G10** viewport virtualization (only if profiling
  demands); **G11** session persistence + a close-confirmation for a file edited ONLY in a
  multibuffer. (G8 — copy + per-excerpt collapse — is done.)

## Invariants

- **Multibuffer is folding-OFF, by design.** The projection syntax painter
  (`ExcerptSyntaxProjection`) maps each excerpt's source rows to view rows **linearly** — it does
  NOT translate through a fold map. So a multibuffer surface MUST keep code folding off, and the
  editor enforces this: a multi-source backing (`isMultiSource`) sets `folding: false` and the
  `embedded` flag (see `TextEditor`). Single-file editors fold normally — their *coordinates* go
  through the same fold-aware `ProjectionView` substrate, but their *highlighting* uses the
  separate fold-aware single-source painter path. Making the projection painter fold-aware (so a
  multibuffer could fold) is the one deferred G1 item; until then, **do not enable folding on any
  multibuffer surface** — captures would land on the wrong rows once a region collapsed.

## Gotchas worth knowing before touching this

- **Scheduling re-flow under the GLib loop.** A re-diff/re-layout that must run *after the current
  command places the caret but before paint* MUST use a **GTK tick callback** (`addTickCallback`),
  NOT `queueMicrotask`/`Promise`/`setTimeout(0)` — Node drains microtasks only on a libuv turn,
  which never happens during the GLib main loop, so a microtask-scheduled re-diff silently never
  runs in the app. (`ContinuousDiffView.scheduleMicroReDiff`.) Tests must drive a realized view +
  `GLib.MainContext.iteration(true)`, not `await`. See the `queuemicrotask-dead-under-glib-loop`
  memory. **Two timings, two tools:** *before-paint* work (a re-diff that must land in the same
  frame as the caret move) → `addTickCallback`; *after-settle* work where the view buffer is
  ALREADY correct and only a derived map must catch up (a one-frame lag is invisible) → a
  macrotask is fine, and `setTimeout` DOES fire under the GLib loop (libuv is pumped every loop
  iteration — see the `js-timers-refactor` memory). `ProjectionView.scheduleSync` (the multi-source
  reverse-sync remap/rebuild for undo + cross-view edits) is the latter: it uses `setTimeout`,
  because the reverse-sync handlers already mirrored the exact edit into the view synchronously;
  only `this.projection` (the gutter/painter coordinate map) needs to catch up. It MUST NOT be a
  `queueMicrotask` — that never fires in the app, leaving the map stale until the next edit forces a
  synchronous resegment (the "corrupts, then a later edit fixes it" symptom). Corollary: anything
  that reads the coordinate map in reaction to a buffer `changed` (the search results' SYNTAX
  repaint, which paints each view row from its projected source) must NOT run while a remap is
  pending — a reverse-sync `changed` fires *during* the mirror, when the map is still stale.
  `SearchResultsView` skips its repaint when `ProjectionView.isSyncPending()` and re-runs it from
  `setReflowHandler` (after the deferred rebuild), so the painter always reads the fresh map.
  (Header/gap *bands* don't need this — they're source-anchored block decorations that ride their
  marks; see `tasks/code-editing/block-decorations.md`.)
- **Cross-segment edits must be rejected at the FUNNEL, not in write-through.** A view range can be
  contiguous yet map to a non-contiguous source range — two regions of one file are the same source
  in different segments, with hidden rows between them. `EditorModel.setTextInBufferRange`'s
  `editableAt` gate (→ `ViewProjection.isViewRangeEditable`) requires a SINGLE SEGMENT, so such an
  edit is refused before GTK mutates the buffer. Rejecting later (in `ProjectionView.writeThrough*`)
  is too late: the `insert-text`/`delete-range` handlers are *before* handlers, so returning early
  skips the SOURCE write but GTK still applies the edit to the VIEW — view and source diverge
  (visible as a visual-`c`/`d` across two regions deleting the wrong lines).
- **Overlay bands (headers/gaps/images) are SOURCE-anchored block decorations.** Each consumer
  declares them via `editor.blockDecorations()` (a `BlockDecorationSet`) and calls `set(specs)` only
  on a logical-model change (collapse, re-diff, image re-scan) — NOT per edit. Positions then ride
  the decoration's anchor mark across every edit/undo/splice; reconcile matches by `id`, rebuilds a
  widget only when its `key` changed, and the editor re-projects only on a re-materialize. Full
  design + the mark-survival proof: `tasks/code-editing/block-decorations.md`. Headers AND gaps are
  widget bands (never buffer rows).
- **Per-row gutter alignment.** A row that carries a band ABOVE it (a filename header, or the search
  `⋯` gap — anchored above the NEXT region's first row, see below) bottom-aligns its gutter number
  (`yalign=1`) so it sits next to the text under the reserved band; a band BELOW a row top-aligns it
  (`yalign=0`). Toggled per row inside the renderer's `queryData` (the only gutter vfunc node-gtk
  invokes), via `BlockDecorations.placementAtLine`.
- **Anchor a separator band to the STABLE side.** The search `⋯` gap is anchored ABOVE the *next*
  region's first row, not below the previous region's last row. A below-anchor uses a left-gravity
  mark at the line *start*, but `o` inserts at the line *end* (after the mark), so the mark wouldn't
  ride the growth and the opened line would land below the gap. The next region's first row is stable
  content its mark tracks. (The filename header is naturally a start-anchor, so it never had this.)
- **Computed surfaces re-derive, they don't row-shift.** The diff's segment structure can't be
  maintained by row arithmetic through row-count changes that cross fragmented phantom/new
  segments; it re-derives via `setResyncHandler` → `reDiff` → `retarget`.

## Hard problems still open

- **Per-source decorations across excerpts**: diagnostics/inlay/LSP key off one Document today;
  must place through the unified map for multi-file (G4 remainder). The block-decoration substrate is
  ready: `editor.blockDecorations()` already projects SOURCE anchors (`{sourceKey,row}`) through the
  unified map, so inline diagnostics/inlay/code-lens become another channel (see block-decorations.md).
- **Viewport virtualization** across thousands of excerpts (G10) — a sum-tree coordinate map only
  if profiling demands it.
- **Gutter cell background drawing** in node-gtk (G5 polish) — blocked, see its task doc.

(Resolved, for reference: boundary-edit clamping, cross-source undo, folds-as-transform,
zero-cost single-file identity, the `Document` view/sync/fold extraction — all done.)

## Key code

- Substrate: `src/ui/TextEditor/ViewProjection.ts`, `ProjectionView.ts`; `src/syntax/
  DocumentSyntax.ts`, `SyntaxProjection.ts`, `syntax-controller.ts`; `Document.ts`,
  `DocumentRegistry.ts`.
- Surfaces (UI, `src/ui/`): `SearchResultsView.ts`, `ContinuousDiffView.ts`,
  `SourceLineNumberGutter.ts`, `HeaderBands.ts`; plus `src/ui/TextEditor/DiffLineNumberGutter.ts`,
  `applyDiffDecorations.ts`.
- Block decorations: `src/ui/TextEditor/BlockDecorations.ts` (generic primitive),
  `BlockDecorationSet.ts` (declarative source-anchored layer) — full design in `block-decorations.md`.
- Model (`src/ui/multibuffer/`): `MultiBufferModel.ts`, `MultiBufferDocument.ts`, `diffMultiBuffer.ts`,
  `diffSegments.ts`, `projectSearch.ts`, `ExcerptSyntaxProjection.ts`.
- Wiring: `src/ui/AppWindow.ts` (`openSearchResults`/`space *`, `openContinuousDiff`/
  `space g D`, `file:save` routing, `diff:expand-*`).
- Reuse: `src/util/lineDiff.ts`, `DiffModel.ts`; `src/lsp/workspaceEdit.ts`.
