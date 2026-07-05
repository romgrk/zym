# Language configuration (grammar + LSP) and the plugin seam

Grammar **and** LSP config are plugin-contributed and curated — no runtime
fetch. A `LanguageRegistry` ties files → languages → their grammar + servers;
the syntax layer and `LspManager` read off it. One language can use
**different servers per project** (a JS project on Flow vs tsserver vs Deno),
selected by root markers.

Helix's `languages.toml` is an authoring *reference* only, not a dependency.

## `LanguageRegistry` (core, the plugin seam)

`src/lang/LanguageRegistry.ts` + `src/lang/types.ts`; the app-wide `languages`
singleton is in `src/lang/index.ts`. Registry starts empty; plugins populate it
at activation (before grammars preload / files open). One registry keyed by
language id; grammar and servers attach independently (VSCode-style), so a
plugin can contribute any subset. Each `register*` returns a `Disposable`
(plugin teardown).

```ts
registerLanguage({ id, fileTypes?, filenames?, globs?, lspId?, lspIds? }): Disposable
registerGrammar(langId, { wasm, highlightsPath, foldTypes, foldsPath?, injections? }): Disposable
registerServer(langId, ServerDef): Disposable   // 0..n per language
```

- `LanguageDef`: detection. `fileTypes` are bare extensions; `lspId`/`lspIds`
  give the LSP `languageId` when it differs from `id` (`lspIds` is per-extension
  — one grammar can span several LSP languages, e.g. the `tsx` grammar backs
  `.js`→javascript, `.jsx`→javascriptreact, `.tsx`→typescriptreact).
  `comments` declares the comment delimiters (`line` leader and/or `block` pair;
  omit for comment-less languages like JSON) — read via `commentsFor(langId)` by
  the editor's toggle-line-comments (`g c`, see [vim-mode.md](vim-mode.md)).
- `GrammarDef`: `wasm` (absolute path or node_modules specifier),
  `highlightsPath` + `foldsPath` (absolute `.scm` paths the plugin vendors via
  `ctx.resolve`), `foldTypes` (node-type folding fallback when no `foldsPath`),
  `injections`.

Resolution API: `languageForPath`, `lspLanguageId`, `grammarFor`,
`grammarLanguageIds` (preload), `serversFor`, `effectiveServers`,
`activeServers`, `installableServers`, `setOverrides`. `src/syntax/grammar.ts`
keeps wasm/query loading but reads its specs from `languages.grammarFor`
(public API `langIdForPath`/`loadGrammar`/`getGrammar`/`preloadGrammars`/
`createParser`).

Built-in languages register via the bundled plugins (`plugins/*`); the
TypeScript plugin (`plugins/typescript/index.ts`) is the reference and
contributes the whole TS/JS family. See [../plugins.md](../plugins.md).

### Remaining / planned

- External plugin *loading* (manifest + out-of-repo packages).

## Per-project server selection

```ts
interface ServerDef {
  name: string;                 // 'flow' | 'typescript-language-server' | 'eslint' | …
  command: string;
  args?: string[];
  install?: InstallSpec;        // { via:'npm', package } | { command: string[] }
  initializationOptions?: unknown;
  settings?: unknown;
  roots?: string[];             // ancestor markers → project root + activation gate
  singleFile?: boolean;         // activate with no root (root = file's dir); default false
  group?: string;               // mutual-exclusion group; highest-priority activated wins
  priority?: number;            // group tiebreak, default 0
}
```

`activeServers(file)` (injectable `fileExists` for tests):
1. `langId = languageForPath(file)` → `effectiveServers(langId)` (candidates
   with user overrides applied).
2. Per candidate: walk ancestors for `roots` → `rootDir`; **activated** iff a
   root is found (or `singleFile`, root = file's dir).
3. Within each `group`, keep only the highest-`priority` activated server;
   ungrouped activated servers all stay.
4. → `ActiveServer { server, rootDir }[]` to spawn/reuse (keyed by
   `(name, rootDir)`).

Example — the `tsx` language (`plugins/typescript/index.ts`): flow
(`roots:['.flowconfig']`, group `js-types`, prio 20), tsserver
(`roots:['tsconfig.json','jsconfig.json','package.json']`, group `js-types`,
prio 10), deno (`roots:['deno.json','deno.jsonc']`, group `js-types`, prio 30),
eslint (roots `.eslintrc*` + `eslint.config.*`, no group). A Flow project picks
flow, plain TS/JS picks tsserver, Deno picks deno; eslint runs alongside any.
(The `ts` language registers tsserver/deno/eslint but not flow.)

## User overrides (`lsp.disabledLanguages` / `lsp.servers`)

`setOverrides({ disabledLanguages, servers })` stores config; `effectiveServers`
applies it, so overrides flow through activation + groups + priority:
- a disabled language → no servers (detection + grammars/highlighting
  unaffected);
- `lsp.servers` is keyed **langId → serverName → `ServerOverride`**: a name
  matching a built-in tweaks it (disable, or replace command/args/settings/
  roots/singleFile/group/priority — set fields replace wholesale, not
  deep-merged); an unknown name with a `command` adds a server.

`LspManager.configure` applies overrides and reconciles open docs (restart under
the new config).

## How `LspManager` consumes it

- `resolveServers(file)` → all active servers (each with a reuse key + a
  `primary` flag). One document drives several servers:
  didOpen/didChange/didSave/didClose fan out to every active server (didOpen
  guarded so a crash-restart can't double-open a healthy sibling).
- Requests (hover/definition/references/code-action/rename/format/
  signature-help) target the **primary** — the grouped server wins over
  ungrouped linters, tie-break on priority (`primaryKeyOf`).
- **Diagnostics are namespaced per server.** `DiagnosticsStore` keys by
  `path → (serverName → {diagnostics, encoding})` so eslint + tsserver don't
  clobber each other; `get(path)` returns merged entries (each paired with its
  server's encoding), sorted by position. `clearServer(serverName, path)` for
  crash recovery; `clear(path)` drops the whole path on close.

## Server availability (installed vs configured)

A configured server only runs if its command is actually installed. `LspManager`
resolves each candidate's command via `lsp/which.ts` (`resolveCommand`) over: the
zym-managed install dir (`managedBinDir`), then project `node_modules/.bin`
from the server's root dir upward (`nodeModulesBinDirs`), then PATH — and
**drops** servers that don't resolve (memoized per command+root). So an optional
server the user hasn't installed is skipped rather than spawned → ENOENT →
crash-restart loop. `LspClient` prepends the same dirs to the spawned server's
PATH. Spawn-level failures (e.g. EACCES) are captured and logged with the full
invocation; trace logs record each `starting <cmd> <args> (cwd …)`.

Note the binary names: the LSP servers are `typescript-language-server` /
`vscode-eslint-language-server`, **not** the `tsserver` / `eslint` CLIs that
often sit in `node_modules/.bin` (those don't speak LSP over stdio).

## Installing servers

A `ServerDef.install` spec is `{ via:'npm', package }` (`package` may be several
space-separated specs) or a raw `{ command }` escape hatch. `lsp/installer.ts`
installs into a managed dir (`$XDG_DATA_HOME/zym/lsp/<server>/`, npm bins under
its `node_modules/.bin`), never the user's global env or project.

Triggers when a needed server is missing:
- **Warning + "Install" button** (default): the "not started" notice carries an
  install action.
- **`lsp:install-server` command**: a picker of installable servers (install
  state annotated) → `LspManager.installByName`.
- **Auto-install** (`lsp.autoInstall`, default off): install on first need,
  announced with an `auto-installing <server>` notification (not silent).

On success the availability cache is cleared and open docs reload, so the server
starts without a restart. Built-ins with installs: `typescript-language-server`
(+`typescript`), `eslint` (`vscode-langservers-extracted`), `flow` (`flow-bin`);
`deno` is out-of-band.

## Server→client requests & configuration

Servers send requests *to* the client; with no handler vscode-jsonrpc
auto-replies `MethodNotFound`, breaking config-driven servers. `LanguageServer`
answers:

- **`workspace/configuration`** → the server's `settings`, resolved per
  requested section via `getConfigSection` (empty/absent → whole object; dotted
  path otherwise; missing → `null`). We push `workspace/didChangeConfiguration`
  after `initialized` and advertise both capabilities. ESLint pulls its config
  this way (empty section), so `ESLINT.settings` carries VS Code-style defaults.
- **`client/registerCapability`/`unregisterCapability`** → file-watcher
  registrations honored (see below); other dynamic registrations acknowledged.
- **`window/workDoneProgress/create`** → acknowledged (progress not shown yet).
- **`window/showMessage`** → a user-facing notice; **`window/logMessage`** error/
  warning → trace log (info/debug chatter dropped).

## Code actions & the WorkspaceEdit applier

`lsp/workspaceEdit.ts` is the shared, pure core (also rename/formatting):
`applyTextEdits(text, edits, enc)` applies LSP `TextEdit`s to a string (each
resolved to a UTF-16 offset, spliced from the end so offsets stay valid;
encoding-aware); `normalizeWorkspaceEdit` flattens a `WorkspaceEdit`'s `changes`/
`documentChanges` to per-file edits (resource create/rename/delete ops counted,
applied by the UI later).

`LanguageServer.codeAction` + `resolveCodeAction` (servers omit the `edit` from
the list; advertised via `codeActionLiteralSupport` + `resolveSupport`).
`LspManager.codeActions(doc, range?)` targets the primary, passing overlapping
diagnostics as context.

**UI:** `lsp:code-action` (`space l a`), `lsp:rename` (`space l R`, prefilled
with the symbol), `lsp:format` (`space l f`). All apply via
`AppWindow.applyWorkspaceEdit` — open editors edited in their buffer
(`TextEditor.applyLspEdits`, one undo group), unopened files on disk.
`FormattingOptions` come from `editor.tabLength`/`insertSpaces`.

### Remaining / planned

- Command-only code actions (`workspace/executeCommand`).
- Resource operations (create/rename/delete file).
- Range-formatting from the selection (the backend supports it).

## Signature help

`LanguageServer.signatureHelp` + `hasSignatureHelp` +
`signatureHelpTriggerCharacters` (labelOffset + activeParameter support);
`LspManager.signatureHelp(doc)` targets the primary (timeout-bounded). The UI
card (in `TextEditor`) shows while typing a call's arguments: triggered when a
trigger char (`(`/`,`) appears in the *typed text* (not the char before the
cursor, which autopair leaves as the inserted `)`), debounced so autopair edits
settle, re-requested on cursor moves while open (so a type-over of `)` closes
it). Anchored once at the callee name (`callNameStartColumn` walks to the active
call's open paren, depth-aware, then back over the `obj.method` chain); the
active parameter is bolded and the label syntax-highlighted.

## Document sync (incremental)

`LanguageServer.didChange` takes LSP `contentChanges`; `LspManager.didChange`
chooses per server. A server that negotiated `TextDocumentSyncKind.Incremental`
(`supportsIncrementalSync`) and got a single edit receives just that delta;
otherwise (full-only, or a multi-edit event with ambiguous sequential
coordinates) it gets the full text — always correct.

The editor adapter maps buffer-change events to `DocumentEdit`s (pre-edit `start`
Point + `oldText` + `newText`), keeping this layer GTK-free. `incrementalChange`
converts the start with the unchanged prefix of its current line and derives the
range end from `start + oldText` via `advancePosition` (encoding-aware) — so the
change lands in the server's pre-change coordinates without the old line text.

## File watching (`workspace/didChangeWatchedFiles`)

We advertise `workspace.didChangeWatchedFiles.dynamicRegistration`, so servers
register watchers (tsserver watches `tsconfig`/source files; eslint its config)
via `client/registerCapability`. `LanguageServer` compiles each watcher's glob to
an absolute-path regex (`lsp/glob.ts`: `**`/`*`/`?`/`{}`) and lazily starts a
`WorkspaceWatcher` (`lsp/workspaceWatcher.ts`) over the server's root. Matching
changes are sent as `workspace/didChangeWatchedFiles`, so servers learn about
external edits without a restart.

`WorkspaceWatcher` places a **non-recursive `fs.watch` per directory** (added/
dropped as dirs appear/vanish) instead of `fs.watch({recursive})`, so it can
**exclude** `node_modules`/`.git`/build dirs (recursive offers no ignore and
would hit inotify limits). Raw events are debounced; type
(created/changed/deleted) is resolved by stat + a known-files set. Failures
(perm/limit) degrade gracefully (that dir is skipped). One watcher per
(server, root).

### Remaining / planned

- Dedup watches by root: two servers at one root double the watches today.

## Fold queries (`folds.scm`)

A grammar declares foldable constructs in `queries/<lang>/folds.scm` (referenced
by `registerGrammar`'s `foldsPath`; `foldTypes` is the node-type fallback when no
query ships). Two capture names control fold *style* (the projection mechanism is
in [folding.md](folding.md)):

- **`@fold`** — the default: folds to a single line, the footer
  (`}` / `} from 'x'`) joins the header (`import {[N]} from 'x'`). Use for
  blocks, objects, arrays, class/interface bodies, comments, standalone `if`, the
  final `else`/`finally`.
- **`@fold.keepFooter`** — keeps the closing line on its **own** line, so a
  chained construct reads one-per-line (`if (x) {[N]` / `} else if (y) {…`).
  Capture the body block of a clause that is *continued* by another (`} else {`,
  `} catch {`).

A node may match both; `computeFoldRanges` merges per start row and keep-footer
wins. Example (TS/TSX `folds.scm`):

```scheme
[ (statement_block) (object) (class_body) (comment) ] @fold
; consequence of an `if` that has an else; a try block a catch follows:
(if_statement consequence: (statement_block) @fold.keepFooter alternative: (_))
(try_statement body: (statement_block) @fold.keepFooter handler: (catch_clause))
```

Adding keep-footer to another language is a **query-only** change (no code).
Verify field names against the grammar — a bad pattern fails the whole
`language.query` compile (folding then silently stops); the runtime path is
`grammar.ts` (~line 89).

## Open questions

- Group tie-break when several exclusive roots are present: priority (chosen) vs
  most-specific/closest root. Priority + user override should cover it.
- Do requests (hover/def) ever need a non-group "primary"? Current: the
  highest-priority activated grouped server is primary; ungrouped (linters)
  contribute diagnostics only.
