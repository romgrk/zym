/*
 * BlockwiseSelection — vendored from xedel/vim-mode-plus's lib/blockwise-selection.js.
 *
 * ESM conversion only (`require`→`import`, `module.exports`→`export default`).
 * Manages a visual-block (ctrl-v) selection as one real selection per block row:
 * the first row reuses the passed (primary) selection, the rest are created via
 * `editor.addSelectionForBufferRange` (zym's multi-selection — secondary
 * selections backed by their own marks, painted as decorations). The operators
 * then iterate `editor.getSelections()` and mutate each row, unchanged.
 */
import { Point } from '../../../text/Point.ts'
import type { Range, RangeLike } from '../../../text/Range.ts'
import type { Selection } from '../Selection.ts'
import type { EditorModel } from '../EditorModel.ts'
import {
  sortRanges,
  assertWithException,
  trimBufferRange,
  getList,
  getLast,
  translateColumnOnHardTabEditor,
} from './utils.ts'
import settings from './settings.ts'
import swrap from './selection-wrapper.ts'
import type { SelectionProperties } from './selection-wrapper.ts'

const blockwiseSelectionsByEditor = new Map<EditorModel, BlockwiseSelection[]>()

export default class BlockwiseSelection {
  needSkipNormalization: boolean
  properties: Record<string, unknown>
  selections: Selection[]
  editor: EditorModel
  goalColumn: number | null
  reversed: boolean

  static clearSelections (editor: EditorModel) {
    blockwiseSelectionsByEditor.delete(editor)
  }

  static has (editor: EditorModel) {
    return blockwiseSelectionsByEditor.has(editor)
  }

  static getSelections (editor: EditorModel): BlockwiseSelection[] {
    return blockwiseSelectionsByEditor.get(editor) || []
  }

  static getSelectionsOrderedByBufferPosition (editor: EditorModel): BlockwiseSelection[] {
    return this.getSelections(editor).sort((a, b) => a.getStartSelection().compare(b.getStartSelection()))
  }

  static getLastSelection (editor: EditorModel): BlockwiseSelection | undefined {
    return getLast(blockwiseSelectionsByEditor.get(editor))
  }

  static register (blockwiseSelection: BlockwiseSelection) {
    const {editor} = blockwiseSelection
    if (!this.has(editor)) {
      blockwiseSelectionsByEditor.set(editor, [])
    }
    blockwiseSelectionsByEditor.get(editor)!.push(blockwiseSelection)
  }

  constructor (selection: Selection) {
    this.needSkipNormalization = false
    this.properties = {}
    this.selections = []
    this.editor = selection.editor
    const editor = this.editor

    const $selection = swrap(selection)
    if (!$selection.hasProperties()) {
      if (settings.get('strictAssertion')) {
        assertWithException(false, 'Trying to instantiate vB from properties-less selection')
      }
      $selection.saveProperties()
    }

    this.goalColumn = selection.cursor.goalColumn
    this.reversed = selection.isReversed()

    let start: Point, end: Point
    let startColumn: number, endColumn: number, reversed: boolean

    const {head, tail} = $selection.getProperties()!
    const isHardTabEditor = !editor.softTabs
    if (isHardTabEditor) {
      head.column = translateColumnOnHardTabEditor(editor, head.row, head.column, true)
      tail.column = translateColumnOnHardTabEditor(editor, tail.row, tail.column, true)
    }

    if (this.reversed) {
      start = head
      end = tail
    } else {
      start = tail
      end = head
    }

    // Respect goalColumn only when it's value is Infinity and selection's head-column is bigger than tail-column
    if (this.goalColumn === Infinity && head.column >= tail.column) {
      head.column = Infinity
    }

    if (start.column > end.column) {
      reversed = !this.reversed
      startColumn = end.column
      endColumn = start.column + 1
    } else {
      reversed = this.reversed
      startColumn = start.column
      endColumn = end.column + 1
    }

    const rangesToSelect: RangeLike[] = getList(start.row, end.row).map((row): RangeLike => {
      if (isHardTabEditor) {
        return [
          [row, translateColumnOnHardTabEditor(editor, row, startColumn, false)],
          [row, translateColumnOnHardTabEditor(editor, row, endColumn, false)]
        ]
      } else {
        return [[row, startColumn], [row, endColumn]]
      }
    })

    let handleFirstSelection = false
    for (const rangeToSelect of rangesToSelect) {
      let currentSelection
      if (!handleFirstSelection) {
        handleFirstSelection = true
        selection.setBufferRange(rangeToSelect, {reversed})
        currentSelection = selection
      } else {
        currentSelection = editor.addSelectionForBufferRange(rangeToSelect, {reversed})
      }

      this.selections.push(currentSelection)
      swrap(currentSelection).saveProperties()
    }

    this.updateGoalColumn()
    ;(this.constructor as typeof BlockwiseSelection).register(this)
  }

  getSelections () {
    return this.selections
  }

  extendMemberSelectionsToEndOfLine () {
    for (const selection of this.getSelections()) {
      const {start, end} = selection.getBufferRange()
      selection.setBufferRange([start, [end.row, Infinity]])
    }
  }

  expandMemberSelectionsOverLineWithTrimRange () {
    for (const selection of this.getSelections()) {
      const {start} = selection.getBufferRange()
      const range = trimBufferRange(this.editor, this.editor.bufferRangeForBufferRow(start.row))
      selection.setBufferRange(range)
    }
  }

  isReversed () {
    return this.reversed
  }

  reverse () {
    this.reversed = !this.reversed
  }

  getProperties (): SelectionProperties {
    return {
      head: swrap(this.getHeadSelection()).getProperties()!.head,
      tail: swrap(this.getTailSelection()).getProperties()!.tail
    }
  }

  updateGoalColumn () {
    if (this.goalColumn != null) {
      for (const selection of this.selections) {
        selection.cursor.goalColumn = this.goalColumn
      }
    }
  }

  isSingleRow () {
    return this.selections.length === 1
  }

  getHeight () {
    const [startRow, endRow] = this.getBufferRowRange()
    return endRow - startRow + 1
  }

  getStartSelection (): Selection {
    return this.selections[0]
  }

  getEndSelection (): Selection {
    return getLast(this.selections)!
  }

  getHeadSelection (): Selection {
    return this.isReversed() ? this.getStartSelection() : this.getEndSelection()
  }

  getTailSelection (): Selection {
    return this.isReversed() ? this.getEndSelection() : this.getStartSelection()
  }

  getBufferRowRange (): [number, number] {
    const startRow = this.getStartSelection().getBufferRowRange()[0]
    const endRow = this.getEndSelection().getBufferRowRange()[0]
    return [startRow, endRow]
  }

  // [NOTE] Used by plugin package vmp:move-selected-text
  setSelectedBufferRanges (ranges: Range[], {reversed}: {reversed?: boolean}) {
    sortRanges(ranges)

    const head = this.getHeadSelection()
    this.removeSelections({except: head})
    const {goalColumn} = head.cursor
    head.setBufferRange(ranges.shift()!, {reversed})
    if (goalColumn != null && head.cursor.goalColumn == null) {
      head.cursor.goalColumn = goalColumn
    }

    for (const range of ranges) {
      this.selections.push(this.editor.addSelectionForBufferRange(range, {reversed}))
    }
    this.updateGoalColumn()
  }

  removeSelections ({except}: {except?: Selection} = {}) {
    for (const selection of this.selections.slice()) {
      if (selection === except) continue

      swrap(selection).clearProperties()
      const index = this.selections.indexOf(selection)
      if (index >= 0) {
        this.selections.splice(index, 1)
      }
      selection.destroy()
    }
  }

  setHeadBufferPosition (point: Point) {
    const head = this.getHeadSelection()
    this.removeSelections({except: head})
    head.cursor.setBufferPosition(point)
  }

  skipNormalization () {
    this.needSkipNormalization = true
  }

  normalize () {
    if (this.needSkipNormalization) return

    // CAUTION: Save prop BEFORE removing member selections.
    const properties = this.getProperties()

    const head = this.getHeadSelection()
    this.removeSelections({except: head})

    const {goalColumn} = head.cursor // FIXME this should not be necessary

    const $selection = swrap(head)
    $selection.selectByProperties(properties)
    $selection.saveProperties(true)

    if (goalColumn != null && head.cursor.goalColumn == null) {
      // FIXME this should not be necessary
      head.cursor.goalColumn = goalColumn
    }
  }

  autoscroll () {
    this.getHeadSelection().autoscroll()
  }
}
