/*
 * PluginRegistry — owns the set of known plugins and their activation state.
 *
 * A plugin is `register`ed (with its base directory, for asset resolution) and
 * later `activate`d: the registry builds a `PluginContextImpl`, runs the plugin's
 * `activate(ctx)`, and remembers the context. `deactivate` runs the plugin's own
 * teardown then disposes every contribution the context tracked. Activation is
 * idempotent and never throws — a plugin that fails to activate is logged and
 * left inactive, so one bad plugin can't block startup (same philosophy as the
 * keymap/config loaders).
 */
import { PluginContextImpl } from './PluginContext.ts';
import type { Plugin, PluginManifest } from './types.ts';

interface PluginEntry {
  plugin: Plugin;
  /** The plugin's base directory (asset resolution root). */
  dir: string;
  /** The live context while active; null when inactive. */
  context: PluginContextImpl | null;
  /** Set if activation failed. */
  error: string | null;
  /** 'builtin' = shipped with quilx, 'user' = loaded from the user plugins dir. */
  source: 'builtin' | 'user';
}

/** A plugin's manifest plus whether it is currently active (for a manager UI). */
export interface PluginInfo extends PluginManifest {
  active: boolean;
  /** If activation failed, the error message. */
  error: string | null;
  /** Whether the plugin is in the disabled list. */
  disabled: boolean;
  /** 'builtin' = shipped with quilx, 'user' = loaded from the user plugins dir. */
  source: 'builtin' | 'user';
  /** The plugin's base directory (for reading assets like package.json). */
  dir: string;
}

export class PluginRegistry {
  private readonly entries = new Map<string, PluginEntry>();

  /** Register a plugin (inactive). `dir` is its directory for `ctx.resolve`. */
  register(plugin: Plugin, dir: string, source: 'builtin' | 'user' = 'builtin'): void {
    if (this.entries.has(plugin.id)) {
      throw new Error(`plugin "${plugin.id}" is already registered`);
    }
    this.entries.set(plugin.id, { plugin, dir, context: null, error: null, source });
  }

  /** Manifest + active state for every registered plugin (registration order).
   *  Pass the `disabled` set (from config) to populate the `disabled` field. */
  list(disabled: ReadonlySet<string> = new Set()): PluginInfo[] {
    return [...this.entries.values()].map(({ plugin, context, error, source, dir }) => ({
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      version: plugin.version,
      minQuilxVersion: plugin.minQuilxVersion,
      active: context !== null,
      error,
      disabled: disabled.has(plugin.id),
      source,
      dir,
    }));
  }

  isActive(id: string): boolean {
    return this.entries.get(id)?.context != null;
  }

  /** Activate one plugin (no-op if unknown or already active). */
  async activate(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.context) return;
    const { minQuilxVersion } = entry.plugin;
    if (minQuilxVersion) {
      const QUILX_VERSION = '0.1.0'; // TODO: import from version constant
      if (!PluginRegistry.versionSatisfies(QUILX_VERSION, minQuilxVersion)) {
        entry.error = `requires quilx >= ${minQuilxVersion}, got ${QUILX_VERSION}`;
        console.warn(`[plugin] "${id}" skipped: ${entry.error}`);
        return;
      }
    }
    const context = new PluginContextImpl(entry.plugin.id, entry.dir);
    try {
      await entry.plugin.activate(context);
      entry.context = context;
      entry.error = null;
    } catch (error) {
      // Roll back anything that registered before the failure.
      context.dispose();
      entry.error = (error as Error).message ?? String(error);
      console.warn(`[plugin] "${id}" failed to activate: ${entry.error}`);
    }
  }

  /** Returns true if `actual` satisfies `>=required` (major.minor.patch prefix). */
  private static versionSatisfies(actual: string, required: string): boolean {
    const parse = (v: string) => v.replace(/^[^0-9]*/, '').split('.').map(Number);
    const [aMaj = 0, aMin = 0, aPat = 0] = parse(actual);
    const [rMaj = 0, rMin = 0, rPat = 0] = parse(required);
    if (aMaj !== rMaj) return aMaj > rMaj;
    if (aMin !== aMin) return aMin > rMin;
    return aPat >= rPat;
  }

  /** Deactivate one plugin (no-op if unknown or inactive). */
  async deactivate(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || !entry.context) return;
    try {
      await entry.plugin.deactivate?.();
    } catch (error) {
      console.warn(`[plugin] "${id}" deactivate hook threw: ${(error as Error).message}`);
    }
    entry.context.dispose();
    entry.context = null;
  }

  /** Activate every registered plugin (startup), skipping IDs in `disabled`. */
  async activateAll(disabled: ReadonlySet<string> = new Set()): Promise<void> {
    for (const id of this.entries.keys()) {
      if (disabled.has(id)) {
        console.log(`[plugin] "${id}" is disabled — skipping`);
        continue;
      }
      await this.activate(id);
    }
  }

  /** Deactivate every active plugin (shutdown). */
  async deactivateAll(): Promise<void> {
    for (const id of this.entries.keys()) await this.deactivate(id);
  }
}
