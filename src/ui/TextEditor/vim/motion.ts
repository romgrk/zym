// Vendored from xedel/vim-mode-plus's lib/motion.js — ESM conversion only:
// `require`→`import`, and the trailing `module.exports` map becomes eager
// registration (each class self-registers on import) plus a default export.
// Motion logic is unchanged.
import { Point } from '../../../text/Point.ts'
import { Range } from '../../../text/Range.ts'
import { Base } from './base.ts'
import type { Cursor } from '../Cursor.ts'
import type { ScanOptions } from './utils.ts'

/** A buffer wise — how a motion/selection spans the buffer. */
type Wise = 'characterwise' | 'linewise' | 'blockwise'
/** Direction discriminant used across the motion subclasses. */
type Direction = 'next' | 'previous' | 'up' | 'down' | null

class Motion extends Base {
  static operationKind = 'motion'
  static command = false

  // `operator` is dynamically dispatched (`.instanceof`, `.name`); Base types it
  // `Operator | undefined`, motions also assign `null`, so keep it loose.
  operator: any = null // TODO(vim-ts): tighten
  inclusive = false
  wise: Wise = 'characterwise'
  jump = false
  verticalMotion = false
  moveSucceeded: boolean | null = null
  moveSuccessOnLinewise = false
  selectSucceeded = false
  requireInput = false
  caseSensitivityKind: string | null = null

  // moveCursor is the per-cursor primitive every concrete motion overrides.
  moveCursor (_cursor: Cursor): void {}

  isReady (): boolean {
    return !this.requireInput || this.input != null
  }

  isLinewise (): boolean {
    return this.wise === 'linewise'
  }

  isBlockwise (): boolean {
    return this.wise === 'blockwise'
  }

  forceWise (wise: Wise): void {
    if (wise === 'characterwise') {
      this.inclusive = this.wise === 'linewise' ? false : !this.inclusive
    }
    this.wise = wise
  }

  resetState (): void {
    this.selectSucceeded = false
  }

  moveWithSaveJump (cursor: Cursor): void {
    const originalPosition = this.jump && cursor.isLastCursor() ? cursor.getBufferPosition() : undefined

    this.moveCursor(cursor)

    if (originalPosition && !cursor.getBufferPosition().isEqual(originalPosition)) {
      this.vimState.mark.set('`', originalPosition)
      this.vimState.mark.set("'", originalPosition)
      // Record the jump for ctrl-o/ctrl-i. Only for true motions — operator
      // targets (e.g. `d}`) don't populate the jump list in Vim.
      if (!this.operator) this.vimState.jumpList.add(originalPosition)
    }
  }

  execute (): void {
    if (this.operator) {
      this.select()
    } else {
      for (const cursor of this.editor.getCursors()) {
        this.moveWithSaveJump(cursor)
      }
    }
    this.editor.mergeCursors()
    this.editor.mergeIntersectingSelections()
  }

  // NOTE: selection is already "normalized" before this function is called.
  select (): void {
    // need to care was visual for `.` repeated.
    const isOrWasVisual = this.operator.instanceof('SelectBase') || this.name === 'CurrentSelection'

    for (const selection of this.editor.getSelections()) {
      selection.modifySelection(() => this.moveWithSaveJump(selection.cursor))

      const selectSucceeded =
        this.moveSucceeded != null
          ? this.moveSucceeded
          : !selection.isEmpty() || (this.isLinewise() && this.moveSuccessOnLinewise)
      if (!this.selectSucceeded) this.selectSucceeded = selectSucceeded

      if (isOrWasVisual || (selectSucceeded && (this.inclusive || this.isLinewise()))) {
        const $selection = this.swrap(selection)
        $selection.saveProperties(true) // save property of "already-normalized-selection"
        $selection.applyWise(this.wise)
      }
    }

    if (this.wise === 'blockwise') {
      this.vimState.getLastBlockwiseSelection().autoscroll()
    }
  }

  setCursorBufferRow (cursor: Cursor, row: number, options?: any): void {
    if (this.verticalMotion && !this.getConfig('stayOnVerticalMotion')) {
      cursor.setBufferPosition(this.getFirstCharacterPositionForBufferRow(row)!, options)
    } else {
      this.utils.setBufferRow(cursor, row, options)
    }
  }

  // Call callback count times.
  // But break iteration when cursor position did not change before/after callback.
  moveCursorCountTimes (cursor: Cursor, fn: (state: {count: number, isFinal: boolean, stop: () => void}) => void): void {
    let oldPosition = cursor.getBufferPosition()
    this.countTimes(this.getCount(), state => {
      fn(state)
      const newPosition = cursor.getBufferPosition()
      if (newPosition.isEqual(oldPosition)) state.stop()
      oldPosition = newPosition
    })
  }

  isCaseSensitive (term: string): boolean {
    if (this.getConfig(`useSmartcaseFor${this.caseSensitivityKind}`)) {
      return term.search(/[A-Z]/) !== -1
    } else {
      return !this.getConfig(`ignoreCaseFor${this.caseSensitivityKind}`)
    }
  }

  getLastResortPoint (direction: Direction): Point {
    if (direction === 'next') {
      return this.getVimEofBufferPosition()
    } else {
      return new Point(0, 0)
    }
  }
}

// Used as operator's target in visual-mode.
class CurrentSelection extends Motion {
  static command = false
  selectionExtent: any = null // TODO(vim-ts): tighten (PointLike extent)
  blockwiseSelectionExtent: any = null // TODO(vim-ts): tighten
  inclusive = true
  pointInfoByCursor = new Map<Cursor, {cursorPosition: Point, startOfSelection: Point}>()

  moveCursor (cursor: Cursor): void {
    if (this.mode === 'visual') {
      this.selectionExtent = this.isBlockwise()
        ? this.swrap(cursor.selection).getBlockwiseSelectionExtent()
        : this.editor.getSelectedBufferRange().getExtent()
    } else {
      // `.` repeat case
      cursor.setBufferPosition(cursor.getBufferPosition().translate(this.selectionExtent))
    }
  }

  select (): void {
    if (this.mode === 'visual') {
      super.select()
    } else {
      for (const cursor of this.editor.getCursors()) {
        const pointInfo = this.pointInfoByCursor.get(cursor)
        if (pointInfo) {
          const {cursorPosition, startOfSelection} = pointInfo
          if (cursorPosition.isEqual(cursor.getBufferPosition())) {
            cursor.setBufferPosition(startOfSelection)
          }
        }
      }
      super.select()
    }

    // * Purpose of pointInfoByCursor? see #235 for detail.
    // When stayOnTransformString is enabled, cursor pos is not set on start of
    // of selected range.
    // But I want following behavior, so need to preserve position info.
    //  1. `vj>.` -> indent same two rows regardless of current cursor's row.
    //  2. `vj>j.` -> indent two rows from cursor's row.
    for (const cursor of this.editor.getCursors()) {
      const startOfSelection = cursor.selection.getBufferRange().start
      this.onDidFinishOperation(() => {
        const cursorPosition = cursor.getBufferPosition()
        this.pointInfoByCursor.set(cursor, {startOfSelection, cursorPosition})
      })
    }
  }
}

class MoveLeft extends Motion {
  moveCursor (cursor: Cursor): void {
    const allowWrap = this.getConfig('wrapLeftRightMotion')
    this.moveCursorCountTimes(cursor, () => {
      this.utils.moveCursorLeft(cursor, {allowWrap})
    })
  }
}

class MoveRight extends Motion {
  moveCursor (cursor: Cursor): void {
    const allowWrap = this.getConfig('wrapLeftRightMotion')

    this.moveCursorCountTimes(cursor, () => {
      this.editor.unfoldBufferRow(cursor.getBufferRow())

      // - When `wrapLeftRightMotion` enabled and executed as pure-motion in `normal-mode`,
      //   we need to move **again** to wrap to next-line if it rached to EOL.
      // - Expression `!this.operator` means normal-mode motion.
      // - Expression `this.mode === "normal"` is not appropreate since it matches `x` operator's target case.
      const needMoveAgain = allowWrap && !this.operator && !cursor.isAtEndOfLine()

      this.utils.moveCursorRight(cursor, {allowWrap})

      if (needMoveAgain && cursor.isAtEndOfLine()) {
        this.utils.moveCursorRight(cursor, {allowWrap})
      }
    })
  }
}

class MoveRightBufferColumn extends Motion {
  static command = false
  moveCursor (cursor: Cursor): void {
    this.utils.setBufferColumn(cursor, cursor.getBufferColumn() + this.getCount())
  }
}

class MoveUp extends Motion {
  wise: Wise = 'linewise'
  wrap = false
  direction: Direction = 'up'

  getBufferRow (row: number): number {
    const min = 0
    const max = this.getVimLastBufferRow()

    if (this.direction === 'up') {
      row = this.getFoldStartRowForRow(row) - 1
      row = this.wrap && row < min ? max : this.limitNumber(row, {min})
    } else {
      row = this.getFoldEndRowForRow(row) + 1
      row = this.wrap && row > max ? min : this.limitNumber(row, {max})
    }
    return this.getFoldStartRowForRow(row)
  }

  moveCursor (cursor: Cursor): void {
    this.moveCursorCountTimes(cursor, () => {
      const row = this.getBufferRow(cursor.getBufferRow())
      this.utils.setBufferRow(cursor, row)
    })
  }
}

class MoveUpWrap extends MoveUp {
  wrap = true
}

class MoveDown extends MoveUp {
  direction: Direction = 'down'
}

class MoveDownWrap extends MoveDown {
  wrap = true
}

class MoveUpScreen extends Motion {
  wise: Wise = 'linewise'
  direction: Direction = 'up'
  moveCursor (cursor: Cursor): void {
    this.moveCursorCountTimes(cursor, () => {
      this.utils.moveCursorUpScreen(cursor)
    })
  }
}

class MoveDownScreen extends MoveUpScreen {
  wise: Wise = 'linewise'
  direction: Direction = 'down'
  moveCursor (cursor: Cursor): void {
    this.moveCursorCountTimes(cursor, () => {
      this.utils.moveCursorDownScreen(cursor)
    })
  }
}

// `gk` / `gj` — move by display (soft-wrapped) line, keeping the visual column.
// Exclusive characterwise (unlike the linewise `j`/`k`), matching Vim's gj/gk, so
// `dgj` deletes to the same column one display line down. The geometry lives in
// EditorModel.displayLineMove; headless it falls back to a buffer-line step.
class MoveUpDisplayLine extends Motion {
  direction: Direction = 'up'
  moveCursor (cursor: Cursor): void {
    this.moveCursorCountTimes(cursor, () => cursor.moveDisplayUp())
  }
}

class MoveDownDisplayLine extends MoveUpDisplayLine {
  direction: Direction = 'down'
  moveCursor (cursor: Cursor): void {
    this.moveCursorCountTimes(cursor, () => cursor.moveDisplayDown())
  }
}

class MoveUpToEdge extends Motion {
  wise: Wise = 'linewise'
  jump = true
  direction: 'previous' | 'next' = 'previous'
  moveCursor (cursor: Cursor): void {
    this.moveCursorCountTimes(cursor, () => {
      const point = this.getPoint(cursor.getScreenPosition())
      if (point) cursor.setScreenPosition(point)
    })
  }

  getPoint (fromPoint: Point): Point | undefined {
    const {column, row: startRow} = fromPoint
    for (const row of this.getScreenRows({startRow, direction: this.direction})) {
      const point = new Point(row, column)
      if (this.isEdge(point)) return point
    }
  }

  isEdge (point: Point): boolean {
    // If point is stoppable and above or below point is not stoppable, it's Edge!
    return (
      this.isStoppable(point) &&
      (!this.isStoppable(point.translate([-1, 0])) || !this.isStoppable(point.translate([+1, 0])))
    )
  }

  isStoppable (point: Point): boolean {
    return (
      this.isNonWhiteSpace(point) ||
      this.isFirstRowOrLastRowAndStoppable(point) ||
      // If right or left column is non-white-space char, it's stoppable.
      (this.isNonWhiteSpace(point.translate([0, -1])) && this.isNonWhiteSpace(point.translate([0, +1])))
    )
  }

  isNonWhiteSpace (point: Point): boolean {
    const char = this.utils.getTextInScreenRange(this.editor, Range.fromPointWithDelta(point, 0, 1))
    return char != null && /\S/.test(char)
  }

  isFirstRowOrLastRowAndStoppable (point: Point): boolean {
    // In notmal-mode, cursor is NOT stoppable to EOL of non-blank row.
    // So explicitly guard to not answer it stoppable.
    if (this.mode === 'normal' && this.utils.pointIsAtEndOfLineAtNonEmptyRow(this.editor, point)) {
      return false
    }

    // If clipped, it means that original ponit was non stoppable(e.g. point.colum > EOL).
    const {row} = point
    return (row === 0 || row === this.getVimLastScreenRow()) && point.isEqual(this.editor.clipScreenPosition(point))
  }
}

class MoveDownToEdge extends MoveUpToEdge {
  direction: 'previous' | 'next' = 'next'
}

// Word Motion family
// +----------------------------------------------------------------------------+
// | direction | which      | word  | WORD | subword | smartword | alphanumeric |
// |-----------+------------+-------+------+---------+-----------+--------------+
// | next      | word-start | w     | W    | -       | -         | -            |
// | previous  | word-start | b     | b    | -       | -         | -            |
// | next      | word-end   | e     | E    | -       | -         | -            |
// | previous  | word-end   | ge    | g E  | n/a     | n/a       | n/a          |
// +----------------------------------------------------------------------------+

class MotionByWord extends Motion {
  static command = false
  wordRegex: RegExp | null = null
  direction: 'previous' | 'next' | null = null
  which: 'start' | 'end' | null = null
  skipBlankRow = false
  skipEmptyRow = false
  skipWhiteSpaceOnlyRow = false

  moveCursor (cursor: Cursor): void {
    this.moveCursorCountTimes(cursor, countState => {
      cursor.setBufferPosition(this.getPoint(cursor, countState))
    })
  }

  getPoint (cursor: Cursor, countState: {count: number, isFinal: boolean, stop: () => void}): Point | [number, number] {
    const direction = this.direction! // always set by concrete word motions
    let which = this.which! // always set by concrete word motions
    const regex = this.getWordRegexForCursor(cursor)

    const from = cursor.getBufferPosition()
    if (direction === 'next' && which === 'start' && this.operator && countState.isFinal) {
      // [NOTE] Exceptional behavior for w and W: [Detail in vim help `:help w`.]
      // [case-A] cw, cW treated as ce, cE when cursor is at non-blank.
      // [case-B] when w, W used as TARGET, it doesn't move over new line.
      if (this.isEmptyRow(from.row)) return [from.row + 1, 0]

      // [case-A]
      if (this.operator.name === 'Change' && !this.utils.pointIsAtWhiteSpace(this.editor, from)) {
        which = 'end'
      }
      const point = this.findPoint(direction, regex, which, this.buildOptions(from))
      // [case-B]
      return point ? Point.min(point, [from.row, Infinity]) : this.getLastResortPoint(direction)
    } else {
      return this.findPoint(direction, regex, which, this.buildOptions(from)) || this.getLastResortPoint(direction)
    }
  }

  buildOptions (from: Point): any {
    return {
      from: from,
      skipEmptyRow: this.skipEmptyRow,
      skipWhiteSpaceOnlyRow: this.skipWhiteSpaceOnlyRow,
      preTranslate: (this.which === 'end' && [0, +1]) || undefined,
      postTranslate: (this.which === 'end' && [0, -1]) || undefined
    }
  }

  getWordRegexForCursor (cursor: Cursor): RegExp {
    if (this.name.endsWith('Subword')) {
      return cursor.subwordRegExp()
    }

    if (this.wordRegex) {
      return this.wordRegex
    }

    if (this.getConfig('useLanguageIndependentNonWordCharacters')) {
      const nonWordCharacters = this._.escapeRegExp(this.utils.getNonWordCharactersForCursor(cursor))
      const source = `^[\\t\\r ]*$|[^\\s${nonWordCharacters}]+|[${nonWordCharacters}]+`
      return new RegExp(source, 'g')
    }
    return cursor.wordRegExp()
  }
}

// w
class MoveToNextWord extends MotionByWord {
  direction: 'previous' | 'next' = 'next'
  which: 'start' | 'end' | null = 'start'
}

// W
class MoveToNextWholeWord extends MoveToNextWord {
  wordRegex = /^$|\S+/g
}

// no-keymap
class MoveToNextSubword extends MoveToNextWord {}

// no-keymap
class MoveToNextSmartWord extends MoveToNextWord {
  wordRegex = /[\w-]+/g
}

// no-keymap
class MoveToNextAlphanumericWord extends MoveToNextWord {
  wordRegex = /\w+/g
}

// b
class MoveToPreviousWord extends MotionByWord {
  direction: 'previous' | 'next' = 'previous'
  which: 'start' | 'end' | null = 'start'
  skipWhiteSpaceOnlyRow = true
}

// B
class MoveToPreviousWholeWord extends MoveToPreviousWord {
  wordRegex = /^$|\S+/g
}

// no-keymap
class MoveToPreviousSubword extends MoveToPreviousWord {}

// no-keymap
class MoveToPreviousSmartWord extends MoveToPreviousWord {
  wordRegex = /[\w-]+/
}

// no-keymap
class MoveToPreviousAlphanumericWord extends MoveToPreviousWord {
  wordRegex = /\w+/
}

// e
class MoveToEndOfWord extends MotionByWord {
  inclusive = true
  direction: 'previous' | 'next' = 'next'
  which: 'start' | 'end' | null = 'end'
  skipEmptyRow = true
  skipWhiteSpaceOnlyRow = true
}

// E
class MoveToEndOfWholeWord extends MoveToEndOfWord {
  wordRegex = /\S+/g
}

// no-keymap
class MoveToEndOfSubword extends MoveToEndOfWord {}

// no-keymap
class MoveToEndOfSmartWord extends MoveToEndOfWord {
  wordRegex = /[\w-]+/g
}

// no-keymap
class MoveToEndOfAlphanumericWord extends MoveToEndOfWord {
  wordRegex = /\w+/g
}

// ge
class MoveToPreviousEndOfWord extends MotionByWord {
  inclusive = true
  direction: 'previous' | 'next' = 'previous'
  which: 'start' | 'end' | null = 'end'
  skipWhiteSpaceOnlyRow = true
}

// gE
class MoveToPreviousEndOfWholeWord extends MoveToPreviousEndOfWord {
  wordRegex = /\S+/g
}

// no-keymap by default; bound to `ge` when subword motions are the default.
// Picks the subword regex via the `endsWith('Subword')` check in MotionByWord.
class MoveToPreviousEndOfSubword extends MoveToPreviousEndOfWord {}

// Sentence
// -------------------------
// Sentence is defined as below
//  - end with ['.', '!', '?']
//  - optionally followed by [')', ']', '"', "'"]
//  - followed by ['$', ' ', '\t']
//  - paragraph boundary is also sentence boundary
//  - section boundary is also sentence boundary(ignore)
class MoveToNextSentence extends Motion {
  jump = true
  sentenceRegex = new RegExp(`(?:[\\.!\\?][\\)\\]"']*\\s+)|(\\n|\\r\\n)`, 'g')
  direction: Direction = 'next'
  skipBlankRow = false

  moveCursor (cursor: Cursor): void {
    this.moveCursorCountTimes(cursor, () => {
      const point =
        this.direction === 'next'
          ? this.getNextStartOfSentence(cursor.getBufferPosition())
          : this.getPreviousStartOfSentence(cursor.getBufferPosition())
      cursor.setBufferPosition(point || this.getLastResortPoint(this.direction))
    })
  }

  isBlankRow (row: number): boolean {
    return this.editor.isBufferRowBlank(row)
  }

  getNextStartOfSentence (from: Point): Point | undefined {
    return this.findInEditor('forward', this.sentenceRegex, {from}, ({range, match}: {range: Range, match: RegExpMatchArray}) => {
      if (match[1] != null) {
        const [startRow, endRow] = [range.start.row, range.end.row]
        if (this.skipBlankRow && this.isBlankRow(endRow)) return
        if (this.isBlankRow(startRow) !== this.isBlankRow(endRow)) {
          return this.getFirstCharacterPositionForBufferRow(endRow)
        }
      } else {
        return range.end
      }
    })
  }

  getPreviousStartOfSentence (from: Point): Point | undefined {
    return this.findInEditor('backward', this.sentenceRegex, {from}, ({range, match}: {range: Range, match: RegExpMatchArray}) => {
      if (match[1] != null) {
        const [startRow, endRow] = [range.start.row, range.end.row]
        if (!this.isBlankRow(endRow) && this.isBlankRow(startRow)) {
          const point = this.getFirstCharacterPositionForBufferRow(endRow)
          if (point!.isLessThan(from)) return point
          else if (!this.skipBlankRow) return this.getFirstCharacterPositionForBufferRow(startRow)
        }
      } else if (range.end.isLessThan(from)) {
        return range.end
      }
    })
  }
}

class MoveToPreviousSentence extends MoveToNextSentence {
  direction: Direction = 'previous'
}

class MoveToNextSentenceSkipBlankRow extends MoveToNextSentence {
  skipBlankRow = true
}

class MoveToPreviousSentenceSkipBlankRow extends MoveToPreviousSentence {
  skipBlankRow = true
}

// Paragraph
// -------------------------
class MoveToNextParagraph extends Motion {
  jump = true
  direction: 'previous' | 'next' = 'next'

  moveCursor (cursor: Cursor): void {
    this.moveCursorCountTimes(cursor, () => {
      const point = this.getPoint(cursor.getBufferPosition())
      cursor.setBufferPosition(point || this.getLastResortPoint(this.direction))
    })
  }

  getPoint (from: Point): [number, number] | undefined {
    let wasBlankRow = this.editor.isBufferRowBlank(from.row)
    const rows = this.getBufferRows({startRow: from.row, direction: this.direction})
    for (const row of rows) {
      const isBlankRow = this.editor.isBufferRowBlank(row)
      if (!wasBlankRow && isBlankRow) {
        return [row, 0]
      }
      wasBlankRow = isBlankRow
    }
  }
}

class MoveToPreviousParagraph extends MoveToNextParagraph {
  direction: 'previous' | 'next' = 'previous'
}

class MoveToNextDiffHunk extends Motion {
  jump = true
  direction: 'previous' | 'next' = 'next'

  moveCursor (cursor: Cursor): void {
    this.moveCursorCountTimes(cursor, () => {
      const point = this.getPoint(cursor.getBufferPosition())
      if (point) cursor.setBufferPosition(point)
    })
  }

  getPoint (from: Point): Point | undefined {
    const getHunkRange = (row: number) => this.utils.getHunkRangeAtBufferRow(this.editor, row)
    const hunkRange = getHunkRange(from.row)
    return this.findInEditor(this.direction, /^[+-]/g, {from}, ({range}: {range: Range}) => {
      if (hunkRange && hunkRange.containsPoint(range.start)) return

      return getHunkRange(range.start.row)!.start
    })
  }
}

class MoveToPreviousDiffHunk extends MoveToNextDiffHunk {
  direction: 'previous' | 'next' = 'previous'
}

// `]h` / `[h` — jump to the next/previous git hunk in a live-edited file (the
// GitGutter change bars), as opposed to MoveTo{Next,Previous}DiffHunk above
// which scan a synthesized +/- diff buffer. Hunk start rows come from the host
// via the EditorModel hunk provider; no provider (buffer-only / no repo) → no-op.
class MotionByHunk extends Motion {
  static command = false
  jump = true
  direction: Direction = null

  getRows (): number[] {
    const rows = this.editor.getHunkStartRows()
    return this.direction === 'previous' ? rows.slice().reverse() : rows
  }

  findRow (cursor: Cursor): number | undefined {
    const cursorRow = cursor.getBufferRow()
    return this.getRows().find(row =>
      this.direction === 'previous' ? row < cursorRow : row > cursorRow
    )
  }

  moveCursor (cursor: Cursor): void {
    this.moveCursorCountTimes(cursor, () => {
      const row = this.findRow(cursor)
      if (row != null) this.utils.moveCursorToFirstCharacterAtRow(cursor, row)
    })
  }
}

class MoveToNextHunk extends MotionByHunk {
  direction: Direction = 'next'
}

class MoveToPreviousHunk extends MotionByHunk {
  direction: Direction = 'previous'
}

// `]d` / `[d` — jump to the next/previous LSP diagnostic in the file, landing on
// its exact start (row + column, so several diagnostics on one line are distinct).
// Positions come from the host via the EditorModel diagnostic provider; no
// provider (buffer-only / no LSP) → no-op.
class MotionByDiagnostic extends Motion {
  static command = false
  jump = true
  direction: Direction = null

  getPositions (): Point[] {
    const positions = this.editor.getDiagnosticPositions()
    return this.direction === 'previous' ? positions.slice().reverse() : positions
  }

  findPosition (cursor: Cursor): Point | undefined {
    const from = cursor.getBufferPosition()
    return this.getPositions().find(point =>
      this.direction === 'previous' ? point.isLessThan(from) : point.isGreaterThan(from)
    )
  }

  moveCursor (cursor: Cursor): void {
    this.moveCursorCountTimes(cursor, () => {
      const point = this.findPosition(cursor)
      if (point) cursor.setBufferPosition(point)
    })
  }
}

class MoveToNextDiagnostic extends MotionByDiagnostic {
  direction: Direction = 'next'
}

class MoveToPreviousDiagnostic extends MotionByDiagnostic {
  direction: Direction = 'previous'
}

// -------------------------
// keymap: 0
class MoveToBeginningOfLine extends Motion {
  moveCursor (cursor: Cursor): void {
    this.utils.setBufferColumn(cursor, 0)
  }
}

class MoveToColumn extends Motion {
  moveCursor (cursor: Cursor): void {
    this.utils.setBufferColumn(cursor, this.getCount() - 1)
  }
}

class MoveToLastCharacterOfLine extends Motion {
  moveCursor (cursor: Cursor): void {
    const row = this.getValidVimBufferRow(cursor.getBufferRow() + this.getCount() - 1)
    cursor.setBufferPosition([row, Infinity])
    cursor.goalColumn = Infinity
  }
}

class MoveToLastNonblankCharacterOfLineAndDown extends Motion {
  inclusive = true

  moveCursor (cursor: Cursor): void {
    const row = this.limitNumber(cursor.getBufferRow() + this.getCount() - 1, {max: this.getVimLastBufferRow()})
    const options: ScanOptions = {from: [row, Infinity], allowNextLine: false}
    const point = this.findInEditor('backward', /\S|^/, options, (event: {range: Range}) => event.range.start)
    if (point) cursor.setBufferPosition(point)
  }
}

// MoveToFirstCharacterOfLine faimily
// ------------------------------------
// ^
// Toggle between the first non-blank character and column 0 (going to ^ first).
class MoveToFirstCharacterOfLine extends Motion {
  moveCursor (cursor: Cursor): void {
    const firstCharacterPoint = this.getFirstCharacterPositionForBufferRow(cursor.getBufferRow())!
    if (cursor.getBufferColumn() === firstCharacterPoint.column && firstCharacterPoint.column !== 0) {
      this.utils.setBufferColumn(cursor, 0)
    } else {
      cursor.setBufferPosition(firstCharacterPoint)
    }
  }
}

class MoveToFirstCharacterOfLineUp extends MoveToFirstCharacterOfLine {
  wise: Wise = 'linewise'
  moveCursor (cursor: Cursor): void {
    this.moveCursorCountTimes(cursor, () => {
      const row = this.getValidVimBufferRow(cursor.getBufferRow() - 1)
      cursor.setBufferPosition([row, 0])
    })
    super.moveCursor(cursor)
  }
}

class MoveToFirstCharacterOfLineDown extends MoveToFirstCharacterOfLine {
  wise: Wise = 'linewise'
  moveCursor (cursor: Cursor): void {
    this.moveCursorCountTimes(cursor, () => {
      const point = cursor.getBufferPosition()
      if (point.row < this.getVimLastBufferRow()) {
        cursor.setBufferPosition(point.translate([+1, 0]))
      }
    })
    super.moveCursor(cursor)
  }
}

class MoveToFirstCharacterOfLineAndDown extends MoveToFirstCharacterOfLineDown {
  getCount () {
    return super.getCount() - 1
  }
}

class MoveToScreenColumn extends Motion {
  static command = false
  which: 'beginning' | 'last-character' | 'first-character' = 'beginning'
  moveCursor (cursor: Cursor): void {
    const point = this.utils.getScreenPositionForScreenRow(this.editor, cursor.getScreenRow(), this.which, {
      allowOffScreenPosition: this.getConfig('allowMoveToOffScreenColumnOnScreenLineMotion')
    })
    if (point) cursor.setScreenPosition(point)
  }
}

// keymap: g 0
class MoveToBeginningOfScreenLine extends MoveToScreenColumn {
  which: 'beginning' | 'last-character' | 'first-character' = 'beginning'
}

// g ^: `move-to-first-character-of-screen-line`
class MoveToFirstCharacterOfScreenLine extends MoveToScreenColumn {
  which: 'beginning' | 'last-character' | 'first-character' = 'first-character'
}

// keymap: g $
class MoveToLastCharacterOfScreenLine extends MoveToScreenColumn {
  which: 'beginning' | 'last-character' | 'first-character' = 'last-character'
}

// keymap: g g
class MoveToFirstLine extends Motion {
  wise: Wise = 'linewise'
  jump = true
  verticalMotion = true
  moveSuccessOnLinewise = true

  moveCursor (cursor: Cursor): void {
    this.setCursorBufferRow(cursor, this.getValidVimBufferRow(this.getRow()))
    cursor.autoscroll({center: true})
  }

  getRow (): number {
    return this.getCount() - 1
  }
}

// keymap: G
class MoveToLastLine extends MoveToFirstLine {
  defaultCount = Infinity
}

// keymap: N% e.g. 10%
class MoveToLineByPercent extends MoveToFirstLine {
  getRow (): number {
    const percent = this.limitNumber(this.getCount(), {max: 100})
    return Math.floor(this.getVimLastBufferRow() * (percent / 100))
  }
}

class MoveToRelativeLine extends Motion {
  static command = false
  wise: Wise = 'linewise'
  moveSuccessOnLinewise = true

  moveCursor (cursor: Cursor): void {
    let row: any // TODO(vim-ts): fold-row helpers return any
    let count = this.getCount()
    if (count < 0) {
      // Support negative count
      // Negative count can be passed like `operationStack.run("MoveToRelativeLine", {count: -5})`.
      // Currently used in vim-mode-plus-ex-mode pkg.
      while (count++ < 0) {
        row = this.getFoldStartRowForRow(row == null ? cursor.getBufferRow() : row - 1)
        if (row <= 0) break
      }
    } else {
      const maxRow = this.getVimLastBufferRow()
      while (count-- > 0) {
        row = this.getFoldEndRowForRow(row == null ? cursor.getBufferRow() : row + 1)
        if (row >= maxRow) break
      }
    }
    this.utils.setBufferRow(cursor, row)
  }
}

class MoveToRelativeLineMinimumTwo extends MoveToRelativeLine {
  static command = false
  getCount (): number {
    return this.limitNumber(super.getCount(), {min: 2})
  }
}

// Position cursor without scrolling., H, M, L
// -------------------------
// keymap: H
class MoveToTopOfScreen extends Motion {
  wise: Wise = 'linewise'
  jump = true
  defaultCount = 0
  verticalMotion = true

  moveCursor (cursor: Cursor): void {
    const bufferRow = this.editor.bufferRowForScreenRow(this.getScreenRow() as number)
    this.setCursorBufferRow(cursor, bufferRow)
  }

  // Returns one of three branches keyed on `this.name`; TS can't see exhaustiveness.
  getScreenRow (): number | undefined {
    const firstVisibleRow = this.editor.getFirstVisibleScreenRow()
    const lastVisibleRow = this.limitNumber(this.editor.getLastVisibleScreenRow(), {max: this.getVimLastScreenRow()})

    const baseOffset = 2
    if (this.name === 'MoveToTopOfScreen') {
      const offset = firstVisibleRow === 0 ? 0 : baseOffset
      const count = this.getCount() - 1
      return this.limitNumber(firstVisibleRow + count, {min: firstVisibleRow + offset, max: lastVisibleRow})
    } else if (this.name === 'MoveToMiddleOfScreen') {
      return firstVisibleRow + Math.floor((lastVisibleRow - firstVisibleRow) / 2)
    } else if (this.name === 'MoveToBottomOfScreen') {
      const offset = lastVisibleRow === this.getVimLastScreenRow() ? 0 : baseOffset + 1
      const count = this.getCount() - 1
      return this.limitNumber(lastVisibleRow - count, {min: firstVisibleRow, max: lastVisibleRow - offset})
    }
  }
}

class MoveToMiddleOfScreen extends MoveToTopOfScreen {} // keymap: M
class MoveToBottomOfScreen extends MoveToTopOfScreen {} // keymap: L

// Scrolling
// Half: ctrl-d, ctrl-u
// Full: ctrl-f, ctrl-b
// -------------------------
// [FIXME] count behave differently from original Vim.
class Scroll extends Motion {
  static command = false
  static scrollTask: any = null
  static amountOfPageByName: Record<string, number> = {
    ScrollFullScreenDown: 1,
    ScrollFullScreenUp: -1,
    ScrollHalfScreenDown: 0.5,
    ScrollHalfScreenUp: -0.5,
    ScrollQuarterScreenDown: 0.25,
    ScrollQuarterScreenUp: -0.25
  }
  verticalMotion = true
  amountOfPixels = 0

  execute (): void {
    const amountOfPage = (this.constructor as typeof Scroll).amountOfPageByName[this.name]
    const amountOfScreenRows = Math.trunc(amountOfPage * this.editor.getRowsPerPage() * this.getCount())
    this.amountOfPixels = amountOfScreenRows * this.editor.getLineHeightInPixels()

    super.execute()

    // TODO(vim-ts): ScrollManager.requestScroll stub lacks the `duration` option.
    this.vimState.requestScroll({
      amountOfPixels: this.amountOfPixels,
      duration: this.getSmoothScrollDuation((Math.abs(amountOfPage) === 1 ? 'Full' : 'Half') + 'ScrollMotion')
    } as any)
  }

  moveCursor (cursor: Cursor): void {
    const cursorPixel = this.editorElement.pixelPositionForScreenPosition(cursor.getScreenPosition())
    cursorPixel.top += this.amountOfPixels
    const screenPosition = this.editorElement.screenPositionForPixelPosition(cursorPixel)
    const screenRow = this.getValidVimScreenRow(screenPosition.row)
    this.setCursorBufferRow(cursor, this.editor.bufferRowForScreenRow(screenRow), {autoscroll: false})
  }
}

class ScrollFullScreenDown extends Scroll {} // ctrl-f
class ScrollFullScreenUp extends Scroll {} // ctrl-b
class ScrollHalfScreenDown extends Scroll {} // ctrl-d
class ScrollHalfScreenUp extends Scroll {} // ctrl-u
class ScrollQuarterScreenDown extends Scroll {} // g ctrl-d
class ScrollQuarterScreenUp extends Scroll {} // g ctrl-u

// Find
// -------------------------
// keymap: f
class Find extends Motion {
  backwards = false
  inclusive = true
  offset = 0
  requireInput = true
  caseSensitivityKind: string | null = 'Find'
  _restoreEditorState: (() => void) | null = null
  preConfirmedChars?: string

  restoreEditorState (): void {
    if (this._restoreEditorState) this._restoreEditorState()
    this._restoreEditorState = null
  }

  cancelOperation (): void {
    this.restoreEditorState()
    super.cancelOperation()
  }

  initialize (): void {
    if (this.getConfig('reuseFindForRepeatFind')) this.repeatIfNecessary()

    if (!this.repeated) {
      const charsMax = this.getConfig('findCharsMax')
      const optionsBase = {purpose: 'find', charsMax}

      if (charsMax === 1) {
        this.focusInput(optionsBase)
      } else {
        this._restoreEditorState = this.utils.saveEditorState(this.editor)
        const options = {
          autoConfirmTimeout: this.getConfig('findConfirmByTimeout'),
          onConfirm: (input: string) => {
            this.input = input
            if (input) this.processOperation()
            else this.cancelOperation()
          },
          onChange: (preConfirmedChars: string) => {
            this.preConfirmedChars = preConfirmedChars
            this.highlightTextInCursorRows(this.preConfirmedChars, 'pre-confirm', this.isBackwards())
          },
          onCancel: () => {
            this.vimState.highlightFind.clearMarkers()
            this.cancelOperation()
          },
          commands: {
            'vim-mode-plus:find-next-pre-confirmed': () => this.findPreConfirmed(+1),
            'vim-mode-plus:find-previous-pre-confirmed': () => this.findPreConfirmed(-1)
          }
        }
        this.focusInput(Object.assign(options, optionsBase))
      }
    }
    super.initialize()
  }

  findPreConfirmed (delta: number): void {
    if (this.preConfirmedChars && this.getConfig('highlightFindChar')) {
      const index = this.highlightTextInCursorRows(
        this.preConfirmedChars,
        'pre-confirm',
        this.isBackwards(),
        this.getCount() - 1 + delta,
        true
      )
      this.count = index! + 1
    }
  }

  repeatIfNecessary (): void {
    const findCommandNames = ['Find', 'FindBackwards', 'Till', 'TillBackwards']
    const currentFind = this.globalState.get('currentFind')
    if (currentFind && findCommandNames.includes(this.vimState.operationStack.getLastCommandName() as string)) {
      this.input = currentFind.input
      this.repeated = true
    }
  }

  isBackwards (): boolean {
    return this.backwards
  }

  execute (): void {
    super.execute()
    let decorationType = 'post-confirm'
    if (this.operator && !this.operator.instanceof('SelectBase')) {
      decorationType += ' long'
    }

    // HACK: When repeated by ",", this.backwards is temporary inverted and
    // restored after execution finished.
    // But final highlightTextInCursorRows is executed in async(=after operation finished).
    // Thus we need to preserve before restored `backwards` value and pass it.
    const backwards = this.isBackwards()
    this.editor.component.getNextUpdatePromise().then(() => {
      this.highlightTextInCursorRows(this.input, decorationType, backwards)
    })
  }

  getPoint (fromPoint: Point): Point | undefined {
    const scanRange = this.editor.bufferRangeForBufferRow(fromPoint.row)
    const points: Point[] = []
    const regex = this.getRegex(this.input as string)
    const indexWantAccess = this.getCount() - 1

    const translation = new Point(0, this.isBackwards() ? this.offset : -this.offset)
    if (this.repeated) {
      fromPoint = fromPoint.translate(translation.negate())
    }

    if (this.isBackwards()) {
      if (this.getConfig('findAcrossLines')) scanRange.start = Point.ZERO

      this.editor.backwardsScanInBufferRange(regex, scanRange, ({range, stop}) => {
        if (range.start.isLessThan(fromPoint)) {
          points.push(range.start)
          if (points.length > indexWantAccess) stop()
        }
      })
    } else {
      if (this.getConfig('findAcrossLines')) scanRange.end = this.editor.getEofBufferPosition()

      this.editor.scanInBufferRange(regex, scanRange, ({range, stop}) => {
        if (range.start.isGreaterThan(fromPoint)) {
          points.push(range.start)
          if (points.length > indexWantAccess) stop()
        }
      })
    }

    const point = points[indexWantAccess]
    if (point) return point.translate(translation)
  }

  // FIXME: bad naming, this function must return index
  highlightTextInCursorRows (text: string | undefined, decorationType: string, backwards: boolean, index: number = this.getCount() - 1, adjustIndex: boolean = false): number | undefined {
    if (!this.getConfig('highlightFindChar')) return

    return this.vimState.highlightFind.highlightCursorRows(
      this.getRegex(text as string),
      decorationType,
      backwards,
      this.offset,
      index,
      adjustIndex
    )
  }

  moveCursor (cursor: Cursor): void {
    const point = this.getPoint(cursor.getBufferPosition())
    if (point) cursor.setBufferPosition(point)
    else this.restoreEditorState()

    if (!this.repeated) this.globalState.set('currentFind', this)
  }

  getRegex (term: string): RegExp {
    const modifiers = this.isCaseSensitive(term) ? 'g' : 'gi'
    return new RegExp(this._.escapeRegExp(term), modifiers)
  }
}

// keymap: F
class FindBackwards extends Find {
  inclusive = false
  backwards = true
}

// keymap: t
class Till extends Find {
  offset = 1
  getPoint (...args: [Point]): Point | undefined {
    const point = super.getPoint(...args)
    this.moveSucceeded = point != null
    return point
  }
}

// keymap: T
class TillBackwards extends Till {
  inclusive = false
  backwards = true
}

// Mark
// -------------------------
// keymap: `
class MoveToMark extends Motion {
  jump = true
  requireInput = true
  // `input` holds the mark char here; keep the runtime `= null` init. Base types
  // it `string | undefined`, so widen to `any` to allow the null initializer.
  input: any = null // TODO(vim-ts): tighten
  moveToFirstCharacterOfLine = false

  initialize (): void {
    this.readChar()
    super.initialize()
  }

  moveCursor (cursor: Cursor): void {
    let point = this.vimState.mark.get(this.input)
    if (point) {
      if (this.moveToFirstCharacterOfLine) {
        point = this.getFirstCharacterPositionForBufferRow(point.row)
      }
      cursor.setBufferPosition(point!)
      cursor.autoscroll({center: true})
    }
  }
}

// keymap: '
class MoveToMarkLine extends MoveToMark {
  wise: Wise = 'linewise'
  moveToFirstCharacterOfLine = true
}

// Fold motion
// -------------------------
class MotionByFold extends Motion {
  static command = false
  wise: Wise = 'characterwise'
  which: 'start' | 'end' | null = null
  direction: Direction = null
  foldRanges: any[] = [] // TODO(vim-ts): tighten (fold range pairs)

  execute (): void {
    this.foldRanges = this.utils.getCodeFoldRanges(this.editor)
    super.execute()
  }

  getRows (): number[] {
    const rows = this.foldRanges.map(foldRange => foldRange[this.which!].row).sort((a: number, b: number) => a - b)
    if (this.direction === 'previous') {
      return rows.reverse()
    } else {
      return rows
    }
  }

  findRowBy (cursor: Cursor, fn: (row: number) => boolean): number | undefined {
    const cursorRow = cursor.getBufferRow()
    return this.getRows().find(row => {
      if (this.direction === 'previous') {
        return row < cursorRow && fn(row)
      } else {
        return row > cursorRow && fn(row)
      }
    })
  }

  findRow (cursor: Cursor): number | undefined {
    return this.findRowBy(cursor, () => true)
  }

  moveCursor (cursor: Cursor): void {
    this.moveCursorCountTimes(cursor, () => {
      const row = this.findRow(cursor)
      if (row != null) this.utils.moveCursorToFirstCharacterAtRow(cursor, row)
    })
  }
}

class MoveToPreviousFoldStart extends MotionByFold {
  which: 'start' | 'end' | null = 'start'
  direction: Direction = 'previous'
}

class MoveToNextFoldStart extends MotionByFold {
  which: 'start' | 'end' | null = 'start'
  direction: Direction = 'next'
}

class MoveToPreviousFoldEnd extends MotionByFold {
  which: 'start' | 'end' | null = 'end'
  direction: Direction = 'previous'
}

class MoveToNextFoldEnd extends MotionByFold {
  which: 'start' | 'end' | null = 'end'
  direction: Direction = 'next'
}

// -------------------------
class MoveToPreviousFunction extends MotionByFold {
  which: 'start' | 'end' | null = 'start'
  direction: Direction = 'previous'
  findRow (cursor: Cursor): number | undefined {
    return this.findRowBy(cursor, row => this.utils.isIncludeFunctionScopeForRow(this.editor, row))
  }
}

class MoveToNextFunction extends MoveToPreviousFunction {
  direction: Direction = 'next'
}

class MoveToPreviousFunctionAndRedrawCursorLineAtUpperMiddle extends MoveToPreviousFunction {
  execute (): void {
    super.execute()
    ;(this.getInstance('RedrawCursorLineAtUpperMiddle') as any).execute()
  }
}

class MoveToNextFunctionAndRedrawCursorLineAtUpperMiddle extends MoveToPreviousFunctionAndRedrawCursorLineAtUpperMiddle {
  direction: Direction = 'next'
}

// -------------------------
class MotionByFoldWithSameIndent extends MotionByFold {
  static command = false

  findRow (cursor: Cursor): number | undefined {
    const closestFoldRange = this.utils.getClosestFoldRangeContainsRow(this.editor, cursor.getBufferRow())
    const indentationForBufferRow = (row: number) => this.editor.indentationForBufferRow(row)
    const baseIndentLevel = closestFoldRange ? indentationForBufferRow(closestFoldRange.start.row) : 0
    const isEqualIndentLevel = (range: any) => indentationForBufferRow(range.start.row) === baseIndentLevel

    const cursorRow = cursor.getBufferRow()
    const foldRanges = this.direction === 'previous' ? this.foldRanges.slice().reverse() : this.foldRanges
    const foldRange = foldRanges.find(foldRange => {
      const row = foldRange[this.which!].row
      if (this.direction === 'previous') {
        return row < cursorRow && isEqualIndentLevel(foldRange)
      } else {
        return row > cursorRow && isEqualIndentLevel(foldRange)
      }
    })
    if (foldRange) {
      return foldRange[this.which!].row
    }
  }
}

class MoveToPreviousFoldStartWithSameIndent extends MotionByFoldWithSameIndent {
  which: 'start' | 'end' | null = 'start'
  direction: Direction = 'previous'
}

class MoveToNextFoldStartWithSameIndent extends MotionByFoldWithSameIndent {
  which: 'start' | 'end' | null = 'start'
  direction: Direction = 'next'
}

class MoveToPreviousFoldEndWithSameIndent extends MotionByFoldWithSameIndent {
  which: 'start' | 'end' | null = 'end'
  direction: Direction = 'previous'
}

class MoveToNextFoldEndWithSameIndent extends MotionByFoldWithSameIndent {
  which: 'start' | 'end' | null = 'end'
  direction: Direction = 'next'
}

class MoveToNextOccurrence extends Motion {
  // Ensure this command is available when only has-occurrence
  static commandScope = 'atom-text-editor.vim-mode-plus.has-occurrence'
  jump = true
  direction: Direction = 'next'
  ranges: Range[] = []

  execute (): void {
    this.ranges = this.utils.sortRanges(this.occurrenceManager.getMarkers().map((marker: any) => marker.getBufferRange()))
    super.execute()
  }

  moveCursor (cursor: Cursor): void {
    const range = this.ranges[this.utils.getIndex(this.getIndex(cursor.getBufferPosition()), this.ranges)]
    const point = range.start
    cursor.setBufferPosition(point, {autoscroll: false})

    this.editor.unfoldBufferRow(point.row)
    if (cursor.isLastCursor()) {
      this.utils.smartScrollToBufferPosition(this.editor, point)
    }

    if (this.getConfig('flashOnMoveToOccurrence')) {
      this.vimState.flash(range, {type: 'search'})
    }
  }

  getIndex (fromPoint: Point): number {
    const index = this.ranges.findIndex(range => range.start.isGreaterThan(fromPoint))
    return (index >= 0 ? index : 0) + this.getCount() - 1
  }
}

class MoveToPreviousOccurrence extends MoveToNextOccurrence {
  direction: Direction = 'previous'

  getIndex (fromPoint: Point): number {
    const ranges = this.ranges.slice().reverse()
    const range = ranges.find(range => range.end.isLessThan(fromPoint))
    const index = range ? this.ranges.indexOf(range) : this.ranges.length - 1
    return index - (this.getCount() - 1)
  }
}

// -------------------------
// keymap: %
class MoveToPair extends Motion {
  inclusive = true
  jump = true
  member = ['Parenthesis', 'CurlyBracket', 'SquareBracket']

  moveCursor (cursor: Cursor): void {
    const point = this.getPoint(cursor)
    if (point) cursor.setBufferPosition(point)
  }

  getPointForTag (point: Point): Point | undefined {
    const pairInfo = (this.getInstance('ATag') as any).getPairInfo(point)
    if (!pairInfo) return

    let {openRange, closeRange} = pairInfo
    openRange = openRange.translate([0, +1], [0, -1])
    closeRange = closeRange.translate([0, +1], [0, -1])
    if (openRange.containsPoint(point) && !point.isEqual(openRange.end)) {
      return closeRange.start
    }
    if (closeRange.containsPoint(point) && !point.isEqual(closeRange.end)) {
      return openRange.start
    }
  }

  getPoint (cursor: Cursor): Point | undefined {
    const cursorPosition = cursor.getBufferPosition()
    const cursorRow = cursorPosition.row
    const point = this.getPointForTag(cursorPosition)
    if (point) return point

    // AAnyPairAllowForwarding return forwarding range or enclosing range.
    const range = (this.getInstance('AAnyPairAllowForwarding', {member: this.member}) as any).getRange(cursor.selection)
    if (range) {
      const {start, end} = range
      if (start.row === cursorRow && start.isGreaterThanOrEqual(cursorPosition)) {
        // Forwarding range found
        return end.translate([0, -1])
      } else if (end.row === cursorPosition.row) {
        // Enclosing range was returned
        // We move to start( open-pair ) only when close-pair was at same row as cursor-row.
        return start
      }
    }

    // Nothing found from the cursor onward. If the cursor sits just *after* a
    // bracket, match that preceding bracket (Vim treats `)|` like `|)`).
    return this.getPointForPrecedingPair(cursorPosition)
  }

  getPointForPrecedingPair (cursorPosition: Point): Point | undefined {
    if (cursorPosition.column === 0) return
    const precedingPoint = cursorPosition.translate([0, -1])
    const leftChar = this.editor.lineTextForBufferRow(cursorPosition.row)[precedingPoint.column]
    const pair = PAIR_MEMBER_BY_BRACKET[leftChar]
    if (!pair) return

    const pairInfo = (this.getInstance(pair.member, {inclusive: true}) as any).getPairInfo(precedingPoint)
    if (!pairInfo) return
    return pair.open ? pairInfo.closeRange.start : pairInfo.openRange.start
  }
}

// Bracket character -> the Pair text-object that matches it, and whether the
// character itself is the opening side (used by MoveToPair's after-a-bracket
// fallback to pick which end to jump to).
const PAIR_MEMBER_BY_BRACKET: Record<string, {member: string, open: boolean}> = {
  '(': {member: 'Parenthesis', open: true},
  ')': {member: 'Parenthesis', open: false},
  '{': {member: 'CurlyBracket', open: true},
  '}': {member: 'CurlyBracket', open: false},
  '[': {member: 'SquareBracket', open: true},
  ']': {member: 'SquareBracket', open: false}
}

// Search as a motion (`/` `?` in operator-pending / visual mode), so an operator
// can target a search match: `d/foo`, `c?bar`, `y/baz`. Unlike upstream's
// search-input mini-editor, zym drives the host's SearchBar via the multi-char
// `focusInput` bridge (VimState.setSearchInput → TextEditor → SearchBar). The bar
// previews live; on confirm it hands back the seated match's *start* (with the
// cursor restored to the origin), which `moveCursor` then moves to — an exclusive
// motion, so `d/foo` deletes up to (not including) the next "foo".
class SearchBase extends Motion {
  static command = false
  requireInput = true
  backwards = false
  jump = true
  // `input` carries the confirmed match-start Point (or null); see class doc.
  input: any = undefined // TODO(vim-ts): tighten (Point | null)

  initialize (): void {
    if (!this.repeated) {
      // TODO(vim-ts): FocusInputOptions on Base lacks `reverse`/non-string onConfirm.
      this.focusInput({
        charsMax: Infinity,
        purpose: 'search',
        reverse: this.backwards,
        onConfirm: (matchStart: Point | null) => {
          this.input = matchStart // Point (ready) or null (cancel)
          if (matchStart) this.processOperation()
          else this.cancelOperation()
        },
        onCancel: () => this.cancelOperation(),
      } as any)
    }
    super.initialize()
  }

  moveCursor (cursor: Cursor): void {
    if (this.input) cursor.setBufferPosition(this.input)
  }
}

class Search extends SearchBase {
  backwards = false
}

class SearchBackwards extends SearchBase {
  backwards = true
}

// Leap (leap.nvim-style two-character labeled jump), as a motion so it composes
// with operators (`d g s`), visual mode, and dot-repeat. Like SearchBase, zym
// drives the host (TextEditor's Leap) through the multi-char
// `focusInput` bridge (VimState.setLeapInput): the host reads the 2 search chars,
// labels the matches, reads the chosen label, and hands back the target's *start*
// position (or null on cancel / no match). An exclusive motion, like search.
class LeapBase extends Motion {
  static command = false
  requireInput = true
  backwards = false
  jump = true
  // `input` carries the confirmed target Point (or null); see class doc.
  input: any = undefined // TODO(vim-ts): tighten (Point | null)

  initialize (): void {
    if (!this.repeated) {
      // TODO(vim-ts): FocusInputOptions on Base lacks `reverse`/non-string onConfirm.
      this.focusInput({
        purpose: 'leap',
        reverse: this.backwards,
        onConfirm: (target: Point | null) => {
          this.input = target // Point (jump) or null (cancel / no match)
          if (target) this.processOperation()
          else this.cancelOperation()
        },
        onCancel: () => this.cancelOperation(),
      } as any)
    }
    super.initialize()
  }

  moveCursor (cursor: Cursor): void {
    if (this.input) cursor.setBufferPosition(this.input)
  }
}

class Leap extends LeapBase {
  backwards = false
}

class LeapBackwards extends LeapBase {
  backwards = true
}

const __operations = {
  Motion,
  CurrentSelection,
  Search,
  SearchBackwards,
  Leap,
  LeapBackwards,
  MoveUpDisplayLine,
  MoveDownDisplayLine,
  MoveLeft,
  MoveRight,
  MoveRightBufferColumn,
  MoveUp,
  MoveUpWrap,
  MoveDown,
  MoveDownWrap,
  MoveUpScreen,
  MoveDownScreen,
  MoveUpToEdge,
  MoveDownToEdge,
  MotionByWord,
  MoveToNextWord,
  MoveToNextWholeWord,
  MoveToNextAlphanumericWord,
  MoveToNextSmartWord,
  MoveToNextSubword,
  MoveToPreviousWord,
  MoveToPreviousWholeWord,
  MoveToPreviousAlphanumericWord,
  MoveToPreviousSmartWord,
  MoveToPreviousSubword,
  MoveToEndOfWord,
  MoveToEndOfWholeWord,
  MoveToEndOfAlphanumericWord,
  MoveToEndOfSmartWord,
  MoveToEndOfSubword,
  MoveToPreviousEndOfWord,
  MoveToPreviousEndOfWholeWord,
  MoveToPreviousEndOfSubword,
  MoveToNextSentence,
  MoveToPreviousSentence,
  MoveToNextSentenceSkipBlankRow,
  MoveToPreviousSentenceSkipBlankRow,
  MoveToNextParagraph,
  MoveToPreviousParagraph,
  MoveToNextDiffHunk,
  MoveToPreviousDiffHunk,
  MoveToNextHunk,
  MoveToPreviousHunk,
  MoveToNextDiagnostic,
  MoveToPreviousDiagnostic,
  MoveToBeginningOfLine,
  MoveToColumn,
  MoveToLastCharacterOfLine,
  MoveToLastNonblankCharacterOfLineAndDown,
  MoveToFirstCharacterOfLine,
  MoveToFirstCharacterOfLineUp,
  MoveToFirstCharacterOfLineDown,
  MoveToFirstCharacterOfLineAndDown,
  MoveToScreenColumn,
  MoveToBeginningOfScreenLine,
  MoveToFirstCharacterOfScreenLine,
  MoveToLastCharacterOfScreenLine,
  MoveToFirstLine,
  MoveToLastLine,
  MoveToLineByPercent,
  MoveToRelativeLine,
  MoveToRelativeLineMinimumTwo,
  MoveToTopOfScreen,
  MoveToMiddleOfScreen,
  MoveToBottomOfScreen,
  Scroll,
  ScrollFullScreenDown,
  ScrollFullScreenUp,
  ScrollHalfScreenDown,
  ScrollHalfScreenUp,
  ScrollQuarterScreenDown,
  ScrollQuarterScreenUp,
  Find,
  FindBackwards,
  Till,
  TillBackwards,
  MoveToMark,
  MoveToMarkLine,
  MotionByFold,
  MoveToPreviousFoldStart,
  MoveToNextFoldStart,
  MotionByFoldWithSameIndent,
  MoveToPreviousFoldStartWithSameIndent,
  MoveToNextFoldStartWithSameIndent,
  MoveToPreviousFoldEndWithSameIndent,
  MoveToNextFoldEndWithSameIndent,
  MoveToPreviousFoldEnd,
  MoveToNextFoldEnd,
  MoveToPreviousFunction,
  MoveToNextFunction,
  MoveToPreviousFunctionAndRedrawCursorLineAtUpperMiddle,
  MoveToNextFunctionAndRedrawCursorLineAtUpperMiddle,
  MoveToNextOccurrence,
  MoveToPreviousOccurrence,
  MoveToPair
}

for (const klass of Object.values(__operations)) klass.register()
export default __operations
