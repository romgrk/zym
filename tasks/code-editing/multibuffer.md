# Multibuffer (continuous multi-file diff / search, editable)

**Goal:** one editor — single cursor, continuous scroll — that shows ranges from
**many files** stitched together with filename headers, with per-file-correct
syntax highlighting and (eventually) editing that writes through to the files.
Like Zed's project-search / project-diff "multibuffer", or GitHub's "Files
changed". The forcing function is the git changes view (replacing
`GitStagingView`'s accordion, `src/ui/GitStagingView.ts`).

## Why this shape (and not a stack of editors)

Zed never concatenates text into one real buffer. It keeps N real buffers (each
with its own language/parse/LSP) and presents **excerpts** (a buffer + a range)
as one virtual coordinate space; filename headers are non-text **blocks**; the
renderer paints only the visible rows. Edits write through to the underlying
buffer. That is the design we want.

We can build the equivalent on GtkSourceView because we already have most of the
scaffolding — this is a **generalization of patterns already shipped**, not
greenfield:

- **`Document` / `DocumentRegistry`** (`src/ui/TextEditor/Document.ts`,
  `DocumentRegistry.ts`) = ref-counted real buffers, N views per Document. This is
  Zed's "real buffer behind excerpts."
- **Fold projection** (`src/syntax/syntax-controller.ts` `setProvidedFolds`,
  `TextEditor.modelLineForViewLine` / `viewLineForModelLine`) already proves the
  view `GtkSource.Buffer` is a **projection** of the model with bidirectional
  view↔model translation. A fold hides ranges of *one* Document; a multibuffer
  concatenates slices of *many*.
- **Synthesized rows** — fold placeholders (`⋯ N unchanged lines`) and
  side-by-side fillers are already real, styled buffer lines. Filename headers are
  the same trick (or `Gtk.TextChildAnchor` when they must be interactive).
- **Virtualization is not a blocker.** GtkTextView validates lines incrementally
  around the viewport on its own, and `SyntaxController.repaint()` already paints
  only `visibleRange()`. A single large projection buffer costs no more than
  opening a big file. (The old open-freeze was a *gutter forcing full validation*
  by querying every line — see the memory / `lifecycle-and-disposal.md` — already
  understood and avoidable.)

So only **two genuinely new pieces** survive, and both also improve what exists.

## New piece 1 — split SyntaxController (parse on the model)

Today `SyntaxController` is created **per view** and parses the **view buffer**
(`this.cachedText = buffer.getText(...)`), which forces the `include_hidden_chars`
hack to see folded text. Split it:

- **`DocumentSyntax` (per `Document`, shared by all N views)** — owns the
  tree-sitter `Tree`, incremental reparse on `Document.onDidChangeText`, captures,
  injection parses, and fold-region **discovery** (`walkFolds`). Pure **model**
  coordinates.
- **syntax painter (per view)** — takes model-coordinate captures and paints
  highlight tags onto *its* `GtkSource.Buffer`, viewport-bounded, translating
  model→view through *that view's* projection (folds today, excerpts later). Owns
  fold **state** (which regions are collapsed) and the provided-vs-discovered fold
  choice.

Effects:

- Folding gets **cleaner**: the parse always runs on full Document text, so
  `include_hidden_chars` goes away. Discovery = model (shared); state = per-view.
- **Keystone:** one parse, many projections — the same captures serve a full-file
  view *and* a 5-line excerpt of the same Document, because captures are in model
  coordinates and each view translates them.
- **Independently valuable, do it first:** the existing N-views-per-Document
  feature currently runs N parses + N wasm trees for the same text. The split kills
  that redundancy before multibuffer exists.

## New piece 2 — excerpt model + edit write-through

Model the projection as a list of **excerpts**, each an ordered list of
**segments**:

```
segment = { source, range, editable: boolean, kind: 'real' | 'phantom' }
```

- `source` = a parsed text unit: a `Document` (live/new side) or a parsed blob
  (old/base side). The **syntax projector** paints each segment from its source's
  own captures → per-language correct, and (for diffs) the old side parsed with the
  *same grammar* but separate content. This also fixes the current `DiffView` wart
  of parsing interleaved `+`/`−` lines as one language.
- An **excerpt coordinate map** translates view offset ↔ `(segment, sourceOffset)`.
  A sorted interval array + binary search is enough for hundreds of excerpts; only
  reach for a sum-tree at thousands.
- Gutters (line numbers, `+`/`−`) key by source row, translated per segment —
  generalize the existing `DiffGutter` / `DiffLineNumberGutter` view→model
  translation (`src/ui/TextEditor/`).

**Editable diff = the new `Document` is the substrate; the diff is a projection
over it.** Concretely:

- Context + added lines are `editable`, `real`, mapped to the new `Document` →
  write-through is just normal file editing.
- **Removed lines are real view rows tagged read-only** (`kind: 'phantom'`, mapped
  to the old blob, not editable) — *not* EOL `VirtualText` (that can't be a
  navigable standalone line). Read-only is enforced the same way edits in hidden
  fold ranges are already intercepted.
- The diff (phantom rows + backgrounds) is **re-computed on edit-idle** against the
  base blob, reusing the git gutter's buffer-vs-base `lineDiff`
  (`src/util/lineDiff.ts`). Editing stays "normal file editing"; the diff is a view
  that re-segments as you type.

This is why Phase 1 and Phase 2 share **one** substrate (segment list): Phase 1 =
all segments read-only; Phase 2 = flip new-side segments `editable` + wire
write-through + live re-diff. Phase 1 therefore does **not** reuse the old
synthesized-buffer `DiffView` — that buffer construction is what we replace.

## Phasing

- **[x] Phase 0 — SyntaxController split.** Done (branch `feat/multibuffer-phase0`).
  `DocumentSyntax` (model parse, shared) + view painter (projection-aware paint + fold
  state). No multibuffer yet; a refactor that also removes redundant per-view parses.
  See **Phase 0 — as built** below.
- **Phase 1a — multibuffer core, validated on project-wide search.** Excerpt map +
  syntax projector + filename headers + read-only single `GtkSourceView` over N
  excerpts. Simplest data (all segments `real`, one source each, no phantoms, no
  old/new) so a coordinate-map / shared-parse bug surfaces in isolation. Design the
  segment model diff-capable from day one; this just exercises the easy subset.
  (Shippable later as "editable project search".)
- **Phase 1b — read-only diff multibuffer (the deliverable).** Add old/new
  duality, phantom removed rows, diff decorations + `foldUnchanged`, the two line
  gutters. Replaces `GitStagingView`'s accordion with one continuous read-only diff.
- **Phase 2 — editable.** Flip new-side segments `editable`, write-through to the
  `Document`, live re-diff on edit. The same write-through then powers
  search-replace-all and multi-file refactors.

## Phase 0 — as built

`SyntaxController` (per `GtkSource.View`/`Buffer`) was split; the parse moved out to a new
`src/syntax/DocumentSyntax.ts` (per `Document`, shared by all its views).

- **`DocumentSyntax(sourceBuffer)`** owns the tree-sitter `Tree`, injection parsers,
  incremental reparse (debounced 60ms, driven off the source buffer's `insert-text`/
  `delete-range`/`changed`), fold-region **discovery** (`foldRanges()` →
  `computeFoldRanges`), and the tree queries (`captures(fromLine,toLine)`,
  `isInStringOrComment`/`indentLevelForRow`/`functionRangeAt`/`classRangeAt`/`tagNamesAt`/
  `captureCounts`) — **all in model coordinates**. `onDidReparse(cb)` fans out to the
  painters; `setLanguageForPath` is idempotent (a sibling view reuses the existing tree).
- **`Document`** owns one `DocumentSyntax` lazily (`get syntax()` over its headless model
  buffer) and disposes it with the document. Buffer-only / diff documents never touch it.
- **`SyntaxController`** is now the per-view *painter*: it pulls model-coord captures + fold
  ranges from a `DocumentSyntax`, translates them into its view (`viewIterForModel` /
  `modelRow`/`viewRow`/`modelPos`, all **identity unless the view has collapsed folds**),
  and paints. It keeps the per-buffer `HighlightTags`, fold/placeholder/bracket tags, the
  composite gutter, the persistent paint cache, and the per-view fold **state**.
  `TextEditor` passes `documentSyntax: this.document.syntax` for file/peek views (one parse
  for N views); buffer-only/diff panes get a **private** `DocumentSyntax` over their own
  view buffer (source == view → identity), preserving today's behavior until Phase 1b
  parses the old/new sides separately.

Translation seam: `FoldHost` gained `viewLineForModelLine`/`modelPointFromView`/
`viewPointFromModel`/`modelLineText` (all already on `Document`).

Things that **fell out** of parsing the model: folds never touch the model, so the model
tree stays valid through a fold — the `fullReparseNext` fold-drift hack and the
`include_hidden_chars` parse hack are gone (a *private* parse over a view buffer still asks
for a full reparse after a fold via `requestFullReparse()`, since that buffer did change).

Tests: `src/syntax/DocumentSyntax.test.ts` proves one parse paints N view buffers and that
an edit through one view reparses + repaints both. Full suite + `tsc` green (704 tests).

Known Phase-0 limitations (acceptable; revisit with Phase 2 correctness work):
- When a discovered fold and a collapsed fold map to the **same view line** (e.g.
  `} function f2() {` joined onto a collapsed line), the collapsed fold wins that gutter
  slot, so the second region isn't `zc`-reachable until the first unfolds. (Old code let
  the discovered one win, but the model parse now rediscovers collapsed bodies, so
  collapsed-wins is required for the chevron/state to be truthful.)
- Highlighting + tree queries under *active folds* over a shared model walk
  `Document.viewPointFromModel`; correct for whole-line folds, not stress-tested for a
  fold splitting a multi-line token. Realized-view viewport-bounded paint + scroll repaint
  are unchanged in logic but only exercised live (headless tests hit the whole-buffer path).

## Correctness notes (bank for Phase 2, not Phase 1)

- A selection or edit spanning an excerpt boundary, or landing on a phantom/
  read-only row, must clamp or reject.
- Copy should strip header rows.

## Key existing code to reuse

- Projection / translation: `src/syntax/syntax-controller.ts`
  (`setProvidedFolds`, `repaint`/`visibleRange`), `TextEditor.modelLineForViewLine`
  / `viewLineForModelLine`.
- Model: `src/ui/TextEditor/Document.ts`, `DocumentRegistry.ts`.
- Diff: `src/util/DiffModel.ts` (`computeDiff`, `foldUnchanged`,
  `diffBufferText`), `src/util/lineDiff.ts`, `src/ui/TextEditor/DiffView.ts` /
  `DiffViewer.ts` / `DiffGutter.ts` / `applyDiffDecorations.ts`.
- Consumer to replace: `src/ui/GitStagingView.ts`.
