# Creating a plugin

A practical, step-by-step guide for adding a new plugin. For the *why* (the
model, contribution points, registry/lifecycle, the disposable-teardown
design) read [plugins.md](plugins.md) first — this page is the recipe, that
page is the architecture.

A plugin contributes any **subset** of the contribution points; you only do
the steps your plugin needs. The most common kind is a **language plugin**
(detection + grammar + LSP), so that's the spine of this guide, with the other
points at the end.

## 1. Pick an id and create the directory

`plugins/<id>/` with an `index.ts`. The `id` is stable and unique (e.g.
`rust`), and doubles as the keymap/style source key. Filenames are camelCase;
the plugin's main export is the manifest object (`<id>Plugin`).

Pick the closest existing plugin as a template:
- **Language with a bundled grammar + standalone LSP** → `plugins/rust/`
  (simplest).
- **Two grammars / one server for both** → `plugins/cpp/` (C + C++).
- **Vendored (non-bundled) grammar** → `plugins/css/` (has
  `build-grammars.sh`).
- **Config-schema contribution** → `plugins/markdown/`.
- **Editor decorations, no language layer** → `plugins/color-preview/`
  (`observeTextEditors`).

## 2. Write `index.ts`

Export a `Plugin` (`src/plugin/types.ts`): manifest fields plus
`activate(ctx)`. Register everything through `ctx`; each `register*` is
disposable-tracked, so `deactivate` is rarely needed.

```ts
import type { Plugin, PluginContext, ServerDef } from 'zym/plugin-api';

export const fooPlugin: Plugin = {
  id: 'foo',
  name: 'Foo',
  description: 'Foo: tree-sitter grammar (highlighting + folding) and the foo LSP.',
  activate(ctx: PluginContext) {
    const { languages } = ctx;
    languages.registerLanguage({ id: 'foo', fileTypes: ['foo'] });       // detection
    languages.registerGrammar('foo', {
      wasm: 'tree-sitter-wasms/out/tree-sitter-foo.wasm',                // or ctx.resolve('grammars/…')
      highlightsPath: ctx.resolve('queries/foo/highlights.scm'),
      foldsPath: ctx.resolve('queries/foo/folds.scm'),
      foldTypes: ['block', '…'],                                         // fallback if folds.scm is missing
    });
    languages.registerServer('foo', FOO_SERVER);
  },
};
```

Notes:
- Set `lspId` on the language only when the file extension's LSP `languageId`
  differs from the language `id` (e.g. `.tsx` → `typescriptreact`).
  `rust`/`c`/`cpp` are already valid LSP ids, so no override.
- A `ServerDef` with no `install` spec is fine for a standalone binary
  (rust-analyzer, clangd) — it's simply skipped, not crash-looped, when absent
  from PATH. Use `roots` for workspace-root markers, `singleFile: true` to let
  it activate on a loose file. See `plugins/cpp/index.ts` and
  [text-editor/language-config.md](text-editor/language-config.md).

## 3. Vendor the grammar assets

Assets live under the plugin dir and are resolved with `ctx.resolve` (so the
plugin is relocatable). For a tree-sitter grammar:

- **wasm** — prefer the bundled `tree-sitter-wasms` pack (module specifier
  `tree-sitter-wasms/out/tree-sitter-<lang>.wasm`). If the pack ships none,
  vendor one under `grammars/` and build it with a `build-grammars.sh` (copy
  the css/ recipe; `tree-sitter build --wasm` uses wasi-sdk, web-tree-sitter
  0.20.x needs ABI ≤14 — don't regenerate `parser.c` with a 0.25+ CLI).
- **queries** — `queries/<lang>/highlights.scm` and `queries/<lang>/folds.scm`.
  Adapt from the grammar's upstream `highlights.scm` to zym's capture palette
  (compare against an existing plugin's queries; the `grammar.test.ts` asserts
  the core captures exist).

### Fold queries — ship keep-footer for chained constructs

The fold style is grammar-declared in `folds.scm`
([text-editor/folding.md](text-editor/folding.md)):
- `@fold` — **join** (default): the footer joins the header onto one line.
- `@fold.keepFooter` — **keep-footer**: the closing line that *continues* a
  chain (`} else {`, `} else if … {`, `} catch (…) {`) stays on its own line.

A brace-delimited language with chained constructs should ship
`@fold.keepFooter` so those chains read well folded (TS/TSX, Rust, and C/C++
all do). It's a query-only change — `src/syntax/folds.ts` consumes the capture
name generically (a node can match both `@fold` and `@fold.keepFooter`;
keep-footer wins per start row). The pattern: capture the **consequence/body
block** of the construct that has a continuation. The TypeScript plugin is the
reference (`plugins/typescript/queries/typescript/folds.scm`):

```scm
(if_statement
  consequence: (statement_block) @fold.keepFooter
  alternative: (_))
(try_statement body: (statement_block) @fold.keepFooter handler: (catch_clause))
```

The final `else`/`catch` block (no continuation) folds via the plain `@fold`.
Verify the exact node/field names against the real grammar (parse a snippet and
print `tree.rootNode.toString()`) — they drift between grammars (Rust:
`if_expression` / `block`; C/C++: `if_statement` / `compound_statement`; TS:
`if_statement` / `statement_block`). Indentation-based languages (Python) have
no continuation line, so keep-footer doesn't apply.

## 4. Register the plugin

Add it to `registerBuiltinPlugins()` in `src/plugin/index.ts` (import + a
`plugins.register(fooPlugin, Path.join(BUILTINS_DIR, 'foo'))` line). This runs
at startup (`src/index.ts`) before grammars preload, so the registry is
populated before anything reads it.

## 5. Tests

Two files, both hermetic (mirror an existing plugin):

- `<id>.test.ts` — activate the plugin against a throwaway `LanguageRegistry`
  via a partial `PluginContext` (so the global singleton isn't touched) and
  assert the contributions: detection (`languageForPath`), `lspLanguageId`,
  server activation at/without a root, grammar registered. See
  `plugins/rust/rust.test.ts`.
- `grammar.test.ts` — load the real wasm in the pinned web-tree-sitter, assert
  the highlight/fold queries **compile** (catches node-name drift) and that a
  sample produces the expected captures (including `fold`; add
  `fold.keepFooter` if the grammar ships it). See `plugins/rust/grammar.test.ts`.

Run: `node --test 'plugins/<id>/**/*.test.ts'` (the glob form — passing a bare
directory makes `node --test` try to run it as an entry file and fail with
`MODULE_NOT_FOUND`).

## 6. Other contribution points

Beyond the language surface, `ctx` also offers (see `src/plugin/types.ts`):
- `registerKeymap(keymap, priority?)` / `registerCommands(target, commands)` —
  keys and commands.
- `registerConfig(schema)` — config-schema entries (full dotted keys); see the
  markdown plugin.
- `registerStyles(css)` — a stylesheet, removed on deactivation.
- `observeTextEditors(cb)` — the per-editor decoration seam (runs for every
  open and future editor; return a Disposable torn down on close). See
  color-preview.
- `ctx.add(disposable)` — escape hatch for anything else.

## 7. Document it

Add a bullet to **Bundled plugins** in [plugins.md](plugins.md) and update the
status list in [index.md](index.md) (the *Plugin system* section).

## Checklist

- [ ] `plugins/<id>/package.json` with `name: "@zym/plugin-<id>"`, `version`, `main`, `peerDependencies: { zym: "^0.1.0" }`.
- [ ] `plugins/<id>/index.ts` exports `<id>Plugin` (`Plugin`); imports from `zym/plugin-api`.
- [ ] Language: `registerLanguage` (+ `lspId` if it differs), `registerGrammar`,
      `registerServer`.
- [ ] Assets under the plugin dir, referenced via `ctx.resolve`.
- [ ] `folds.scm` ships `@fold` (and `@fold.keepFooter` for chained brace constructs).
- [ ] Registered in `registerBuiltinPlugins()` (`src/plugin/index.ts`).
- [ ] `<id>.test.ts` + `grammar.test.ts` (queries compile, expected captures) pass.
- [ ] Documented in plugins.md + index.md.
