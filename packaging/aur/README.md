# AUR packaging (`zym-git`)

Packaging for <https://aur.archlinux.org/packages/zym-git> — a VCS package
that builds zym from the latest `origin/master` on GitHub, compiling the
node-gtk addon from source against the system GTK (prebuilts don't track
Arch's rolling Node ABI).

| File | Role |
| ---- | ---- |
| `PKGBUILD`       | the canonical package recipe (this exact file is published) |
| `zym.install`    | pacman hooks — icon cache / desktop database refresh |
| `common.sh`      | shared helpers; the pkgver formula lives here for the scripts |
| `build-local.sh` | build a package from the current **working tree** (test rig) |
| `publish-aur.sh` | sync PKGBUILD + .SRCINFO into the AUR repo and push |

## Test locally

```sh
./build-local.sh       # build only; prints the .pkg.tar.zst path
./build-local.sh -i    # build + sudo pacman -U
```

Builds from your working tree (uncommitted changes included; the pkgver gets a
`.dirty` suffix) in `~/.cache/zym-aur-build`, reusing the canonical PKGBUILD's
`build()`/`package()` verbatim so the test can't drift from what ships.

## Publish

```sh
./publish-aur.sh                 # dry run: clone/sync/commit, no push
AUR_PUSH=1 ./publish-aur.sh      # the real thing
```

Prerequisites: an AUR account with your SSH key, and this repo's master pushed
to GitHub (the AUR builds from `origin/master`, not your local tree). The
script warns when the packaging files differ from `origin/master`.

Because `zym-git` is a VCS package, the AUR listing's version only changes when
we push a new `.SRCINFO` — users' AUR helpers rebuild from git master anyway,
but re-run `publish-aur.sh` after notable releases so the listed version stays
roughly current.
