# Git

Three deliverables, in priority order — **all three now have a working first
cut** (status viewer, commit, forge links), plus branch/stash management and a
GitHub PR/CI surface that grew out of the forge work:

1. **Status viewer** — a Source Control panel (`GitPanel`), a sibling tab of the
   file tree in the left dock. **Done** (file-level staging; no diffs/hunks).
2. **Commit interface** — message edited in a normal editor tab, commit on
   save/close. **Done** (no amend/sign-off yet).
3. **Forge links** — GitHub repo/actions/issues/PR open-on-web, PR + CI status
   in the header, PR/issue/CI pickers, create/checkout PR. **Done for GitHub**
   (via `gh`); GitLab + `#123`-in-text detection not yet.

Plus: **branch** switch/create/delete/merge/rename (pickers), **stash**
push/pop/apply/drop, and a per-line **diff gutter** in the editor.

This page is the architecture record; the per-feature sections below are kept
updated as the implementation lands. See the Phasing checklist at the bottom for
exact status.

## Current state

The pre-existing primitives that were reused, not rebuilt:

- **`src/git.ts` — `GitRepo`** (CLI-backed `CliGitRepo`; was libgit2/Ggit, see
  "Resolved" below). Synchronous reads (`getBranch`, `getStatus` ±lines,
  `getAheadBehind`, `getFileStatuses`, `getTrackedPaths`) served from cached poll
  state, an async mutation path (`run(args, onDone)`), `isBusy`, and `onChange`
  (HEAD file-monitor + 1.5s working-tree poll keyed on a `signature()`). Parsers
  live in `src/git/status.ts`.
- **`GitBranchButton`** — header indicator (branch, ±lines, ↑↓, busy spinner). Its
  own comment notes it is meant to grow into a branch switcher popover.
- **`FileTree`** — per-file status (untracked / ±lines) and a hide-untracked
  filter, refreshed on `git.onChange`.
- **AppWindow** — `git:fetch` / `git:pull` / `git:push` commands and the
  upstream-behind notification (offers `git:pull` when the branch falls behind).
- **Notifications** — `quilx.notifications` for surfacing operation results and
  failures (replaces ad-hoc toasts).

Constraints carried from the codebase:

- **I/O model (measured, not assumed).** A probe under the live GLib main loop
  (`startLoop()` + `loop.run()`) showed:
  - `child_process.execFileSync` / `node:fs` sync — **work** (already used by
    FileTree / FilePicker).
  - `child_process.execFile` **callbacks** — **fire promptly** with full stdout.
  - **Promise / microtask** resolution — fires only when the loop yields, so it
    is effectively starved (this, not "child_process is broken", is why the
    earlier promise-based `simple-git` attempt appeared to hang — see `git.ts`).

  Conclusion: **node I/O is fine** for git. Use `node:child_process` directly —
  `execFileSync` for fast local reads, `execFile` (callback form) for anything
  slow or networked. Avoid promise-based wrappers until the loop integration
  drains microtasks. This is simpler than the `Gio.Subprocess` path and hands us
  stdout directly.
- **Strip-only TS** (see project memory): no enums, no parameter properties, no
  namespaces.
- **One main component per file** under `src/ui`, camel-cased after the
  component.

## Module boundary (public API)

The rest of the codebase imports git/GitHub functionality from exactly **two**
modules: **`src/git.ts`** and **`src/github.ts`**. Everything under **`src/git/`**
(`cli.ts`, `status.ts`) is internal:

- `src/git.ts` is the git facade — the reactive `GitRepo` (below) plus a
  `export * from './git/cli.ts'` that re-exports the CLI surface (status/staging/
  branch/stash/commit helpers + types). Callers do `import { … } from '../git.ts'`.
- `src/github.ts` is the GitHub facade (`gh`-backed PR/issue/CI reads). It's the
  one other module allowed to use the internal `git/cli.ts` directly (it imports
  `gitSync`/`currentBranch` from there) — deliberately, so it stays GTK-free and
  unit-testable, while the rest of the codebase still only sees `git.ts`/`github.ts`.

Invariant (grep-checkable): nothing outside `git.ts`/`github.ts` imports
`git/cli.ts` or `git/status.ts`.

## Backend: the git CLI helper — `src/git/cli.ts` (done, internal)

The git operations use **`node:child_process` + the `git` CLI** rather than
extending the libgit2 `GitRepo`. The CLI gives us exactly what `git status`/`git
diff` print (no re-deriving with three libgit2 diffs), and respects the user's
hooks and config (name/email, GPG, pre-commit/commit-msg) for free. The existing
libgit2 reads (GitBranchButton, FileTree) stay as-is; consolidate later if worth
it.

`src/git/cli.ts` wraps the CLI (note: `cwd` is the first arg of every call):

```ts
gitSync(cwd, args): string;                       // execFileSync, fast local reads (64 MiB cap)
git(cwd, args, onDone): void;                      // execFile callback, onDone(ok, stdout, stderr)
repoRoot(cwd): string | null;                      // rev-parse --show-toplevel
commitMsgPath(root): string;                       // .git/COMMIT_EDITMSG
```

(No promise wrappers — microtasks are starved under the loop; see Current state.)

### Status model (done)

`getChanges(root)` parses `git status --porcelain=v2 -z` into a flat list the
panel groups itself; a file edited both in index and worktree is pushed as **two**
rows (staged + unstaged):

```ts
type GitFileState = 'new' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
interface GitChange {
  path: string;     // absolute
  state: GitFileState;
  staged: boolean;  // index vs HEAD
  unstaged: boolean;// workdir vs index
}
```

Porcelain v2 reports staged (X) and unstaged (Y) state per file in one call.
Line counts (±) per row are not surfaced in the panel yet (FileTree still shows
its own ± from libgit2).

### Mutations (done)

`cli.ts` exposes each as an `execFile`-callback function:

- stage / unstage: `stage` (`git add`), `unstage` (`git restore --staged`)
- stage-all / unstage-all: `stageAll`, `unstageAll`
- discard: `discard` (`git restore`, tracked) / `clean` (`git clean`, untracked) — destructive, confirmed first
- commit: `commit(root, messageFile, …)` → `git commit -F <msgfile>` (no `--amend`/`--signoff` yet)
- branch: `currentBranch`, `listBranches`, `switchBranch`, `createBranch`, `deleteBranch`, `mergeBranch`, `renameBranch`
- stash: `listStashes` (→ `Stash[]`), `stashPush`, `stashPop`, `stashApply`, `stashDrop`

Per-path diff **text** (`git diff [--staged] -- <path>`) is not wired into the
panel; the editor-tab diff (`git:diff-current`, working-tree vs HEAD) is the
diff surface today.

### Refresh

After an in-app mutation completes, refresh directly (the callback fires
promptly). To also catch changes made from a terminal, reuse the existing
`git.onChange` (HEAD monitor + poll); note its `signature()` is HEAD→workdir
totals and does **not** move on staging alone, so external `git add` won't auto-
refresh until `signature()` learns about the index — a known gap, fine to defer.

## UI: left-dock layout (done — landed as a sibling tab)

**Where it actually went:** Source Control is a **sibling tab of the file tree**
in the left-dock top panel, not a separate section above it. `buildWorkbench`
(`AppWindow`) adds two tabs to one `Panel` — `  Files` (`fileIconGlyph`) and
` Git` (`Icons.git`, embedded in the Adw tab title) — defaulting to Files. The
panel collapses out of the workbench when its last tab closes and the
reveal/focus path re-attaches it (per-workbench, so each agent workbench has its
own). `#GitPanel` is the CSS/selector identity.

## Feature: status viewer — `src/ui/GitPanel.ts` (done)

Component **`GitPanel`** (`#GitPanel`), exposing `root` (a scrollable column).
Constructed with `{ cwd, git, onOpenFile, onCommit }`; rebuilds on
`git.onChange`.

Layout:

- **Staged** group — `RowKind: 'staged'`, per-row unstage; staged status drawn in `theme.ui.success`.
- **Changes / Untracked** — `RowKind: 'unstaged'`, stage + discard; drawn in `theme.ui.error`.

Each group is a small header (label + count) over a `Gtk.ListBox` of file rows
(file icon + path + a single-letter state badge, `STATE_LETTER`). Rows are
cursor-navigable (header rows are non-selectable/non-activatable). Actions go
through the command system so they're keybindable while the panel is focused
(`s` stage, `u` unstage, `A` stage-all/unstage-all toggle, `X` discard,
`c c` commit) — mirroring FileTree's bare-key bindings. Clicking/`o` opens the
file.

**Diffs.** Still not in the panel — rows show status and support staging only.
The diff surface today is the editor tab (`git:diff-current` = working tree vs
HEAD) plus the per-line gutter (below). Hunk/line staging and an in-panel diff
are future work.

## Feature: commit interface (done — edit-in-tab, not inline)

**Where it actually went:** not an embedded mini-editor in the panel. `c c`
(`git:commit`) calls `onCommit` → `AppWindow.startCommit()`, which opens
`.git/COMMIT_EDITMSG` in a **normal editor tab**; **saving + closing the tab
commits** (`git commit -F .git/COMMIT_EDITMSG`). This reuses the full editor
(vim, chrome) with zero `TextEditor` changes and keeps the message git-native.
Result/failures surface through `quilx.notifications`; on success the lists
refresh.

Not done: amend, sign-off, amend-prefill from `git log -1 --format=%B`,
commit-message ruler/length hint, branch-name placeholder.

## Feature: forge links — `src/github.ts` + `src/ui/Github*.ts` (GitHub done)

Implemented as a concrete **GitHub** integration driven by the `gh` CLI (not the
abstract `Forge` interface that was sketched — `GitLabForge` etc. can be factored
out if/when a second provider lands).

- **Remote resolution** — `resolveGithubRepo(root, remoteNames)` lists remotes,
  then resolves the first present in order, parsing SSH/HTTPS via
  `parseGithubRemote` → `{ host, owner, repo }`. Order is **`upstream` then
  `origin`**, both from config (`git.remotes.upstream` / `git.remotes.origin`,
  registered in `src/quilx.ts`, defaulting to `upstream`/`origin`).
- **`src/github.ts`** — `gh`-backed reads: `fetchPullRequest` (number, url,
  title, state, CI rollup, linked issue), `fetchChecks` / `fetchFailedChecks`
  (CI status buckets), `searchPullRequests`, `fetchIssues`, `fetchDefaultBranch`,
  `createPullRequestWeb`, `checkoutPullRequest`. `repoWebUrl` builds the base URL.
- **`GithubButtons`** (header) — repo/actions/issues/pulls open-on-web; the PR
  segment shows the current branch's PR (glyph + `#1234`, colored by state) and
  opens it, or becomes a **"create PR"** affordance on a non-default branch; a CI
  glyph reflects the PR's check rollup and opens the checks picker. Hidden when no
  GitHub remote resolves.
- **Pickers** — `GithubPrPicker` (checkout, `space g h p`/`c`), `GithubIssuePicker`
  (`space g h i`), `GithubCIChecksPicker` (`github:ci-checks`),
  `GithubFailedCIPicker` (`space g h f`).
- **Commands / keymaps** — `space g h`: `r` repo, `a` actions, `i` issues, `p`/`c`
  PR checkout, `n` new PR, `f` failed CI.

Not done: `#123`-in-text / branch-name / selection detection (offer *Open #123*);
*open file/line on web* (`blameUrl`/`compareUrl`); GitLab and other providers.

## Beyond the original plan (also built)

- **Branch management** — `src/ui/BranchPicker.ts`: switch/create
  (`openBranchPicker`, `space g b b`), delete (`space g b d`), merge into current
  (`space g b m`), rename (`space g b r`). `GitBranchButton` now opens the branch
  picker on click (it was specced as a plain indicator).
- **Stash management** — `src/ui/StashPicker.ts`: push (`space g s s`), and
  pop/apply/drop via a picker over `listStashes` (`space g s p`/`a`/`d`).
- **Diff gutter** — `src/ui/TextEditor/GitGutter.ts`: a `GtkSource`
  gutter renderer marking added/modified/deleted lines per file, diffing the live
  buffer against the HEAD blob (debounced, generation-guarded against stale async
  results).

## Mutations: coordinated methods on `GitRepo`

Every repo mutation goes through a **named method on `GitRepo`** that marks the
repo busy (the branch indicator spins), runs the git/gh command, then refreshes
and reports `(ok, stderr)` via the `GitOpDone` callback:

- git: `fetch`, `pull`, `push`, `commit(messageFile)`, `stash`, `stashPop/Apply/
  Drop(ref)`, `switchBranch/createBranch/deleteBranch/mergeBranch/renameBranch(name)`
- gh: `checkoutPullRequest(number)` — git.ts wraps github.ts's raw `gh pr checkout`.

The UI calls these (e.g. `git.switchBranch(name, report)`); it never manages busy
state itself. The coordination primitives are **private to `CliGitRepo`**: a single
`mutate(op, onDone)` brackets the op with `begin()`/end (busy + forced refresh).
`run`/`beginOperation` are **not** on the public interface — callers can't bypass
the coordination (type-enforced).

This (a) fixes the prior bypass where `BranchPicker`/`StashPicker`/commit/`gh pr
checkout` ran CLI mutations directly with no spinner/refresh, and (b) means a
multi-second `gh pr checkout` (switches branch, fetches forks) spins the indicator
and refreshes on completion instead of waiting on the HEAD monitor.

Also fixed alongside: `GithubButtons.refresh()` resolved the GitHub remote (two
sync `git` spawns) on *every* `onChange`; now cached once per session.

## Config: default git workflow (done)

Config keys registered in `src/quilx.ts` (same mechanism as `editor.*`), read via
`quilx.config.get` in `GithubButtons.remoteNames()`:

| Key                     | Type   | Default      | Description                                              |
| ----------------------- | ------ | ------------ | -------------------------------------------------------- |
| `git.remotes.upstream`  | string | `"upstream"` | Remote name for the canonical repo (PRs/issues, fetch). |
| `git.remotes.origin`    | string | `"origin"`   | Remote name for your fork (push).                        |

Used by forge resolution (upstream → origin order) and as the natural defaults
for push/pull targets later. Kept minimal now; more workflow knobs (default
push remote, auto-fetch interval, …) can be added as we iterate.

## Shared concerns

- **I/O**: the new git ops use `node:child_process` + the `git` CLI —
  `execFileSync` for fast local reads, `execFile` (callback) for slow/networked
  ops. No promise wrappers (microtasks are starved under the loop).
- **Refresh**: in-app mutations refresh on their callback; `git.onChange`
  (existing) covers external changes (with the staging-signature gap noted above).
- **Errors & feedback**: every mutation reports through `quilx.notifications`
  (success info / failure error), consistent with fetch/pull/push.
- **Commands first, bindings central**: each component registers its handlers;
  key bindings live in `src/keymaps/default.ts` (vim bare keys while the panel is
  focused, like FileTree).
- **Theming**: reuse the semantic colors already wired for diffs/sync
  (`.quilx-diff-added/-removed`, the `theme.ui.success/error/...` keys).
- **Destructive ops** (discard, force) confirm first and never run implicitly.

## Resolved: Ggit retired → CLI-backed `GitRepo`

**Done.** `src/git.ts` is now `CliGitRepo` (backed by `src/git/cli.ts` + the pure
parsers in `src/git/status.ts`); the `GitRepo` interface is byte-for-byte the same,
so no consumer changed. `Ggit` is gone from the tree (`git.ts`, `gi.ts`, and the
`generate-types` script) — the leak probe now reports **zero `Ggit*` objects**.

**Why it had to go.** Ggit handed back GObjects via GI `<Type>.new()` /
transfer-full returns, and **node-gtk never frees those** — upstream bug
[romgrk/node-gtk#446](https://github.com/romgrk/node-gtk/issues/446) (GObjects from
GI function returns are never GC'd, vs `new <Type>()` which is). The 1.5 s poll
created several per tick (`Repository`, `Diff`, `Tree`, `Ref`, …), so the live heap
grew without bound and every V8 major-GC mark got slower — surfacing as
increasingly long, high-CPU UI hangs the longer quilx ran. (An interim mitigation
— cache one `Repository`, cache `DiffOptions`, memoize ref/index reads — cut the
churn to a single residual `GgitDiff`; the migration removes even that. A related
leak was also fixed in `TextEditor.ts`: `followSystemColorScheme` now disconnects
its global `Adw.StyleManager` `notify::dark` handler on `destroy`.)

How the replacement satisfies the synchronous-read contract and the design details
are in **"Migration design"** below; the short version: an async background poll
(`git status --porcelain=v2 --branch -z` + `diff --numstat` + `ls-files`) updates
cached state and fires `onChange`, and the getters return those cached fields with
no I/O. `getStatus()` preserves the old totals — tracked `--numstat` **plus**
untracked files counted as insertions (the branch indicator's `+` relies on this;
binary and oversized untracked files count as 0) — read once per poll and folded
into both the change-signature and the cached state.

## Migration design: CLI-backed `GitRepo` (the way off Ggit)

Goal: a clean, stable, performant, correct replacement for the libgit2 reads,
**keeping the `GitRepo` interface byte-for-byte** so no consumer changes. `git.ts`
+ `gi.ts:26` are the *only* `Ggit` references in the tree, so this is contained.

### The one hard constraint: reads must be available *synchronously*

These call sites read git state on the synchronous path and cannot await:

- `AppWindow` command predicates — `when: () => this.git.getBranch() !== null`
  (evaluated synchronously every time the palette/keymap re-checks availability).
- `GitBranchButton.refresh()` / `FileTree.refreshStatuses()` — render synchronously
  inside an `onChange` callback (`getBranch`, `hasConflicts`, `isBusy`, `getStatus`,
  `getAheadBehind`, `getFileStatuses`, `getTrackedPaths`).

So we **cannot** make the getters async, and we **must not** make them block:
`execFileSync` per getter would freeze the GLib main loop (and the UI) for the
git command's duration (tens of ms on a big repo), on a hot path called per poll
*and* per palette keystroke.

### Architecture: async background poll → cached state → synchronous getters

```
                 ┌─ git status --porcelain=v2 --branch -z ─┐  (one spawn)
 1.5s poll  ──►  ├─ git diff --numstat -z HEAD ────────────┤  execFile (async,
 (+ HEAD mon)    └─ git ls-files -z  (only when index/HEAD moved) ┘  callback)
                                   │
                                   ▼  parse (pure fns, unit-tested)
                         this.state = { branch, ahead, behind, conflicts,
                                        added, removed, fileStatuses, tracked }
                                   │ fire onChange iff signature changed
   getBranch()/getStatus()/… ◄────┘  return cached fields synchronously (no I/O)
```

- **Background poll uses `git(cwd, args, cb)`** (execFile callback form — proven
  to fire promptly under the loop; promises are the only starved primitive). It
  never blocks the UI.
- **Getters return cached fields** — pure field reads, zero I/O, zero allocation
  of native objects. This is what makes it both synchronous *and* performant.
- **Seed once at construction** with `gitSync` (a single `git status --porcelain=v2
  --branch` + `ls-files`) so the first paint and the first `when:` check are
  correct before the first async poll lands. One short synchronous call at
  startup is acceptable; the steady state is fully async.

### Command mapping (libgit2 read → git CLI → parse)

| `GitRepo` getter | git command(s) | notes |
| --- | --- | --- |
| `getBranch()` | `# branch.head` line of `status --porcelain=v2 --branch` | `(detached)` → use `# branch.oid` short SHA to match libgit2 shorthand |
| `getAheadBehind()` | `# branch.ab +A -B` line (same status call) | line absent (no upstream/detached) → `null` |
| `hasConflicts()` | any `u ` (unmerged) entry in the same status call | |
| `getFileStatuses()` | file entries of the same status call, joined with `diff --numstat -z HEAD` | tracked → `{modified, added, removed}`; `?` → `{untracked}` (no ±, matches today) |
| `getStatus()` (totals) | sum of `--numstat` adds/dels **+** line counts of untracked files | libgit2 used `SHOW_UNTRACKED_CONTENT` (untracked counted as insertions); replicate by reading untracked files (cap size; they're usually few/small) |
| `getTrackedPaths()` | `git ls-files -z` → absolute paths | changes only on add/rm/commit → refresh on index/HEAD move, not every poll |

**One status call covers branch + ahead/behind + conflicts + the file set.** Only
`--numstat` (±) and `ls-files` (tracked) are extra; `ls-files` runs on low
frequency. So a steady poll is **1–2 async spawns / 1.5 s**, none blocking.

### Change detection (`onChange`)

- Keep the **`Gio.FileMonitor` on `HEAD`** for instant branch-switch reaction
  (single long-lived GObject — not part of the leak).
- Keep the **1.5 s working-tree poll**, but compute the signature from the
  porcelain output (branch + ab + per-file XY states + ± totals).
- **Fixes the known staging gap for free:** porcelain v2 includes the staged (X)
  state, so an external `git add` now moves the signature and fires `onChange`
  (the old libgit2 `signature()` only saw HEAD→workdir totals).
- Optional perf: only poll while the window is focused/mapped.

### Mutations & `run()`

`run(args, onDone)` keeps its contract (busy-count + `onChange` on transition and
completion) but routes through `cli.ts`'s `git()` instead of `Gio.Subprocess` —
one fewer subprocess mechanism, same async behaviour.

### Correctness edge cases to preserve (cover with tests)

Not-a-repo → all null/empty (`repoRoot` null short-circuits); detached HEAD →
branch = short SHA, ahead/behind null; **unborn branch** (no commits) → `diff HEAD`
fails, treat everything as untracked/added; renames (porcelain `2 `) consume the
trailing original-path token; worktrees/submodules resolve via `cwd`; huge output
bounded by the 64 MiB `maxBuffer`.

### Migration phases (low-risk, incremental — interface never changes)

1. **Parsers first (pure, testable).** Add `src/git/status.ts`: `parseStatus`
   (porcelain v2 → `{branch, ahead, behind, conflicts, files}`) and `parseNumstat`.
   Unit-test with fixtures + a temp-repo integration test (mkdtemp, like the LSP
   tests). This is where "correct" is earned.
2. **`CliGitRepo implements GitRepo`** in `src/git.ts` (or `src/git/repo.ts`):
   sync seed + async poll + cached getters + HEAD monitor + `run()`. No consumer
   touches it — they use the `openGitRepo` factory and the interface.
3. **Flip the factory** `openGitRepo` to construct `CliGitRepo`. Smoke-test the
   live app (branch button, file tree ±, fetch/pull/push, panel refresh).
4. **Delete Ggit:** remove the `GgitRepo` class, `Ggit.init()`, `gi.ts:26`, and
   `Ggit-1.0` from the `generate-types` script. Re-run the headless leak probe to
   confirm zero `Ggit*` objects remain.

### Why this satisfies the four goals

- **Clean** — one small interface, backed by the CLI layer already used everywhere
  else; deletes the entire libgit2/GObject code path.
- **Stable** — no node-gtk object-lifecycle exposure at all (kills node-gtk#446
  for git); `git` is the source of truth and honours the user's config/hooks.
- **Performant** — steady state is 1–2 async spawns/1.5 s off the UI thread;
  getters are cached field reads; no per-poll native allocation.
- **Correct** — porcelain v2 is git's own machine format; parsers are pure and
  unit-tested; the staging-signature gap is fixed as a side effect.

## Phasing

- [x] Backend: `src/git/cli.ts` helper (`gitSync` / `git`) + `git status --porcelain=v2` parsing
- [x] Left-dock: SourceControl in the dock (landed as a sibling tab of FileTree, not a section above it)
- [x] Status viewer: staged/changes/untracked lists with stage/unstage/discard
- [x] Commit: `.git/COMMIT_EDITMSG` + `git commit -F` (edit in a normal tab, commit on save+close — not an inline editor)
- [ ] Commit extras: amend, sign-off, amend prefill, length ruler
- [x] Config: `git.remotes.upstream` / `git.remotes.origin`
- [x] Forge: remote parsing (upstream→origin) + GitHub open-on-web (`GithubButtons`)
- [x] Forge: GitHub PR + CI status, PR/issue/CI pickers, create/checkout PR (via `gh`)
- [ ] Forge: `#123` reference detection → open issue/PR; open file/line on web
- [ ] Forge: GitLab provider (factor out the `Forge` interface when it lands)
- [x] Branch management: switch/create/delete/merge/rename pickers
- [x] Stash management: push/pop/apply/drop
- [x] Diff gutter in the editor (added/modified/deleted per line)
- [ ] In-panel diffs / hunk-level staging (left-dock `GitPanel`)
- [~] **Tab-hosted staging interface** — `GitStagingView` (`src/ui/GitStagingView.ts`),
  opened in an editor tab via `git:open-staging` (`space g o`). Horizontal split:
  a `git status`-style file list (staged green / unstaged + untracked red,
  file-level stage/unstage/discard) + an embedded commit box on the left; an
  **editable `TextEditor`** of the selected file on the right (gutter change bars +
  hunk staging via `space h s`/`u`). Coexists with `GitPanel`. The right pane is
  meant to grow into the full inline/side-by-side diff renderer (editable new-side
  lines keep vim). See [staging-interface.md](staging-interface.md).
- [ ] More git diff sources (staged / commit / PR) — see code-editing/diff.md
- [x] Mutations are coordinated `GitRepo` methods (fetch/pull/push/commit/stash*/branch*/checkoutPullRequest); busy+refresh primitives private to the impl — see "Mutations: coordinated methods" above
- [x] Two-module boundary: rest of codebase imports only `git.ts`/`github.ts`; `src/git/` internal — see "Module boundary" above
- [x] Mitigate the Ggit/node-gtk leak in `src/git.ts` (cache repo + memoize reads) — see "Known issue" above
- [x] Migrate off Ggit → CLI-backed `GitRepo` (see "Migration design" above; node-gtk#446):
  - [x] `src/git/status.ts`: pure `parseStatus` (porcelain v2) + `parseNumstat` + `parseLsFiles`, with unit tests (`status.test.ts`, 14)
  - [x] `CliGitRepo implements GitRepo`: sync seed + async poll + cached sync getters + HEAD monitor + `run()`; temp-repo integration test (`git.test.ts`, 7)
  - [x] Flipped `openGitRepo` to `CliGitRepo`; live poll + HEAD-monitor verified under the app loop (edit → `getStatus` updates, branch switch → `getBranch` updates)
  - [x] Deleted `GgitRepo` + `Ggit.init()` + `gi.ts` Ggit export + `Ggit-1.0` from `generate-types`; leak probe shows zero `Ggit*` objects

## Decisions (as built)

- **Diffs**: status + staging only in the panel; the diff *surface* is the editor
  tab (`git:diff-current`) + the per-line gutter. Hunk/line staging deferred.
- **Commit buffer**: `.git/COMMIT_EDITMSG` edited in a full editor tab (save+close
  commits) — chosen over an embedded mini-editor; no `TextEditor` changes needed.
- **Staging**: file-level only (hunk/line staging later).
- **Forge**: concrete GitHub-over-`gh` implementation, not the abstract `Forge`
  interface (extract it when a second provider lands).
- **GitBranchButton**: clicking opens the branch picker (no popover; the picker
  is the switcher).
