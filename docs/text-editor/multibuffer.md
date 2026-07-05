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

- **Document** — a parsed text unit: a `Document` (live/new side, via
  `DocumentRegistry`) or a parsed blob (old/base side). Owns its model
  buffer + shared `DocumentSyntax` parse + LSP doc + file I/O.
- **`CoordinatesMap`** (`src/ui/TextEditor/CoordinatesMap.ts`) — pure,
  GTK-free coordinate map over an ordered `Item[]` (`segment`s over
  documents + synthesized `block` rows). Maps **document `(documentKey,row,
  col)` ↔ buffer ↔ screen** (the vocabulary of
  `docs/text-editor/coordinates.md`), with **folds composed as the
  `buffer ↔ screen` transform**. `segment = { document, range, editable,
  kind: 'real' | 'phantom' }`. A single full-file segment with no folds
  `isIdentity` → every translation short-circuits (zero-cost single-file
  path). The editability gate (`isScreenRangeEditable`) rejects block/
  phantom/cross-document/folded ranges. A no-fold **row-direct** fast path
  lets in-place edits skip the remap.
- **`Screen`** (`src/ui/TextEditor/Screen.ts`) — per-view
  materialize + bidirectional sync over a `CoordinatesMap`. Does
  write-through (screen→document, clamped to one editable segment),
  reverse-sync (document→screen, incremental mirror; `retarget` =
  minimal-churn splice re-diff for computed surfaces), incremental
  re-segmentation (`resegment`/`adjustItems`), `retarget` (re-derive
  items + splice), and is the **`UndoTarget`** coordinating a multi-file
  edit as one transaction. `setResyncHandler` lets a computed surface
  (the diff) re-derive from scratch on a row-count reverse-sync.
- **Painter** — `SyntaxController` highlights the view buffer two ways
  (`paintViewLines`):
  - **single-document** (a normal file): pulls the one `DocumentSyntax`'s
    captures and maps them **through the fold map**
    (`screenIterForDocument`/`documentLineRange`) — **fold-aware**.
  - **projection** (a multibuffer): `ExcerptSyntaxProjection.paintSlices`
    pulls each excerpt's document captures and places them with a
    **linear** document→screen mapping (`sliceIter`) — **NOT fold-aware**
    (see the invariant below).

- **Lazy syntax (generic — search *and* diff).** A broad search / large diff can
  stitch hundreds of files; parsing each is O(file), so a multibuffer reads +
  builds each source's geometry up front but **defers the tree-sitter parse**
  until the excerpt nears the viewport. The policy splits cleanly:
  - **Projection = what/how.** `ExcerptSyntaxProjection.ensureParsedForRange(from,
    to)` (a `SyntaxProjection` hook) parses, once each, the sources whose excerpts
    overlap those view rows. Each source is a `ProjectionSource` carrying its
    `DocumentSyntax` + an `ensureParsed` thunk; `SearchResultsView` / `DiffView`
    supply the thunk (`DocumentSyntax.setLanguageForPath(path, { deferParse: true })`
    — grammar selected now, the whole source parsed on the next tick). The bounded
    *head* parse used on single-file open is skipped here: excerpts are scattered
    through a file, not at its head.
  - **`TextEditor` = when.** `installLazyProjectionSyntax` (multibuffer only) drives
    `ensureParsedForRange` from the viewport — bound to vertical scroll + the
    adjustment's `changed` (size-allocate / first real viewport), throttled, plus a
    one-shot once mapped, guarded on realize (an unrealized view reports the *whole*
    buffer as visible). `ensureProjectionSyntax(from, to)` exposes it for
    pre-warming / tests.

  A just-parsed source repaints itself through the painter's `onDidReparse`
  subscription, so the initial multibuffer paint is a no-op until the first source
  parses (one tick).

**Surfaces** are thin orchestrators over a normal `TextEditor` natively
backed by a `MultiBufferDocument`, so vim/search/decorations come free.
UI classes carry no `MultiBuffer` in their name; that's the model layer
(`src/ui/multibuffer/`).
- `SearchResultsView` (project search results) — `src/ui/SearchResultsView.ts`;
  wrapped by `ProjectSearchView` (`src/ui/ProjectSearchView.ts`), which adds the
  search-entry + ripgrep-flag header and rebuilds the results on each query.
- `DiffView` (git diff) — `src/ui/DiffView.ts`;
  `buildDiffMultiBuffer` (`diffMultiBuffer.ts`, model) windows each file
  (context ±3, runs ≥2 elided to a `⋯` gap), `diffSegments.ts` does the
  line-diff → items (eq/ins → editable new-side, del → phantom old-blob
  rows).

`TextEditor` is natively backed by a `TextEditorSource`
(`src/ui/TextEditor/TextEditorSource.ts`) with two implementations:
`Document` (one file/source) or `MultiBufferDocument`
(`src/ui/multibuffer/MultiBufferDocument.ts`, N sources over one
`Screen`). A multi-source backing reports `isMultiSource`; the
editor derives `embedded` from it (no own line numbers / minimap / LSP /
git gutter / folding). A peek view stays file-backed (keeps LSP + the
shared parse). Buffer-only mode (commit message, diff panes, picker) is a
file-less `Document` + `BufferEditorOptions` presentation knobs, pinned by
`src/ui/TextEditor/BufferEditor.test.ts`.

## What ships today

Single-file editing plus both multibuffer surfaces run on the
`CoordinatesMap`/`Screen` substrate:

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
  - **Hunk staging** (LIVE diffs only — the staging surface
    `git:diff-current-changes`, flagged `live`; read-only commit/branch/file
    diffs are not live and their gutter omits this whole section) — each
    file's index blob (`git show :path`) is read and every changed row
    classified staged/unstaged against the index (staged = HEAD↔index,
    unstaged = index↔worktree, the same model `GitGutter` uses). A gutter
    marker bar shows it (info/blue = staged, warning/amber = unstaged). `space h s`/`space h u` →
    `git:hunk-stage`/`git:hunk-unstage` (the unified hunk commands, shared
    with the editor gutter; routed here via the focus chain since this
    embedded editor registers no gutter variant, and bare vim `s`/`u` stay
    substitute/undo) build the hunk patch (`formatHunkPatch`) and
    `applyPatch --cached` (`--reverse`
    for unstage), then re-read the index + repaint markers (no geometry
    reflow — staging doesn't touch the worktree↔HEAD diff). `space h r` →
    `git:hunk-revert` discards the unstaged hunk: unlike stage/unstage (which
    `git apply` the index), it restores the hunk's rows to the index version on
    the live new-side `Document` (`replaceModelLineRange`, one undo) and saves —
    so the diff, any open editor, and the LSP stay in sync (a `git apply` on disk
    would desync the in-memory Document). Partial-file (per-hunk) staging/revert
    works. On `git.onChange` the view reacts by what moved (tracked via
    `getHead()`): a mere **index move** (external `git add`/reset) only re-reads the
    index + repaints markers (no geometry reflow). A **HEAD move** (commit, amend,
    reset, checkout) **re-bases** the diff — each file's base (old) blob is
    re-fetched from the new HEAD, so a file now equal to the worktree produces no
    hunks and drops out (`buildDiffMultiBuffer` skips no-change files); committing
    every change empties the view, a partial commit leaves only the remainder.
    Tested by `DiffViewStaging.test.ts` (real temp-repo round-trip).
  - **Commit** — `space g c` → `git:start-commit` opens
    `.git/COMMIT_EDITMSG` in a tab (save+close commits).
  - `space g o` opens the diff multibuffer (the `GitStagingView`
    replacement).
- **Editable project search + replace-all** — `space p /` opens the search
  surface (`ProjectSearchView`); `space p *` seeds the word under the cursor,
  and both seed the visual selection when one exists.
  A header carries a debounced search entry, ripgrep flag controls,
  one glob field (`!` excludes), and a presets combo. Matches **stream in** and grow
  the results multibuffer in place (`SearchResultsView.setExcerpts`) rather than
  rebuilding it. See [project-search.md](project-search.md) for the shared backend,
  the quick picker, and presets.
  Ripgrep runs through the process runner (`projectSearch.ts`, see
  `docs/process-runner.md`). `file:save` routes to the active multibuffer.
- **Cross-source undo/redo** — `Screen` is the `UndoTarget`;
  re-entrant user actions; a multi-file edit is one `ctrl-z`.
- **Multibuffer interaction** — vim works (real editor); expand-context
  (diff); copy is clean (search headers + all gaps are widget bands, never
  buffer rows; the diff's headers ride an EMPTY navigable header row, so a
  yank across excerpts carries only real source lines + blank header lines,
  no copy-time filtering); per-file collapse — `SearchResultsView` (`z a`
  toggle / `z M` all / `z R` none) shows a collapsed file's first source
  row; `DiffView` (`z c`/`z o` close/open, `z a` toggle, `z r`/`z m` all,
  `z j`/`z k` next/prev, `z /` picker) folds it to just its navigable
  header row. Gaps + markdown images are SOURCE-anchored block decorations
  via `editor.blockDecorations()`; the diff's per-file headers are `sticky`
  block decorations (above + pinned) reconciled by `StickyHeaders` — see
  `docs/text-editor/block-decorations.md` and `docs/text-editor/diff.md`.

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
  (`{documentKey,row}`) through the unified map, so inline
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
  *coordinates* go through the same fold-aware `Screen`
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
    memory). `Screen.scheduleSync` (the multi-source reverse-sync
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
    `Screen.isSyncPending()` and re-runs it from
    `setReflowHandler` (after the deferred rebuild). Header/gap *bands*
    don't need this — they're source-anchored block decorations that ride
    their marks (see `docs/text-editor/block-decorations.md`).
- **Cross-segment edits must be rejected at the FUNNEL, not in
  write-through.** A screen range can be contiguous yet map to a
  non-contiguous document range — two regions of one file are the same
  document in different segments, with hidden rows between them.
  `EditorModel.setTextInBufferRange`'s `editableAt` gate (→
  `CoordinatesMap.isScreenRangeEditable`) requires a SINGLE SEGMENT, so
  such an edit is refused before GTK mutates the buffer. Rejecting later
  (in `Screen.writeThrough*`) is too late: the
  `insert-text`/`delete-range` handlers are *before* handlers, so
  returning early skips the DOCUMENT write but GTK still applies the edit to
  the view buffer — screen and document diverge.
- **Overlay bands (headers/gaps/images) are SOURCE-anchored block
  decorations.** Each consumer declares them via
  `editor.blockDecorations()` (a `BlockDecorationSet`) and calls
  `set(specs)` only on a logical-model change (collapse, re-diff, image
  re-scan) — NOT per edit. Positions then ride the decoration's anchor
  mark across every edit/undo/splice; reconcile matches by `id`, rebuilds
  a widget only when its `key` changed, and the editor re-projects only on
  a re-materialize. Full design + the mark-survival proof:
  `docs/text-editor/block-decorations.md`. Search headers AND all gaps are
  widget bands (never buffer rows); the **diff's** per-file headers instead
  are `sticky` block decorations (`StickyHeaders`) floating above an empty
  navigable header row — see `docs/text-editor/diff.md`.
- **Per-row gutter alignment.** A row that carries a band ABOVE it (a
  filename header, or the search gap band — anchored above the NEXT
  region's first row) bottom-aligns its gutter number (`yalign=1`) so it
  sits next to the text under the reserved band; a band BELOW a row
  top-aligns it (`yalign=0`). Toggled per row inside the renderer's
  `virtual_queryData` (the only gutter vfunc node-gtk invokes), via
  `BlockDecorations.placementAtLine`.
- **Anchor a separator band to the STABLE side.** The search gap band is
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

- Substrate: `src/ui/TextEditor/CoordinatesMap.ts`, `Screen.ts`;
  `src/syntax/DocumentSyntax.ts`, `SyntaxProjection.ts`,
  `syntax-controller.ts`; `Document.ts`, `DocumentRegistry.ts`.
- Surfaces (UI, `src/ui/`): `SearchResultsView.ts`, `ProjectSearchView.ts`
  (the search-entry + flags wrapper),
  `DiffView.ts`, `SourceLineNumberGutter.ts`, `HeaderBands.ts`;
  plus `src/ui/TextEditor/DiffLineNumberGutter.ts`,
  `applyDiffDecorations.ts`.
- Block decorations: `src/ui/TextEditor/BlockDecorations.ts` (generic
  primitive), `BlockDecorationSet.ts` (declarative source-anchored layer)
  — full design in `block-decorations.md`.
- Sticky headers: `src/ui/TextEditor/StickyHeaders.ts` — the reusable,
  surface-agnostic abstraction over `sticky` `BlockDecorations` (owns pinning +
  caret-follow focus + the no-cursor decoration); any multibuffer drives it via
  `editor.stickyHeaders.setHeaders` (the diff today, project-search next). See
  `diff.md`.
- Model (`src/ui/multibuffer/`): `MultiBufferModel.ts`,
  `MultiBufferDocument.ts`, `diffMultiBuffer.ts`, `diffSegments.ts`,
  `projectSearch.ts`, `ExcerptSyntaxProjection.ts`.
- Wiring: `src/ui/AppWindow.ts` (`openProjectSearch`/`space p /` +
  `space p *`, `openLiveDiff`/`space g d d`, `file:save` routing,
  `diff:expand-*`); read-only commit/branch diffs in `src/ui/diffViews.ts`.
- Reuse: `src/util/lineDiff.ts`, `applyDiffDecorations.ts`;
  `src/lsp/workspaceEdit.ts`.
