// Vendored from xedel/vim-mode-plus's lib/misc-command.js — ESM conversion only:
// `require`→`import`, trailing `module.exports` → eager registration + default
// export. NOTE: some commands here (tab switching, scroll/redraw opt-in dialogs)
// still reference `atom.*` inside their method bodies; they are not wired to any
// keymap, so they never run. They are neutralized when those features are ported.
import { Range } from '../../../text/Range.ts'
import { Base } from './base.ts'
import { zym } from '../../../zym.ts'
import type { Point } from '../../../text/Point.ts'

// Some commands here (scroll/redraw opt-in dialogs, tab switching) still reference
// the Atom global in dead method bodies that are never wired to a keymap. Declare
// it as `any` so they type-check; they are neutralized when those features port.
// TODO(vim-ts): replace `atom.*` references when these features are ported.
declare const atom: any

class MiscCommand extends Base {
  static command = false
  static operationKind = 'misc-command'
}

class Mark extends MiscCommand {
  async execute (): Promise<void> {
    const mark = await this.readCharPromised()
    if (mark) {
      this.vimState.mark.set(mark, this.getCursorBufferPosition())
    }
  }
}

class ReverseSelections extends MiscCommand {
  execute (): void {
    this.swrap.setReversedState(this.editor, !this.editor.getLastSelection().isReversed())
    if (this.isMode('visual', 'blockwise')) {
      this.getLastBlockwiseSelection().autoscroll()
    }
  }
}

class BlockwiseOtherEnd extends ReverseSelections {
  execute (): void {
    for (const blockwiseSelection of this.getBlockwiseSelections()) {
      blockwiseSelection.reverse()
    }
    super.execute()
  }
}

class Undo extends MiscCommand {
  execute (): void {
    const newRanges: Range[] = []
    const oldRanges: Range[] = []

    const disposable = this.editor.getBuffer().onDidChangeText(event => {
      for (const {newRange, oldRange} of event.changes) {
        if (newRange.isEmpty()) {
          oldRanges.push(oldRange) // Remove only
        } else {
          newRanges.push(newRange)
        }
      }
    })

    if (this.name === 'Undo') {
      this.editor.undo()
    } else {
      this.editor.redo()
    }

    disposable.dispose()

    for (const selection of this.editor.getSelections()) {
      selection.clear()
    }

    if (this.getConfig('setCursorToStartOfChangeOnUndoRedo')) {
      const strategy = this.getConfig('setCursorToStartOfChangeOnUndoRedoStrategy')
      this.setCursorPosition({newRanges, oldRanges, strategy})
      this.vimState.clearSelections()
    }

    if (this.getConfig('flashOnUndoRedo')) {
      if (newRanges.length) {
        this.flashChanges(newRanges, 'changes')
      } else {
        this.flashChanges(oldRanges, 'deletes')
      }
    }
    this.activateMode('normal')
  }

  setCursorPosition ({newRanges, oldRanges, strategy}: {newRanges: Range[], oldRanges: Range[], strategy: string}): void {
    const lastCursor = this.editor.getLastCursor() // This is restored cursor

    let changedRange: Range | undefined

    if (strategy === 'smart') {
      changedRange = this.utils.findRangeContainsPoint(newRanges, lastCursor.getBufferPosition())
    } else if (strategy === 'simple') {
      changedRange = this.utils.sortRanges(newRanges.concat(oldRanges))[0]
    }

    if (changedRange) {
      if (this.utils.isLinewiseRange(changedRange)) this.utils.setBufferRow(lastCursor, changedRange.start.row)
      else lastCursor.setBufferPosition(changedRange.start)
    }
  }

  flashChanges (ranges: Range[], mutationType: string): void {
    const isMultipleSingleLineRanges = (ranges: Range[]) => ranges.length > 1 && ranges.every(this.utils.isSingleLineRange)
    const humanizeNewLineForBufferRange = this.utils.humanizeNewLineForBufferRange.bind(null, this.editor)
    const isNotLeadingWhiteSpaceRange = this.utils.isNotLeadingWhiteSpaceRange.bind(null, this.editor)
    if (!this.utils.isMultipleAndAllRangeHaveSameColumnAndConsecutiveRows(ranges)) {
      ranges = ranges.map(humanizeNewLineForBufferRange)
      const type = isMultipleSingleLineRanges(ranges) ? `undo-redo-multiple-${mutationType}` : 'undo-redo'
      if (!(type === 'undo-redo' && mutationType === 'deletes')) {
        this.vimState.flash(ranges.filter(isNotLeadingWhiteSpaceRange), {type})
      }
    }
  }
}

class Redo extends Undo {}

// zc
class FoldCurrentRow extends MiscCommand {
  execute (): void {
    for (const point of this.getCursorBufferPositions()) {
      // TODO(vim-ts): foldBufferRow not yet on EditorModel
      ;(this.editor as any).foldBufferRow(point.row)
    }
  }
}

// zo
class UnfoldCurrentRow extends MiscCommand {
  execute (): void {
    for (const point of this.getCursorBufferPositions()) {
      this.editor.unfoldBufferRow(point.row)
    }
  }
}

// za
class ToggleFold extends MiscCommand {
  execute (): void {
    for (const point of this.getCursorBufferPositions()) {
      // TODO(vim-ts): toggleFoldAtBufferRow not yet on EditorModel
      ;(this.editor as any).toggleFoldAtBufferRow(point.row)
    }
  }
}

// Base of zC, zO, zA
class FoldCurrentRowRecursivelyBase extends MiscCommand {
  static command = false
  eachFoldStartRow (fn: (row: number) => void): void {
    for (const {row} of this.getCursorBufferPositionsOrdered().reverse()) {
      // TODO(vim-ts): isFoldableAtBufferRow not yet on EditorModel
      if (!(this.editor as any).isFoldableAtBufferRow(row)) continue

      const foldRanges: Range[] = this.utils.getCodeFoldRanges(this.editor)
      const enclosingFoldRange = foldRanges.find(range => range.start.row === row)
      const enclosedFoldRanges = foldRanges.filter(range => enclosingFoldRange!.containsRange(range))

      // Why reverse() is to process encolosed(nested) fold first than encolosing fold.
      enclosedFoldRanges.reverse().forEach(range => fn(range.start.row))
    }
  }

  foldRecursively (): void {
    this.eachFoldStartRow(row => {
      // TODO(vim-ts): foldBufferRow not yet on EditorModel
      if (!this.editor.isFoldedAtBufferRow(row)) (this.editor as any).foldBufferRow(row)
    })
  }

  unfoldRecursively (): void {
    this.eachFoldStartRow(row => {
      if (this.editor.isFoldedAtBufferRow(row)) this.editor.unfoldBufferRow(row)
    })
  }
}

// zC
class FoldCurrentRowRecursively extends FoldCurrentRowRecursivelyBase {
  execute (): void {
    this.foldRecursively()
  }
}

// zO
class UnfoldCurrentRowRecursively extends FoldCurrentRowRecursivelyBase {
  execute (): void {
    this.unfoldRecursively()
  }
}

// zA
class ToggleFoldRecursively extends FoldCurrentRowRecursivelyBase {
  execute (): void {
    if (this.editor.isFoldedAtBufferRow(this.getCursorBufferPosition().row)) {
      this.unfoldRecursively()
    } else {
      this.foldRecursively()
    }
  }
}

// zR
class UnfoldAll extends MiscCommand {
  execute (): void {
    // TODO(vim-ts): unfoldAll lives on FoldAccess, not yet on EditorModel
    ;(this.editor as any).unfoldAll()
  }
}

// zM
class FoldAll extends MiscCommand {
  execute (): void {
    const {allFold} = this.utils.getFoldInfoByKind(this.editor)
    if (!allFold) return

    // TODO(vim-ts): unfoldAll lives on FoldAccess, not yet on EditorModel
    ;(this.editor as any).unfoldAll()
    for (const {indent, range} of allFold.listOfRangeAndIndent) {
      if (indent <= this.getConfig('maxFoldableIndentLevel')) {
        // TODO(vim-ts): foldBufferRange not yet on EditorModel
        ;(this.editor as any).foldBufferRange(range)
      }
    }
    // TODO(vim-ts): scrollToCursorPosition not yet on EditorModel
    ;this.editor.scrollToCursorPosition({center: true})
  }
}

// zr
class UnfoldNextIndentLevel extends MiscCommand {
  execute (): void {
    const {folded} = this.utils.getFoldInfoByKind(this.editor)
    if (!folded) return
    const {minIndent, listOfRangeAndIndent} = folded
    const targetIndents = this.utils.getList(minIndent!, minIndent! + this.getCount() - 1)
    for (const {indent, range} of listOfRangeAndIndent) {
      if (targetIndents.includes(indent)) {
        this.editor.unfoldBufferRow(range.start.row)
      }
    }
  }
}

// zm
class FoldNextIndentLevel extends MiscCommand {
  execute (): void {
    const {unfolded, allFold} = this.utils.getFoldInfoByKind(this.editor)
    if (!unfolded) return
    // FIXME: Why I need unfoldAll()? Why can't I just fold non-folded-fold only?
    // Unless unfoldAll() here, @editor.unfoldAll() delete foldMarker but fail
    // to render unfolded rows correctly.
    // I believe this is bug of text-buffer's markerLayer which assume folds are
    // created **in-order** from top-row to bottom-row.
    // TODO(vim-ts): unfoldAll lives on FoldAccess, not yet on EditorModel
    ;(this.editor as any).unfoldAll()

    const maxFoldable = this.getConfig('maxFoldableIndentLevel')
    let fromLevel = Math.min(unfolded.maxIndent!, maxFoldable)
    fromLevel = this.limitNumber(fromLevel - this.getCount() - 1, {min: 0})
    const targetIndents = this.utils.getList(fromLevel, maxFoldable)
    for (const {indent, range} of allFold!.listOfRangeAndIndent) {
      if (targetIndents.includes(indent)) {
        // TODO(vim-ts): foldBufferRange not yet on EditorModel
        ;(this.editor as any).foldBufferRange(range)
      }
    }
  }
}

// ctrl-e scroll lines downwards
class MiniScrollDown extends MiscCommand {
  defaultCount: number = this.getConfig('defaultScrollRowsOnMiniScroll')
  direction: string = 'down'

  keepCursorOnScreen (): void {
    const cursor = this.editor.getLastCursor()
    const row = cursor.getScreenRow()
    const offset = 2
    const validRow =
      this.direction === 'down'
        ? this.limitNumber(row, {min: this.editor.getFirstVisibleScreenRow() + offset})
        : this.limitNumber(row, {max: this.editor.getLastVisibleScreenRow() - offset})
    if (row !== validRow) {
      this.utils.setBufferRow(cursor, this.editor.bufferRowForScreenRow(validRow), {autoscroll: false})
    }
  }

  execute (): void {
    // TODO(vim-ts): ScrollManager.requestScroll stub lacks the `duration` option.
    this.vimState.requestScroll({
      amountOfPixels: (this.direction === 'down' ? 1 : -1) * this.getCount() * this.editor.getLineHeightInPixels(),
      duration: this.getSmoothScrollDuation('MiniScroll'),
      onFinish: () => this.keepCursorOnScreen()
    } as any)
  }
}

// ctrl-y scroll lines upwards
class MiniScrollUp extends MiniScrollDown {
  direction: string = 'up'
}

// RedrawCursorLineAt{XXX} in viewport.
// +-------------------------------------------+
// | where        | no move | move to 1st char |
// |--------------+---------+------------------|
// | top          | z t     | z enter          |
// | upper-middle | z u     | z space          |
// | middle       | z z     | z .              |
// | bottom       | z b     | z -              |
// +-------------------------------------------+
class RedrawCursorLine extends MiscCommand {
  static command = false
  static coefficientByName: Record<string, number> = {
    RedrawCursorLineAtTop: 0,
    RedrawCursorLineAtUpperMiddle: 0.25,
    RedrawCursorLineAtMiddle: 0.5,
    RedrawCursorLineAtBottom: 1
  }

  coefficient: number = 0
  moveToFirstCharacterOfLine: boolean = false

  initialize (): void {
    const baseName = this.name.replace(/AndMoveToFirstCharacterOfLine$/, '')
    this.coefficient = (this.constructor as typeof RedrawCursorLine).coefficientByName[baseName]
    // `z z` (center) honors the editor's configured center fraction rather than a hardcoded
    // mid-screen, matching every other "reveal centered" path. See docs/text-editor/index.md (Centering).
    if (baseName === 'RedrawCursorLineAtMiddle') this.coefficient = this.editor.getCenterFraction()
    this.moveToFirstCharacterOfLine = this.name.endsWith('AndMoveToFirstCharacterOfLine')
    super.initialize()
  }

  execute (): void {
    const scrollTop = Math.round(this.getScrollTop())
    // TODO(vim-ts): ScrollManager.requestScroll stub lacks the `duration` option.
    this.vimState.requestScroll({
      scrollTop: scrollTop,
      duration: this.getSmoothScrollDuation('RedrawCursorLine'),
      onFinish: () => {
        if (
          this.getConfig('askOptInToEditorScrollPastEnd') &&
          this.editorElement.getScrollTop() !== scrollTop &&
          !this.editor.getScrollPastEnd()
        ) {
          this.recommendToEnableScrollPastEnd()
        }
      }
    } as any)
    if (this.moveToFirstCharacterOfLine) this.editor.moveToFirstCharacterOfLine()
  }

  getScrollTop (): number {
    const {top} = this.editorElement.pixelPositionForScreenPosition(this.editor.getCursorScreenPosition())
    const editorHeight = this.editorElement.getHeight()
    const lineHeightInPixel = this.editor.getLineHeightInPixels()

    return this.limitNumber(top - editorHeight * this.coefficient, {
      min: top - editorHeight + lineHeightInPixel * 3,
      max: top - lineHeightInPixel * 2
    })
  }

  recommendToEnableScrollPastEnd (): void {
    const message = [
      'vim-mode-plus',
      '- Failed to scroll. To successfully scroll, `editor.scrollPastEnd` need to be enabled.',
      '- You can do it from `"Settings" > "Editor" > "Scroll Past End"`.',
      '- Or **do you allow vmp enable it for you now?**'
    ].join('\n')

    const notification: any = atom.notifications.addInfo(message, {
      dismissable: true,
      buttons: [
        {
          text: 'No thanks.',
          onDidClick: () => notification.dismiss()
        },
        {
          text: 'Never ask again.',
          onDidClick: () => {
            atom.config.set(`vim-mode-plus.askOptInToEditorScrollPastEnd`, false)
            notification.dismiss()
          }
        },
        {
          text: 'OK. Enable it now!!',
          onDidClick: () => {
            atom.config.set(`editor.scrollPastEnd`, true)
            notification.dismiss()
          }
        }
      ]
    })
  }
}

class RedrawCursorLineAtTop extends RedrawCursorLine {} // zt
class RedrawCursorLineAtTopAndMoveToFirstCharacterOfLine extends RedrawCursorLine {} // z enter
class RedrawCursorLineAtUpperMiddle extends RedrawCursorLine {} // zu
class RedrawCursorLineAtUpperMiddleAndMoveToFirstCharacterOfLine extends RedrawCursorLine {} // z space
class RedrawCursorLineAtMiddle extends RedrawCursorLine {} // z z
class RedrawCursorLineAtMiddleAndMoveToFirstCharacterOfLine extends RedrawCursorLine {} // z .
class RedrawCursorLineAtBottom extends RedrawCursorLine {} // z b
class RedrawCursorLineAtBottomAndMoveToFirstCharacterOfLine extends RedrawCursorLine {} // z -

// Horizontal Scroll without changing cursor position
// -------------------------
// zs
class ScrollCursorToLeft extends MiscCommand {
  which: string = 'left'
  execute (): void {
    const translation: [number, number] = this.which === 'left' ? [0, 0] : [0, 1]
    const screenPosition = this.editor.getCursorScreenPosition().translate(translation)
    const pixel = this.editorElement.pixelPositionForScreenPosition(screenPosition)
    if (this.which === 'left') {
      // TODO(vim-ts): setScrollLeft not yet on EditorModel
      ;(this.editorElement as any).setScrollLeft(pixel.left)
    } else {
      // TODO(vim-ts): setScrollRight/component not yet on EditorModel
      ;(this.editorElement as any).setScrollRight(pixel.left)
      ;this.editor.component.updateSync() // FIXME: This is necessary maybe because of bug of atom-core.
    }
  }
}

// ze
class ScrollCursorToRight extends ScrollCursorToLeft {
  which: string = 'right'
}

// insert-mode specific commands
// -------------------------
class InsertMode extends MiscCommand {} // just namespace

class ActivateNormalModeOnce extends InsertMode {
  execute (): void {
    const cursorsToMoveRight = this.editor.getCursors().filter(cursor => !cursor.isAtBeginningOfLine())
    this.vimState.activate('normal')
    for (const cursor of cursorsToMoveRight) {
      this.utils.moveCursorRight(cursor)
    }

    const disposable = atom.commands.onDidDispatch((event: any) => {
      if (event.type !== this.getCommandName()) {
        disposable.dispose()
        this.vimState.activate('insert')
      }
    })
  }
}

class ToggleReplaceMode extends MiscCommand {
  execute (): void {
    if (this.mode === 'insert') {
      if (this.submode === 'replace') {
        this.vimState.operationStack.runNext('ActivateInsertMode')
      } else {
        this.vimState.operationStack.runNext('ActivateReplaceMode')
      }
    }
  }
}

class InsertRegister extends InsertMode {
  async execute (): Promise<void> {
    const input = await this.readCharPromised()
    if (input) {
      this.editor.transact(() => {
        for (const selection of this.editor.getSelections()) {
          selection.insertText(this.vimState.register.getText(input, selection))
        }
      })
    }
  }
}

class InsertLastInserted extends InsertMode {
  execute (): void {
    this.editor.insertText(this.vimState.register.getText('.'))
  }
}

class CopyFromLineAbove extends InsertMode {
  rowDelta: number = -1

  execute (): void {
    const translation: [number, number] = [this.rowDelta, 0]
    this.editor.transact(() => {
      for (const selection of this.editor.getSelections()) {
        const point = selection.cursor.getBufferPosition().translate(translation)
        if (point.row >= 0) {
          const range = Range.fromPointWithDelta(point, 0, 1)
          const text = this.editor.getTextInBufferRange(range)
          if (text) selection.insertText(text)
        }
      }
    })
  }
}

class CopyFromLineBelow extends CopyFromLineAbove {
  rowDelta: number = +1
}

// Insert-mode editing: ctrl-w deletes the word before the cursor, ctrl-u deletes
// back to the line's first non-blank (or column 0). Upstream maps these to Atom's
// editor commands; zym implements them directly.
class DeleteToPreviousWordBoundary extends InsertMode {
  execute (): void {
    this.editor.transact(() => {
      for (const selection of this.editor.getSelections()) {
        const point = selection.cursor.getBufferPosition()
        const before = this.editor.lineTextForBufferRow(point.row).slice(0, point.column)
        let i = before.length
        while (i > 0 && /\s/.test(before[i - 1])) i-- // trailing whitespace
        if (i > 0) {
          const wordy = /[A-Za-z0-9_]/.test(before[i - 1])
          const cls = wordy ? /[A-Za-z0-9_]/ : /[^A-Za-z0-9_\s]/
          while (i > 0 && cls.test(before[i - 1])) i--
        }
        this.editor.setTextInBufferRange([[point.row, i], point], '')
      }
    })
  }
}

class DeleteToBeginningOfInsertLine extends InsertMode {
  execute (): void {
    this.editor.transact(() => {
      for (const selection of this.editor.getSelections()) {
        const point = selection.cursor.getBufferPosition()
        const lineText = this.editor.lineTextForBufferRow(point.row)
        const firstNonBlank = lineText.search(/\S/)
        const col = firstNonBlank >= 0 && point.column > firstNonBlank ? firstNonBlank : 0
        this.editor.setTextInBufferRange([[point.row, col], point], '')
      }
    })
  }
}

// Macros. `q{reg}` starts recording keystrokes into a register, `q` stops;
// `@{reg}` replays, `@@` replays the last. Recording/replay of the raw keystrokes
// lives in the KeymapManager; this just drives it and owns the per-register store.
class RecordMacro extends MiscCommand {
  async execute (): Promise<void> {
    // TODO(vim-ts): macro record methods not yet on KeymapManager
    const km = zym.keymaps
    if (km.isRecordingMacro()) {
      this.vimState.saveMacro(this.vimState.recordingMacroRegister!, km.stopMacroRecord())
      this.vimState.recordingMacroRegister = null
    } else {
      const register = await this.readCharPromised()
      if (register && /^[a-zA-Z0-9"]$/.test(register)) {
        this.vimState.recordingMacroRegister = register
        km.startMacroRecord()
      }
    }
  }
}

class ReplayMacro extends MiscCommand {
  async execute (): Promise<void> {
    // Read the `@`-count, then clear it so it doesn't leak into the macro's own
    // operations (`2@a` replays twice; the macro's keys carry their own counts).
    const count = this.getCount()
    this.vimState.operationStack.resetCount()

    let register = await this.readCharPromised()
    if (!register) return
    if (register === '@') register = this.vimState.lastMacroRegister // @@ = repeat last
    if (!register) return
    const keys = this.vimState.getMacro(register)
    if (!keys) return
    this.vimState.lastMacroRegister = register
    for (let i = 0; i < count; i++) this.vimState.replayMacro(keys)
  }
}

class NextTab extends MiscCommand {
  execute (): void {
    const pane = atom.workspace.paneForItem(this.editor)

    if (this.hasCount()) {
      pane.activateItemAtIndex(this.getCount() - 1)
    } else {
      pane.activateNextItem()
    }
  }
}

class PreviousTab extends MiscCommand {
  execute (): void {
    atom.workspace.paneForItem(this.editor).activatePreviousItem()
  }
}

// Change list (g; / g,) — the per-editor, marker-backed edit-position ring.
// Navigation moves the cursor directly (not via a jump motion), so stepping the
// list doesn't itself record.
class GoToOlderChange extends MiscCommand {
  direction: 'goBackward' | 'goForward' = 'goBackward'
  execute (): void {
    const point: Point | null = this.vimState.changeList[this.direction](this.getCursorBufferPosition(), this.getCount())
    if (point) this.editor.setCursorBufferPosition(point)
  }
}
class GoToNewerChange extends GoToOlderChange {
  direction: 'goBackward' | 'goForward' = 'goForward'
}

// Jump list (ctrl-o / ctrl-i). There is no per-editor jump ring anymore — these
// walk the single workspace-wide list (GlobalJumpList) through the host-injected
// navigator, so `vim-mode-plus:jump-backward`/`-forward` and `workspace:jump-*`
// stay in lockstep. Unbound by default (ctrl-o/ctrl-i bind the workspace command).
class JumpBackward extends MiscCommand {
  direction: 'backward' | 'forward' = 'backward'
  execute (): void {
    this.vimState.jumpNavigate(this.direction)
  }
}
class JumpForward extends JumpBackward {
  direction: 'backward' | 'forward' = 'forward'
}

const __operations = {
  MiscCommand,
  JumpBackward,
  JumpForward,
  GoToOlderChange,
  GoToNewerChange,
  Mark,
  ReverseSelections,
  BlockwiseOtherEnd,
  Undo,
  Redo,
  FoldCurrentRow,
  UnfoldCurrentRow,
  ToggleFold,
  FoldCurrentRowRecursivelyBase,
  FoldCurrentRowRecursively,
  UnfoldCurrentRowRecursively,
  ToggleFoldRecursively,
  UnfoldAll,
  FoldAll,
  UnfoldNextIndentLevel,
  FoldNextIndentLevel,
  MiniScrollDown,
  MiniScrollUp,
  RedrawCursorLine,
  RedrawCursorLineAtTop,
  RedrawCursorLineAtTopAndMoveToFirstCharacterOfLine,
  RedrawCursorLineAtUpperMiddle,
  RedrawCursorLineAtUpperMiddleAndMoveToFirstCharacterOfLine,
  RedrawCursorLineAtMiddle,
  RedrawCursorLineAtMiddleAndMoveToFirstCharacterOfLine,
  RedrawCursorLineAtBottom,
  RedrawCursorLineAtBottomAndMoveToFirstCharacterOfLine,
  ScrollCursorToLeft,
  ScrollCursorToRight,
  ActivateNormalModeOnce,
  ToggleReplaceMode,
  InsertRegister,
  InsertLastInserted,
  CopyFromLineAbove,
  CopyFromLineBelow,
  DeleteToPreviousWordBoundary,
  DeleteToBeginningOfInsertLine,
  RecordMacro,
  ReplayMacro,
  NextTab,
  PreviousTab
}

for (const klass of Object.values(__operations)) klass.register()
export default __operations
