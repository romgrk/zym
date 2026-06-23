// Vendored from xedel/vim-mode-plus's lib/operator.js — ESM conversion only:
// `require`→`import`, and the trailing `module.exports` map becomes eager
// registration + default export. Operator logic is unchanged.
import { Range } from '../../../text/Range.ts'
import { Base } from './base.ts'
import type { Selection } from '../Selection.ts'
import type { Point } from '../../../text/Point.ts'

/** The "wise" of an operation. */
type Wise = 'characterwise' | 'linewise' | 'blockwise'

class Operator extends Base {
  static operationKind: string | null = 'operator'
  static command = false
  recordable = true

  // target is a Motion/TextObject (or transiently its string class-name).
  // TODO(vim-ts): tighten to a real Motion|TextObject union once both are typed.
  target: any = null
  wise: Wise | null = null
  occurrence = false
  occurrenceType = 'base'
  occurrenceSelected = false
  occurrenceWise: Wise | null = null

  flashTarget = true
  flashCheckpoint = 'did-finish'
  flashType = 'operator'
  flashTypeForOccurrence = 'operator-occurrence'
  trackChange = false

  patternForOccurrence: RegExp | null = null
  stayAtSamePosition: boolean | null = null
  stayOptionName: string | null = null
  stayByMarker = false
  restorePositions = true
  setToFirstCharacterOnLinewise = false

  acceptPresetOccurrence = true
  acceptPersistentSelection = true

  targetSelected: boolean | null = null
  // Base declares `input?: string`; the upstream initializer is `null`, so widen
  // to `any` to stay override-compatible without changing the runtime value.
  // TODO(vim-ts): align with Base.input once the input flow is fully typed.
  input: any = null
  readInputAfterSelect = false
  readInputBeforeSelect = false
  bufferCheckpointByPurpose: Record<string, any> = {}

  // Accumulator used by setTextToRegister for blockwise yank/delete.
  blockwiseRegisterRows: string[] | null = null

  // Subclass-only fields declared on Operator so override-compatibility holds.
  focusInputOptions?: any
  newRanges?: Range[]
  regex?: RegExp
  step?: number
  baseNumber?: number | null
  location?: string
  where?: string
  cancelled?: boolean
  sequentialPaste?: boolean
  blockwisePaste?: boolean
  linewisePaste?: boolean
  mutationsBySelection?: Map<Selection, Range>

  // Optional hook implemented by mutating subclasses (Delete/Yank/Put/...).
  mutateSelection? (selection: Selection): void

  isReady (): boolean {
    return this.target && this.target.isReady()
  }

  // Called when operation finished
  // This is essentially to reset state for `.` repeat.
  resetState (): void {
    this.targetSelected = null
    this.occurrenceSelected = false
  }

  // Two checkpoint for different purpose
  // - one for undo
  // - one for preserve last inserted text
  createBufferCheckpoint (purpose: string): void {
    this.bufferCheckpointByPurpose[purpose] = this.editor.createCheckpoint()
  }

  getBufferCheckpoint (purpose: string): any {
    return this.bufferCheckpointByPurpose[purpose]
  }

  groupChangesSinceBufferCheckpoint (purpose: string): void {
    const checkpoint = this.getBufferCheckpoint(purpose)
    if (checkpoint) {
      this.editor.groupChangesSinceCheckpoint(checkpoint)
      delete this.bufferCheckpointByPurpose[purpose]
    }
  }

  setMarkForChange (range: Range): void {
    this.vimState.mark.set('[', range.start)
    this.vimState.mark.set(']', range.end)
  }

  needFlash (): boolean {
    return (
      this.flashTarget &&
      this.getConfig('flashOnOperate') &&
      !this.getConfig('flashOnOperateBlacklist').includes(this.name) &&
      (this.mode !== 'visual' || this.submode !== this.target.wise) // e.g. Y in vC
    )
  }

  flashIfNecessary (ranges: Range[]): void {
    if (this.needFlash()) {
      this.vimState.flash(ranges, {type: this.getFlashType()})
    }
  }

  flashChangeIfNecessary (): void {
    if (this.needFlash()) {
      this.onDidFinishOperation(() => {
        const ranges = this.mutationManager.getSelectedBufferRangesForCheckpoint(this.flashCheckpoint)
        this.vimState.flash(ranges, {type: this.getFlashType()})
      })
    }
  }

  getFlashType (): string {
    return this.occurrenceSelected ? this.flashTypeForOccurrence : this.flashType
  }

  trackChangeIfNecessary (): void {
    if (!this.trackChange) return
    this.onDidFinishOperation(() => {
      const range = this.mutationManager.getMutatedBufferRangeForSelection(this.editor.getLastSelection())
      if (range) this.setMarkForChange(range)
    })
  }

  initialize (): void {
    this.subscribeResetOccurrencePatternIfNeeded()

    // When preset-occurrence was exists, operate on occurrence-wise
    if (this.acceptPresetOccurrence && this.occurrenceManager.hasMarkers()) {
      this.occurrence = true
    }

    // [FIXME] ORDER-MATTER
    // To pick cursor-word to find occurrence base pattern.
    // This has to be done BEFORE converting persistent-selection into real-selection.
    // Since when persistent-selection is actually selected, it change cursor position.
    if (this.occurrence && !this.occurrenceManager.hasMarkers()) {
      const regex = this.patternForOccurrence || this.getPatternForOccurrenceType(this.occurrenceType)
      this.occurrenceManager.addPattern(regex)
    }

    // This change cursor position.
    if (this.selectPersistentSelectionIfNecessary()) {
      // [FIXME] selection-wise is not synched if it already visual-mode
      if (this.mode !== 'visual') {
        this.vimState.activate('visual', this.swrap.detectWise(this.editor))
      }
    }

    if (this.mode === 'visual') {
      this.target = 'CurrentSelection'
    }
    if (typeof this.target === 'string') {
      this.setTarget(this.getInstance(this.target))
    }

    super.initialize()
  }

  subscribeResetOccurrencePatternIfNeeded (): void {
    // [CAUTION]
    // This method has to be called in PROPER timing.
    // If occurrence is true but no preset-occurrence
    // Treat that `occurrence` is BOUNDED to operator itself, so cleanp at finished.
    if (this.occurrence && !this.occurrenceManager.hasMarkers()) {
      this.onDidResetOperationStack(() => this.occurrenceManager.resetPatterns())
    }
  }

  setModifier ({wise, occurrence, occurrenceType}: {wise?: Wise, occurrence?: boolean, occurrenceType: string}): void {
    if (wise) {
      this.wise = wise
    } else if (occurrence) {
      this.occurrence = occurrence
      this.occurrenceType = occurrenceType
      // This is o modifier case(e.g. `c o p`, `d O f`)
      // We RESET existing occurence-marker when `o` or `O` modifier is typed by user.
      const regex = this.getPatternForOccurrenceType(occurrenceType)
      this.occurrenceManager.addPattern(regex, {reset: true, occurrenceType})
      this.onDidResetOperationStack(() => this.occurrenceManager.resetPatterns())
    }
  }

  // return true/false to indicate success
  selectPersistentSelectionIfNecessary (): boolean {
    const canSelect =
      this.acceptPersistentSelection &&
      this.getConfig('autoSelectPersistentSelectionOnOperate') &&
      !this.persistentSelection.isEmpty()

    if (canSelect) {
      this.persistentSelection.select()
      this.editor.mergeIntersectingSelections()
      this.swrap.saveProperties(this.editor)
      return true
    } else {
      return false
    }
  }

  getPatternForOccurrenceType (occurrenceType: string): RegExp | undefined {
    if (occurrenceType === 'base') {
      return this.utils.getWordPatternAtBufferPosition(this.editor, this.getCursorBufferPosition())
    } else if (occurrenceType === 'subword') {
      return this.utils.getSubwordPatternAtBufferPosition(this.editor, this.getCursorBufferPosition())
    }
  }

  // target is TextObject or Motion to operate on.
  setTarget (target: any): void {
    this.target = target
    this.target.operator = this
    this.emitDidSetTarget(this)
  }

  setTextToRegister (text: string, selection: Selection): void {
    if (this.vimState.register.isUnnamed() && this.isBlackholeRegisteredOperator()) {
      return
    }

    const wise = this.occurrenceSelected ? this.occurrenceWise : this.target.wise

    // Blockwise: each member row calls this once, top-to-bottom (the order
    // `mutateSelections` iterates). Accumulate the rows and flush them once, on
    // the last (bottom) row, as a single blockwise-typed register value — paste
    // reconstructs the columns from it. (Upstream leans on Atom's per-selection
    // clipboard + native multi-cursor here; zym has neither, so it stores the
    // whole block in the register.)
    if (wise === 'blockwise') {
      if (!this.blockwiseRegisterRows) this.blockwiseRegisterRows = []
      this.blockwiseRegisterRows.push(text)
      if (!selection.isLastSelection()) return
      const blockText = this.blockwiseRegisterRows.join('\n')
      this.blockwiseRegisterRows = null
      // TODO(vim-ts): RegisterType has no 'blockwise'; type loosely until the
      // register models blockwise values.
      const value = (): any => ({text: blockText, type: 'blockwise', selection})
      this.vimState.register.set(null, value())
      if (this.vimState.register.isUnnamed()) {
        if (this.instanceof('Yank')) this.vimState.register.set('0', value())
        else if (this.instanceof('Delete') || this.instanceof('Change')) this.vimState.register.set('1', value())
      }
      // The default register routes through the system clipboard, which carries
      // only plain text (wise is otherwise inferred from a trailing newline).
      // Remember this exact text as blockwise so paste can still column-restore
      // it; cleared by the next non-blockwise yank/delete below.
      this.vimState.register.lastBlockwiseText = blockText
      return
    }

    this.vimState.register.lastBlockwiseText = null

    if (wise === 'linewise' && !text.endsWith('\n')) {
      text += '\n'
    }

    if (text) {
      this.vimState.register.set(null, {text, selection})

      if (this.vimState.register.isUnnamed()) {
        if (this.instanceof('Delete') || this.instanceof('Change')) {
          if (!this.needSaveToNumberedRegister(this.target) && this.utils.isSingleLineText(text)) {
            this.vimState.register.set('-', {text, selection}) // small-change
          } else {
            this.vimState.register.set('1', {text, selection})
          }
        } else if (this.instanceof('Yank')) {
          this.vimState.register.set('0', {text, selection})
        }
      }
    }
  }

  isBlackholeRegisteredOperator (): boolean {
    const operators: string[] = this.getConfig('blackholeRegisteredOperators')
    const wildCardOperators = operators.filter((name: string) => name.endsWith('*'))
    const commandName = this.getCommandNameWithoutPrefix()
    return (
      wildCardOperators.some((name: string) => new RegExp('^' + name.replace('*', '.*')).test(commandName)) ||
      operators.includes(commandName)
    )
  }

  needSaveToNumberedRegister (target: any): boolean {
    // Used to determine what register to use on change and delete operation.
    // Following motion should save to 1-9 register regerdless of content is small or big.
    const goesToNumberedRegisterMotionNames = [
      'MoveToPair', // %
      'MoveToNextSentence', // (, )
      'Search', // /, ?, n, N
      'MoveToNextParagraph' // {, }
    ]
    return goesToNumberedRegisterMotionNames.some(name => target.instanceof(name))
  }

  normalizeSelectionsIfNecessary (): void {
    if (this.mode === 'visual' && this.target && this.target.isMotion()) {
      this.swrap.normalize(this.editor)
    }
  }

  mutateSelections (): void {
    // Coalesce every selection's mutation into ONE undo step, so a multi-cursor
    // operation (blockwise / occurrence / multiple cursors) undoes as a whole.
    // Inner per-edit `transact`s nest into this outer user action.
    this.editor.transact(() => {
      for (const selection of this.editor.getSelectionsOrderedByBufferPosition()) {
        this.mutateSelection!(selection)
      }
    })
    this.mutationManager.setCheckpoint('did-finish')
    this.restoreCursorPositionsIfNecessary()
  }

  preSelect (): void {
    this.normalizeSelectionsIfNecessary()
    this.createBufferCheckpoint('undo')
  }

  postMutate (): void {
    this.groupChangesSinceBufferCheckpoint('undo')
    this.emitDidFinishMutation()

    // Even though we fail to select target and fail to mutate,
    // we have to return to normal-mode from operator-pending or visual
    this.activateMode('normal')
  }

  // Main
  execute (): void | Promise<void> {
    this.preSelect()

    // Read the operator's input (e.g. the surround pair char) BEFORE selecting
    // the target, so the target is never highlighted while we wait for the key.
    if (this.readInputBeforeSelect && !this.repeated) {
      return this.executeAsyncToReadInputBeforeSelect()
    }

    if (this.readInputAfterSelect && !this.repeated) {
      return this.executeAsyncToReadInputAfterSelect()
    }

    if (this.selectTarget()) this.mutateSelections()
    this.postMutate()
  }

  async executeAsyncToReadInputBeforeSelect (): Promise<void> {
    this.input = await this.focusInputPromised(this.focusInputOptions)
    if (this.input == null) {
      // Nothing was mutated yet (target not selected), so just leave the mode.
      if (this.mode !== 'visual') this.activateMode('normal')
      return
    }
    if (this.selectTarget()) this.mutateSelections()
    this.postMutate()
  }

  async executeAsyncToReadInputAfterSelect (): Promise<void> {
    if (this.selectTarget()) {
      this.input = await this.focusInputPromised(this.focusInputOptions)
      if (this.input == null) {
        if (this.mode !== 'visual') {
          this.editor.revertToCheckpoint(this.getBufferCheckpoint('undo'))
          this.activateMode('normal')
        }
        return
      }
      this.mutateSelections()
    }
    this.postMutate()
  }

  // Return true unless all selection is empty.
  selectTarget (): boolean {
    if (this.targetSelected != null) {
      return this.targetSelected
    }
    this.mutationManager.init({stayByMarker: this.stayByMarker})

    if (this.target.isMotion() && this.mode === 'visual') this.target.wise = this.submode
    if (this.wise != null) this.target.forceWise(this.wise)

    this.emitWillSelectTarget()

    // Allow cursor position adjustment 'on-will-select-target' hook.
    // so checkpoint comes AFTER @emitWillSelectTarget()
    this.mutationManager.setCheckpoint('will-select')

    // NOTE: When repeated, set occurrence-marker from pattern stored as state.
    if (this.repeated && this.occurrence && !this.occurrenceManager.hasMarkers()) {
      this.occurrenceManager.addPattern(this.patternForOccurrence, {occurrenceType: this.occurrenceType})
    }

    this.target.execute()

    this.mutationManager.setCheckpoint('did-select')
    if (this.occurrence) {
      if (!this.patternForOccurrence) {
        // Preserve occurrencePattern for . repeat.
        this.patternForOccurrence = this.occurrenceManager.buildPattern()
      }

      this.occurrenceWise = this.wise || 'characterwise'
      if (this.occurrenceManager.select(this.occurrenceWise)) {
        this.occurrenceSelected = true
        this.mutationManager.setCheckpoint('did-select-occurrence')
      }
    }

    this.targetSelected = this.vimState.haveSomeNonEmptySelection() || this.target.name === 'Empty'
    if (this.targetSelected) {
      this.emitDidSelectTarget()
      this.flashChangeIfNecessary()
      this.trackChangeIfNecessary()
    } else {
      this.emitDidFailSelectTarget()
    }

    return this.targetSelected
  }

  restoreCursorPositionsIfNecessary (): void {
    if (!this.restorePositions) return

    const stay =
      this.stayAtSamePosition != null
        ? this.stayAtSamePosition
        : this.getConfig(this.stayOptionName as string) || (this.occurrenceSelected && this.getConfig('stayOnOccurrence'))
    const wise = this.occurrenceSelected ? this.occurrenceWise : this.target.wise
    const {setToFirstCharacterOnLinewise} = this
    this.mutationManager.restoreCursorPositions({stay, wise, setToFirstCharacterOnLinewise})
  }
}

class SelectBase extends Operator {
  static command = false
  flashTarget = false
  recordable = false

  execute (): void {
    this.normalizeSelectionsIfNecessary()
    this.selectTarget()

    if (this.target.selectSucceeded) {
      if (this.target.isTextObject()) {
        this.editor.scrollToCursorPosition()
      }
      const wise = this.occurrenceSelected ? this.occurrenceWise : this.target.wise
      this.activateModeIfNecessary('visual', wise)
    } else {
      this.cancelOperation()
    }
  }
}

class Select extends SelectBase {
  execute (): void {
    this.swrap.saveProperties(this.editor)
    super.execute()
  }
}

class SelectLatestChange extends SelectBase {
  target: any = 'ALatestChange'
}

class SelectPreviousSelection extends SelectBase {
  target: any = 'PreviousSelection'
}

class SelectPersistentSelection extends SelectBase {
  target: any = 'APersistentSelection'
  acceptPersistentSelection = false
}

class SelectOccurrence extends SelectBase {
  occurrence = true
}

// VisualModeSelect: used in visual-mode
// When text-object is invoked from normal or viusal-mode, operation would be
//  => VisualModeSelect operator with target=text-object
// When motion is invoked from visual-mode, operation would be
//  => VisualModeSelect operator with target=motion)
// ================================
// VisualModeSelect is used in TWO situation.
// - visual-mode operation
//   - e.g: `v l`, `V j`, `v i p`...
// - Directly invoke text-object from normal-mode
//   - e.g: Invoke `Inner Paragraph` from command-palette.
class VisualModeSelect extends SelectBase {
  static command = false
  acceptPresetOccurrence = false
  acceptPersistentSelection = false
}

// Persistent Selection
// =========================
class CreatePersistentSelection extends Operator {
  flashTarget = false
  stayAtSamePosition = true
  acceptPresetOccurrence = false
  acceptPersistentSelection = false

  mutateSelection (selection: Selection): void {
    this.persistentSelection.markBufferRange(selection.getBufferRange())
  }
}

class TogglePersistentSelection extends CreatePersistentSelection {
  initialize (): void {
    if (this.mode === 'normal') {
      const point = this.editor.getCursorBufferPosition()
      const marker = this.persistentSelection.getMarkerAtPoint(point)
      if (marker) this.target = 'Empty'
    }
    super.initialize()
  }

  mutateSelection (selection: Selection): void {
    const point = this.getCursorPositionForSelection(selection)
    const marker = this.persistentSelection.getMarkerAtPoint(point)
    if (marker) {
      marker.destroy()
    } else {
      super.mutateSelection(selection)
    }
  }
}

// Preset Occurrence
// =========================
class TogglePresetOccurrence extends Operator {
  target: any = 'Empty'
  flashTarget = false
  acceptPresetOccurrence = false
  acceptPersistentSelection = false
  occurrenceType = 'base'

  execute (): void {
    const marker = this.occurrenceManager.getMarkerAtPoint(this.getCursorBufferPosition())
    if (marker) {
      this.occurrenceManager.destroyMarkers([marker])
    } else {
      const isNarrowed = this.vimState.isNarrowed()

      let regex
      if (this.mode === 'visual' && !isNarrowed) {
        this.occurrenceType = 'base'
        regex = new RegExp(this._.escapeRegExp(this.editor.getSelectedText()), 'g')
      } else {
        regex = this.getPatternForOccurrenceType(this.occurrenceType)
      }

      this.occurrenceManager.addPattern(regex, {occurrenceType: this.occurrenceType})
      this.occurrenceManager.saveLastPattern(this.occurrenceType)

      if (!isNarrowed) this.activateMode('normal')
    }
  }
}

class TogglePresetSubwordOccurrence extends TogglePresetOccurrence {
  occurrenceType = 'subword'
}

// Want to rename RestoreOccurrenceMarker
class AddPresetOccurrenceFromLastOccurrencePattern extends TogglePresetOccurrence {
  execute (): void {
    this.occurrenceManager.resetPatterns()
    const regex = this.globalState.get('lastOccurrencePattern')
    if (regex) {
      const occurrenceType = this.globalState.get('lastOccurrenceType') as string | undefined
      this.occurrenceManager.addPattern(regex, {occurrenceType})
      this.activateMode('normal')
    }
  }
}

// Delete
// ================================
class Delete extends Operator {
  trackChange = true
  flashCheckpoint = 'did-select-occurrence'
  flashTypeForOccurrence = 'operator-remove-occurrence'
  stayOptionName = 'stayOnDelete'
  setToFirstCharacterOnLinewise = true

  execute (): void {
    this.onDidSelectTarget(() => {
      if (this.occurrenceSelected && this.occurrenceWise === 'linewise') {
        this.flashTarget = false
      }
    })

    if (this.target.wise === 'blockwise') {
      this.restorePositions = false
    }
    super.execute()
  }

  selectTarget (): boolean {
    if (super.selectTarget()) return true
    // The generic guard rejects an *empty* selection. The one linewise case that
    // must still delete is the empty row GtkSourceView renders after the file's
    // final newline: it has no trailing newline to span, so its forward linewise
    // range is empty. Accept it — mutateSelection borrows the preceding newline.
    const wise = this.occurrenceSelected ? this.occurrenceWise : this.target.wise
    const row = this.editor.getCursorBufferPosition().row
    if (wise === 'linewise' && row > 0 && row === this.editor.getLastBufferRow() && this.editor.lineTextForBufferRow(row) === '') {
      this.targetSelected = true
      this.emitDidSelectTarget()
    }
    return this.targetSelected ?? false
  }

  mutateSelection (selection: Selection): void {
    this.setTextToRegister(selection.getText(), selection)
    const wise = this.occurrenceSelected ? this.occurrenceWise : this.target.wise
    // A linewise range that reaches the buffer's last row is short one newline:
    // the last row never has a trailing one, so deleting forward removes nothing
    // (or leaves a stray empty row). Borrow the *preceding* newline instead —
    // how Vim removes the final line, and what makes `dd` delete the empty row
    // GtkSourceView renders after the file's final newline.
    if (wise === 'linewise') {
      const range = selection.getBufferRange()
      if (range.end.row === this.editor.getLastBufferRow() && range.start.row > 0) {
        const prevEnd = this.editor.bufferRangeForBufferRow(range.start.row - 1).end
        selection.setBufferRange(new Range(prevEnd, range.end))
      }
    }
    selection.deleteSelectedText()
  }
}

class DeleteRight extends Delete {
  target: any = 'MoveRight'
}

class DeleteLeft extends Delete {
  target: any = 'MoveLeft'
}

class DeleteToLastCharacterOfLine extends Delete {
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

class DeleteLine extends Delete {
  wise: Wise = 'linewise'
  target: any = 'MoveToRelativeLine'
  flashTarget = false
}

// Yank
// =========================
class Yank extends Operator {
  trackChange = true
  stayOptionName = 'stayOnYank'

  mutateSelection (selection: Selection): void {
    this.setTextToRegister(selection.getText(), selection)
  }
}

class YankLine extends Yank {
  wise: Wise = 'linewise'
  target: any = 'MoveToRelativeLine'
}

class YankToLastCharacterOfLine extends Yank {
  target: any = 'MoveToLastCharacterOfLine'
}

// Yank diff hunk at cursor by removing leading "+" or "-" from each line
class YankDiffHunk extends Yank {
  target: any = 'InnerDiffHunk'
  mutateSelection (selection: Selection): void {
    // Remove leading "+" or "-" in diff hunk
    const textToYank = selection.getText().replace(/^./gm, '')
    this.setTextToRegister(textToYank, selection)
  }
}

// ReplaceWithRegister (port of romgrk/replace.vim): replace the target with the
// content of the register (`s{motion}`, `ss` current line, `S` = whole line). The
// replaced text is discarded (blackhole) rather than yanked, so the register used
// for the replacement keeps its content across repeated replaces. (Named to avoid
// the vmp `Replace` transform-string operator, which reads a char instead.)
class ReplaceWithRegister extends Operator {
  trackChange = true
  stayOptionName = 'stayOnDelete'

  mutateSelection (selection: Selection): void {
    const value = this.vimState.register.get(null, selection)
    let text = value && value.text != null ? value.text : ''
    const linewise = this.target.wise === 'linewise' || this.isMode('visual', 'linewise')
    // Match the register's shape to a linewise target (and vice-versa) so the line
    // structure stays intact.
    if (linewise) {
      if (!text.endsWith('\n')) text += '\n'
    } else if (text.endsWith('\n')) {
      text = text.replace(/\n+$/, '')
    }
    selection.insertText(text)
  }
}

class ReplaceLineWithRegister extends ReplaceWithRegister {
  wise: Wise = 'linewise'
  target: any = 'MoveToRelativeLine'
}

// -------------------------
// [ctrl-a]
class Increase extends Operator {
  target: any = 'Empty' // ctrl-a in normal-mode find target number in current line manually
  flashTarget = false // do manually
  restorePositions = false // do manually
  step = 1
  newRanges: Range[] = []
  regex?: RegExp

  execute (): void {
    this.newRanges = []
    if (!this.regex) this.regex = new RegExp(`${this.getConfig('numberRegex')}`, 'g')

    super.execute()

    if (this.newRanges.length) {
      if (this.getConfig('flashOnOperate') && !this.getConfig('flashOnOperateBlacklist').includes(this.name)) {
        this.vimState.flash(this.newRanges, {type: this.flashTypeForOccurrence})
      }
    }
  }

  replaceNumberInBufferRange (scanRange: Range, fn?: (event: any) => boolean): Range[] {
    const newRanges: Range[] = []
    this.scanEditor('forward', this.regex!, {scanRange}, (event: any) => {
      if (fn) {
        if (fn(event)) event.stop()
        else return
      }
      const nextNumber = this.getNextNumber(event.matchText)
      newRanges.push(event.replace(String(nextNumber)))
    })
    return newRanges
  }

  mutateSelection (selection: Selection): void {
    const {cursor} = selection
    if (this.target.name === 'Empty') {
      // ctrl-a, ctrl-x in `normal-mode`
      const cursorPosition = cursor.getBufferPosition()
      const scanRange = this.editor.bufferRangeForBufferRow(cursorPosition.row)
      const newRanges = this.replaceNumberInBufferRange(scanRange, (event: any) =>
        event.range.end.isGreaterThan(cursorPosition)
      )
      const point = (newRanges.length && newRanges[0].end.translate([0, -1])) || cursorPosition
      cursor.setBufferPosition(point)
    } else {
      const scanRange = selection.getBufferRange()
      this.newRanges.push(...this.replaceNumberInBufferRange(scanRange))
      cursor.setBufferPosition(scanRange.start)
    }
  }

  getNextNumber (numberString: string): number {
    return Number.parseInt(numberString, 10) + this.step * this.getCount()
  }
}

// [ctrl-x]
class Decrease extends Increase {
  step = -1
}

// -------------------------
// [g ctrl-a]
class IncrementNumber extends Increase {
  baseNumber: number | null = null
  target: any = null

  getNextNumber (numberString: string): number {
    if (this.baseNumber != null) {
      this.baseNumber += this.step * this.getCount()
    } else {
      this.baseNumber = Number.parseInt(numberString, 10)
    }
    return this.baseNumber
  }
}

// [g ctrl-x]
class DecrementNumber extends IncrementNumber {
  step = -1
}

// Put
// -------------------------
// Cursor placement:
// - place at end of mutation: paste non-multiline characterwise text
// - place at start of mutation: non-multiline characterwise text(characterwise, linewise)
class PutBefore extends Operator {
  location = 'before'
  target: any = 'Empty'
  flashType = 'operator-long'
  restorePositions = false // manage manually
  flashTarget = false // manage manually
  trackChange = false // manage manually
  mutationsBySelection: Map<Selection, Range> = new Map()

  initialize (): void {
    this.vimState.sequentialPasteManager.onInitialize(this)
    super.initialize()
  }

  execute (): void {
    this.mutationsBySelection = new Map()
    this.sequentialPaste = this.vimState.sequentialPasteManager.onExecute(this)

    this.onDidFinishMutation(() => {
      if (!this.cancelled) this.adjustCursorPosition()
    })

    super.execute()

    if (this.cancelled) return

    this.onDidFinishOperation(() => {
      // TrackChange
      const newRange = this.mutationsBySelection.get(this.editor.getLastSelection())
      if (newRange) this.setMarkForChange(newRange)

      // Flash
      if (this.getConfig('flashOnOperate') && !this.getConfig('flashOnOperateBlacklist').includes(this.name)) {
        const ranges = this.editor.getSelections().map(selection => this.mutationsBySelection.get(selection))
        this.vimState.flash(ranges, {type: this.getFlashType()})
      }
    })
  }

  adjustCursorPosition (): void {
    for (const selection of this.editor.getSelections()) {
      if (!this.mutationsBySelection.has(selection)) continue

      const {cursor} = selection
      const newRange = this.mutationsBySelection.get(selection)!
      if (this.linewisePaste) {
        this.utils.moveCursorToFirstCharacterAtRow(cursor, newRange.start.row)
      } else {
        if (newRange.isSingleLine()) {
          cursor.setBufferPosition(newRange.end.translate([0, -1]))
        } else {
          cursor.setBufferPosition(newRange.start)
        }
      }
    }
  }

  mutateSelection (selection: Selection): void {
    // TODO(vim-ts): register.get returns RegisterValue|null and RegisterType has
    // no 'blockwise'/'lastBlockwiseText' member; cast until RegisterManager models
    // blockwise (see setTextToRegister).
    const value: any = this.vimState.register.get(null, selection, this.sequentialPaste)
    if (!value.text) {
      this.cancelled = true
      return
    }

    // `value.type` is lost when the register round-trips through the clipboard,
    // so also treat text matching the last blockwise yank/delete as blockwise.
    this.blockwisePaste =
      value.type === 'blockwise' ||
      (this.vimState.register.lastBlockwiseText != null && value.text === this.vimState.register.lastBlockwiseText)
    const textToPaste = this.blockwisePaste ? value.text : value.text.repeat(this.getCount())
    this.linewisePaste = value.type === 'linewise' || this.isMode('visual', 'linewise')
    const newRange = this.paste(selection, textToPaste, {linewisePaste: this.linewisePaste})
    this.mutationsBySelection.set(selection, newRange)
    this.vimState.sequentialPasteManager.savePastedRangeForSelection(selection, newRange)
  }

  // Return pasted range
  paste (selection: Selection, text: string, {linewisePaste}: {linewisePaste?: boolean}): Range {
    if (this.sequentialPaste) {
      return this.pasteCharacterwise(selection, text)
    } else if (this.blockwisePaste) {
      return this.pasteBlockwise(selection, text)
    } else if (linewisePaste) {
      // pasteLinewise only returns undefined on an unreachable location branch.
      return this.pasteLinewise(selection, text) as Range
    } else {
      return this.pasteCharacterwise(selection, text)
    }
  }

  // Paste a blockwise register: each yanked row goes onto a successive buffer
  // row at the cursor's column, padding short rows with spaces and appending new
  // rows past end-of-buffer. (`p` inserts after the cursor column, `P` before.)
  pasteBlockwise (selection: Selection, text: string): Range {
    const lines = text.split('\n')
    const count = this.getCount()
    const {row, column} = selection.cursor.getBufferPosition()
    const startColumn = this.location === 'after' && !this.isEmptyRow(row) ? column + 1 : column

    let firstStart: Point | null = null
    let lastEnd: Point | null = null
    for (let i = 0; i < lines.length; i++) {
      const targetRow = row + i
      while (targetRow > this.editor.getLastBufferRow()) {
        const eof = this.editor.bufferRangeForBufferRow(this.editor.getLastBufferRow()).end
        this.utils.insertTextAtBufferPosition(this.editor, eof, '\n')
      }
      const lineLength = this.editor.lineLength(targetRow) // codepoint length (see EditorModel)
      const pad = lineLength < startColumn ? ' '.repeat(startColumn - lineLength) : ''
      const insertColumn = Math.min(startColumn, lineLength)
      const range = this.utils.insertTextAtBufferPosition(this.editor, [targetRow, insertColumn], pad + lines[i].repeat(count))
      if (!firstStart) firstStart = range.start
      lastEnd = range.end
    }
    return new Range(firstStart as Point, lastEnd as Point)
  }

  pasteCharacterwise (selection: Selection, text: string): Range {
    const {cursor} = selection
    if (selection.isEmpty() && this.location === 'after' && !this.isEmptyRow(cursor.getBufferRow())) {
      cursor.moveRight()
    }
    return selection.insertText(text)
  }

  // Return newRange
  pasteLinewise (selection: Selection, text: string): Range | undefined {
    const {cursor} = selection
    const cursorRow = cursor.getBufferRow()
    if (!text.endsWith('\n')) {
      text += '\n'
    }
    if (selection.isEmpty()) {
      if (this.location === 'before') {
        return this.utils.insertTextAtBufferPosition(this.editor, [cursorRow, 0], text)
      } else if (this.location === 'after') {
        const targetRow = this.getFoldEndRowForRow(cursorRow)
        this.utils.ensureEndsWithNewLineForBufferRow(this.editor, targetRow)
        return this.utils.insertTextAtBufferPosition(this.editor, [targetRow + 1, 0], text)
      }
    } else {
      if (!this.isMode('visual', 'linewise')) {
        selection.insertText('\n')
      }
      return selection.insertText(text)
    }
  }
}

class PutAfter extends PutBefore {
  location = 'after'
}

class PutBeforeWithAutoIndent extends PutBefore {
  pasteLinewise (selection: Selection, text: string): Range | undefined {
    const newRange = super.pasteLinewise(selection, text)
    this.utils.adjustIndentWithKeepingLayout(this.editor, newRange as Range)
    return newRange
  }
}

class PutAfterWithAutoIndent extends PutBeforeWithAutoIndent {
  location = 'after'
}

class AddBlankLineBelow extends Operator {
  flashTarget = false
  target: any = 'Empty'
  stayAtSamePosition = true
  stayByMarker = true
  where = 'below'

  mutateSelection (selection: Selection): void {
    const point = selection.getHeadBufferPosition()
    if (this.where === 'below') point.row++
    point.column = 0
    this.editor.setTextInBufferRange([point, point], '\n'.repeat(this.getCount()))
  }
}

class AddBlankLineAbove extends AddBlankLineBelow {
  where = 'above'
}

// SplitLine — inverse of `J` (Join). Breaks the line at each cursor by inserting
// a newline, dropping the text from the cursor onward to a new line. The cursor
// stays at the end of the resulting first line (like `i<CR><Esc>`). Bound to
// ctrl-j. We position cursors explicitly, so restorePositions is disabled.
class SplitLine extends Operator {
  flashTarget = false
  target: any = 'Empty'
  restorePositions = false

  mutateSelection (selection: Selection): void {
    const point = selection.getHeadBufferPosition()
    this.editor.setTextInBufferRange([point, point], '\n')
    const column = point.column > 0 ? point.column - 1 : 0
    selection.cursor.setBufferPosition([point.row, column])
  }
}

class ResolveGitConflict extends Operator {
  target: any = 'Empty'
  restorePositions = false // do manually

  mutateSelection (selection: Selection): void {
    const point = this.getCursorPositionForSelection(selection)
    const rangeInfo = this.getConflictingRangeInfo(point.row)

    if (rangeInfo) {
      const {whole, sectionOurs, sectionTheirs, bodyOurs, bodyTheirs} = rangeInfo
      const resolveConflict = (range: Range) => {
        const text = this.editor.getTextInBufferRange(range)
        const dstRange = this.getBufferRangeForRowRange([whole.start.row, whole.end.row])
        const newRange = this.editor.setTextInBufferRange(dstRange, text ? text + '\n' : '')
        selection.cursor.setBufferPosition(newRange.start)
      }
      // NOTE: When cursor is at separator row '=======', no replace happens because it's ambiguous.
      if (sectionOurs.containsPoint(point)) {
        resolveConflict(bodyOurs)
      } else if (sectionTheirs.containsPoint(point)) {
        resolveConflict(bodyTheirs)
      }
    }
  }

  getConflictingRangeInfo (row: number): any {
    const from: [number, number] = [row, Infinity]
    const conflictStart = this.findInEditor('backward', /^<<<<<<< .+$/, {from}, (event: any) => event.range.start)

    if (conflictStart) {
      const startRow = conflictStart.row
      let separatorRow: number | undefined, endRow: number | undefined
      const from: [number, number] = [startRow + 1, 0]
      const regex = /(^<<<<<<< .+$)|(^=======$)|(^>>>>>>> .+$)/g
      this.scanEditor('forward', regex, {from}, ({match, range, stop}: any) => {
        if (match[1]) {
          // incomplete conflict hunk, we saw next conflict startRow wihout seeing endRow
          stop()
        } else if (match[2]) {
          separatorRow = range.start.row
        } else if (match[3]) {
          endRow = range.start.row
          stop()
        }
      })
      if (!endRow) return
      const whole = new Range([startRow, 0], [endRow, Infinity])
      const sectionOurs = new Range(whole.start, [(separatorRow || endRow) - 1, Infinity])
      const sectionTheirs = new Range([(separatorRow || startRow) + 1, 0], whole.end)

      const bodyOursStart = sectionOurs.start.translate([1, 0])
      const bodyOurs =
        sectionOurs.getRowCount() === 1
          ? new Range(bodyOursStart, bodyOursStart)
          : new Range(bodyOursStart, sectionOurs.end)

      const bodyTheirs =
        sectionTheirs.getRowCount() === 1
          ? new Range(sectionTheirs.start, sectionTheirs.start)
          : sectionTheirs.translate([0, 0], [-1, 0])
      return {whole, sectionOurs, sectionTheirs, bodyOurs, bodyTheirs}
    }
  }
}

const __operations = {
  Operator,
  SelectBase,
  Select,
  SelectLatestChange,
  SelectPreviousSelection,
  SelectPersistentSelection,
  SelectOccurrence,
  VisualModeSelect,
  CreatePersistentSelection,
  TogglePersistentSelection,
  TogglePresetOccurrence,
  TogglePresetSubwordOccurrence,
  AddPresetOccurrenceFromLastOccurrencePattern,
  Delete,
  DeleteRight,
  DeleteLeft,
  DeleteToLastCharacterOfLine,
  DeleteLine,
  Yank,
  YankLine,
  YankToLastCharacterOfLine,
  YankDiffHunk,
  ReplaceWithRegister,
  ReplaceLineWithRegister,
  Increase,
  Decrease,
  IncrementNumber,
  DecrementNumber,
  PutBefore,
  PutAfter,
  PutBeforeWithAutoIndent,
  PutAfterWithAutoIndent,
  AddBlankLineBelow,
  AddBlankLineAbove,
  SplitLine,
  ResolveGitConflict
}

for (const klass of Object.values(__operations)) klass.register()
export default __operations
// Named export for subclassing modules (operator-insert, operator-transform-string).
export { Operator }
