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
- **Injection language resolution** (`resolveGuestLangId` in `grammar.ts`, pure +
  unit-tested): a captured `@language` node's text, else the injection's static
  `language`. The name resolves through the **shared `LanguageRegistry`** — as a
  langId, an alias→extension (```` ```typescript ```` → `ts` → the TS grammar), or
  an injection-only langId (`markdown-inline`). So a fenced block uses whatever
  plugin contributed that language's grammar — cross-plugin injection.

`#set!` query directives are **not** exposed by web-tree-sitter 0.20.x, so the
guest language comes from a captured `@language` node or the injection's static
`language` field — never a `#set!` directive.

### Contribution shape

A grammar declares injections in its `GrammarDef` (`src/lang/types.ts`):

```ts
injections: [
  { query: '((inline) @content)', language: 'markdown-inline' },           // static guest
  { query: '(fenced_code_block (info_string (language) @language) (code_fence_content) @content)' }, // dynamic guest
]
```

`@content` (or `@injection.content`) marks the region(s); `@language` (or
`@injection.language`) names the guest by node text. The markdown plugin already
declares exactly this (gated on the grammar assets being present).

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
grammars into the plugin's `grammars/`.

The key enabler: `tree-sitter build --wasm` (CLI ≥ 0.24) **auto-downloads
wasi-sdk** into `~/.cache/tree-sitter` and compiles with that — **no emscripten,
no Docker**. (Older guidance that it needs `emcc`/Docker is out of date.)

**ABI:** web-tree-sitter is pinned to `0.20.x`, which loads grammar ABI ≤14. We
compile the package's *existing* `parser.c` (already ABI 14) and deliberately do
**not** run `tree-sitter generate` — a 0.25+ CLI would regenerate it as ABI 15,
which fails to load with *"Incompatible language version."* `preloadGrammars` also
skips a grammar that fails to load (warns) rather than aborting startup, so a bad
drop-in degrades gracefully.

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
`background`), applied alongside its color when `SyntaxController` builds the tag
(`tagProps`). Headings are **bold + larger, scaled per level** (h1 1.5, h2 1.2,
h3+ 1.1) via per-level `@markup.heading.1`…`.6` captures; their color inherits
`markup.heading` by `resolveColor`'s longest-prefix fallback. The theme adapter
fills these from Zed's `font_weight`/`font_style` plus built-in `markup.*` defaults
(`theme.ts` `applyMarkupDefaults`), with colors reused from the loaded palette so
they stay theme-consistent. This is what makes Markdown *look* like Markdown — it
benefits every language, Markdown is just the forcing function. (One-winner-per-run
still holds: nested styles don't combine — the innermost capture's tag wins; an
acceptable edge case.)

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
(`@markup.strong`/`.emphasis`/`.strikethrough`), inline + fenced code
(`@markup.raw`, background), links/images (`@markup.link[.url]`, underlined),
lists + GFM task checkboxes, block quotes, tables (header + delimiter row), and
inline HTML tags (`@tag`). Front matter has an injection rule ready
(`(minus_metadata) @content` → `yaml`); it lights up once a YAML plugin
contributes a `yaml` grammar (the Markdown plugin deliberately doesn't own YAML).

## Later

- Recursion is bounded at `MAX_INJECTION_DEPTH`; markdown needs depth 1.
- Combined injections (parse all same-language fences as one tree) — today each
  region parses separately. Fine for correctness; an optimization for huge files.
- A general `injections.scm` loader (in addition to the TS-declared form) if a
  vendored grammar ships one we'd rather use verbatim.
