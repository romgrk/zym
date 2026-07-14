---
name: verify
description: Drive the live zym app headlessly (Xvfb + node inspector) to verify a change end-to-end — launch, dispatch real keybindings, read editor state, screenshot.
---

# Verifying zym changes in the live app

zym is a GTK4 app; its surface is pixels + keyboard. Drive it headlessly:

## Launch

```bash
Xvfb :99 -screen 0 1600x1000x24 & sleep 1
mkdir -p /tmp/zym-verify/xdg/{config,state,cache}   # isolate XDG so the user's config/sessions stay untouched
cd <project-to-open>       # the app roots its workbench at the LAUNCH CWD, not the file argument's dir
DISPLAY=:99 GDK_BACKEND=x11 \
  XDG_CONFIG_HOME=/tmp/zym-verify/xdg/config XDG_STATE_HOME=/tmp/zym-verify/xdg/state \
  XDG_CACHE_HOME=/tmp/zym-verify/xdg/cache NODE_ENV=development \
  node --inspect=9333 --import <repo>/bin/register-gtk.mjs <repo>/src/index.ts ./some/file.ts &
sleep 8    # plugins + grammars preload before the window shows
```

## Drive via CDP

`cdp.mjs` (next to this file) is a dependency-free inspector client:
`node cdp.mjs 9333 '<expression>'` evaluates in the app and prints the result JSON.
The app exposes `globalThis.zym` (see `src/zym.ts`).

- **Keys — the real dispatch path**: `zym.keymaps.onWindowKeyPressEvent(keyval, 0, 0)` (what the
  tests use). Send a whole sequence in ONE evaluate — split across calls, the keymap's
  partial-match timer can fire between them: `[32,103,100,100].map(k => zym.keymaps.onWindowKeyPressEvent(k,0,0))`
  is `space g d d`. Keyvals for printable ASCII are the char codes; Escape is 65307. Send an
  Escape first to clear pending key state.
- **Read editor state**: `zym.window.getFocus()` is the focused widget (an editor's
  `EditorSourceView` → `.getBuffer()` for line counts / text / cursor iter).
- **Trace command routing**: monkey-patch `zym.commands.dispatchAlongChain` to log command names.
- Evaluates occasionally fail with `Promise was collected` — transient; retry.

## Screenshot

`DISPLAY=:99 import -window root /tmp/shot.png` (imagemagick), then Read the png.

## Gotchas

- The workbench cwd is the process CWD at launch; passing `/path/file.ts` as the argument does
  NOT re-root it.
- Async flows (git blob reads, reconcile after an external file change) need a `sleep 2-5` before
  asserting.
- Startup log noise that is NOT a finding: libEGL DRI3 warning (Xvfb), two `[node-gtk:styles]`
  CSS parse errors, keymap ambiguity warnings.
