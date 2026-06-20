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

Branch: `feat/multibuffer-phase0`.

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
- **Painter** — `SyntaxController` paints the view buffer from each segment's source
  `DocumentSyntax` captures through a pluggable `SyntaxProjection` (identity for single-file,
  `ExcerptSyntaxProjection` for multibuffer).

**Surfaces** (real `TextEditor`s over a `ProjectionView`, so vim/search/decorations come free):
- `MultiBufferView` (project search) — `src/ui/multibuffer/MultiBufferView.ts`.
- `DiffMultiBufferView` (git diff) — `src/ui/multibuffer/DiffMultiBufferView.ts`;
  `buildDiffMultiBuffer` (`diffMultiBuffer.ts`) windows each file (context ±3, runs ≥2 elided to a
  `⋯` gap), `diffSegments.ts` does the line-diff → items (eq/ins → editable new-side, del → phantom
  old-blob rows).

## Status (G1–G11)

- **G1 — One substrate.** ✅ single-file + both multibuffer surfaces run on `ViewProjection`/
  `ProjectionView`. *Remaining:* delete the `TextEditor` buffer-mode / `syntaxProjection` duality
  (multibuffer still enters via `buffer.externalBuffer`); fold single-source painter into the
  one-segment case.
- **G2 — Editable everywhere.** ✅ single-file (identity), project search, and diff all write
  through to live `Document`s; replace-all across files is one transaction.
- **G3 — Folds are a transform.** ✅ single-file. *Per-excerpt collapse = Phase 4.*
- **G4 — Per-source-correct.** ✅ highlighting, line-number gutters (project-search
  `MultiBufferGutter`; diff `CombinedDiffLineNumberGutter` — old|new in one renderer), decorations.
  *Diagnostics / LSP across excerpts = Phase 4.*
- **G5 — Continuous multi-file editable diff.** ✅ surface built + GUI-verified (write-through,
  phantom rejection, live re-diff with no flash/caret-jump, gutter alignment, expand-context
  `zo`/`zR`/`zm`). **Hunk staging ✅** (`feat/multibuffer-staging`): each file's index blob (`git
  show :p`) is read and every changed row classified staged/unstaged (the same model `GitGutter`
  uses — staged = HEAD↔index, unstaged = index↔worktree); a gutter marker bar shows it (info/blue =
  staged, warning/amber = unstaged). `space h s`/`space h u` (scoped to `#TextEditor.diff-multibuffer`
  so bare vim `s`/`u` stay substitute/undo) → `diff:stage-hunk`/`diff:unstage-hunk` build the hunk
  patch (`formatHunkPatch`) and `applyPatch --cached` (`--reverse` for unstage), then re-read the
  index + repaint markers (no geometry reflow — staging doesn't touch the worktree↔HEAD diff).
  Partial-file (per-hunk) staging works; external index moves refresh via `git.onChange`. Tested:
  `DiffMultiBufferStaging.test.ts` (real temp-repo round-trip). **Commit ✅** — `space g c` →
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
- **G8 — Multibuffer interaction.** ◐ vim works (real editor); expand-context done. *Remaining:*
  copy strips header/gap rows; per-excerpt collapse.
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

### Task B — merge `TextEditor` and `MultiBufferView` into one (the G1 cleanup)

Today `MultiBufferView` / `DiffMultiBufferView` **wrap** a `TextEditor` in a special **buffer mode**
(`BufferEditorOptions`: `externalBuffer` = the `ProjectionView` buffer, `syntaxProjection`,
`undoTarget`), and that `TextEditor` still constructs a **throwaway scratch `Document` shim** whose
translation methods just return identity. That duality (a "normal-file editor" path vs a
"buffer-mode/external-buffer" path) is the last thing standing between us and full **G1**.

- **Goal:** one editor. Make `TextEditor` natively backed by a `ProjectionView` over N sources as a
  first-class case (a single file = one full-file excerpt — already true at the substrate level via
  `ProjectionView`/`ViewProjection`; make it true at the `TextEditor` seam too). Then
  `MultiBufferView`/`DiffMultiBufferView` shrink to thin orchestrators (build the `Item[]`, apply
  decorations/overlays/gutter, wire navigation) over a normal editor.
- **Delete:** the `externalBuffer` / `syntaxProjection` / buffer-mode branches in
  `TextEditor`/`BufferEditorOptions`, and the scratch-`Document` shim; fold the single-source
  painter path in `SyntaxController` into the one-segment projection case.
- **Care:** the single-file editor + the full test suite (~830) are the regression invariant — this
  is a **seam refactor, not new mechanism** (the projection substrate is already shared), so do it
  incrementally and keep the suite green at each step. This is hard-problem #7 (`Document` refactor)
  finishing.

### Backlog (after the two pickups)

- **Gutter band background** (G5 polish, blocked on node-gtk) — `tasks/code-editing/gutter-cell-background.md`.
- **G8** copy-strips-header/gap rows + per-excerpt collapse; **G9** more diff sources (commit / PR /
  range); **G10** viewport virtualization (only if profiling demands); **G11** session persistence +
  a close-confirmation for a file edited ONLY in a multibuffer.

## Gotchas worth knowing before touching this

- **Scheduling re-flow under the GLib loop.** A re-diff/re-layout that must run *after the current
  command places the caret but before paint* MUST use a **GTK tick callback** (`addTickCallback`),
  NOT `queueMicrotask`/`Promise`/`setTimeout(0)` — Node drains microtasks only on a libuv turn,
  which never happens during the GLib main loop, so a microtask-scheduled re-diff silently never
  runs in the app. (`DiffMultiBufferView.scheduleMicroReDiff`.) Tests must drive a realized view +
  `GLib.MainContext.iteration(true)`, not `await`. See the `queuemicrotask-dead-under-glib-loop`
  memory.
- **Overlay bands (headers/gaps) must be reconciled in place, not torn down.** Removing +
  re-adding a `BlockDecoration` collapses its reserved band and re-expands it a frame later
  (flicker + text jump). `DiffMultiBufferView.installOverlays` reuses handles via
  `BlockDecorations.handle.update({ line?, widget? })`.
- **Per-row gutter alignment.** An excerpt's first row carries a header band ABOVE it, so its
  gutter number must bottom-align (`yalign=1`); rows with a `⋯` gap band BELOW stay top-aligned.
  Toggled per row inside the renderer's `queryData` (the only gutter vfunc node-gtk invokes).
- **Computed surfaces re-derive, they don't row-shift.** The diff's segment structure can't be
  maintained by row arithmetic through row-count changes that cross fragmented phantom/new
  segments; it re-derives via `setResyncHandler` → `reDiff` → `retarget`.

## Hard problems still open

- **Per-excerpt collapse** as another fold-like transform (G8).
- **Per-source decorations across excerpts**: diagnostics/inlay/LSP key off one Document today;
  must place through the unified map for multi-file (G4 remainder).
- **Viewport virtualization** across thousands of excerpts (G10) — a sum-tree coordinate map only
  if profiling demands it.
- **Gutter cell background drawing** in node-gtk (G5 polish) — blocked, see its task doc.

(Resolved, for reference: boundary-edit clamping, cross-source undo, folds-as-transform,
zero-cost single-file identity, the `Document` view/sync/fold extraction — all done.)

## Key code

- Substrate: `src/ui/TextEditor/ViewProjection.ts`, `ProjectionView.ts`; `src/syntax/
  DocumentSyntax.ts`, `SyntaxProjection.ts`, `syntax-controller.ts`; `Document.ts`,
  `DocumentRegistry.ts`.
- Surfaces: `src/ui/multibuffer/` (`MultiBufferView.ts`, `DiffMultiBufferView.ts`,
  `MultiBufferModel.ts`, `diffMultiBuffer.ts`, `diffSegments.ts`, `projectSearch.ts`,
  `MultiBufferGutter.ts`, `MultiBufferHeader.ts`); `src/ui/TextEditor/DiffLineNumberGutter.ts`,
  `BlockDecorations.ts`, `applyDiffDecorations.ts`.
- Wiring: `src/ui/AppWindow.ts` (`openSearchMultibuffer`/`space *`, `openDiffMultibuffer`/
  `space g D`, `file:save` routing, `diff:expand-*`).
- To replace: `src/ui/GitStagingView.ts`.
- Reuse: `src/util/lineDiff.ts`, `DiffModel.ts`; `src/lsp/workspaceEdit.ts`.
