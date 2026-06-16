/*
 * The plugin layer's public surface: the application-wide `plugins` registry and
 * `registerBuiltinPlugins`, which registers the plugins quilx bundles (today just
 * TypeScript). Built-ins live under `src/plugins/<id>/` and are registered with
 * that directory so a plugin resolves its own assets (`ctx.resolve`).
 *
 * Lifecycle (see `src/index.ts`): register the built-ins, then `activateAll()`
 * BEFORE grammars are preloaded — activation is what populates the `languages`
 * registry the grammar/LSP layers read. Later, third-party plugins (out-of-repo)
 * will be discovered and registered here too.
 */
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginRegistry } from './PluginRegistry.ts';
import { typescriptPlugin } from '../plugins/typescript/index.ts';
import { markdownPlugin } from '../plugins/markdown/index.ts';
import { htmlPlugin } from '../plugins/html/index.ts';
import { cssPlugin } from '../plugins/css/index.ts';
import { jsonPlugin } from '../plugins/json/index.ts';
import { rustPlugin } from '../plugins/rust/index.ts';
import { cppPlugin } from '../plugins/cpp/index.ts';
import { colorPreviewPlugin } from '../plugins/color-preview/index.ts';

export { PluginRegistry } from './PluginRegistry.ts';
export type { PluginInfo } from './PluginRegistry.ts';
export type { Plugin, PluginManifest, PluginContext } from './types.ts';

/** The application-wide plugin registry. */
export const plugins = new PluginRegistry();

/** Directory holding the bundled plugins (`src/plugins`). */
const BUILTINS_DIR = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), '../plugins');

/** Register the plugins quilx ships with (inactive until `plugins.activateAll`). */
export function registerBuiltinPlugins(): void {
  plugins.register(typescriptPlugin, Path.join(BUILTINS_DIR, 'typescript'));
  plugins.register(markdownPlugin, Path.join(BUILTINS_DIR, 'markdown'));
  plugins.register(htmlPlugin, Path.join(BUILTINS_DIR, 'html'));
  plugins.register(cssPlugin, Path.join(BUILTINS_DIR, 'css'));
  plugins.register(jsonPlugin, Path.join(BUILTINS_DIR, 'json'));
  plugins.register(rustPlugin, Path.join(BUILTINS_DIR, 'rust'));
  plugins.register(cppPlugin, Path.join(BUILTINS_DIR, 'cpp'));
  plugins.register(colorPreviewPlugin, Path.join(BUILTINS_DIR, 'color-preview'));
}
