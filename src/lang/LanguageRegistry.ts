/*
 * LanguageRegistry — the single source of truth tying files to languages, and
 * languages to their grammar + LSP servers. The plugin seam: the built-in pack
 * and (later) external plugins contribute through `register*`; the editor's
 * syntax layer and `LspManager` consume `grammarFor` / `activeServers`.
 *
 * Server selection is per-file/per-project: a language has several candidate
 * servers, each gated by root markers (activation) and optionally grouped for
 * mutual exclusion (flow vs tsserver vs deno), with additive ungrouped linters.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { Disposable } from '../util/eventKit.ts';
import type {
  LanguageDef, GrammarDef, ServerDef, ActiveServer, ServerOverride, ServerOverrides,
  InjectionRule, CommentSpec,
} from './types.ts';

export interface ActiveServerOptions {
  /** Existence check (injectable for tests); defaults to `Fs.existsSync`. */
  fileExists?: (path: string) => boolean;
}

export class LanguageRegistry {
  private readonly languages = new Map<string, LanguageDef>();
  private readonly grammars = new Map<string, GrammarDef>();
  private readonly serversByLang = new Map<string, ServerDef[]>();
  // Cross-grammar injection rules contributed by plugins (the user's own come from
  // config). Compiled per host grammar by `src/syntax/grammar.ts`.
  private readonly injections: InjectionRule[] = [];
  // User config (from `lsp.*`): languages to suppress, and per-server tweaks.
  private disabledLanguages = new Set<string>();
  private serverOverrides: ServerOverrides = {};

  /**
   * Register a language definition (detection). Returns a Disposable that
   * removes it again (used by plugin deactivation); removal is a no-op if the
   * entry was meanwhile replaced by a later registration of the same id.
   */
  registerLanguage(def: LanguageDef): Disposable {
    this.languages.set(def.id, def);
    return new Disposable(() => {
      if (this.languages.get(def.id) === def) this.languages.delete(def.id);
    });
  }

  registerGrammar(langId: string, def: GrammarDef): Disposable {
    this.grammars.set(langId, def);
    return new Disposable(() => {
      if (this.grammars.get(langId) === def) this.grammars.delete(langId);
    });
  }

  /**
   * Contribute a cross-grammar injection rule (a plugin injecting into host grammars
   * it names in `rule.hosts` — e.g. CSS-in-JS into the TS/JS grammars). Returns a
   * Disposable that removes it again (plugin deactivation). The syntax layer
   * (`grammar.ts`) reads these via `injectionRules` and compiles them per host.
   */
  registerInjection(rule: InjectionRule): Disposable {
    this.injections.push(rule);
    return new Disposable(() => {
      const i = this.injections.indexOf(rule);
      if (i !== -1) this.injections.splice(i, 1);
    });
  }

  /** Every plugin-contributed injection rule (the user's come from config separately). */
  injectionRules(): InjectionRule[] {
    return this.injections;
  }

  registerServer(langId: string, def: ServerDef): Disposable {
    const list = this.serversByLang.get(langId);
    if (list) list.push(def);
    else this.serversByLang.set(langId, [def]);
    return new Disposable(() => {
      const current = this.serversByLang.get(langId);
      if (!current) return;
      const i = current.indexOf(def);
      if (i !== -1) current.splice(i, 1);
      if (current.length === 0) this.serversByLang.delete(langId);
    });
  }

  /** The language definition matching a file path (by filename, extension, glob). */
  private matchLanguage(filePath: string): LanguageDef | null {
    const base = Path.basename(filePath);
    const ext = Path.extname(base).slice(1).toLowerCase();
    for (const lang of this.languages.values()) {
      if (lang.filenames?.includes(base)) return lang;
      if (ext !== '' && lang.fileTypes?.some((t) => t.toLowerCase() === ext)) return lang;
      if (lang.globs?.some((g) => globToRegExp(g).test(base))) return lang;
    }
    return null;
  }

  /** The language id for a file path, or null if unrecognized. */
  languageForPath(filePath: string): string | null {
    return this.matchLanguage(filePath)?.id ?? null;
  }

  /**
   * The LSP document `languageId` for a file (per the protocol), or null. Differs
   * from `languageForPath` when one grammar language spans several LSP ids — e.g.
   * the `tsx` grammar → `javascript` / `javascriptreact` / `typescriptreact`.
   */
  lspLanguageId(filePath: string): string | null {
    const lang = this.matchLanguage(filePath);
    if (!lang) return null;
    const ext = Path.extname(Path.basename(filePath)).slice(1).toLowerCase();
    return lang.lspIds?.[ext] ?? lang.lspId ?? lang.id;
  }

  /** The comment delimiters for a language, or null when it declares none (JSON). */
  commentsFor(langId: string): CommentSpec | null {
    return this.languages.get(langId)?.comments ?? null;
  }

  grammarFor(langId: string): GrammarDef | null {
    return this.grammars.get(langId) ?? null;
  }

  /** Language ids that have a registered grammar (for preloading). */
  grammarLanguageIds(): string[] {
    return [...this.grammars.keys()];
  }

  /** All server candidates registered for a language (built-ins, no overrides). */
  serversFor(langId: string): ServerDef[] {
    return this.serversByLang.get(langId) ?? [];
  }

  /** Registered servers that declare an install method, de-duplicated by name. */
  installableServers(): ServerDef[] {
    const byName = new Map<string, ServerDef>();
    for (const list of this.serversByLang.values()) {
      for (const server of list) {
        if (server.install && !byName.has(server.name)) byName.set(server.name, server);
      }
    }
    return [...byName.values()];
  }

  /**
   * Apply user config: language ids to suppress entirely, and per-server
   * overrides (by language id → server name). Replaces any previous overrides;
   * pass empty/undefined to clear. Affects server resolution only — detection
   * and grammars are untouched (highlighting still works for disabled languages).
   */
  setOverrides(config: { disabledLanguages?: string[]; servers?: ServerOverrides }): void {
    this.disabledLanguages = new Set(config.disabledLanguages ?? []);
    this.serverOverrides = config.servers ?? {};
  }

  /**
   * The candidate servers for a language with user overrides applied: built-ins
   * minus disabled ones (each tweaked by its override), plus any user-added
   * servers. Empty when the language itself is disabled.
   */
  effectiveServers(langId: string): ServerDef[] {
    if (this.disabledLanguages.has(langId)) return [];
    const langOverrides = this.serverOverrides[langId] ?? {};
    const base = this.serversFor(langId);
    const result: ServerDef[] = [];
    for (const def of base) {
      const ov = langOverrides[def.name];
      if (ov?.disable) continue;
      result.push(ov ? applyOverride(def, ov) : def);
    }
    // Names not matching a built-in are user-added servers (need a command).
    for (const [name, ov] of Object.entries(langOverrides)) {
      if (ov.disable || ov.command === undefined || base.some((d) => d.name === name)) continue;
      result.push(applyOverride({ name, command: ov.command }, ov));
    }
    return result;
  }

  /**
   * The servers that should run for `filePath`, resolved against its project:
   * each candidate activates only when a root marker is found (or it is
   * single-file), then within each exclusion group only the highest-priority
   * activated server is kept; ungrouped servers all stay.
   */
  activeServers(filePath: string, opts: ActiveServerOptions = {}): ActiveServer[] {
    const fileExists = opts.fileExists ?? ((p: string) => Fs.existsSync(p));
    const langId = this.languageForPath(filePath);
    if (!langId) return [];

    const fileDir = Path.dirname(Path.resolve(filePath));
    const ungrouped: ActiveServer[] = [];
    const grouped = new Map<string, ActiveServer>();

    for (const server of this.effectiveServers(langId)) {
      const roots = server.roots ?? [];
      let rootDir = roots.length ? findRoot(fileDir, roots, fileExists) : null;
      if (rootDir === null) {
        if (!server.singleFile) continue; // needs a root and none was found
        rootDir = fileDir;
      }
      const active: ActiveServer = { server, rootDir };
      if (!server.group) {
        ungrouped.push(active);
        continue;
      }
      const current = grouped.get(server.group);
      if (!current || (server.priority ?? 0) > (current.server.priority ?? 0)) {
        grouped.set(server.group, active);
      }
    }
    return [...ungrouped, ...grouped.values()];
  }
}

/**
 * Merge a user override onto a server def. Each set field replaces the built-in's
 * (args/roots/settings replace wholesale — they aren't deep-merged). `false`/`0`/
 * `''` count as set (so e.g. `priority: 0` or `group: ''` take effect).
 */
function applyOverride(def: ServerDef, ov: ServerOverride): ServerDef {
  return {
    ...def,
    command: ov.command ?? def.command,
    args: ov.args ?? def.args,
    initializationOptions: ov.initializationOptions ?? def.initializationOptions,
    settings: ov.settings ?? def.settings,
    roots: ov.roots ?? def.roots,
    singleFile: ov.singleFile ?? def.singleFile,
    group: ov.group ?? def.group,
    priority: ov.priority ?? def.priority,
  };
}

/** Nearest ancestor of `dir` (inclusive) containing one of `roots`, or null. */
function findRoot(dir: string, roots: string[], fileExists: (p: string) => boolean): string | null {
  let current = dir;
  while (true) {
    for (const marker of roots) {
      if (fileExists(Path.join(current, marker))) return current;
    }
    const parent = Path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Compile a basename glob (supports `*` and `?`) to an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}
