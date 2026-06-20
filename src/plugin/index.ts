/*
 * The plugin layer's public surface: the application-wide `plugins` registry,
 * `registerBuiltinPlugins` (bundled plugins), and `loadUserPlugins` (out-of-repo
 * discovery). Built-ins live under `plugins/<id>/` (repo root). User plugins are
 * scanned from `$XDG_DATA_HOME/quilx/plugins/`, each a directory with a
 * `package.json` + `main` entry that exports a `Plugin`.
 *
 * Lifecycle (see `src/index.ts`):
 *   registerBuiltinPlugins() → await loadUserPlugins() → await plugins.activateAll()
 * All three run BEFORE grammars are preloaded.
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PluginRegistry } from './PluginRegistry.ts';
import { quilx } from '../quilx.ts';
import { typescriptPlugin } from '../../plugins/typescript/index.ts';
import { markdownPlugin } from '../../plugins/markdown/index.ts';
import { htmlPlugin } from '../../plugins/html/index.ts';
import { cssPlugin } from '../../plugins/css/index.ts';
import { jsonPlugin } from '../../plugins/json/index.ts';
import { rustPlugin } from '../../plugins/rust/index.ts';
import { cppPlugin } from '../../plugins/cpp/index.ts';
import { pythonPlugin } from '../../plugins/python/index.ts';
import { colorPreviewPlugin } from '../../plugins/color-preview/index.ts';
import type { Plugin } from './types.ts';

export { PluginRegistry } from './PluginRegistry.ts';
export type { PluginInfo } from './PluginRegistry.ts';
export type { Plugin, PluginManifest, PluginContext } from './types.ts';

/** The current quilx version — checked against a plugin's `minQuilxVersion`. */
export const QUILX_VERSION = '0.1.0';

/** The application-wide plugin registry. */
export const plugins = new PluginRegistry();

/** Directory holding the bundled plugins (`plugins/` at repo root). */
const BUILTINS_DIR = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), '../../plugins');

/** Register the plugins quilx ships with (inactive until `plugins.activateAll`). */
export function registerBuiltinPlugins(): void {
  plugins.register(typescriptPlugin, Path.join(BUILTINS_DIR, 'typescript'));
  plugins.register(markdownPlugin, Path.join(BUILTINS_DIR, 'markdown'));
  plugins.register(htmlPlugin, Path.join(BUILTINS_DIR, 'html'));
  plugins.register(cssPlugin, Path.join(BUILTINS_DIR, 'css'));
  plugins.register(jsonPlugin, Path.join(BUILTINS_DIR, 'json'));
  plugins.register(rustPlugin, Path.join(BUILTINS_DIR, 'rust'));
  plugins.register(cppPlugin, Path.join(BUILTINS_DIR, 'cpp'));
  plugins.register(pythonPlugin, Path.join(BUILTINS_DIR, 'python'));
  plugins.register(colorPreviewPlugin, Path.join(BUILTINS_DIR, 'color-preview'));
}

/** `$XDG_DATA_HOME/quilx/plugins` — the directory scanned for user plugins. */
function userPluginsDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || Path.join(Os.homedir(), '.local', 'share');
  return Path.join(dataHome, 'quilx', 'plugins');
}

/**
 * Scan the user plugins directory and register any valid plugins found.
 * Each entry must be a directory containing a `package.json` with a `main`
 * field pointing to an ES module that exports a `Plugin` as its default or
 * named export matching `<id>Plugin`.
 *
 * Errors are logged per-plugin and never thrown — a bad user plugin never
 * blocks startup.
 */
export async function loadUserPlugins(): Promise<void> {
  const dir = userPluginsDir();
  let entries: string[];
  try {
    entries = Fs.readdirSync(dir);
  } catch {
    return; // directory doesn't exist yet — nothing to load
  }

  for (const entry of entries) {
    const pluginDir = Path.join(dir, entry);
    try {
      const stat = Fs.statSync(pluginDir);
      if (!stat.isDirectory()) continue;

      const manifestPath = Path.join(pluginDir, 'package.json');
      if (!Fs.existsSync(manifestPath)) {
        console.warn(`[plugin] user plugin "${entry}": no package.json, skipping`);
        continue;
      }

      const manifest = JSON.parse(Fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      const mainRel = (manifest.main as string | undefined) ?? 'index.js';
      const mainPath = Path.join(pluginDir, mainRel);

      if (!Fs.existsSync(mainPath)) {
        console.warn(`[plugin] user plugin "${entry}": main "${mainRel}" not found, skipping`);
        continue;
      }

      const mod = await import(pathToFileURL(mainPath).href) as Record<string, unknown>;

      // Accept a default export or the first export whose value looks like a Plugin.
      const plugin = findPluginExport(mod);
      if (!plugin) {
        console.warn(`[plugin] user plugin "${entry}": no Plugin export found, skipping`);
        continue;
      }

      plugins.register(plugin, pluginDir, 'user');
    } catch (err) {
      console.warn(`[plugin] user plugin "${entry}" failed to load: ${(err as Error).message}`);
    }
  }
}

/** Return the first value in `mod` that looks like a Plugin (has id + activate). */
function findPluginExport(mod: Record<string, unknown>): Plugin | null {
  for (const value of Object.values(mod)) {
    if (isPlugin(value)) return value;
  }
  return null;
}

function isPlugin(value: unknown): value is Plugin {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Plugin).id === 'string' &&
    typeof (value as Plugin).name === 'string' &&
    typeof (value as Plugin).activate === 'function'
  );
}

/**
 * Return the set of plugin IDs currently disabled via config. Used by callers
 * that want to skip disabled plugins before calling `plugins.activateAll`.
 */
export function disabledPluginIds(): Set<string> {
  const list = quilx.config.get('plugins.disabled');
  if (!Array.isArray(list)) return new Set();
  return new Set(list.filter((v): v is string => typeof v === 'string'));
}
