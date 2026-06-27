# Plugin system

Atom-inspired plugin architecture. The goal: everything that makes a
language (or a feature) first-class — grammars, LSP configs, keymaps,
commands, config schema, stylesheets, and later UI — is contributed by a
**plugin** rather than wired into the core, and can be
activated/deactivated cleanly at runtime.

> Writing or editing a plugin? Read the step-by-step guide first:
> [plugin-creation.md](plugin-creation.md). This file is the
> architecture; that one is the recipe.

## Model

A plugin is a **manifest** (`id`, `name`, `description?`, `version?`)
plus lifecycle hooks:

```ts
interface Plugin extends PluginManifest {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
```

`activate(ctx)` registers contributions through the `PluginContext`.
Every `register*` call **returns a Disposable and is tracked on the
context**, so deactivation disposes the whole bag — a plugin rarely
manages disposables itself. This mirrors Atom: `activate()` + a
`CompositeDisposable` of subscriptions.

### Contribution points (`PluginContext`)

| Method | Contributes | Backed by |
| --- | --- | --- |
| `ctx.languages.registerLanguage(def)` | file-type detection | `LanguageRegistry` |
| `ctx.languages.registerGrammar(langId, def)` | tree-sitter grammar (wasm + `highlightsPath` + fold types) | `LanguageRegistry` (+ grammar cache) |
| `ctx.languages.registerServer(langId, def)` | an LSP server candidate | `LanguageRegistry` |
| `ctx.registerKeymap(keymap, priority?)` | key bindings (`{ selector: { keystroke: command } }`) | `zym.keymaps` |
| `ctx.registerCommands(target, commands)` | commands on a `#id`/widget | `zym.commands` |
| `ctx.registerConfig(schema)` | config-schema entries (full dotted keys) | `zym.config` |
| `ctx.registerStyles(css)` | a stylesheet | `styles` (StyleManager) |
| `ctx.observeTextEditors(cb)` | per-editor behavior/decorations (`cb(editor)→Disposable?`, run for every open + future editor) | `Workspace` editor registry |
| `ctx.add(disposable)` | escape hatch for anything else | — |
| `ctx.resolve(rel)` | absolute path to a bundled asset | plugin `dir` |

Assets (grammar wasm, `.scm` queries) are resolved against the plugin's
own directory via `ctx.resolve`, so a plugin is self-contained and
relocatable. A grammar's wasm may be an absolute path or a
`node_modules` module specifier (`tree-sitter-wasms/out/…`).

**`observeTextEditors`** is the per-editor decoration seam (Atom's
`atom.workspace.observeTextEditors`): the callback runs for every editor
already open and each one opened later, and the Disposable it returns is
torn down when that editor closes *or* the plugin deactivates. Backed by
an editor registry on `Workspace`
(`zym.workspace.addTextEditor`/`observeTextEditors`); the AppWindow
registers/deregisters each file editor over its tab lifecycle. The
editor it hands back exposes `editor.decorations` (the `TextDecorations`
tag surface, with a `layer.tint(range, {background, foreground?,
wholeLine?})` for arbitrary colors) and `editor.model` (the
`EditorModel`: `scan`, `onDidChangeText`, …); for inline widgets it
exposes `BlockDecorations` (used by Markdown's image preview). This is
the seam the **color-preview** and **markdown image-preview** plugins
build on, and the one future error-lens / code-lens plugins will use.

### Registry & lifecycle

`PluginRegistry` (the `plugins` singleton, `src/plugin/index.ts`) owns
the set of known plugins and their activation state:

- `register(plugin, dir)` — make a plugin known (inactive).
- `activate(id)` / `deactivate(id)` — idempotent; activation builds a
  `PluginContextImpl`, runs `activate(ctx)`, and remembers the context;
  deactivation runs the plugin's `deactivate?()` then disposes the
  context. Activation **never throws** — a failing plugin is logged and
  rolled back (its partial contributions disposed), so one bad plugin
  can't block startup.
- `activateAll()` / `deactivateAll()`, `list()` (manifest + `active`),
  `isActive(id)`.

**Startup order** (`src/index.ts`): `registerBuiltinPlugins()` →
`plugins.activateAll()` → `preloadGrammars()`. Activation must precede
the grammar preload (and any file open) because activation is what
*populates* the `languages` registry the grammar/LSP layers read. The
`languages` singleton starts empty; nothing is registered at import
time.

## Design decisions

Clean deactivation requires the contribution registries to be
disposable-aware:

- `LanguageRegistry.registerLanguage/Grammar/Server` return Disposables
  that remove the entry (no-op if it was replaced meanwhile).
- `Config.removeSchema(keyPath)` is the inverse of `setSchema`.
- `StyleManager.addRemovable(css)` queues-or-installs (plugins activate
  *before* the Gdk display exists), returning a Disposable that removes
  the sheet whether installed or still queued.
- `grammar.clearGrammar(langId)` drops a cached parse when a grammar is
  unregistered, so a re-register isn't shadowed by a stale parse.
- A grammar owns its highlights file: `GrammarDef.highlightsPath` is an
  absolute path the plugin resolves itself.

Keymaps and commands are already disposable-returning
(`zym.keymaps.add`, `zym.commands.add`).

## Bundled plugins

`registerBuiltinPlugins()` in `src/plugin/index.ts` registers all
bundled plugins:

- **typescript** (`plugins/typescript/`) — TS/JS/TSX detection,
  tree-sitter grammars (queries vendored under `queries/`,
  `GrammarDef.highlightsPath`), and the flow/tsserver/deno/eslint server
  candidates.
- **html** (`plugins/html/`) — detection (`.html`/`.htm`/`.xhtml`), the
  bundled `tree-sitter-html` grammar (highlights + folds,
  palette-adapted), and `vscode-html-language-server` (single-file).
  Exercises *cross-plugin injections*: `<script>` → a CSS grammar this
  plugin vendors injection-only, and `<script>` → the TypeScript
  plugin's tsx grammar (`js`), each a no-op if its guest grammar isn't
  registered.
- **markdown** — config + vendored block/inline grammars + image
  preview.
- **css** — CSS/SCSS/Sass; bundled + vendored grammars.
- **json** — JSON/JSONC.
- **cpp** — C/C++; clangd.
- **rust** — rust-analyzer.
- **python** — pyright/pylsp/ruff.
- **bash** — shell; bash-language-server.
- **color-preview** — the `observeTextEditors` reference consumer (no
  language layer).

## Files

- Plugin managing code is at `src/plugin`
- Default bundled plugins are at `plugins`

## Remaining / planned

- **UI contributions** — let a plugin register a `Panel`/dock widget and
  a workspace item. The biggest open design question: how a plugin gets
  a handle to the layout without the core importing it.
- **Snippets / menus / palette categories** as first-class contribution
  points.
- **Out-of-repo plugins** — discovery + loading of npm-style packages
  with a manifest file; enable/disable persisted to config; a
  plugin-manager UI driven by `plugins.list()`.
- **Per-plugin config namespace** — a `ctx.config.scope(id)` convenience
  and settings-UI grouping, instead of full dotted keys.
- **Deactivation on quit** — wire `plugins.deactivateAll()` into
  shutdown (today process exit handles teardown; explicit deactivation
  matters once plugins hold external resources).
