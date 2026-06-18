# Editor decoration layers

The editor's decoration surfaces, modeled on **Atom's decoration `type`s** so the
vocabulary is shared and a new feature reuses a surface instead of inventing an
ad-hoc one. Naming convention: no `Controller` suffix; the class is named for *what
it is* (the decoration kind), in `src/ui/TextEditor/`.

Atom's types are `line`, `line-number`/`gutter`, `highlight`, `cursor`, `overlay`,
`block`, plus inline/trailing `text`. Mapped onto our surfaces:

| Atom type | Our surface | Mechanism | Consumers |
|---|---|---|---|
| **line** | `TextDecorations` (`LineStyle`) | `GtkTextTag` paragraph-background, layered | diff add/remove/filler, diff fold-row |
| **highlight** | `TextDecorations` (`HighlightStyle`) | `GtkTextTag` char-background, layered; `UnderlineOverlay` for drawn squiggles | search, word-diff, vim flash/occurrence, picker-match; **diagnostics squiggles** |
| **gutter / line-number** | per-renderer `GtkSource.GutterRendererText` | a glyph per line | line numbers + fold chevron (`SyntaxController`), git change bars (`GitGutter`), diagnostic severity (`DiagnosticsView`), diff +/− (`DiffGutter`) |
| **cursor** | `EditorModel` (`cursorTag`, `extraSelectionTag`) | tag + native | vim block cursor, multi-cursor, native selection |
| **text** (trailing/virtual) | `VirtualText` | `GtkSourceAnnotations` (EOL) | inlay hints, error lens |
| **text** (mid-line virtual) | the fold projection (`Document.foldViewRange`) | view-only text in the view buffer | fold `[N]` placeholder — see below |
| **overlay** | `OverlayDecoration`, `Peek`, `Leap` | `Gtk.Overlay`/`Gtk.Fixed` child at a marker, scroll-following | hover, signature help (`OverlayDecoration`); see-definition (`Peek`); leap marks (`Leap`); completion (`CompletionController`, own positioning) |
| **block** | `BlockDecorations` | text-window overlay widget that reserves a vertical band | diff `⋯ N unchanged lines` |

## The two text-tag categories (`TextDecorations`)

`TextDecorations` is the shared tag surface — named, clearable **layers**, each
producer re-syncing its full set on update. Its `DecorationStyle` splits into Atom's
two range categories:

- **`LineStyle`** (`added`/`removed`/`filler`/`fold`) — paints the *whole line*
  (paragraph background).
- **`HighlightStyle`** (`highlight`/`word-add`/`flash`/…) — paints a *character range*.

`decorate(range, style)` takes either built-in style; `LINE_STYLES` picks paragraph-
vs char-background. For colors that *aren't* a fixed style (plugins), `tint(range,
{ background, foreground?, wholeLine? })` paints an arbitrary tint — a char range by
default, or a whole-line paragraph background with `wholeLine: true`. So the fixed
`DecorationStyle` set is just the built-in vocabulary; generic line **and** highlight
decorations are open to any producer via `tint`.

The drawn diagnostic squiggle (`UnderlineOverlay`) lives **inside** `TextDecorations`
(pushed via `setUnderlines`) — it's just another highlight, so a producer never
touches the overlay directly. (It's a Cairo overlay, so it tracks scroll/edits by
re-binding `value-changed` on `notify::vadjustment` + repainting on buffer `changed`.)

## Virtual text — EOL *and* mid-line

Two flavors of "text shown but not in the model":

- **End-of-line** trailing text — `VirtualText` (`GtkSourceAnnotations`): inlay hints,
  error lens. Line-anchored, no column control.
- **Mid-line** view-only text — the **fold projection** already does this: the fold
  `[N]` placeholder is real text in the *view* buffer (not the model), inserted
  mid-line (`import {[N]} from 'x'`). So true column-positioned virtual text *is*
  available via `Document.foldViewRange` + the view↔model translation — inlay hints
  currently use the simpler EOL path, but could move mid-line on this mechanism.

## overlay vs block

- **`overlay`** — a floating widget positioned at a buffer point that *follows scroll*
  and dismisses, without taking layout space. `OverlayDecoration` is the shared base
  for the cursor-anchored cards (hover, signature; the natural home for future
  code-lens / peek-references popups). `Peek` (focusable, sibling overlay) and `Leap`
  (mark layer) are specialized overlays; completion has its own dropdown positioning.
- **`block`** — `BlockDecorations`: a real widget *between* lines, reserving vertical
  space (zero buffer footprint). The diff's `⋯ N lines`. See
  [inline-widgets.md](inline-widgets.md).

## The model↔view boundary (folds)

Any decoration positioned from **model/LSP coordinates** must translate model→view
*and* re-render on `SyntaxController.onFoldsChanged`, because folds collapse text so
view lines diverge from the file (`DiagnosticsView`, `VirtualText`/inlay hints,
`GitGutter` all do this). This is the standing cost of view≠model — see
[folding.md](folding.md) → "Boundary rule".

## Adding a decoration — which surface?

- background over text → `TextDecorations` (`line` whole-line, `highlight` range).
- a glyph in the gutter → a `GutterRendererText`.
- trailing text after a line → `VirtualText`; column-positioned text → the projection.
- a floating card at the cursor/a line → `OverlayDecoration` (or `Peek` if focusable).
- a real widget between lines → `BlockDecorations`.

Don't add a new ad-hoc overlay/layer when one of these fits.
