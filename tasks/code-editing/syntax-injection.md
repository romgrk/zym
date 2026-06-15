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

## Remaining: vendor the Markdown grammars

The engine and the markdown plugin's grammar registration are wired; only the
binary/query assets are missing. The markdown plugin registers its grammars
**only if these four files exist** (else Markdown stays LSP-only, no tree-sitter),
so dropping them in + restarting lights highlighting up with no code change:

```
src/plugins/markdown/grammars/tree-sitter-markdown.wasm
src/plugins/markdown/grammars/tree-sitter-markdown-inline.wasm
src/plugins/markdown/queries/markdown/highlights.scm
src/plugins/markdown/queries/markdown-inline/highlights.scm
```

### Getting the wasm (two grammars)

Tree-sitter Markdown is a **split grammar** — the source repo
[`tree-sitter-grammars/tree-sitter-markdown`](https://github.com/tree-sitter-grammars/tree-sitter-markdown)
contains two grammars in subdirs: `tree-sitter-markdown/` (block) and
`tree-sitter-markdown-inline/` (inline). Build each to wasm:

```sh
git clone https://github.com/tree-sitter-grammars/tree-sitter-markdown
npm i -g tree-sitter-cli           # a 0.22.x CLI emits ABI ≤14 (loads in web-tree-sitter 0.20.8)
cd tree-sitter-markdown/tree-sitter-markdown        && tree-sitter build --wasm
cd ../tree-sitter-markdown-inline                   && tree-sitter build --wasm
```

`tree-sitter build --wasm` uses a local `emcc` if present, else the official
emscripten Docker image — so Docker (or emscripten) is the only host requirement.
It emits `tree-sitter-markdown.wasm` / `tree-sitter-markdown-inline.wasm`; copy
both into `src/plugins/markdown/grammars/`.

**ABI caveat:** web-tree-sitter is pinned to `0.20.8`, which loads grammar ABI
≤14. A grammar generated by a tree-sitter CLI ≤0.22 emits ABI 14 and loads fine;
a much newer CLI may emit ABI 15 and fail with *"Incompatible language version"*.
If that happens, regenerate with an older CLI (or bump `web-tree-sitter` — a
separate, larger change). Verify a built wasm loads with a throwaway script
(`Parser.Language.load(path)` under web-tree-sitter 0.20.8) before vendoring;
`preloadGrammars` also now skips a grammar that fails to load (warns) rather than
aborting startup, so a bad drop-in degrades gracefully.

### Getting the queries

Vendor `highlights.scm` for both grammars from a project that targets these
grammars — Zed (GPL-3, already quilx's query source) or nvim-treesitter
(Apache-2.0). quilx's highlighter maps capture names with longest-prefix fallback,
so either's capture names work. Put them at the two `queries/…/highlights.scm`
paths above. (The **injections** are declared in TS on the `GrammarDef`, not as an
`injections.scm`, so only `highlights.scm` is needed per grammar.)

## Later

- Recursion is bounded at `MAX_INJECTION_DEPTH`; markdown needs depth 1.
- Combined injections (parse all same-language fences as one tree) — today each
  region parses separately. Fine for correctness; an optimization for huge files.
- A general `injections.scm` loader (in addition to the TS-declared form) if a
  vendored grammar ships one we'd rather use verbatim.
