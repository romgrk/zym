# LSP integration

Language-server support: diagnostics, navigation, and (later) hover/code-actions,
behind an abstraction the rest of the editor uses.

## Decisions

- **Transport: Node IO.** `child_process.spawn` + `vscode-jsonrpc/node` over stdio.
  This works under node-gtk's GLib loop because the loop is run from the GTK
  `activate` callback (a macrotask), not the top-level module microtask — see
  node-gtk issue #442 / `runLoopEntry`. Validated end-to-end against `clangd`
  (initialize 9ms, idle round-trip 2ms, idle diagnostics push 56ms). No heartbeat
  needed: reads wake the loop via uv's backend fd.
- **Client libraries:** Microsoft's `vscode-jsonrpc` + `vscode-languageserver-protocol`
  (MIT) — JSON-RPC framing, stream transport, and all LSP types. No hand-rolled
  protocol.
- **Server configs: Helix `languages.toml`** — the one declarative, parseable source
  mapping file-types → language → server `command`/`args`/`roots`/`config`. Fetched
  from GitHub, cached under `$XDG_CONFIG_HOME/quilx/lsp/`, with a vendored snapshot
  (`src/lsp/languages.toml`) as the offline fallback. Parsed with `smol-toml`.
  (Zed was evaluated and rejected — its server launch logic is Rust/WASM, not data.)
  Helix configs assume the binary is on `PATH`; we never download servers.

## Architecture (`src/lsp/`)

GTK-free core, talking to editors via the small `LspDocument` interface:

- `position.ts` — `Point`/`Range` ↔ LSP, encoding-aware (utf-8/16/32) + URI helpers.
- `registry.ts` — fetch/cache/parse `languages.toml`; `serverSpecsForPath` resolution;
  user overrides (`lsp.servers`), `lsp.disabledLanguages`, `lsp.configUrl`.
- `LspClient.ts` — transport: spawn + `vscode-jsonrpc` connection + logging/exit events.
- `LanguageServer.ts` — one server per (server, rootDir): lifecycle, capability +
  position-encoding negotiation, full-text document sync, diagnostics, definition.
- `LspManager.ts` — orchestration: root resolution (root markers → `.git` → file dir),
  server reuse, document lifecycle, diagnostics routing, go-to-definition.
- `diagnostics/DiagnosticsStore.ts` — per-path diagnostics + `did-update` events.
- `diagnostics/DiagnosticsView.ts` — per-editor inline squiggles (via the shared
  `DecorationController` `diagnostic-*` styles) + Nerd Font gutter glyphs drawn by a
  `GtkSource.GutterRendererText` (the fold-gutter pattern).
- `diagnostics/DiagnosticsPanel.ts` — the "Diagnostics" list (bottom-dock tab); a thin
  consumer of the shared `ui/LocationList` that maps the store to severity-glyph +
  muted `file:line` + message rows.
- `ui/LocationList.ts` — shared, keyboard-navigable list of file locations (the
  `#LocationList` keymap + `core:*` nav), to be reused by project-wide search and other
  jump-to-location features. Activating a row reveals an already-open editor or opens
  the file (`AppWindow.openOrFocusFile`, also used by go-to-definition).
- `diagnostics/severity.ts` — shared per-severity presentation (Nerd Font glyph +
  color), used by the view and the panel.

Wiring: `quilx.lsp` singleton + `lsp.*` config schema (`quilx.ts`); `TextEditor`
implements `LspDocument` and drives didOpen/didChange/didSave/didClose; `AppWindow`
registers `lsp:go-to-definition` (`space l d`) and `lsp:toggle-diagnostics-panel`
(`space l l`), applies `lsp.*` config (live) + refreshes the catalog on launch, and
routes `LspManager.onNotice` (server start/ready/exit/failure) into the notification
log — trace level for routine events, warning/error for exits/failures.

## Status

- [x] LSP client implementation + server-config abstraction (Helix-sourced).
- [x] Diagnostics: inline squiggles, Nerd Font gutter glyphs, "Diagnostics" panel.
- [x] **Workbench-aware diagnostics + header status** — the manager is already
  multi-root (servers resolved/keyed per project root); the UI surfaces scope to the
  owning workbench. `DiagnosticsStore.paths/countsBySeverity` take an `accept(path)`
  predicate; `ServerStatus` carries `rootDir`. Each workbench's `DiagnosticsPanel`
  shows only its root's files, and the header `WorkbenchStatus` (pill + LSP
  indicator) follows the *active* workbench. Ownership = the open workbench whose
  cwd is the longest prefix of the path/server-root (`AppWindow.ownerWorkbenchCwd`,
  so a nested worktree owns its files, not the parent; orphans → user workbench);
  re-scoped on workbench switch and on a worktree re-root.
- [x] Trace logging of major LSP events to the notification log.
- [x] Navigation: definition / declaration / type-definition / implementation
  (`space l d`/`D`/`t`/`i`), and find-references (`space l r`) presented in a
  `LocationPicker` (`ui/ReferencesPicker.ts`) — a fuzzy-filterable list with a
  source-preview pane, reusing the same picker the workspace-symbol / search
  features use.
- [x] Hover (`space l k` / vim `K`): `textDocument/hover` → markdown rendered to Pango
  (`ui/markdownMarkup.ts`, subset renderer) in a floating overlay card, bottom-aligned
  just above the cursor (an `Gtk.Overlay` child with `valign=END` + margins — no
  height read; GtkPopover was avoided, it froze the UI under node-gtk). Code blocks
  are syntax-highlighted by reusing the editor's tree-sitter grammars + queries +
  theme colors (`syntax/highlightToMarkup.ts`), in the editor monospace font; prose
  stays proportional. 3s request timeout; dismissed on cursor-move/scroll.
  Command-triggered (P1); mouse-hover is a later phase.
- [ ] Code actions.
- [x] **Inlay hints** — `textDocument/inlayHint` (`LanguageServer.inlayHint` +
  `inlayHint` client capability; `LspManager.inlayHints` requests the whole doc,
  normalized to `{line, label}`). Rendered as native **end-of-line annotations** per
  view (`InlayHintController` → `AnnotationController`, debounced on edits), since the
  annotation API is line-anchored (mid-line column placement would need the overlay
  recipe — see [virtual-lines.md](virtual-lines.md)). tsserver inlay prefs enabled in
  the TS plugin. Toggle `editor.inlayHints`.
- [x] **Error lens** — each line's worst diagnostic message trailing the line
  (`DiagnosticsView` → `AnnotationController`, colored by severity). Toggle
  `editor.errorLens`.
- [ ] Later: hover-on-mouse, rename, completion, signature help, incremental sync.

## Notes / gotchas

- Servers must be on `PATH`. On this machine `clangd`/`rust-analyzer` are present;
  `typescript-language-server` is not (a `.ts` file resolves but the spawn fails —
  the manager emits a `failed to start …` log).
- Document sync is full-text (whole buffer per change) for correctness; incremental
  sync is a later optimization.
