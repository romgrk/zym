# Troubleshooting

## Install

**`npm warn allow-scripts … not yet covered by allowScripts`, then `zym` fails
to start.** npm skipped the native modules' install steps. Recent zym versions
pre-approve them in the package manifest; if your npm doesn't honor that,
re-run with the scripts approved explicitly:

```sh
npm install -g zym-editor --allow-scripts=native-keymap,node-gtk
```

With pnpm the equivalent gate is `pnpm approve-builds -g` after
`pnpm add -g zym-editor` (pnpm ignores manifest self-approval by design).

**`Could not load namespace …` (Gtk, Adw, GtkSource, Vte) on launch.** A
system library or its GObject-Introspection typelib is missing. Install the
packages listed in [Getting started](getting-started.md#install) — on
Debian/Ubuntu the typelibs are separate `gir1.2-*` packages.

**node-gtk compiles from source (or fails to).** When no prebuilt binary
matches your Node version/platform, node-gtk falls back to a local build,
which needs a C++ toolchain and the development headers
(Debian/Ubuntu: `build-essential libgirepository1.0-dev libcairo2-dev`;
Arch: `base-devel gobject-introspection cairo`; Fedora:
`gcc-c++ gobject-introspection-devel cairo-devel`). Using a current LTS Node
usually avoids the build entirely.

**`SyntaxError` / type-stripping errors on start.** Your Node is too old — zym
runs its TypeScript source directly and needs Node ≥ 22.15. `node --version`
to check.

**An `ExperimentalWarning: stripTypeScriptTypes` line prints on boot.** This
is expected — zym uses Node's type stripping, which Node still labels
experimental. It is harmless.

## Runtime

**zym doesn't appear in the app launcher.** Run `zym --install-desktop` once —
it writes the `.desktop` entry and icons for your user.

**Fonts or colors look wrong.** zym follows the system fonts and the system
light/dark preference (`core.followSystemColorScheme`). Editor font and size
are `editor.fontFamily` / `editor.fontSize` in the preferences (`space , ,`).

**A language server isn't starting.** zym offers to install missing servers
when it recognizes the language; installed servers live under
`~/.cache/zym/`. The diagnostics panel (`space l l`) and the notification log
(`space n`) surface LSP errors.

**Something else broke.** The notification log (`space n`) keeps every
notification of the session, including error details. Please report issues at
<https://github.com/romgrk/zym/issues> — include the log output of running
`zym` from a terminal if the problem is at startup.
