# Text editor widget

> Evaluation for index.md → "Code editing → Text editor": *"Consider a custom
> widget or a fork of GtkSourceView … multiple cursors, rectangular selection,
> better performance with large files. Consider a JS widget, or a Rust widget
> with a JS wrapper."*

The question is **whether to keep building on `GtkSource.View` or own the text
widget**, judged against the features a full editor needs. The short answer:
**stay on GtkSourceView and emulate the two things it can't do natively
(multi-cursor, block-select) on the seam the editor model already exposes**;
treat a custom widget as a gated escape hatch, not the next step. The rest of
this page is the evidence for that, and what each path actually costs.

This updates the earlier conclusion (keep `GtkSource.View`, proven for
tree-sitter highlighting + tag-based folding) by extending it to the three
harder features the task names.

## Current state (what already sits on the widget)

Reused, not rebuilt — see `src/ui/TextEditor/`:

- **`TextEditor.ts`** — `GtkSource.View` + `GtkSource.Buffer`, tree-sitter
  highlighting + `invisible`-tag folding (`SyntaxController`), a `GtkSource.Map`
  minimap, file I/O, and modal editing (vim, or `GtkSource.VimIMContext` behind a
  toggle).
- **`EditorModel.ts`** — an Atom-`TextEditor`-shaped model over the buffer
  (`Point`/`Range`, scanning, markers, mutation, undo). **It already surfaces
  `getCursors()` / `getSelections()` / `getCursorsOrderedByBufferPosition()` as
  arrays**, today 1-element because `GtkTextBuffer` has a single
  `insert`/`selection_bound` mark pair. The vim port deferred multi-cursor here
  on purpose — *this array API is the seam the multi-cursor work plugs into.*
- **`MarkerLayer.ts` / `Marker.ts`** — markers backed by anonymous
  `GtkTextMark`s with gravity, the primitive a real multi-cursor implementation
  needs (extra cursor/selection mark pairs live here).

So the editor's *logic* layer is already abstracted away from "one cursor"; only
the *backing* (one mark pair) and *rendering* (one native caret) are single-cursor.

## Feature checklist vs. GtkSourceView

| Feature | On GtkSourceView | Notes |
|---|---|---|
| Syntax highlighting (tree-sitter) | **Built** (ours) | `setHighlightSyntax(false)` + own `TextTag`s. Upstream is regex `.lang` only; tree-sitter is discussed but unmerged (gtksourceview#124). |
| Code folding | **Built** (ours) | No upstream fold API in GtkSource 5; we use the `invisible` `TextTag`. |
| Gutter (line nums, diagnostics, git bars, breakpoints) | **Native** | `GtkSourceGutterRenderer`; Builder's omni-gutter is the model. |
| Inline virtual text / diff / blame / inlay hints | **Native-ish** | `GtkSourceAnnotations` (since 5.18); fallbacks: `TextChildAnchor`, `insert_paintable`, overlays. Exact annotation rendering unverified. |
| Diff display (inline + side-by-side) | **Doable** | Inline via annotations/virtual text; side-by-side via two synced views + blank regions. (index.md item.) |
| Search UI | **Doable** | `GtkSource.SearchContext` exists; or own box wired to vim `/`. |
| Minimap | **Native** | `GtkSource.Map` (already used). |
| Multiple cursors | **Emulate** | No native support — `GtkTextBuffer` has one mark pair. Proven on-top (see Option A). |
| Rectangular / block / column selection | **Emulate** | No native support; depends on the same multi-cursor infra. |
| Large line *counts* (M+ lines) | **Native, fine** | Only visible paragraphs are laid out. |
| Pathological long *single* lines (minified) | **Unfixable** | The one hard wall — see constraints. |
| IME / bidi / a11y / clipboard / DnD | **Native, free** | The expensive-to-rebuild subsystems all come for free here. |

The decisive rows: the features GtkSourceView *can't* do natively are
multi-cursor, block-select, and long-line performance — and exactly those trace
to two parts of GtkTextView you can't override (the single mark pair and the
per-paragraph Pango layout).

## Options

### Option A — Stay on GtkSourceView, emulate the gaps **(recommended)**

Keep the widget; build multi-cursor and block-select on top, the way **GNOME
Builder already does**: a list of virtual cursors, each its own
`insert`+`selection_bound` `GtkTextMark` pair, extra carets drawn via
`set_visible()` + a highlight `TextTag` (or a `snapshot_layer` pass), every edit
replayed per cursor in an *after*-handler (`ide-cursor.c`). Rectangular
selection falls out of the same infra (a column of virtual cursors).

In quilx this lands **on the existing seam**: grow `EditorModel`'s
`getCursors()`/`getSelections()` from 1-element to N-element arrays backed by
`MarkerLayer` mark pairs, and the vim layer (which already iterates those arrays)
gets multi-cursor largely for free.

- **Pros:** keeps the entire built stack (vim, tree-sitter, folding, minimap,
  file I/O); IME/bidi/a11y/clipboard stay free; lands incrementally on an
  already-prepared API; lowest risk.
- **Cons:** emulated multi-cursor is real, maintenance-heavy code that fights a
  one-cursor buffer (Builder's has filed edge-case bugs: dismissal, write-without-
  delete, keybinding conflicts); doesn't fix long single lines.
- **Effort:** medium. **Risk:** low–medium (correctness of edit-replay).

### Option B — Fork GtkSourceView

Patch a real multi-mark / block-selection model into the C widget.

- **Verdict: reject.** Inherits C + a fork to maintain against upstream, and the
  hardest part (long-line Pango layout) still isn't fixed because it lives in
  GTK's `GtkTextView`/`GtkTextLayout`, below GtkSourceView. Worst of both — fork
  cost without solving the thing only a new widget solves. Also off-path for a
  JS/node-gtk codebase.

### Option C — Own the widget (custom GTK4 text widget)

A from-scratch `GtkWidget` whose `snapshot()` paints code via Pango/GSK. This is
the only path that fixes long lines *and* makes multi-cursor/block-select native.

The research is encouraging on **rendering** and sobering on **everything
around it**:

- **Rendering is the safe part.** GTK4 already gives the two things GPU editors
  hand-roll: a glyph texture atlas and retained render-node caching (`snapshot()`
  runs on invalidation, not per frame). **VTE** is the proven GTK4 reference
  (custom monospace grid via `gsk_text_node_new` + `append_color`, its own
  `GtkScrollable`, `GtkIMMulticontext`, frame-clock redraws). Per-line
  PangoLayout/node caching + viewport culling is the documented strategy.
- **node-gtk can drive it from JS.** Subclassing `Gtk.Widget` and overriding
  `snapshot()` from JS is demonstrated in the node-gtk repo
  (`examples/gtk-4-custom-widget.js`). Subject to our known constraints
  (instantiate after the main loop, ≥3-char GType name, camelCase→snake_case
  vfunc mapping).
- **The hard, expensive subsystems you'd rebuild:** the private `GtkTextLayout`
  middle layer (per-line layout cache, viewport virtualization, display-line vs
  paragraph, height index) — the largest single cost; **IME** (consume
  `GtkIMMulticontext`, but preedit splicing + `filter_keypress` ordering are
  fiddly); **bidi**; **a11y** (`GtkAccessibleText`, needs GTK ≥ 4.14). These are
  precisely what GtkSourceView gives for free.
- **The open risk:** per-frame JS↔native FFI cost of doing `snapshot()` from
  node-gtk is **unmeasured**. Mitigated by GTK's invalidation model (paint on
  edit/scroll/blink, not 60 fps) and per-line node caching, but unproven here.

Sub-shapes, if Option C is ever taken:

- **C1 — JS-only snapshot widget.** Rope/parse/multi-cursor model in TS, render
  in JS. Simplest interop (no second language/runtime).
- **C2 — Rust core + JS rendering (the "Rust widget" the task floats, done
  right).** Rust **core** (`ropey` + tree-sitter + tree-sitter-highlight +
  multi-cursor/selection model) as a napi-rs Node addon supplying text,
  highlight spans, and cursor geometry; the **GTK4 widget stays JS/node-gtk**
  doing `append_layout` rendering. Keeps one main loop, one thread, no GObject
  handoff, no GIR generation — lowest-risk way to get a Rust core. No prior art
  pairs a Rust core with GTK4 custom rendering, but every piece is individually
  proven.
- **C3 — fully-Rust gtk-rs widget exposed via GIR.** **Reject.** Works in
  principle (precedent: `rdw`) but needs a manual C-header → `g-ir-scanner` →
  typelib pipeline the gtk-rs toolchain won't automate; the pointer-handoff
  alternative needs a node-gtk patch (`WrapperFromGObject` isn't exported to JS)
  and has zero precedent. Cost without payoff for an app that owns both sides.

- **Effort (C1/C2):** very large. **Risk:** high (layout-cache rebuild, IME/bidi/
  a11y correctness, FFI perf). Telling signal: **no major Rust editor uses GTK** —
  Zed/Lapce/COSMIC all went GPU-direct, Helix is a TUI; the fast GTK editors
  (GNOME Text Editor, gedit) are C-on-GtkSourceView.

## Recommendation (staged)

1. **Now: Option A.** Multi-cursor and rectangular selection via virtual
   cursor/selection mark pairs on `MarkerLayer`, surfaced through
   `EditorModel.getCursors()/getSelections()` (already array-shaped) and rendered
   with a `snapshot_layer` / `TextTag` pass. Unblocks both named features with no
   rewrite and no loss of the vim/syntax/fold investment.
2. **Long lines: accept the upstream guard.** Adopt GtkSourceView's own
   posture — detect and warn/refuse to fully load pathological single-line files
   rather than hang. Revisit only if real workloads make it intolerable.
3. **Keep Option C as a gated escape hatch.** Pursue only if native multi-cursor
   or long-line editing becomes non-negotiable. If so: **C2** (Rust core + JS
   snapshot widget), and **gate it behind a one-day node-gtk `snapshot()` FFI
   perf spike** (render ~50 visible lines, measure frame time + invalidation
   cadence) before committing. **Never C3.**

## Constraints carried from the research (cited; mark-uncertain noted)

- **Single mark pair.** `GtkTextBuffer` has exactly `insert` + `selection_bound`
  — one cursor, one selection — unchanged in GTK4. No native multi-cursor or
  rectangular selection. (docs.gtk.org `class.TextBuffer`; GtkSourceView
  PainPoints wiki.)
- **Multi-cursor is proven on top, and fragile.** GNOME Builder's `ide-cursor.c`
  (parallel mark pairs + per-cursor edit replay). GNOME Text Editor still lacks
  it; described upstream as needing "deep changes into GtkSourceView"
  (gnome-text-editor#253). *Uncertain:* GTK4-era Builder impl details.
- **Long single lines are the one unfixable wall.** Each paragraph is one
  indivisible `PangoLayout`, so a giant line defeats visible-only layout; gedit
  FAQ calls it "a known limitation of GtkTextView [that] cannot be fixed easily,"
  and GtkSourceView's loader may refuse such files (gtk#229, gtksourceview#95 /
  #208). Large line *counts* are fine. *Uncertain:* GTK4 crash status, loader
  thresholds, exact big-O.
- **No upstream tree-sitter or fold API** in GtkSource 5; both are ours already
  (highlighting via PCRE2+JIT `.lang` upstream; folding via `invisible` tag).
- **Extensibility is additive, not replaceable.** Gutter renderers, `TextTag`s,
  `snapshot_layer` (BELOW/ABOVE text), `GtkSourceAnnotations` (≥5.18) cover
  gutter/inline/virtual-text needs — but you cannot replace the per-line Pango
  layout, which is the part owning the widget would be *for*.
- **Custom rendering is well-supported; the surround is the cost.** GTK4 atlas +
  retained nodes make glyph painting cheap (VTE proves the GTK4 path; node-gtk
  proves the JS `snapshot()` override). The bulk is rebuilding the private
  `GtkTextLayout` (layout cache + viewport virtualization) plus IME / bidi /
  a11y. *Uncertain (flagged for a spike):* per-frame node-gtk FFI cost; exact
  `appendLayout` wrapper name.
- **Rust-in-process is realistic but not turnkey.** One libgtk + one GType
  registry + one main loop (node-gtk's) supports co-residency, but exporting a
  Rust gtk widget needs a manual GIR/typelib pipeline (C2 sidesteps this by
  keeping rendering in JS and Rust as a pure-logic napi core). Best Rust building
  blocks: `ropey`, tree-sitter + tree-sitter-highlight; **avoid** cosmic-text
  inside GTK (redundant with Pango, bypasses GTK's accelerated text path).
  *Uncertain:* no project proves "Rust core + GTK4 custom snapshot widget" end to
  end — recommendation is assembled from individually-proven pieces.

## Editor seams other features depend on

Since the widget stays on GtkSourceView, the work is a small set of shared
primitives in the editor layer that the other features (LSP, diff, search, vim
polish, multi-cursor) plug into. Status:

- [x] **Buffer change events** — `EditorModel.onDidChangeText` (Atom
  `{changes:[{oldRange,newRange,oldText,newText}]}` shape), backed by the
  buffer's `insert-text`/`delete-range` signals (extents computed pre-edit) and
  flushed post-mutation on `changed`. Replaced the former inert stub. Consumers:
  vim undo/redo (`misc-command.js`), LSP `didChange` (`TextEditor.installLsp`),
  and the future multi-cursor edit-replay. (`EditorModel.ts`, tests in
  `EditorModel.test.ts`.)
- [x] **Viewport + pixel geometry** — `getFirstVisibleScreenRow` /
  `getLastVisibleScreenRow` (visible buffer rows) and `pixelRectForBufferPosition`
  (widget-relative cell rect for anchoring popovers). Realized-view-guarded with
  whole-buffer / null fallbacks; the realized paths (`getVisibleRect`/
  `getLineAtY`/`getIterLocation`) need interactive verification. Consumers: LSP
  hover & code-action popovers, vim H/M/L + scroll commands, side-by-side diff
  scroll-sync. (`EditorModel.ts`.)
- [x] **Inline decoration surface** — `DecorationController` / `DecorationLayer`
  (`editor.decorations`): clearable, named layers of GtkTextTag *background* spans,
  re-synced by their producer. Styles: `highlight`/`highlight-strong` (search),
  `added`/`removed` (diff). Tags sit above syntax priority. (`DecorationController.ts`,
  tests in `DecorationController.test.ts`.)
- [x] **Drawn-underline overlay** — `UnderlineOverlay`: a transparent
  `Gtk.DrawingArea` over the text that strokes anti-aliased Cairo sine waves under
  buffer ranges, replacing GtkTextTag's fixed dense `Pango.Underline.ERROR`
  squiggle. Used by `DiagnosticsView` for diagnostic squiggles (gutter glyphs stay
  a Nerd-Font `GutterRendererText`). Wave amplitude/wavelength are tunable
  constants; the drawn result needs interactive verification (no headless render).
  Inline virtual text (`GtkSourceAnnotations`, 5.18+ — we're on 5.20) lands with
  its consumers. (`UnderlineOverlay.ts`, test in `UnderlineOverlay.test.ts`.)
- [ ] **Virtual lines & inline virtual content** — *investigated, not built.* See
  [virtual-lines.md](virtual-lines.md): line-trailing text via `GtkSourceAnnotations`,
  general virtual lines via a `pixels-above/below` gap-tag + buffer-coord overlay
  (`VirtualLineController` primitive). Wanted by inlay hints, error lens, git
  blame, code lens, AI ghost text, and live inline diff. POC recommended.

## What's next (recommended order)

The shared primitives above are done, so the remaining work is features that sit
on them. Ordered by value-given-readiness:

### 1. Search — *done*

- [x] **Search engine** — `SearchController` (`SearchController.ts`): incremental
  literal/regex search over the buffer via `EditorModel.scan`, `highlight` on all
  matches + `highlight-strong` on the current one through `editor.decorations`,
  nearest-from-origin seating, `next`/`previous` (direction-aware), cancel-restores-
  origin, and replace-current / replace-all (regex backrefs). Headless tests in
  `SearchController.test.ts`.
- [x] **SearchBar widget** — `SearchBar.ts`: a compact bar floating top-right
  (`Gtk.Overlay`, theme popover background). One horizontal row: the search and
  replace `Gtk.Entry`s (both always shown, linked into one control, monospace,
  fixed-width so the match count can't reflow them), then the count, a 3-way case
  button (smart / sensitive / insensitive), and a regex toggle. Regex mode adds
  inline regex/`$`-ref syntax highlighting in both inputs (`regexHighlight.ts`,
  Pango attributes). Options toggle by key — **Alt+S** cycles case, **Alt+R**
  toggles regex (shown in tooltips; Alt+C was taken by `tab:close`). Incremental
  highlight + cursor preview; in search **Enter/Shift+Enter** step (relative to
  the cursor), in replace **Enter** replaces the current match and **Ctrl+Enter**
  replaces all. **Esc** confirms at the current match (returns to origin only when
  there's no match); focus-out (click into editor) confirms. While the bar holds
  focus the editor keeps its active caret (no inactive-caret flicker).
- [x] **Vim `/` `?` `n` `N`** — `/`/`?` open the bar (forward/backward), `n`/`N`
  repeat the last search relative to the cursor (`TextEditor.installSearch`,
  normal-mode keymap). Smartcase is the default case mode.

Not yet (search refinements, low priority): `*`/`#` word-under-cursor search;
search history; operator-pending `d/foo<CR>` (search as a motion); `:%s///` via the
ex command line (below).

### 1b. Command line (`:` ex-commands) — *WON'T DO* (decided 2026-06-14)

We are **not** building a vim `:` ex-command line. The commands it would have
restored are already reachable elsewhere: save via `space w` (`file:save`),
close via `tab:close` / `pane:close`, open via `space o` (the fuzzy file picker),
and search/replace via the SearchBar. So `:w`/`:q`/`:e`/`:%s` are covered without
a modal command prompt, and the `command-bar-text`/`command-text` status the
removed `VimIMContext` emitted stays gone.

### 2. Multi-cursor / blockwise — *done*

The widget-evaluation's marquee feature, built on Option A as planned.
`getCursors()`/`getSelections()` are N-element over `MarkerLayer` mark pairs;
`hasMultipleCursors`/`mergeCursors`/`mergeIntersectingSelections`/
`onDidAddSelection` are real (no longer stubs), and `Selection.onDidDestroy`
backs per-selection register clipboard. Entry points: blockwise `ctrl-v`,
occurrence `c o p`, and persistent `ctrl-alt-↑/↓` add-cursor (`escape` collapses).
Extra carets render as reverse-video block tags in normal/visual and host-drawn
beam carets in insert (`onExtraCursors` → a caret-widget pool in `TextEditor.ts`).
Multi-cursor operations coalesce into one undo step (`mutateSelections` in one
`transact`); insert is **live-replicated** to every cursor — each typed
chunk/backspace is mirrored on a deferred microtask (off the `changed` signal, to
avoid invalidating the in-flight edit's iters). Tests: `blockwise.test.ts`,
`multicursor.test.ts`, `occurrence.test.ts`.

Remaining (in-app verification / edges): beam-caret visuals + `ctrl-alt-arrow`
keys can't be tested headless; an insert *session* undoes in a couple of steps
(the native keystroke and the mirror flush are separate GTK user actions);
replication covers insertions + single-line backspaces, with multi-line deletes /
mid-text replacements falling back to the leave-insert replay.

### 3. Quick cleanups — *any time*

- [x] **Fold-aware motions** — `EditorModel.isFoldedAtBufferRow`/`unfoldBufferRow`
  now delegate to `SyntaxController` (via a `FoldProvider` the host wires in with
  `setFoldProvider`), so the vim motions that consult them (`motion.js`/`utils.js`)
  skip past and reveal folded rows instead of treating the buffer as unfolded.
- [x] **Buffer-only editor mode** — `new TextEditor({ buffer: { placeholder,
  initialText, onSubmit } })`: no file I/O / LSP / line-numbers / minimap, keeps
  vim + syntax + search, a greyed placeholder over the empty buffer, `getText`/
  `setText`, and Ctrl+Enter → `onSubmit`. For the Git commit-message editor.
- [x] **Column-unit reconciliation** — convention pinned to **codepoint** columns
  (matching `GtkTextIter` + `lsp/position.ts`). Fixed the UTF-16 holdouts that fed
  Points: `EditorModel.pointAtTextOffset` (scan/search), the `.length`-as-column
  sites in `Cursor.ts` + vendored `operator.js` (via new `EditorModel.lineLength`),
  and `searchWordUnderCursor`. Tests with emoji/astral chars in `EditorModel.test.ts`.
  Tree-sitter highlighting is also reconciled: `SyntaxController.iterAt` converts
  web-tree-sitter's UTF-16 columns to codepoints, gated on a per-refresh
  `hasAstral` check so BMP-only files (the norm) pay nothing. *Remaining holdout:*
  the incremental-parse edit tracking (`onInsert`/`onDelete`) still mixes codepoint
  iter offsets with UTF-16 string lengths, so editing right next to an astral char
  can feed tree-sitter a slightly-wrong edit — rare; its own task.
- [x] **Vim polish** — `H`/`M`/`L` screen motions and `ctrl-f/b/d/u/e/y` scroll
  commands, flash-on-operate, and **`=`/`==` auto-indent** are done. `=` re-indents
  to a real tree-sitter indent source: `SyntaxController.indentLevelForRow` counts
  enclosing fold-block nodes (`syntax/indent.ts`), injected into the editor via
  `EditorModel.setIndentSource` (falls back to copy-the-line-above when no grammar);
  it also improves paste-reindent.
- [x] **Matching brackets** — highlights the bracket under (or just before) the
  cursor and its pair, or — when the cursor sits *inside* a pair (not adjacent) —
  the innermost *enclosing* pair, so the brackets stay lit as you move between them
  (`syntax/bracketMatch.ts` + a cursor-driven tag in SyntaxController). Brackets
  inside strings/comments/regex are ignored (`SyntaxController.isInStringOrComment`,
  via `indent.ts` `enclosingTypeMatches`).
- [x] **Indent guides** — faint vertical lines per indentation level, drawn in the
  leading whitespace (`IndentGuideOverlay`, a Cairo overlay like the diagnostic
  squiggles). Levels follow the actual indentation and continue unbroken through
  blank lines inside a block. Toggle with `editor.indentGuides`.
- [x] **Tree-sitter text objects** — `if`/`af` (function), `ic`/`ac` (class /
  interface / enum), `ia`/`aa` (arguments). Backed by `SyntaxController`'s
  `functionRangeAt`/`classRangeAt` (the generic `enclosingNodeRange` in `indent.ts`,
  outer = whole def, inner = body), surfaced via `EditorModel.getFunctionRange`/
  `getClassRange` to the vim `Function`/`Class` text objects.
- [x] **Folds query** — folding is driven by a grammar's `folds.scm` (`@fold`
  captures, incl. multi-line comments; `GrammarDef.foldsPath`, compiled to
  `Grammar.foldsQuery`) when present, else the `foldTypes` set. Plus **run folds**:
  consecutive import statements / line comments collapse to their first line. Pure
  `computeFoldRanges` (`syntax/folds.ts`, unit-tested); `foldTypes` is retained for
  the indent source. TS ships `queries/{typescript,tsx}/folds.scm`.
- [x] **JSX/HTML tags** — *auto-close*: typing `>` to finish an opening tag inserts
  `</name>` and sits between them (`tagClose.ts`, pure + unit-tested). Text-based
  (the tree is debounced) with a JSX-vs-generics heuristic (the `<` must not follow
  an identifier) and a tag-language gate (`tsx`/`html`/… — so plain `.ts` generics
  never close). Fragments → `</>`. *Co-rename*: the `tag:rename` command renames
  both halves of the pair (or a self-closing tag) in one undo step, via
  `SyntaxController.tagNamesAt` (tree, `syntax/tags.ts`, unit-tested) + a prefilled
  prompt. (Live linked-editing — mirror as you type — is a possible follow-up; it
  needs mark-tracking across the tree's mismatch gap.)

### 4. Diff display — *investigated; sequence with Git*

See [diff.md](diff.md) for the editor-side investigation. Conclusion: render both
unified and side-by-side from **synthesized read-only buffers** (the alignment
fillers / deleted lines are real padded lines, styled via `editor.decorations`),
which sidesteps GtkTextView's lack of virtual lines and reuses the buffer-only +
decoration + scroll-sync primitives already landed. No new widget primitive is
required; the editor-side gaps are small (read-only mode, a diff gutter renderer,
a couple of decoration styles, scroll-sync, hunk nav). The real dependency is the
diff *data*, which comes from the **Git** workstream — so build it alongside Git.
