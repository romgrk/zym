# Language configuration (grammar + LSP) and the plugin seam

## Context

Language knowledge is currently split and sourced inconsistently:
- `syntax/grammar.ts` — a hardcoded `SPECS` map (extensions → tree-sitter wasm +
  highlights query + fold types).
- `lsp/registry.ts` — **fetches** Helix `languages.toml` at runtime (cached +
  vendored snapshot), parses 155 KB of TOML, and resolves file → server config.

We want grammar **and** LSP config to be plugin-contributed, and to stop
runtime-fetching the LSP config (non-deterministic, network-dependent, decoupled
from the grammars, pulls ~177 irrelevant languages). And one language must
support **different server configs per project** (a JS project on Flow vs one on
tsserver vs Deno).

## Decisions

- **Curated, hand-authored built-in pack** (not a generated Helix dump). Each
  supported language is a small definition we own. (Helix `languages.toml` is a
  *reference* when authoring, not a runtime/generated dependency.)
- **Restructure first**, before more LSP features (code actions etc.), so they
  build on the unified seam.
- **No runtime fetch / no live TOML parse.** Delete `registry.refresh()` + the
  vendored `languages.toml` + `smol-toml`.

## `LanguageRegistry` (core, the plugin seam)

One registry keyed by language id; grammar and servers attach independently
(VSCode-style), so a plugin can contribute any subset.

```ts
registerLanguage({ id, fileTypes, filenames?, globs?, firstLinePattern? })   // detection
registerGrammar(langId, { wasm, highlights, foldTypes?, injections? })       // highlighting
registerServer(langId, ServerDef)                                            // LSP (0..n per language)
```

Resolution API: `languageForPath(path)`, `grammarFor(langId)`,
`activeServers(path)`, plus loaders (`grammar.ts` keeps wasm/query loading but
reads its specs from the registry).

Built-in languages register at startup (`src/lang/builtin/*`) — effectively the
first, in-process "plugin". External plugin *loading* (manifest + per-plugin
asset paths) lands with the broader Plugin-system task; this restructure is its
precursor.

## Multiple server configs per language (per-project selection)

```ts
interface ServerDef {
  name: string;                 // 'flow' | 'tsserver' | 'eslint' | …
  command: string;
  args?: string[];
  initializationOptions?: unknown;
  settings?: unknown;
  roots?: string[];             // ancestor markers → project root + activation
  singleFile?: boolean;         // activate with no root (root = file's dir); default false
  group?: string;               // mutual-exclusion group; highest-priority activated wins
  priority?: number;            // default 0
}
```

`activeServers(file)`:
1. `lang = languageForPath(file)` → candidate servers for the language.
2. Per candidate: walk ancestors for `roots` → `rootDir`; **activated** iff a root
   is found (or `singleFile` with root = file's dir).
3. Within each `group`, keep only the highest-`priority` activated server;
   ungrouped activated servers all stay.
4. → `{ server, rootDir }[]` to spawn/reuse (keyed by `(name, rootDir)`).

Example (`javascript`): flow (`roots:['.flowconfig']`, group `js-types`, prio 20),
tsserver (`roots:['tsconfig.json','jsconfig.json','package.json']`, group
`js-types`, prio 10), deno (`roots:['deno.json']`, group `js-types`, prio 30),
eslint (`roots:['.eslintrc',…]`, no group). → Flow project picks flow; plain
TS/JS picks tsserver; Deno picks deno; eslint runs alongside any. User config
overrides: disable a server, change priority, force one, or add servers.

## Implications for existing LSP code

- **`LspManager.resolve`** changes from "first server of the matched language" to
  `activeServers(file)` → ensure/reuse **each** active server. One document may
  now drive several servers (didOpen/didChange/didSave/didClose to all that are
  open for it).
- **Diagnostics must be namespaced per server.** `DiagnosticsStore` currently
  keys by path and *replaces*; with (e.g.) eslint + tsserver publishing for the
  same file they'd clobber. Re-key by `(serverName, path)` and merge for the
  gutter/squiggles/panel. Requests (hover/definition/references) target a single
  server (the language's primary in its group); only diagnostics merge.

## Migration plan (phased)

1. [x] `src/lang/`: `LanguageRegistry` + `types.ts` + `builtin.ts` (curated
   typescript/tsx; server defs with roots/group/priority — flow/tsserver/deno
   exclusion group + additive eslint) + `languages` singleton. Resolution
   (`languageForPath`, `grammarFor`, `activeServers` with activation + groups +
   priority + injectable `fileExists`). Unit-tested. **Additive — not yet
   consumed** by `grammar.ts`/`LspManager`.
2. [x] Repoint `grammar.ts` to read grammar specs from the registry (keep
   wasm/query loading + the preload). `langIdForPath` → `languageForPath`.
   Public API (`langIdForPath`/`loadGrammar`/`getGrammar`/`preloadGrammars`/
   `createParser`) unchanged, so no callers were touched. `SPECS`/`GrammarSpec`/
   `FOLD_TYPES` deleted; specs now come from `languages.grammarFor` +
   `languages.grammarLanguageIds`.
3. [x] Repoint `LspManager` to `activeServers(file)`; support multiple active
   servers. `resolve` → `resolveServers` (all active, each with reuse key +
   `primary` flag); didOpen/didChange/didSave/didClose fan out to every active
   server (didOpen guarded by `isOpen` so a crash-restart can't double-open a
   healthy sibling); requests (hover/definition/references) target the primary
   (grouped server wins over ungrouped linters; tie-break on priority — see
   `primaryKeyOf`). `LspClient`/`LanguageServer` migrated off `registry.ts`'s
   `ServerSpec` to `lang/types.ts`'s `ServerDef` (+ `initializationOptions` now
   sent in `initialize`). `configure` only honors `enable`; overrides deferred
   to phase 6. `refreshRegistry` is a no-op pending phase-5 removal.
   **Caveat (fixed in phase 4):** diagnostics are still keyed by path alone, so
   two servers publishing for the same file (e.g. eslint + tsserver) clobber.
4. [x] Namespace `DiagnosticsStore` by `(serverName, path)` + merge. Storage is
   `path → (serverName → {diagnostics, encoding})`; `set` takes a `serverName`
   and replaces only that server's set (empty clears just it). `get(path)`
   returns a merged `DiagnosticEntry[]` (each diagnostic paired with its own
   server's encoding, since servers may negotiate different ones), sorted by
   position. Added `clearServer(serverName, path)` (crash recovery clears only
   the dead server, not its live siblings); `clear(path)` still drops the whole
   path (on close). `DiagnosticsView`/`DiagnosticsPanel` updated to consume the
   merged entries. Unit-tested (accumulate-not-clobber, per-server replace,
   clearServer vs clear, did-update). Closes the phase-3 clobber caveat.
5. [x] Delete `lsp/registry.ts` fetch/cache + `registry.test.ts` + vendored
   `languages.toml` + the `smol-toml` dependency. Also removed the now-dead
   `LspManager.refreshRegistry`, the `lsp.configUrl`/`lsp.refreshOnLaunch` config
   schema + their AppWindow wiring, and `LspConfig.configUrl`. Server configs are
   now solely the curated built-in pack (`lang/builtin.ts`); Helix's
   `languages.toml` remains only an authoring *reference* (a comment), not a
   runtime dependency. `disabledLanguages`/`lsp.servers` config retained for
   phase 6 (currently accepted but not yet applied).
6. [x] User config keyed into the registry. `LanguageRegistry.setOverrides({
   disabledLanguages, servers })` stores config; `effectiveServers(langId)`
   applies it (disabled language → no servers; per-server override by name to
   disable/tweak command/args/settings/roots/priority/group; an unknown name
   with a `command` adds a server). `activeServers` resolves from
   `effectiveServers`, so overrides flow through activation + groups + priority.
   `lsp.servers` is now keyed **langId → serverName → override**.
   `LspManager.configure` applies overrides and reconciles open docs (restart
   under the new config). Overrides touch server resolution only — detection and
   grammars (highlighting) are unaffected by `disabledLanguages`. Unit-tested.

**Migration complete** — grammar + LSP config is fully registry-driven, curated,
and override-able; no runtime fetch remains.

## Open questions

- Group tie-break when several exclusive roots are present: priority (chosen) vs
  most-specific/closest root. Priority + user override should cover it.
- Do requests (hover/def) ever need a non-group "primary"? Start with: the
  highest-priority activated grouped server is primary; ungrouped (linters)
  contribute diagnostics only.
