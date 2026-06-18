# Staging interface (tab-based)

A second Source-Control surface that opens **as an editor tab** (via
`workbench.center.add`), distinct from the left-dock `GitPanel` (which stays).
It mirrors what `git status` shows — staged files in green, unstaged/untracked in
red — and lets you open a **diff/edit pane in a horizontal split inside the same
widget** (a `TextEditor`, not a separate dock panel).

Tracking: see [index.md](index.md) ("In-panel diffs"); this is the richer,
tab-hosted take on that line item. The left-dock `GitPanel` is unchanged.

## Decisions (from the kickoff)

- **Opens in a tab**, like an editor — `center.add(view.root, { title, requireTabBar })`.
- **Layout**: a single scrollable column (`Gtk.ScrolledWindow` → `Gtk.ListBox`),
  **accordion-style** — pressing `o` on a file expands an **inline unified
  `DiffViewer` directly beneath its row** (a non-selectable list row holding the
  viewer); `o` again collapses it. Several diffs can be open at once. (An earlier
  iteration used a left/right `Gtk.Paned` with an editable `TextEditor` on the
  right; replaced by the inline accordion.)
- **File list = file-level staging only** (stage / unstage / discard whole
  files), grouped Staged / Unstaged / Untracked. The **full path** (no file-type
  icon) is shown in the **app monospace font** (`fonts.monospace`), colored like
  `git status` — staged green, unstaged/untracked red. Same model + helpers as
  `GitPanel` (`getChanges`, `stage`, `unstage`, `discard`, `clean`). Porcelain
  letters are dropped except a `D` on deletions. `X` discards with **no prompt**
  (restore tracked / `git clean -fd` an untracked file *or folder*).
- **Inline diff = the read-only `DiffViewer` (unified).** `GitStagingView` builds
  it itself (it's self-contained given a `DiffModel` — no `DocumentRegistry`
  plumbing needed): per-row base/target — staged → index↔HEAD (`git show :p` /
  `HEAD:p`), unstaged → worktree↔index, untracked → all-added — fed to
  `computeDiff` → `new DiffViewer(model, { languagePath })`. The viewer row gets a
  bounded height (`diffHeight`, snug to the change, capped at 480px); the viewer's
  own `ScrolledWindow` scrolls anything past the cap. Side-by-side is a later
  toggle (`DiffViewer` already supports it).
  - Note: the inline viewer is **read-only**, so hunk-level staging isn't on it
    (file-level staging from the list still works). The kickoff direction —
    *"the TextEditor will become our diff viewer eventually, because we want
    editable lines to have vim"* — points to a future editable-diff renderer; the
    inline `DiffViewer` is the read-only step toward it. Wiring hunk staging onto
    the diff (reusing `hunkPatch.ts`) is follow-up work.
- **Commit** — `c c` opens `.git/COMMIT_EDITMSG` in the **editor area** (a normal
  tab), and save+close commits via the existing `startCommit`/`finishCommit` flow
  (`GitRepo.commit` → `git commit -F`, hooks/GPG honored).
- **Coexists** with `GitPanel`; nothing in the left dock changes. The list
  rendering is intentionally a small self-contained copy for now — extracting a
  shared `GitStatusList` used by both is a follow-up, deferred to avoid GitPanel
  regressions while this is in flux.

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
`onCommit()` (→ AppWindow `startCommit`, opens `COMMIT_EDITMSG`).

Behavior:

- Rebuilds the list on `git.onChange`; preserves the cursor and **re-opens any
  inline diffs** whose file still has a row (so staging a file — which moves it
  between groups — keeps its diff open and refreshes its content).
- Bare keys while the list is focused: `j`/`k` navigate, `o` toggles the inline
  diff (`core:right`), `s`/`u` stage/unstage, `X` discard, `c c` commit. The diff
  rows are non-selectable, so cursor nav skips over them.
- Open diffs are keyed by `${kind}:${relPath}` so a file present in both the
  staged and unstaged groups can show each diff independently. Async `git show`
  results are dropped if the list was rebuilt meanwhile (stale-row guard).

## AppWindow wiring

`git:open-staging` command (on `#AppWindow`) → `new GitStagingView({ cwd, git,
onCommit: () => this.startCommit() })`, added to `workbench.center` as a tab
(` Staging`) and tracked in a `stagingViews` map so `disposeChild` tears it down
on close. Keymap: **`space g o`** (`space g g` already focuses the left-dock Git
panel). No editor-pane factory is needed — the view builds its own `DiffViewer`s.

## Phasing

- [x] `GitStagingView` — scrollable status list (file-level staging, monospace
      colored paths), opened as a center tab; `git:open-staging` + `space g o`.
- [x] Inline unified `DiffViewer` accordion under each row (`o` toggles), per-row
      diff base, bounded height, re-open across refresh.
- [ ] Side-by-side toggle surfaced inline; hunk-level staging wired onto the diff
      (reuse `hunkPatch.ts`); extract a shared `GitStatusList` with `GitPanel`;
      eventual editable-diff renderer (vim on the new-side lines).
```
