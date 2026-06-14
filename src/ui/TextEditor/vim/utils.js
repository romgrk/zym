/*
 * utils — the vim layer's shared helpers (the home of vim-mode-plus's utils.js).
 *
 * Vendored incrementally: only the helpers the ported core currently exercises
 * live here; the rest are brought over from upstream as motions/operators/
 * text-objects come online (phase 5+). Functions take an `editor` (EditorModel)
 * or `cursor` and stay free of Atom/DOM dependencies.
 */

/**
 * Move `cursor` one column left. With `keepGoalColumn`, the vertical-motion goal
 * column is preserved (used when normalizing the cursor off the end of a line on
 * entering normal mode). Mirrors vim-mode-plus's `moveCursorLeft`.
 */
export function moveCursorLeft(cursor, options = {}) {
  const { keepGoalColumn = false, allowWrap = false } = options
  const goalColumn = cursor.goalColumn
  if (allowWrap || !cursor.isAtBeginningOfLine()) {
    cursor.moveLeft(1, { allowWrap })
  }
  if (keepGoalColumn && goalColumn != null) cursor.goalColumn = goalColumn
}
