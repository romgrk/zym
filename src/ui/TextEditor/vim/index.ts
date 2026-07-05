/*
 * Vim wiring — connects the vendored vim core to zym's command/keymap system.
 *
 * `attachVim` builds one VimState per editor and registers its commands against
 * that editor's view *instance* (so a keystroke dispatches to the right editor's
 * VimState). The keymaps are registered once, globally, scoped by mode CSS class
 * (`.TextEditor.normal-mode` / `.insert-mode`); the KeymapManager matches a
 * focused view against them and dispatches the bound command, which the per-view
 * command bundle resolves to `vimState.operationStack.run(<OperationClass>)`.
 *
 * The bindings are data-driven: each table maps a keystroke to an operation
 * class name, and both the command name (`vim-mode-plus:<dasherized>`) and the
 * keymap entry are derived from it.
 */
import { zym } from '../../../zym.ts';
import type { CommandRef } from '../../../KeymapManager.ts';
import type { EditorModel } from '../EditorModel.ts';
import VimState from './vim-state.ts';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.ts'; // ActivateNormalMode
import './motion.ts'; // self-registers the motion operations
import './operator.ts'; // Delete/Yank and operator base
import './operator-insert.ts'; // ActivateInsertMode/InsertAfter/Change/…
import './operator-transform-string.ts'; // gU/gu/g~, r, surround
import './text-object.ts'; // iw/aw/i(/a"/… (operator + visual targets)
import './misc-command.ts'; // Undo/Redo/Mark/…
import './zym-commands.ts'; // GoToFile (gf) / GoogleSearch (gw)

const dasherize = (name: string): string =>
  (name[0].toLowerCase() + name.slice(1)).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());

const commandName = (klass: string): string => `vim-mode-plus:${dasherize(klass)}`;

// Mode-entry operations, available only in normal mode. These enter insert mode
// at various positions (or after opening a new line).
const MODE_BINDINGS: Record<string, string> = {
  i: 'ActivateInsertMode',
  a: 'InsertAfter',
  o: 'InsertBelowWithNewline',
  O: 'InsertAboveWithNewline',
  I: 'InsertAtFirstCharacterOfLine',
  A: 'InsertAfterEndOfLine',
  'g I': 'InsertAtBeginningOfLine',
  // gi: resume insert at the position where insert mode was last left (the `^` mark).
  'g i': 'InsertAtLastInsert',
  // R: replace (overwrite) mode — insert mode with the `replace` submode; the
  // host overwrites on type and restores on backspace.
  R: 'ActivateReplaceMode',
};

// Visual-mode activation, available in normal and visual modes (so V switches a
// characterwise selection to linewise, and v toggles back to normal).
const VISUAL_BINDINGS: Record<string, string> = {
  v: 'ActivateCharacterwiseVisualMode',
  V: 'ActivateLinewiseVisualMode',
  'ctrl-v': 'ActivateBlockwiseVisualMode',
};

// Commands available only in visual mode (so they don't shadow normal-mode keys
// like `o` = open-line, `I`/`A` = insert at line start/end). `o` swaps the
// selection's active end; `O` swaps the other corner in blockwise. `I`/`A` enter
// insert mode at the start/end of every selection (column-insert in visual-block,
// the start/end of each line otherwise).
const VISUAL_COMMAND_BINDINGS: Record<string, string> = {
  o: 'ReverseSelections',
  O: 'BlockwiseOtherEnd',
  I: 'InsertAtStartOfTarget',
  A: 'InsertAtEndOfTarget',
};

// Single-key motions, available while NOT in insert mode.
const MOTION_BINDINGS: Record<string, string> = {
  h: 'MoveLeft',
  l: 'MoveRight',
  j: 'MoveDown',
  k: 'MoveUp',
  // Lowercase w/b/e default to *subword* motions (camelCase/snake_case aware);
  // the uppercase WHOLE-word variants (W/B/E) stay whole-word.
  w: 'MoveToNextSubword',
  W: 'MoveToNextWholeWord',
  b: 'MoveToPreviousSubword',
  B: 'MoveToPreviousWholeWord',
  e: 'MoveToEndOfSubword',
  E: 'MoveToEndOfWholeWord',
  // `0` is bound separately (count-aware): a count digit mid-count (`10j`),
  // otherwise MoveToBeginningOfLine. See ZERO_BINDING / count-or-line-start.
  '^': 'MoveToFirstCharacterOfLine',
  $: 'MoveToLastCharacterOfLine',
  G: 'MoveToLastLine',
  '{': 'MoveToPreviousParagraph',
  '}': 'MoveToNextParagraph',
  '%': 'MoveToPair',
  '|': 'MoveToColumn',
  '-': 'MoveToFirstCharacterOfLineUp',
  '+': 'MoveToFirstCharacterOfLineDown',
  'g _': 'MoveToLastNonblankCharacterOfLineAndDown',
  // `space` is intentionally left UNMAPPED. Upstream vim-mode-plus binds it to
  // MoveRight, but zym reserves `space` as the leader key, so the editor must
  // never consume it. Do not add a `space`/`' '` binding here (or anywhere in
  // this file's tables).
};

// Multi-key motions (keystroke sequences), available while NOT in insert mode.
const SEQUENCE_BINDINGS: Record<string, string> = {
  'g g': 'MoveToFirstLine',
  'g e': 'MoveToPreviousEndOfSubword', // subword by default; `g E` stays whole-word
  'g E': 'MoveToPreviousEndOfWholeWord',
  'g ctrl-d': 'ScrollQuarterScreenDown',
  'g ctrl-u': 'ScrollQuarterScreenUp',
  // gj/gk — move by display (soft-wrapped) line. g0/g^/g$ — start/first-non-blank/end
  // of the *display* line (only differ from 0/^/$ under soft-wrap).
  'g j': 'MoveDownDisplayLine',
  'g k': 'MoveUpDisplayLine',
  'g 0': 'MoveToBeginningOfScreenLine',
  'g ^': 'MoveToFirstCharacterOfScreenLine',
  'g $': 'MoveToLastCharacterOfScreenLine',
  // ]m/[m — jump to the next/previous function start (tree-sitter), also usable as an
  // operator target (`d ] m`). Same code-fold scope source as the `i f`/`a f` text objects.
  '] m': 'MoveToNextFunction',
  '[ m': 'MoveToPreviousFunction',
  // gv — reselect the last visual selection.
  'g v': 'SelectPreviousSelection',
  // gb — select the latest changed/yanked region (the `[`/`]` change marks).
  'g b': 'SelectLatestChange',
  // Fold motions: zj/zk to the next/previous fold, [z/]z to the current fold's edges.
  'z j': 'MoveToNextFoldStart',
  'z k': 'MoveToPreviousFoldEnd',
  '[ z': 'MoveToPreviousFoldStart',
  '] z': 'MoveToNextFoldEnd',
  // [h/]h — jump to the previous/next git hunk (GitGutter change bars).
  '[ h': 'MoveToPreviousHunk',
  '] h': 'MoveToNextHunk',
  // [d/]d — jump to the previous/next LSP diagnostic in the file.
  '[ d': 'MoveToPreviousDiagnostic',
  '] d': 'MoveToNextDiagnostic',
};

// By default `j`/`k` move by display line too (like `:set nowrap`-free editors),
// but only in normal/visual mode — operator-pending keeps the linewise buffer
// `j`/`k` so `dj`/`dk` still delete whole lines. Registered at a higher priority
// so it wins over the buffer-line `j`/`k` from the shared motion bindings.
const DISPLAY_LINE_DEFAULTS: Record<string, string> = {
  j: 'MoveDownDisplayLine',
  k: 'MoveUpDisplayLine',
};

// Screen-relative line motions (use the viewport geometry).
const SCREEN_MOTION_BINDINGS: Record<string, string> = {
  H: 'MoveToTopOfScreen',
  M: 'MoveToMiddleOfScreen',
  L: 'MoveToBottomOfScreen',
};

// Sentence motions.
const SENTENCE_BINDINGS: Record<string, string> = {
  ')': 'MoveToNextSentence',
  '(': 'MoveToPreviousSentence',
};

// Increment / decrement the number under (or after) the cursor.
const NUMBER_BINDINGS: Record<string, string> = {
  'ctrl-a': 'Increase',
  'ctrl-x': 'Decrease',
};

// Scrolling. ctrl-f/b/d/u page-scroll (cursor moves with the view); ctrl-e/ctrl-y
// scroll one line, keeping the cursor on screen.
const SCROLL_BINDINGS: Record<string, string> = {
  'ctrl-f': 'ScrollFullScreenDown',
  'ctrl-b': 'ScrollFullScreenUp',
  'ctrl-d': 'ScrollHalfScreenDown',
  'ctrl-u': 'ScrollHalfScreenUp',
  'ctrl-e': 'MiniScrollDown',
  'ctrl-y': 'MiniScrollUp',
};

// `z`-prefix: cursor-line redraw (zz/zt/zb — vim operations). The fold keys
// (za/zo/zc/zO/zC/zr/zm/zR/zM) share the prefix but dispatch to the editor's
// `fold:*` commands (registered by TextEditor over the SyntaxController), not vim
// operations — see FOLD_KEYMAP, kept out of NORMAL_OPERATIONS.
const Z_SCROLL_BINDINGS: Record<string, string> = {
  'z z': 'RedrawCursorLineAtMiddle',
  'z t': 'RedrawCursorLineAtTop',
  'z b': 'RedrawCursorLineAtBottom',
};
const FOLD_KEYMAP: Record<string, string> = {
  'z a': 'fold:toggle',
  'z o': 'fold:open',
  'z c': 'fold:close',
  // zO/zC recurse into the cursor's fold subtree (open/close every nested fold).
  'z O': 'fold:open-recursive',
  'z C': 'fold:close-recursive',
  // zr/zm open/close ALL folds; zR/zM are vim's capitals for the same here (no
  // foldlevel-stepping, so the lowercase/uppercase pair are aliases).
  'z r': 'fold:open-all',
  'z m': 'fold:close-all',
  'z R': 'fold:open-all',
  'z M': 'fold:close-all',
};

// Find-char motions. These `requireInput`: the operation reads the next
// keystroke (captured via VimState.readChar) as its target character, then
// jumps to it on the cursor's line. f/F land on the char; t/T stop next to it.
const FIND_BINDINGS: Record<string, string> = {
  f: 'Find',
  F: 'FindBackwards',
  t: 'Till',
  T: 'TillBackwards',
};

// `;`/`,` repeat the last find/leap (same / reversed direction). These don't map
// to an operation class — they replay the recorded motion via the operation stack
// — so they're wired as commands in `attachVim`, not through the class tables. `;`
// repeats whichever of find/leap was used last; `,` reverses the find.
const REPEAT_FIND_COMMANDS: Record<string, string> = {
  ';': 'vim-mode-plus:repeat-find-or-start-leap',
  ',': 'vim-mode-plus:repeat-find-reverse',
};

// `.` repeats the last change. Like the repeat-find keys, it replays a recorded
// operation through the stack rather than mapping to an operation class.
const REPEAT_COMMANDS: Record<string, string> = {
  '.': 'vim-mode-plus:repeat',
};

// Count digits 1-9 accumulate the operation count (e.g. `2dw`, `5j`). `0` stays
// MoveToBeginningOfLine — using it mid-count (e.g. `10j`) isn't handled yet.
const COUNT_BINDINGS: Record<string, { command: string; args: number[] }> = Object.fromEntries(
  Array.from({ length: 9 }, (_, i) => [
    String(i + 1),
    { command: 'vim-mode-plus:set-count', args: [i + 1] },
  ]),
);

// `0` is count-aware: it extends a pending count (`10j`) or, with no count,
// moves to the beginning of the line.
const ZERO_BINDING: Record<string, string> = {
  '0': 'vim-mode-plus:count-or-line-start',
};

// `"{reg}` selects the register the next yank/delete/paste uses (e.g. `"ayy`,
// `"+p`). Reads the register letter via VimState.readChar and sets it on the
// register manager; it clears itself after the next operation. Not an operation
// class — it sets pending state directly rather than running through the stack.
const REGISTER_COMMANDS: Record<string, string> = {
  '"': 'vim-mode-plus:set-register-name',
};

// Operators (await a motion/text-object target), available while NOT in insert mode.
// d/y/c await a target in normal mode but operate on the selection in visual mode.
// x/p have preset targets / no target, so they execute immediately.
const OPERATOR_BINDINGS: Record<string, string> = {
  d: 'Delete',
  y: 'Yank',
  c: 'Change',
  x: 'DeleteRight',
  p: 'PutAfter',
  P: 'PutBefore',
  // Replace-with-register operator (romgrk/replace.vim): `s{motion}` replaces the
  // target with the register's content; `ss` (same-operator repeat) the line.
  s: 'ReplaceWithRegister',
};

// Text objects, used as operator targets / visual selections. Bound only in
// operator-pending and visual modes (in normal mode `i`/`a` enter insert).
const TEXT_OBJECT_BINDINGS: Record<string, string> = {
  'i w': 'InnerWord',
  'a w': 'AWord',
  'i W': 'InnerWholeWord',
  'a W': 'AWholeWord',
  'i p': 'InnerParagraph',
  'a p': 'AParagraph',
  'i s': 'InnerSentence',
  'a s': 'ASentence',
  'i t': 'InnerTag',
  'a t': 'ATag',
  // targets.vim: arguments (with separator handling) and indentation blocks.
  'i a': 'InnerArguments',
  'a a': 'AArguments',
  // Indentation block: `i i` and `a i` both select the block including its
  // surrounding blank lines (no inner/around split — see Indentation in text-object.ts).
  'i i': 'Indentation',
  'a i': 'Indentation',
  // gn/gN: the next/previous search match (operate on it: `cgn`, `dgn`; or extend
  // a visual selection). Needs an active search — see SearchController's pattern
  // bridge to globalState.lastSearchPattern.
  'g n': 'SearchMatchForward',
  'g N': 'SearchMatchBackward',
  // LHS/RHS of an assignment (equal.operator): `h` = left side, `l` = right side.
  // inner trims to the value; `a` keeps the `=`/`:`/`->` separator.
  'i h': 'InnerLhs',
  'a h': 'ALhs',
  'i l': 'InnerRhs',
  'a l': 'ARhs',
  // whole buffer.
  'i e': 'InnerEntire',
  'a e': 'AEntire',
  // fold region (the foldable block at the cursor).
  'i z': 'InnerFold',
  'a z': 'AFold',
  // function (tree-sitter): `if` body, `af` whole definition.
  'i f': 'InnerFunction',
  'a f': 'AFunction',
  // class/interface/enum (tree-sitter): `ic` body, `ac` whole definition.
  'i c': 'InnerClass',
  'a c': 'AClass',
  // Brackets use the targets.vim-style *AllowForwarding* variants: when the cursor
  // isn't inside a pair, the text object seeks to the next pair on the line (an
  // enclosing pair still wins). Either member key (open or close) selects the pair,
  // plus letter aliases that don't need a shift/AltGr reach: `b`=() , `r`=[] , `k`={}
  // (these mirror the surround pair aliases — see `pairsByAlias` in
  // operator-transform-string.ts; surround additionally accepts `a`=`<>`).
  'i (': 'InnerParenthesisAllowForwarding',
  'a (': 'AParenthesisAllowForwarding',
  'i )': 'InnerParenthesisAllowForwarding',
  'a )': 'AParenthesisAllowForwarding',
  'i b': 'InnerParenthesisAllowForwarding',
  'a b': 'AParenthesisAllowForwarding',
  'i [': 'InnerSquareBracketAllowForwarding',
  'a [': 'ASquareBracketAllowForwarding',
  'i ]': 'InnerSquareBracketAllowForwarding',
  'a ]': 'ASquareBracketAllowForwarding',
  'i r': 'InnerSquareBracketAllowForwarding',
  'a r': 'ASquareBracketAllowForwarding',
  'i {': 'InnerCurlyBracketAllowForwarding',
  'a {': 'ACurlyBracketAllowForwarding',
  'i }': 'InnerCurlyBracketAllowForwarding',
  'a }': 'ACurlyBracketAllowForwarding',
  'i k': 'InnerCurlyBracketAllowForwarding',
  'a k': 'ACurlyBracketAllowForwarding',
  'i <': 'InnerAngleBracketAllowForwarding',
  'a <': 'AAngleBracketAllowForwarding',
  'i >': 'InnerAngleBracketAllowForwarding',
  'a >': 'AAngleBracketAllowForwarding',
  // Quotes already seek to the next pair on the line (Quote.allowForwarding).
  'i "': 'InnerDoubleQuote',
  'a "': 'ADoubleQuote',
  "i '": 'InnerSingleQuote',
  "a '": 'ASingleQuote',
  'i `': 'InnerBackTick',
  'a `': 'ABackTick',
};

// Case operators (await a motion/text-object target, like d/y). Sequences under
// the `g` prefix — no bare `g` binding exists, so they don't conflict.
const CASE_BINDINGS: Record<string, string> = {
  'g U': 'UpperCase',
  'g u': 'LowerCase',
  'g ~': 'ToggleCase',
};

// In VISUAL mode, bare u/U/~ transform the selection's case (vim's visual case keys),
// not Undo/Redo (those are `.TextEditor:not(.insert-mode)` bindings). Registered at a
// higher priority — like the display-line j/k — so the visual scope wins the tie.
// Reuses the case operation classes already registered via CASE_BINDINGS.
const VISUAL_CASE_BINDINGS: Record<string, string> = {
  u: 'LowerCase',
  U: 'UpperCase',
  '~': 'ToggleCase',
};

// Replace-character (r): selects `count` chars to the right and reads a single
// replacement character. Operates on the selection in visual mode.
const REPLACE_BINDINGS: Record<string, string> = {
  r: 'ReplaceCharacter',
};

// Marks: `m{a}` records the cursor position under letter `a`; `` `{a} `` /
// `'{a}` jump to it (the latter to the line's first character). The jumps are
// motions (so `` d`a `` works); `m` is a misc command.
const MARK_BINDINGS: Record<string, string> = {
  m: 'Mark',
  '`': 'MoveToMark',
  "'": 'MoveToMarkLine',
};

// Surround (vim-surround style), bound in normal mode:
//   `ys{motion}{char}` wrap the motion's range, `ds{char}` delete a pair,
//   `cs{from}{to}` change one pair into another.
// Their `y`/`d`/`c` prefixes collide with the Yank/Delete/Change operators; the
// KeymapManager's longest-match deferral resolves it (it waits one key to see if
// `s` follows, falling back to the bare operator otherwise).
const SURROUND_BINDINGS: Record<string, string> = {
  'y s': 'Surround',
  'd s': 'DeleteSurround',
  'c s': 'ChangeSurround',
};

// Single-key operator shortcuts with preset targets (so they run immediately):
// S replaces the whole line (= `ss`), C/D change/delete to end of line, Y yanks
// a line, X deletes left. In visual mode they operate on the selection.
const SHORTCUT_OPERATOR_BINDINGS: Record<string, string> = {
  S: 'ReplaceLineWithRegister',
  C: 'ChangeToLastCharacterOfLine',
  D: 'DeleteToLastCharacterOfLine',
  Y: 'YankLine',
  X: 'DeleteLeft',
  '~': 'ToggleCaseAndMoveRight',
};

// Indent/outdent operators (>/< await a motion target; >>/<< via same-operator
// repeat) and join (J, preset target).
const INDENT_JOIN_BINDINGS: Record<string, string> = {
  '>': 'Indent',
  '<': 'Outdent',
  '=': 'AutoIndent',
  J: 'Join',
};

// Toggle line comments (vim-commentary / nvim `gc`): `g c` is an operator
// (`g c {motion}`, doubled `g c g c`, visual `g c` on the selection); `g c c` is
// the current-line stroke (preset target, normal-mode only — the keymap's
// longest-match deferral arbitrates it against the bare `g c` operator, exactly
// like `y`/`y s`). Delimiters come from the file's language (`comments` in the
// LanguageRegistry); the non-vim `ctrl-/` route is TextEditor's
// `editor:toggle-line-comments`.
const COMMENT_BINDINGS: Record<string, string> = {
  'g c': 'ToggleLineComments',
};
const COMMENT_LINE_BINDINGS: Record<string, string> = {
  'g c c': 'ToggleLineCommentsCurrentLine',
};

// Normal-mode-only editing commands. `ctrl-j` splits the line at the cursor —
// the inverse of `J` (Join). Normal-only so it doesn't collide with the visual
// `CurrentSelection` target the Operator base would otherwise impose.
const EDIT_BINDINGS: Record<string, string> = {
  'ctrl-j': 'SplitLine',
};

// Misc commands (undo/redo), available while NOT in insert mode.
const MISC_BINDINGS: Record<string, string> = {
  u: 'Undo',
  U: 'Redo',
  'ctrl-r': 'Redo',
};

// Insert-mode editing commands (vim's ctrl-w / ctrl-u / ctrl-r / ctrl-a).
const INSERT_BINDINGS: Record<string, string> = {
  'ctrl-w': 'DeleteToPreviousWordBoundary',
  'ctrl-u': 'DeleteToBeginningOfInsertLine',
  'ctrl-r': 'InsertRegister',
  'ctrl-a': 'InsertLastInserted',
};

// Macros — record (q{reg}…q) and replay (@{reg}, @@). Normal mode.
const MACRO_BINDINGS: Record<string, string> = {
  q: 'RecordMacro',
  '@': 'ReplayMacro',
};

// Per-editor jump list (alt-o/alt-i) and change list (g;/g,) — normal-mode
// navigation. ctrl-o/ctrl-i walk the workspace-wide jump list instead (across
// editors, vim's cross-buffer behavior) — see GLOBAL_JUMP_COMMANDS.
const JUMP_BINDINGS: Record<string, string> = {
  'alt-o': 'JumpBackward',
  'alt-i': 'JumpForward',
  'g ;': 'GoToOlderChange',
  'g ,': 'GoToNewerChange',
};

// Host commands (see ui/GlobalJumpList.ts), bound here so every jump key lives
// beside JUMP_BINDINGS — the fold-command precedent for host-command keys.
const GLOBAL_JUMP_COMMANDS: Record<string, string> = {
  'ctrl-o': 'workspace:jump-backward',
  'ctrl-i': 'workspace:jump-forward',
};

// Occurrence: `g o` toggles occurrence arming — it operates on the SEARCH matches
// (arm from the active search, else seed the search from the cursor word / selection
// without moving the cursor). Any later operator restricts itself to the armed
// matches (`g o` then `d a p`). `g .` re-arms the last occurrence pattern. Disarm
// with `g o` again or Escape. There is no `o`/`O` operator-modifier (`c o p`) —
// `g o` replaces it (and adds regex). See docs/text-editor/occurrence-search.md.
const OCCURRENCE_BINDINGS: Record<string, string> = {
  'g o': 'TogglePresetOccurrence',
  'alt-/': 'TogglePresetOccurrence', // fast single-chord toggle (arm/disarm)
  'g .': 'AddPresetOccurrenceFromLastOccurrencePattern',
};

// Persistent multi-cursor: add a cursor on the row below/above (Sublime/VS Code
// `ctrl-alt-↓/↑`). The extra cursors then move with motions, are operated on by
// operators, and receive typed text on leaving insert mode (the same path
// blockwise/occurrence use). `escape` in normal mode collapses back to one.
// These are plain commands (no operation class), wired in `attachVim`.
const MULTI_CURSOR_COMMANDS: Record<string, string> = {
  'ctrl-alt-down': 'vim-mode-plus:add-cursor-below',
  'ctrl-alt-up': 'vim-mode-plus:add-cursor-above',
};
const MULTI_CURSOR_CLEAR: Record<string, string> = {
  escape: 'vim-mode-plus:clear-multiple-cursors',
};

// `ctrl-l` (the classic vim `:noh` remap) clears the search highlights and disarms
// occurrence. The query is kept so `n`/`N` re-find. Plain command, wired in
// `attachVim`. See docs/text-editor/occurrence-search.md.
const SEARCH_CLEAR_COMMANDS: Record<string, string> = {
  'ctrl-l': 'vim-mode-plus:clear-search-highlight',
};

// Alt-navigation, ported from the user's nvim keymap (`<A-j/k>` = 5j/5k,
// `<A-d/u>` = 12<C-e>/12<C-y>): alt-j/k step 5 lines; alt-d/u scroll the view 12
// lines, keeping the cursor on screen. alt-j/k pass a line count to the plain
// `move-down`/`move-up` commands via the keymap's `{ command, args }` form; the
// scroll entries run an operation class with a preset count, wired as plain
// commands in `attachVim`.
const ALT_NAV_COMMANDS: Record<string, CommandRef> = {
  'alt-j': { command: 'vim-mode-plus:move-down', args: [5] },
  'alt-k': { command: 'vim-mode-plus:move-up', args: [5] },
  'alt-d': { command: 'vim-mode-plus:scroll-down-12-lines' },
  'alt-u': { command: 'vim-mode-plus:scroll-up-12-lines' },
};

// Leap (leap.nvim-style two-char labeled jump). `g s` / `g S` because plain
// `s`/`S` are Substitute here. Bound in every non-insert mode so it works as a
// plain jump (normal), a selection extension (visual), and an operator target
// (`d g s`). The host (TextEditor's Leap) supplies the labels + input.
const LEAP_BINDINGS: Record<string, string> = {
  'g s': 'Leap',
  'g S': 'LeapBackwards',
};

// zym-original `g`-prefixed commands (see `zym-commands.ts`). `gf` opens the file
// named under the cursor (normal mode). `gw` opens a Google search for the word
// under the cursor (normal) or the selection (visual), so it's bound in both.
const GOTO_FILE_BINDINGS: Record<string, string> = {
  'g f': 'GoToFile',
};
const WEB_SEARCH_BINDINGS: Record<string, string> = {
  'g w': 'GoogleSearch',
};

// Motions + operators are bound in every non-insert mode (notably operator-pending,
// so the motion that follows `d` resolves). Mode-entry keys (i/a) are normal-only.
const NON_INSERT_BINDINGS: Record<string, string> = {
  ...MOTION_BINDINGS,
  ...SEQUENCE_BINDINGS,
  ...LEAP_BINDINGS,
  ...SCREEN_MOTION_BINDINGS,
  ...SENTENCE_BINDINGS,
  ...FIND_BINDINGS,
  ...CASE_BINDINGS,
  ...REPLACE_BINDINGS,
  ...MARK_BINDINGS,
  ...OPERATOR_BINDINGS,
  ...SHORTCUT_OPERATOR_BINDINGS,
  ...NUMBER_BINDINGS,
  ...SCROLL_BINDINGS,
  ...INDENT_JOIN_BINDINGS,
  ...COMMENT_BINDINGS,
  ...MISC_BINDINGS,
  ...OCCURRENCE_BINDINGS,
};

// Search as an operator/visual motion (`d/foo`, `v?bar`). Bound only in
// operator-pending and visual modes — in normal mode `/`/`?` open the SearchBar
// directly (TextEditor's `editor:search-*` commands), not the vim motion.
const SEARCH_MOTION_BINDINGS: Record<string, string> = {
  '/': 'Search',
  '?': 'SearchBackwards',
};

// All operation classes a command is registered for, by class name.
const NORMAL_OPERATIONS: Record<string, string> = {
  ...MODE_BINDINGS,
  ...VISUAL_BINDINGS,
  ...NON_INSERT_BINDINGS,
  ...EDIT_BINDINGS,
  ...TEXT_OBJECT_BINDINGS,
  ...SURROUND_BINDINGS,
  ...Z_SCROLL_BINDINGS,
  ...SEARCH_MOTION_BINDINGS,
  ...JUMP_BINDINGS,
  ...MACRO_BINDINGS,
  ...GOTO_FILE_BINDINGS,
  ...WEB_SEARCH_BINDINGS,
  ...COMMENT_LINE_BINDINGS,
  // Visual-only commands registered under unique keys so they don't shadow the
  // normal-mode `o`/`O` (open-line) entries above — this map is only enumerated
  // for command registration, so the keys are arbitrary.
  'visual:o': 'ReverseSelections',
  'visual:O': 'BlockwiseOtherEnd',
  'visual:I': 'InsertAtStartOfTarget',
  'visual:A': 'InsertAtEndOfTarget',
  // Insert-mode commands, likewise under unique keys (ctrl-r/ctrl-a otherwise
  // collide with Redo / Increase).
  'insert:ctrl-w': 'DeleteToPreviousWordBoundary',
  'insert:ctrl-u': 'DeleteToBeginningOfInsertLine',
  'insert:ctrl-r': 'InsertRegister',
  'insert:ctrl-a': 'InsertLastInserted',
  // SelectOccurrence reachable as a command but without a default keystroke (registered
  // for command creation only; the key here is arbitrary). MoveToNext/PreviousOccurrence
  // are intentionally not exposed — `n`/`N` (editor search-next/prev) already navigate the
  // matches in zym's unified search/occurrence model.
  'occurrence:select': 'SelectOccurrence',
};

let keymapsRegistered = false;

function toKeymap(bindings: Record<string, string>): Record<string, string> {
  const keymap: Record<string, string> = {};
  for (const [key, klass] of Object.entries(bindings)) keymap[key] = commandName(klass);
  return keymap;
}

function registerKeymapsOnce(): void {
  if (keymapsRegistered) return;
  keymapsRegistered = true;

  zym.keymaps.add('vim-mode-plus', {
    // Mode-entry keys (i/a) are normal-only; v/V activate visual from normal too.
    // Surround sequences (ys/ds/cs) start here; their operator targets resolve
    // through the operator-pending text-object bindings below.
    '.TextEditor.normal-mode': {
      ...toKeymap(MODE_BINDINGS),
      ...toKeymap(VISUAL_BINDINGS),
      ...toKeymap(SURROUND_BINDINGS),
      // ctrl-j splits the line at the cursor (inverse of J), normal-mode only.
      ...toKeymap(EDIT_BINDINGS),
      // z-prefix: folds (→ editor `fold:*` commands) + zz/zt/zb cursor-line redraw.
      ...FOLD_KEYMAP,
      ...toKeymap(Z_SCROLL_BINDINGS),
      // alt-o/alt-i per-editor jump list, g;/g, change list; ctrl-o/ctrl-i the
      // workspace-wide jump list (across editors).
      ...toKeymap(JUMP_BINDINGS),
      ...GLOBAL_JUMP_COMMANDS,
      // q record / @ replay macros.
      ...toKeymap(MACRO_BINDINGS),
      // ctrl-alt-↑/↓ add a cursor; escape collapses multi-cursor back to one.
      ...MULTI_CURSOR_COMMANDS,
      ...MULTI_CURSOR_CLEAR,
      // ctrl-l clears the search highlights + disarms occurrence (vim `:noh`).
      ...SEARCH_CLEAR_COMMANDS,
      // alt-j/k step 5 lines; alt-d/u scroll the view 12 lines (ported from nvim).
      ...ALT_NAV_COMMANDS,
      // gf opens the file under the cursor; gw Google-searches the word under it.
      ...toKeymap(GOTO_FILE_BINDINGS),
      ...toKeymap(WEB_SEARCH_BINDINGS),
      // g c c toggles the current line's comment (the operator itself is `g c`,
      // bound with the other operators below).
      ...toKeymap(COMMENT_LINE_BINDINGS),
    },
    // Motions and operators apply in normal, operator-pending, and visual modes.
    '.TextEditor:not(.insert-mode)': {
      ...toKeymap(NON_INSERT_BINDINGS),
      ...REPEAT_FIND_COMMANDS,
      ...REPEAT_COMMANDS,
      ...REGISTER_COMMANDS,
      ...COUNT_BINDINGS,
      ...ZERO_BINDING,
    },
    // In visual mode: v/V switch wise (or toggle off), text objects select, and
    // `/`/`?` extend the selection to a search match.
    '.TextEditor.visual-mode': {
      ...toKeymap(VISUAL_BINDINGS),
      ...toKeymap(VISUAL_COMMAND_BINDINGS),
      ...toKeymap(TEXT_OBJECT_BINDINGS),
      ...toKeymap(SEARCH_MOTION_BINDINGS),
      // gw Google-searches the current selection.
      ...toKeymap(WEB_SEARCH_BINDINGS),
    },
    // Operator targets in operator-pending mode: text objects and `d/foo` search.
    '.TextEditor.operator-pending-mode': {
      ...toKeymap(TEXT_OBJECT_BINDINGS),
      ...toKeymap(SEARCH_MOTION_BINDINGS),
    },
    // Escape returns to normal mode from insert, operator-pending, and visual.
    '.TextEditor:not(.normal-mode)': {
      escape: 'vim-mode-plus:activate-normal-mode',
    },
    // Insert-mode editing commands (ctrl-w/u/r/a).
    '.TextEditor.insert-mode': toKeymap(INSERT_BINDINGS),
  });

  // `j`/`k` → display-line motion in normal & visual mode, at a higher priority so
  // it overrides the buffer-line `j`/`k` bound above. Operator-pending is left out
  // on purpose, so `dj`/`dk` stay linewise.
  zym.keymaps.add(
    'vim-mode-plus-display-lines',
    {
      '.TextEditor.normal-mode': toKeymap(DISPLAY_LINE_DEFAULTS),
      '.TextEditor.visual-mode': toKeymap(DISPLAY_LINE_DEFAULTS),
    },
    1,
  );

  // Visual-mode u/U/~ → case ops, at the same higher priority so they beat the shared
  // not-insert u=Undo / U=Redo / ~=toggle-and-move bindings.
  zym.keymaps.add(
    'vim-mode-plus-visual-case',
    {
      '.TextEditor.visual-mode': toKeymap(VISUAL_CASE_BINDINGS),
    },
    1,
  );
}

/** Create and wire a VimState for `editor`, returning it. */
export function attachVim(editor: EditorModel): VimState {
  registerKeymapsOnce();

  const vimState = new VimState(editor, new StatusBarManager());

  const commands: Record<string, (...args: unknown[]) => void> = {
    'vim-mode-plus:activate-normal-mode': () => {
      vimState.operationStack.run('ActivateNormalMode');
    },
    // Count digits accumulate via the operation stack (mode-aware: normal vs
    // operator-pending), so `2d3w` multiplies to 6. Commands receive
    // (event, element, ...args); the digit is the first dispatch arg.
    'vim-mode-plus:set-count': (_event, _element, n) => {
      vimState.setCount(n as number);
    },
    // `0`: extend a pending count, else move to the beginning of the line.
    'vim-mode-plus:count-or-line-start': () => {
      if (vimState.operationStack.hasCount()) vimState.setCount(0);
      else vimState.operationStack.run('MoveToBeginningOfLine');
    },
    // `;`/`,` replay the recorded find rather than running an operation class.
    'vim-mode-plus:repeat-find': () => {
      vimState.operationStack.runCurrentFind();
    },
    // `;` repeats the find when a find (f/F/t/T or a prior `;`) was the last
    // command; otherwise it starts a fresh leap. So a `;` after `fx` steps the
    // find, but a standalone `;` is a quick leap.
    'vim-mode-plus:repeat-find-or-start-leap': () => {
      const findCommands = ['Find', 'FindBackwards', 'Till', 'TillBackwards'];
      const lastWasFind = findCommands.includes(vimState.operationStack.getLastCommandName() ?? '');
      if (lastWasFind && vimState.globalState.get('currentFind')) {
        vimState.operationStack.runCurrentFind();
      } else {
        vimState.operationStack.run('Leap');
      }
    },
    'vim-mode-plus:repeat-find-reverse': () => {
      vimState.operationStack.runCurrentFind({ reverse: true });
    },
    // `.` — replay the last recorded change.
    'vim-mode-plus:repeat': () => {
      vimState.operationStack.runRecorded();
    },
    // `"` — read a register letter and target it for the next operation.
    'vim-mode-plus:set-register-name': () => {
      vimState.register.setName();
    },
    // `ctrl-l` — vim `:noh`: disarm occurrence and drop the search highlights (the
    // query persists so `n`/`N` re-find).
    'vim-mode-plus:clear-search-highlight': () => {
      vimState.clearSearchHighlight();
    },
    // Persistent multi-cursor add/clear (direct EditorModel ops, then repaint).
    'vim-mode-plus:add-cursor-below': () => {
      editor.addCursorBelow();
      editor.renderExtraSelections();
    },
    'vim-mode-plus:add-cursor-above': () => {
      editor.addCursorAbove();
      editor.renderExtraSelections();
    },
    'vim-mode-plus:clear-multiple-cursors': () => {
      if (!editor.hasMultipleCursors()) return;
      editor.clearExtraSelections();
      editor.renderExtraSelections();
    },
    // Alt-navigation: run the mini-scroll with a preset count (the count rides on
    // the operation instance via `run`'s properties arg).
    'vim-mode-plus:scroll-down-12-lines': () => {
      vimState.operationStack.run('MiniScrollDown', { count: 12 });
    },
    'vim-mode-plus:scroll-up-12-lines': () => {
      vimState.operationStack.run('MiniScrollUp', { count: 12 });
    },
  };
  for (const klass of Object.values(NORMAL_OPERATIONS)) {
    commands[commandName(klass)] = () => {
      vimState.operationStack.run(klass);
    };
  }

  // move-down / move-up take a line count as their first dispatch argument
  // (default 1), so a keybinding can step several lines at once (e.g. alt-j → 5).
  // Registered after the generic loop so these count-aware handlers win.
  const runWithCount = (klass: string, count: unknown) => {
    vimState.operationStack.run(klass, { count: typeof count === 'number' ? count : 1 });
  };
  commands[commandName('MoveDown')] = (_event, _element, count) => runWithCount('MoveDown', count);
  commands[commandName('MoveUp')] = (_event, _element, count) => runWithCount('MoveUp', count);

  zym.commands.add(editor.view, commands);
  return vimState;
}
