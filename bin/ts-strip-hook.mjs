/*
 * ts-strip-hook — strip TypeScript types at load time, including under node_modules.
 *
 * The project runs its `.ts` source directly: in dev `node` strips types itself.
 * But node's *built-in* type stripping refuses files under `node_modules`
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — which is exactly where
 * `pnpm i -g` installs zym, so the global `zym` could not load its own source.
 *
 * A userland load hook that calls `module.stripTypeScriptTypes()` explicitly is
 * not subject to that restriction, so it makes the installed command work while
 * keeping the no-build-step model. Strip mode replaces type syntax with
 * whitespace, preserving line/column positions, so stack traces stay accurate
 * without source maps. Imported for side effect by bin/zym.mjs before any `.ts`
 * is loaded. See docs/install.md.
 */
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  load(url, context, nextLoad) {
    // Only intercept on-disk `.ts`/`.mts`; let everything else (JS, wasm, and
    // node-gtk's `gi:` scheme) fall through to the next loader untouched.
    if (url.startsWith('file:') && /\.m?ts$/.test(new URL(url).pathname)) {
      const source = readFileSync(fileURLToPath(url), 'utf8');
      return {
        format: 'module',
        source: stripTypeScriptTypes(source),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
