/*
 * LSP file-watcher glob matching. Servers register watchers with glob patterns
 * (`**​/*.ts`, `**​/tsconfig.json`, …) via `client/registerCapability`; we match
 * changed paths against them before notifying `workspace/didChangeWatchedFiles`.
 *
 * The glob → regex compiler is the shared one in `src/util/glob.ts`; this module
 * is just the LSP-specific anchoring (a relative pattern, or one rooted at a
 * watcher base).
 */
import { escapeLiteral, globBody, globToRegExp } from '../util/glob.ts';

/** Compile an LSP glob to an anchored RegExp matching a (relative) path. */
export function lspGlobToRegExp(glob: string): RegExp {
  return globToRegExp(glob);
}

/**
 * A RegExp matching absolute paths for a watcher registered with `pattern`
 * relative to `base` (the workspace or a RelativePattern base). `base` is treated
 * literally; `pattern` is a glob.
 */
export function watcherRegExp(base: string, pattern: string): RegExp {
  const baseNorm = base.replace(/\\/g, '/').replace(/\/+$/, '');
  return new RegExp(`^${escapeLiteral(baseNorm)}/${globBody(pattern.replace(/\\/g, '/'))}$`);
}
