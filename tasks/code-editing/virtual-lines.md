# Virtual lines & inline virtual content

Investigation of how to show content that **isn't in the buffer** — trailing
text, full virtual lines, inline widgets — on our GtkSourceView 5.20 editor. This
is a cross-cutting capability several features want; diff is just one. All APIs
below were probed and **exist in our node-gtk build**.

> **Update — the general virtual-line / inline-widget mechanism (§2 below) is
> chosen and planned in [inline-widgets.md](inline-widgets.md).** The exact APIs
> are re-confirmed in `Gtk-4.0.gir`: `gtk_text_view_add_overlay`/`move_overlay`/
> `remove` take **buffer coordinates** (so the overlay child scrolls with the text
> natively — no manual scroll-follow), `get_iter_location` returns the anchor's
> rect in buffer coords, and `Gtk.TextTag.pixels-below-lines`/`pixels-above-lines`
> reserve the gap. First consumers: the diff fold placeholder (replacing the
> synthesized `FoldRow`) and a see-definition peek.

## Features that want it

- **LSP inlay hints** — parameter names / inferred types, mid-line and end-of-line.
- **Error lens** — the diagnostic message shown after/below the offending line.
- **Git blame** — trailing author/date per line.
- **Code lens** — a line *above* a symbol (reference count, run/debug actions).
- **Inline AI completion / ghost text** — Copilot-style preview not in the buffer.
- **Inline diff** — deleted lines (unified) and alignment fillers (side-by-side)
  *while editing the live buffer* (the read-only viewer avoids this — see diff.md).
- **Folded-region placeholder** — "… 12 lines …" on the fold header.
- **Inline images / color swatches / markdown render / expandable panels.**

## The mechanisms (probed; all available)

There is **no single "virtual line" primitive** — but the building blocks cover
the needs in tiers.

### 1. `GtkSourceAnnotations` (5.18+) — line-anchored trailing text + icon

Per-LINE annotation: a `GtkSource.Annotation` carries `line` + `description`
(text) + `icon` + `style`, and the provider has `populateHoverAsync` for hover.
Model: `view.getAnnotations().addProvider(p)`; the provider exposes
`addAnnotation`/`removeAnnotation`/`removeAll`. Renders as **end-of-line**
trailing content.

- **Fits:** error lens, git blame, simple end-of-line inlay hints — with hover.
- **Limits:** line-anchored only (no column → no true *mid-line* inlay hints);
  end-of-line slot, not a full virtual line that pushes text down; brand-new API
  (landed late 2024 — verify rendering + node-gtk provider vfunc binding in a POC).

### 2. Gap tag + overlay — the general virtual-LINE recipe

`Gtk.TextTag` exposes **`pixels-above-lines` / `pixels-below-lines` /
`pixels-inside-wrap`** — these reserve blank vertical *space* above/below a line
(no content). Fill that gap with either:

- **`view.addOverlay(child, bufX, bufY)` / `moveOverlay`** — a real widget at
  fixed *buffer* coordinates that scrolls with the text but takes no layout space
  (it sits in the reserved gap); or
- **`snapshot_layer`** custom drawing (we already do this for the diagnostic
  squiggle via a DrawingArea overlay) — draw text/lines into the gap.

So: **tag reserves the vertical space (pushing real lines apart), overlay/snapshot
renders the virtual line into it.** This is the reusable "virtual line" engine.

- **Fits:** code lens (gap above), inline expanded diagnostics, multi-line ghost
  text, live inline-diff deleted blocks, inline images/previews.
- **Limits:** you own the geometry — compute the gap's pixel rect (`getIterLocation`
  + `bufferToWindowCoords`, which our `EditorModel` pixel-geometry already wraps)
  and reposition on scroll/edit; stacking several virtuals at one spot needs care;
  no automatic invalidation.

### 3. `GtkTextChildAnchor` — inline widget that takes space

`buffer.createChildAnchor`/`insertChildAnchor` + `view.addChildAtAnchor(child,
anchor)` embeds a **real GtkWidget** inline; it occupies layout space (a tall
widget on its own line ≈ a virtual line that genuinely pushes text down) and
**consumes one buffer char** (the anchor). `insertPaintable` is the image variant.

- **Fits:** inline widgets / expandable panels / images, and synthesized virtual
  blocks in **read-only** buffers.
- **Limits:** the anchor is a real char → it perturbs offsets, save, and search.
  **Not for the live editable buffer.** Best in read-only / synthesized buffers.

### 4. Synthesized read-only buffer — for pure viewers

For a *viewer* (diff), make the virtual content real text in a throwaway buffer
and style it. Sidesteps all of the above. Only works when not editing the live
file (see [diff.md](diff.md)).

## Recommendation

Two pieces cover everything, both reusing primitives already landed
(`editor.decorations`, the pixel-geometry getters, the overlay pattern from the
squiggle layer):

1. **Use `GtkSourceAnnotations` for line-trailing text** — error lens, git blame,
   end-of-line inlay hints. Purpose-built, hover for free. Cheapest path; POC it
   first to confirm rendering + the provider binding.
   - ✅ **Built** (`src/ui/TextEditor/AnnotationController.ts`, POC
     `src/poc/annotations.ts`). Per-view (one of the things the A2 document-model
     unblocked — a shared buffer would render annotations in every view). Consumers:
     **error lens** (`DiagnosticsView`) and **end-of-line inlay hints**
     (`InlayHintController`). Concrete API: `GtkSource.Annotation.new(description, icon,
     line, style)` + a `GtkSource.AnnotationProvider` (concrete, no subclass) +
     `view.getAnnotations().addProvider()`.
   - **Findings:** (a) **render** only happens for a *populated* provider added to the
     view — mutating an already-registered provider (late `addAnnotation`) doesn't
     repaint, so the controller re-adds the provider each update. (b) **Color** comes
     from the *style scheme's* diff styles — `ERROR`→`diff:removed-line` fg,
     `WARNING`→`diff:changed-line`, `ACCENT`→`diff:added-line`, `NONE`→drawn-spaces
     color; our generated scheme now defines them (`createSourceScheme.ts`). (c)
     **Line-anchored, no column/alignment control** — and with **soft-wrap on the
     annotations right-align** to the wrap width rather than trailing immediately after
     the text (a GtkSourceView rendering behaviour, no API to change it). Mid-line /
     trail-immediately placement wants the §2 overlay recipe instead.
2. **Build a small `VirtualLineController` primitive** on the *gap-tag + overlay*
   recipe (§2): given a buffer row and a widget (or drawn content), reserve the
   gap via a `pixels-above/below` tag and position an overlay child in it,
   repositioning on scroll/edit (it can reuse `UnderlineOverlay`'s scroll-follow
   approach). This is the general capability behind code lens, ghost text, inline
   expanded diagnostics, and live inline-diff. Mid-line inlay hints (a column
   position annotations can't do) also fall here, via an overlay at the iter's
   pixel rect.
3. **`GtkTextChildAnchor`** only inside **read-only / synthesized** buffers
   (it dirties the live buffer); **synthesized buffers** stay the answer for the
   diff *viewer*.

## Risks / to verify in a POC

- `GtkSourceAnnotations` is very new (5.18); confirm it renders as expected and
  that node-gtk can drive the provider (`populateHoverAsync` vfunc).
- The gap-tag + overlay recipe needs a realized view — confirm a `pixels-above-lines`
  tag reserves a per-line gap and that an `add_overlay` child lands and scrolls
  correctly in it (geometry via the existing `pixelRectForBufferPosition`).
- Overlay repositioning cost on scroll/edit (we already do this for the squiggle
  overlay, so the pattern is proven; measure with many virtuals).

## Net

No custom widget or fork is needed: line-trailing virtual text has a native API
(`GtkSourceAnnotations`), and general virtual lines are buildable from
`pixels-above/below` tags + buffer-coordinate overlays — a small
`VirtualLineController` primitive that, like the search/decoration/buffer-only
work, sits on top of GtkSourceView rather than replacing it. Recommend a one-day
POC of both (annotations + the gap-tag overlay) before committing a feature to
either.
