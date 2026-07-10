# Inline widgets (block decorations & peek)

Three built primitives for showing real content between buffer lines that
is not in the buffer — a label, an image, or a full nested widget (e.g. a
see-definition peek that inlines another `TextEditor` below a line). They
are the "proper" virtual-line mechanism the
[virtual-lines](virtual-lines.md) investigation recommended.

- **`BlockDecorations`** (`editor.inlineBlocks`) — a non-interactive /
  click-only widget in a reserved gap below/above a line, parented to the
  **text window** so it scrolls natively. Zero buffer footprint. The only
  consumer today is the markdown image preview.
- **`Peek`** (`editor.showPeek`) — a **focusable** card (a nested
  `TextEditor`) in a reserved gap, parented to the editor's **sibling**
  `Gtk.Overlay` so it can take keyboard input. Drives see-definition.

> Note: these primitives *add* content (a widget/line not in the buffer).
> To show *less* than the model on one real navigable line — single-line
> code folding, including the diff viewer's `⋯ N unchanged lines`
> placeholder — use the view-side text **projection** in
> [folding.md](folding.md) instead.

## The mechanism (APIs confirmed in our build)

Present in this node-gtk/GTK4 build (probed in `Gtk-4.0.gir`):

- **`gtk_text_view_add_overlay(child, xpos, ypos)`** / **`move_overlay`**
  / **`remove`** — place a real widget at a **fixed buffer coordinate** in
  the text window. Because it lives in the text window, **it scrolls with
  the text for free** — we do *not* reposition on scroll (unlike the
  diagnostic squiggle, a `Gtk.Fixed` overlay we scroll-follow manually).
- **`Gtk.TextTag.pixels-below-lines` / `pixels-above-lines` /
  `pixels-inside-wrap`** — reserve a blank vertical *band* below/above a
  line (pushes real lines apart).
- **`gtk_text_view_get_iter_location(iter)`** → the line's rect **in
  buffer coordinates** (so positioning the overlay needs no window
  conversion); `get_line_yrange`, `get_visible_rect`,
  `buffer_to_window_coords` available if window coords are ever needed.

Recipe: **the tag reserves the gap, the overlay child fills it at buffer
coords, scrolling is automatic.** The only moving part is keeping the gap
height equal to the child's height and repositioning when the buffer
changes *above* the anchor.

### Placement strategies

There are two placement strategies, chosen by whether the content needs
keyboard focus:

1. **Non-interactive / click-only content → `add_overlay`** (text-window
   child). Image previews, ghost text, code-lens buttons. This is
   `BlockDecorations`.
2. **Focusable / text-input content (see-definition peek) → gap-tag + a
   *sibling* overlay**, i.e. the widget goes in the editor's
   `Gtk.Overlay`/`Gtk.Fixed` layer (the existing hover/squiggle pattern —
   *not* a child of the text view), positioned at the gap via
   buffer→window coords with manual scroll-follow. This is `Peek`.

The split is forced by IM focus: a focusable nested GtkSourceView that is
a *descendant* of the outer GtkTextView leaks letter input (IM-commit) to
the outer view, because the outer view sees focus as still "within"
itself and keeps its IM context active (key events reach the nested view,
but committed text does not). A *sibling* (not descendant) means focus
genuinely leaves the outer view → its IM context releases → no input
leak. The sibling costs the manual scroll-follow that the text-window
overlay gives for free, but it is the proven hover/squiggle pattern in
this codebase.

> **These should be one primitive.** `Peek` and `BlockDecorations` are two
> implementations of the *same* idea — reserve a gap below a line, float a
> widget in it — differing only in the parenting strategy the IM-focus split
> above forces (text-window child vs sibling overlay). Because they are
> separate systems, neither knows about the other's reserved gap, so a peek
> and a block on the *same* line stack on top of each other: the diff's
> pending review-comment card (a block) had to be hand-suppressed while its
> edit box (a peek) is open (`DiffView.editingPendingId`; see
> [diff.md](diff.md)). The unification: fold `Peek` into `BlockDecorations`
> as a `focusable` band that internally routes to a sibling-overlay slot, so
> a single gap-reservation + reconciliation path serves both and same-line
> widgets can't collide — the IM-focus constraint stays, but as an internal
> parenting detail rather than a second subsystem.

### node-gtk overlay-removal constraint

`gtk_text_view_remove` is a **no-op** in this node-gtk/GTK build — it
warns `"<widget> is not a child of GtkTextView"` and leaves the child
parented to the private `GtkTextViewChild` (the overlay's real parent).
Forcing `unparent()` then detaches the widget while the
`GtkTextViewChild`'s internal overlay list still references it → a
`gtk_widget_snapshot_child: assertion '_gtk_widget_get_parent (child) ==
widget' failed` CRITICAL on the next paint.

So `BlockDecorations` never removes its overlay child: the overlay child
is a controller-owned **slot `Gtk.Box`** wrapping the consumer's widget;
removal detaches the consumer widget (`Gtk.Box.remove`, which works) and
**hides + pools the slot** for the view's lifetime, and `add()` reuses a
pooled slot. Repro + regression check: `src/poc/overlay-churn.ts` (must
print nothing on stderr).

### Overlay z-order constraint (sticky bands on top)

`GtkTextViewChild` draws its overlays in **`add_overlay` (internal queue)
order** (`gtktextviewchild.c`, `snapshot` iterates `overlays.head`): the
last-added overlay is drawn on top. That order is effectively **append-only** —
there is no reorder API, and (per the removal constraint above) an overlay
can't be cleanly removed and re-added; node-gtk exposes none of
`GtkTextViewChild`'s methods either. Because a freed slot is **pooled and
reused at its fixed queue position**, a later non-sticky band reusing an old
slot — or a brand-new one appended on top — can end up drawn over a *sticky*
band. That was the "diff file headers scroll under the `⋯` fold markers" bug.

`BlockDecorations` keeps the **sticky** bands (the diff file headers — `sticky:
true`) at the queue tail so they always draw on top of the scrolling gap/comment
bands:

- a sticky band **never reuses a pooled slot** — it always takes a fresh slot
  appended on top (`add()`), and its slot is **not** re-pooled on removal
  (it sits on top; a scrolling band reusing it would draw over the headers);
- whenever a **brand-new non-sticky** overlay is appended (past the pool — a new
  gap on collapse, a review comment), it lands on top, so `place()` calls
  **`restackStickies()`**: each sticky's widget moves into a fresh slot appended
  on top and the vacated slots (now strictly below every sticky) re-enter the
  non-sticky pool. This fires only on genuinely-new overlays — never per-scroll
  or per-edit (a reused/already-parented slot keeps its position).

## Why not the alternatives

- **`GtkTextChildAnchor`** — embeds a real widget but **consumes one
  buffer char** → perturbs offsets / search / save on the live buffer.
  Keep only as a fallback if overlay geometry proves troublesome.
- **`GtkSourceAnnotations`** — end-of-line trailing text only; no own row,
  no click-to-expand. Right for error-lens / blame, wrong for a block.
- **Synthesized real line** (a `FoldRow`-style placeholder that is buffer
  text) — selectable/editable and perturbs row mapping; the block avoids
  it. For *folds* specifically, the view-side projection in
  [folding.md](folding.md) is used instead.

## The primitive: `BlockDecorations`

Lives beside `TextDecorations` (one per editor, `editor.inlineBlocks`).

```ts
const handle = editor.inlineBlocks.add({
  line,                 // anchor row (buffer)
  widget,               // any Gtk.Widget
  placement: 'below',   // gap below the anchor line ('above' = pixels-above)
});
handle.invalidate();    // re-measure the widget height + reposition (after its size changes)
handle.remove();        // drop the band + overlay + anchor mark
```

(Options are exactly `{ line, widget, placement? }` — no width option; see
`BlockDecorations.ts`.)

Each handle owns three things:

1. **A `GtkTextMark` at the anchor line** (left gravity), *not* a raw line
   number — lines shift as a live buffer is edited; the mark tracks them.
   Position = `get_iter_location(mark).y + .height` (bottom of the anchor
   line), `x = 0` (text origin). Static in the read-only diff; the same
   code serves the live editor.
2. **A dedicated gap tag** (`pixelsBelowLines = childHeight`) applied only
   to the anchor line. One tag per block (heights differ); the tag table
   growing by a handful is fine.
3. **The overlay child**, placed via `add_overlay(widget, x, bottomY)`.

### The hard part — dynamic height

Fixed-height blocks (a one-line label) are trivial; a variable-height
child is the work:

- Measure the child (`child.measure(VERTICAL, width)`), set
  `tag.pixelsBelowLines = H`, then `move_overlay` to the anchor bottom.
  `handle.invalidate()` re-runs this.
- **Guard the loop**: setting the tag relayouts, which can re-emit size
  signals — act only when H differs from the last applied value.
- **Reposition triggers**: layout shifts that move anchors (edits above,
  fold toggles) via `repositionAll()` — **not** scroll (the text-window
  overlay scrolls for free). In the read-only diff the buffer is static,
  so this reduces to "place once."

### node-gtk timing gotchas (apply to all consumers)

- **Place only after geometry is valid.** `get_iter_location` returns 0
  before the view's first layout (and `map` fires before it), so placement
  retries on a 16ms timer until the anchor's line rect is non-zero.
- **Never place synchronously inside a layout-invalidating action.** A
  block added during a fold collapse runs right after
  `applyTag(invisible)` invalidated the layout; `addOverlay` then leaves
  the overlay child unallocated until an external relayout (a window
  resize would reveal it). Route *all* placement through the deferred
  flush so the invalidation settles first.
- **Force the relayout.** Callers `queueResize()` after a layout change —
  the cooperative loop won't otherwise re-allocate.
- **Reposition via a frame-clock tick callback** (after a change), not
  idle/timeout (which fire mid-transition and read bogus coordinates); guard
  against moving to a zero-height (invalid) rect. The window is
  **stabilization-based, not a fixed frame count**: GtkTextView re-allocates
  changed line heights (e.g. an `on` header line growing to its widget height
  on collapse/expand) over an unpredictable number of frames, so the tick keeps
  repositioning *while any band still moves* and stops only after positions hold
  steady (`REPOSITION_FRAMES` consecutive still frames), capped by
  `REPOSITION_MAX_FRAMES`. A fixed window could close mid-relayout and strand a
  sticky header at a partially-grown Y — the "headerbands float over the wrong
  location after collapsing a file" bug — recovering only if a later scroll /
  `vadjustment::changed` happened to re-fire.
- **The overlay caret is a consumer too.** `TextEditor.renderCursorOverlay`
  / `renderExtraCarets` place the hollow/filled/beam caret boxes from
  `bufferToWindowCoords`, which is all-zero before the first allocation —
  so a caret painted during load (cursor at 0,0 on an empty/EOL line)
  lands at widget (0,0), over the gutter, until the next cursor move. Both
  hide while `getHeight() <= 0`, and `installCursorOverlay` re-runs
  `refreshCursorStyle()` on a post-`map` tick once the height is real.
- **The block caret is focus-gated.** `EditorModel.focused` starts
  `false` (a fresh view holds no keyboard focus) and only the focus
  controller's `enter` sets it true, so an unfocused view — background
  tab, inactive split pane, peek — paints *no* block caret. Defaulting it
  true made any loaded-but-unfocused editor show a solid block.

### Focus / input

A `BlockDecorations` child is a *descendant* of the text view, so a
focusable nested editor would leak IM input to the outer view — hence
`BlockDecorations` is click-only. Focusable content uses the
sibling-overlay `Peek` instead (focus genuinely leaves the outer view →
its IM releases). See *Placement strategies* above.

## The primitive: `Peek`

`Peek` (`src/ui/TextEditor/Peek.ts`) is the sibling-overlay variant: the
peek card is a direct child of the editor's `Gtk.Overlay` (a SIBLING of
the text view, so focusing it releases the outer view's IM → no input
leak), positioned at the gap via the overlay's **`get-child-position`**
(exact + unclamped, and only the card's rect is allocated → clicks/scroll
outside it reach the file). Scroll-follow re-runs the overlay allocation
on the vadjustment change. Wired into `TextEditor` as
`showPeek`/`closePeek`/`peekOpen`.

`Peek` depends on node-gtk #444 / PR #445 (caller-allocated out-struct
signal params — `get-child-position`'s `GdkRectangle*`).

## Consumers (built)

1. **Markdown image preview** (`BlockDecorations`) —
   `plugins/markdown/imagePreview.ts`. The only `BlockDecorations`
   consumer. `![alt](src)` local images (relative / absolute / `file://`)
   render as a `Gtk.Picture` block below their line. Reconciled on a
   debounced rescan (blocks keep identity across edits and track their
   anchor mark, so typing doesn't reload); textures downscaled + cached
   per path/mtime; toggle `markdown.imagePreview`. Remote (`http(s)`/
   `data:`) images are deferred (async network).
2. **See-definition / peek** (`Peek`) — the `lsp:peek-definition` command
   (`space l p`, toggles) in `AppWindow.peekDefinition` fetches the LSP
   definition (`zym.lsp.goto`) and shows a full-width nested read-only
   `TextEditor` below the symbol's line, height-capped with internal
   scroll, `escape` to close. Two paths: if the definition's file is already
   open, peek a live read-only `TextEditor` onto its shared `Document`
   (`revealPeekRow` + `wrapPeekBody`); otherwise a read-only snapshot
   slice read from disk (`buildDefinitionPeek` — highlighted slice +
   header with file:line + ✕). When the peeked file is open, edits in the
   peek and the tab reflect in each other (via the document registry —
   shared `Document`, N views, per-view cursors; see
   [document-registry.md](document-registry.md)); the disk snapshot is the
   closed-file fallback.

> The multibuffer `DiffView` **is** a consumer: it windows the diff (only
> changed hunks + context are projected into the view) and marks each elided
> run with a `⋯ N unchanged lines` **gap widget** — a block decoration placed
> below the last shown row, alongside the per-file header bands (see
> [diff.md](diff.md) / [multibuffer.md](multibuffer.md)). Single-line code
> folding is a separate mechanism (the fold projection — see
> [folding.md](folding.md)).

## Open questions

- Construction-only tests can't verify rendering, so visual changes need
  an interactive run on a real display.
- Height-loop stability with a live-resizing nested editor (guarded
  re-measure).
- Repositioning cost when many blocks exist + frequent edits above them
  (debounce; only blocks below an edit need a move). Not a concern for the
  static diff.

## Future consumers (ideas — NOT built)

Candidate features on top of the three primitives. Each notes the
primitive and the existing infra it would reuse.

**Block (`BlockDecorations` — non-interactive / click):**

- **Error lens** — the diagnostic message inline below the offending
  line. Reuses diagnostics (`DiagnosticsView`, squiggles).
- **Code lens** — `N references` / `run | debug` above a symbol
  (`placement: 'above'`). LSP `textDocument/codeLens`; reuses go-to /
  references.
- **Inline AI ghost text** — multi-line completion preview below the
  cursor. Reuses agents.
- **Math / other previews** — `$$…$$` etc. (Color literals already exist
  as the separate `color-preview` plugin — a decoration *tint*, not a
  block.)
- **Test / coverage results** by a test. *Needs a test-runner.*

**Peek (`Peek` — focusable, sibling overlay):**

- **Peek references / implementations / type-definition** — results list +
  preview inline. Reuses `find-references`. *Most natural next.*
- **Inline AI edit (Cmd-K style)** — a focusable prompt under the line →
  apply as a diff. Reuses agents.
- **Peek commit / blame diff** — inline a `DiffView` below a line.
  Reuses diff + git.
- **Inline rename** — a tiny inline editor for `lsp:rename` with live
  preview.
- **Inline merge-conflict resolution** — both sides inline with accept
  buttons. *Niche.*

**Separate mechanism — EOL trailing text (`GtkSourceAnnotations`, not
built):** end-of-line only; fits **inlay hints**, **git blame** (trailing
author/date), and a trailing **error-lens** variant. Survey in
[virtual-lines.md](virtual-lines.md); needs its own POC (confirm node-gtk
provider vfunc binding).

**Suggested priority** (value ÷ effort): error lens → peek references →
code lens; most *distinctive*: inline AI edit + peek commit diff.

**TODO — unify scroll behaviour:** `Peek` (sibling-overlay, widget coords) is pinned under horizontal scroll while `BlockDecorations` (`add_overlay`, buffer coords) scrolls on both axes; reconcile so inline widgets behave the same (e.g. hook `hadjustment` in `Peek`, or move both onto one mechanism).
