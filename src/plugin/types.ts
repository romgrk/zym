/*
 * Plugin contracts — the shape a plugin exports and the `PluginContext` it
 * registers contributions through. Modelled on Atom's package model: a plugin is
 * a manifest plus an `activate(ctx)` (and optional `deactivate`), and everything
 * it contributes is recorded as a Disposable so deactivation tears it all down
 * cleanly.
 *
 * Contribution points (grammars, LSP servers, keymaps, commands, config schema,
 * stylesheets) each return a Disposable; the `PluginContext` also tracks them for
 * automatic teardown, so a plugin rarely has to manage disposables itself. New
 * contribution kinds are added here and on `PluginContext` (see PluginContext.ts).
 */
import type { Disposable, DisposableLike } from '../util/eventKit.ts';
import type { Gtk } from '../gi.ts';
import type { TextEditor } from '../ui/TextEditor/index.ts';
import type { LanguageDef, GrammarDef, ServerDef, InjectionRule } from '../lang/types.ts';
import type { ConfigSchema } from '../util/Config.ts';
import type { CommandMap } from '../CommandManager.ts';
import type { KeymapBySelector } from '../KeymapManager.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

/** Static plugin metadata (the manifest), independent of its behavior. */
export interface PluginManifest {
  /** Stable, unique id (e.g. `typescript`); also the keymap/style source key. */
  id: string;
  /** Human-readable name shown in the plugin manager. */
  name: string;
  description?: string;
  version?: string;
  /** Minimum zym version required. Activation is skipped with a warning if unmet. */
  minZymVersion?: string;
}

/** Language-layer contributions (detection + tree-sitter grammar + LSP servers). */
export interface PluginLanguages {
  /** Contribute a language definition (file-type detection). */
  registerLanguage(def: LanguageDef): Disposable;
  /** Bind a tree-sitter grammar to a language id (paths via `ctx.resolve`). */
  registerGrammar(langId: string, def: GrammarDef): Disposable;
  /** Add an LSP server candidate for a language id. */
  registerServer(langId: string, def: ServerDef): Disposable;
  /** Contribute a cross-grammar language injection (e.g. CSS-in-JS into the TS/JS
   *  grammars). The rule names its host grammar(s); the guest grammar must be
   *  registered too (an unknown guest is a harmless no-op). */
  registerInjection(rule: InjectionRule): Disposable;
}

/**
 * The handle a plugin's `activate` receives. Every `register*` both returns a
 * Disposable and records it on the context, so deactivation (which disposes the
 * whole bag) cleans up automatically — a plugin only keeps a Disposable when it
 * wants to undo a contribution itself, mid-run.
 */
export interface PluginContext {
  /** The activating plugin's id. */
  readonly id: string;
  /** The plugin's own directory, for resolving bundled assets. */
  readonly dir: string;
  /** Resolve a path relative to the plugin's directory (grammars, queries, …). */
  resolve(relativePath: string): string;

  /** Language / grammar / LSP-server contributions. */
  readonly languages: PluginLanguages;

  /** Contribute key bindings (same `{ selector: { keystroke: command } }` shape
   *  as the built-in keymap), layered at `priority` (default 0). */
  registerKeymap(keymap: KeymapBySelector, priority?: number): Disposable;
  /** Register commands on a target (a component `#id` selector or a widget). */
  registerCommands(target: string | Widget, commands: CommandMap): Disposable;
  /** Contribute config-schema entries (full dotted key paths). */
  registerConfig(schema: Record<string, ConfigSchema>): Disposable;
  /** Contribute a stylesheet (CSS), removed again on deactivation. */
  registerStyles(css: string): Disposable;

  /** Observe text editors: `callback` runs for every editor already open and each
   *  newly opened one; a Disposable it returns is torn down on editor close or
   *  plugin deactivate. The per-editor decoration seam (color preview, error lens,
   *  …) — Atom's `observeTextEditors`. */
  observeTextEditors(callback: (editor: TextEditor) => DisposableLike | void): Disposable;

  /** Track an arbitrary Disposable for teardown on deactivate (escape hatch). */
  add(disposable: Disposable): void;
}

/** A plugin: its manifest plus lifecycle hooks. */
export interface Plugin extends PluginManifest {
  /** Register contributions; may be async (e.g. to read bundled metadata). */
  activate(ctx: PluginContext): void | Promise<void>;
  /** Optional extra teardown beyond disposing the context's tracked contributions. */
  deactivate?(): void | Promise<void>;
}
