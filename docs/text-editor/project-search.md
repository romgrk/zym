# Project search

Project-wide ripgrep search, behind one streaming backend shared by two surfaces.

## Backend

`src/ui/multibuffer/projectSearch.ts` is the single backend. `searchProject(cwd,
query, options, callbacks)` streams `rg --json` matches as they arrive and returns
a handle to cancel the in-flight rg (a new query cancels the previous one). It runs
through the **streaming** process runner (`runProcessStream`, see
[../process-runner.md](../process-runner.md)). `ProjectSearchOptions` (case / whole-word
/ regex / hidden, plus one `globs` field where a `!`-prefixed glob excludes, matching rg)
maps to rg args via `buildRipgrepArgs`. `runProjectSearch` is a buffered convenience over
the same stream.

## Surfaces

Two distinct entry points; same backend, options, and presets.

- **Picker** (`src/ui/SearchPicker.ts`, `space /`) — a quick-jump
  [LocationPicker](../../src/ui/LocationPicker.ts) with a source preview. Results
  append progressively as rg streams; the entry row carries case/word/regex option
  chips (a Picker `headerAccessory`), and flipping one re-runs the search.
- **Full view** (`src/ui/ProjectSearchView.ts`, `space p s`; `space *` seeds it with
  the selection) — the editable [multibuffer](multibuffer.md) results surface
  (`SearchResultsView`), with one options row (flag toggles, a single glob field, a presets
  combo). It grows in place as matches stream: each refresh **appends** the new files' rows
  (`Screen.appendItems` — O(new), not `retarget`'s O(rows²) re-diff, which is what hung mid-search)
  and highlights only the new excerpts; the caret, edits, and scroll are preserved. `ProjectSearchView`
  adds at most `VIEW_FILES_PER_FLUSH` files per frame and caps the view at `MAX_VIEW_FILES`, and
  `SearchResultsView` skips a file whose size or longest line is pathological (`MAX_SOURCE_BYTES` /
  `MAX_SOURCE_LINE`) — a minified bundle / source map can't render without stalling GtkSourceView.
  Set `ZYM_SEARCH_PROFILE=1` to log per-step timings (`src/util/profile.ts`).

## Presets

Named, **options-only** presets (e.g. "Code" = exclude tests/docs). Stored per-project in
`<cwd>/.zym/settings.json` under `search.presets` and layered over a few built-ins, all in
`src/projectSettings.ts` (`projectSearchPresets` / `saveSearchPreset`). The full view's header
has a Presets menu to apply or save one.
