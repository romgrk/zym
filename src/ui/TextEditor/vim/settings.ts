/*
 * settings — the vim layer's view onto the global config.
 *
 * Stands in for vim-mode-plus's `settings` module: vendored code calls
 * `settings.get(param)` / `settings.set(param, value)` and occasionally observes
 * changes. Just as upstream reads its keys off `atom.config` under the
 * `vim-mode-plus` namespace, this registers its schema into the shared
 * `zym.config` and exposes a namespaced view — so the global config stays the
 * single source of truth and these params show up as `vim-mode-plus.*`.
 *
 * We seed only the parameters the ported core actually reads and grow the schema
 * as more of vim-mode-plus comes online; this is deliberately not a verbatim
 * port of upstream's ~100-entry config.
 */
import type { ConfigSchema } from '../../../util/Config.ts';
import { zym } from '../../../zym.ts';

const schema: Record<string, ConfigSchema> = {
  debug: {
    type: 'boolean',
    default: false,
    description: 'Log internal vim-layer activity to the console.',
  },
  startInInsertMode: {
    type: 'boolean',
    default: false,
    description: 'Enter insert mode when an editor is first attached.',
  },
  startInInsertModeScopes: {
    type: 'array',
    default: [],
    description: 'Scopes (by selector) that should start in insert mode.',
  },
  clearHighlightSearchOnResetNormalMode: {
    type: 'boolean',
    default: false,
    description: 'Clear search highlights when normal mode is reset (e.g. via Escape).',
  },
  clearPersistentSelectionOnResetNormalMode: {
    type: 'boolean',
    default: false,
    description: 'Clear persistent selections when normal mode is reset.',
  },
  autoDisableInputMethodWhenLeavingInsertMode: {
    type: 'boolean',
    default: false,
    description: 'Disable the OS input method when leaving insert mode.',
  },
  leapBidirectional: {
    type: 'boolean',
    default: true,
    description: 'Leap (g s) searches both directions from the cursor, not just forward/backward.',
  },
  leapDimEditor: {
    type: 'boolean',
    default: true,
    description: 'Dim the editor text while a leap (g s) is in progress so the jump labels stand out.',
  },
  wrapLeftRightMotion: {
    type: 'boolean',
    default: false,
    description: 'Allow h/l (and similar) to wrap across line boundaries.',
  },
  defaultScrollRowsOnMiniScroll: {
    type: 'integer',
    default: 1,
    description: 'Rows ctrl-e/ctrl-y scroll the view by when no count is given.',
  },
  allowCursorPastEndOfLine: {
    type: 'boolean',
    default: true,
    description:
      "Let the cursor rest one column past the last character in normal mode (vim's `virtualedit=onemore`). Off restores the classic vim resting position on the last character.",
  },
  useClipboardAsDefaultRegister: {
    type: 'boolean',
    default: true,
    description: 'Yank/paste through the system clipboard by default (like vim clipboard=unnamedplus). Set false for vim-classic separate registers.',
  },
  sequentialPaste: {
    type: 'boolean',
    default: true,
    description:
      'Pressing the same paste command again replaces the just-pasted text with the next entry in the yank history (a yank-pop ring). Off restores classic `pp` = paste twice.',
  },
  sequentialPasteMaxHistory: {
    type: 'integer',
    default: 8,
    description: 'How many recent yanks/deletes the sequential-paste history keeps.',
  },
  numberRegex: {
    type: 'string',
    default: '-?[0-9]+',
    description: 'Pattern used to find numbers under the cursor for increment/decrement.',
  },
  strictAssertion: {
    type: 'boolean',
    default: false,
    description: 'Throw on internal assertion failures instead of logging.',
  },

  // --- Operator behavior ---
  blackholeRegisteredOperators: {
    type: 'array',
    default: [],
    description: 'Operators (by command name) that write to the blackhole register.',
  },
  flashOnOperate: {
    type: 'boolean',
    default: true,
    description: 'Flash the operated-on range after an operator runs (e.g. a yank).',
  },
  flashOnOperateBlacklist: {
    type: 'array',
    default: [],
    description: 'Operators that never flash, even when flashOnOperate is on.',
  },
  autoSelectPersistentSelectionOnOperate: {
    type: 'boolean',
    default: false,
    description: 'Include persistent selections as operator targets automatically.',
  },
  stayOnDelete: {
    type: 'boolean',
    default: false,
    description: "Keep the cursor in place after delete instead of vim's default move.",
  },
  stayOnYank: {
    type: 'boolean',
    default: false,
    description: 'Keep the cursor in place after yank.',
  },
  stayOnChange: {
    type: 'boolean',
    default: false,
    description: 'Keep the cursor in place after change.',
  },
  stayOnOccurrence: {
    type: 'boolean',
    default: true,
    description: 'Keep the cursor in place when operating on occurrences.',
  },

  // --- Motion behavior ---
  jumpListMinLines: {
    type: 'integer',
    default: 6,
    minimum: 0,
    description:
      'Any motion that moves the cursor at least this many lines records a jump-list entry (ctrl-o / ctrl-i), on top of the classic vim jump motions (G, search, etc). 0 records classic jumps only.',
  },
  stayOnVerticalMotion: {
    type: 'boolean',
    default: false,
    description: 'Keep the column on j/k instead of moving to the first character.',
  },
  useLanguageIndependentNonWordCharacters: {
    type: 'boolean',
    default: false,
    description: 'Use a fixed non-word character set for word motions, ignoring grammar.',
  },

  // --- Find motions (f/F/t/T) ---
  findCharsMax: {
    type: 'integer',
    default: 1,
    description: 'How many characters f/F/t/T read before jumping (1 = classic vim).',
  },
  findAcrossLines: {
    type: 'boolean',
    default: true,
    description: 'Let f/F/t/T search beyond the cursor line. Off restores classic single-line vim find.',
  },
  reuseFindForRepeatFind: {
    type: 'boolean',
    default: false,
    description: 'Pressing the same find key again repeats the last find instead of re-reading input.',
  },
  highlightFindChar: {
    type: 'boolean',
    default: false,
    description: 'Highlight matches of the find character on the cursor rows.',
  },
  ignoreCaseForFind: {
    type: 'boolean',
    default: false,
    description: 'Make f/F/t/T case-insensitive.',
  },
  useSmartcaseForFind: {
    type: 'boolean',
    default: false,
    description: 'Case-insensitive find unless the input has an uppercase character.',
  },

  // --- Transform-string operators (case, replace-char, surround) ---
  stayOnTransformString: {
    type: 'boolean',
    default: false,
    description: 'Keep the cursor in place after a transform-string operator (gU/gu/g~/surround).',
  },
  replaceByDiffOnSurround: {
    type: 'boolean',
    default: false,
    description: 'Apply surround edits as a minimal diff (preserves markers) instead of whole-range replace.',
  },
  customSurroundPairs: {
    type: 'string',
    default: '{}',
    description: 'JSON map of surround alias → [open, close] pairs, layered over the built-ins.',
  },
  charactersToAddSpaceOnSurround: {
    type: 'array',
    default: [],
    description: 'Surround characters that wrap the text in spaces (e.g. add a space inside brackets).',
  },

  // --- Undo / redo ---
  setCursorToStartOfChangeOnUndoRedo: {
    type: 'boolean',
    default: true,
    description: 'Move the cursor to the start of the change after undo/redo.',
  },
  setCursorToStartOfChangeOnUndoRedoStrategy: {
    type: 'string',
    default: 'simple',
    enum: ['simple', 'smart'],
    description:
      "How the cursor finds the change after undo/redo. 'simple' always lands on the start of the earliest changed range; 'smart' only repositions into a re-inserted range that already contains the cursor.",
  },
  flashOnUndoRedo: {
    type: 'boolean',
    default: true,
    description: 'Flash the changed range after undo/redo.',
  },
};

export const settings = zym.config.scope('vim-mode-plus').register(schema);
export default settings;
