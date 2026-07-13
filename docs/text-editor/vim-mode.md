# Vim mode

Custom modal editing ported from Atom's vim-mode-plus, driven by zym's
`CommandManager`/`KeymapManager` over an `EditorModel` shim (see
`src/ui/TextEditor/vim/`). It replaces `GtkSource.VimIMContext` and is the
default (no flag).

For an exhaustive, per-mode table of every bound keystroke (and the notable
standard-vim keys we don't map), see
[vim-keymap-reference.md](../../guide/vim-keymap-reference.md).

## What works

- Motions, operators, text-objects, visual mode, registers, marks, counts,
  dot-repeat.
- find-char (`f`/`F`/`t`/`T`/`;`/`,`), case ops (`gU`/`gu`/`g~`), surround
  (`ys`/`ds`/`cs`), indent/outdent/join.
  - surround `f` = function *call* (text-based, not the tree-sitter `af`/`if`):
    `dsf` `fn(x)`→`x`, `csf` `fn(x)`→`|(x)`, `ysiwf` `x`→`|(x)`.
- **Toggle line comments** (vim-commentary): `g c {motion}`, `g c c` /
  `g c g c` current line, visual `g c`; `ctrl-/` works in any mode (incl.
  insert) via `editor:toggle-line-comments`. Delimiters come from the file's
  language (`comments` on `LanguageDef`, see
  [language-config.md](language-config.md)) through
  `EditorModel.setCommentSpecSource` — the toggle lives in
  `EditorModel.toggleLineCommentsForBufferRows` (line leader at the rows'
  minimum indent; block-pair per-line wrap for CSS/HTML/Markdown; blank rows
  skipped; no spec → no-op).
- `gv` reselects the last visual selection; `gb` selects the latest
  changed/yanked region (the `` `[ ``/`` `] `` change marks).
- `]h`/`[h` jump to the next/previous git hunk; `]d`/`[d` to the next/previous
  LSP diagnostic (positions fed from the host via `EditorModel` providers).
- **Jump list** — one, workspace-wide (`ctrl-o`/`ctrl-i`, vim's cross-buffer
  behavior): `ui/GlobalJumpList.ts` is the single engine. It has two detectors,
  feeding one ring (duplicates collapse):
  1. **Caret distance** — it watches the focused editor's caret directly
     (`TextEditor.onDidChangeCursorPosition`); any far same-file move
     (≥ `vim-mode-plus.jumpListMinLines` rows, default 6, `0` = off) records where
     the caret left. This catches jumps with no per-command wiring — a big motion,
     a mouse click, an in-file `g d`.
  2. **Explicit hints** (`vimState.emitDidRecordJump` → `TextEditor.onDidRecordJump`)
     — for jumps that are semantically jumps but may be *shorter* than the
     threshold, so the distance detector would miss them. Two sources emit: vim
     jump motions (`motion.ts` `moveWithSaveJump`, its `jump = true` motions — `}`,
     `%`, …; operator targets like `d}` never hint), and the host's `*`/`#`/`n`/`N`
     search (`TextEditor.recordSearchJump`, since search is a jump at any distance).

  There is no per-editor jump ring anymore. Entries are plain path+point pairs (so
  they can re-open closed files and drift when lines are inserted above — vim
  tolerates the same for unloaded buffers; no marker tracking).
  `vim-mode-plus:jump-backward`/`-forward` (registered, unbound by default)
  delegate to this engine via a host-injected navigator, so they and
  `workspace:jump-*` stay in lockstep. Deliberately dropped vs classic vim: a jump
  motion under the threshold that neither detector sees (short, unflagged, not a
  search) won't record — but flagged motions and search always hint, so this only
  affects non-flagged short hops.
- **Change list** (`g;`/`g,`) — still a per-editor, marker-backed ring in
  `vim/position-history.ts` (a zym addition — vmp leaned on Atom for this). It's a
  separate concern (edit positions, not jumps), fed on `onDidChangeText`, and
  keeps marker precision so entries track edits.
- **zym-original `g`-commands** (`vim/zym-commands.ts`): `gf` opens the file named
  under the cursor (resolving against the current file's dir, then the project
  root, then absolute / `~`); `gw` opens a Google search for the word under the
  cursor (normal) or the selection (visual). `gw` rather than `go` because `go`
  stays the occurrence-preset toggle.
- System clipboard integration; register prefix (`"`).
- **Sequential paste** — `p`/`P` always perform regular paste (`pp` pastes
  twice). `alt-p` is the separate yank-pop command: after any paste it replaces
  that text with the next yank-history entry, and repeated `alt-p` keeps cycling
  as one undo step. With no preceding paste, `alt-p` starts with a normal paste.
- `/` `?` `n` `N` search via the `SearchBar` (incremental highlight, case/regex,
  replace).
- **Occurrence** — unified with search: `g o` (or the fast `alt-/`) *arms*
  occurrence on the search matches by recoloring the search highlight a distinct
  **purple** (dropping the current-match emphasis); any later operator restricts
  itself to the armed matches (`g o` then `d a p`). A *visible* search wins;
  otherwise arming (re-)seeds the search from the cursor word / selection without
  moving the cursor. Arming creates **no marks** — they're materialised lazily only
  when an operator runs, so `g o` is cheap on large buffers. `ctrl-l` (vim `:noh`)
  drops the highlights — the re-target gesture, since `ctrl-l` then `g o` arms the
  cursor word again. Persistent; disarm with `g o`/`alt-/` again (→ amber search) or
  `escape`. `g .` re-arms the last pattern. The old `o`/`O` operator-modifier
  (`c o p`) is removed. Built on
  `OccurrenceManager` (lazy-armed pattern → `MarkerLayer` on demand) + the host's
  `SearchController` over a `VimState` bridge (`occurrence.test.ts`). See
  [occurrence-search.md](occurrence-search.md).
- **Visual-blockwise (`ctrl-v`) and multiple cursors** — emulated on
  `MarkerLayer` mark pairs surfaced through the array-shaped
  `getCursors()`/`getSelections()`. Entry points: blockwise `ctrl-v`
  (I/A/c/d/yank/paste), armed occurrence `g o`, and persistent `ctrl-alt-↑/↓`
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
