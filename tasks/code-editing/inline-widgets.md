# Inline widgets (block decorations)

A reusable primitive for showing **real content between buffer lines** that is
**not in the buffer** — a label, a button, or a full nested widget (e.g. a
see-definition peek that inlines another `TextEditor` below a line). It is the
"proper" virtual-line mechanism the [virtual-lines](virtual-lines.md)
investigation recommended, now scoped to an implementation plan.

It supersedes the synthesized-`FoldRow` placeholder the diff viewer uses today
(see [diff.md](diff.md)): a fold placeholder that is a real buffer line is
selectable/editable text and perturbs row mapping. As an inline widget it has
**zero buffer footprint**.

## POC findings (`src/poc/inline-overlay.ts`, run on a real display)

Confirmed by running the POC interactively:

- ✅ **`view.addOverlay(child, x, y)` reserves + renders.** With a
  `pixels-below-lines` gap tag on the anchor line, the overlay child sits in the
  band below that line.
- ✅ **Scrolls natively.** The overlay tracks its anchor as the text scrolls — no
  manual scroll-follow (buffer-coordinate child in the text window).
- ✅ **Pointer input works.** A `Gtk.Button` in the overlay receives clicks — so
  the fold placeholder (a clickable label/button) is fully supported.
- ✅ **Clean add/remove** once the view is realized. Two gotchas: build the
  overlay only *after* the view is **mapped** (pre-realize `get_iter_location`
  returns ~0 → the child lands at the top and can't be parented/removed), and
  **never remove the overlay child from the view**. In this node-gtk/GTK 4.22
  build `gtk_text_view_remove` is a **no-op** — it warns `"<widget> is not a child
  of GtkTextView"` and leaves the child parented to the private `GtkTextViewChild`
  (the overlay's real parent). Forcing `unparent()` then detaches the widget while
  the `GtkTextViewChild`'s internal overlay list still references it → a
  `gtk_widget_snapshot_child: assertion '_gtk_widget_get_parent (child) == widget'
  failed` CRITICAL on the next paint. **Fix (`InlineBlockController`):** the overlay
  child is a controller-owned **slot `Gtk.Box`** wrapping the consumer's widget;
  removal detaches the consumer widget (`Gtk.Box.remove`, which works) and **hides +
  pools the slot** for the view's lifetime, and `add()` reuses a pooled slot. Repro +
  regression check: `src/poc/overlay-churn.ts` (must print nothing on stderr).
- ❌ **A focusable nested GtkSourceView leaks text input.** Key *events*
  (backspace/enter/arrows) reach the focused nested view, but **letter input
  (IM-commit) goes to the OUTER view** — because the overlay child is a
  *descendant* of the outer GtkTextView, so the outer view sees focus as still
  "within" itself and keeps its IM context active. Claiming the press (so the
  outer view doesn't steal focus on click) was necessary but not sufficient.

**Conclusion — two placement strategies:**

1. **Non-interactive / click-only content → `add_overlay`** (text-window child).
   Fold placeholder, ghost text, inlay hints, code-lens buttons. Fully de-risked.
2. **Focusable / text-input content (see-definition peek) → gap-tag + a *sibling*
   overlay**, i.e. the widget goes in the editor's `Gtk.Overlay`/`Gtk.Fixed`
   layer (the existing hover/squiggle pattern — *not* a child of the text view),
   positioned at the gap via buffer→window coords with manual scroll-follow. A
   sibling (not descendant) means focus genuinely leaves the outer view → its IM
   context releases → no input leak. Costs the manual scroll-follow the
   text-window overlay gave for free, but it's the proven pattern in this codebase.

## The mechanism (APIs confirmed in our build)

Probed in `Gtk-4.0.gir` — all present in this node-gtk/GTK4 build:

- **`gtk_text_view_add_overlay(child, xpos, ypos)`** / **`move_overlay`** /
  **`remove`** — place a real widget at a **fixed buffer coordinate** in the text
  window. Because it lives in the text window, **it scrolls with the text for
  free** — we do *not* reposition on scroll (unlike the diagnostic squiggle, a
  `Gtk.Fixed` overlay we scroll-follow manually).
- **`Gtk.TextTag.pixels-below-lines` / `pixels-above-lines` / `pixels-inside-wrap`**
  — reserve a blank vertical *band* below/above a line (pushes real lines apart).
- **`gtk_text_view_get_iter_location(iter)`** → the line's rect **in buffer
  coordinates** (so positioning the overlay needs no window conversion);
  `get_line_yrange`, `get_visible_rect`, `buffer_to_window_coords` available if
  window coords are ever needed.

Recipe: **the tag reserves the gap, the overlay child fills it at buffer coords,
scrolling is automatic.** The only moving part is keeping the gap height equal to
the child's height and repositioning when the buffer changes *above* the anchor.

## Why not the alternatives

- **`GtkTextChildAnchor`** — embeds a real widget but **consumes one buffer char**
  → perturbs offsets / search / save on the live buffer, and (for the diff) would
  reintroduce the synthesized-row mapping mess. Keep only as a fallback if overlay
  geometry proves troublesome.
- **`GtkSourceAnnotations`** — end-of-line trailing text only; no own row, no
  click-to-expand. Right for error-lens / blame, wrong for a block.
- **Synthesized real line** (today's `FoldRow`) — selectable/editable text; the
  thing we're replacing.

## The primitive: `InlineBlockController`

Lives beside `DecorationController` (one per editor, `editor.inlineBlocks`).

```ts
const handle = editor.inlineBlocks.add({
  line,                 // anchor row
  widget,               // any Gtk.Widget
  placement: 'below',   // gap below the anchor line ('above' = pixels-above on the next line)
  fullWidth: true,      // size the child to the text-window width
});
handle.remove();        // height is tracked automatically; handle.invalidate() forces a re-measure
```

Each handle owns three things:

1. **A `GtkTextMark` at the anchor line** (left gravity), *not* a raw line number
   — lines shift as a live buffer is edited; the mark tracks them. Position =
   `get_iter_location(mark).y + .height` (bottom of the anchor line), `x = 0` (text
   origin). Static in the read-only diff; the same code serves the live editor.
2. **A dedicated gap tag** (`pixelsBelowLines = childHeight`) applied only to the
   anchor line. One tag per block (heights differ); the tag table growing by a
   handful is fine.
3. **The overlay child**, placed via `add_overlay(widget, x, bottomY)`.

### The hard part — dynamic height

Fixed-height blocks (fold placeholder = one-line label) are trivial. The nested
editor is where the work is:

- Measure the child (`child.measure(VERTICAL, width)`), set `tag.pixelsBelowLines
  = H`, then `move_overlay` to the anchor bottom.
- Re-apply H when the child's content height changes. **Guard the loop**: setting
  the tag relayouts, which can re-emit size signals — act only when H differs from
  the last applied value.
- **Width**: `widget.widthRequest = textWindowWidth`, updated on view resize.
- **Reposition triggers**: buffer `changed` *above* the anchor (debounced) and
  height changes — **not** scroll. In the read-only diff the buffer is static, so
  this reduces to "place once."

### Focus / input (verify in the POC)

An overlay child is a real widget, so a nested `TextEditor` receives focus and
keyboard normally. The risk is the **capture-phase key controllers + vim layer on
the outer view**: confirm that when focus is inside the overlay child, the outer
view's capture controller does *not* steal its keystrokes (it shouldn't — events
target the focused child — but verify). Escape/close and Tab traversal are wired
per-feature.

## Consumers

1. **Fold placeholder** (first real use — trivial, de-risks the primitive). A
   clickable one-line label/button. Converting it lets us **delete the synthetic
   `FoldRow`**: revert the render-list insertion in `DiffModel`/`DiffView`/
   `SideBySideDiffView`, key decorations/gutter/hunks back off the real diff lines,
   and a fold becomes *hide body (invisible tag) + one inline block on the line
   above*. Cleaner than today, and the placeholder is no longer buffer text. In
   side-by-side, both panes attach their own block (lockstep, like the folds).
2. **See-definition / peek** — a full-width nested read-only `TextEditor` (or
   `DiffViewer`) below the symbol's line, height-capped with internal scroll,
   Escape to close. The dynamic-height + live-buffer + focus case the primitive is
   built to absorb. Sources the definition from the existing LSP go-to plumbing.
3. **Later** (same primitive): code lens (gap *above* a symbol), inline expanded
   diagnostics / error-lens block, multi-line AI ghost text, inline images.
   Mid-line / end-of-line inlay hints are a *different* shape — prefer
   `GtkSourceAnnotations` there (see virtual-lines.md).

## Plan / sequencing

1. [x] **Geometry POC** — `src/poc/inline-overlay.ts` (`pnpm poc:inline`). Ran on a
   real display; results in *POC findings* above. Net: `add_overlay` is confirmed
   for non-interactive/click content (placement, native scroll, clicks, clean
   add/remove); a focusable nested editor leaks text input (descendant-of-textview
   IM problem) → interactive content needs the sibling-overlay strategy. (Headless
   here only confirms API bindings; rendering needs the real display. node-gtk #442:
   defer the top-level `app.run` by one macrotask or the app exits 0 immediately.)
2. [x] **`InlineBlockController` — `add_overlay` (non-interactive) path.**
   `src/ui/TextEditor/InlineBlockController.ts`: mark anchor + per-handle gap tag +
   text-window overlay; measures the child and sets the gap to match; defers
   placement to `map` and **retries until line geometry is valid** (map fires before
   the first layout pass → `get_iter_location` is 0); force-`unparent` on remove;
   `repositionAll()` for layout shifts. API `add({line, widget, placement})` /
   `handle.remove()` / `handle.invalidate()`. Verified on a real display via
   `pnpm poc:inline` (placement, toggle, click, scroll-follow). Exposed as
   `editor.inlineBlocks`.
3. [x] **Convert the fold placeholder** to an inline block — done and verified on a
   real display (collapse/expand, position, side-by-side both panes, scroll).
   `foldUnchanged` returns fold regions over real buffer rows (no `FoldRow`);
   `DiffFold` hides each body and, while collapsed, renders the
   `⋯ N unchanged lines` placeholder as a clickable inline block on the anchor line
   (`placement: 'below'`, or `'above'` for a top-of-file fold); the gutter chevron
   stays as the always-visible toggle; an explicit toggle keeps the anchor on screen
   (`scrollToMark`). Unified + side-by-side (one block per pane, lockstep). The
   placeholder is no longer buffer text (not editable/selectable).

   **node-gtk timing gotchas (hard-won — all in `InlineBlockController`):**
   - **Place only after geometry is valid.** `get_iter_location` returns 0 before
     the view's first layout (and `map` fires before it), so placement retries on a
     16ms timer until the anchor's line rect is non-zero.
   - **Never place synchronously inside a layout-invalidating action.** A block
     added during a fold collapse runs right after `applyTag(invisible)` invalidated
     the layout; `addOverlay` then leaves the overlay child unallocated until an
     external relayout (a window resize would reveal it). Route *all* placement
     through the deferred flush so the invalidation settles first.
   - **Force the relayout.** `DiffFold` and the controller call `queueResize()` after
     a fold change — the cooperative loop won't otherwise re-allocate.
   - **Reposition via a frame-clock tick callback** (a few frames after a change),
     not idle/timeout (which fire mid-transition and read bogus coordinates); guard
     against moving to a zero-height (invalid) rect.
4. [x] **Sibling-overlay variant** — `InlinePeek` (`src/ui/TextEditor/InlinePeek.ts`):
   the peek card is a direct child of the editor's `Gtk.Overlay` (a SIBLING of the
   text view, so focusing it releases the outer view's IM → no input leak),
   positioned at the gap via the overlay's **`get-child-position`** (exact +
   unclamped, and only the card's rect is allocated → clicks/scroll outside it reach
   the file). Scroll-follow re-runs the overlay allocation on the vadjustment change.
   POC `src/poc/sibling-peek.ts` proved focus/IM + input pass-through + scroll-follow
   on a real display. **Depends on node-gtk #444 / PR #445** (caller-allocated
   out-struct signal params — `get-child-position`'s `GdkRectangle*`). Wired into
   `TextEditor` as `showPeek`/`closePeek`/`peekOpen`.
5. [x] **See-definition** — `buildDefinitionPeek` (read-only highlighted slice of the
   definition's file + header with file:line + ✕; Escape closes) shown by
   `editor.showPeek`; `lsp:peek-definition` command (`space l p`, toggles) in
   `AppWindow` fetches the LSP definition (`quilx.lsp.goto`) and reads the file.
   Constructs clean in a real editor (`node scripts/peek-demo.ts`); **pending a visual
   run**. Remaining polish: scroll the slice to center the definition; jump-to button.
6. [ ] **Live buffer (deferred)** — the peek currently shows a read-only *snapshot*
   slice. To make edits in the peek (and external edits) reflect in an open tab + the
   modified dot, it must share the open document's buffer. Chosen approach: the
   **document registry** refactor (shared `Document`, N views, per-view cursors) —
   see [document-registry.md](document-registry.md). Done as a separate effort.

## Risks / open questions

- The POC must confirm the gap-tag + overlay geometry on a **realized** view (the
  sandbox window never maps here, so this needs an interactive run on the user's
  machine — construction-only tests can't verify rendering).
- Height-loop stability with a live-resizing nested editor (guarded re-measure).
- Outer-view capture controllers vs. a focused inner editor (the focus/input
  question above) — the single biggest unknown for the peek feature.
- Repositioning cost when many blocks exist + frequent edits above them (debounce;
  only blocks below an edit need a move). Not a concern for the static diff.

## Net

No fork or custom widget: a small `InlineBlockController` (per-line gap tag +
buffer-coordinate overlay child) on top of GtkSourceView covers fold placeholders,
see-definition peeks, code lens, and inline expanded content — with a zero
buffer-footprint, natively-scrolling overlay. POC the geometry + focus first.

## Future consumers (ideas to split into work)

The two primitives are built and proven; these are candidate features on top.
Each notes the primitive it uses and the existing infra it reuses.

**Block (`InlineBlockController` — non-interactive / click, text-window overlay):**

- **Error lens** — the diagnostic message inline below the offending line (the
  readable, no-hover form). Reuses the existing diagnostics (`DiagnosticsView`,
  squiggles). *High value, low–medium.*
- **Code lens** — `N references` · `run | debug` · `implementations` above a symbol,
  clickable. LSP `textDocument/codeLens`; reuses go-to / references. The gap goes
  *above* the symbol (`placement: 'above'`). *High value, medium.*
- **Inline AI ghost text** — multi-line agent completion preview below the cursor,
  accept/dismiss. Reuses the agent infra. *High value, higher effort.*
- **Color swatch / image / math preview** — a block under a CSS color, a markdown
  `![img]`, or `$$…$$`. *Nice, low–medium (markdown/CSS).*
  - ✅ **Markdown image preview built** (`src/plugins/markdown/imagePreview.ts`):
    `![alt](src)` local images (relative / absolute / `file://`) render as a
    `Gtk.Picture` block below their line via `InlineBlockController`, reconciled on a
    debounced rescan (blocks keep their identity across edits and track their anchor
    line, so typing doesn't reload). Textures are downscaled+cached per path/mtime;
    toggle `markdown.imagePreview`. Remote (`http(s)`/`data:`) deferred (async
    network). Color swatch is the separate `color-preview` plugin (decoration tint).
- **Test / coverage results** — pass/fail + message by a test. *Needs a test-runner.*

**Peek (`InlinePeek` — focusable, sibling overlay):**

- **Peek references / implementations / type-definition** — a results list + preview
  inline (the sibling of see-definition). Reuses `find-references`. *High value,
  medium — most natural next.*
- **Inline AI edit (Cmd-K style)** — a focusable prompt under the line ("rewrite
  this") → apply as a diff. Reuses agents. *High value, higher effort; distinctive.*
- **Peek commit / blame diff** — inline a `DiffViewer` below a line ("what changed
  here" / the blamed commit). Reuses the diff viewer + git. *Great fit, medium.*
- **Inline rename** — a tiny inline editor for LSP rename with live preview. Reuses
  `lsp:rename`. *Medium.*
- **Inline merge-conflict resolution** — both sides inline with accept buttons. *Niche.*

**Separate mechanism — EOL trailing text (`GtkSourceAnnotations`, not built):**
end-of-line only; complements blocks/peeks. Fits **inlay hints** (param names /
inferred types), **git blame** (trailing author/date), and a trailing **error-lens**
variant. Survey in [virtual-lines.md](virtual-lines.md); needs its own POC (very new
API; confirm node-gtk provider vfunc binding).

**Suggested priority** (value ÷ effort, all reuse existing infra): error lens →
peek references → code lens; most *distinctive*: inline AI edit + peek commit diff.
