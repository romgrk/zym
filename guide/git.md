# Git & GitHub

All git functionality lives under the `space g` leader (with hunk operations
under `space h`), and works from anywhere — you don't need to be in the git
panel to stage, commit, or diff.

## The git panel

`space g g` focuses the Source Control panel: the list of changed files, with
an embedded diff. With the list focused:

| Keys        | Action |
| ----------- | ------ |
| `j` / `k`   | move through the changes |
| `l` / `o` / `enter` | open the selected change's diff |
| `s` / `u`   | stage / unstage the file under the cursor |
| `S` / `U`   | stage / unstage everything |
| `X`         | discard the change (restore tracked / delete untracked) |
| `c c`       | commit the staged changes (embedded message editor) |
| `ctrl-w l` / `ctrl-w h` | move between the list and the embedded diff |
| `q`         | (in the diff) collapse back to the list |

In the commit editor, `ctrl-enter` commits and `q`/`escape` in normal mode
cancels.

## Diffs

Every diff is a real editor — you can edit, and stage at hunk level, directly
in the diff view.

| Keys          | Action |
| ------------- | ------ |
| `space g d d` | diff the current changes (the working tree, continuously updated) |
| `space g d c` | pick a commit to diff against its parent |
| `space g d b` | diff this branch vs master/main (PR-style) |
| `space g D`   | diff just the current file (working tree vs HEAD) |
| `space g m`   | show the commit that last touched the current line |

Hunk operations work on the hunk under the cursor, in any editor with a git
gutter or inside a diff:

| Keys        | Action |
| ----------- | ------ |
| `space h s` | stage the hunk |
| `space h u` | unstage the hunk |
| `space h r` | revert (discard) the hunk |
| `space h n` | stage the hunk and advance to the next (`ctrl-]` in diffs) |

Inside a multi-file diff, `z`-prefixed keys manage the view: `z j`/`z k` step
between files, `z /` jumps to one by name, `z c`/`z o`/`z a` close/open/toggle
the file under the cursor, `z m`/`z r` close/open all, `z .` expands the elided
unchanged lines at the nearest `⋯` gap (`z >` reveals whole files, `z <`
re-collapses), and `] h`/`[ h` jump between hunks. `g d` opens the file at the
line under the cursor. `enter` opens a review-comment box that can send the
line and your comment to an agent.

A large diff opens as an overview: any file with at least
`editor.diffCollapseLines` changed lines (default 500; set it to 0 to disable)
starts folded to its header, so you scan the file list first and open the ones
you want with `z o` / `z r`.

## History

`space g v` opens the git log viewer: a filterable commit list with a live diff
preview. `/` filters, `j`/`k` move (previewing as you go), `o`/`enter`/`l`
opens the selected commit's diff, `y y` copies the short hash, and `R` reverts
the commit (with confirmation).

## Branches, stash, remotes

| Keys          | Action |
| ------------- | ------ |
| `space g b b` | branch picker — switch or create |
| `space g b d` | delete a branch |
| `space g b m` | merge a branch into the current one |
| `space g b r` | rename the current branch |
| `space g s s` | stash push |
| `space g s p` | stash pop |
| `space g s a` | stash apply |
| `space g s d` | stash drop |
| `space g f`   | fetch |
| `space g l`   | pull |
| `space g p`   | push |
| `space g c`   | commit staged changes (message in a tab) |
| `space g C`   | amend the last commit (prefilled message) |
| `space g a a` / `space g a .` | stage all / the current file |
| `space g u a` / `space g u .` | unstage all / the current file |

## GitHub

The `space g h` family talks to GitHub for the current repository:

| Keys          | Action |
| ------------- | ------ |
| `space g h p` | pull-request picker — check out a PR's branch (filter like on GitHub, e.g. by author) |
| `space g h n` | create a pull request from the current branch |
| `space g h o` | open the current branch's PR in the browser |
| `space g h i` | issue picker |
| `space g h a` | open the repo's Actions page |
| `space g h f` | failed-CI picker — jump to a failing run's log |
| `space g h l` | open the current line on GitHub (permalink) |
| `space g h L` | open the PR that introduced the current line |
| `space g h r` | open the repository page |

Live CI check status for the current branch is shown in the window, and the
failed-CI picker jumps straight into the failing job's log.
