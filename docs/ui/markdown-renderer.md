# Markdown renderer (native render-node widget)

`MarkdownRenderer` (`src/ui/markdown/MarkdownRenderer.ts`) is a `Gtk.Widget`
subclass that draws an entire markdown document by appending GSK render nodes in
its `snapshot` vfunc — no child widgets, no `Gtk.DrawingArea`/Cairo draw func.

## Why it exists

The older `MarkdownView` (`src/ui/markdown/MarkdownView.ts`) builds a document out
of many `Gtk.Label`s. GTK can't select across separate widgets, so each label is a
selection "island" — you can't drag-select from a heading, through a code block,
into a table. `MarkdownRenderer` makes the whole document **one** widget, so
selection, copy, and link hit-testing span every block uniformly. Use it wherever
unified selection across mixed markdown matters; `MarkdownView` remains fine for
simple, non-selectable prose.

## Pipeline

```
markdown ──buildBlocks──▶ MdBlock[]            (model — markdownModel.ts)
        ──relayout(w)──▶ positioned Pango layouts + fills/rules   (geometry)
        ──snapshot()───▶ Gsk nodes: appendColor + appendLayout    (paint)
```

- **Model** (`markdownModel.ts`): parses with `marked`'s lexer (its token AST, not
  its HTML) and FLATTENS nesting (lists, blockquotes) into a linear `MdBlock[]`,
  each block carrying an `indent` level and a `quotes` id path (the enclosing
  blockquote ids, outermost first). Each blockquote occurrence gets a UNIQUE id, so
  the renderer draws ONE continuous bar per quote and never merges two adjacent
  quotes. Every selectable text run is one `MdSegment` with three parallel views of
  the same content: `markup` (what Pango renders), `plain` (the visible text —
  EXACTLY the laid-out layout's text, so Pango byte offsets map back into it), and
  `links` (clickable `[start,end)` byte ranges). Images render as a muted alt-text
  placeholder (v1). No HTML is supported.
- **Blockquotes** render as one visual box: `quoteGroups()` gives each quote's
  `[first,last]` block range, and `relayout` opens the box at the first block and
  draws a single continuous bar (spanning the inter-block gaps) when it closes at
  the last, with code-block padding inside (`QUOTE_PAD`) and margin outside
  (`QUOTE_MARGIN_*`). The first/last inner block's own outer margin is suppressed so
  the padding governs the box edges. The box gets a faint rounded background
  (`view.fg` @ 0.15, `BLOCK_RADIUS` corners — same radius as code) **pushed at
  group-open** so it sits behind inner content fills (e.g. a code block inside the
  quote); its height is filled in at close. The bar is inset by `BLOCK_RADIUS` to
  clear the rounded corners.
- **Font**: the widget carries a `.MarkdownRenderer` class with one rule —
  `font-size: var(--t-font-ui-size-large)` (`addStyles` in the module) — so the
  document reads at the large UI size; `createPangoLayout` inherits it and headings
  scale relative to it. That `--t-font-*` var is published by the font store on the
  `.AppWindow` **class** (`src/ui/AppWindow.ts`), so an ancestor must carry that
  class (the real app does; POCs must `addCssClass('AppWindow')`, not just
  `setName`, or the var won't resolve). Monospace runs (inline code + code blocks)
  render at a Pango `size` percentage **detected at runtime** by `monoSizeAttr()`:
  it measures each face's inked x-height (apparent SIZE, height of `x`) AND the inked
  width of `|` (≈ stem thickness = apparent WEIGHT), and scales the mono by the
  geometric mean of the two ratios. Folding weight in shrinks a heavier monospace
  more than x-height alone (`font-size-adjust`) would — for Adwaita Sans / JetBrains
  Mono that's ~87% vs ~94% from x-height only. Parameter-free, adapts to ANY pairing,
  memoized per `uiFamily|monospaceFamily` (recomputes on font change, next render).
- **Layout** is height-for-width: `getRequestMode` returns `HEIGHT_FOR_WIDTH`,
  `measure` lays the document out at the proposed width and returns the height, and
  geometry is recomputed lazily whenever the allocated width changes. Each block
  becomes one positioned `Pango.Layout` (`createPangoLayout`, so it inherits the
  widget's CSS font); tables compute a column grid; code/quote/table decorations
  become solid `Fill`s.
- **Paint** (`snapshot`): `appendColor` for fills (code + blockquote backgrounds via
  `pushRoundedClip`), rules (hr, table borders, quote bars) and the selection
  highlight, then `appendLayout` per segment for the text. Fills paint before rules,
  so the quote bar/border sit on top of the quote tint.

## Selection / input

Selection-only (no caret), per the design scope: drag-select across blocks,
double-click word, triple-click block, `Ctrl+A` select-all, `Ctrl+C` copy, link
click + hover pointer. Carets are `{seg, byte}` (a Pango UTF-8 byte offset into a
segment). The selection MODEL is independent of its highlight geometry — if copy
works but nothing paints, the bug is in the geometry, not the model.

Highlight rectangles are reconstructed per visual line from `index_to_pos` (NOT
`pango_layout_line_get_x_ranges` — node-gtk mis-marshals its caller-allocated
`int**`/`n_ranges` out-param and returns a single value, so nothing draws). For a
line whose selection runs to the line end, the right edge is the line's
alignment-aware left edge (`index_to_pos(lineStart).x`) plus `line.getExtents()`
logical width — because `getExtents().x` drops the alignment offset that
`index_to_pos` includes, so mixing the two mispositions center/right-aligned table
cells. Exact for LTR; bidi/RTL lines collapse to one bounding rect (good enough for v1).
Input uses `Gtk.GestureClick` (press → anchor + double/triple-click word/block
select; release → link) + `Gtk.GestureDrag` (`drag-update` → extend head) +
`EventControllerMotion` (hover cursor only) + `EventControllerKey`, each attached
through the `CompositeDisposable` (see
[lifecycle-and-disposal.md](../lifecycle-and-disposal.md)). The drag MUST be a real
`GestureDrag`: a bare `EventControllerMotion` gated on a press flag delivers motion
only sparsely under a button grab, so the selection stutters and skips positions —
`GestureDrag.drag-update` fires per motion event during the hold (the same
GestureClick + GestureDrag pairing GtkText/GtkLabel use).

## node-gtk gotchas (load-bearing)

- **vfunc names**: `registerClass` maps a method to a vfunc by `snake_case(name)`.
  So `snapshot`→`snapshot`, `measure`→`measure`, `getRequestMode`→`get_request_mode`.
- **`measure` returns a tuple**: node-gtk marshals a void vfunc's out-params from
  the JS return value, so `measure` returns `[min, natural, minBaseline, natBaseline]`
  (use `-1` for baselines). This already matches the generated `measure` typing.
- **Don't override `size_allocate`**: its vfunc signature `(width, height, baseline)`
  collides with the public `sizeAllocate(Gdk.Rectangle, baseline)` TS typing. We
  skip it and re-lay-out lazily on width change in `measure`/`snapshot` instead.
- **Teardown is `teardown()`, not `dispose()`**: `dispose` snake-cases onto the
  `GObject::dispose` vfunc, which we must not shadow.
- **Constructor + registration order**: state is initialised in a normal
  constructor (node-gtk subclass constructors work — verified; see node-gtk#457).
  But `registerClass` must run ONCE before the first `new` — instantiating an
  *unregistered* GObject subclass aborts the process — so the
  `createMarkdownRenderer()` factory registers on first use, and must therefore run
  **after** GTK init (import the module from inside `activate`/after `startLoop`).
- GTK enum types aren't referenceable through the node-gtk value import, so enum
  params are typed `number` (method params are bivariant, so the override still
  matches) and enum-returning vfuncs let TS infer the return.

## Try it

`pnpm run poc:mdwidget [file.md]` (`src/poc/markdown-widget.ts`) renders a
kitchen-sink fixture in a scrolled window; drag across blocks, double/triple-click,
`Ctrl+A`/`Ctrl+C`, click links.

## Not done yet

Caret + keyboard cursor navigation, real image decoding (alt-text only today),
live font/theme re-layout, and adopting the widget in the agent conversation UI.
