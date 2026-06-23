# Plan: unify editor coordinate vocabulary, make `buffer ↔ screen` real

**Spec:** [docs/text-editor/coordinates.md](docs/text-editor/coordinates.md) is
the source of truth for the `document` / `buffer` / `screen` vocabulary and the
two deliberate inversions. Read it first; this plan only sequences the work.

## Goal

One coordinate vocabulary across the editor stack, and a `buffer ↔ screen`
transform that is actually fold- (and eventually wrap-) aware instead of the
identity stubs that exist today. The vendored vim layer
(`src/ui/TextEditor/vim/*`, ported from vim-mode-plus) keeps Atom's
`buffer`/`screen` method names unchanged — the point is to make those names mean
what Atom means, not to rewrite the ported code.

## Handoff status

- **Stage 1 is DONE and merged to `master`** (rename commit `22fc09e`, merge
  `7bf6969`). It was rename-only; typecheck + the full test suite were green.
- **Next agent: start from `master`** — the work is all there. Stage 2 below is
  the main thread (behaviour-bearing, needs running the app to verify vim with
  folds); the parallel vim `as any` track is independent and lower-risk if you
  want a self-contained, fully-test-gated task instead.

## Current state (after Stage 1)

- `ViewProjection` (`src/ui/TextEditor/ViewProjection.ts`, pure, unit-tested)
  implements the real 3-space coordinate map under the **canonical** names
  `document` / `buffer` / `screen`. The `FoldHost` contract
  (`src/syntax/syntax-controller.ts`) + its `Document`/`ProjectionView` impls +
  `SyntaxController`'s internal translators all speak `document` / `screen`
  (`documentToScreen` / `screenToDocument` / `documentLineForScreenLine` / …).
- ⚠️ **Stage 2 target:** `EditorModel` / `Cursor` / `Selection` still operate
  directly on the materialized *screen* buffer and treat `screen` = `buffer` =
  identity: the `*ForScreenPosition` / `*ForScreenRow` methods clamp and return
  the same point. Correct only when no fold/wrap is active — so the vim layer
  still "ignores folds".
- Soft-wrap is real (GtkSourceView renders it; a "long-line mode" disables it)
  but lives only in pixel geometry (`gj`/`gk` via `displayLineMove`), not in the
  Point-based screen coordinates. (Stage 3.)
- Baseline is green: `pnpm run typecheck` clean, `pnpm run test` 1006 pass
  (2 pre-existing skips).

## Stage 1 — rename the projection layer to the canonical names (no behavior change) — ✅ DONE

Pure mechanical rename, gated by the test suite. Applied the map from
coordinates.md (`source`/`model` → `document`, `projection`/`proj` → `buffer`,
`view` → `screen`) to:

- `ViewProjection.ts` + `ViewProjection.test.ts`: the `Segment` fields, the three
  spaces, and the transform methods (`sourceToView`, `viewToSource`,
  `projOffsetToView`, `viewOffsetToProj`, …).
- `ProjectionView.ts` and the `FoldHost` interface + its `SyntaxController`
  implementation (`modelPointFromView`, `viewPointFromModel`,
  `modelLineForViewLine`, `viewLineForModelLine`, `modelLineText`, …).
- The prose in `docs/text-editor/multibuffer.md` and
  `docs/text-editor/folding.md` (they still say source/projection/view + model).

**Gate:** `pnpm run typecheck` + `pnpm run test` green. No behavior change — this
is rename-only; if a diff changes logic, it's wrong.

**Outcome (decisions made during the rename):**
- The class/file names `ViewProjection` / `ProjectionView` were **kept** (they
  name the substrate components; the rename targeted the coordinate *vocabulary*
  inside them — spaces, fields, transform method names — not the type names).
- `ViewProjection.ts` was made fully canonical (identifiers + prose); only GTK
  storage terms (`view buffer`, `per-view`) remain, which are correct.
- The `FoldHost` contract + its `Document`/`ProjectionView` impls + the
  `SyntaxController` internal translators are renamed; `SyntaxController`'s GTK
  widget field `this.view` and viewport-paint helpers (`paintViewLines`,
  `visibleRange`) are deliberately untouched (widget concerns, not coordinates).
- `Segment.documentKey` (was `sourceKey`) was renamed repo-wide; the block-decoration
  anchor type (`{ documentKey?, row } | { viewRow }`) inherited it. Its `{ viewRow }`
  variant (decoration layer) is out of Stage-1 scope and left as-is.
- `docs/text-editor/folding.md` has pre-existing architectural staleness
  (`forward`/`propagate`/`toModelOffset`, mark-based folds) predating the
  ViewProjection refactor — only its vocabulary + renamed-method refs were
  updated here; a full rewrite is a separate doc task.

## Stage 2 — make `EditorModel` speak `buffer`, delegate `buffer ↔ screen`

Today `EditorModel`'s screen methods are identity clamps over the view buffer.
Target: its buffer-coordinate API operates in `buffer` space, and its `screen`
methods delegate to `ViewProjection`'s `buffer ↔ screen` (fold) transform so the
distinction becomes real when a fold is active.

- Route `screenPositionForBufferPosition` / `bufferPositionForScreenPosition` /
  `screenRowForBufferRow` / `bufferRowForScreenRow` / `clipScreenPosition` /
  `screenRangeForBufferRange` / `bufferRangeForScreenRange` (and `Cursor`'s
  `getScreenPosition`/`getScreenColumn`/`setScreenPosition`) through the
  transform instead of returning identity.
- This is **behavior-bearing on the vendored vim path** (vim currently sees
  folded text). Wire the fold transform first; decide and document whether vim
  motions operate on `buffer` (unfolded, Atom-faithful) or `screen`.
- Drop the now-stale identity-era comments as they're touched (coordinates.md
  carries the explanation; keep inline notes to one line + a pointer).

**Gate:** typecheck + tests + manual vim verification with folds active
(`zc`/`zo`, motions crossing a fold, visual select over a fold).

## Stage 3 — soft-wrap into screen coordinates (later, optional)

Model wrapped display rows in `screen` space so `screen` row ≠ `buffer` row under
wrap (today wrap is pixel-only). Large; only if a feature needs Point-level wrap
awareness.

## Parallel track — finish vim `as any` removal (independent of coordinates)

~50 vim casts remain that are **not** coordinate-related and can be done anytime,
by building the missing shim functionality (not by widening to `any`):

- **Operation hierarchy** (`operation-stack.ts`, `motion.ts`): narrow with the
  existing `isOperator()`/`isMotion()`/`isTextObject()` predicates; make
  `Base.getInstance` generic so `getInstance(...).getPairInfo()` keeps its type.
- **`Selection.insertText` options**: add `{autoIndent?, autoIndentNewline?}` and
  honor it via EditorModel's existing auto-indent primitives.
- **Long tail**: `getURI()` on EditorModel (wire a `Document` reference);
  `bufferRangeForScopeAtPosition` (needs a tree-sitter scope-extent query);
  `MANAGER_REGISTRY` heterogeneous-constructor typing; `editorElement`/
  `matchScopes` DOM-ism; `pair-finder.ts` options.
