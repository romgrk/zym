# Developer tooling

## Linting (ESLint)

`pnpm run lint` (`eslint .`) — flat config in `eslint.config.js`.

**Purpose: catch real bugs, not style.** Formatting is deferred to a separate
tool; this config enables no stylistic/layout rules.

### Config base

- `@eslint/js` `recommended` + `typescript-eslint` `recommended` (the
  **non**-type-checked preset).
- These presets are logic-only — ESLint moved all formatting rules out to the
  separate `@stylistic` plugin, which we deliberately do **not** add. So "defer
  formatting to another tool" falls out for free; no `eslint-config-prettier`
  needed.
- The presets run without type information. `pnpm run typecheck` (`tsc
  --noEmit`, strict) already does whole-program type analysis, and type-aware
  linting over the generated GIR type surface (353 TS files, `skipLibCheck`) is
  slow. The one exception is `local/no-floating-cleanup` (below), which needs
  type info — so a second config block scoped to `src/**` + `plugins/**` turns
  on the typescript-eslint project service just for it.

### Local rule tuning (in `eslint.config.js`)

- `@typescript-eslint/no-explicit-any: off` — node-gtk's GObject/GIR/vfunc
  bindings are pervasively `any`; flagging it is pure noise.
- `@typescript-eslint/no-unused-vars: warn` with `^_` ignore patterns —
  `_`-prefixed args are intentional placeholders in GObject vfunc/signal
  signatures.
- `no-undef: off` for TS — TypeScript already resolves identifiers.
- `no-empty` stays at the default **error** with no `allowEmptyCatch`: empty
  `catch {}` blocks are not allowed (an intentional one needs an explicit
  comment or a no-op statement).

### `local/no-floating-cleanup` (type-aware)

Vendored from MUI ([mui/mui-public#1538](https://github.com/mui/mui-public/pull/1538))
into `eslint-rules/no-floating-cleanup.js` — the rule is not yet in a published
`@mui/internal-code-infra`. Once it ships, replace the vendored file with the
package import.

Like `@typescript-eslint/no-floating-promises`, but for functions: an expression
statement whose call returns a callable (an `unsubscribe` / cleanup function)
that is discarded is flagged as a likely subscription leak. This is high-value
here — `eventKit` subscriptions (`onDidChange*`, `onTitleChange`, …) return
disposer functions, and dropping them is a documented leak class (see
[lifecycle-and-disposal.md](lifecycle-and-disposal.md)).

- Opt out per call with `void expr` (same convention as no-floating-promises).
- Fluent/builder calls that return `this` are never reported.
- Requires the type-aware block, hence `@typescript-eslint/utils` as a dep.

### Upgrade path

For more type-aware bug rules (`no-floating-promises` itself is the obvious next
one), swap the base `recommended` → `recommendedTypeChecked`; the project
service is already wired up in the type-aware block.

### Intentional inline disables

A handful of deliberate spots carry an inline `// eslint-disable` rather than a
config change: the `\x00` sentinel regex in `src/ui/markdownMarkup.ts`
(`no-control-regex`), the `debugger` statements in `src/util/assert.ts`, the
emscripten-Module `this` capture in `src/syntax/grammar.ts` (`no-this-alias`),
the forward-referenced `leaf` in `src/ui/PanelGroup.ts` (`prefer-const`), and the
ported-but-unwired mouse handlers in `VimState.observeMouse` (vim-mode-plus #830).

### Real leaks this rule caught (now fixed)

`local/no-floating-cleanup` surfaced 7 discarded `eventKit` disposers in
`src/ui/AppWindow.ts` (editor `onTitleChange`/`onModifiedChange`; terminal
`onTitleChange`; agent `onTitleChange`/`onDidChangeStatus`/`onDidChangeWorktree`/
`onDidChangeFiles`). `AppWindow` outlives the editor/agent tabs it subscribes to,
so the discarded disposers — and the closures they pin — survived every tab
close. Fixed by collecting them into per-tab (`tabSubs`) / per-agent
(`agentSubs`) `CompositeDisposable`s disposed in `disposeChild` / `closeAgent`
(see [lifecycle-and-disposal.md](lifecycle-and-disposal.md)). Along the way,
`onTitleChange` was made to return an unsubscribe function (it previously
returned `void`, so the subscription could never be detached).
