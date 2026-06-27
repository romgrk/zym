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
runs elide to a `⋯` gap widget, and per-side tree-sitter highlighting,
added/removed backgrounds, and old|new line-number gutters are painted on top.
It is fully documented in **[multibuffer.md](multibuffer.md)** — start there.

## Entry points

- **`git:diff-current-changes`** (`space g d d`) — the working tree's changes as
  one editable, stageable diff (the staging surface). `DiffView` in editable
  mode: the new side is a live `Document`, edits write through, hunks stage with
  `s`/`u`.
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
rows via a `no-cursor` decoration (`editor.decorations.setNoCursorRanges`, applied in
`applyDecorations`) — the band reads `.focused` instead, so it's clear the cursor is on the header
without a stray box over the filename. Being an ordinary text-window `add_overlay` child it **scrolls
natively** — smooth on a touchpad, never swallows scroll (it bubbles to the view), stays click-to-jump,
and is **clipped to the viewport by the text view** (so nothing draws over the tab bar). The `sticky`
flag (in `BlockDecorations`) clamps the overlay's Y to the scroll top and re-clamps it on every
`value-changed`, so once a file scrolls past the top its header **pins** there; below the top it just
rides the text. To stop stacked pinned headers from accumulating, a sticky band is also clamped to sit
no lower than just above the **next** sticky band (`nextStickyBandTop`), so an earlier file's header
slides up and rides the text out of view as the next reaches the top — only the current (last-passed)
file's header stays pinned. The opaque header fill (editor background + tint) lets it occlude the diff
scrolling underneath.

`StickyHeaders` (`src/ui/TextEditor/StickyHeaders.ts`) is a thin reconcile + focus layer over the
block primitive: `DiffView` drives it from `installOverlays` via `editor.stickyHeaders.setHeaders(...)`
(reconciled by path — add / re-anchor / swap-widget-on-content-change / remove), and it toggles a
`.focused` class on the header whose line the caret sits on. The header widget shows a `▾`/`▸` chevron
+ `+N −M` stats, and **only** the filename (the elided file head is now its own gap band, not a header
subtitle). `⋯` gaps — the leading file-head gap (`'above'` the first content row) and between-window
gaps (`'below'` the last shown row) — plus review-comment cards are ordinary (non-sticky)
`BlockDecorations`.

**Per-file collapse** — `z a` (`diff:toggle-file`) folds the file under the cursor to just its header
row; `z C` / `z O` (`diff:collapse-all-files` / `diff:expand-all-files`) fold/unfold every file (a
one-line-per-file overview). A collapsed file emits only its header row
(`buildDiffMultiBuffer`'s `collapsed` predicate, keyed by path in `DiffView.collapsedFiles`); the
re-derive rides the existing `reDiff()` refresh path and the caret recovers onto the file's header
row when its own line is folded away. This is orthogonal to the **context** controls (`z o`/`z R`/`z m`,
which reveal elided unchanged lines *within* an expanded file). The search surface's headers stay
`BlockDecorations` bands (it has its own per-excerpt collapse).

## Comment & review (any diff)

`DiffView` carries a comment/review layer (`startComment`, review mode,
`submitReview`; `src/ui/DiffCommentBox.ts`) that turns the cursor row or a visual
selection into a `path:line` reference + unified-diff hunk + `On <locator>:` + your
text, formats it, and hands it to an agent. It's enabled whenever the host wires
`onSend` — which **every** diff surface now does, live or historical, so a review
can always be sent to an agent:

- `enter` opens the inline comment box on the row/selection (`g d` still jumps to
  the file); `ctrl-enter` / `diff:review-toggle` starts **review mode**, which
  accumulates comments as inline cards (`diff:review-send` flushes the batch as
  one message, `diff:review-remove` drops one).
- **Targeting** (`buildCommentTarget`): a visual selection sends exactly the
  selected rows; a bare cursor widens the *patch* to the surrounding hunk (for
  context) but the `locator` + `navLine` still pin the **cursor's own line**, so
  the agent knows precisely which line the comment is about.
- **Revision context**: a historical diff sets `reviewContext` (e.g. ``Review of
  commit `a0c0365` (subject)`` or ``Review of `branch` vs `master```), prefixed to
  the message so the agent knows the lines refer to that revision, not the working
  tree. Working-tree diffs (live / current-file) omit it.
- The delivery seam is **`zym.workspace.sendReviewToAgent`** → AppWindow's
  `reviewToAgent`: with a running agent it sends straight to it and **reveals** it
  (so the review visibly lands). With none running it opens the agent picker, whose
  highlighted **"Send to new agent"** entry (`AgentPickerOptions.newAgent`) opens the
  **AgentLauncher** (pick model / permission / worktree); the review is then
  delivered to the agent it starts. The live staging surface (`openLiveDiff`) and
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
  staging diff still shows its staged/unstaged marker band.
- `src/ui/TextEditor/GitGutter.ts` — the live change-bar gutter shown **while
  editing** a file with uncommitted changes (a separate feature from the diff
  surface; also built on `lineDiff.ts`).

See [multibuffer.md](multibuffer.md) for the projection/excerpt machinery and
[inline-widgets.md](inline-widgets.md) for the inline-block primitive used by the
gap/header/comment bands.
