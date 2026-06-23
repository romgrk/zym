# Folding & the view-projection primitive

Single-line, **navigable** code folding — a folded `import { … } from 'x'`
reads as `import {[N]} from 'x'` on one real line whose `}`/tail you can move
the cursor over, and an `if/else if/else` folds one-per-line. Built on a
reusable **view-side text projection**: a document range is physically replaced by
a short placeholder in the *view* buffer while the headless **model** stays the
full source of truth.

This is the third virtual-content mechanism, complementing the two in
[inline-widgets.md](inline-widgets.md) (overlay block + sibling peek) and the
end-of-line annotations in [virtual-lines.md](virtual-lines.md). Use it whenever
the view must show *less* than the model on a single real line.

## Why a projection (the GtkTextView wall)

GtkTextView **cannot visually join two lines of real text across an invisible
newline**: you can hide a whole line (it collapses to zero height) but you
cannot pull real text from line N+3 up onto line N. So to render a fold as one
*navigable* line, the view's **actual text** must be that one line. We get there
without touching the file because the document-model
([text-editor.md](text-editor.md)) already separates the headless model buffer
from each view's own buffer.

Dead-ends ruled out: invisible-tag join (newline won't collapse); end-of-line
`GtkSourceAnnotations` (EOL only, right-aligns under wrap, not navigable);
`GtkTextChildAnchor` widget for the marker (a child at the line end blocks the
newline-join; a U+FFFC char is excluded from `getText` but counted by offsets →
pervasive off-by-one). The literal-text placeholder in a projected buffer avoids
all of these.

## The primitive — `Document` fold projection

`src/ui/TextEditor/Document.ts`. A **fold** collapses a document range into a short
placeholder in ONE view; folds are per-view (a split can fold what the other
shows).

```ts
const fold = doc.foldScreenRange(buffer, viewStart, viewEnd, '[3]'); // collapse → placeholder
doc.unfoldScreen(buffer, fold);                                       // restore document text
const [ps, pe] = doc.foldPlaceholderRange(buffer, fold);           // live screen offsets
```

Each fold owns four marks: `pStart/pEnd` (view, the placeholder) and
`mStart/mEnd` (model, the collapsed range). The view buffer = document text with
each fold's `[mStart,mEnd)` replaced by its placeholder.

**Invariant (the whole point):** `model == view with every placeholder
expanded`. The model never sees the placeholder, so **LSP / save / undo stay
clean**. Folding deletes+inserts in the view under `suppress` so it never
forwards to the model.

**Translation** (all walk the per-view folds; identity fast-path when none):
- `toModelOffset` / `toViewOffset` — used by `forward`/`propagate` so cross-view
  edits stay in sync (a view edit lands at the right *model* offset; a model
  edit lands at the right *view* offset). A model edit **inside** a collapsed
  range is absorbed by the fold (`editInsideFold`), not painted onto the
  placeholder.
- `documentPointFromScreen` / `screenPointFromDocument`, `documentLineForScreenLine` /
  `screenLineForDocumentLine`, `documentLineText` — for the boundaries below.

Validated headless in `Document.test.ts` (incl. a 600-edit cross-view fuzz with
a live fold that round-trips through unfold).

## Consumer 1 — code folding (`syntax/syntax-controller.ts`)

- **Fold style** is **grammar-declared** in the fold query (`folds.scm`), not
  hard-coded — so language plugins control it (see
  [language-config.md](language-config.md) → fold queries):
  - **join** (single line, the default) — a node captured `@fold` collapses
    `[afterBrace … footer's }]`; the footer joins the header. import, function,
    object, class, **standalone `if`**, final `else`/`finally`.
  - **keep-footer** (1-per-line) — a node captured **`@fold.keepFooter`**
    collapses only to the newline ending the last body line, so
    `}`/`} else {`/`} catch {` stays on its own line. The query captures the
    consequence/body block of a chained construct — an `if` that has an
    `else`/`alternative`, a `try` a `catch` follows — for every brace language
    that ships it (TS/TSX, Rust, C/C++). `computeFoldRanges` merges captures per
    start row (keep-footer wins).
- `[N]` = lines folded (span for join, hidden body lines for keep-footer).
- The placeholder carries `foldPlaceholderTag` (muted + `editable:false`).
- `activeFolds` is the live list of fold handles; `foldsByHeaderLine` (keyed by
  line) holds expanded foldable regions from the parse PLUS collapsed ones — but
  a collapsed fold **does not clobber** a foldable region sharing its line
  (`} function f2() {` joined onto a collapsed line), so the second region stays
  reachable by `zc`.
- `regionAtCursor` is **offset-precise** off `activeFolds`, so several folds on
  one line each toggle independently; the gutter chevron is line-granular (picks
  one).
- Line-number gutter renders `modelLineFor(viewLine)` (file lines, with the
  collapsed ones skipped). An open (`zo`/`za`) returns a `RevealedRange` (the
  restored body span) so the editor drops the caret on its first non-blank
  character — no selection.

## Consumer 2 — the cursor/edit/search model (`EditorModel.ts`, `FoldAccess`)

The placeholder is real view text, so the model/vim layer must treat it as
atomic — it does NOT trust GtkSourceView's view of the text:
- **Atomic single glyph** — the caret may rest *on* a marker (block cursor
  covers the whole `[N]`) but motions snap out of its interior, in the travel
  direction (`setCursorBufferPosition` + the `notify::cursor-position` hook).
- **Reveal-on-edit** — an edit spanning a placeholder (`setTextInBufferRange`)
  unfolds the touched folds first (marks preserve the range), then edits the
  real text, so deleting a selection that includes a fold deletes the folded
  lines too. Guarded so it can't infinitely recurse if nothing reveals.
- **Search over the document** — before scanning the (collapsed) view, the
  search reveals each fold whose **document content** matches
  (`revealFoldsMatching`), leaving non-matching folds closed. So `/`, the search
  bar, `*`/`#` find folded content without a blanket unfold, and never match the
  `[N]` placeholder text.
- `zc` keeps the caret unless it was inside the collapsed body.

## Boundary rule — rendering document coordinates on the projected view

**Anything that paints LSP/document-space results on the view must do TWO things**
(both no-ops without folds, via identity translation):

1. **Translate document→screen at render time** (and skip/clamp ranges inside folds),
   because screen lines/cols diverge from the file once folded.
2. **Re-render when folds toggle** — a fold open/close shifts the screen lines
   *under* already-rendered decorations, so positions go stale until re-placed.
   `SyntaxController.onFoldsChanged(cb)` fires after every fold open/close (it's
   the choke point — `toggleFold` covers commands/gutter/`za`/`zc`/search/
   edit-reveal; `unfoldAll` too). `TextEditor` subscribes and re-renders.

Today:
- `DiagnosticsView` — encodes columns off `modelLineTextForRow`, then
  `viewRangeFromModel(...)` per diagnostic (a fold-internal one lands on its
  placeholder line); re-rendered on `onFoldsChanged`.
- `InlayHintController` — translates each hint's document line to a screen line
  (injected `toViewLine`, wired to `screenLineForDocumentLine`); caches the last
  fetch (`lastHints`) so a fold toggle re-places via `rerender()` (no LSP
  round-trip).
- `GitGutter` — the change bars: diff against the **model** text (not the
  collapsed view, which yields a garbage diff), translate screen→document in
  `queryData`; the gutter re-queries on the fold toggle's `queueDraw`, so no
  subscription needed. `]h`/`[h` translate the hunk rows document→screen; hunk
  actions unfold first so view==model.
- LSP **requests** translate the other way: `lspCursor` is
  `documentPointFromScreen(...)`.

When adding a feature that renders document-space ranges (references peek, code
lens, range code-actions, etc.) apply the same `viewRangeFromModel` /
`documentPointFromScreen` **and** re-render on `onFoldsChanged` — the standing cost of
view≠model, and the easiest thing to forget.

## Reusing the projection for other inline markers

Any "show a short stand-in for a longer model span, on one real navigable line"
can reuse `foldScreenRange`/`unfoldScreen` + the `FoldAccess` atomicity, e.g.
collapsing a long string/array literal, a `// region` block, generated code, or
a redacted span. Wire a consumer that (1) decides the view range + placeholder,
(2) styles the placeholder via a tag, (3) reuses the document↔screen translation at
every document-coord boundary. Overlay/peek content that adds its *own* line still
belongs to [inline-widgets.md](inline-widgets.md); use the projection when the
view shows *less*.

## Design facts

- Keep-footer is grammar-declared via `@fold.keepFooter`; **every brace-delimited
  language plugin ships the patterns** for its chained constructs (`} else {`,
  `} catch {`, …) — see [plugin-creation.md](../plugin-creation.md). A plugin
  that omits the capture folds if/else single-line until it adds it (a query-only
  change — see language-config.md). Indentation-based languages (Python) have no
  continuation line, so keep-footer doesn't apply.
- **Nested folds** compose; folding over an already-folded region **subsumes**
  the inner fold (`Document.foldScreenRange` drops it,
  `SyntaxController.pruneDeadFolds` clears the handle, `isFoldAlive` guards the
  read paths). Covered by tests.
- New **document-coord renderers** must translate *and* re-render on
  `onFoldsChanged` (see the boundary rule).

## Remaining / planned

- **Fold persistence** across reload/reopen — folds are currently dropped
  (`setText` clears them).
- **Per-step search reveal** — search reveals folds containing a match eagerly
  (all up front); a lazy per-step reveal is possible later.
- **Per-hunk git actions on folds** — stage/unstage/revert unfold all first for
  correctness; a per-hunk view↔model translation would keep folds intact.
- Verify `editable:false` fully blocks native IM input inside a placeholder, and
  the split-view fold interactions, on a real display.
