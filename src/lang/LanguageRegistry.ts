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
import type {
  LanguageDef, GrammarDef, ServerDef, ActiveServer, ServerOverride, ServerOverrides,
} from './types.ts';

export interface ActiveServerOptions {
  /** Existence check (injectable for tests); defaults to `Fs.existsSync`. */
  fileExists?: (path: string) => boolean;
}

export class LanguageRegistry {
  private readonly languages = new Map<string, LanguageDef>();
  private readonly grammars = new Map<string, GrammarDef>();
  private readonly serversByLang = new Map<string, ServerDef[]>();
  // User config (from `lsp.*`): languages to suppress, and per-server tweaks.
  private disabledLanguages = new Set<string>();
  private serverOverrides: ServerOverrides = {};

  registerLanguage(def: LanguageDef): void {
    this.languages.set(def.id, def);
  }

  registerGrammar(langId: string, def: GrammarDef): void {
    this.grammars.set(langId, def);
  }

  registerServer(langId: string, def: ServerDef): void {
    const list = this.serversByLang.get(langId);
    if (list) list.push(def);
    else this.serversByLang.set(langId, [def]);
  }

  /** The language id for a file path, or null if unrecognized. */
  languageForPath(filePath: string): string | null {
    const base = Path.basename(filePath);
    const ext = Path.extname(base).slice(1).toLowerCase();
    for (const lang of this.languages.values()) {
      if (lang.filenames?.includes(base)) return lang.id;
      if (ext !== '' && lang.fileTypes?.some((t) => t.toLowerCase() === ext)) return lang.id;
      if (lang.globs?.some((g) => globToRegExp(g).test(base))) return lang.id;
    }
    return null;
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
