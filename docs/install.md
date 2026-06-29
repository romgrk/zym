# Running & install

## Dev

`pnpm start [file]` runs `node --import node-gtk/register src/index.ts`. The
`--import` flag installs node-gtk's `gi:` import hooks before the entry module's
static `import … from 'gi:…'` resolve — without it the app cannot load any GTK
namespace. node strips the TypeScript types itself (no build step).

## Global command (`zym`)

`package.json` `bin` maps `zym` → `bin/zym.mjs`, so `pnpm i -g` (or `pnpm i -g .`
from a checkout) installs a `zym` command on `PATH`.

`bin/zym.mjs` is a thin launcher with no static `gi:`/`.ts` imports. To boot it
dynamically imports, in order:

1. `bin/ts-strip-hook.mjs` — a `module.registerHooks` load hook that strips
   TypeScript types via `module.stripTypeScriptTypes()`. This is load-bearing for
   the installed command: node's *built-in* type stripping refuses files under
   `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), which is exactly
   where `pnpm i -g` puts zym, so without the hook the launcher could not load its
   own `.ts` source. A userland hook is not subject to that restriction, keeping
   the no-build-step model. (Strip mode blanks types in place, so stack traces stay
   accurate with no source maps. The hook uses experimental node APIs and prints
   one `ExperimentalWarning` to stderr on boot.)
2. `node-gtk/register` — installs the `gi:` hooks (same effect as `--import`).
3. `src/index.ts` — the entry, whose static `gi:` and `.ts` imports now resolve
   under both hooks.

Both must be dynamic imports: a *static* `import 'node-gtk/register'` in the same
file would be hoisted above that ordering (see node-gtk/register's own note). The
launcher passes the optional file argument straight through (`src/index.ts` reads
`process.argv[2]`).

Subcommands, handled before any GTK is loaded:

- `zym [file]` — open the editor, optionally on a file
- `zym --install-desktop` — install the desktop launcher (below)
- `zym --version`, `zym --help`

## Packaging & lifecycle

What must ship for the installed command to run: `bin/`, `scripts/`, `src/`
(including the committed `src/icons.generated.ts`), `assets/`, `plugins/`,
`package.json`. `.npmignore` keeps dev-only material (`docs/`, tests,
`src/poc/`, `scripts/peek-demo.ts`, lint/ts config) out.

- `scripts/` **must** ship: nothing dev-only depends on it at install time, but
  `scripts/install-desktop.ts` backs `zym --install-desktop`, and keeping it in
  avoids surprises.
- Dev-only generation (`generate-types`, `generate-icons`) runs in `prepare`, not
  `postinstall`. `prepare` runs on a source/dev install and before `pnpm pack`, but
  **never** when zym is installed as a dependency — so a consumer install does not
  try to regenerate node-gtk typings (dev-only, and failure-prone), and relies on
  the committed `src/icons.generated.ts` that ships in the tarball.
- Runtime tree-sitter deps live in `dependencies`, not `devDependencies`:
  `web-tree-sitter` (required by `src/syntax/grammar.ts`) and `tree-sitter-wasms`
  (bundled plugins load `tree-sitter-wasms/out/*.wasm`, resolved against zym's
  `node_modules` — see `src/lang/types.ts`). Genuinely dev-only entries
  (`typescript`, `typescript-language-server`, `eslint`, …) stay in
  `devDependencies`: they appear in source only as language ids or LSP spawn-command
  names, never as package imports; LSP servers are provisioned separately.

## Consumer requirements

- **node** new enough for type stripping + `module.registerHooks` /
  `module.stripTypeScriptTypes` (node 22.15+ / 23.5+).
- **node-gtk's native build.** node-gtk (`^3.0.0`, for the `gi:`/`register`
  features) installs its binding via `node-pre-gyp` (prebuilt from S3, else a local
  build). pnpm gates dependency build scripts by default, so a `pnpm i -g` user must
  approve it: `pnpm approve-builds` (or `pnpm approve-builds -g` for a global
  install). A package cannot pre-approve this — pnpm ignores any `pnpm` field in a
  dependency's `package.json` (a security boundary). npm runs the build with no
  approval step.
- **System libraries** at runtime: GTK 4, libadwaita, GtkSourceView 5, Vte, and the
  GObject-introspection typelibs node-gtk loads namespaces from.

## Desktop entry

`zym --install-desktop` (after a global install) or `pnpm run install-desktop`
(from a checkout) writes `$XDG_DATA_HOME/applications/com.github.romgrk.zym.desktop`
and refreshes the MIME cache. Both run `scripts/install-desktop.ts` —
`installDesktopEntry()`; running the file directly installs pointing at this
checkout's launcher, while `zym --install-desktop` imports it and points at the
installed launcher.

Decisions:

- The file is named after the GTK application id (`com.github.romgrk.zym`, kept in
  sync with `APP_ID` in `src/application.ts`), and sets `StartupWMClass` to it, so
  GNOME associates the running window with the entry.
- `Exec` bakes an absolute, `realpath`-resolved node path plus the absolute
  launcher path rather than relying on `zym` being on `PATH`. A GUI launch does not
  inherit an interactive shell's `PATH`, and a version manager such as fnm exposes
  node only through an ephemeral per-shell symlink (`/run/user/.../fnm_multishells/…`)
  — resolving through it to the versioned install gives a path that survives later
  launches.
- `Icon=com.github.romgrk.zym`; no branded icon ships yet, so desktops fall back to
  a generic icon until one named after the app id is installed into an icon theme.
