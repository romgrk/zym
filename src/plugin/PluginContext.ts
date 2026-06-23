/*
 * PluginContextImpl — the concrete `PluginContext` handed to a plugin's
 * `activate`. It wraps the application singletons (the `languages` registry,
 * `zym.keymaps` / `zym.commands` / `zym.config`, the style manager) and
 * records every contribution as a Disposable in a bag the `PluginRegistry`
 * disposes on deactivation.
 *
 * Assets (grammar wasm, highlight queries) are resolved against the plugin's own
 * directory via `resolve`, so a plugin is self-contained and relocatable.
 */
import * as Path from 'node:path';
import { Disposable, CompositeDisposable, type DisposableLike } from '../util/eventKit.ts';
import type { TextEditor } from '../ui/TextEditor/index.ts';
import { languages } from '../lang/index.ts';
import { clearGrammar, refreshGrammarInjections } from '../syntax/grammar.ts';
import { zym } from '../zym.ts';
import { styles } from '../styles.ts';
import type { Gtk } from '../gi.ts';
import type { LanguageDef, GrammarDef, ServerDef, InjectionRule } from '../lang/types.ts';
import type { ConfigSchema } from '../util/Config.ts';
import type { CommandMap } from '../CommandManager.ts';
import type { KeymapBySelector } from '../KeymapManager.ts';
import type { PluginContext, PluginLanguages } from './types.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

export class PluginContextImpl implements PluginContext {
  readonly id: string;
  readonly dir: string;
  /** Everything this plugin contributed, disposed (in reverse) on deactivate. */
  private readonly disposables = new CompositeDisposable();

  readonly languages: PluginLanguages;

  constructor(id: string, dir: string) {
    this.id = id;
    this.dir = dir;
    this.languages = this.makeLanguages();
  }

  resolve(relativePath: string): string {
    return Path.resolve(this.dir, relativePath);
  }

  add(disposable: Disposable): void {
    this.disposables.add(disposable);
  }

  /** Track and return a Disposable (helper for the register* methods). */
  private track(disposable: Disposable): Disposable {
    this.disposables.add(disposable);
    return disposable;
  }

  private makeLanguages(): PluginLanguages {
    return {
      registerLanguage: (def: LanguageDef) => this.track(languages.registerLanguage(def)),
      registerServer: (langId: string, def: ServerDef) =>
        this.track(languages.registerServer(langId, def)),
      registerGrammar: (langId: string, def: GrammarDef) => {
        const inner = languages.registerGrammar(langId, def);
        // Removing the def also invalidates the loaded-grammar cache so a later
        // re-registration isn't shadowed by a stale parse.
        return this.track(new Disposable(() => {
          inner.dispose();
          clearGrammar(langId);
        }));
      },
      registerInjection: (rule: InjectionRule) => {
        const inner = languages.registerInjection(rule);
        // Re-attach to loaded grammars now (handles registration after preload) and
        // again on removal. A no-op during normal activation (grammars load after).
        refreshGrammarInjections();
        return this.track(new Disposable(() => {
          inner.dispose();
          refreshGrammarInjections();
        }));
      },
    };
  }

  registerKeymap(keymap: KeymapBySelector, priority = 0): Disposable {
    return this.track(zym.keymaps.add(`plugin:${this.id}`, keymap, priority));
  }

  registerCommands(target: string | Widget, commands: CommandMap): Disposable {
    return this.track(zym.commands.add(target, commands));
  }

  registerConfig(schema: Record<string, ConfigSchema>): Disposable {
    zym.config.addSchema(schema);
    return this.track(new Disposable(() => {
      for (const key of Object.keys(schema)) zym.config.removeSchema(key);
    }));
  }

  registerStyles(css: string): Disposable {
    return this.track(styles.addRemovable(css));
  }

  observeTextEditors(callback: (editor: TextEditor) => DisposableLike | void): Disposable {
    return this.track(zym.workspace.observeTextEditors(callback));
  }

  /** Dispose every tracked contribution (called by the registry on deactivate). */
  dispose(): void {
    this.disposables.dispose();
  }
}
