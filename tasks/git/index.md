# Git

The git subsystem covers three deliverables, plus extras that grew out of them:

1. **Status viewer** — a Source Control panel (`GitPanel`), a sibling tab of the
   file tree in the left dock. **Done** (file-level staging).
2. **Commit interface** — message edited in a normal editor tab, commit on
   save+close. **Done** (no amend/sign-off yet).
3. **Forge links** — GitHub repo/actions/issues/PR open-on-web, PR + CI status in
   the header, PR/issue/CI pickers, create/checkout PR. **Done for GitHub** (via
   `gh`); GitLab and `#123`-in-text detection not yet.

Plus: **branch** switch/create/delete/merge/rename, **stash**
push/pop/apply/drop, a per-line **diff gutter** with **hunk-level staging**, and a
tab-hosted **staging view** (`GitStagingView`).

This page is the architecture record; the Phasing checklist at the bottom is the
authoritative status.

## Module boundary (public API)

The rest of the codebase imports git/GitHub functionality from exactly **two**
modules — **`src/git.ts`** and **`src/github.ts`**. Everything under
**`src/git/`** (`cli.ts`, `status.ts`) is internal:

- `src/git.ts` is the git facade — the reactive `GitRepo` (below) plus
  `export * from './git/cli.ts'`, which re-exports the CLI surface
  (status/staging/branch/stash/commit/worktree helpers + types). Callers do
  `import { … } from '../git.ts'`.
- `src/github.ts` is the GitHub facade: the reactive `GithubService` plus the
  `gh`-backed read functions. It is the one other module allowed to use
  `git/cli.ts` directly (it imports the async `git`/`repoRoot`) — deliberately,
  so it stays GTK-free and unit-testable. Its `gh` spawns also route through the
  process runner.

Invariant (grep-checkable): nothing outside `git.ts`/`github.ts` imports
`git/cli.ts` or `git/status.ts`.

## I/O model

Use `node:child_process` + the `git`/`gh` CLI directly. **Every** git/gh
invocation is **asynchronous** (callback form) — there is no synchronous git path.
Node async IO resolves normally under the live GLib loop; promises/microtasks are
starved, so the whole surface is callbacks (no promise wrappers). Simpler than
`Gio.Subprocess`, and hands us stdout directly.

All spawning goes through the **process runner** (`src/process/runner.ts` +
`runner-main.ts` — see [../index.md](../index.md) "Process runner"): the long-lived
~1.5 GB node-gtk process must never `fork()` (this Node's libuv has no
`posix_spawn` fast path, so fork cost scales with RSS — tens of ms/spawn). The
parent forks once to launch a tiny child; every command then forks *that* (~1 ms).
`cli.ts`'s `git()` and github.ts's `gh()` both call `runProcess`, with a
direct-spawn fallback if the runner is down. IPC is **binary**
(`src/process/codec.ts`): a length-prefixed frame whose stdout/stderr (up to
64 MiB) cross the pipe as raw bytes, never JSON-escaped.

Repo topology is derived straight from the on-disk git layout — pure `fs` reads,
no subprocess: `repoRoot` (walk up for `.git`, memoized), `worktreeInfo`, and
`listWorktrees` (read `<common>/worktrees/*` + HEAD via `commondir`/`gitdir`).
The cold callers (branch/stash pickers, github remote resolution, the commit
message path) take a callback.

**Remaining perf work:** coalesce the `onChange` fan-out (one `git status` per
root feeding all gutters instead of per-editor `git show` pairs, plus a per-file
gate so a gutter only re-fetches when its own file moved).

## Backend: the git CLI helper — `src/git/cli.ts` (internal)

The CLI gives us exactly what `git status`/`git diff` print (no re-deriving with
libgit2 diffs) and respects the user's hooks and config (name/email, GPG,
pre-commit/commit-msg) for free.

Core primitives (note: `cwd`/`root` is the first arg of every call):

```ts
git(cwd, args, onDone): void;                // async (process runner); onDone(ok, stdout, stderr)
repoRoot(cwd): string | null;                // nearest ancestor with `.git` — pure fs, memoized
commitMsgPath(root, onDone): void;           // async; .git/COMMIT_EDITMSG (via rev-parse --git-path)
```

It also exposes the pure-fs `worktreeInfo` / `listWorktrees`, `invalidateRepoRoot`,
and the async `currentBranch(root, cb)` / `listBranches(root, cb)` /
`listStashes(root, cb)`. There is no `gitSync`.

### Status model

`getChangesAsync(root, cb)` parses `git status --porcelain=v2 -z` into a flat list
the panel groups itself; a file edited in both index and worktree is pushed as
**two** rows (staged + unstaged):

```ts
type GitFileState = 'new' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
interface GitChange {
  path: string;     // absolute
  state: GitFileState;
  staged: boolean;  // index vs HEAD
  unstaged: boolean;// workdir vs index
}
```

It runs the runner's async `git()`, so the Source Control panel (and the staging
view) refresh without blocking the UI thread. Porcelain v2 reports staged (X) and
unstaged (Y) state per file in one call. Per-row line counts (±) are not surfaced
in the panel.

### Mutations

Each is an `execFile`-callback function:

- stage / unstage: `stage` (`git add`), `unstage` (`git restore --staged`);
  `stageAll`, `unstageAll`
- hunk staging: `applyPatch` (`git apply --cached` of a synthesized hunk patch —
  see the diff gutter)
- discard: `discard` (`git restore`, tracked) / `clean` (`git clean`, untracked)
  — destructive, confirmed first
- commit: `commit(root, messageFile)` → `git commit -F <msgfile>` (no
  `--amend`/`--signoff` yet)
- branch: `currentBranch`, `listBranches`, `switchBranch`, `createBranch`,
  `deleteBranch`, `mergeBranch`, `renameBranch`
- stash: `listStashes` (→ `Stash[]`), `stashPush`, `stashPop`, `stashApply`,
  `stashDrop`

Pure parsers live in `src/git/status.ts` (`parseStatus`, `parseNumstat`,
`parseLsFiles`), unit-tested in `status.test.ts`.

## The reactive `GitRepo` — `src/git.ts`

`CliGitRepo implements GitRepo` (created via `openGitRepo`, pooled via
`acquireGitRepo`/`releaseGitRepo`). It exists because several call sites read git
state **synchronously** and cannot await:

- command predicates — `when: () => this.git.getBranch() !== null`.
- `GitBranchButton.refresh()` / `FileTree.refreshStatuses()` — render
  synchronously inside an `onChange` callback.

So the architecture is **async background poll → cached state → synchronous
getters**:

```
                 ┌─ git status --porcelain=v2 --branch -z --untracked-files=all ─┐
 1.5s poll  ──►  ├─ git diff --numstat -z HEAD ─────────────────────────────────┤
 (+ HEAD watch)  └─ git ls-files -z  (only when the index/HEAD moved) ───────────┘
                                   │  git(cwd, args, cb) — async, never blocks
                                   ▼  parse (pure fns, unit-tested)
                         this.state = { branch, commit, status, ahead,
                                        conflicts, fileStatuses, tracked }
                                   │ fire onChange iff signature() changed
   getBranch()/getHead()/getStatus()/… ◄────┘  cached field reads, no I/O
```

- Warmed up **asynchronously** at construction (`warmUp()`): an async
  `rev-parse --absolute-git-dir` + an immediate async `pollOnce()`, so acquiring a
  repo never blocks the UI thread. The getters return the empty state until that
  first poll lands (~tens of ms) — first paint shows a blank branch indicator for
  a frame, then the poll's `notify()` fills it in (subscribers register on the same
  tick as the acquire, before status returns). (Was a synchronous `seed()`.)
- **Change detection**: a **chokidar** watch on `<git-dir>/HEAD` (`startHeadWatch`,
  attached once the async warm-up resolves the git dir; chokidar handles the atomic
  rename git does to `HEAD`) for instant branch-switch/commit reaction, plus the
  1.5 s poll for working-tree edits and staging. On a HEAD event the signature is
  reset and `pollOnce()` runs. `signature()` is
  computed from the porcelain output — branch, HEAD commit, ahead/behind,
  conflicts, **per-file staged/unstaged/untracked state**, and ± totals — so it
  moves on edits, staging (including external `git add`), branch/upstream
  changes, and any HEAD move (commit/reset/external push).
- `getStatus()` totals preserve the old libgit2 behaviour: tracked `--numstat`
  adds/dels **plus** untracked files counted as insertions (the branch
  indicator's `+` relies on this). `countNewLines` caps each untracked file at 10
  MiB and treats binaries as 0; the whole subprocess output is bounded by the 64
  MiB `maxBuffer`.

### Coordinated mutations

Every repo mutation goes through a **named method on `GitRepo`** that marks the
repo busy (the branch indicator spins), runs the git/gh command, then refreshes
and reports `(ok, stderr)` via `GitOpDone`:

- git: `fetch`, `pull`, `push`, `commit(messageFile)`, `stash`,
  `stashPop/Apply/Drop(ref)`,
  `switchBranch/createBranch/deleteBranch/mergeBranch/renameBranch(name)`
- gh: `checkoutPullRequest(number)` — wraps github.ts's `gh pr checkout`.

The UI calls these (e.g. `git.switchBranch(name, report)`) and never manages busy
state itself. The coordination primitives are **private**: `mutate(op, onDone)`
brackets the op with `begin()`/end (reference-counted busy + a forced
`pollOnce()` refresh on completion). There is no public `run`/`beginOperation`,
so callers can't bypass the coordination (type-enforced). This matters for a
multi-second `gh pr checkout` (switches branch, fetches forks): it spins the
indicator and refreshes on completion instead of waiting on the file watch.

## UI

### Left-dock layout

Source Control is a **sibling tab of the file tree** in the left-dock top panel.
`buildWorkbench` (`AppWindow`) adds only the `  Files` tab (`fileIconGlyph`) up
front; the ` Git` tab (`Icons.git`, embedded in the Adw tab title) is **created
lazily** the first time it's revealed (`AppWindow.ensureGitPanel`, driven by
`git-panel:focus`), so a workbench opens no git-subscribing `GitPanel` until the
user asks for it (`workbench.gitPanel`/`gitTab` are null until then). The panel
collapses out of the workbench when its last tab closes; the reveal/focus path
re-attaches it (per-workbench, so each agent workbench has its own). `#GitPanel`
is the CSS/selector identity.

### Status viewer — `src/ui/GitPanel.ts`

Component **`GitPanel`** (`#GitPanel`), exposing `root` (a scrollable column).
Constructed with `{ cwd, git, onOpenFile, onCommit }`; rebuilds on `git.onChange`
via an async `getChangesAsync` fetch (a generation guard drops a result superseded
by a newer refresh — no `git status` on the UI thread). `setRoot(cwd, git)`
re-roots it when an agent moves into a worktree.

- **Staged** group — `RowKind: 'staged'`, per-row unstage, drawn in
  `theme.ui.success`.
- **Changes / Untracked** — `RowKind: 'unstaged'`, stage + discard, drawn in
  `theme.ui.error`.

Each group is a small header (label + count) over a `Gtk.ListBox` of file rows
(file icon + path + a single-letter state badge, `STATE_LETTER`). Rows are
cursor-navigable (header rows non-selectable). Actions go through the command
system so they're keybindable while the panel is focused: `s` stage, `u`
unstage, `A` stage-all/unstage-all toggle, `X` discard, `c c` commit — mirroring
FileTree's bare-key bindings. Clicking/`o` opens the file. In-panel diffs are not
shown here; the diff surfaces are the editor tab, the gutter, and `GitStagingView`.

### Commit interface — edit-in-tab

`c c` (`git:commit`) calls `onCommit` → `AppWindow.startCommit()`, which opens
`.git/COMMIT_EDITMSG` in a **normal editor tab**; **saving + closing the tab
commits** (`git commit -F .git/COMMIT_EDITMSG`). This reuses the full editor
(vim, chrome) with zero `TextEditor` changes and keeps the message git-native.
Result/failures surface through `quilx.notifications`; on success the lists
refresh.

Not done: amend, sign-off, amend-prefill from `git log -1 --format=%B`,
commit-message length ruler, branch-name placeholder.

### Branch / stash pickers

- **`src/ui/BranchPicker.ts`** — switch/create (`openBranchPicker`, `space g b
  b`), delete (`space g b d`), merge into current (`space g b m`), rename (`space
  g b r`). `GitBranchButton` opens the branch picker on click (no popover; the
  picker is the switcher).
- **`src/ui/StashPicker.ts`** — push (`space g s s`), and pop/apply/drop via a
  picker over `listStashes` (`space g s p`/`a`/`d`).
- **`GitBranchButton`** — header indicator (branch, ±lines, ↑↓, busy spinner).

### Diff gutter + hunk staging — `src/ui/TextEditor/GitGutter.ts`

A `GtkSource.GutterRendererText` subclass drawing a VS Code-style change bar per
line. Two in-process Myers diffs feed it (`util/lineDiff`): the live buffer vs the
file's **index** blob (unstaged changes — green added / amber modified / red
deletion marker) and the index vs the **HEAD** blob (staged changes — blue). Both
base blobs are refetched (two `git show` spawns) on load and on any
`GitRepo.onChange`, debounced and generation-guarded against stale async results.
The refetch is **skipped while the editor is unmapped** (off-screen tabs/docks)
and runs on the next `map`, so only visible editors refetch on a repo change.

It also drives **hunk-level staging**: `stageHunk`/`unstageHunk` (`space h s` /
`space h u`) synthesize a unified diff for the hunk under the cursor and
`git apply --cached` it (via `applyPatch`); `revert-hunk` (`space h r`) is done in
the buffer by the editor. Hunk helpers live in `util/hunkPatch.ts`.

### Tab-hosted staging view — `src/ui/GitStagingView.ts`

Opened in an editor tab via `git:open-staging` (`space g o`); coexists with
`GitPanel`. A single scrollable `git status`-style column: each changed file is
one row (full path, staged green / unstaged+untracked red). Pressing `o` expands
an inline **read-only unified `DiffViewer`** directly beneath the row (an
accordion; several can be open at once). Keys while focused: `j`/`k` navigate, `o`
toggle diff, `s`/`u` stage/unstage, `X` discard, `c c` commit. Per-row diff base:
staged = index↔HEAD, unstaged = worktree↔index, untracked = all-added. See
[staging-interface.md](staging-interface.md).

## Forge: GitHub — `src/github.ts` + `src/ui/Github*.ts`

Implemented as a concrete **GitHub** integration driven by the `gh` CLI (not an
abstract `Forge` interface — a second provider can be factored out if/when GitLab
lands).

- **Remote resolution** — `resolveGithubRepo(root, remoteNames)` lists remotes,
  resolves the first present in order, parsing SSH/HTTPS via `parseGithubRemote`
  → `{ host, owner, repo }`. Order is **`upstream` then `origin`**, both from
  config. `repoWebUrl` builds the base URL.
- **`gh`-backed reads** — `fetchPullRequest` (number, url, title, state, CI
  rollup, linked issue), `fetchChecks` / `fetchFailedChecks`,
  `searchPullRequests`, `fetchIssues`, `fetchDefaultBranch`,
  `createPullRequestWeb`, `checkoutPullRequest`.
- **`GithubService`** (`openGithubService(git, options)`) — the reactive model:
  caches PR/CI/default-branch state plus busy, exposes synchronous getters and
  `onChange`, and refreshes off the underlying `git` changes. The header view is
  a pure view over it (so the old per-`onChange` remote-resolution cost is gone).
- **`GithubButtons`** (header) — a `.linked` pair of buttons over `GithubService`:
  the PR segment shows the current branch's PR (state-colored glyph + `#1234`) and
  opens it, or becomes a **create-PR** affordance on a non-default branch; the CI
  segment shows the PR's check rollup and opens the checks picker. Hidden when
  there's nothing actionable.
- **Pickers** — `GithubPrPicker` (checkout), `GithubIssuePicker`,
  `GithubCIChecksPicker`, `GithubFailedCIPicker`.
- **Commands / keymaps** (`space g h …`) — `r` repo, `a` actions, `i` issues,
  `p`/`c` PR checkout, `n` new PR, `o` open this branch's PR, `f` failed CI.

Not done: `#123`-in-text / branch-name / selection detection (offer *Open #123*);
*open file/line on web* (`blameUrl`/`compareUrl`); GitLab and other providers.

## Config: default git workflow

Config keys registered in `src/quilx.ts` (same mechanism as `editor.*`), read via
`quilx.config.get`:

| Key                    | Type   | Default      | Description                                              |
| ---------------------- | ------ | ------------ | -------------------------------------------------------- |
| `git.remotes.upstream` | string | `"upstream"` | Remote name for the canonical repo (PRs/issues, fetch). |
| `git.remotes.origin`   | string | `"origin"`   | Remote name for your fork (push).                        |

Used by forge resolution (upstream → origin order) and as the natural defaults
for push/pull targets. More knobs (default push remote, auto-fetch interval) can
be added as we iterate.

## Shared concerns

- **Errors & feedback**: every mutation reports through `quilx.notifications`
  (success info / failure error). `AppWindow` also offers `git:pull` when the
  branch falls behind upstream.
- **Commands first, bindings central**: each component registers its handlers;
  key bindings live in `src/keymaps/default.ts` (vim bare keys while the relevant
  list/panel is focused).
- **Theming**: reuse the semantic colors wired for diffs/sync
  (`.quilx-diff-added/-removed`, the `theme.ui.success/error/warning` keys).
- **Destructive ops** (discard, force) confirm first and never run implicitly.

## Correctness edge cases (parsers + `status.test.ts`)

Not-a-repo → all null/empty; detached HEAD → branch = short SHA, ahead/behind
null; unborn branch (`diff HEAD` fails) → everything untracked/added; renames
consume the trailing original-path token; worktrees/submodules resolve via `cwd`.
Porcelain v2 includes the staged X state, so an external `git add` fires
`onChange`.

## Phasing

- [x] Backend: `src/git/cli.ts` helper (async `git`, pure-fs topology) + porcelain v2 parsing
- [x] Left-dock: Source Control as a sibling tab of FileTree (lazily created on
  first reveal — not built/subscribed at startup)
- [x] Status viewer: staged/changes/untracked lists with stage/unstage/discard
- [x] Commit: `.git/COMMIT_EDITMSG` + `git commit -F` (edit in a tab, commit on save+close)
- [ ] Commit extras: amend, sign-off, amend prefill, length ruler
- [x] Config: `git.remotes.upstream` / `git.remotes.origin`
- [x] Forge: remote parsing (upstream→origin) + GitHub open-on-web (`GithubButtons`)
- [x] Forge: GitHub PR + CI status, PR/issue/CI pickers, create/checkout PR (via `gh`); reactive `GithubService`
- [ ] Forge: `#123` reference detection → open issue/PR; open file/line on web
- [ ] Forge: GitLab provider (factor out a `Forge` interface when it lands)
- [x] Branch management: switch/create/delete/merge/rename pickers
- [x] Stash management: push/pop/apply/drop
- [x] Diff gutter (added/modified/deleted per line; staged vs unstaged)
- [x] Hunk-level staging in the editor (`space h s`/`u`/`r` via `git apply`)
- [x] ~~Tab-hosted staging view — `GitStagingView`~~ **RETIRED** (replaced by the
  continuous editable diff multibuffer below). See [staging-interface.md](staging-interface.md)
  for the original design (kept for history).
- [ ] In-panel diffs in `GitPanel` itself
- [ ] More git diff sources (commit / PR) — see code-editing/diff.md
- [x] **Continuous multi-file editable diff** replacing `GitStagingView` — hunk staging via
  the gutter marker + `space h s`/`space h u`, commit via `space g c`; opened with
  `space g o`/`space g D`. See [../code-editing/multibuffer.md](../code-editing/multibuffer.md)
- [x] Mutations are coordinated `GitRepo` methods; busy+refresh primitives private to the impl
- [x] Two-module boundary: rest of codebase imports only `git.ts`/`github.ts`; `src/git/` internal
- [x] CLI-backed `CliGitRepo`: pure parsers (`status.ts` + `status.test.ts`), async
  warm-up + 1.5 s poll + chokidar `HEAD` watch + cached getters + coordinated
  mutations (`git.test.ts`); all spawns via the process runner (binary IPC, async-only)
- [x] **All-async git** — no `gitSync`; repo topology
  (`repoRoot`/`worktreeInfo`/`listWorktrees`) read straight from the on-disk git
  layout (pure fs); cold callers (pickers, github remotes, commit path) take callbacks

## Decisions (as built)

- **Diffs**: in `GitPanel`, status + staging only; diff surfaces are the editor
  tab (`git:diff-current`), the per-line gutter, and `GitStagingView`.
- **Commit buffer**: `.git/COMMIT_EDITMSG` edited in a full editor tab — chosen
  over an embedded mini-editor; no `TextEditor` changes needed.
- **Staging**: file-level (panel + staging view) and hunk-level (gutter).
- **Forge**: concrete GitHub-over-`gh`, not an abstract `Forge` interface
  (extract it when a second provider lands).
- **GitBranchButton**: clicking opens the branch picker.
