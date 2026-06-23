# Diff display

> **History:** this page once described a standalone read-only diff viewer
> (`DiffView` / `SideBySideDiffView` / `DiffViewer`, synthesized read-only
> buffers + a `DiffGutter`, with a pure `DiffModel` model layer). That whole
> subsystem was removed in the diff-view consolidation. There is now **one**
> diff surface — the multibuffer `DiffView` — and this page is a pointer to it.

All diffs render on the continuous, multi-file multibuffer **`DiffView`**
(`src/ui/DiffView.ts`). It stitches each changed file's old (HEAD/blob) and new
(working-tree or live `Document`) sides into one scrollable editor via a
`ViewProjection`: changed hunks plus a little context are shown, long unchanged
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
- `src/ui/TextEditor/applyDiffDecorations.ts` — paints full-line
  `added`/`removed` backgrounds and `word-add`/`word-del` intra-line char spans
  onto a decoration layer (handling the unterminated-last-line case). Owns the
  `WordRange` type.
- `src/ui/TextEditor/DiffLineNumberGutter.ts` (`CombinedDiffLineNumberGutter`) —
  the one gutter renderer drawing both the old and new line-number columns.
- `src/ui/TextEditor/GitGutter.ts` — the live change-bar gutter shown **while
  editing** a file with uncommitted changes (a separate feature from the diff
  surface; also built on `lineDiff.ts`).

See [multibuffer.md](multibuffer.md) for the projection/excerpt machinery and
[inline-widgets.md](inline-widgets.md) for the inline-block primitive used by the
gap/header/comment bands.
