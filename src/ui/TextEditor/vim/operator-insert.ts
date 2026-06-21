// Vendored from xedel/vim-mode-plus's lib/operator-insert.js — ESM conversion:
// `require`→`import`, the trailing `module.exports` map → eager registration +
// default export, and the one `atom.commands.add` (Replace-mode backspace
// handling) is neutralized until that key wiring is ported.
import { Range } from '../../../text/Range.ts'
import { Operator } from './operator.ts'
import type { Point } from '../../../text/Point.ts'
import type { Selection } from '../Selection.ts'
import type { Marker } from '../Marker.ts'
import type { AggregatedChange } from '../EditorModel.ts'

/** Which end of the target an Insert* operator places the cursor at. */
type WhichPosition = 'start' | 'end' | 'head' | 'tail'

/** The "wise" of an operation (mirrors operator.ts's local `Wise`). */
type Wise = 'characterwise' | 'linewise' | 'blockwise'

// Operator which start 'insert-mode'
// -------------------------
// [NOTE]
// Rule: Don't make any text mutation before calling `@selectTarget()`.
class ActivateInsertModeBase extends Operator {
  static command = false
  flashTarget = false
  supportInsertionCount = true

  // The earliest (topCursor's) change captured since the insert checkpoint, used
  // to replay text on `.` repeat. Null until insert mode is left with a change.
  lastChange: AggregatedChange | null = null
  // topCursor's buffer position when insertion started; used to compute the
  // deletion offset when replaying a change that deleted text.
  topCursorPositionAtInsertionStart: Point | null = null
  // Optional hook implemented by mutating subclasses (Change/InsertAboveWithNewline/...).
  mutateText? (): void

  // When each mutaion's extent is not intersecting, muitiple changes are recorded
  // e.g
  //  - Multicursors edit
  //  - Cursor moved in insert-mode(e.g ctrl-f, ctrl-b)
  // But I don't care multiple changes just because I'm lazy(so not perfect implementation).
  // I only take care of one change happened at earliest(topCursor's change) position.
  // Thats' why I save topCursor's position to @topCursorPositionAtInsertionStart to compare traversal to deletionStart
  // Why I use topCursor's change? Just because it's easy to use first change returned by getChangeSinceCheckpoint().
  getChangeSinceCheckpoint (purpose: string): AggregatedChange | undefined {
    return this.editor.getChangeSinceCheckpoint(this.getBufferCheckpoint(purpose))
  }

  // [BUG-BUT-OK] Replaying text-deletion-operation is not compatible to pure Vim.
  // Pure Vim record all operation in insert-mode as keystroke level and can distinguish
  // character deleted by `Delete` or by `ctrl-u`.
  // But I can not and don't trying to minic this level of compatibility.
  // So basically deletion-done-in-one is expected to work well.
  replayLastChange (selection: Selection): void {
    let textToInsert: string
    if (this.lastChange != null) {
      const {start, oldExtent, newText} = this.lastChange
      if (!oldExtent.isZero()) {
        const traversalToStartOfDelete = start.traversalFrom(this.topCursorPositionAtInsertionStart!)
        const deletionStart = selection.cursor.getBufferPosition().traverse(traversalToStartOfDelete)
        const deletionEnd = deletionStart.traverse(oldExtent)
        selection.setBufferRange([deletionStart, deletionEnd])
      }
      textToInsert = newText
    } else {
      textToInsert = ''
    }
    // TODO(vim-ts): Selection.insertText models no options arg; the {autoIndent}
    // hint is honored upstream only. Cast keeps the call's runtime behavior.
    ;(selection.insertText as any)(textToInsert, {autoIndent: true})
  }

  // called when repeated
  // [FIXME] to use replayLastChange in repeatInsert overriding subclasss.
  repeatInsert (selection: Selection, _text: string): void {
    this.replayLastChange(selection)
  }

  disposeReplaceMode () {
    if (this.vimState.replaceModeDisposable) {
      this.vimState.replaceModeDisposable.dispose()
      this.vimState.replaceModeDisposable = null
    }
  }

  initialize (): void {
    this.disposeReplaceMode()
    super.initialize()
  }

  execute (): void {
    if (this.repeated) this.flashTarget = this.trackChange = true

    this.preSelect()

    if (this.selectTarget() || this.target.wise !== 'linewise') {
      if (this.mutateText) this.mutateText()

      if (this.repeated) {
        for (const selection of this.editor.getSelections()) {
          const textToInsert = (this.lastChange && this.lastChange.newText) || ''
          this.repeatInsert(selection, textToInsert)
          this.utils.moveCursorLeft(selection.cursor)
        }
        this.mutationManager.setCheckpoint('did-finish')
        this.groupChangesSinceBufferCheckpoint('undo')
        this.emitDidFinishMutation()
        if (this.getConfig('clearMultipleCursorsOnEscapeInsertMode')) this.vimState.clearSelections()
      } else {
        if (this.mode !== 'insert') {
          this.initializeInsertMode()
        }

        if (this.name === 'ActivateReplaceMode') {
          this.activateMode('insert', 'replace')
        } else {
          this.activateMode('insert')
        }
      }
    } else {
      this.activateMode('normal')
    }
  }

  initializeInsertMode () {
    // Avoid freezing by acccidental big count(e.g. `5555555555555i`), See #560, #596
    let insertionCount = this.supportInsertionCount ? this.limitNumber(this.getCount() - 1, {max: 100}) : 0

    let textByOperator = ''
    if (insertionCount > 0) {
      const change = this.getChangeSinceCheckpoint('undo')
      textByOperator = (change && change.newText) || ''
    }

    this.createBufferCheckpoint('insert')
    const topCursor = this.editor.getCursorsOrderedByBufferPosition()[0]
    this.topCursorPositionAtInsertionStart = topCursor.getBufferPosition()

    // Skip normalization of blockwiseSelection.
    // Since want to keep multi-cursor and it's position in when shift to insert-mode.
    for (const blockwiseSelection of this.getBlockwiseSelections()) {
      blockwiseSelection.skipNormalization()
    }

    // With multiple cursors, mirror the primary's typing onto the others live
    // (incremental insert) instead of replaying once on leave. Blockwise keeps
    // the leave-time replay (it prepends operator text / handles count repeats).
    const liveReplication = this.editor.getSelections().length > 1 && this.getBlockwiseSelections().length === 0
    if (liveReplication) this.editor.beginMultiCursorEditReplication()

    const insertModeDisposable = this.vimState.preemptWillDeactivateMode(({mode}) => {
      if (mode !== 'insert') {
        return
      }
      insertModeDisposable.dispose()
      this.disposeReplaceMode()

      // If edits were mirrored to the extra cursors live, the leave-time replay
      // below must not run (it would double-insert). Stop replication first.
      const wasReplicating = this.editor.isReplicatingMultiCursorEdits()
      this.editor.endMultiCursorEditReplication()

      this.vimState.mark.set('^', this.editor.getCursorBufferPosition()) // Last insert-mode position
      let textByUserInput = ''
      const change = this.getChangeSinceCheckpoint('insert')
      if (change) {
        this.lastChange = change
        this.setMarkForChange(new Range(change.start, change.start.traverse(change.newExtent)))
        textByUserInput = change.newText
      }
      this.vimState.register.set('.', {text: textByUserInput}) // Last inserted text

      // quilx: there is no native multi-cursor, so the just-typed text only
      // reached the primary selection. Replicate it to the block's other cursors
      // — this is plain Vim's blockwise-insert behavior, which mirrors the typed
      // text to every row on leaving insert mode. Then collapse to one cursor,
      // since quilx doesn't keep persistent multi-cursors.
      if (!wasReplicating && textByUserInput && this.editor.getSelections().length > 1) {
        for (const selection of this.editor.getSelections()) {
          if (selection.isPrimary) continue
          // TODO(vim-ts): Selection.insertText models no options arg; cast keeps {autoIndent}.
          ;(selection.insertText as any)(textByOperator + textByUserInput, {autoIndent: false})
        }
        this.vimState.clearSelections()
      }

      while (insertionCount) {
        insertionCount--
        for (const selection of this.editor.getSelections()) {
          // TODO(vim-ts): Selection.insertText models no options arg; cast keeps {autoIndent}.
          ;(selection.insertText as any)(textByOperator + textByUserInput, {autoIndent: true})
        }
      }

      // This cursor state is restored on undo.
      // So cursor state has to be updated before next groupChangesSinceCheckpoint()
      if (this.getConfig('clearMultipleCursorsOnEscapeInsertMode')) this.vimState.clearSelections()

      // grouping changes for undo checkpoint need to come last
      if (this.getConfig('groupChangesWhenLeavingInsertMode')) this.groupChangesSinceBufferCheckpoint('undo')

      const preventIncorrectWrap = this.editor.hasAtomicSoftTabs()
      for (const cursor of this.editor.getCursors()) {
        this.utils.moveCursorLeft(cursor, {preventIncorrectWrap})
      }
    })
  }
}

class ActivateInsertMode extends ActivateInsertModeBase {
  target = 'Empty'
  acceptPresetOccurrence = false
  acceptPersistentSelection = false
}

class ActivateReplaceMode extends ActivateInsertMode {
  // Activates insert mode with the `replace` submode (the execute path calls
  // `activateMode('insert', 'replace')`); the host (TextEditor) implements the
  // overwrite-on-type and backspace-restore against that submode, since quilx
  // routes insert-mode keystrokes through GtkSourceView, not Atom's text events.

  repeatInsert (selection: Selection, text: string): void {
    for (const char of text) {
      if (char === '\n') continue
      if (selection.cursor.isAtEndOfLine()) break
      // TODO(vim-ts): EditorModel/Selection doesn't model selectRight yet.
      ;(selection as any).selectRight()
    }
    // TODO(vim-ts): Selection.insertText models no options arg; cast keeps {autoIndent}.
    ;(selection.insertText as any)(text, {autoIndent: false})
  }
}

class InsertAfter extends ActivateInsertMode {
  execute (): void {
    for (const cursor of this.editor.getCursors()) {
      this.utils.moveCursorRight(cursor)
    }
    super.execute()
  }
}

// key: 'g I' in all mode
class InsertAtBeginningOfLine extends ActivateInsertMode {
  execute (): void {
    if (this.mode === 'visual' && this.submode !== 'blockwise') {
      // TODO(vim-ts): EditorModel doesn't model splitSelectionsIntoLines yet.
      ;(this.editor as any).splitSelectionsIntoLines()
    }
    for (const blockwiseSelection of this.getBlockwiseSelections()) {
      blockwiseSelection.skipNormalization()
    }
    this.editor.moveToBeginningOfLine()
    super.execute()
  }
}

// key: normal 'A'
class InsertAfterEndOfLine extends ActivateInsertMode {
  execute (): void {
    this.editor.moveToEndOfLine()
    super.execute()
  }
}

// key: normal 'I'
class InsertAtFirstCharacterOfLine extends ActivateInsertMode {
  execute (): void {
    for (const cursor of this.editor.getCursors()) {
      this.utils.moveCursorToFirstCharacterAtRow(cursor, cursor.getBufferRow())
    }
    super.execute()
  }
}

class InsertAtLastInsert extends ActivateInsertMode {
  execute (): void {
    const point = this.vimState.mark.get('^')
    if (point) {
      this.editor.setCursorBufferPosition(point)
      this.editor.scrollToCursorPosition({center: true})
    }
    super.execute()
  }
}

class InsertAboveWithNewline extends ActivateInsertMode {
  // Marks where the user typed `o`/`O`, so undo/redo restores the cursor there.
  originalCursorPositionMarker: Marker | null = null

  initialize (): void {
    this.originalCursorPositionMarker = this.editor.markBufferPosition(this.editor.getCursorBufferPosition())
    super.initialize()
  }

  // This is for `o` and `O` operator.
  // On undo/redo put cursor at original point where user type `o` or `O`.
  groupChangesSinceBufferCheckpoint (purpose: string): void {
    if (this.repeated) {
      super.groupChangesSinceBufferCheckpoint(purpose)
      return
    }

    const lastCursor = this.editor.getLastCursor()
    const cursorPosition = lastCursor.getBufferPosition()
    lastCursor.setBufferPosition(this.originalCursorPositionMarker!.getHeadBufferPosition())
    this.originalCursorPositionMarker!.destroy()
    this.originalCursorPositionMarker = null

    if (this.getConfig('groupChangesWhenLeavingInsertMode')) {
      super.groupChangesSinceBufferCheckpoint(purpose)
    }
    lastCursor.setBufferPosition(cursorPosition)
  }

  autoIndentEmptyRows (): void {
    for (const cursor of this.editor.getCursors()) {
      const row = cursor.getBufferRow()
      if (this.isEmptyRow(row)) this.editor.autoIndentBufferRow(row)
    }
  }

  mutateText (): void {
    this.editor.insertNewlineAbove()
    if (this.editor.autoIndent) this.autoIndentEmptyRows()
  }

  repeatInsert (selection: Selection, text: string): void {
    // TODO(vim-ts): Selection.insertText models no options arg; cast keeps {autoIndent}.
    ;(selection.insertText as any)(text.trimLeft(), {autoIndent: true})
  }
}

class InsertBelowWithNewline extends InsertAboveWithNewline {
  mutateText (): void {
    for (const cursor of this.editor.getCursors()) {
      this.utils.setBufferRow(cursor, this.getFoldEndRowForRow(cursor.getBufferRow()))
    }

    this.editor.insertNewlineBelow()
    if (this.editor.autoIndent) this.autoIndentEmptyRows()
  }
}

// Advanced Insertion
// -------------------------
class InsertByTarget extends ActivateInsertModeBase {
  static command = false
  which: WhichPosition | null = null // one of ['start', 'end', 'head', 'tail']

  initialize (): void {
    // HACK
    // When g i is mapped to `insert-at-start-of-target`.
    // `g i 3 l` start insert at 3 column right position.
    // In this case, we don't want repeat insertion 3 times.
    // This @getCount() call cache number at the timing BEFORE '3' is specified.
    this.getCount()
    super.initialize()
  }

  execute (): void {
    this.onDidSelectTarget(() => {
      // In vC/vL, when occurrence marker was NOT selected,
      // it behave's very specially
      // vC: `I` and `A` behaves as shoft hand of `ctrl-v I` and `ctrl-v A`.
      // vL: `I` and `A` place cursors at each selected lines of start( or end ) of non-white-space char.
      if (!this.occurrenceSelected && this.mode === 'visual' && this.submode !== 'blockwise') {
        for (const $selection of this.swrap.getSelections(this.editor)) {
          $selection.normalize()
          $selection.applyWise('blockwise')
        }

        if (this.submode === 'linewise') {
          for (const blockwiseSelection of this.getBlockwiseSelections()) {
            blockwiseSelection.expandMemberSelectionsOverLineWithTrimRange()
          }
        }
      }

      for (const $selection of this.swrap.getSelections(this.editor)) {
        $selection.setBufferPositionTo(this.which!)
      }
    })
    super.execute()
  }
}

// key: 'I', Used in 'visual-mode.characterwise', visual-mode.blockwise
class InsertAtStartOfTarget extends InsertByTarget {
  which: WhichPosition = 'start'
}

// key: 'A', Used in 'visual-mode.characterwise', 'visual-mode.blockwise'
class InsertAtEndOfTarget extends InsertByTarget {
  which: WhichPosition = 'end'
}

class InsertAtHeadOfTarget extends InsertByTarget {
  which: WhichPosition = 'head'
}

class InsertAtStartOfOccurrence extends InsertAtStartOfTarget {
  occurrence = true
}

class InsertAtEndOfOccurrence extends InsertAtEndOfTarget {
  occurrence = true
}

class InsertAtHeadOfOccurrence extends InsertAtHeadOfTarget {
  occurrence = true
}

class InsertAtStartOfSubwordOccurrence extends InsertAtStartOfOccurrence {
  occurrenceType = 'subword'
}

class InsertAtEndOfSubwordOccurrence extends InsertAtEndOfOccurrence {
  occurrenceType = 'subword'
}

class InsertAtHeadOfSubwordOccurrence extends InsertAtHeadOfOccurrence {
  occurrenceType = 'subword'
}

class InsertAtStartOfSmartWord extends InsertByTarget {
  which: WhichPosition = 'start'
  target: any = 'MoveToPreviousSmartWord'
}

class InsertAtEndOfSmartWord extends InsertByTarget {
  which: WhichPosition = 'end'
  target: any = 'MoveToEndOfSmartWord'
}

class InsertAtPreviousFoldStart extends InsertByTarget {
  which: WhichPosition = 'start'
  target: any = 'MoveToPreviousFoldStart'
}

class InsertAtNextFoldStart extends InsertByTarget {
  which: WhichPosition = 'end'
  target: any = 'MoveToNextFoldStart'
}

// -------------------------
class Change extends ActivateInsertModeBase {
  trackChange = true
  supportInsertionCount = false

  mutateText (): void {
    // Allways dynamically determine selection wise wthout consulting target.wise
    // Reason: when `c i {`, wise is 'characterwise', but actually selected range is 'linewise'
    //   {
    //     a
    //   }
    const isLinewiseTarget = this.swrap.detectWise(this.editor) === 'linewise'
    for (const selection of this.editor.getSelections()) {
      if (!this.getConfig('dontUpdateRegisterOnChangeOrSubstitute')) {
        this.setTextToRegister(selection.getText(), selection)
      }
      if (isLinewiseTarget) {
        // Keep the changed line's own indentation (vim `autoindent`): capture it
        // before clearing, then restore it on the emptied line.
        const range = selection.getBufferRange()
        const startRow = range.start.row
        // A linewise selection ends at column 0 of the row AFTER its last line.
        const lastRow = range.end.column === 0 && range.end.row > startRow ? range.end.row - 1 : range.end.row
        const indent = this.editor.leadingWhitespaceForBufferRow(startRow)
        if (startRow === lastRow) {
          // Single line: CLEAR its content, keeping the line and its trailing newline. (`insertText
          // ('\n')` instead replaces the line AND its newline — visually identical in a plain buffer,
          // but at a projection/multibuffer excerpt boundary it deletes the line OUT of its excerpt,
          // shifts the next excerpt up, and lands the insert in that next excerpt. Clearing stays
          // inside the line's own source.)
          const end = this.editor.bufferRangeForBufferRow(startRow).end
          selection.setBufferRange([[startRow, 0], [end.row, end.column]])
          ;(selection.insertText as any)('', {autoIndent: false})
          selection.cursor.setBufferPosition([startRow, 0])
        } else {
          // Multi-line: replace the lines with a single empty line, then step back onto it. The
          // insert leaves the cursor at the start of the *following* line, so the move must wrap
          // across the newline — a plain moveLeft stalls at col 0.
          // TODO(vim-ts): Selection.insertText models no options arg; cast keeps {autoIndent}.
          ;(selection.insertText as any)('\n', {autoIndent: true})
          selection.cursor.moveLeft(1, {allowWrap: true})
        }
        if (indent) {
          const row = selection.cursor.getBufferPosition().row
          this.editor.setTextInBufferRange([[row, 0], [row, 0]], indent)
          selection.cursor.setBufferPosition([row, indent.length])
        }
      } else {
        // TODO(vim-ts): Selection.insertText models no options arg; cast keeps {autoIndent}.
        ;(selection.insertText as any)('', {autoIndent: true})
      }
    }
  }
}

class ChangeOccurrence extends Change {
  occurrence = true
}

class ChangeSubwordOccurrence extends ChangeOccurrence {
  occurrenceType = 'subword'
}

class Substitute extends Change {
  target: any = 'MoveRight'
}

class SubstituteLine extends Change {
  wise: Wise = 'linewise' // [FIXME] to re-override target.wise in visual-mode
  target: any = 'MoveToRelativeLine'
}

// alias
class ChangeLine extends SubstituteLine {}

class ChangeToLastCharacterOfLine extends Change {
  target: any = 'MoveToLastCharacterOfLine'

  execute (): void {
    this.onDidSelectTarget(() => {
      if (this.target.wise === 'blockwise') {
        for (const blockwiseSelection of this.getBlockwiseSelections()) {
          blockwiseSelection.extendMemberSelectionsToEndOfLine()
        }
      }
    })
    super.execute()
  }
}

const __operations = {
  ActivateInsertModeBase,
  ActivateInsertMode,
  ActivateReplaceMode,
  InsertAfter,
  InsertAtBeginningOfLine,
  InsertAfterEndOfLine,
  InsertAtFirstCharacterOfLine,
  InsertAtLastInsert,
  InsertAboveWithNewline,
  InsertBelowWithNewline,
  InsertByTarget,
  InsertAtStartOfTarget,
  InsertAtEndOfTarget,
  InsertAtHeadOfTarget,
  InsertAtStartOfOccurrence,
  InsertAtEndOfOccurrence,
  InsertAtHeadOfOccurrence,
  InsertAtStartOfSubwordOccurrence,
  InsertAtEndOfSubwordOccurrence,
  InsertAtHeadOfSubwordOccurrence,
  InsertAtStartOfSmartWord,
  InsertAtEndOfSmartWord,
  InsertAtPreviousFoldStart,
  InsertAtNextFoldStart,
  Change,
  ChangeOccurrence,
  ChangeSubwordOccurrence,
  Substitute,
  SubstituteLine,
  ChangeLine,
  ChangeToLastCharacterOfLine
}

for (const klass of Object.values(__operations)) klass.register()
export default __operations
