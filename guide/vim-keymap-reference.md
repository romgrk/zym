# Vim keymap reference (audit)

An exhaustive list of every vim-mode keystroke zym binds today, the operation /
command behind it, and the mode(s) it's active in — plus a **gaps** section for
notable standard-vim keys we *don't* map. This is the audit companion to
[vim-mode.md](../docs/text-editor/vim-mode.md); the keymap data itself lives in
`src/ui/TextEditor/vim/index.ts` (vim layer) with a few editor-level keys in
`src/ui/TextEditor/TextEditor.ts` and app/diff overrides in
`src/keymaps/default.ts`.

Keystrokes are written in the canonical form (see
[commands-keymaps.md](../docs/commands-keymaps.md)): lowercase, presses
space-separated, so `g g` is the two-press `gg` and `ctrl-v` is one chord.

## Modes & scopes

| Mode | CSS scope | Notes |
|---|---|---|
| normal | `.TextEditor.normal-mode` | mode-entry keys live here only |
| operator-pending | `.TextEditor.operator-pending-mode` | text objects + search-as-motion |
| visual (char/line/block) | `.TextEditor.visual-mode` | + blockwise `ctrl-v` submode |
| insert | `.TextEditor.insert-mode` | only the ctrl-w/u/r/a edit keys are vim |
| (motions/operators) | `.TextEditor:not(.insert-mode)` | shared by normal + op-pending + visual |

`space` is the global leader and is **deliberately never bound** by the vim layer.
`escape` returns to normal mode from every non-normal mode.

## Mode entry (normal only)

| Key | Operation | Action |
|---|---|---|
| `i` | ActivateInsertMode | insert before cursor |
| `a` | InsertAfter | insert after cursor |
| `o` | InsertBelowWithNewline | open line below |
| `O` | InsertAboveWithNewline | open line above |
| `I` | InsertAtFirstCharacterOfLine | insert at first non-blank |
| `A` | InsertAfterEndOfLine | insert at end of line |
| `g I` | InsertAtBeginningOfLine | insert at column 1 (vim `gI`) |
| `g i` | InsertAtLastInsert | resume insert at the last insert position (`^` mark) |
| `R` | ActivateReplaceMode | overwrite/replace mode |
| `v` / `V` / `ctrl-v` | Activate{Characterwise,Linewise,Blockwise}VisualMode | enter visual (also from visual to switch wise) |

## Motions (normal + operator-pending + visual)

| Key | Operation | Action |
|---|---|---|
| `h` `l` `j` `k` | MoveLeft/Right/Down/Up | `j`/`k` are **display-line** in normal+visual, **buffer-line** in op-pending (so `dj` is linewise) |
| `w` `b` `e` | MoveToNext/PreviousSubword, MoveToEndOfSubword | **subword** (camelCase/snake aware) by default |
| `W` `B` `E` | …WholeWord | whole-word variants |
| `g e` / `g E` | MoveToPreviousEndOfSubword / …WholeWord | backward end-of-word |
| `0` | count-or-line-start | extends a pending count (`10j`), else beginning of line |
| `^` / `$` | MoveToFirst/LastCharacterOfLine | |
| `-` / `+` | MoveToFirstCharacterOfLineUp/Down | first non-blank, prev/next line |
| `g _` | MoveToLastNonblankCharacterOfLineAndDown | |
| `g g` / `G` | MoveToFirstLine / MoveToLastLine | |
| `{` / `}` | MoveToPrevious/NextParagraph | |
| `(` / `)` | MoveToPrevious/NextSentence | |
| `%` | MoveToPair | matching bracket |
| `|` | MoveToColumn | |
| `g j` / `g k` | MoveDown/UpDisplayLine | explicit display-line |
| `g 0` / `g ^` / `g $` | MoveToBeginning/FirstCharacter/LastCharacterOfScreenLine | display-line BOL / first-non-blank / EOL (differ from `0`/`^`/`$` only under soft-wrap) |
| `] m` / `[ m` | MoveToNext/PreviousFunction | next/prev function start (tree-sitter); also an operator target (`d ] m`) |
| `H` `M` `L` | MoveToTop/Middle/BottomOfScreen | screen-relative |
| `f` `F` `t` `T` | Find / FindBackwards / Till / TillBackwards | reads one char (`requireInput`) |
| `;` / `,` | repeat-find-or-start-leap / repeat-find-reverse | `;` repeats find, or starts a leap if last cmd wasn't a find |
| `g s` / `g S` | Leap / LeapBackwards | leap.nvim two-char labeled jump |
| `z j` / `z k` | MoveToNextFoldStart / MoveToPreviousFoldEnd | |
| `[ z` / `] z` | MoveToPreviousFoldStart / MoveToNextFoldEnd | |
| `[ h` / `] h` | MoveToPrevious/NextHunk | git hunks |
| `[ d` / `] d` | MoveToPrevious/NextDiagnostic | LSP diagnostics |
| `g n` / `g N` | SearchMatchForward/Backward | also a text object (`c g n`) |

## Search (motion + editor SearchBar)

| Key | Command | Mode | Action |
|---|---|---|---|
| `/` `?` | editor:search-forward/backward | normal | open the SearchBar |
| `/` `?` | Search / SearchBackwards | op-pending, visual | search-as-motion (`d/foo`, `v?bar`) |
| `n` / `N` | editor:search-next/previous | normal | next/prev match (SearchBar) |
| `*` / `#` | editor:search-word-forward/backward | normal | word under cursor (whole-word) |
| `g /` / `g #` ... | editor:search-word-*[-loose] | normal | `g /`=`*`; `g *`/`g #` are substring (loose) |
| `ctrl-l` | clear-search-highlight | normal | vim `:noh` — drop highlights, disarm occurrence |

Inside the bar: `enter` / `shift-enter` step to the next/previous match; in the
replace field, `enter` replaces the current match and `ctrl-enter` replaces all
(a notification reports the count). `alt-s` cycles the case mode, `alt-r`
toggles regex, `ctrl-p` / `ctrl-n` recall the search history, `esc` cancels.

## Operators (await a target in normal; act on selection in visual)

| Key | Operation | Action |
|---|---|---|
| `d` `y` `c` | Delete / Yank / Change | |
| `>` `<` `=` | Indent / Outdent / AutoIndent | `>>`/`<<`/`==` via same-key repeat |
| `g U` `g u` `g ~` | UpperCase / LowerCase / ToggleCase | case operators |
| `g c` | ToggleLineComments | toggle line comments (vim-commentary): `g c {motion}`, `g c g c` same-key repeat, visual `g c`; delimiters from the file's language |
| `s` | ReplaceWithRegister | `s{motion}` replace with register; `ss` line |
| `y s` / `d s` / `c s` | Surround / DeleteSurround / ChangeSurround | vim-surround; the target/replacement char is read as input. Pairs `( ) [ ] { } < >`, aliases `b`=`()` `r`=`[]` `k`=`{}` `a`=`<>` (`pairsByAlias`), quotes `" ' \``, tags `t`, plus `f` = function **call** (text-based: `dsf` `fn(x)`→`x`, `csf`/`ysiwf` wrap a call) |

### Shortcut operators (preset target — run immediately)

| Key | Operation | Action |
|---|---|---|
| `x` / `X` | DeleteRight / DeleteLeft | delete char right/left |
| `p` / `P` | PutAfter / PutBefore | paste after/before |
| `alt-p` | SequentialPaste | replace the last paste with the next yank-history entry; repeat to keep cycling |
| `r` | ReplaceCharacter | replace `count` chars |
| `~` | ToggleCaseAndMoveRight | |
| `S` | ReplaceLineWithRegister | replace whole line (= `ss`) |
| `C` / `D` | ChangeToLastCharacterOfLine / DeleteToLastCharacterOfLine | to end of line |
| `Y` | YankLine | yank line |
| `J` | Join | join lines |
| `ctrl-j` | SplitLine | split line at cursor (inverse of `J`, normal only) |
| `g c c` | ToggleLineCommentsCurrentLine | toggle the current line's comment (vim-commentary `gcc`) |
| `y d` / `y u` | editor:duplicate-line-below/above | duplicate line down/up (editor, normal) |
| `ctrl-/` | editor:toggle-line-comments | toggle line comments (any mode, incl. insert) |

## Text objects (operator-pending + visual)

`i` = inner, `a` = around. Every entry below has both an `i …` and `a …` form.

| Object | Operation base | Notes |
|---|---|---|
| `w` / `W` | InnerWord / AWord, Inner/AWholeWord | subword vs whole-word |
| `p` | Inner/AParagraph | |
| `s` | Inner/ASentence | |
| `t` | Inner/ATag | HTML/XML tag |
| `a` | Inner/AArguments | targets.vim arguments |
| `i` | Indentation | `i i` and `a i` are identical (incl. blank lines) |
| `h` / `l` | Inner/ALhs, Inner/ARhs | LHS/RHS of `=`/`:`/`->` assignment |
| `e` | Inner/AEntire | whole buffer |
| `z` | Inner/AFold | fold region at cursor |
| `f` | Inner/AFunction | tree-sitter |
| `c` | Inner/AClass | tree-sitter (class/interface/enum) |
| `(` `)` `b` | …ParenthesisAllowForwarding | seeks forward to next pair on line |
| `[` `]` `r` | …SquareBracketAllowForwarding | `r` = home-row alias |
| `{` `}` `k` | …CurlyBracketAllowForwarding | `k` = home-row alias |
| `<` `>` | …AngleBracketAllowForwarding | |
| `"` `'` `` ` `` | Inner/ADoubleQuote, …SingleQuote, …BackTick | quotes seek forward |
| `g n` / `g N` | SearchMatchForward/Backward | next/prev search match |

## Counts & registers

| Key | Command | Action |
|---|---|---|
| `1`–`9` | set-count | accumulate count (`2dw`, `5j`) |
| `0` | count-or-line-start | count digit mid-count, else BOL |
| `"` | set-register-name | `"a`, `"+` select register for next op |

## Marks

| Key | Operation | Action |
|---|---|---|
| `m` | Mark | `m{a}` set mark |
| `` ` `` | MoveToMark | `` `{a} `` jump to mark (exact) |
| `'` | MoveToMarkLine | `'{a}` jump to mark line (first non-blank) |
| `g v` | SelectPreviousSelection | reselect last visual selection |
| `g b` | SelectLatestChange | select last changed/yanked region (`` `[ ``/`` `] ``) |

## Visual-mode-only

| Key | Operation | Action |
|---|---|---|
| `o` | ReverseSelections | swap active end |
| `O` | BlockwiseOtherEnd | swap the other corner (blockwise) |
| `I` / `A` | InsertAtStartOfTarget / InsertAtEndOfTarget | block/line-start/end insert |
| `u` / `U` / `~` | LowerCase / UpperCase / ToggleCase | case the selection (priority layer; overrides the non-insert `u`=Undo/`U`=Redo) |
| `g w` | GoogleSearch | search the selection on the web |

## Scrolling & redraw

| Key | Operation | Action |
|---|---|---|
| `ctrl-f` / `ctrl-b` | ScrollFullScreenDown/Up | page |
| `ctrl-d` / `ctrl-u` | ScrollHalfScreenDown/Up | half page |
| `ctrl-e` / `ctrl-y` | MiniScrollDown/Up | one line |
| `g ctrl-d` / `g ctrl-u` | ScrollQuarterScreenDown/Up | quarter page |
| `z z` / `z t` / `z b` | RedrawCursorLineAtMiddle/Top/Bottom | |
| `alt-j` / `alt-k` | move-down/up ×5 | step 5 lines (nvim port) |
| `alt-d` / `alt-u` | scroll-{down,up}-12-lines | scroll 12, cursor stays on screen |

## Folds (→ editor `fold:*`, not vim ops)

| Key | Command | Action |
|---|---|---|
| `z a` | fold:toggle | toggle fold at cursor |
| `z o` / `z c` | fold:open / fold:close | open/close fold at cursor (one level) |
| `z O` / `z C` | fold:open-recursive / fold:close-recursive | open/close the cursor's fold **and every fold nested in it** |
| `z r` / `z m` | fold:open-all / fold:close-all | open/close **all** folds |
| `z R` / `z M` | fold:open-all / fold:close-all | vim's capitals — aliases of `z r`/`z m` here (no foldlevel stepping) |

## Edit, undo, repeat, macros

| Key | Operation / command | Action |
|---|---|---|
| `u` | Undo | normal/op-pending (in **visual** `u` lowercases the selection) |
| `U` / `ctrl-r` | Redo | `U` is Redo in normal (in **visual** `U` uppercases the selection) |
| `.` | repeat | repeat last change |
| `q` / `@` | RecordMacro / ReplayMacro | `q{reg}…q`, `@{reg}`, `@@` |
| `ctrl-a` / `ctrl-x` | Increase / Decrease | number under cursor |
| `ctrl-o` / `ctrl-i` | workspace:jump-backward / -forward | jump list, across editors |
| `g ;` / `g ,` | GoToOlderChange / GoToNewerChange | change list |

`ctrl-o`/`ctrl-i` walk the jump list — like vim's cross-buffer jump list, it
re-traces navigation across tabs (including tab switches and files opened via
`g d`, pickers, or the file tree, re-opening the file if its tab was closed). It
watches the caret directly, so a far same-file jump made by *any* means — `*`/`n`
search, an in-file `g d`, a click, a big motion — lands you back where you
started on `ctrl-o`. Besides those, the classic vim jump motions (`G`, `{`/`}`,
search, …) always record even over a short distance. The distance threshold for
everything else is the `vim-mode-plus.jumpListMinLines` config key (default `6`;
`0` records only the classic flagged motions). `vim-mode-plus:jump-backward` /
`-forward` are the same commands under different names (bindable in `keymap.json`).
Separately, `g;`/`g,` walk the **change list** — the positions of your recent
edits, per file.

## Occurrence & multi-cursor

| Key | Command | Action |
|---|---|---|
| `g o` / `alt-/` | TogglePresetOccurrence | arm/disarm occurrence on search matches |
| `g .` | AddPresetOccurrenceFromLastOccurrencePattern | re-arm last pattern |
| `ctrl-alt-down` / `ctrl-alt-up` | add-cursor-below / above | persistent multi-cursor |
| `escape` | clear-multiple-cursors | collapse to one cursor (normal) |

## zym-original / editor extras (normal)

| Key | Command | Action |
|---|---|---|
| `g f` | GoToFile | open file under cursor |
| `g w` | GoogleSearch | web-search word (normal) / selection (visual) |
| `g d` / `g D` | lsp:go-to-definition / go-to-declaration | jump to definition/declaration (leader: `space l d`/`space l D`) |
| `K` | lsp:hover | hover card (`.TextEditor.normal-mode`) |
| `enter` | editor:comment | comment line/selection to an agent (file editors) |

## Insert mode (vim edit keys)

| Key | Operation | Action |
|---|---|---|
| `ctrl-w` | DeleteToPreviousWordBoundary | delete word back |
| `ctrl-u` | DeleteToBeginningOfInsertLine | delete to insert-start |
| `ctrl-r` | InsertRegister | `ctrl-r{reg}` paste register |
| `ctrl-a` | InsertLastInserted | re-insert last inserted text |

## Window / pane (`.AppWindow`, vim-style, all modes)

`ctrl-w` chords live at the window scope, so they work regardless of editor mode:
`ctrl-w v`/`s` split, `ctrl-w c` close, `ctrl-w h`/`j`/`k`/`l` focus,
`ctrl-w w`/`ctrl-w ctrl-w` cycle, and `ctrl-w g h`/`j`/`k`/`l`/`a`/`s` toggle docks.
See `src/keymaps/default.ts`.

## Registered, but no default keystroke

Operation classes wired as commands (reachable via palette / user keymap) with no
bound key today:

| Command | Operation | Note |
|---|---|---|
| vim-mode-plus:select-occurrence | SelectOccurrence | select all armed occurrences |

## Gaps — notable standard-vim keys we do NOT map

| Key | Vim meaning | Status in zym |
|---|---|---|
| `:` | ex-command line | **Won't do** — save/close/open via `space …`; search via SearchBar |
| `g q` | format lines | not mapped (`g w` is reused for web search) |
| `g ?` | rot13 | not mapped |
| `g J` | join without space | not mapped (only `J`) |
| `g p` / `g P` | paste, leave cursor after | not mapped |
| `g o` | goto byte N | **repurposed** → occurrence toggle |
| `g s` | (sleep in vim) | **repurposed** → leap |
| `[[` `]]` `[]` `][` | section motions | not mapped (have `] m`/`[ m` function motions) |
| `[(` `])` `[{` `]}` | unmatched-bracket motions | not mapped |
| `z f` `z d` `z D` `z E` `z F` | manual fold create/delete | not mapped — syntax folds only |
| `Z Z` / `Z Q` | write-quit / quit | not mapped (no ex) — use `space w`, `tab:close` |
| `&` / `g &` | repeat `:s` | not mapped (no ex) |
| `ctrl-]` / `ctrl-^` | tag jump / alternate file | not mapped — `g d` (LSP) / tab nav instead |
| insert `ctrl-t`/`ctrl-d` | indent/outdent line | not mapped |
| insert `ctrl-o` | one normal-mode command | not mapped |
| insert `ctrl-v` / `ctrl-k` | literal / digraph insert | not mapped |
| count `N%` | go to N% of file | not mapped (`MoveToLineByPercent` exists but `%` is wired to match-pair only) |

Recently filled (were gaps): `g i`, `g 0`/`g ^`/`g $`, `] m`/`[ m`, `g d`/`g D`, `z O`/`z C`,
`z R`/`z M`, and visual `u`/`U`/`~` case.
