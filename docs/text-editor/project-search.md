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

Two distinct entry points; same backend, options, and presets. The picker rides the vim
idioms (`space /` = search, `space *` = word under cursor); the full tab lives under the
`space s` search leader (`space s s` opens it, `space s w` / `space s *` seed the word).
All four commands seed the visual selection when one exists (`project:search`,
`project:search-word`, `project:search-open`, `project:search-open-word`).

- **Picker** (`src/ui/SearchPicker.ts`, `space /`; `space *` seeds the word under the
  cursor) — a quick-jump [LocationPicker](../../src/ui/LocationPicker.ts) with a source
  preview. Results append progressively as rg streams; the entry row carries
  case/word/regex option chips (a Picker `headerAccessory`), and flipping one re-runs
  the search.
- **Full view** (`src/ui/ProjectSearchView.ts`, `space s s`; `space s w` seeds the word
  under the cursor) — the editable [multibuffer](multibuffer.md) results surface
  (`SearchResultsView`), with one options row (flag toggles, a single glob field, a presets
  combo). It grows in place as matches stream: each refresh **appends** the new files' rows
  (`Screen.appendItems` — O(new), not `retarget`'s O(rows²) re-diff, which is what hung mid-search)
  and highlights only the new excerpts; the caret, edits, and scroll are preserved. `ProjectSearchView`
  adds at most `VIEW_FILES_PER_FLUSH` files per frame and caps the view at `MAX_VIEW_FILES`, and
  `SearchResultsView` skips a file whose size or longest line is pathological (`MAX_SOURCE_BYTES` /
  `MAX_SOURCE_LINE`) — a minified bundle / source map can't render without stalling GtkSourceView.
  The gap band between two non-adjacent regions of a file is labelled like the diff's fold markers:
  the next region's enclosing section (git's function-context heuristic, `enclosingSection` in
  `diffMultiBuffer.ts`) without the `@@ -old +new @@` range — the source line-number gutter already
  shows it — falling back to `⋯` (see [diff.md](diff.md) for the diff's full git-patch labels).
  Set `ZYM_SEARCH_PROFILE=1` to log per-step timings (`src/util/profile.ts`).
  **Focus flow:** a seeded search that auto-runs (`space s w`) lands the caret on the **first match**
  once results stream in; `space s s` opens focused in the search box to type a query. In the box,
  Enter (`project-search:submit`) commits the query and jumps to the first match, while Down
  (`project-search:focus-results`) drops into the results at the top. From within the tab (focus in
  the results) `space s s` (`project-search:focus-search`, scoped to `.ProjectSearchView`, so it
  outranks the global leader by focus proximity) returns to the search box **without clearing the
  query**. Landing on the first match is `SearchResultsView.focusFirstMatch()` (first file's first
  match); the arm-then-flush handoff (results may still be streaming) is `pendingFocusFirstMatch`.

## Presets

Named, **options-only** presets (e.g. "Code" = exclude tests/docs). Stored per-project in
`<cwd>/.zym/settings.json` under `search.presets` and layered over a few built-ins, all in
`src/projectSettings.ts` (`projectSearchPresets` / `saveSearchPreset`). The full view's header
has a Presets menu to apply or save one.
