# Plugin system

Atom-inspired plugin architecture. The goal: everything that makes a language (or
a feature) first-class — grammars, LSP configs, keymaps, commands, config schema,
stylesheets, and later UI — is contributed by a **plugin** rather than wired into
the core, and can be activated/deactivated cleanly at runtime.

The TypeScript support was the first thing extracted: it used to be the in-process
"built-in pack" (`src/lang/builtin.ts`); it is now `src/plugins/typescript/`, the
reference plugin. **Markdown** (`src/plugins/markdown/`) is the second — a language
with an LSP server and a config schema but *no* grammar, showing a plugin can
contribute any subset of the points (see Bundled plugins below).

## Model

A plugin is a **manifest** (`id`, `name`, `description?`, `version?`) plus
lifecycle hooks:

```ts
interface Plugin extends PluginManifest {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
```

`activate(ctx)` registers contributions through the `PluginContext`. Every
`register*` call **returns a Disposable and is tracked on the context**, so
deactivation disposes the whole bag — a plugin rarely manages disposables itself.
This mirrors Atom: `activate()` + a `CompositeDisposable` of subscriptions.

### Contribution points (`PluginContext`)

| Method | Contributes | Backed by |
| --- | --- | --- |
| `ctx.languages.registerLanguage(def)` | file-type detection | `LanguageRegistry` |
| `ctx.languages.registerGrammar(langId, def)` | tree-sitter grammar (wasm + `highlightsPath` + fold types) | `LanguageRegistry` (+ grammar cache) |
| `ctx.languages.registerServer(langId, def)` | an LSP server candidate | `LanguageRegistry` |
| `ctx.registerKeymap(keymap, priority?)` | key bindings (`{ selector: { keystroke: command } }`) | `quilx.keymaps` |
| `ctx.registerCommands(target, commands)` | commands on a `#id`/widget | `quilx.commands` |
| `ctx.registerConfig(schema)` | config-schema entries (full dotted keys) | `quilx.config` |
| `ctx.registerStyles(css)` | a stylesheet | `styles` (StyleManager) |
| `ctx.observeTextEditors(cb)` | per-editor behavior/decorations (`cb(editor)→Disposable?`, run for every open + future editor) | `Workspace` editor registry |
| `ctx.add(disposable)` | escape hatch for anything else | — |
| `ctx.resolve(rel)` | absolute path to a bundled asset | plugin `dir` |

Assets (grammar wasm, `.scm` queries) are resolved against the plugin's own
directory via `ctx.resolve`, so a plugin is self-contained and relocatable. A
grammar's wasm may be an absolute path or a `node_modules` module specifier
(`tree-sitter-wasms/out/…`).

**`observeTextEditors`** is the per-editor decoration seam (Atom's
`atom.workspace.observeTextEditors`): the callback runs for every editor already
open and each one opened later, and the Disposable it returns is torn down when
that editor closes *or* the plugin deactivates. Backed by an editor registry on
`Workspace` (`quilx.workspace.addTextEditor`/`observeTextEditors`); the AppWindow
registers/deregisters each file editor over its tab lifecycle. The editor it hands
back exposes `editor.decorations` (the `DecorationController` tag surface, now with
a `layer.tint(range, {background, foreground})` for arbitrary colors) and
`editor.model` (the `EditorModel`: `scan`, `onDidChangeText`, …). This is the seam
the **color-preview** plugin and the future error-lens / code-lens plugins build on.

### Registry & lifecycle

`PluginRegistry` (the `plugins` singleton, `src/plugin/index.ts`) owns the set of
known plugins and their activation state:

- `register(plugin, dir)` — make a plugin known (inactive).
- `activate(id)` / `deactivate(id)` — idempotent; activation builds a
  `PluginContextImpl`, runs `activate(ctx)`, and remembers the context;
  deactivation runs the plugin's `deactivate?()` then disposes the context.
  Activation **never throws** — a failing plugin is logged and rolled back
  (its partial contributions disposed), so one bad plugin can't block startup.
- `activateAll()` / `deactivateAll()`, `list()` (manifest + `active`), `isActive(id)`.

**Startup order** (`src/index.ts`): `registerBuiltinPlugins()` →
`plugins.activateAll()` → `preloadGrammars()`. Activation must precede the grammar
preload (and any file open) because activation is what *populates* the
`languages` registry the grammar/LSP layers read. The `languages` singleton starts
empty; nothing is registered at import time anymore.

## Why these core changes

To support clean deactivation the contribution registries became
disposable-aware:

- `LanguageRegistry.registerLanguage/Grammar/Server` now return Disposables that
  remove the entry (no-op if it was replaced meanwhile).
- `Config.removeSchema(keyPath)` — inverse of `setSchema`.
- `StyleManager.addRemovable(css)` — queue-or-install (plugins activate *before*
  the Gdk display exists), returning a Disposable that removes the sheet whether
  installed or still queued.
- `grammar.clearGrammar(langId)` — drop a cached parse when a grammar is
  unregistered (a re-register isn't shadowed by a stale parse).
- `GrammarDef.query` (a name resolved against a hardcoded `src/syntax/queries`
  dir) → `GrammarDef.highlightsPath` (an absolute path the plugin owns).

Keymaps and commands already returned Disposables (`quilx.keymaps.add`,
`quilx.commands.add`).

## Files

- `src/plugin/types.ts` — `Plugin`, `PluginManifest`, `PluginContext`, `PluginLanguages`.
- `src/plugin/PluginContext.ts` — `PluginContextImpl` (wraps the singletons, tracks disposables).
- `src/plugin/PluginRegistry.ts` — `PluginRegistry`, `PluginInfo`.
- `src/plugin/index.ts` — the `plugins` singleton + `registerBuiltinPlugins()`.
- `src/plugins/typescript/` — the TypeScript plugin (`index.ts`, `queries/`, `typescript.test.ts`).
- `src/plugins/markdown/` — the Markdown plugin (`index.ts`, `markdown.test.ts`).
- `src/plugins/css/` — the CSS plugin (`index.ts`, `queries/`, vendored `grammars/`,
  `build-grammars.sh`, `css.test.ts`, `grammar.test.ts`).
- `src/plugins/json/` — the JSON plugin (`index.ts`, `queries/`, `json.test.ts`,
  `grammar.test.ts`).
- `src/plugins/cpp/` — the C / C++ plugin (`index.ts`, `queries/c/`, `queries/cpp/`,
  `cpp.test.ts`, `grammar.test.ts`).
- `src/plugins/color-preview/` — the color-preview plugin (`index.ts` editor wiring +
  `colors.ts` pure parser/contrast, `colors.test.ts`); the `observeTextEditors`
  reference consumer.
- `src/Workspace.ts` — the `observeTextEditors`/`addTextEditor` editor registry the
  seam is backed by (beyond the file-opener it already held).

## Bundled plugins

- **typescript** — TS/JS/TSX detection, tree-sitter grammars (vendored under
  `queries/`), and the flow/tsserver/deno/eslint server candidates. Exercises the
  `languages` surface.
- **markdown** — detection (`.md`/`.markdown`/…), the **marksman** language
  server (single-file; skipped gracefully if not on PATH), and a `markdown.*`
  config schema (authoring preferences, surfaced in the settings UI). Exercises
  `registerConfig` — the surface TypeScript didn't. It contributes **no
  tree-sitter grammar** (the bundled `tree-sitter-wasms` pack ships none for
  Markdown), so Markdown gets LSP features without tree-sitter highlighting until
  a Markdown wasm is vendored — at which point one `registerGrammar` call lights
  it up. A good demonstration that a language plugin can supply any subset of the
  contribution points.
- **css** — CSS/SCSS/Sass detection, tree-sitter grammars, and language servers.
  First plugin to **mix a bundled grammar with a vendored one**: CSS uses the
  bundled `tree-sitter-css.wasm`; SCSS uses `tree-sitter-scss.wasm`, vendored under
  `grammars/` and built by the plugin's own `build-grammars.sh` (the Markdown
  recipe). Sass (indented) is detection + LSP only — no ABI-14 grammar exists for
  it. `vscode-css-language-server` (from `vscode-langservers-extracted`, the eslint
  sibling) serves CSS + SCSS; **SomeSass** serves indented Sass (optional, skipped
  if absent).
- **json** — JSON/JSONC detection, the bundled `tree-sitter-json` grammar
  (highlighting + folding), and `vscode-json-language-server` (the same
  `vscode-langservers-extracted` package as the eslint/css servers). One grammar
  backs both dialects — it parses `//`/block comments as `(comment)` nodes — and a
  single ServerDef serves the `json` / `jsonc` languageIds.
- **cpp** — C/C++ detection and the bundled `tree-sitter-c` / `tree-sitter-cpp`
  grammars (highlighting + folding), with **clangd** as the language server. Two
  grammars (C++ is a superset, so it carries its own queries), `.h` headers map to
  C by convention while `.hpp`/`.hh`/… map to C++, and a single `clangd` ServerDef
  serves the `c` / `cpp` languageIds (single-file; prefers a `compile_commands.json`
  root; skipped gracefully if clangd isn't on PATH, like marksman).
- **color-preview** — the first **`observeTextEditors`** consumer (no language layer at
  all). Background-tints color literals — hex (`#rgb`…`#rrggbbaa`), `rgb()/rgba()`,
  `hsl()/hsla()` — with the color they represent, contrast-picking black/white
  text. Language-agnostic (scans buffer text, so colors light up in CSS, JS, HTML).
  Pure parsing/contrast in `colors.ts` (unit-tested); the editor wiring re-syncs a
  `color-preview` decoration layer on edits (debounced). A clickable swatch / color
  picker is a later focusable-overlay feature; named colors await tree-sitter
  scoping (a bare-word regex would tint identifiers). See
  [code-editing/inline-widgets.md](code-editing/inline-widgets.md).

## What's next

- **UI contributions** — let a plugin register a `Panel`/dock widget and a
  workspace item (the biggest open design question: how a plugin gets a handle to
  the layout without the core importing it).
- **Snippets / menus / palette categories** as first-class contribution points.
- **Out-of-repo plugins** — discovery + loading of npm-style packages with a
  manifest file; enable/disable persisted to config; a plugin-manager UI driven by
  `plugins.list()`.
- **Per-plugin config namespace** — a `ctx.config.scope(id)` convenience and
  settings-UI grouping, instead of full dotted keys.
- **Deactivation on quit** — wire `plugins.deactivateAll()` into shutdown (today
  process exit handles teardown; explicit deactivation matters once plugins hold
  external resources).
