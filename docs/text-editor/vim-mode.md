# Vim mode

Custom modal editing ported from Atom's vim-mode-plus, driven by zym's
`CommandManager`/`KeymapManager` over an `EditorModel` shim (see
`src/ui/TextEditor/vim/`). It replaces `GtkSource.VimIMContext` and is the
default (no flag).

## What works

- Motions, operators, text-objects, visual mode, registers, marks, counts,
  dot-repeat.
- find-char (`f`/`F`/`t`/`T`/`;`/`,`), case ops (`gU`/`gu`/`g~`), surround
  (`ys`/`ds`/`cs`), indent/outdent/join.
- `gv` reselects the last visual selection; `gb` selects the latest
  changed/yanked region (the `` `[ ``/`` `] `` change marks).
- `]h`/`[h` jump to the next/previous git hunk; `]d`/`[d` to the next/previous
  LSP diagnostic (positions fed from the host via `EditorModel` providers).
- **zym-original `g`-commands** (`vim/zym-commands.ts`): `gf` opens the file named
  under the cursor (resolving against the current file's dir, then the project
  root, then absolute / `~`); `gw` opens a Google search for the word under the
  cursor (normal) or the selection (visual). `gw` rather than `go` because `go`
  stays the occurrence-preset toggle.
- System clipboard integration; register prefix (`"`).
- `/` `?` `n` `N` search via the `SearchBar` (incremental highlight, case/regex,
  replace).
- **Occurrence** — operator-modifier `o`/`O` (`c o p`, `d o p`, `g U o w`;
  subword via `O`) and preset occurrence `g o`/`g O`/`g .` (persistent
  highlighted markers any later operator restricts itself to), via a real
  `OccurrenceManager` over `MarkerLayer` + a `TextDecorations` highlight layer
  (`occurrence.test.ts`).
- **Visual-blockwise (`ctrl-v`) and multiple cursors** — emulated on
  `MarkerLayer` mark pairs surfaced through the array-shaped
  `getCursors()`/`getSelections()`. Entry points: blockwise `ctrl-v`
  (I/A/c/d/yank/paste), occurrence `c o p`, and persistent `ctrl-alt-↑/↓`
  (add cursor above/below; `escape` collapses). Extra-caret rendering
  (reverse-video block tags in normal/visual; host-drawn beam carets in insert);
  multi-cursor operations undo as one step; insert is incrementally replicated
  to every cursor live (`blockwise.test.ts`, `multicursor.test.ts`). Bracket
  auto-pairing consumes the keystroke (suppressing native insert + its
  replication), so `autoPair.ts` applies the pair/type-over/backspace at every
  cursor itself via `EditorModel.applyAutoPairEdit` (`autoPair.test.ts`).
- Polish: `=`/`==` auto-indent (tree-sitter indent source — `syntax/indent.ts` +
  `EditorModel.setIndentSource`), matching-bracket highlight
  (`syntax/bracketMatch.ts`; ignores strings/comments/regex; enclosing pair when
  inside), indent guides (`IndentGuides`, `editor.indentGuides`), tree-sitter
  text objects `ic`/`ac` (class) alongside `if`/`af`/`ia`/`aa`, H/M/L screen
  motions, ctrl-f/b/d/u/e/y scrolling, flash-on-operate.

The 19 vendored vim modules are fully strict-typed `.ts`; `tsc --noEmit` is clean
and all vim tests pass. `vimState.editor` is typed as the real `EditorModel`.

## Won't do

- `:` ex-command line — save/close/open/search are reachable via `space w` /
  `tab:close` / `space o` / the `SearchBar`.

## Remaining / planned

- Caret visuals + `ctrl-alt-arrow` keys need in-app verification (headless can't
  realize the view).
- ~100 `// TODO(vim-ts): tighten` casts remain, each marking an unported host
  feature (search/highlight/persistent-selection managers) or a method the
  vendored code calls that isn't on
  `EditorModel`/`Selection`/`Cursor`/`MarkerLayer` yet (e.g.
  `splitSelectionsIntoLines`, `clipScreenPosition`, `Selection.compare`,
  `insertText({autoIndent})`, marker `{invalidate}` opts, fold/scroll helpers,
  macro record/stop on `KeymapManager`); tighten as those host APIs land.
