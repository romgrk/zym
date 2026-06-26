# Occurrence ↔ search (unified match model)

Occurrence and search both highlight regex matches in the buffer, but they used
to be two separate engines:

- **Search** (`SearchController`) — an ordered, navigable match set with a
  *current* match (`n`/`N`), regex/case/whole-word support, driven by the
  `SearchBar`. Stored as plain `Range[]`.
- **Occurrence** (`OccurrenceManager`) — an unordered set of operator *targets*
  (`MarkerLayer` marks, so they survive multi-edits). A later operator restricts
  itself to the marks it intersects (`c o p` = change every occurrence in the
  paragraph).

They are the same concept split across two entry points. `gn`/`gN` already prove
the bridge: they make the *last search pattern* an operator target. This document
records the decision to collapse the two so that **occurrence operates on the
search matches**.

## Model

- **Search owns the pattern + the global match set** (live, regex-capable).
- **The operator's text-object owns the scope.**
- **Occurrence = (search matches) ∩ (scope)**, materialised as marks *lazily* — only
  when an operator actually runs (see "Lazy marks" below).

Three explicit states — operators only act on matches when *armed*, so a plain
navigation search is never a loaded gun:

| State | Highlight | `n`/`N` | Operators |
|---|---|---|---|
| No search | — | — | normal |
| Search (navigation) | amber (`search.match`), current match strong | yes | act on text objects |
| **Occurrence armed** (`g o`) | **purple** (`search.occurrence`), uniform | yes | act on matches ∩ scope |

The armed highlight is a *visually distinct* purple: the implicit-operation
footgun only bites when the mode is invisible. **Arming recolors the existing
search highlight layer in place** — it does not add a second layer — so (a) the
current-match emphasis (`highlight-strong`) disappears while armed, and (b) there's
nothing to double-paint. Arming/disarming flips that one layer between purple and
amber.

**Single source of truth.** "Armed" lives in *one* place — the `OccurrenceManager`.
The search render derives its purple-vs-amber style from `isOccurrenceArmed()` at
paint time (there is no separate `armed` flag on `SearchController` to drift), and
the occurrence *operation* reads the **live** search pattern
(`getActiveSearchPattern()`), not a snapshot. So the highlight and the operator can
never disagree: if it's purple, operators use it; and if you change the search while
armed, both the purple and the operation follow the new pattern.

### Lazy marks

Occurrence *operations* need `MarkerLayer` marks (they mutate through edits). But
creating a mark per match is O(matches) GObject allocations — slow to do on every
`g o` in a large buffer. So arming creates **no marks**: it just stores the armed
pattern and recolors the search highlight purple.

Marks are materialised on demand when an operator runs — and **scoped to the
operator's target range**, not the whole buffer. The pattern is *resolved* in
`Operator.initialize` (at the original cursor, before persistent-selection moves it),
but the *scan* is deferred to `selectTarget`, after `target.execute()` has selected
the range: `OccurrenceManager.materializeWithin(pattern, editor.getSelectedBufferRanges())`
scans only within those ranges (via `collectRangeByScan`'s `scanRange`). So `c i i`
(change inner-indentation) scans/marks only the indentation block — not every match
in the file. The marks are torn down after the operation (the existing
transient-occurrence cleanup); the persistent visual is always the recolored search
layer.

The eager path (preset `g .`) still scans the whole buffer — it's created before any
target exists, and is rare; the common armed `g o` → operate flow is the one that's
scoped.

## Keys

- **`g o`** / **`alt-/`** — toggle occurrence arming (`alt-/` is the fast
  single-chord form; both bind `TogglePresetOccurrence`). Press again to disarm.
  - If armed → disarm: drop the armed pattern and recolor the highlight back to the
    amber search view (`setArmed(false)`).
  - Else arm (no marks created — see "Lazy marks"): a **visible search wins** — if
    search highlights are on screen, arm that search; otherwise (re-)seed the search
    from the **selection** (visual) or the **word at/after the cursor** (normal)
    *without moving the cursor*, then recolor it purple (`setArmed(true)`). This
    replaces the old `c o p`: `g o` then any `<operator><text-object>`.
- **`g .`** — re-arm from the last occurrence pattern (eager; unchanged).
- **`ctrl-l`** — vim `:noh`: disarm occurrence and drop the search highlights (the
  query persists so `n`/`N` re-find). This is the **re-target gesture**: because
  `g o` arms a *visible* search, `ctrl-l` then `g o` arms the cursor word again
  instead of the earlier search. We gate on visibility rather than "is a query set"
  because a confirmed search stays highlighted, so the rule has no hidden state —
  `g o` arms the search exactly when you can see it. (A cursor-on-hit DWIM was
  considered and rejected as too implicit.)
- **Disarm** — `g o`/`alt-/` again (→ amber search view), or **`escape`**
  (reset-normal-mode disarms; no new binding needed). Occurrence is *persistent*: it
  survives motions/operators until one of these clears it.

The `o`/`O` **operator-modifier keybindings** (`c o p`, `d O w`) are **removed** —
`g o` covers the cursor-word case and adds regex + live preview. The underlying
`setOperatorModifier` / `Operator.setModifier` engine is retained (it still backs
the unit tests and is reachable via the API), only the keys are gone.

## Implementation

- `SearchController` — `get activePattern()`, `get hasVisibleMatches()` (the
  visible-search-wins gate), `setQueryStatic(query, {wholeWord})` (set query +
  highlight, no cursor move), and `rehighlight()`. There is **no local `armed`
  flag**: `highlight()` reads `setArmedProvider`'s callback (`isOccurrenceArmed()`)
  to pick the purple vs amber style, so the render can't drift from the occurrence
  state. `ctrl-l` reuses the `did-request-clear-search-highlight` bridge (host
  `search.clear()`) which empties the matches while keeping the query for `n`/`N`.
- `OccurrenceManager` — `arm(pattern)` stores the armed pattern **without scanning**;
  `armedPattern` / `isArmed()` expose it; `disarm()` drops it and clears any marks.
  `materializeWithin(pattern, ranges)` does the scoped scan+mark;
  `markBufferRangeByPattern` gained an optional `scanRanges`.
- `Operator.initialize` — armed/preset detection runs *before* `subscribeReset…` so
  the armed case (no marks yet) registers its transient-mark cleanup; it then
  *resolves* `patternForOccurrence` to the **live** search pattern
  (`vimState.getActiveSearchPattern() ?? armedPattern ?? cursor-word`) but does
  **not** scan.
- `Operator.selectTarget` — after `target.execute()`, materialises the marks scoped
  to `editor.getSelectedBufferRanges()`, then `select()`s as before.
- `VimState` — an `OccurrenceSearchProvider` bridge (`armFromCursor`, `armFromText`,
  `getActivePattern`, `refresh`), `isOccurrenceArmed()` (the render's source of
  truth), `getActiveSearchPattern()` (live pattern for the operation),
  `refreshSearchHighlight()`, `disarmOccurrence()` (disarm + repaint amber) and
  `clearSearchHighlight()` (disarm + clear, for `ctrl-l`). Headless (no host) → the
  provider is absent and `g o` falls back to the in-vim cursor-word pattern, armed
  lazily; an operator then materialises it. So the vim unit tests keep working.
- `TextEditor.installSearch` — wires the provider to `SearchController` +
  `SearchBar.reflectQuery`, and `search.setArmedProvider(() => isOccurrenceArmed())`.
  `armSearchFromCursor()` returns the visible search's pattern, else re-seeds the
  cursor word; `wordAtOrAfterCursor()` is shared by `*`/`#` and `g o`.
- `OccurrenceManager.renderMarkers` (the eager subword path) paints the new
  `occurrence` decoration style.
- `TextDecorations` / theme — new `occurrence` highlight style + `search.occurrence`
  palette colour (a dim purple).

## Known follow-ups

- The armed visual recolors the one search layer, so `n`/`N` while armed simply
  repaints purple — no two-layer issue. (The earlier deferred "n/N repaints over the
  occurrence layer" item is resolved by the lazy/recolor design.)
- After an operation mutates the armed matches, the recolored search highlight isn't
  re-scanned, so it can lag the edits until the next `n`/`N` or re-arm. A post-operate
  refresh is possible but deferred (highlight visuals need in-app verification).
- An optional `auto-disarm after one operate` config (mimicking the old transient
  `c o p`) could be added if persistent arming proves to be too sticky.
