# Text editor widget

> Evaluation for index.md → "Code editing → Text editor": *"Consider a custom
> widget or a fork of GtkSourceView … multiple cursors, rectangular selection,
> better performance with large files. Consider a JS widget, or a Rust widget
> with a JS wrapper."*

**Decision: stay on `GtkSource.View` and emulate the two things it can't do
natively (multi-cursor, block-select); own the *model* so each view gets its
own buffer; treat a from-scratch widget as a gated escape hatch, not the next
step.**

This page records why, and what each rejected path would cost. The actual
text-editor code lives in `src/ui/TextEditor/`.

## Architecture at a glance

Two layers sit on the widget (`src/ui/TextEditor/`):

- **Document / model layer (we own the text).** `Document.ts` keeps the text in
  a **headless model `GtkSource.Buffer`** (never shown) that is the single
  source of truth + undo authority + LSP text source. Each on-screen view gets
  its **own** `GtkSource.Buffer` via `Document.createView()`, kept in sync from
  the model — so the buffer is pure presentation, which is what lets two views
  of one file have independent cursors, folds, and decorations.
  `DocumentRegistry.ts` owns multi-host / active-view routing and ref-counting.
- **Editor logic layer (`EditorModel.ts`).** An Atom-`TextEditor`-shaped model
  over a view's buffer: `Point`/`Range`, scanning, mutation, undo, plus the
  seams other features plug into (`onDidChangeText`, viewport/pixel geometry,
  decorations, cursors/selections). `getCursors()`/`getSelections()` are
  **N-element** arrays backed by `MarkerLayer.ts` mark pairs — the seam
  multi-cursor plugs into. Undo is relocated to the `Document` via
  `setUndoTarget()` so it stays correct across views.

`TextEditor.ts` ties it together: a `GtkSource.View` on a `Document`
view-buffer, tree-sitter highlighting + `invisible`-tag folding
(`SyntaxController`), a `GtkSource.Map` minimap, file I/O (delegated to
`Document`), LSP, and **custom vim modal editing** (`vim/`, ported from
vim-mode-plus).

## Feature checklist vs. GtkSourceView

| Feature | On GtkSourceView | Notes |
|---|---|---|
| Syntax highlighting (tree-sitter) | **Built** (ours) | `setHighlightSyntax(false)` + own `TextTag`s. Upstream is regex `.lang` only. |
| Code folding | **Built** (ours) | No upstream fold API in GtkSource 5; we use the `invisible` `TextTag`. |
| Gutter (line nums, diagnostics, git bars) | **Native** | `GtkSourceGutterRenderer`. |
| Inline virtual text / inlay hints / diff | **Built** | `VirtualText.ts` wraps native `GtkSourceAnnotations` (5.18+; we're on 5.20). |
| Diff display | **Built** | One multibuffer `DiffView` (`src/ui/DiffView.ts`) on a `CoordinatesMap`. |
| Search UI | **Built** | `SearchController` + `SearchBar`. |
| Minimap | **Native** | `GtkSource.Map`. |
| Multiple cursors / block selection | **Built (emulated)** | No native support; emulated on `MarkerLayer` (Option A). |
| Multiple *views* of one buffer (split, peek) | **Built (A2)** | Each view its own buffer, synced from the `Document` model. |
| Large line *counts* (M+ lines) | **Native, fine** | Only visible paragraphs are laid out. |
| Pathological long *single* lines (minified) | **Guarded** | The one hard wall; long-line mode degrades gracefully — see constraints. |
| IME / bidi / a11y / clipboard / DnD | **Native, free** | The expensive-to-rebuild subsystems all come free here. |

The features GtkSourceView *can't* do natively — multi-cursor, block-select,
long single lines — trace to two parts of **GtkTextView** (GTK core, below
GtkSourceView) you can't override: the single `insert`/`selection_bound` mark
pair, and the per-paragraph `PangoLayout`.

## Options considered

### Option A — stay on GtkSourceView, emulate the gaps *(chosen)*

Build multi-cursor and block-select on top, the way GNOME Builder does
(`ide-cursor.c`): a list of virtual cursors, each its own mark pair, extra
carets drawn over the text, every edit replayed per cursor. Rectangular
selection is a column of virtual cursors. In zym this lands on the existing
seam: `EditorModel.getCursors()`/`getSelections()` are N-element over
`MarkerLayer`, and the vim layer (which iterates those arrays) gets
multi-cursor largely for free. Pros: keeps the entire built stack (vim,
tree-sitter, folding, minimap, I/O); IME/bidi/a11y/clipboard stay free; lands
incrementally; lowest risk. Cons: emulated multi-cursor is real
maintenance-heavy code fighting a one-cursor buffer; doesn't fix long lines.

### Option B — fork GtkSourceView — **rejected**

The things we fight don't live in GtkSourceView; they live in **GtkTextView**,
which is **GTK core**. To change the model (buffer/presentation split, mid-line
layout, insert-mark-is-the-cursor coupling) you'd fork GTK itself and ship it
through node-gtk forever — and the hardest part (long-line layout) still
wouldn't be fixed because it lives in `GtkTextLayout`. All the cost of owning a
text stack with none of the design benefit. Off-path for a JS/node-gtk
codebase.

### Option C — own the widget (custom GTK4 text widget) — **gated escape hatch**

A from-scratch `GtkWidget` whose `snapshot()` paints code via Pango/GSK. The
only path that fixes long lines *and* makes multi-cursor/block-select native.
Research is encouraging on **rendering** (GTK4 gives a glyph atlas + retained
render-node caching; VTE proves the GTK4 path; node-gtk's
`examples/gtk-4-custom-widget.js` proves a JS `snapshot()` override) and
sobering on **the surround**: you'd rebuild the private `GtkTextLayout` middle
layer (per-line layout cache + viewport virtualization — the largest cost),
plus IME, bidi, and a11y — exactly what GtkSourceView gives free. Telling
signal: no major Rust editor uses GTK (Zed/Lapce/COSMIC went GPU-direct; the
fast GTK editors are C-on-GtkSourceView).

If ever taken, the shape is **C2 — Rust core + JS rendering**: a Rust core
(`ropey` + tree-sitter + tree-sitter-highlight + cursor model) as a napi-rs
addon supplying text/highlight-spans/cursor-geometry; the GTK4 widget stays
JS/node-gtk. Keeps one main loop, one thread, no GObject handoff, no GIR
pipeline. (A fully-Rust gtk-rs widget exposed via GIR — "C3" — is rejected:
needs a manual typelib pipeline the gtk-rs toolchain won't automate and has
zero precedent.)

**The gate before any C rewrite:** a one-day node-gtk spike answering three
unknowns — (1) render perf (a `Gtk.Widget` subclass snapshotting ~50 visible
lines via cached `PangoLayout`s, scrolling/typing smoothly with `snapshot()`
driven from JS — the per-frame JS↔native FFI cost is unmeasured); (2) IME wired
directly (`GtkIMContext` commit/preedit); (3) `GtkScrollable` + adjustments. If
perf is janky, the answer is definitive: stay on GtkSourceView.

**Long lines:** adopt GtkSourceView's own posture — detect and warn/refuse
pathological single-line files rather than hang. Revisit only if real workloads
make it intolerable.

## Document-model direction (A2): own the model, keep per-view GtkSourceViews

A third path between Option A (one shared buffer, emulate everything per view)
and Option C (own the whole widget): keep GtkSourceView as the **renderer**,
but make **our model the source of truth for text** and give **each view its
own buffer**, synced from the model. This is how Atom (`TextBuffer` ↔ N
`TextEditor`s), VS Code (`TextModel` ↔ editors), and CodeMirror 6 (state ↔
views) all work — and our vim layer is a port of Atom's vim-mode-plus. (POC in
`src/poc/document-model.ts` validated the gates first.)

**Why it's needed: everything buffer-level renders identically in every view.**
Two `GtkTextView`s on one `GtkTextBuffer` show the *same* cursor, selection,
current line, brackets, search, and folds, because the *buffer* owns the
`TextTag`s, the `insert`/`selection_bound` marks (native caret + selection),
and the `invisible` fold tag; the *view* owns only scroll + child widgets.
Per-view folding is outright **impossible** on a shared buffer (line visibility
is a buffer tag). The fix is to stop sharing the buffer.

**What per-view buffers give (natively, per view):** caret, selection,
current-line, search, bracket, and **folding** are each native again (each
buffer has its own marks/tags). Native inline widgets / `GtkSourceAnnotations`
/ markers per view are possible. LSP `didChange` fires once from the model.

**What this does NOT fix** (still GtkTextView, below us): long single lines, and
native multi-cursor *within* one view (still one mark pair per buffer → extra
cursors stay emulated, but leak-free since each view has its own buffer). So
this is the targeted fix for **multi-view**, not a substitute for the Option C
endgame — and it doesn't preclude C later (the `Document` model layer ports
unchanged; only the views get swapped).

**Mechanics + the undo trick.** An edit in any view → apply to the model →
mirror to the other view buffers, reentrancy-guarded by an `origin`/`suppress`
pair (care around IME commit and exact `(offset, deleted, inserted)`
mirroring). Undo is the crux: native per-buffer undo would desync views, so the
**headless model buffer** holds the one native undo manager
(`setEnableUndo(true)`) and view buffers have undo **off**
(`setEnableUndo(false)`); `EditorModel.setUndoTarget()` routes a
document-backed view's `undo`/`redo`/`transact` to the `Document`, which
propagates to every view. Syntax stays per-view (N parses; the model buffer
isn't shown).

`Document.ts` owns the model buffer + `createView()`, file I/O, disk-watching,
modified-state, and the document-level LSP. `TextEditor` is a view onto a
`Document`; `AppWindow` split opens a real 2nd view; the live see-definition
peek (`peek: true`) is a read-only 2nd view.

**Deferred polish (not blockers):** undo grouping feel (relies on GTK's native
coalescing; wrap vim ops in `beginUserAction`/`endUserAction` if needed); IME
under heavy multi-view load (not stress-tested); extreme pastes (fuzz-tested,
not at pathological scale); linked scroll for split (panes scroll independently
by default); double parse (N parses for N views — fine for typical 2–3).

**Unblocked but not yet built:** the model as a single authoritative edit
stream is a foundation for collaborative editing / CRDT, model-layer AI edits,
macro recording, or history/time-travel; new view types (minimap-as-view,
"compare against unsaved") are just `Document.createView()`.

## Constraints carried from the research (cited; uncertainties flagged)

- **Single mark pair.** `GtkTextBuffer` has exactly `insert` +
  `selection_bound`, unchanged in GTK4 — no native multi-cursor or rectangular
  selection. (docs.gtk.org `class.TextBuffer`; GtkSourceView PainPoints wiki.)
- **All buffer-level state renders identically in every view of a buffer.**
  *(Ours, proven building the document registry.)* See A2 above — the clean fix
  is per-view buffers.
- **Multi-cursor is proven on top, and fragile.** GNOME Builder's `ide-cursor.c`
  (parallel mark pairs + per-cursor edit replay). GNOME Text Editor still lacks
  it, described upstream as needing "deep changes into GtkSourceView"
  (gnome-text-editor#253). *Uncertain:* GTK4-era Builder impl details.
- **Long single lines are the one unfixable wall.** Each paragraph is one
  indivisible `PangoLayout`, so a giant line defeats visible-only layout; the
  loader may refuse such files (gtk#229, gtksourceview#95/#208). Large line
  *counts* are fine. *Uncertain:* GTK4 crash status, loader thresholds, exact
  big-O. **Mitigated** (long-line guard,
  `hasLongLine`/`applySyntaxOrLongLineMode` in `TextEditor.ts`): a file with any
  line ≥ `LONG_LINE_THRESHOLD` (20k, VS Code parity) loads in *long-line mode* —
  soft-wrap off + tree-sitter highlighting dropped (`disableHighlighting`) + a
  toast — so it opens/scrolls instead of hanging. GtkTextView still renders the
  wide line as best it can (the genuine wall; cairo/pixman may warn on the
  oversized rect — benign).
- **Extensibility is additive, not replaceable.** Gutter renderers, `TextTag`s,
  `snapshot_layer`, `GtkSourceAnnotations` cover gutter/inline/virtual-text
  needs — but you cannot replace the per-line Pango layout, the part owning the
  widget would be *for*.
- **Rust-in-process is realistic but not turnkey.** One libgtk + GType registry
  + main loop supports co-residency, but exporting a Rust gtk widget needs a
  manual GIR/typelib pipeline (C2 sidesteps this by keeping rendering in JS,
  Rust as a pure-logic napi core). Best blocks: `ropey`, tree-sitter; **avoid**
  cosmic-text inside GTK (redundant with Pango). *Uncertain:* no project proves
  "Rust core + GTK4 custom snapshot widget" end to end.

## Shared editor primitives (the seams features plug into)

All built (`src/ui/TextEditor/`):

- **Buffer change events** — `EditorModel.onDidChangeText` (Atom
  `{changes:[{oldRange,newRange,oldText,newText}]}` shape), backed by the
  buffer's `insert-text`/`delete-range` signals. Consumers: vim undo/redo, LSP
  `didChange`, multi-cursor edit-replay. (tests: `EditorModel.test.ts`.)
- **Viewport + pixel geometry** — `getFirstVisibleScreenRow`/
  `getLastVisibleScreenRow` and `pixelRectForBufferPosition` (widget-relative
  cell rect for anchoring popovers), realized-view-guarded with fallbacks.
  Consumers: LSP hover/code-action popovers, vim H/M/L + scroll, diff
  scroll-sync.
- **Inline decorations** — `TextDecorations` / `DecorationLayer`
  (`editor.decorations`): clearable named layers of `TextTag` background spans
  (search `highlight`, diff `added`/`removed`), above syntax priority. (tests:
  `TextDecorations.test.ts`.)
- **Drawn-underline overlay** — `UnderlineOverlay`: a transparent
  `Gtk.DrawingArea` stroking anti-aliased Cairo sine waves under buffer ranges
  (nicer than `Pango.Underline.ERROR`). Used by `DiagnosticsView` squiggles.
  Drawn result needs interactive verification.
- **Virtual text** — `VirtualText.ts` wraps native `GtkSourceAnnotations`
  (end-of-line trailing text, per view). Consumers: `InlayHintController`,
  `DiagnosticsView`. *Note:* annotations are line-anchored (end-of-line only);
  general mid-line virtual lines would still need the gap-tag + overlay recipe —
  see [virtual-lines.md](virtual-lines.md) (not built).

## Feature status

### Search — *done*

`SearchController` (incremental literal/regex over `EditorModel.scan`,
decoration highlights, next/previous, replace-current/all with regex backrefs) +
`SearchBar` (floating top-right; search+replace entries, 3-way case button,
regex toggle with inline regex highlighting; **`alt-s`** case, **`alt-r`** regex;
`enter`/`shift-enter` step, `ctrl-enter` replace-all). Vim `/` `?` `n` `N` wired;
smartcase default. Tests: `SearchController.test.ts`. Not yet (low priority):
`*`/`#` word search, history, operator-pending search-as-motion.

### Command line (`:` ex-commands) — *won't do*

No vim `:` command line. Its commands are already reachable: save via
`space w`, close via `tab:close`/`pane:close`, open via `space o`,
search/replace via SearchBar. So `:w`/`:q`/`:e`/`:%s` are covered without a
modal prompt.

### Multi-cursor / blockwise — *done*

Built on Option A. `getCursors()`/`getSelections()` N-element over
`MarkerLayer`;
`hasMultipleCursors`/`mergeCursors`/`mergeIntersectingSelections`/`onDidAddSelection`
are real; `Selection.onDidDestroy` backs per-selection register clipboard. Entry
points: blockwise `ctrl-v`, occurrence `c o p`, persistent `ctrl-alt-↑/↓`
add-cursor (`escape` collapses). Extra carets render as reverse-video block tags
(normal/visual) and host-drawn beam carets (insert), via
`EditorModel.onExtraCursors` → a caret pool in `TextEditor.ts`. The primary block
caret falls back to the same host-drawn overlay box where there's no glyph to
reverse-video (empty line / past EOL / EOF) or while unfocused (hollow). All
host-drawn carets sit on a `Gtk.Fixed` at *window* coords, so — like
`IndentGuides`/`UnderlineOverlay` — they must be re-placed on scroll
(`repositionOverlayCarets`, bound to the v/h adjustments); only the reverse-video
tag caret scrolls natively with the text. Multi-cursor ops
coalesce into one undo step (`mutateSelections` in one `transact`); insert is
live-replicated to every cursor on a deferred microtask. Tests:
`blockwise.test.ts`, `multicursor.test.ts`, `occurrence.test.ts`. Edges needing
in-app verification: beam visuals + `ctrl-alt-arrow` keys; insert sessions can
undo in a couple of steps; replication covers inserts + single-line backspaces
(multi-line deletes fall back to the leave-insert replay).

### Editor / vim polish — *done*

- **Fold-aware motions** — `EditorModel.isFoldedAtBufferRow`/`unfoldBufferRow`
  delegate to `SyntaxController` via a `FoldProvider` (`setFoldProvider`); vim
  motions skip/reveal folded rows.
- **Buffer-only editor mode** — `new TextEditor({ buffer: {...} })`: no file I/O
  / LSP / line-numbers / minimap; keeps vim + syntax + search; placeholder,
  `getText`/`setText`, `ctrl-enter` → `onSubmit`. For the Git commit-message
  editor.
- **Column-unit reconciliation** — columns are **codepoints** (matching
  `GtkTextIter` + `lsp/position.ts`). Tree-sitter `SyntaxController.iterAt`
  converts web-tree-sitter UTF-16 cols to codepoints, gated on a per-refresh
  `hasAstral` check. *Remaining holdout:* incremental-parse edit tracking still
  mixes codepoint offsets with UTF-16 lengths — editing next to an astral char
  can feed a slightly-wrong edit.
- **Vim motions** — `H`/`M`/`L`, `ctrl-f/b/d/u/e/y`, flash-on-operate, **`=`/`==`
  auto-indent** (tree-sitter indent via `SyntaxController.indentLevelForRow` +
  `EditorModel.setIndentSource`, falls back to copy-line-above).
- **Matching brackets** — under/before the cursor and its pair, or the innermost
  enclosing pair when inside (`syntax/bracketMatch.ts`); ignores brackets in
  strings/comments.
- **Indent guides** — faint per-level vertical lines (`IndentGuides`, Cairo
  overlay); toggle `editor.indentGuides`.
- **Tree-sitter text objects** — `if`/`af`, `ic`/`ac`, `ia`/`aa`, via
  `SyntaxController` `functionRangeAt`/`classRangeAt`.
- **Folds query** — driven by a grammar's `folds.scm` (`@fold` captures) when
  present, else `foldTypes`; plus run-folds (consecutive imports / line comments
  collapse). `computeFoldRanges` (`syntax/folds.ts`, unit-tested).
- **JSX/HTML tags** — auto-close (`>` inserts `</name>`, `tagClose.ts`,
  JSX-vs-generics heuristic + tag-language gate) and co-rename (`tag:rename`,
  `SyntaxController.tagNamesAt`).
- **Inlay hints** — LSP parameter/type hints rendered end-of-line via
  `VirtualText` (`InlayHintController`, `editor.inlayHints`).

### Diff display — *done*

Every diff renders on the one multibuffer `DiffView` (`src/ui/DiffView.ts`): each
changed file's old/new sides are stitched into a single scrollable editor via a
`CoordinatesMap`, with changed hunks + context shown and long unchanged runs
elided to a `⋯` gap widget. Backgrounds come from `editor.decorations`; per-side
syntax is painted through the projection. See [multibuffer.md](multibuffer.md)
and [diff.md](diff.md). Diff *data* comes from the **Git** workstream;
`GitGutter.ts` draws VS Code-style change bars (in-process Myers diff of
buffer↔index and index↔HEAD).

### Scrolling & open performance — *done; native rendering is the floor*

Scroll/open cost is **per-frame node-gtk FFI** (JS draw/query code crossing the
boundary once-or-more *per visible line, per frame*), not GtkTextView layout —
only visible paragraphs lay out. After the work per-frame JS is ~1% CPU; the
frame-rate ceiling is now native GtkTextView/GSK rendering, beyond which the
only lever is the gated custom-widget path (Option C). Current mechanisms:

- **IndentGuides** (`IndentGuides.ts`) — one batched `getText` for the visible
  block + JS level math (not two FFI line-reads/row); geometry hoists the
  buffer→widget translation out of the per-row loop and, when all visible rows
  are the base height (no wrap/scaled line — common for code), derives each row's
  y arithmetically with no per-row FFI (per-row `getIterLocation` fallback
  otherwise). ~10× fewer FFI/frame, pixel-identical output.
- **Line-number gutter** — `lineNumberWidth` caches the digit count.
- **Highlighting: a persistent, incremental, throttled cache** (`paintedRanges` +
  `syntax/paintRegions.ts`). A scroll paints only the not-yet-painted lines of
  the visible range (`rangeGaps`) and **never clears** — text unchanged ⇒ tags
  stay valid — so highlights persist (scroll down then up is free) and a held
  ctrl-d/ctrl-u keeps up (a **throttle**, `VIEWPORT_THROTTLE_MS`=16ms/frame, not
  a trailing debounce). Edit/fold/new-doc resets it (a reparse can change tokens
  anywhere): `repaint()` clears all highlight tags, paints the viewport, resets
  the cache; scrolling re-accumulates.
- **First paint is bounded** (`initialPaintRange`, top 250 lines) — pre-size-
  allocate `visibleRange` is null; rather than highlight the whole buffer
  (O(file): ~840ms@3k, ~1.45s@8k) it paints the file's head, so open is
  O(viewport) (~70ms, size-independent). Headless keeps the whole-buffer paint
  (tests).
- **First *parse* is bounded too** (`DocumentSyntax`, `INITIAL_PARSE_LINES`=500) —
  the synchronous open parse reads only the file's head (covering the first-paint
  window + margin), then `scheduleFullParse` parses the whole file on the next
  loop iteration (a macrotask, after the first frame) and emits a reparse so every
  view repaints + rebuilds folds. So the parse that blocks open is O(viewport)
  (~1.5ms, flat) instead of O(file) (~28ms@10k, ~144ms@50k lines). While the tree
  is partial, incremental edit tracking is skipped and the next reparse is forced
  full; a sibling view that attaches mid-window reuses the partial tree (the shared
  deferred parse upgrades both). Bench: `src/poc/load-bench.ts`. Small files
  (≤500 lines) still parse fully in one synchronous pass.

Follow-ups (measured, not done): the highlight cache is **unbounded** (far-region
eviction cap); **startup** ~680ms = module load ~450ms + `preloadGrammars` (all
grammars) ~230ms — lazy per-language load. `UnderlineOverlay` squiggles still
redraw per frame under diagnostics (marginal).

### Gutter rendering — *done; one composite renderer*

The main view's four gutter renderers are collapsed into a **single composite
`GtkSourceGutterRendererText`** (`GutterRenderer` in `gutterRenderers.ts`) that
composes line number + fold chevron + git bar + diagnostic glyph into **one
markup string (one `PangoLayout`) per line**. `SyntaxController` owns the one
renderer and its deferred-install / width-priming machinery; `GitGutter` and
`DiagnosticsView` don't own renderers — they feed a per-line cell through the
`GutterCellSink` (`setGitCell` / `setDiagCell` + `redrawGutter`). The gutter is
**display-only**: the chevron shows ▾/▸ but takes no clicks (folding is
keyboard-driven — `za`/`zo`/`zc`/`zr`/`zm`).

The composite cuts the gutter's own per-frame Pango layout cost ~4× (1 layout/
line vs 4) and removes 3× of the per-line `queryData` C→JS FFI and
`gsk_text_node` creation. At ~5–7% of a 60Hz frame budget the gutter was a real
but *not dominant* slice of the scroll floor (native GTK/GSK text render is still
the floor); the win grows with viewport height and on slower hardware. Benches:
`src/poc/gutter-bench.ts` (headless layout cost), `src/poc/gutter-visual.ts`
(snapshots the composite gutter to a PNG for visual verification).

**How it composes.** One renderer's `queryData` builds a single markup string per
line: right-justified line number (`<span>` muted), a space + chevron, then the
git-bar and diagnostic-glyph cells (each a `<span>` the owning controller hands
over, or a space on clean lines so a bar/glyph appearing later doesn't shift the
text column — monospace makes the column math exact). `GitGutter`/
`DiagnosticsView` keep all their own logic (diff/hunks, severity map); they just
write a cell function instead of inserting a renderer. Disposal:
`SyntaxController` removes the renderer + nulls the cell closures on `dispose`,
and the `setGitCell`/`setDiagCell(null)` paths guard against running after the
controller is gone (tab-close detaches, never destroys — see
lifecycle-and-disposal.md).

Background — GtkSourceView's author profiled exactly this; two findings reframe
where the native scroll floor sits:

- **GTK4 caches the text's render nodes** (`GtkTextLineDisplay`), so scrolling
  *translates* cached per-line nodes rather than re-rendering them — the text
  itself is cheap. The per-frame native cost concentrates in what *isn't* cached:
  the **gutter renderers** (a `PangoLayout` per line, per renderer) and our
  overlay `DrawingArea`s (already optimized). ([GtkSourceView
  Next](https://blogs.gnome.org/chergert/2020/09/22/gtksourceview-next/))
- **Line numbers alone cost "double-digit CPU %"** during kinetic scroll, because
  each line's number went through `PangoLayout` measure+render. The fix — cache
  digit `0–9` glyphs once, build a `PangoGlyphString`, draw via
  `gsk_text_node_new()` instead of `gtk_snapshot_render_layout()` — lives in
  GtkSourceView's **built-in** line-number renderer, which **we bypass** (we use a
  custom `GtkSourceGutterRendererText` for fold-aware model→view numbering).
  ([Faster
  Numbers](https://blogs.gnome.org/chergert/2024/01/20/faster-numbers/))

**The `gsk_text_node` digit-cache is not worth pursuing as a node-gtk JS
renderer.** We prototyped the base-`GtkSourceGutterRenderer` + manual
`snapshot_line` approach (branch `feat/gutter-cell-background`, not merged) and
benchmarked it: **drawing the gutter from JS via node-gtk is a net perf
_regression_.** node-gtk *can* do it (overriding `snapshot_line` + `measure`
fires; `appendColor` / `appendLayout` / `alignCell` / `getLineYrange` reachable;
we also added a `super.<vfunc>()` chain-up to node-gtk, PR
romgrk/node-gtk#451 — macOS chain-up gap tracked in node-gtk#453). But
`GtkSourceGutterRendererText` draws each line **in C** behind one `queryData`
callback, whereas a JS `snapshot_line` crosses JS→C **~6× per line** (`alignCell`
+ `save` + `translate` + `appendLayout` + `restore`, plus a `Graphene.Point`
alloc) — measured ~165–210 µs/frame for the number column alone, which
**outweighs** the ~51 µs/frame a markup-free `setText` number saves. The per-
frame node-gtk FFI *is* the scroll floor; moving drawing into JS multiplies it.
To beat the C markup renderer you'd draw in C, not JS (out of scope). Also not
applicable: the [PCRE2 +
JIT](https://blogs.gnome.org/chergert/2020/09/30/gtksourceview-gets-a-jit/) work
optimizes the `.lang` regex engine we don't use.

**The snapshot-API gutter is a _control_ feature, not a perf one.** What it buys
that the C markup renderer can't: arbitrary per-row drawing (backgrounds /
content beside **block decorations** via `getLineYrange(CELL)`), and a path to a
**clickable** gutter. Clicking is separate from drawing — either override
`activate` / `query_activatable` (line-granular; `activate` carries no pointer-x,
so one composite renderer can't tell which column was hit), or attach a
`GtkGestureClick` to the gutter widget and hit-test x→column / y→line yourself
(full per-column, recommended). The working prototype lives on
`feat/gutter-cell-background`; the main editor (no block decorations) keeps the C
markup composite, paying neither the FFI cost nor gaining drawing it doesn't
need.

## Related friction evidence

[inline-widgets.md](inline-widgets.md),
[document-registry.md](document-registry.md),
[virtual-lines.md](virtual-lines.md), [decorations.md](decorations.md),
[folding.md](folding.md), [diff.md](diff.md), [multibuffer.md](multibuffer.md).
