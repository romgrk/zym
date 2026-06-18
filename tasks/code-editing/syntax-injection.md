# Syntax injection (embedded languages)

Tree-sitter **language injection**: highlighting a region of one grammar's tree
with another grammar. The motivating case is Markdown — fenced code blocks
(```` ```ts ````) highlit by the code's grammar, and inline spans (emphasis,
links, code) highlit by the `markdown-inline` grammar — but the engine is
general (it also covers JS/CSS-in-HTML, code-in-JSDoc, etc. once those grammars
ship).

## Engine (done)

The highlighter (`src/syntax/syntax-controller.ts`) gathers captures from the
base grammar **and** every injected layer into one flat list, then paints with
the existing sweep — *innermost capture wins, later index breaks ties*. Because
injected captures are gathered after the base (higher index) and are narrower
than the host region containing them, they paint over it for free; no tag-priority
juggling.

Data flow per refresh (`collectCaptures` → `paintCaptures`):

1. Parse the buffer with the base grammar (incremental, as before).
2. `collectCaptures(grammar, root, text, out, depth)`:
   - push the base grammar's highlight captures (flattened to primitives — see below);
   - for each of the grammar's **injections**, run the injection query over the
     tree; for each match resolve the guest grammar and parse just the `@content`
     range with it (`parser.parse(text, undefined, { includedRanges: [range] })`,
     so positions stay absolute), then recurse (bounded by `MAX_INJECTION_DEPTH`).
3. `paintCaptures` flattens the merged captures into non-overlapping runs and
   applies one tag per run.

Key decisions:

- **Captures are flattened to `RawCapture` primitives** at gather time, so each
  injected tree can be `delete()`d immediately (its `SyntaxNode`s would otherwise
  dangle once the wasm tree is freed). Injected trees are transient — never kept
  for incremental reparse; they're cheap and the host reparse is what's debounced.
- **`includedRanges`** (a `parse` option in web-tree-sitter 0.20.x) is used
  instead of substring-parsing, so guest captures carry absolute document
  coordinates — no offset math.
- **Guest parsers are cached** per grammar (`injectionParsers`), recreated when
  the document language changes (`resetTree`).
- **Injection language resolution**: the guest name is a captured `@language`
  node's text, else the injection's static `language`. `collectCaptures` resolves
  it to a loaded grammar via `grammarForName` (`grammar.ts`), which calls the pure,
  unit-tested `resolveGuestLangId` (also `grammar.ts`). The name resolves through
  the **shared `LanguageRegistry`** — as a langId, an alias→extension
  (```` ```typescript ```` → `ts` → the TS grammar), or an injection-only langId
  (`markdown-inline`). So a fenced block uses whatever plugin contributed that
  language's grammar — cross-plugin injection.

(`#set!` query directives aren't exposed by web-tree-sitter 0.20.x, which is why
the guest language comes from a captured `@language` node or the static `language`
field, never a directive.)

### Contribution shape

A grammar declares injections in its `GrammarDef` (`src/lang/types.ts`):

```ts
injections: [
  { query: '((inline) @content)', language: 'markdown-inline' },           // static guest
  { query: '(fenced_code_block (info_string (language) @language) (code_fence_content) @content)' }, // dynamic guest
]
```

`@content` (or `@injection.content`) marks the region(s); `@language` (or
`@injection.language`) names the guest by node text. The Markdown plugin declares
exactly this (`MD_INJECTIONS` in `src/plugins/markdown/index.ts`, registered only
when the grammar assets are present).

## Markdown grammars (done — vendored)

The grammars are built and checked in, so Markdown highlighting (headings, lists,
emphasis, inline + fenced code) works out of the box:

```
src/plugins/markdown/grammars/tree-sitter-markdown.wasm          (block,  ABI 14)
src/plugins/markdown/grammars/tree-sitter-markdown-inline.wasm   (inline, ABI 14)
src/plugins/markdown/queries/markdown/highlights.scm
src/plugins/markdown/queries/markdown-inline/highlights.scm
```

The plugin registers them only if those four files exist (else Markdown stays
LSP-only), so the feature is self-contained. `src/plugins/markdown/grammar.test.ts`
is the end-to-end check: the wasms load, the queries compile, and a ```` ```ts ````
fence resolves to TypeScript captures.

### How the wasm is built (reproducible)

`src/plugins/markdown/build-grammars.sh` (the plugin owns its own build) fetches
`@tree-sitter-grammars/tree-sitter-markdown` (MIT; ships C sources, **no wasm**)
and compiles its committed **ABI-14** `parser.c` for both the block and inline
grammars into the plugin's `grammars/`. The script `tree-sitter build --wasm`
(CLI ≥ 0.24) auto-downloads wasi-sdk into `~/.cache/tree-sitter` — no emscripten,
no Docker.

**ABI:** web-tree-sitter is pinned to `0.20.x`, which loads grammar ABI ≤14. The
build compiles the package's *existing* `parser.c` (already ABI 14) and refuses if
its ABI is > 14; it deliberately does **not** run `tree-sitter generate`, which a
0.25+ CLI would emit as ABI 15 (fails to load: *"Incompatible language version."*).
`preloadGrammars` (`grammar.ts`) skips a grammar that fails to load (warns) rather
than aborting startup, so a bad drop-in degrades gracefully.

### Queries

`queries/markdown*/highlights.scm` are adapted from nvim-treesitter (Apache-2.0)
to quilx's capture-name palette (`@keyword`/`@string`/`@type`/…), so the structural
tokens actually get theme colors. The **injections** are declared in TS on the
`GrammarDef` (not an `injections.scm`), so only `highlights.scm` is needed per
grammar.

### Adding another injectable language

The same recipe vendors any tree-sitter grammar, **owned by that plugin**: give
the plugin a `build-grammars.sh` like Markdown's (or copy its shape), confirm the
`parser.c` is ABI ≤14, build, drop the wasm + a palette-mapped `highlights.scm`
into the plugin, and `registerGrammar`. Fenced code blocks for that language then
light up automatically (the registry resolves the fence name → the new grammar).

## Styled tags (bold / italic / scale / background)

Highlight tags aren't foreground-only any more. A capture can carry font styling
via `theme.syntaxStyle` (`bold`/`italic`/`underline`/`strikethrough`/`scale`/
`background`). Headings are **bold + larger, scaled per level** (h1 1.5, h2 1.2,
h3+ 1.1) via per-level `@markup.heading.1`…`.6` captures; their color inherits
`markup.heading` by `resolveColor`'s longest-prefix fallback. The theme loader
fills these from each `syntax` token's style fields plus built-in `markup.*`
defaults (`theme.ts` `applyMarkupDefaults`), with colors reused from the palette so
they stay theme-consistent. This is what makes Markdown *look* like Markdown — it
benefits every language, Markdown is just the forcing function.

**Stacking (multiple attributes compose).** Styles are split into separate
GtkTextTags — one foreground-color tag per capture, plus shared *decoration* tags
(bold/italic/underline/strikethrough, one per distinct scale, one per distinct
text-background, one per distinct full-line/paragraph background) — applied
additively in `paintCaptures` (`syntax-controller.ts`). The pure `computeStyleRuns`
(`highlightRuns.ts`, unit-tested) flattens overlapping captures into runs, with two
deliberately different rules:

  - **Foreground color**: innermost capture wins *with suppression* — a narrower
    uncolored token shows the default foreground rather than bleeding a broader
    `@function` color (standard tree-sitter behavior). Ties break toward the later
    capture, so injected layers win.
  - **Decorations** layer: background and scale take the innermost capture that
    *has* one (so a code span's background survives under recolored tokens, and a
    heading keeps its scale over inline code inside it); bold/italic/… are additive
    (nested `***bold italic***` is both).

So nested emphasis composes and a fenced/inline code background can sit under
syntax-colored tokens — neither was possible with the old one-tag-per-run sweep.

**`scale` + vertical motion (soft-wrap):** `scale` is the one style attribute that
changes a line's height, so a scaled heading line is taller than the unscaled `##`
markers on it. Vim display-line motion (`j`/`k`, `gj`/`gk`) therefore moves by
**one display row using the view's own layout** — `EditorModel.displayLineMove`
calls `forward_display_line`/`backward_display_line` (wrap-aware) and re-snaps to
the goal-x at the target row's *middle* y (snapping at the exact row top returns
the row above). This is correct under **soft-wrap** (a buffer line can span several
display rows) AND for mixed-height heading lines, where pixel-stepping by the
cursor glyph height would under/overshoot. Soft-wrap itself is on by default
(`editor.softWrap`, wired in `TextEditor.createView`).

## Markdown coverage

The plugin's queries (`queries/markdown*/highlights.scm`) cover: headings
(`@markup.heading.1`…`.6`, bold + per-level scale), **strong**/*emphasis*/~~strikethrough~~
(`@markup.strong`/`.emphasis`/`.strikethrough`), inline code (`@markup.raw`,
text background) and fenced/indented code (`@markup.raw.block`, full-line
`paragraph-background` under the injected token colors), links/images
(`@markup.link[.url]`, underlined),
lists + GFM task checkboxes, block quotes, tables (header + delimiter row), and
inline HTML tags (`@tag`). Front matter has an injection rule ready
(`(minus_metadata) @content` → `yaml`); it lights up once a YAML plugin
contributes a `yaml` grammar (the Markdown plugin deliberately doesn't own YAML).

## Performance: viewport-scoped + incremental

Highlighting is limited to the **visible range** (± `VIEWPORT_MARGIN_LINES`) when
the view is realized, so large files only pay for what's on screen:

- `refresh()` (on edit) reparses incrementally (as before) then calls `repaint()`;
  the scroll handler (debounced) calls `repaint()` with **no** reparse, reusing the
  cached buffer text.
- `repaint()` queries the base grammar over the visible `startPoint`/`endPoint`
  (tree-sitter limits captures to the range) and **skips injections entirely
  off-screen** — the big win for Markdown, which has an `inline` node per paragraph
  but only parses the visible ones.
- Tags are cleared over the previously-painted *line* span before each paint
  (`paintedExtent`), so scrolling can't leave stale highlighting behind.
- Not realized (initial load / headless) → whole buffer, as before.

## Later

- Recursion is bounded at `MAX_INJECTION_DEPTH`; markdown needs depth 1.
- Combined injections (parse all same-language fences as one tree) — today each
  region parses separately. Fine for correctness; a further optimization.
- A general `injections.scm` loader (in addition to the TS-declared form) if a
  vendored grammar ships one we'd rather use verbatim.

## Gotcha: grammar wasm libc imports (markdown "no highlighting" + crash)

Each grammar wasm is an emscripten **side module** that imports its libc from the
web-tree-sitter runtime. The pinned 0.20.x runtime provides the common ctype helpers
(`iswalpha`/`iswalnum`/`iswspace`/…) but not `towlower`/`strcmp`/`__assert_fail`, which
the Markdown scanner's `parse_html_block` needs (case-insensitive HTML-block tag
matching). An unprovided import resolves to `undefined`, so the scanner's first call
throws `Cannot read properties of undefined (reading 'apply')` mid-parse — markdown with
any `<...>` block (e.g. `tasks/styling.md`) opened with **no highlighting**, and editing
it left the tree corrupt so a later incremental `tree.edit` faulted with **memory access
out of bounds** (whole-process crash).

Fix (`src/syntax/grammar.ts` `initOptions`): supply the missing symbols via `Parser.init`
(the side-module linker resolves against them, same model as isw*), keyed by emscripten's
mangled names (`_towlower`/`_strcmp`/`___assert_fail`). `strcmp` needs the wasm heap —
captured by reading `this.HEAPU8` from `locateFile` (emscripten calls it as a method on
the runtime Module). Regression test: `src/syntax/injection.test.ts` (HTML-block markdown
must highlight). To audit a new grammar: `WebAssembly.Module.imports()` on its wasm, then
check each `env` function name against the runtime.
