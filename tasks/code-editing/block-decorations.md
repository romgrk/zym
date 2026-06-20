# Block decorations — generic primitive + declarative layer

**Goal:** make block decorations (a widget shown in a reserved gap *between* lines, zero buffer
footprint) a clean, first-class `TextEditor` capability, so the three consumers — project search
(filename header + `⋯` gap bands), the continuous diff (headers + elision gaps), and the markdown
inline-image plugin — declare *what* to decorate and nothing else. Today each consumer recomputes
view-row anchors and re-runs its reconcile on every edit, duplicating freshness/timing logic; that
duplicated seam is exactly where the `o u` header-misposition bug lived.

The word **"band"** is a *consumer* concept (a filename header band, a `⋯` gap band) and must NOT
appear in the generic API — the primitive and the declarative layer speak only of "block
decorations", "anchors", and "specs".

## The load-bearing fact (verified)

`src/ui/TextEditor/BlockDecorationAnchor.test.ts` pins it:

- A block decoration is anchored by a **left-gravity `GtkTextMark`** on the view buffer. That mark
  tracks **every incremental view edit on its own** — write-through, the reverse-sync mirror of an
  undo, the diff's `retarget` splice, **and** collapse/expand (also a `retarget` splice). The
  decoration's line needs **no re-derivation** across any of these.
- The **only** operation that drops the mark is a true `materialize`/`setText` — initial build, an
  explicit `ProjectionView.rebuild()`, or a Document file-reload. That is the *lone* point a
  decoration must be re-placed from a fresh projection.

Consequence: the per-edit `installBands` re-projection in the surfaces is unnecessary, and (for
search) it *caused* the `o u` bug by re-seating the mark to a row computed from a stale projection.
The refactor therefore **removes** that path (and the `isSyncPending` / `setReflowHandler` band
plumbing added to work around it), rather than orchestrating it.

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

- **`BlockDecorations` (primitive) stays generic.** Public surface: `add({ line, widget, placement })
  → handle { update({line?,widget?}), invalidate(), remove() }`. No header/gap/key/projection/"band"
  concepts. This is "whatever block decoration is in the TextEditor."
- **`BlockDecorationSet` (declarative)** is where reconcile-a-set and source-anchoring live — the
  concern that does NOT belong in the primitive. It replaces today's `BlockBandSet` (which moves out
  of `BlockDecorations.ts`; the `bands()` factory and the "band" naming are deleted).

## API

> **Status: DONE.** Layer + plumbing in `BlockDecorationSet.ts` / `TextEditor.blockDecorations()` /
> `ProjectionView.onDidMaterialize` / `TextEditorSource.viewRowForSource`; all three consumers
> migrated; `BlockBandSet`/`bands()` deleted. Tests: `BlockDecorationAnchor.test.ts` (mark survival),
> `BlockDecorationSet.test.ts` (the layer). Suite green (861).

```ts
// Anchor: a SOURCE position (sourceKey optional → the sole source; re-projectable across a
// materialize) OR a direct view row (for a computed surface like the diff that re-set()s itself).
type BlockDecorationAnchor = { sourceKey?: string; row: number } | { viewRow: number }

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

Behaviour of `set(specs)`:
- reconcile by `id`: add new, remove gone, and for survivors swap the widget only when `key` changed
  (delegates to the primitive's `add`/`handle.update`/`handle.remove`);
- translate each `anchor → view row` via the editor's current projection (`viewRowForSource`, which
  short-circuits to `row` for identity); drop specs whose anchor isn't currently visible
  (collapsed / off-projection) — reconcile removes their decoration.

Between `set()` calls the editor does **nothing**: positions ride the primitive's marks. The editor
re-runs each registered set's `set(lastSpecs)` only on a new narrow `ProjectionView.onDidMaterialize`
(initial build / `rebuild` / reload) — the one case marks are lost.

## Who calls `set()`, and when (logical-model changes only)

- **Project search** (`SearchResultsView`): on construct + collapse/expand. Header anchor
  `(sourceKey, firstSourceRow)`, gap anchor `(sourceKey, segmentEndRow)`. Delete the
  `onDidChangeText`→`installBands`, the `isSyncPending` guard, and `setReflowHandler`.
- **Continuous diff** (`ContinuousDiffView`): on construct + each re-diff (its set genuinely changes —
  elision gaps appear/disappear). Anchors as source rows; drop the per-edit band re-placement and the
  view-row computation in `installOverlays`.
- **Markdown images** (`imagePreview`): on construct + each re-scan that changes the image set.
  Anchor `(row)` on the sole source. Drop the manual reconcile/timing.

Syntax **repaint** stays each consumer's own concern (the painter needs the fresh projection); it is
independent of decorations and must not be re-coupled to them.

## Steps (all DONE — suite green at each)

1. ✅ New `BlockDecorationSet` (source anchor OR `{viewRow}`, no "band"); `ProjectionView.onDidMaterialize`;
   `TextEditorSource.viewRowForSource` (Document = fold-aware identity, MultiBufferDocument = projection);
   `TextEditor.blockDecorations()` registers the set + re-projects on materialize; `handle.line()`.
   Tests: `BlockDecorationSet.test.ts`, `BlockDecorationAnchor.test.ts`.
2. ✅ **search** — source-anchored header/gap; deleted the per-edit `installBands`. (Gap anchored ABOVE
   the next region's first row, a start-anchor, so `o` on the previous region's last line rides it.)
3. ✅ **diff** — `{viewRow}` anchors (its first row may be a phantom; it re-`set()`s per reDiff anyway).
4. ✅ **markdown** — `{row}` on the sole source (also fixed a latent fold bug: it used a model row as a
   view row).
5. ✅ Deleted `BlockBandSet`/`BlockBandSpec`/`bands()`; updated the multibuffer gotchas.
   *Deviation:* `isSyncPending`/`setReflowHandler` are KEPT — they now drive only the SYNTAX repaint
   (a painter concern that genuinely needs the fresh map on a reflow), not bands. Documented as such.

## Notes / risks

- The primitive already self-heals position on `changed` (`scheduleReserve`) and on the vadjustment
  `changed` (`scheduleReposition`); the declarative layer must not duplicate that.
- `onDidMaterialize` must fire after `materialize` has run (marks already gone) so the re-projection
  reads the rebuilt buffer.
- Fold placeholder keeps using the primitive directly (its anchor is a view offset, not a source
  position) — not in scope.
- This is the clean substrate for the open **per-source decorations across excerpts** problem
  (diagnostics / inlay / code-lens become just another `blockDecorations()` set later).
