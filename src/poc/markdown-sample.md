# Markdown rendering fixture

This first paragraph mixes **bold**, __also bold__, *italic*, `inline code`, and a [link](https://example.com) all in one sentence so the inline spans can be eyeballed together.

This is a deliberately long single-line paragraph with no hard wraps so that wrapping behaviour and the conversation column's maximum width can be judged at a glance; it rambles on past the point of usefulness purely so the renderer has to break it across several lines, and then it keeps going a little further still to be sure the measure is comfortable rather than cramped or absurdly wide.

## Unordered list with nesting

- First top-level item with a trailing `code span`
- Second item, which owns a nested unordered sub-list:
    - Nested bullet one
    - Nested bullet two
- Third item, which owns a nested ordered sub-list:
    1. Nested step one
    2. Nested step two

### Ordered list

1. First step with `inline code` and **bold** together
2. Second step that references a `--flag` and **another bold** run
3. Third step linking to the [docs](https://example.com/docs)

> A blockquote, first paragraph. It should read as visually set apart from the
> surrounding prose without being hard to read.
>
> Second blockquote paragraph, which itself contains a list:
> - quoted bullet one
> - quoted bullet two

---

#### TypeScript code block

```ts
export function describe(node: Node): string {
  // The next line is intentionally over 120 columns to test horizontal overflow handling inside a capped conversation column width.
  const summary = `${node.kind} at ${node.start}:${node.end} — ${node.children.length} children, depth ${depth(node)}, label ${JSON.stringify(node.label)}`;
  return summary.trim();
}
```

#### Bash code block

```bash
rg -n "MarkdownView" src/ui
fd -e ts markdown src | head
git status --short
```

#### Plain (no language) code block

```
just plain preformatted text
  with some   indentation
  and no syntax highlighting
```

##### Heading level five

A short paragraph beneath an H5 to check the smaller heading size and the gap above it.

###### Heading level six

A short paragraph beneath an H6, the smallest heading the renderer supports.

## Table with mixed alignment

| Left | Center | Right | Notes |
|:-----|:------:|------:|:------|
| a | b | 1 | short |
| alpha | beta | 1000 | a deliberately long cell so the table is wider than the prose text column and exercises horizontal layout |
| x | y | 42 | mid |
| last | row | 7 | end |

A short closing paragraph mixing **bold**, *italic*, `inline code`, and a final [link](https://example.com) so the inline styles are seen once more after all the block constructs above.
