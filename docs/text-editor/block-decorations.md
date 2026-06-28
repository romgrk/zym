# Block decorations — generic primitive + declarative layer

**Goal:** block decorations (a widget shown in a reserved gap *between*
lines, with zero buffer footprint) are a first-class `TextEditor`
capability. Consumers — project search (filename header + `⋯` gap bands),
the continuous diff (headers + elision gaps), and the markdown inline-image
plugin — declare *what* to decorate and nothing else; they do not recompute
view-row anchors or re-run reconcile on every edit.

The word **"band"** is a *consumer* concept (a filename header band, a `⋯`
gap band) and must NOT appear in the generic API — the primitive and the
declarative layer speak only of "block decorations", "anchors", and "specs".

## The load-bearing fact

`src/ui/TextEditor/BlockDecorationAnchor.test.ts` pins it:

- A block decoration is anchored by a **left-gravity `GtkTextMark`** on the
  view buffer. That mark tracks **every incremental view edit on its own** —
  write-through, the reverse-sync mirror of an undo, the diff's `retarget`
  splice, **and** collapse/expand (also a `retarget` splice). The
  decoration's line needs **no re-derivation** across any of these.
- The **only** operation that drops the mark is a true `materialize` /
  `setText` — initial build, an explicit `Screen.rebuild()`, or a
  Document file-reload. That is the *lone* point a decoration must be
  re-placed from a fresh projection.

Consequence: consumers do **not** re-project decorations per edit. Doing so
re-seats the mark to a row computed from a (possibly stale) projection,
which is the class of bug that caused the `o u` header-misposition. Positions
ride the marks between explicit `set()` calls.

## Layering

```
TextEditor
├─ inlineBlocks : BlockDecorations              generic primitive — place/update/remove a widget at
│                                                a VIEW line; owns mark, space reservation, placement
│                                                & reposition timing, slot pooling, node-gtk quirks.
│                                                Used directly by the fold placeholder.
└─ blockDecorations() : BlockDecorationSet      declarative — SOURCE-anchored specs, set-reconcile by
                                                 id/key, projects anchor→view line ONCE per set(),
                                                 re-projects only on materialize. Built ON the primitive.
```

- **`BlockDecorations` (primitive) is generic.** Public surface:
  `add({ line, widget, placement, sticky?, fullWidth? }) → handle { update({line?,widget?}),
  invalidate(), remove() }`. No header/gap/key/projection/"band" concepts.
  `placement` is `'above'`/`'below'` (a blank band over/under the line, the widget
  floats in it) or `'on'` (the line is grown to the widget height and the widget
  COVERS it — the caret rests on the line). `sticky` (generic: pin to the viewport
  top when the anchor scrolls above it, re-clamped on every scroll) powers the
  diff's pinned file headers. `fullWidth` width-requests the slot to the visible
  width (re-fit on resize) so a NON-sticky band spans the row instead of hugging
  its widget's natural width — the diff's `⋯` gap bands use it (sticky bands are
  always full-width, so it's a no-op there).
  This is "whatever block decoration is in the TextEditor."
- **`BlockDecorationSet` (declarative)** is where reconcile-a-set and
  source-anchoring live — the concern that does NOT belong in the primitive.

## API

```ts
// Anchor: a SOURCE position (documentKey optional → the sole source; re-projectable across a
// materialize) OR a direct view row (for a computed surface like the diff that re-set()s itself).
type BlockDecorationAnchor = { documentKey?: string; row: number } | { viewRow: number }

interface BlockDecorationSpec {
  id: string;                       // stable identity across set() calls (reused/moved/removed by id)
  key: string;                      // content identity — rebuild the widget only when it changes
  anchor: BlockDecorationAnchor;
  placement?: 'above' | 'below';
  build: () => Gtk.Widget;
}

const decos = editor.blockDecorations();   // a fresh set, registered with the editor
decos.set(specs);                          // declarative reconcile; call only on LOGICAL-model changes
decos.clear();
```

Implementation lives in `BlockDecorationSet.ts`,
`TextEditor.blockDecorations()`, `Screen.onDidMaterialize`, and
`TextEditorSource.viewRowForSource`. Tests:
`BlockDecorationAnchor.test.ts` (mark survival), `BlockDecorationSet.test.ts`
(the layer).

Behaviour of `set(specs)`:
- reconcile by `id`: add new, remove gone, and for survivors swap the widget
  only when `key` changed (delegates to the primitive's `add` /
  `handle.update` / `handle.remove`);
- translate each `anchor → view row` via the editor's current projection
  (`viewRowForSource`, which short-circuits to `row` for identity); drop
  specs whose anchor isn't currently visible (collapsed / off-projection) —
  reconcile removes their decoration.

Between `set()` calls the editor does **nothing**: positions ride the
primitive's marks. The editor re-runs each registered set's `set(lastSpecs)`
only on a new narrow `Screen.onDidMaterialize` (initial build /
`rebuild` / reload) — the one case marks are lost.

## Who calls `set()`, and when (logical-model changes only)

- **Project search** (`SearchResultsView`): on construct + collapse/expand.
  Header anchor `(documentKey, firstSourceRow)`, gap anchor
  `(documentKey, segmentEndRow)`. The gap is anchored ABOVE the next region's
  first row (a start-anchor) so `o` on the previous region's last line rides
  it.
- **Continuous diff** (`DiffView`): on construct + each re-diff
  (its set genuinely changes — elision gaps appear/disappear). Uses
  `{viewRow}` anchors (its first row may be a phantom; it re-`set()`s per
  reDiff anyway). The `⋯` **gaps** (leading file-head gap `'above'` the first
  content row, between-window gaps `'below'`) are `fullWidth` bands (they span the
  row like the header above them, but scroll with the text); review-comment cards
  are plain bands; the per-file **headers** are `sticky` bands placed `'on'` their row
  (`placement: 'on', sticky: true`) reconciled by `StickyHeaders` — the widget
  COVERS an empty navigable header row (the caret lands on it) and pins to the
  viewport top when scrolled past — see [diff.md](diff.md).
- **Markdown images** (`imagePreview`): on construct + each re-scan that
  changes the image set. Anchor `(row)` on the sole source.

Syntax **repaint** stays each consumer's own concern (the painter needs the
fresh projection); it is independent of decorations and must not be
re-coupled to them. `isSyncPending` / `setReflowHandler` drive only that
syntax repaint (a painter concern that genuinely needs the fresh map on a
reflow), not decorations.

## Notes / risks

- The primitive self-heals position on `changed` (`scheduleReserve`) and on
  the vadjustment `changed` (`scheduleReposition`); the declarative layer
  must not duplicate that.
- `onDidMaterialize` must fire after `materialize` has run (marks already
  gone) so the re-projection reads the rebuilt buffer.
- The fold placeholder uses the primitive directly (its anchor is a view
  offset, not a source position).

## Future

- This is the clean substrate for the open **per-source decorations across
  excerpts** problem: diagnostics / inlay / code-lens can become just another
  `blockDecorations()` set.
