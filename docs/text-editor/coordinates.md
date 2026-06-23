# Editor coordinate spaces: document / buffer / screen

The canonical vocabulary for editor positions. Every `(row, column)` in the
text-editor stack lives in exactly one of three spaces; method names translate
between them with Atom's `XForY` convention (`screenPositionForBufferPosition`,
`bufferRowForScreenRow`, …). This page is the source of truth for the names —
code and the other text-editor docs are being migrated onto it (see
[Current state](#current-state-wip) and [VIM-PLAN.md](../../VIM-PLAN.md)).

## The three spaces

```
document  ──stitch (N→1)──▶  buffer  ──folds + soft-wrap──▶  screen
per-file source of truth     the editor's content           what's displayed
(Document model)             (multibuffer of excerpts)       (folded, wrapped)
```

- **document** — one source file's text, the headless `Document` model buffer
  and undo/LSP authority. Identified by a source key (path / blob id). The
  language server, file I/O, and go-to-definition speak *document* coordinates.
- **buffer** — the editor's logical content: N documents stitched into one
  stream (the multibuffer). A normal single-file editor is the degenerate case —
  one full-file excerpt, so `buffer` is identity to its one `document`. This is
  Atom's "buffer"; **vim / `Cursor` / `Selection` / `EditorModel` operate here.**
- **screen** — what is actually shown: `buffer` with code folds (tree-sitter)
  and soft-wrap applied. Atom's "screen". Scrolling, visible-row range, caret
  pixels, and display-line motion (`gj`/`gk`) speak *screen* coordinates.

## Transforms and where they live

- **document ↔ buffer** — the multibuffer stitch (segment map) in
  `ViewProjection`. Single file = identity, short-circuited.
- **buffer ↔ screen** — code folds (the `ViewProjection` fold transform,
  materialized into the view buffer) plus soft-wrap (GtkSourceView at render
  time; pixel geometry for `gj`/`gk`).

## Who speaks which space

| Layer | Space |
|---|---|
| LSP, file I/O, `Document`, go-to-def | document |
| vim, `Cursor`, `Selection`, `EditorModel`, marks, mutation | buffer |
| scroll / viewport, gutters, fold rendering, caret pixels | screen |

## Two deliberate inversions

Read these — both are intentional and will mislead if you assume otherwise.

1. **`buffer` is the stitched multibuffer, not a single file** — the opposite of
   Zed's convention (where `buffer` = one file, `multibuffer` = the stitch). We
   follow Atom because the vendored vim layer does; a single source file is one
   full-file **excerpt** of the buffer.
2. **`GtkSource.Buffer` is storage, not a coordinate level** — GTK is an
   implementation detail. The headless `GtkSource.Buffer` stores `document`; the
   materialized view `GtkSource.Buffer` stores `screen`. The `buffer` space
   itself is logical (computed by `ViewProjection`) with no dedicated
   `GtkBuffer`. Never infer a coordinate level from a GTK buffer field name.

## Current state (WIP)

The vocabulary above is the target; the code is mid-migration.

- The projection code still uses pre-unification names: `ViewProjection` calls
  the spaces **source / projection / view**, and the fold `FoldHost`
  (`SyntaxController`) calls them **model / view**. Mapping: `source` & `model` →
  **document**, `projection` → **buffer**, `view` → **screen**.
- `EditorModel` / `Cursor` / `Selection` operate directly on the materialized
  *view* buffer and treat `screen` = `buffer` = identity (the `*ForScreenPosition`
  methods are clamp-only stubs). Correct only with no fold or wrap active; the
  vim layer "ignores folds" as a consequence.
- Soft-wrap is GTK-rendered; only `gj`/`gk` thread it (via pixels), not the
  Point-based screen coordinates.
- **Target:** `EditorModel` speaks `buffer` and delegates `buffer ↔ screen` to
  `ViewProjection` (folds) + GTK (wrap); the vendored vim layer keeps its Atom
  `buffer`/`screen` method names unchanged.

## Old → new name map

| Old (in code/docs) | New |
|---|---|
| `source`, `model` | `document` |
| `projection`, `proj` | `buffer` |
| `view` | `screen` |
