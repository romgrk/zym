# Diff display

> **History:** this page once described a standalone read-only diff viewer
> (`DiffView` / `SideBySideDiffView` / `DiffViewer`, synthesized read-only
> buffers + a `DiffGutter`, with a pure `DiffModel` model layer). That whole
> subsystem was removed in the diff-view consolidation. There is now **one**
> diff surface — the multibuffer `DiffView` — and this page is a pointer to it.

All diffs render on the continuous, multi-file multibuffer **`DiffView`**
(`src/ui/DiffView.ts`). It stitches each changed file's old (HEAD/blob) and new
(working-tree or live `Document`) sides into one scrollable editor via a
`CoordinatesMap`: changed hunks plus a little context are shown, long unchanged
runs elide to a git-patch `@@ … @@` hunk-header gap band, and per-side tree-sitter highlighting,
added/removed backgrounds, and old|new line-number gutters are painted on top.
It is fully documented in **[multibuffer.md](multibuffer.md)** — start there.

`DiffView.root` is a `Gtk.Stack` swapping the editor for an empty state (an `Adw.StatusPage` built
by `createEmptyMessage`, `src/ui/createEmptyMessage.ts`) whenever no file has a change — so a live
diff whose changes are all discarded shows "No changes" rather than a blank editor. `reDiff` toggles
it on `headerAnchors.length === 0`. `git:diff-current-changes` therefore opens the diff even on a
clean tree (its empty state) instead of a "no changes" toast — `buildCurrentChangesDiff` returns null
only outside a repo.

The live diff is a **live mirror of the working tree**, kept current three ways: (1) content edits to
a file it already tracks arrive for free — the new side is the shared live `Document`, so an edit in
*any* editor tab reverse-syncs through `Screen` into the view and re-diffs (`setResyncHandler` →
`reDiff`); (2) a HEAD move re-bases and an index move repaints markers (`onGitChange`); (3) a file
that becomes changed *after* open is folded in by `onGitChange` → `reconcileFiles`, which — when the
repo model's change set grew — asks the host to rebuild the `DiffFile[]` (`refreshFiles`, HEAD blob +
`deleted` flag) and splices the new files in via `DiffView.setFiles`. `setFiles` only ADDS (a file
that went clean already renders nothing); per-file state (collapse / review / unsaved edits) is
keyed by path and survives, and each added file's source buffers are registered with the live
`Screen` + syntax painter (whose maps were built at open — skipping this renders the new excerpt
as blank rows). Every `reDiff` also **pins the top visible line** (by its source
position) so a reflow that adds/drops rows above the viewport — a commit, a collapse/expand — doesn't
jump the content under the reader (`topScrollAnchor` → `setTopBufferRow`). Re-diffs stay cheap on
a many-file diff: each file's line diff (and staged classification) memoizes in a per-view cache
keyed by its texts' identity (`DiffLayoutOptions.cache`), so a re-flow only re-diffs files whose
text changed; decorations re-sync only the spliced row window `retarget` reports; expand-context
reveals are keyed **per path** (bare row indices collide across files); and gap bands reconcile by
per-file ids, so one file's fold doesn't churn every later file's band. Reopening
(`git:diff-current-changes` again) re-syncs the set explicitly on top of the live path. (External,
on-disk edits to a file open as a `Document` aren't reflected until it's reloaded — the `Document`
model doesn't auto-reload; in-app edits are fully live.)

## Entry points

- **`git:diff-current-changes`** (`space g d d`) — the working tree's changes as
  one editable, stageable diff (the staging surface). `DiffView` in editable
  mode: the new side is a live `Document`, edits write through, hunks stage with
  `s`/`u`, and it tracks the working tree live (see above). Only **one live diff per
  workbench**: re-triggering it reveals + focuses the already-open tab (found by scanning
  `workbench.center.allChildren()` for a `DiffView.forRoot(w)?.live`) rather than stacking a
  second one, re-syncing its file set to the current changes first (`DiffView.setFiles`, redundant
  with the live path but a cheap explicit refresh) — see `PaneItems.openLiveDiff`.
- **`git:diff-current`** (`space g D`) — just the active file, working tree vs
  HEAD, on the same multibuffer surface (one file, read-only).
- **`git:diff-commit`** (`space g d c`) / **`git:diff-branch`** (`space g d b`)
  — read-only diffs of a commit (vs its parent) or this branch vs master/main
  (three-dot, PR-style). `git:diff-commit` takes an optional revision argument
  (a sha, `HEAD~2`, a tag, …); dispatched without one it opens a commit picker
  (`openCommitPicker`). Both live in **`src/ui/diffViews.ts`**, which builds the
  `DiffFile[]` from git blobs and opens a non-editable `DiffView` in a tab.

## Sticky + collapsible file headers

Each file's header is an **empty, read-only, navigable `block` row** (the file's first row), which
the filename widget **covers** as an `on`-placed `sticky` `BlockDecoration` (`placement: 'on', sticky:
true`) — the widget sits OVER its own line (the line is grown to the widget's height), so the caret
lands *on the headerband* (`j`/`k` stops there). The caret box itself is **suppressed** on the header
rows (a `no-cursor` decoration) and the band reads as **selected** instead (`.MultiBufferHeader.is-focused`) —
both owned by `StickyHeaders` (see below) — so it's clear the cursor is on the header without a stray
box over the filename. That selection is shown only while the diff editor holds keyboard focus
(`:focus-within`), as an accent-tinted background (`.is-focused` reads no differently when the diff is
unfocused). Being
an ordinary text-window `add_overlay` child it **scrolls
natively** — smooth on a touchpad, never swallows scroll (it bubbles to the view), and is **clipped to
the viewport by the text view** (so nothing draws over the tab bar). A single click on a header does
nothing (it no longer opens the file); a **double-click toggles the file's fold** (`toggleFileCollapse`,
the pointer equivalent of `z a`). The `sticky`
flag (in `BlockDecorations`) clamps the overlay's Y to the scroll top and re-clamps it on every
`value-changed`, so once a file scrolls past the top its header **pins** there; below the top it just
rides the text. To stop stacked pinned headers from accumulating, a sticky band is also clamped to sit
no lower than just above the **next** sticky band (`nextStickyBandTop`), so an earlier file's header
slides up and rides the text out of view as the next reaches the top — only the current (last-passed)
file's header stays pinned. The opaque header fill (libadwaita's `--sidebar-bg-color`) lets it
occlude the diff scrolling underneath — including the `⋯` gap bands and review-comment cards, which
are kept strictly
**below** the headers in the overlay draw order (sticky bands stay at the `add_overlay` queue tail; see
the z-order constraint in [inline-widgets.md](inline-widgets.md)).

`StickyHeaders` (`src/ui/TextEditor/StickyHeaders.ts`) is a **reusable, surface-agnostic** abstraction
over the block primitive (the diff today, project-search next): a surface drives it via
`editor.stickyHeaders.setHeaders(...)` (one `{ viewRow, build, id, key }` per excerpt — for the diff,
reconciled by path from `installOverlays`), and it owns everything generic — the pinning, the
caret-follow `.focused` highlight, and the `no-cursor` decoration over the header rows. Nothing
diff-specific lives in it; the surface only supplies the header set + its own widget look. The diff's
header widget shows a Nerd Font collapse chevron (`NERDFONT.NAV.CHEVRON_DOWN` expanded /
`CHEVRON_RIGHT` collapsed, coloured to match the path) + `+N −M` stats + a dimmed `(deleted)` tag for a
removed file, and **only** the filename (the elided file head is now its own gap band, not a header
subtitle). The gap bands read git-patch style: each shows the `@@ -old +new @@ section` header of the
hunk that FOLLOWS it (byte-identical to what `git diff` prints above that hunk — see `windowHunkHeader`,
which reuses git's default `,count`-elision and function-context heuristic), or a bare `⋯` for a
trailing gap (no hunk follows, as git prints nothing there). When the line-number gutter is showing
(`editor.diffLineNumbers`), the `@@ -old +new @@` range just restates the gutter, so `gapLabel` drops
it and keeps only the trailing section context (a bare `⋯` when the hunk has none); `installOverlays`
keys the band on the displayed text so a live toggle rebuilds it. Markers render in the editor
foreground, same as the filename, on an opaque `--secondary-sidebar-bg-color` band (a shade off the
header's `--sidebar-bg-color`). The leading file-head gap (`'above'` the first content row) and between-window
gaps (`'below'` the last shown row) — plus review-comment cards — are ordinary (non-sticky)
`BlockDecorations`, all `fullWidth: 'content'` so they span the full content width under the header
and stay full-width while scrolling horizontally with the text (unlike the pinned header). The cards
need it too: their body is a wrapping label, so without a forced width the band collapses to the
label's ~zero minimum and reflows tall a few frames after placing.

**Per-file folding & navigation** (vim-style, keyed by path in `DiffView.collapsedFiles`). At open, a
large diff auto-folds: the first build passes `buildDiffMultiBuffer`'s `autoCollapseAtLines`, which
folds any file whose change (`added + removed`) meets `editor.diffCollapseLines` (default 500; 0
disables) inline in the same pass — no rebuild — so a big diff opens as a scannable overview.
`seedAutoCollapse` then mirrors those files into `collapsedFiles`; later re-diffs omit the threshold,
so they honor the user's collapse set and never re-fold a file expanded with `z o` / `z r`. `z c` /
`z o` (`diff:collapse-file` / `diff:expand-file`) close/open the file under the cursor, `z a`
(`diff:toggle-file`) toggles it, and `z r` / `z m` (`diff:expand-all-files` / `diff:collapse-all-files`)
open/close every file (a one-line-per-file overview). `z x` (`diff:collapse-files-matching`) collapses
every file matching a comma-separated glob filter (`!` to negate), typed into a picker
(`DiffCollapseGlobPicker`; glob engine in `src/util/glob.ts`). `z j` / `z k` (`diff:next-file` /
`diff:prev-file`) step the caret between file headers; `z /` (`diff:go-to-file`) opens a fuzzy file
picker over the diff editor (`DiffFilePicker`, like `lsp:document-symbols`) that jumps to the chosen
file's header. A collapsed file emits only its header row (`buildDiffMultiBuffer`'s `collapsed`
predicate); the re-derive rides the existing `reDiff()` refresh path and the caret recovers onto the
file's header row. Revealing the elided unchanged lines *within* a file is a
separate axis: `z .` (`diff:expand-context`) expands the nearest `⋯` gap a chunk at a time, `z >`
(`diff:expand-all`) reveals the full files, `z <` (`diff:collapse-context`) re-collapses — and
clicking a `⋯` marker expands it too. (`.` mirrors the dots; `z o` is the file-open now, not the
context expand.) The search surface's headers stay `BlockDecorations` bands (it has its own
per-excerpt collapse).

## Comment & review (any diff)

`DiffView` carries a comment/review layer (`startComment`, review mode,
`submitReview`; `src/ui/DiffCommentBox.ts`) that turns the cursor row or a visual
selection into a `path:line` reference + unified-diff hunk + `On <locator>:` + your
text, formats it, and hands it to an agent. The box and the message format
(`formatAgentComment`) are shared with ordinary file editors, which get the same
single-comment gesture — see [comment-to-agent.md](comment-to-agent.md). The diff
adds **review mode** (accumulate, batch-send) on top. It's enabled whenever the
host wires `onSend` — which **every** diff surface now does, live or historical, so
a review can always be sent to an agent:

- `enter` opens the inline comment box on the row/selection (`g d` still jumps to
  the file); `ctrl-enter` / `diff:review-toggle` starts **review mode**, which
  accumulates comments as inline cards (`diff:review-send` flushes the batch as
  one message, `diff:review-remove` drops one).
- **Targeting** (`buildCommentTarget`): a visual selection sends exactly the
  selected rows; a bare cursor widens the *patch* to the surrounding hunk (for
  context), capped at `COMMENT_MAX_LINES` rows around the cursor so a huge changed
  block doesn't send a wall of context — the `locator` + `navLine` still pin the
  **cursor's own line**, so the agent knows precisely which line the comment is
  about. (The cap is bare-cursor only; a visual selection is never trimmed.)
- **Revision context**: a historical diff sets `reviewContext` (e.g. ``Review of
  commit `a0c0365` (subject)`` or ``Review of `branch` vs `master```), prefixed to
  the message so the agent knows the lines refer to that revision, not the working
  tree. Working-tree diffs (live / current-file) omit it.
- The delivery seam is **`zym.workspace.sendReviewToAgent`** → AppWindow's
  `reviewToAgent`: with a running agent it sends straight to it and **reveals** it
  (so the review visibly lands). With none running it opens the agent picker, whose
  highlighted **"Send to new agent"** entry (`AgentPickerOptions.newAgent`) opens the
  **AgentLauncher** (pick model / permission / worktree) with the review **pre-filled
  as the prompt** (`initialPrompt`), so it becomes the new agent's **first turn** —
  the launch prompt is the spawn argument and is reliably delivered (sending it as a
  separate post-launch turn races with the just-spawned agent and is dropped). The
  live staging surface (`openLiveDiff`) and
  the editor-hosted single-file diff call `reviewToAgent` directly; the decoupled
  commit/branch views go through the workspace seam.
- Read-only diffs register a **session participant**, so unsent (accumulated)
  review comments prompt before the window closes (`DiffView.isModified()` counts
  pending comments).

## Surviving shared pieces

- `src/util/lineDiff.ts` — the minimal Myers O(ND) line diff (degrades to a
  whole-file replace past size bounds), the basis of every diff.
- `src/util/wordDiff.ts` — the intra-line ("word-by-word") diff: given a
  removed↔added line pair it reports each side's changed-character spans
  (`WordRange`, the canonical home) via `diffWordsWithSpace`, then refines them for
  display — collapsing spans separated only by *noise* (whitespace/punctuation, so a
  lone matching `(` or `` ` `` can't fragment a changed run) while a real unchanged
  word still splits them, and promoting an otherwise-whole-line change (only
  whitespace in its margins) to a full-line highlight. The
  multibuffer attaches the result per row (`DiffMultiBuffer.wordRanges`, paired
  within each hunk in `annotateWordDiffs`); read-only and live diffs both carry
  it. (Was lost when the diff subsystem was consolidated onto the multibuffer and
  re-wired since.)
- `src/ui/TextEditor/applyDiffDecorations.ts` — paints full-line
  `added`/`removed` backgrounds and `word-add`/`word-del` intra-line char spans
  (`DiffView` feeds it `dmb.wordRanges`) onto a decoration layer (handling the
  unterminated-last-line case).
- `src/ui/TextEditor/DiffLineNumberGutter.ts` (`CombinedDiffLineNumberGutter`) —
  the one gutter renderer drawing both the old and new line-number columns. The
  number columns are gated on `editor.diffLineNumbers` (off by default, live-toggled
  via `zym.config.observe`); when off a read-only diff has no gutter, but the **live**
  staging diff still shows its staged/unstaged marker band. Each column's width is fixed to the whole
  diff's widest line number (`DiffView.gutterWidths`), so collapsing/expanding never re-sizes the gutter.
- `src/ui/TextEditor/GitGutter.ts` — the live change-bar gutter shown **while
  editing** a file with uncommitted changes (a separate feature from the diff
  surface; also built on `lineDiff.ts`).

See [multibuffer.md](multibuffer.md) for the projection/excerpt machinery and
[inline-widgets.md](inline-widgets.md) for the inline-block primitive used by the
gap/header/comment bands.
