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

- **`src/git.ts` — `GitRepo`** (libgit2 via Ggit). Synchronous reads
  (`getBranch`, `getStatus` ±lines, `getAheadBehind`, `getFileStatuses`,
  `getTrackedPaths`), an async mutation path (`run(args, onDone)` via
  `Gio.Subprocess`, non-blocking, GLib-native), `isBusy`, and `onChange`
  (HEAD file-monitor + 1.5s working-tree poll keyed on a `signature()`).
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

## Backend: the git CLI helper — `src/git/cli.ts` (done)

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

## Feature: forge links — `src/git/github.ts` + `src/ui/Github*.ts` (GitHub done)

Implemented as a concrete **GitHub** integration driven by the `gh` CLI (not the
abstract `Forge` interface that was sketched — `GitLabForge` etc. can be factored
out if/when a second provider lands).

- **Remote resolution** — `resolveGithubRepo(root, remoteNames)` lists remotes,
  then resolves the first present in order, parsing SSH/HTTPS via
  `parseGithubRemote` → `{ host, owner, repo }`. Order is **`upstream` then
  `origin`**, both from config (`git.remotes.upstream` / `git.remotes.origin`,
  registered in `src/quilx.ts`, defaulting to `upstream`/`origin`).
- **`src/git/github.ts`** — `gh`-backed reads: `fetchPullRequest` (number, url,
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
- [ ] In-panel diffs / hunk-level staging
- [ ] More git diff sources (staged / commit / PR) — see code-editing/diff.md

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
