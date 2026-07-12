# LSP integration

Language-server support — diagnostics, navigation, hover, completion, code
actions, rename, formatting, symbols — behind a GTK-free core the editor
drives through a small `LspDocument` interface.

## Decisions

- **Transport: Node IO.** `child_process.spawn` + `vscode-jsonrpc/node` over
  stdio. Node async IO and Promises resolve normally under node-gtk's GLib
  loop. The one rule: start the loop from a **macrotask** (the GTK `activate`
  callback, via `runLoopEntry`), not the top-level ES-module body. No
  heartbeat needed: reads wake the loop via uv's backend fd.
- **Client libraries:** Microsoft's `vscode-jsonrpc` +
  `vscode-languageserver-protocol` (MIT) provide JSON-RPC framing, stream
  transport, and all LSP types. No hand-rolled protocol.
- **Server configs: curated, plugin-contributed.** Servers are hand-authored
  `ServerDef`s registered on the `LanguageRegistry` (`src/lang/`) by plugins
  (e.g. `plugins/typescript/`), not fetched at runtime. See
  [language-config.md](language-config.md) for the registry design and why.
- **Server install (optional).** `ServerDef.install` (npm package, or a raw
  `command`) installs a missing binary into a zym-managed dir
  (`$XDG_DATA_HOME/zym/lsp/<server>/`), never the user's env/project. The
  managed `node_modules/.bin` is searched and put on the spawn `PATH`
  (`lsp/installer.ts`, `lsp/which.ts`). Missing servers are skipped (not
  crash-looped); the warning names the exact missing binary.

## Architecture

The language layer (`src/lang/`) holds the contribution model; the LSP core
(`src/lsp/`) is GTK-free and talks to editors through `LspDocument`.

### Language layer (`src/lang/`)

- `types.ts` — `LanguageDef` (file-type → language id detection, LSP
  `languageId` mapping), `GrammarDef` (tree-sitter binding), `ServerDef` (an
  LSP server candidate: command, install, root markers, exclusion
  `group`/`priority`), `ServerOverride`.
- `LanguageRegistry.ts` — the plugin seam.
  `registerLanguage`/`registerGrammar`/`registerServer` (disposable);
  `languageForPath`, `grammarFor`, `serversFor`, and `activeServers(path)` —
  resolves a file to the servers that should run, applying root-marker gating,
  exclusion groups (highest `priority` wins within a group; ungrouped linters
  run additively), and user overrides.
- `index.ts` — the `languages` singleton, populated by plugins at activation.

### LSP core (`src/lsp/`)

- `position.ts` — `Point`/`Range` ↔ LSP, encoding-aware (utf-8/16/32) + URI
  helpers.
- `LspClient.ts` — transport: spawn + `vscode-jsonrpc` connection +
  logging/exit events; injects managed/`node_modules` bin dirs onto `PATH`.
- `LanguageServer.ts` — one server per (server, rootDir): lifecycle, capability
  + position-encoding negotiation, document sync (full-text or incremental, per
  the negotiated `TextDocumentSyncKind`), and the request methods (definition,
  references, hover, completion + resolve, signatureHelp, codeAction + resolve,
  rename + prepareRename, formatting/rangeFormatting,
  workspace/documentSymbol, inlayHint).
- `LspManager.ts` — orchestration: resolves a file → its `activeServers`,
  spawns/reuses one process per (server, rootDir), drives
  didOpen/Change/Save/Close to *every* active server, routes diagnostics into
  the store, and answers requests against the *primary* server (the language
  server; ungrouped linters contribute diagnostics only). Root resolution =
  root markers → `.git` → file dir (`resolveRootDir`). Crash recovery restarts
  a crashed server with exponential backoff, giving up after a bounded number
  of rapid crashes (a stable run resets the count). **Idle shutdown:** when a
  server's last open document closes, it is stopped after a short debounced
  delay (`IDLE_SHUTDOWN_MS`) — kept non-zero so a `didClose`→`didOpen`
  reload/rename or a quick reopen re-claims the process instead of bouncing it.
  Without this, servers for closed files (and for closed workbenches/worktrees,
  which on close re-attribute to the user workbench's LSP count) would live
  until app quit. Pure helpers (`resolveRootDir`, `locationToTarget`) are
  exported for testing.
- `which.ts` / `installer.ts` — server-binary resolution and managed install
  (see decisions above).
- `workspaceEdit.ts` — `applyTextEdits` / `normalizeWorkspaceEdit`: apply a
  server `WorkspaceEdit` (open editors edited in-buffer, others on disk).
  Shared by code actions and rename.
- `workspaceWatcher.ts` — watches the project tree (per-dir `fs.watch`,
  excluding `node_modules`/`.git`/build output) and feeds
  `workspace/didChangeWatchedFiles`.
- `glob.ts` — glob matching for file-watcher filters / language globs.
- `diagnostics/DiagnosticsStore.ts` — per-path diagnostics + `did-update`
  events; `paths`/`countsBySeverity` take an `accept(path)` predicate for
  scoping.
- `diagnostics/DiagnosticsView.ts` — per-editor inline squiggles (shared
  `TextDecorations` `diagnostic-*` styles), Nerd Font gutter glyphs drawn by a
  `GtkSource.GutterRendererText` (the fold-gutter pattern), and **error-lens**
  trailing text (worst diagnostic per line, via `VirtualText`; toggle
  `editor.errorLens`).
- `diagnostics/DiagnosticsPanel.ts` — the "Diagnostics" list (bottom-dock
  tab); a thin consumer of the shared `ui/LocationList`.
- `diagnostics/severity.ts` — per-severity presentation (Nerd Font glyph +
  color), shared by the view and the panel.

### Shared UI

- `ui/LocationList.ts` — keyboard-navigable list of file locations
  (`#LocationList` keymap + `core:*` nav); used by the Diagnostics panel.
  Activating a row reveals an open editor or opens the file
  (`AppWindow.openOrFocusFile`).
- `ui/ReferencesPicker.ts` (`openReferencesPicker`) — fuzzy-filterable list
  with a source-preview pane, reusing the `ui/LocationPicker` the
  workspace-symbol / search features use; presents find-references results.

### Wiring

`zym.lsp` singleton + `lsp.*` config schema (`zym.ts`: `lsp.enable`,
`lsp.disabledLanguages`, `lsp.servers` overrides, `lsp.autoInstall`).
`TextEditor` implements `LspDocument` and drives
didOpen/didChange/didSave/didClose. `AppWindow` registers the `lsp:*`
commands, applies `lsp.*` config live, and routes `LspManager.onNotice`
(server start/ready/exit/failure, install actions) into the notification log —
trace for routine events, warning/error for failures. Diagnostics are scoped
per workbench: `AppWindow.ownerWorkbenchCwd` assigns each path/server-root to
the open workbench whose cwd is its longest prefix (a nested worktree owns its
files; orphans → user workbench), and the header `WorkbenchStatus` follows the
active workbench.

## Features

These all work today, driven from the LSP core and surfaced through the editor:

- **Navigation:** definition / declaration / type-definition / implementation
  (`space l d`/`D`/`t`/`i`), find-references (`space l r`,
  `ReferencesPicker`), workspace symbols (`space l s`), document symbols /
  outline (`space l o`), and inline peek-definition (`space l p`, see
  [inline-widgets.md](inline-widgets.md)). Workspace symbols is project-scoped,
  not cursor-scoped, so it runs from any tab: the active file's server when there
  is one, else the first running server that supports it (`workspaceSymbolServer`).
- **Hover** (`space l k` / vim `K`): `textDocument/hover` → markdown rendered
  to Pango (`ui/markdownMarkup.ts`, subset renderer) in a floating overlay
  card, bottom-aligned just above the cursor (a `Gtk.Overlay` child with
  `valign=END` + margins — no height read). Code blocks are syntax-highlighted by reusing the
  editor's tree-sitter grammars + queries + theme colors
  (`syntax/highlightToMarkup.ts`), in the editor monospace font; prose stays
  proportional. Content soft-wraps (Pango `WORD_CHAR`) and the card is width-capped
  (`HOVER_MAX_WIDTH_CHARS`, in chars so it tracks the font) so a long code line wraps
  to a readable column instead of stretching the card. 3s timeout; dismissed on
  cursor-move/scroll. Command-triggered.
- **Completion:** `textDocument/completion` (+ resolve) via the primary server
  (`createLspCompletionSource` / `CompletionController` / `CompletionPopup`),
  trigger-character support (`.`/`::`), and auto-imports (resolved
  `additionalTextEdits` applied on accept). See
  [autocompletion.md](autocompletion.md).
- **Signature help:** `textDocument/signatureHelp` — floating card while
  typing call args, active parameter bold.
- **Code actions:** `textDocument/codeAction` (+ resolve) → pick
  (`space l a`), applied via `workspaceEdit.ts`.
- **Rename:** `textDocument/rename` (+ prepareRename) → `space l R`, applied
  via `workspaceEdit.ts`.
- **File rename/move:** on `file:move`/`file:rename`, `workspace/willRenameFiles`
  (primary server, gated on its `fileOperations` filter globs) returns a
  `WorkspaceEdit` that rewrites references in other files — applied via
  `workspaceEdit.ts` after a confirm, then the on-disk move, then
  `workspace/didRenameFiles`. The willRename request is cancellable
  (`$/cancelRequest`) behind a delayed "Updating references…" toast. Client
  advertises `workspace.fileOperations.{willRename,didRename}`.
- **Formatting:** document / range formatting (`space l f`).
- **Inlay hints:** `textDocument/inlayHint` rendered as native end-of-line
  annotations (`InlayHintController` → `VirtualText`, debounced; toggle
  `editor.inlayHints`). Mid-line column placement would need the overlay
  recipe — see [virtual-lines.md](virtual-lines.md).
- **Diagnostics:** inline squiggles, Nerd Font gutter glyphs, error-lens
  trailing text (`editor.errorLens`), "Diagnostics" panel, per-workbench
  scoping + header status.

## Remaining / planned

- [ ] Mouse-hover (hover-on-pointer; today hover is command-triggered).
- [ ] Code lens.
- [ ] Inline-rename UI.
- [ ] File rename/move targets only the *primary* server (covers TS/JS import
  updates); a second server that also rewrites references is not consulted.

## Notes / gotchas

- Servers must be on `PATH` (or installed into the managed dir). A file whose
  language resolves to an uninstalled server logs a `failed to start …` notice
  naming the missing binary.
- Requests target the *primary* server only; ungrouped linters (e.g. eslint)
  contribute diagnostics but don't answer navigation/hover/etc.
