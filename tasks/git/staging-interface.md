# Staging interface (tab-based)

> **RETIRED (2026-06).** `GitStagingView` (`src/ui/GitStagingView.ts`) and its `git:open-staging`
> command were deleted; its job is now the **continuous editable diff multibuffer**
> (`DiffMultiBufferView`, `space g o`/`space g D`) with hunk staging on the gutter marker
> (`space h s`/`space h u`) and commit via `space g c`. This doc is kept for history — the
> per-row diff base, discard semantics, and untracked=all-added decisions informed the replacement.
> See [../code-editing/multibuffer.md](../code-editing/multibuffer.md).

A second Source-Control surface that opens **as an editor tab** (via
`workbench.center.add`), distinct from the left-dock `GitPanel` (which stays).
It mirrors what `git status` shows — staged files in green, unstaged/untracked in
red — and expands an **inline read-only diff beneath any file row** (an accordion,
toggled with `o`), in the same widget — no separate dock panel.

Tracking: see [index.md](index.md) ("Tab-hosted staging view"). The left-dock
`GitPanel` is unchanged.

## Design

- **Opens in a tab**, like an editor — `center.add(view.root, { title, requireTabBar })`.
- **Layout**: a single scrollable column (`Gtk.ScrolledWindow` → `Gtk.ListBox`),
  **accordion-style** — pressing `o` on a file expands an **inline unified
  `DiffViewer` directly beneath its row** (a non-selectable list row holding the
  viewer); `o` again collapses it. Several diffs can be open at once. (An earlier
  iteration used a left/right `Gtk.Paned` with an editable `TextEditor` on the
  right; replaced by this inline accordion.)
- **File list = file-level staging only** (stage / unstage / discard whole
  files), grouped Staged / Unstaged / Untracked. The **full relPath** (no
  file-type icon) is shown in the **app monospace font** (`fonts.monospace`),
  colored like `git status` — staged green, unstaged + untracked red. Same model +
  helpers as `GitPanel`, imported from `src/git.ts` (`getChanges`, `stage`,
  `unstage`, `discard`, `clean`). Porcelain letters are dropped except a `D` badge
  on deletions. `X` discards with **no prompt** (`discard` a tracked file / `clean`
  an untracked file *or folder*).
- **Inline diff = the read-only `DiffViewer` (unified).** `GitStagingView` builds
  it itself (it's self-contained given a `DiffModel` — no `DocumentRegistry`
  plumbing needed): per-row base/target — staged → index↔HEAD
  (`git show HEAD:p` / `:p`), unstaged → worktree↔index, untracked → all-added —
  fed to `computeDiff` → `new DiffViewer(model, { languagePath, header: false })`.
  The viewer row gets a bounded height (`diffHeight`, snug to the displayed rows
  after `foldUnchanged`, capped at 480px); the viewer's own `ScrolledWindow`
  scrolls anything past the cap. Passing `header: false` hides the viewer's own
  unified↔side-by-side toggle, so side-by-side isn't surfaced inline yet (the
  `DiffViewer` itself already supports both).
  - The inline viewer is **read-only**, so hunk-level staging isn't on it.
    File-level staging from the list still works, and hunk-level staging exists
    elsewhere — the editor diff gutter (`GitGutter.stageHunk`/`unstageHunk` via
    `git apply --cached`). Wiring hunk staging onto this inline diff (reusing
    `src/util/hunkPatch.ts`) and an eventual editable-diff renderer are follow-up
    work.
- **Commit** — `c c` calls `onCommit()` → `AppWindow.startCommit()`, which opens
  `.git/COMMIT_EDITMSG` in the **editor area** (a normal tab); save+close commits
  via `finishCommit` → `GitRepo.commit` → `git commit -F` (hooks/GPG honored).
- **Coexists** with `GitPanel`; nothing in the left dock changes. The list
  rendering is a small self-contained copy for now — extracting a shared
  `GitStatusList` used by both is deferred to avoid GitPanel regressions.

## Component: `src/ui/GitStagingView.ts`

```
Staged (1)
  src/foo.ts                          ← monospace path, green (staged)
  ┌────────────────────────────────┐
  │ +2  −1            ⌃ ⌄  ▤ ▥      │  ← inline DiffViewer (unified), opened
  │ @@ -1,3 +1,4 @@                 │    with `o`, height bounded + scrolls
  │  function foo() {               │
  │ +  const x = 1                  │
  │ -  return 0                     │
  │ +  return x                     │
  └────────────────────────────────┘
Unstaged (1)
  src/bar.ts                          ← red (unstaged)
```

`GitStagingViewOptions`: `cwd`, `git: GitRepo` (re-render on `onChange`),
`onCommit()` (→ `AppWindow.startCommit`, opens `COMMIT_EDITMSG`).

Behavior:

- Rebuilds the list on `git.onChange`; preserves the cursor + scroll position and
  **re-opens any inline diffs** whose file still has a row (so staging a file —
  which moves it between groups — keeps its diff open and refreshes its content).
- Keys while the list is focused (selector `#GitStagingView`): `j`/`k` navigate,
  `o` toggles the inline diff (`core:right`, and focuses it on open), `s`/`u`
  stage/unstage, `X` discard, `c c` commit. The diff rows are non-selectable, so
  cursor nav skips over them. While a diff is focused (selector
  `#GitStagingView #TextEditor`), `q` / `escape escape` close it (`git:close-diff`)
  and return focus to the list.
- Open diffs are keyed by `${kind}:${relPath}` (`kind` is `staged | unstaged`;
  untracked rows render in the `unstaged` group) so a file present in both the
  staged and unstaged groups can show each diff independently. Async `git show`
  results are dropped if the list was rebuilt meanwhile (stale-row guard).

## AppWindow wiring

`git:open-staging` command (on `#AppWindow`) → `AppWindow.openStagingView()`
constructs `new GitStagingView({ cwd, git, onCommit: () => this.startCommit() })`,
adds it to `workbench.center` as a tab (titled `${Icons.git}  Staging`,
`requireTabBar: true`), and tracks it in a `stagingViews` map so `disposeChild`
tears it down on close. Keymap: **`space g o`** (`space g g` already focuses the
left-dock Git panel). No editor-pane factory is needed — the view builds its own
`DiffViewer`s.

## Phasing

- [x] `GitStagingView` — scrollable status list (file-level staging, monospace
      colored paths), opened as a center tab; `git:open-staging` + `space g o`.
- [x] Inline unified `DiffViewer` accordion under each row (`o` toggles), per-row
      diff base, bounded height, re-open across refresh.
- [ ] Side-by-side toggle surfaced inline; hunk-level staging wired onto the inline
      diff (reuse `src/util/hunkPatch.ts`); extract a shared `GitStatusList` with
      `GitPanel`; eventual editable-diff renderer (vim on the new-side lines).
```
