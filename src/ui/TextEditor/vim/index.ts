/*
 * Vim wiring — connects the vendored vim core to quilx's command/keymap system.
 *
 * `attachVim` builds one VimState per editor and registers its commands against
 * that editor's view *instance* (so a keystroke dispatches to the right editor's
 * VimState). The keymaps are registered once, globally, scoped by mode CSS class
 * (`GtkSourceView.normal-mode` / `.insert-mode`); the KeymapManager matches a
 * focused view against them and dispatches the bound command, which the per-view
 * command bundle resolves to `vimState.operationStack.run(<OperationClass>)`.
 *
 * The bindings are data-driven: each table maps a keystroke to an operation
 * class name, and both the command name (`vim-mode-plus:<dasherized>`) and the
 * keymap entry are derived from it.
 */
import { quilx } from '../../../quilx.ts';
import type { EditorModel } from '../EditorModel.ts';
import VimState from './vim-state.js';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.js'; // ActivateNormalMode
import './motion.js'; // self-registers the motion operations
import './operator.js'; // Delete/Yank and operator base
import './operator-insert.js'; // ActivateInsertMode/InsertAfter/Change/…
import './operator-transform-string.js'; // gU/gu/g~, r, surround
import './text-object.js'; // iw/aw/i(/a"/… (operator + visual targets)
import './misc-command.js'; // Undo/Redo/Mark/…

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
};

// Visual-mode activation, available in normal and visual modes (so V switches a
// characterwise selection to linewise, and v toggles back to normal).
const VISUAL_BINDINGS: Record<string, string> = {
  v: 'ActivateCharacterwiseVisualMode',
  V: 'ActivateLinewiseVisualMode',
  'ctrl-v': 'ActivateBlockwiseVisualMode',
};

// Commands available only in visual mode (so they don't shadow normal-mode keys
// like `o` = open-line). `o` swaps the selection's active end; `O` swaps the
// other corner in blockwise.
const VISUAL_COMMAND_BINDINGS: Record<string, string> = {
  o: 'ReverseSelections',
  O: 'BlockwiseOtherEnd',
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
  // MoveRight, but quilx reserves `space` as the leader key, so the editor must
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
  // gj/gk — move by display (soft-wrapped) line.
  'g j': 'MoveDownDisplayLine',
  'g k': 'MoveUpDisplayLine',
  // gv — reselect the last visual selection.
  'g v': 'SelectPreviousSelection',
  // Fold motions: zj/zk to the next/previous fold, [z/]z to the current fold's edges.
  'z j': 'MoveToNextFoldStart',
  'z k': 'MoveToPreviousFoldEnd',
  '[ z': 'MoveToPreviousFoldStart',
  '] z': 'MoveToNextFoldEnd',
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
// (za/zo/zc/zR/zM) share the prefix but dispatch to the editor's `fold:*`
// commands (registered by TextEditor over the SyntaxController), not vim
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

// `;`/`,` repeat the last find (same / reversed direction). These don't map to
// an operation class — they replay the recorded find via the operation stack —
// so they're wired as commands in `attachVim`, not through the class tables.
const REPEAT_FIND_COMMANDS: Record<string, string> = {
  ';': 'vim-mode-plus:repeat-find',
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
  'i i': 'InnerIndentation',
  'a i': 'AIndentation',
  // whole buffer.
  'i e': 'InnerEntire',
  'a e': 'AEntire',
  // fold region (the foldable block at the cursor).
  'i z': 'InnerFold',
  'a z': 'AFold',
  // function (tree-sitter): `if` body, `af` whole definition.
  'i f': 'InnerFunction',
  'a f': 'AFunction',
  // Brackets use the targets.vim-style *AllowForwarding* variants: when the cursor
  // isn't inside a pair, the text object seeks to the next pair on the line (an
  // enclosing pair still wins). `b`/`B` are vim's aliases for ()/{}; either
  // member key (open or close) selects the pair.
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
  'i {': 'InnerCurlyBracketAllowForwarding',
  'a {': 'ACurlyBracketAllowForwarding',
  'i }': 'InnerCurlyBracketAllowForwarding',
  'a }': 'ACurlyBracketAllowForwarding',
  'i B': 'InnerCurlyBracketAllowForwarding',
  'a B': 'ACurlyBracketAllowForwarding',
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
// s/x delete then (s) insert, S/C/D change/delete to end-of-line-or-line, Y yanks
// a line, X deletes left. In visual mode they operate on the selection.
const SHORTCUT_OPERATOR_BINDINGS: Record<string, string> = {
  s: 'Substitute',
  S: 'SubstituteLine',
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
  J: 'Join',
};

// Misc commands (undo/redo), available while NOT in insert mode.
const MISC_BINDINGS: Record<string, string> = {
  u: 'Undo',
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

// Jump list (ctrl-o/ctrl-i) and change list (g;/g,) — normal-mode navigation.
const JUMP_BINDINGS: Record<string, string> = {
  'ctrl-o': 'JumpBackward',
  'ctrl-i': 'JumpForward',
  'g ;': 'GoToOlderChange',
  'g ,': 'GoToNewerChange',
};

// Motions + operators are bound in every non-insert mode (notably operator-pending,
// so the motion that follows `d` resolves). Mode-entry keys (i/a) are normal-only.
const NON_INSERT_BINDINGS: Record<string, string> = {
  ...MOTION_BINDINGS,
  ...SEQUENCE_BINDINGS,
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
  ...MISC_BINDINGS,
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
  ...TEXT_OBJECT_BINDINGS,
  ...SURROUND_BINDINGS,
  ...Z_SCROLL_BINDINGS,
  ...SEARCH_MOTION_BINDINGS,
  ...JUMP_BINDINGS,
  ...MACRO_BINDINGS,
  // Visual-only commands registered under unique keys so they don't shadow the
  // normal-mode `o`/`O` (open-line) entries above — this map is only enumerated
  // for command registration, so the keys are arbitrary.
  'visual:o': 'ReverseSelections',
  'visual:O': 'BlockwiseOtherEnd',
  // Insert-mode commands, likewise under unique keys (ctrl-r/ctrl-a otherwise
  // collide with Redo / Increase).
  'insert:ctrl-w': 'DeleteToPreviousWordBoundary',
  'insert:ctrl-u': 'DeleteToBeginningOfInsertLine',
  'insert:ctrl-r': 'InsertRegister',
  'insert:ctrl-a': 'InsertLastInserted',
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

  quilx.keymaps.add('vim-mode-plus', {
    // Mode-entry keys (i/a) are normal-only; v/V activate visual from normal too.
    // Surround sequences (ys/ds/cs) start here; their operator targets resolve
    // through the operator-pending text-object bindings below.
    'GtkSourceView.normal-mode': {
      ...toKeymap(MODE_BINDINGS),
      ...toKeymap(VISUAL_BINDINGS),
      ...toKeymap(SURROUND_BINDINGS),
      // z-prefix: folds (→ editor `fold:*` commands) + zz/zt/zb cursor-line redraw.
      ...FOLD_KEYMAP,
      ...toKeymap(Z_SCROLL_BINDINGS),
      // ctrl-o/ctrl-i jump list, g;/g, change list.
      ...toKeymap(JUMP_BINDINGS),
      // q record / @ replay macros.
      ...toKeymap(MACRO_BINDINGS),
    },
    // Motions and operators apply in normal, operator-pending, and visual modes.
    'GtkSourceView:not(.insert-mode)': {
      ...toKeymap(NON_INSERT_BINDINGS),
      ...REPEAT_FIND_COMMANDS,
      ...REPEAT_COMMANDS,
      ...REGISTER_COMMANDS,
      ...COUNT_BINDINGS,
      ...ZERO_BINDING,
    },
    // In visual mode: v/V switch wise (or toggle off), text objects select, and
    // `/`/`?` extend the selection to a search match.
    'GtkSourceView.visual-mode': {
      ...toKeymap(VISUAL_BINDINGS),
      ...toKeymap(VISUAL_COMMAND_BINDINGS),
      ...toKeymap(TEXT_OBJECT_BINDINGS),
      ...toKeymap(SEARCH_MOTION_BINDINGS),
    },
    // Operator targets in operator-pending mode: text objects and `d/foo` search.
    'GtkSourceView.operator-pending-mode': {
      ...toKeymap(TEXT_OBJECT_BINDINGS),
      ...toKeymap(SEARCH_MOTION_BINDINGS),
    },
    // Escape returns to normal mode from insert, operator-pending, and visual.
    'GtkSourceView:not(.normal-mode)': {
      escape: 'vim-mode-plus:activate-normal-mode',
    },
    // Insert-mode editing commands (ctrl-w/u/r/a).
    'GtkSourceView.insert-mode': toKeymap(INSERT_BINDINGS),
  });

  // `j`/`k` → display-line motion in normal & visual mode, at a higher priority so
  // it overrides the buffer-line `j`/`k` bound above. Operator-pending is left out
  // on purpose, so `dj`/`dk` stay linewise.
  quilx.keymaps.add(
    'vim-mode-plus-display-lines',
    {
      'GtkSourceView.normal-mode': toKeymap(DISPLAY_LINE_DEFAULTS),
      'GtkSourceView.visual-mode': toKeymap(DISPLAY_LINE_DEFAULTS),
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
  };
  for (const klass of Object.values(NORMAL_OPERATIONS)) {
    commands[commandName(klass)] = () => {
      vimState.operationStack.run(klass);
    };
  }

  quilx.commands.add(editor.view, commands);
  return vimState;
}
