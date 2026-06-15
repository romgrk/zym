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

## Server availability (installed vs configured)

A configured server only runs if its command is actually installed. `LspManager`
resolves each candidate's command via `lsp/which.ts` — the quilx-managed install
dir, then project `node_modules/.bin` (from the server's root dir upward), then
PATH — and **drops** servers that don't resolve (memoized per command+root). So an
optional server the user hasn't installed is skipped instead of being spawned,
failing with ENOENT, and tripping the crash-restart loop. `LspClient` prepends the
same dirs to the spawned server's PATH (so a managed or repo-local server resolves
when opening another project). When a server that *did* resolve still fails to
start, the spawn-level reason (e.g. EACCES) is captured and logged with the full
invocation; trace logs record each `starting <cmd> <args> (cwd …)`.

Note the binary names: the LSP servers are `typescript-language-server` /
`vscode-eslint-language-server`, **not** the `tsserver` / `eslint` CLIs that often
sit in `node_modules/.bin` (those don't speak LSP over stdio).

## Installing servers

A `ServerDef` may carry an `install` spec (`{ via: 'npm', package }` — `package`
may be several space-separated specs — or a raw `{ command }` escape hatch).
`lsp/installer.ts` installs into a managed dir (`$XDG_DATA_HOME/quilx/lsp/<server>/`,
npm bins under its `node_modules/.bin`), never the user's global env or project.

Triggers, when a needed server is missing:
- **Warning + "Install" button** (default): the "not started" warning carries an
  action that installs on click (`LspNotice.action` → a notification button).
- **`lsp:install-server` command**: a picker of installable servers (install state
  annotated) → `LspManager.installByName`.
- **Auto-install** (`lsp.autoInstall`, default off): install on first need without a
  prompt, announced with an `auto-installing <server>` info notification (not silent).

On success the availability cache is cleared and open docs reload, so the
freshly-installed server starts without a restart. Built-ins with installs:
`typescript-language-server` (+`typescript`), `eslint`
(`vscode-langservers-extracted`), `flow` (`flow-bin`); `deno` is out-of-band.

## Server→client requests & configuration

Servers send requests *to* the client; with no handler vscode-jsonrpc auto-replies
`MethodNotFound`, which breaks config-driven servers. `LanguageServer` answers:

- **`workspace/configuration`** → the server's `settings` (`ServerDef.settings`),
  resolved per requested section via `getConfigSection` (empty/absent section →
  whole object; dotted path otherwise; missing → `null`). We also push
  `workspace/didChangeConfiguration` after `initialized`, and advertise
  `workspace.configuration` + `didChangeConfiguration`.
- **`client/registerCapability` / `unregisterCapability`** → file-watcher
  registrations (`workspace/didChangeWatchedFiles`) are honored (see below); other
  dynamic registrations are acknowledged.
- **`window/workDoneProgress/create`** → acknowledged (progress not shown yet).
- **`window/showMessage`** → a notice (user-facing); **`window/logMessage`** error/
  warning lines → the trace log (info/debug chatter dropped).

ESLint note: it pulls its config this way (empty section), so `ESLINT.settings`
carries VS Code-style defaults. Caveat — `vscode-langservers-extracted` bundles an
eslint server that may predate **flat-config** (`eslint.config.*`) support; against
a flat-config-only project it stays idle (no error). A flat-config-capable eslint
LSP is the fix there, independent of this client handling.

## Code actions & the WorkspaceEdit applier

`lsp/workspaceEdit.ts` is the shared, pure core (also for rename/formatting):
`applyTextEdits(text, edits, enc)` applies LSP `TextEdit`s to a string (resolves
each to a UTF-16 offset, splices from the end so offsets stay valid;
encoding-aware), and `normalizeWorkspaceEdit` flattens a `WorkspaceEdit`'s
`changes`/`documentChanges` to per-file edits (resource create/rename/delete ops
are counted, applied by the UI later).

`LanguageServer.codeAction(path, range, context)` + `resolveCodeAction` (servers
omit the `edit` from the list; advertised via `codeActionLiteralSupport` +
`resolveSupport`). `LspManager.codeActions(doc, range?)` targets the primary
server, passing the overlapping diagnostics as context. Verified end-to-end
against tsserver (Organize Imports → resolve → normalize → apply).

**UI:** `lsp:code-action` (`space l a`) picks an action; `lsp:rename`
(`space l R`) prompts for a name (prefilled with the symbol); `lsp:format`
(`space l f`) formats the document. All apply via `AppWindow.applyWorkspaceEdit`
— open editors are edited in their buffer (`TextEditor.applyLspEdits`, one undo
group), files with no open editor on disk. `LspManager.rename`/`format`/`canRename`
back rename/format; `FormattingOptions` come from `editor.tabLength`/`insertSpaces`.
Verified end-to-end against tsserver. **Not yet wired:** command-only code actions
(`workspace/executeCommand`), resource operations (create/rename/delete file), and
range-formatting from the selection (the backend supports it).

## Document sync (incremental)

`LanguageServer.didChange` takes LSP `contentChanges`; `LspManager.didChange`
chooses per server. A server that negotiated `TextDocumentSyncKind.Incremental`
(`supportsIncrementalSync`) and got a single edit receives just that delta;
otherwise (full-only server, or a multi-edit event whose sequential coordinates
are ambiguous) it gets the full text — always correct.

The editor adapter maps its buffer-change events to `DocumentEdit`s (pre-edit
`start` Point + `oldText` + `newText`), keeping this layer GTK-free.
`incrementalChange` converts the start with the unchanged prefix of its current
line and derives the range end from `start + oldText` via `advancePosition`
(encoding-aware) — so the change lands in the server's pre-change coordinates
without needing the old line text. Verified end-to-end against tsserver (an
incremental edit raised the expected type error; the inverse edit cleared it).

## File watching (workspace/didChangeWatchedFiles)

We advertise `workspace.didChangeWatchedFiles.dynamicRegistration`, so servers
register watchers (tsserver watches `tsconfig`/source files; eslint its config) via
`client/registerCapability`. `LanguageServer` compiles each watcher's glob to an
absolute-path regex (`lsp/glob.ts`: `**`/`*`/`?`/`{}`) and lazily starts a
`WorkspaceWatcher` (`lsp/workspaceWatcher.ts`) over the server's root. Matching
changes are sent as `workspace/didChangeWatchedFiles`, so servers learn about
external edits (new files, branch switches, config changes) without a restart.

`WorkspaceWatcher` places a **non-recursive `fs.watch` per directory** (adding/
dropping them as dirs appear/vanish) instead of `fs.watch({recursive})`, so it can
**exclude** `node_modules`/`.git`/build dirs (recursive offers no ignore and would
hit inotify limits). Raw events are debounced; type (created/changed/deleted) is
resolved by stat + a known-files set. Failures (perm/limit) degrade gracefully
(that dir is skipped). One watcher per (server, root) — two servers at one root
double the watches today (a future dedup-by-root opportunity).

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
