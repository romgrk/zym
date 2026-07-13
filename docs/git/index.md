# Git

The git subsystem covers three deliverables, plus extras that grew out of
them:

1. **Status viewer** — a Source Control panel (`GitPanel`) that opens as a
   tab in the active center panel. File-level staging.
2. **Commit interface** — message edited in an embedded editor in a vertical
   split above the change list (`ctrl-enter` commits).
3. **Forge links** — GitHub repo/actions/issues/PR open-on-web, PR + CI
   status in the header, PR/issue/CI pickers, create/checkout PR. GitHub
   only (via `gh`).

Plus: **branch** switch/create/delete/merge/rename, **stash**
push/pop/apply/drop, a per-line **diff gutter** with **hunk-level
staging**, and a continuous multi-file editable diff view.

## Module boundary (public API)

The rest of the codebase imports git/GitHub functionality from exactly
**two** modules — **`src/git.ts`** and **`src/github.ts`**. Everything
under **`src/git/`** (`cli.ts`, `status.ts`) is internal:

- `src/git.ts` is the git facade — the reactive `GitRepo` (below) plus
  `export * from './git/cli.ts'`, which re-exports the CLI surface
  (status/staging/branch/stash/commit/worktree helpers + types). Callers
  do `import { … } from '../git.ts'`.
- `src/github.ts` is the GitHub facade: the reactive `GithubService` plus
  the `gh`-backed read functions. It is the one other module allowed to
  use `git/cli.ts` directly (it imports the async `git`/`repoRoot`) —
  deliberately, so it stays GTK-free and unit-testable. Its `gh` spawns
  also route through the process runner.

Invariant (grep-checkable): nothing outside `git.ts`/`github.ts` imports
`git/cli.ts` or `git/status.ts`.

## I/O model

Use `node:child_process` + the `git`/`gh` CLI directly. **Every** git/gh
invocation is **asynchronous** (callback form) — there is no synchronous
git path. Node async IO resolves normally under the live GLib loop;
promises/microtasks are starved, so the whole surface is callbacks (no
promise wrappers). Simpler than `Gio.Subprocess`, and hands us stdout
directly.

All spawning goes through the **process runner** (`src/process/runner.ts`
+ `runner-main.ts` — see [../process-runner.md](../process-runner.md)): the
long-lived ~1.5 GB node-gtk process must never `fork()` (this Node's
libuv has no `posix_spawn` fast path, so fork cost scales with RSS — tens
of ms/spawn). The parent forks once to launch a tiny child; every command
then forks *that* (~1 ms). `cli.ts`'s `git()` and github.ts's `gh()` both
call `runProcess`, with a direct-spawn fallback if the runner is down. IPC
is **binary** (`src/process/codec.ts`): a length-prefixed frame whose
stdout/stderr (up to 64 MiB) cross the pipe as raw bytes, never
JSON-escaped.

**Locking:** every invocation is `git --no-optional-locks <cmd>` (the flag
must precede the subcommand; prepended centrally in `cli.ts`, equivalent to
`GIT_OPTIONAL_LOCKS=0`, git ≥ 2.15). Plain `git status` / `git diff` are not
read-only: they opportunistically refresh the index stat cache and rewrite the
index under `.git/index.lock`. Since the reactive poll runs them constantly
(watch events, heartbeat, panel refreshes), it would routinely hold that lock,
and any concurrent real operation — a user/agent `git add`/`commit`/`rebase`
in a terminal, or our own mutations — fails immediately with `Unable to
create '.git/index.lock': File exists` (git never waits for a lock). Worse,
the poll's own index rewrite fired the metadata watcher's `index` watch,
scheduling yet another poll. The flag disables only those *optional*
side-effect writes; mutations (`add`, `commit`, `apply --cached`, …) still
take the mandatory index lock exactly as before. Trade-off: our reads never
freshen the stat cache, so status re-verifies racily-dirty entries until a
real index write lands — negligible next to lock contention.

Repo topology is derived straight from the on-disk git layout — pure `fs`
reads, no subprocess: `repoRoot` (walk up for `.git`, memoized),
`worktreeInfo`, and `listWorktrees` (read `<common>/worktrees/*` + HEAD
via `commondir`/`gitdir`). The cold callers (branch/stash pickers, github
remote resolution, the commit message path) take a callback.

**Remaining perf work:** coalesce the `onChange` fan-out (one `git status`
per root feeding all gutters instead of per-editor `git show` pairs, plus
a per-file gate so a gutter only re-fetches when its own file moved).

## Backend: the git CLI helper — `src/git/cli.ts` (internal)

The CLI gives us exactly what `git status`/`git diff` print (no
re-deriving with libgit2 diffs) and respects the user's hooks and config
(name/email, GPG, pre-commit/commit-msg) for free.

Core primitives (note: `cwd`/`root` is the first arg of every call):

```ts
git(cwd, args, onDone): void;                // async (process runner); onDone(ok, stdout, stderr)
repoRoot(cwd): string | null;                // nearest ancestor with `.git` — pure fs, memoized
commitMsgPath(root, onDone): void;           // async; .git/COMMIT_EDITMSG (via rev-parse --git-path)
```

It also exposes the pure-fs `worktreeInfo` / `listWorktrees`,
`invalidateRepoRoot`, and the async `currentBranch(root, cb)` /
`listBranches(root, cb)` / `listStashes(root, cb)`. There is no `gitSync`.

### Status model

`getChangesAsync(root, cb)` parses `git status --porcelain=v2 -z` into a
flat list the panel groups itself; a file edited in both index and
worktree is pushed as **two** rows (staged + unstaged):

```ts
type GitFileState = 'new' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
interface GitChange {
  path: string;     // absolute
  state: GitFileState;
  staged: boolean;  // index vs HEAD
  unstaged: boolean;// workdir vs index
}
```

It runs the runner's async `git()`, so the Source Control panel (and the
staging view) refresh without blocking the UI thread. Porcelain v2 reports
staged (X) and unstaged (Y) state per file in one call. Per-row line counts
(±) are not surfaced in the panel.

### Mutations

Each is an `execFile`-callback function:

- stage / unstage: `stage` (`git add`), `unstage` (`git restore
  --staged`); `stageAll`, `unstageAll`
- hunk staging: `applyPatch` (`git apply --cached` of a synthesized hunk
  patch — see the diff gutter)
- discard: `discard` (`git restore`, tracked) / `clean` (`git clean`,
  untracked) — destructive, confirmed first
- commit: `commit(root, messageFile)` → `git commit -F <msgfile>` (no
  `--amend`/`--signoff` yet)
- branch: `currentBranch`, `listBranches`, `switchBranch`, `createBranch`,
  `deleteBranch`, `mergeBranch`, `renameBranch`
- stash: `listStashes` (→ `Stash[]`), `stashPush`, `stashPop`,
  `stashApply`, `stashDrop`

Pure parsers live in `src/git/status.ts` (`parseStatus`, `parseNumstat`,
`parseLsFiles`), unit-tested in `status.test.ts`.

## The reactive `GitRepo` — `src/git.ts`

`CliGitRepo implements GitRepo` (created via `openGitRepo`, pooled via
`acquireGitRepo`/`releaseGitRepo`). It exists because several call sites
read git state **synchronously** and cannot await:

- command predicates — `when: () => this.git.getBranch() !== null`.
- `GitBranchButton.refresh()` / `FileTree.refreshStatuses()` — render
  synchronously inside an `onChange` callback.

So the architecture is **async background poll → cached state →
synchronous getters**:

```
                 ┌─ git status --porcelain=v2 --branch -z --untracked-files=all ─┐
 60s heartbeat ─►├─ git diff --numstat -z HEAD ─────────────────────────────────┤
 + file watches  └─ git ls-files -z  (only when the index/HEAD moved) ───────────┘
                                   │  git(cwd, args, cb) — async, never blocks
                                   ▼  parse (pure fns, unit-tested)
                         this.state = { branch, commit, upstream, status, ahead,
                                        conflicts, fileStatuses, tracked }
                                   │ fire onChange iff signature() changed
   getBranch()/getHead()/getUpstream()/getStatus()/… ◄────┘  cached field reads, no I/O
```

- Warmed up **asynchronously** at construction (`warmUp()`): an async
  `rev-parse --absolute-git-dir` + an immediate async `pollOnce()`, so
  acquiring a repo never blocks the UI thread. The getters return the
  empty state until that first poll lands (~tens of ms) — first paint
  shows a blank branch indicator for a frame, then the poll's `notify()`
  fills it in (subscribers register on the same tick as the acquire,
  before status returns).
- **Change detection**: two **chokidar** watches plus a slow backstop poll.
  One watches the git metadata (`startWatch`, attached once the async warm-up
  resolves the dirs; chokidar handles git's atomic renames): the worktree's
  `<git-dir>/HEAD` + `index`, **plus the common dir's `refs/` (recursive) +
  `packed-refs`** for instant branch-switch / commit / staging / reset / merge
  reaction — and crucially the remote-tracking ref moves a `git fetch`/`push`
  makes (ahead/behind), which touch neither `HEAD` nor `index` and so were missed
  before (refs live in the *common* dir, shared across linked worktrees; `HEAD`/
  `index` are per-worktree, so both dirs are resolved via `rev-parse
  --absolute-git-dir --git-common-dir`). On such an event the signature is reset
  and `pollOnce()` runs. The other (`syncContentWatch`) watches
  the **working-tree directories that hold tracked files** — non-recursively
  (`depth: 0`), with `.git` ignored — so an external tool or agent editing a tracked
  file (or dropping a new file beside one) refreshes live, the case `HEAD`/`index`
  can't see. Watching tracked-file dirs only keeps it off gitignored trees
  (`node_modules`, build output) for free, and the dir set is re-derived after each
  refresh as the tracked set moves (add/rm/commit/checkout). Its events are
  **throttled** (leading + trailing, `CONTENT_THROTTLE_MS`) so a burst — a build, a
  multi-file agent edit — collapses to one `git status`; past `MAX_WATCHED_DIRS`
  directories the content watch is dropped in favour of the heartbeat. A **60 s
  heartbeat** poll remains as a pure backstop for anything every watch missed.
  `signature()` is computed from the porcelain output — branch, HEAD commit, upstream
  ref, ahead/behind, conflicts, **per-file staged/unstaged/untracked state**, and ±
  totals — so it moves on edits, staging (including external `git add`),
  branch/upstream changes, and any HEAD move (commit/reset/external push). The
  upstream tracking ref (porcelain v2's `# branch.upstream`, e.g. `origin/main`) is
  parsed into the state and exposed by **`getUpstream()`** for the panel's `git
  status` preamble.
- `getStatus()` totals count tracked `--numstat` adds/dels **plus**
  untracked files as insertions (the branch indicator's `+` relies on
  this). `countNewLines` caps each untracked file at 10 MiB and treats
  binaries as 0; the whole subprocess output is bounded by the 64 MiB
  `maxBuffer`.

### Coordinated mutations

Every repo mutation goes through a **named method on `GitRepo`** that
marks the repo busy (the branch indicator spins), runs the git/gh command,
then refreshes and reports `(ok, stderr)` via `GitOpDone`:

- git: `fetch`, `pull`, `push(remote?)`, `commit(messageFile)`,
  `revert(sha)`, `stash`, `stashPop/Apply/Drop(ref)`,
  `switchBranch/createBranch/deleteBranch/mergeBranch/renameBranch(name)`.
  `push` does a plain `git push` when the branch already tracks an upstream;
  on the **first push of a new branch** (no upstream tracking ref) it resolves
  the branch name (`git branch --show-current`, empty on a detached HEAD →
  plain push) and sets the upstream with `-u <remote> <branch>` (`remote`
  defaults to `origin`, wired from `git.remotes.origin`). `revert` runs
  `git revert --no-edit <sha>`.
- gh: `checkoutPullRequest(number)` — wraps github.ts's `gh pr checkout`.

The UI calls these (e.g. `git.switchBranch(name, report)`) and never
manages busy state itself. The coordination primitives are **private**:
`mutate(op, onDone)` brackets the op with `begin()`/end (reference-counted
busy + a forced `pollOnce()` refresh on completion). There is no public
`run`/`beginOperation`, so callers can't bypass the coordination
(type-enforced). This matters for a multi-second `gh pr checkout`
(switches branch, fetches forks): it spins the indicator and refreshes on
completion instead of waiting on the file watch.

## UI

### Layout — a center tab

Source Control **opens as a tab in the active center panel** (like a normal
editor tab), via `git-panel:focus` → `AppWindow.revealGitPanel`. The ` Git`
tab (`Icons.git`, embedded in the Adw tab title) and its `GitPanel` are
**created lazily** the first time it's revealed (`AppWindow.ensureGitPanel`),
so a workbench opens no git-subscribing `GitPanel` until the user asks for it
(`workbench.gitPanel`/`gitTab` are null until then). Revealing again reveals
the existing tab when it's still hosted (`Panel.containing`); otherwise it
re-adds it, unparenting any closed page first (the zombie rule — see
[../workbench.md](../workbench.md)). The `GitPanel` is owned per-workbench (each
agent workbench has its own) and reused across close/reopen — closing the tab
keeps it alive for the next reveal. `#GitPanel` is the CSS/selector identity.
(The file tree keeps the right-side dock; `git:` was previously a dock tab.)

**Sizing (why the panel used to vanish / paint blank).** The page's content bin is an
`Adw.Bin` (AdwTabView's page host); the panel is fragile to bad size *measures* Adw caches
into it. Two guards keep the measure valid at all times:

- The panel's two `Gtk.Paned`s (`root` and the inner `split`) keep their children
  **shrinkable** (`shrink-child = true`, GtkPaned's default) while pinning their *width* with
  `resize-child = false`. This matters because the change list can't scroll horizontally (its
  `ScrolledWindow` is `NEVER`-hpolicy), so its **width minimum is the content's** (~240px), and
  with the embedded diff open the split's minimum is the *sum* (~650px). With `shrink = false`
  that sum is an **unshrinkable floor**: in any pane narrower than it — a narrow window, a split,
  the file-tree/agent columns eating the width — Adw gets an *unsatisfiable* measure, caches it,
  and allocates the page bin a degenerate size, **dropping the child** (the Adw.Bin goes empty)
  or painting it blank. It comes back on the next reveal (`git-panel:focus` re-adds the orphaned
  `root`). Making the children shrinkable collapses the panel's measured minimum to ~0, so the
  measure is always satisfiable. (Verified by `root.measure()`: ~275→657px with `shrink=false`,
  **120px** — the `setSizeRequest` floor — with `shrink=true`.)
- `root` also carries a small `setSizeRequest(120, 80)` floor, so even a degenerate 0-measure
  (e.g. on **close → re-add** while a git refresh is relaying out the list) can't be cached as
  `0×0` and paint the re-added page blank.

Note the earlier assumption that "the ScrolledWindow's minimum is `0×0`" held only for *height*
(it scrolls vertically); its **width** minimum is the list content's, which is what the shrink
guard addresses.

### Status viewer — `src/ui/git/GitPanel.ts`

Component **`GitPanel`** (`#GitPanel`), whose `root` is an **outer vertical
`Gtk.Paned`**: the **embedded commit editor** (the start child, added by `c c`;
see "Commit interface" below) over the **inner horizontal `Gtk.Paned`**
(`this.split`, the end child) holding the change list (`#GitPanelList`, its start
child) and — once a change is opened — an **embedded live diff** (its end child,
taking most of the width; see "Embedded diff" below). `.GitPanel` lives on the
outer Paned so it scopes every descendant (list, diff, commit box). Constructed
with `{ cwd, git, onOpenFile, buildDiffView }`; rebuilds on `git.onChange` via an
async `getChangesAsync` fetch (a generation guard drops a result superseded by a
newer refresh — no `git status` on the UI thread). `setRoot(cwd, git)` re-roots it
when an agent moves into a worktree.

Above the groups it prints a **`git status`-style preamble** (`statusRow` +
the pure `gitStatusLines`, read from `getBranch()` / `getUpstream()` /
`getAheadBehind()`): `On branch <branch>` plus the upstream tracking line
(ahead / behind / diverged / up-to-date), mirroring git's wording, with the
parenthetical advice hint (`use "git push"…`) muted. Omitted when there's no
branch.

- **Staged** group — `RowKind: 'staged'`, per-row unstage, drawn in
  `theme.ui.success`.
- **Changes / Untracked** — `RowKind: 'unstaged'`, stage + discard, drawn
  in `theme.ui.error`.

Each group is a small header (label + count) over a `Gtk.ListBox` of file
rows: the single-letter state badge (`STATE_LETTER`, small + bold with one
row-spacing of trailing margin) leads, followed by the path in the monospace
font, both tinted the same staged-green / unstaged-red color. Rows are
cursor-navigable (header rows non-selectable), each section separated by `2×`
the row spacing. Actions go through the command system so they're keybindable
while the **list** is focused (the keys are scoped to `#GitPanelList`, not the
panel root, so they don't fire inside the embedded diff): `s` stage, `S`
stage-all (`git add -A`), `u` unstage, `U` unstage-all (`git reset`), `X`
discard (`git restore` for a tracked file, `git clean` for an untracked one),
`c c` commit — mirroring FileTree's bare-key bindings. (`S`/`U` replaced the
earlier `A` stage/unstage-all toggle.)

Below the list (bottom-left of the list column) a **keybinding-hints footer**
(`KeybindingHints`, `src/ui/KeybindingHints.ts`) shows those bindings (`s`
stage · `S` stage all · `u` unstage · `U` unstage all · `X` discard · `c c`
commit) as `Keycap` chips. The chips live in an **`Adw.WrapBox`** so they wrap
onto more lines when the column is narrow (each keycap stays glued to its action
word). It's gated on **`help.showKeybindings`** (default `true`) and tracks it
**reactively** (`config.observe`) — toggling the setting shows/hides it live.
The commit box shares the same component (`ctrl-enter` commit / `escape`
cancel).

#### Embedded diff

`l` / `enter` / `o` (and a single click on a row) open the selected change in a **live,
editable working-tree `DiffView`** embedded as the Paned's end child (a vertical
divider; the diff takes most of the width). The view is built by the host via
`GitPanelOptions.buildDiffView` (`AppWindow.buildCurrentChangesDiff`, which owns
the `DocumentRegistry`), so the same multibuffer staging surface as
`git:diff-current-changes` shows here. It is **rebuilt on each open** (so it
always reflects the current change set; a generation guard drops a build a newer
open superseded) and its caret is placed on the opened change's excerpt via
`DiffView.revealFile(path)` → `TextEditor.revealRow`, which places the excerpt **a
quarter down the viewport** with **`scroll_to_mark` (aligned)**
(`EditorModel.scrollCursorToFraction(0.25)`). `scroll_to_mark` defers and validates
the buffer incrementally until the mark is reached, so it lands accurately on a
freshly-embedded multibuffer — unlike `scroll_to_iter` / the `getIterLocation`-based
`setTopBufferRow`, which read an estimate (the header-band block decorations make
line heights variable) and undershoot before the lines above are validated.
`revealRow` re-asserts the scroll for a few frames against a late reflow, and the
diff's `focus()` defers to the view's `map` when it's attached this frame (so a
click / `l` reliably moves focus into it, not just the caret).

The change list **follows the diff caret**: `DiffView.onCursorFileChanged` fires
when the caret crosses into another file's excerpt, and the panel selects that
file's row (`selectRowForPath`, selection only — focus stays in the diff; the
row stays visibly highlighted via the `#GitPanel row:selected` style). `ctrl-w l`
moves focus list→diff, `ctrl-w h` moves diff→list, and `q` (normal mode) closes
the diff back to just the list (`git-panel:focus-diff` / `git-panel:focus-list` /
`git-panel:close-diff`, scoped `#GitPanel #GitPanelList` /
`#GitPanel #TextEditor:not(.insert-mode):not(.GitCommitInput)` /
`#GitPanel #TextEditor.normal-mode`, mirroring the git-log viewer). `ctrl-w h` is
excluded in insert mode so the editor's own insert `ctrl-w` (delete-word) fires
immediately rather than stalling on the chord's partial-match timeout. With no
`buildDiffView` wired, `l`/`enter`/`o` fall back to opening the file
(`onOpenFile`). The diff is disposed with the panel.

The same staging is reachable **from anywhere** (no need to focus the panel)
via the `space g` leader, registered on `#AppWindow`. The `a`dd / `u`nstage
sub-leaders take `a` (all) or `.` (current file): `space g a a`
(`git:stage-all`, `git add -A`) and `space g a .` (`git:stage-current`, `git
add <file>`); `space g u a` (`git:unstage-all`, `git reset`) and `space g u .`
(`git:unstage-current`). They shell out via `git/cli.ts` and then call
`workbench.git.refresh()` so the gutter and branch indicator update at once.

### Commit interface — embedded editor

`c c` (`git:commit`), `space g c` (`git:start-commit`), and the panel's
own commit all open an **embedded commit editor** — `GitCommitBox`
(`src/ui/git/GitCommitBox.ts`) — in the **vertical split above the change
list** (`GitPanel.startCommit`), not a separate tab. It is a buffer-only
`TextEditor` (full vim, syntax, search; `cssClass` `GitCommitInput`):
`ctrl-enter` commits, `alt-enter` inserts a newline (plain `enter` stays a
newline — messages are multi-line), `q`/`escape` (normal mode) cancels.
On submit the panel writes the message to `.git/COMMIT_EDITMSG` (so hooks
+ config apply) and commits via the coordinated
`GitRepo.commit(messageFile, amend)`. An empty message aborts (box stays
open); a failed commit keeps the box so the message isn't lost; only a
successful commit closes it. Result/failures surface through
`zym.notifications`; the list refreshes on `onChange`.

`space g c`/`space g C` (`AppWindow.startCommit`) reveal Source Control and
delegate to `GitPanel.startCommit(amend)` — the panel owns the message →
`git.commit` flow; there is no tab-based commit path (`commitEditors` /
`finishCommit` are gone).

**Amend** (`space g C`, `git:commit-amend`) uses the same embedded editor
but prefills the message with the last commit's (`lastCommitMessage` →
`git log -1 --format=%B`) and finalizes with `git commit --amend`.

The commit-box keys are scoped to `.GitPanel .GitCommitInput` in
`keymaps/default.ts`; the diff's `q` (close-diff) carries
`:not(.GitCommitInput)` so the two editors' keys don't collide. A footer
renders those bindings via the shared `KeybindingHints`
(`src/ui/KeybindingHints.ts`) — `Keycap` chips gated reactively on the
**`help.showKeybindings`** config (default `true`), the same component the
status list uses.

Not done: sign-off, commit-message length ruler, branch-name placeholder.

### Branch / stash pickers

- **`src/ui/git/BranchPicker.ts`** — switch/create (`openBranchPicker`, `space
  g b b`), delete (`space g b d`), merge into current (`space g b m`),
  rename (`space g b r`). `GitBranchButton` opens the branch picker on
  click (no popover; the picker is the switcher).
- **`src/ui/git/StashPicker.ts`** — push (`space g s s`), and pop/apply/drop
  via a picker over `listStashes` (`space g s p`/`a`/`d`).
- **`GitBranchButton`** — header indicator (branch, ±lines, ↑↓, busy
  spinner).

### Diff gutter + hunk staging — `src/ui/TextEditor/GitGutter.ts`

A `GtkSource.GutterRendererText` subclass drawing a VS Code-style change
bar per line. Two in-process line diffs feed it (`util/lineDiff`): the
live buffer vs the file's **index** blob (unstaged changes — green added /
amber modified / red deletion marker) and the index vs the **HEAD** blob
(staged changes — blue). An edit recomputes only the buffer↔index script
(one `diffLines` run shared by the hunks and the staged-row alignment,
150ms-debounced); the HEAD↔index hunks depend only on the bases, so they're
rebuilt when the bases land, not per keystroke pause. Both base blobs are
refetched (two `git show` spawns) on load and on any `GitRepo.onChange`,
debounced and generation-guarded against stale async results. The refetch is **skipped
while the editor is unmapped** (off-screen tabs/docks) and runs on the
next `map`, so only visible editors refetch on a repo change.
For a file outside any repository the git column is not registered with the
composite gutter, no bases are fetched or diffed, and hunk queries/actions stay
empty; moving an editor across that boundary clears any prior hunk state.

It also drives **hunk-level staging**: `stageHunk`/`unstageHunk` (`space h
s` / `space h u`) synthesize a unified diff for the hunk under the cursor
and `git apply --cached` it (via `applyPatch`); `hunk-revert` (`space h
r`) is done in the buffer (restore the hunk's rows to the index version, then
save) — by the editor over its `GitGutter`, and by the continuous diff over its
live new-side `Document`. Hunk helpers live in `util/hunkPatch.ts`.

### Inline blame — `src/ui/TextEditor/GitBlameController.ts`

Current-line blame (GitLens-style), gated by the **`editor.lineBlame`**
config flag (off by default). While on, the line under the cursor trails the
blame for the commit that last touched it (or `You • Uncommitted changes` for
the zero-sha working-tree line). The fields and their order come from
**`editor.lineBlameFormat`** (default `[message, time, author]`; tokens
`message`/`time`/`author`/`date`/`sha`, joined by ` • `, parsed by
`formatBlame`).

Built on `VirtualText` (the native `GtkSourceAnnotations` API, `NONE` style —
plain trailing text, no background), like `InlayHintController`. Blame is
fetched per file with `git blame --line-porcelain --contents -`, feeding the
**live buffer** on stdin so line numbers and uncommitted lines match what the
user sees (not the on-disk file); the result is parsed by `parseBlame` and
cached. Cursor moves and fold toggles re-place the single annotation from the
cache with no new git call (mapping VIEW→MODEL lines through the document, for
folds); an edit invalidates the cache so the next render re-blames (debounced).

Independent of the inline annotation, **`git:show-commit`** (`space g m`) pops
the **full message** of the commit that last touched the cursor line above the
cursor, reusing the LSP hover card. It blames just that line
(`blameCommitForLine` → `git blame -L n,n --contents -`) for the sha, then
`git show -s` for the message; `blameCommitAtCursor` is the shared entry point
(also used by `github:open-pr-for-line`).

### Continuous editable diff

Multi-file staging is done through a **continuous multi-file editable diff
view** (opened with `space g o` / `space g D`, and the GitPanel's embedded
diff): each changed file's hunks are editable inline, hunk staging via the
gutter marker + `space h s` / `space h u`, commit via `space g c`. It is
built on the editor's multibuffer substrate — see
[../text-editor/multibuffer.md](../text-editor/multibuffer.md). This
replaced the earlier tab-hosted `GitStagingView`; its original design is
recorded in [staging-interface.md](staging-interface.md).

Diff-local keys (`#TextEditor.continuous-diff.normal-mode`, more specific than
vim's `#TextEditor`):

- **`g d`** (`diff:open-file`) opens the file/line under the caret in a real
  editor tab (via the view's `onActivate`).
- **`[h` / `]h`** (`diff:prev-hunk` / `diff:next-hunk`, `prevHunk`/`nextHunk`)
  move the caret across the diff's own changed hunks (a maximal run of
  added/removed rows). They **override** vim's gutter-based
  `MoveToPrevious/NextHunk`, which no-ops here (the multibuffer has no gutter).
- **`space h n`** (`git:hunk-stage-next`, live diff only; **`ctrl-]`** is a
  single-chord alternative) stages the hunk under the caret then advances to the
  next — a fast review-and-stage flow. Staging only re-marks rows
  (worktree-vs-HEAD content is unchanged), so the precomputed next-hunk position
  survives the async refresh.

All of these route through `AppWindow.activeContinuousDiff()`, which now resolves
the DiffView **containing keyboard focus** (walking up from the focused widget),
so they work in the GitPanel's *embedded* diff too — not just a diff that is its
own center tab.

### Git log (history) viewer — `src/ui/git/GitLogView.ts`

`git:log` opens **one self-contained center tab**: a horizontal `Gtk.Paned`
with the commit list on the left and the selected commit's read-only diff on
the right (no side-split panel — the viewer hosts and disposes the embedded
`DiffView` itself). The left column is a header (branch + upstream ref /
ahead-behind / HEAD sha) over a live `file:`/`author:`/word **search**
(picker fzy matcher, AND-combined) over a vim-navigable list of the newest
`COMMIT_LIMIT` commits (subject over an "author · date · sha" line).

- **Navigation / preview** — `j`/`k`, `g g`/`G` move the selection and
  **live-preview** that commit's diff in the right pane (debounced
  ~90 ms + generation-guarded, so a fast scroll only builds the commit it
  settles on). `o`/`enter`/`l` load it and move focus *into* the diff. The
  diff is built by `buildCommitDiffView` (shared with `git:diff-commit`,
  vs the commit's first parent), so it gets the fold/expand-context commands
  (`z o`/`z R`/`z m`) for free. `y y` (`git-log:copy-sha`) yanks the selected
  commit's short hash to the system clipboard.
- **Revert** — `R` (`git-log:revert`) reverts the selected commit: an Adwaita
  confirmation, then `GitRepo.revert` → `git revert --no-edit <sha>` (a new
  "Revert …" commit), and the list reloads (top commit re-selected). A revert
  that hits conflicts fails with git's stderr surfaced — resolving it is the
  normal conflict flow.
- **List ↔ diff focus** — the list and the diff are two nested "windows":
  `ctrl-w l` steps from the list into the diff (`git-log:focus-diff`),
  `ctrl-w h` steps back out (`git-log:focus-list`). Both commands are
  registered on the view root so they resolve from anywhere inside the
  viewer. Keys are scoped under `#GitLogList` (bare nav), `#GitLogSearch`
  (drop into the list), and `#GitLogView #GitLogList` / `#GitLogView
  #TextEditor` (the `ctrl-w` focus pair) — see `keymaps/default.ts`.
- **Ref badges** — commits with refs get a **third row** (under the subject +
  meta lines) of chips for the branches/tags pointing at them, so you can see
  where every other branch sits in the history. `listCommits` asks for `%D`
  under `--decorate=full`; `parseRefNames` (in `git/status.ts`) classifies the
  fully-qualified names into `CommitRef`s — local `branch`, remote-tracking
  `remote`, `tag`, or a detached `head` — dropping the symbolic `origin/HEAD` and
  non-branch/tag namespaces. The **current branch (and a detached HEAD) are not
  shown** — only *other* refs decorate (`head: true` is filtered out at the view).
  Chips are color-coded by kind, using libadwaita's OS-following status colors so
  they track the light/dark scheme — local branches **accent**, remote branches
  **warning**, tags **success**. The list never scrolls sideways
  (`scrolled` is `NEVER`/`AUTOMATIC`), so a crowded badge row ellipsizes its chips
  rather than widening. Only refs on the listed (HEAD-reachable) commits decorate —
  the log is still the current branch's history, not `--all`.

## Forge: GitHub — `src/github.ts` + `src/ui/Github*.ts`

Implemented as a concrete **GitHub** integration driven by the `gh` CLI
(not an abstract `Forge` interface — a second provider can be factored out
if/when GitLab lands).

- **Remote resolution** — `resolveGithubRepo(root, remoteNames)` lists
  remotes, resolves the first present in order, parsing SSH/HTTPS via
  `parseGithubRemote` → `{ host, owner, repo }`. Order is **`upstream`
  then `origin`**, both from config. `repoWebUrl` builds the base URL.
- **`gh`-backed reads** — `fetchPullRequest` (number, url, title, state,
  CI rollup, linked issue), `fetchChecks` / `fetchFailedChecks`,
  `searchPullRequests`, `fetchIssues`, `fetchDefaultBranch`,
  `createPullRequestWeb`, `checkoutPullRequest`.
- **`GithubService`** (`openGithubService(git, options)`) — the reactive
  model: caches PR/CI/default-branch state plus busy, exposes synchronous
  getters and `onChange`, and refreshes off the underlying `git` changes.
  The header view is a pure view over it.
- **`GithubButtons`** (header) — a `.linked` pair of buttons over
  `GithubService`: the PR segment shows the current branch's PR
  (state-colored glyph + `#1234`) and opens it, or becomes a **create-PR**
  affordance on a non-default branch; the CI segment shows the PR's check
  rollup and opens the checks picker. Hidden when there's nothing
  actionable.
- **Pickers** — `GithubPrPicker` (checkout), `GithubIssuePicker`,
  `GithubCIChecksPicker`, `GithubFailedCIPicker`.
- **Commands / keymaps** (`space g h …`) — `r` repo, `a` actions, `i`
  issues, `p`/`c` PR checkout, `n` new PR, `o` open this branch's PR, `l`
  open the current line (`github:open-line`), `L` open the PR that introduced
  the current line (`github:open-pr-for-line`), `f` failed CI.

Not done: `#123`-in-text / branch-name / selection detection (offer *Open
#123*); `compareUrl`; GitLab and other providers.

## Config: default git workflow

Config keys registered in `src/zym.ts` (same mechanism as `editor.*`),
read via `zym.config.get`:

| Key                    | Type   | Default      | Description                                              |
| ---------------------- | ------ | ------------ | -------------------------------------------------------- |
| `git.remotes.upstream` | string | `"upstream"` | Remote name for the canonical repo (PRs/issues, fetch). |
| `git.remotes.origin`   | string | `"origin"`   | Remote name for your fork (push).                        |

Used by forge resolution (upstream → origin order) and as the natural
defaults for push/pull targets — `git:push` sets a new branch's upstream to
`git.remotes.origin` (the fork). More knobs (default push remote, auto-fetch
interval) can be added as we iterate.

## Shared concerns

- **Errors & feedback**: mutations are **silent on success** — the panel,
  gutter, and branch indicator already reflect the change, so a success toast
  is just noise. Only **failures** notify (`zym.notifications.addError`); a
  neutral info toast still explains a no-op (e.g. "No stashes", "Not in a git
  repository"). The failure detail is git's own output — `mutate` takes
  **stderr, then stdout** as a fallback,
  because git writes some failure reasons to stdout rather than stderr
  (notably `git commit`'s "nothing to commit …", the common empty-index case);
  surfacing only stderr there left an unactionable placeholder. `AppWindow` also
  offers `git:pull` when the branch falls behind upstream.
- **Commands first, bindings central**: each component registers its
  handlers; key bindings live in `src/keymaps/default.ts` (vim bare keys
  while the relevant list/panel is focused).
- **Theming**: reuse the semantic colors wired for diffs/sync
  (`.zym-diff-added/-removed`, the `theme.ui.success/error/warning`
  keys).
- **Destructive ops** (discard, force) confirm first and never run
  implicitly.

## Correctness edge cases (parsers + `status.test.ts`)

Not-a-repo → all null/empty; detached HEAD → branch = short SHA,
ahead/behind null; unborn branch (`diff HEAD` fails) → everything
untracked/added; renames consume the trailing original-path token;
worktrees/submodules resolve via `cwd`. Porcelain v2 includes the staged X
state, so an external `git add` fires `onChange`.

## Remaining / planned

- [ ] Commit extras: amend, sign-off, amend prefill, length ruler
- [ ] Forge: `#123` reference detection → open issue/PR; open file/line on
  web (`blameUrl`/`compareUrl`)
- [ ] Forge: GitLab provider (factor out a `Forge` interface when it
  lands)
- [ ] In-panel diffs in `GitPanel` itself
- [x] More git diff sources: commit, vs its parent (`git:diff-commit`) and this
  branch vs base, PR-style (`git:diff-branch`) — `src/ui/diffViews.ts`; see
  text-editor/diff.md
- [~] Perf: coalesce the `onChange` fan-out (one `git status` per root +
  per-file refetch gate)
