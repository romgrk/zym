/*
 * Base — superclass of every vim operation (operators, motions, text-objects).
 *
 * Vendored from xedel/vim-mode-plus's lib/base.js with these quilx adaptations:
 *   - ESM instead of CommonJS (`require` → `import`, `module.exports` → `export`);
 *   - the base↔vim-state import cycle is broken: the upstream `static
 *     registerCommand()` (the only user of VimState here) is dropped, since quilx
 *     registers commands through `quilx.commands`/`quilx.keymaps` separately;
 *   - lazy class loading via `json/file-table.json` is replaced by an eager
 *     registry: operation modules call `Klass.register()` at import time and
 *     `getClass` is a plain lookup (quilx has no startup-time pressure to defer).
 *
 * Everything else — the count/repeat machinery and the vimState proxy getters —
 * is preserved so vendored operation subclasses port unchanged.
 */
import settings from './settings.ts';
import type VimState from './vim-state.ts';
import type { VimMode, VimSubmode } from './vim-state.ts';
import type { EditorModel } from '../EditorModel.ts';
import type { Cursor } from '../Cursor.ts';
import type { Selection } from '../Selection.ts';
import type { Point } from '../../../text/Point.ts';
import type { Range } from '../../../text/Range.ts';
import type { Disposable } from '../../../util/eventKit.ts';
import type { Operator } from './operator.ts';

/**
 * The kind tag every operation declares as a static; drives dispatch predicates.
 * Subclasses assign a bare string literal (`static operationKind = 'motion'`,
 * which strip-only TS widens to `string`), so the field is typed `string | null`
 * to stay override-compatible; `OperationKind` documents the expected values.
 */
type OperationKind = 'operator' | 'motion' | 'text-object' | 'misc-command'

/** Options accepted by `focusInput` (mirrors `VimState.focusInput`). */
interface FocusInputOptions {
  onConfirm?: (input: string) => void
  onCancel?: () => void
  onChange?: (input: string) => void
  hideCursor?: boolean
  charsMax?: number
  purpose?: string
}

const classify = (s: string): string => s[0].toUpperCase() + s.slice(1).replace(/-(\w)/g, m => m[1].toUpperCase())
const dasherize = (s: string): string => (s[0].toLowerCase() + s.slice(1)).replace(/[A-Z]/g, m => '-' + m.toLowerCase())

export class Base {
  static classByName = new Map<string, typeof Base>()
  static commandPrefix = 'vim-mode-plus'
  static commandScope = 'atom-text-editor'
  static operationKind: string | null = null
  // Whether the subclass is exposed as a command (overridable via own `command`).
  static command?: boolean

  vimState: VimState
  recordable = false
  repeated = false
  count: number | null = null
  defaultCount = 1

  // Dynamically-assigned operation fields (set by the operation stack / subclasses).
  input?: string
  operator?: Operator
  target?: Base

  get name (): string {
    return this.constructor.name
  }

  constructor (vimState: VimState) {
    this.vimState = vimState
  }

  initialize (): void {}

  // Called both on cancel and success
  resetState (): void {}

  // OperationStack postpone execution untill isReady() get true, overridden on subclass.
  isReady (): boolean {
    return true
  }

  // VisualModeSelect is anormal, since it's auto complemented in visial mode.
  // In other word, normal-operator is explicit whereas anormal-operator is implicit.
  isTargetOfNormalOperator (): boolean | undefined {
    return this.operator && this.operator.name !== 'VisualModeSelect'
  }

  hasCount (): boolean {
    return this.vimState.hasCount()
  }

  getCount (): number {
    if (this.count == null) {
      this.count = this.hasCount() ? this.vimState.getCount() : this.defaultCount
    }
    // hasCount() is true here whenever getCount() returned a number, so count is set.
    return this.count!
  }

  // Identical to utils.limitNumber. Copy here to postpone full require of utils.
  limitNumber (number: number, {max, min}: {max?: number, min?: number} = {}): number {
    if (max != null) number = Math.min(number, max)
    if (min != null) number = Math.max(number, min)
    return number
  }

  resetCount (): void {
    this.count = null
  }

  countTimes (last: number, fn: (state: {count: number, isFinal: boolean, stop: () => void}) => void): void {
    if (last < 1) return

    let stopped = false
    const stop = () => (stopped = true)
    for (let count = 1; count <= last; count++) {
      fn({count, isFinal: count === last, stop})
      if (stopped) break
    }
  }

  activateMode (mode: VimMode, submode?: VimSubmode): void {
    this.onDidFinishOperation(() => {
      this.vimState.activate(mode, submode)
    })
  }

  activateModeIfNecessary (mode: VimMode, submode?: VimSubmode): void {
    if (!this.vimState.isMode(mode, submode)) {
      this.activateMode(mode, submode)
    }
  }

  getInstance (name: string | typeof Base, properties?: Record<string, unknown>): Base {
    return (this.constructor as typeof Base).getInstance(this.vimState, name, properties)
  }

  cancelOperation (): void {
    this.vimState.operationStack.cancel(this)
  }

  processOperation (): void {
    this.vimState.operationStack.process()
  }

  focusInput (options: FocusInputOptions = {}): void {
    if (!options.onConfirm) {
      options.onConfirm = input => {
        this.input = input
        this.processOperation()
      }
    }
    if (!options.onCancel) options.onCancel = () => this.cancelOperation()
    if (!options.onChange) options.onChange = input => this.vimState.hover.set(input)

    this.vimState.focusInput(options)
  }

  // Return promise which resolve with input char or `undefined` when cancelled.
  focusInputPromised (options: FocusInputOptions = {}): Promise<string | undefined> {
    return new Promise(resolve => {
      const defaultOptions = {hideCursor: true, onChange: (input: string) => this.vimState.hover.set(input)}
      this.vimState.focusInput(Object.assign(defaultOptions, options, {onConfirm: resolve, onCancel: resolve}))
    })
  }

  readChar (): void {
    this.vimState.readChar({
      onConfirm: input => {
        this.input = input
        this.processOperation()
      },
      onCancel: () => this.cancelOperation()
    })
  }

  // Return promise which resolve with read char or `undefined` when cancelled.
  readCharPromised (): Promise<string | undefined> {
    return new Promise<string | undefined>(resolve => {
      this.vimState.readChar({onConfirm: resolve, onCancel: () => resolve(undefined)})
    })
  }

  instanceof (klassName: string): boolean {
    // Unlike upstream (which lazy-loads every class), quilx registers operations
    // eagerly and only those that are ported. Treat an unregistered class name as
    // "not an instance" rather than throwing, so checks against not-yet-ported
    // operations (e.g. Search, Change) simply return false.
    const klass = Base.classByName.get(klassName)
    return klass ? this instanceof klass : false
  }

  isOperator (): boolean {
    // Don't use `instanceof` to postpone require for faster activation.
    return (this.constructor as typeof Base).operationKind === 'operator'
  }

  isMotion (): boolean {
    // Don't use `instanceof` to postpone require for faster activation.
    return (this.constructor as typeof Base).operationKind === 'motion'
  }

  isTextObject (): boolean {
    // Don't use `instanceof` to postpone require for faster activation.
    return (this.constructor as typeof Base).operationKind === 'text-object'
  }

  getCursorBufferPosition (): Point {
    return this.getBufferPositionForCursor(this.editor.getLastCursor())
  }

  getCursorBufferPositions (): Point[] {
    return this.editor.getCursors().map(cursor => this.getBufferPositionForCursor(cursor))
  }

  getCursorBufferPositionsOrdered (): Point[] {
    return this.utils.sortPoints(this.getCursorBufferPositions())
  }

  getBufferPositionForCursor (cursor: Cursor): Point {
    return this.mode === 'visual' ? this.getCursorPositionForSelection(cursor.selection) : cursor.getBufferPosition()
  }

  getCursorPositionForSelection (selection: Selection): Point {
    return this.swrap(selection).getBufferPositionFor('head', {from: ['property', 'selection']})!
  }

  getOperationTypeChar (): string | undefined {
    const kind = (this.constructor as typeof Base).operationKind
    const chars: Record<string, string> = {operator: 'O', 'text-object': 'T', motion: 'M', 'misc-command': 'X'}
    return kind == null ? undefined : chars[kind]
  }

  toString (): string {
    const base = `${this.name}<${this.getOperationTypeChar()}>`
    return this.target ? `${base}{target = ${this.target.toString()}}` : base
  }

  getCommandName (): string {
    return (this.constructor as typeof Base).getCommandName()
  }

  getCommandNameWithoutPrefix (): string {
    return (this.constructor as typeof Base).getCommandNameWithoutPrefix()
  }

  static isCommand (): boolean {
    return Object.prototype.hasOwnProperty.call(this, 'command') ? this.command! : true
  }

  static getClass (name: string): typeof Base {
    const klass = this.classByName.get(name)
    if (!klass) {
      throw new Error(`class '${name}' not found (was its operation module imported and registered?)`)
    }
    return klass
  }

  static getInstance (vimState: VimState, klass: string | typeof Base, properties?: Record<string, unknown>): Base {
    const Klass: typeof Base = typeof klass === 'function' ? klass : Base.getClass(klass)
    const object = new Klass(vimState)  
    if (properties) Object.assign(object, properties)
    object.initialize()
    return object
  }

  // Public API to register operations to the class table. Operation modules call
  // this at import time (eager registration; see file header).
  static register (): void {
    if (this.classByName.has(this.name)) {
      console.warn(`Duplicate constructor ${this.name}`)
    }
    this.classByName.set(this.name, this)
  }

  static getCommandName (): string {
    return this.commandPrefix + ':' + this.getCommandNameWithoutPrefix()
  }

  static getCommandNameWithoutPrefix (): string {
    return dasherize(this.name)
  }

  static getKindForCommandName (command: string): string | null | undefined {
    const commandWithoutPrefix = command.replace(/^vim-mode-plus:/, '')
    const commandClassName = classify(commandWithoutPrefix)
    if (this.classByName.has(commandClassName)) {
      return this.classByName.get(commandClassName)!.operationKind
    }
  }

  getSmoothScrollDuation (kind: string): number {
    const base = 'smoothScrollOn' + kind
    return this.getConfig(base) ? this.getConfig(base + 'Duration') : 0
  }

  // Proxy propperties and methods
  // ===========================================================================
  get mode (): VimMode { return this.vimState.mode } // prettier-ignore
  get submode (): VimSubmode { return this.vimState.submode } // prettier-ignore
  get swrap () { return this.vimState.swrap } // prettier-ignore
  get utils () { return this.vimState.utils } // prettier-ignore
  get editor (): EditorModel { return this.vimState.editor } // prettier-ignore
  get editorElement (): EditorModel { return this.vimState.editorElement } // prettier-ignore
  get globalState () { return this.vimState.globalState } // prettier-ignore
  get mutationManager () { return this.vimState.mutationManager } // prettier-ignore
  get occurrenceManager () { return this.vimState.occurrenceManager } // prettier-ignore
  get persistentSelection () { return this.vimState.persistentSelection } // prettier-ignore
  get _ () { return this.vimState._ } // prettier-ignore

  onDidChangeSearch (...args: Parameters<VimState['onDidChangeSearch']>): Disposable { return this.vimState.onDidChangeSearch(...args) } // prettier-ignore
  onDidConfirmSearch (...args: Parameters<VimState['onDidConfirmSearch']>): Disposable { return this.vimState.onDidConfirmSearch(...args) } // prettier-ignore
  onDidCancelSearch (...args: Parameters<VimState['onDidCancelSearch']>): Disposable { return this.vimState.onDidCancelSearch(...args) } // prettier-ignore
  onDidCommandSearch (...args: Parameters<VimState['onDidCommandSearch']>): Disposable { return this.vimState.onDidCommandSearch(...args) } // prettier-ignore
  onDidSetTarget (...args: Parameters<VimState['onDidSetTarget']>): Disposable { return this.vimState.onDidSetTarget(...args) } // prettier-ignore
  emitDidSetTarget (...args: Parameters<VimState['emitDidSetTarget']>): void { return this.vimState.emitDidSetTarget(...args) } // prettier-ignore
  onWillSelectTarget (...args: Parameters<VimState['onWillSelectTarget']>): Disposable { return this.vimState.onWillSelectTarget(...args) } // prettier-ignore
  emitWillSelectTarget (...args: Parameters<VimState['emitWillSelectTarget']>): void { return this.vimState.emitWillSelectTarget(...args) } // prettier-ignore
  onDidSelectTarget (...args: Parameters<VimState['onDidSelectTarget']>): Disposable { return this.vimState.onDidSelectTarget(...args) } // prettier-ignore
  emitDidSelectTarget (...args: Parameters<VimState['emitDidSelectTarget']>): void { return this.vimState.emitDidSelectTarget(...args) } // prettier-ignore
  onDidFailSelectTarget (...args: Parameters<VimState['onDidFailSelectTarget']>): Disposable { return this.vimState.onDidFailSelectTarget(...args) } // prettier-ignore
  emitDidFailSelectTarget (...args: Parameters<VimState['emitDidFailSelectTarget']>): void { return this.vimState.emitDidFailSelectTarget(...args) } // prettier-ignore
  onWillFinishMutation (...args: Parameters<VimState['onWillFinishMutation']>): Disposable { return this.vimState.onWillFinishMutation(...args) } // prettier-ignore
  emitWillFinishMutation (...args: Parameters<VimState['emitWillFinishMutation']>): void { return this.vimState.emitWillFinishMutation(...args) } // prettier-ignore
  onDidFinishMutation (...args: Parameters<VimState['onDidFinishMutation']>): Disposable { return this.vimState.onDidFinishMutation(...args) } // prettier-ignore
  emitDidFinishMutation (...args: Parameters<VimState['emitDidFinishMutation']>): void { return this.vimState.emitDidFinishMutation(...args) } // prettier-ignore
  onDidFinishOperation (...args: Parameters<VimState['onDidFinishOperation']>): Disposable { return this.vimState.onDidFinishOperation(...args) } // prettier-ignore
  onDidResetOperationStack (...args: Parameters<VimState['onDidResetOperationStack']>): Disposable { return this.vimState.onDidResetOperationStack(...args) } // prettier-ignore
  subscribe (handler: any): any { return this.vimState.subscribe(handler) } // prettier-ignore
  isMode (...args: Parameters<VimState['isMode']>): boolean { return this.vimState.isMode(...args) } // prettier-ignore
  getBlockwiseSelections (): ReturnType<VimState['getBlockwiseSelections']> { return this.vimState.getBlockwiseSelections() } // prettier-ignore
  getLastBlockwiseSelection (): ReturnType<VimState['getLastBlockwiseSelection']> { return this.vimState.getLastBlockwiseSelection() } // prettier-ignore
  addToClassList (className: any): any { return this.vimState.addToClassList(className) } // prettier-ignore
  getConfig (param: string): any { return this.vimState.getConfig(param) } // prettier-ignore

  // Wrapper for this.utils
  // ===========================================================================
  getVimEofBufferPosition () { return this.utils.getVimEofBufferPosition(this.editor) } // prettier-ignore
  getVimLastBufferRow () { return this.utils.getVimLastBufferRow(this.editor) } // prettier-ignore
  getVimLastScreenRow () { return this.utils.getVimLastScreenRow(this.editor) } // prettier-ignore
  getValidVimBufferRow (row: number) { return this.utils.getValidVimBufferRow(this.editor, row) } // prettier-ignore
  getValidVimScreenRow (row: number) { return this.utils.getValidVimScreenRow(this.editor, row) } // prettier-ignore
  getWordBufferRangeAndKindAtBufferPosition (...args: any[]) { return (this.utils.getWordBufferRangeAndKindAtBufferPosition as any)(this.editor, ...args) } // prettier-ignore
  getFirstCharacterPositionForBufferRow (row: number) { return this.utils.getFirstCharacterPositionForBufferRow(this.editor, row) } // prettier-ignore
  getBufferRangeForRowRange (rowRange: [number, number]) { return this.utils.getBufferRangeForRowRange(this.editor, rowRange) } // prettier-ignore
  scanEditor (...args: any[]) { return (this.utils.scanEditor as any)(this.editor, ...args) } // prettier-ignore
  findInEditor (...args: any[]) { return (this.utils.findInEditor as any)(this.editor, ...args) } // prettier-ignore
  findPoint (...args: any[]) { return (this.utils.findPoint as any)(this.editor, ...args) } // prettier-ignore
  trimBufferRange (...args: any[]) { return (this.utils.trimBufferRange as any)(this.editor, ...args) } // prettier-ignore
  isEmptyRow (...args: any[]) { return (this.utils.isEmptyRow as any)(this.editor, ...args) } // prettier-ignore
  getFoldStartRowForRow (...args: any[]) { return (this.utils.getFoldStartRowForRow as any)(this.editor, ...args) } // prettier-ignore
  getFoldEndRowForRow (...args: any[]) { return (this.utils.getFoldEndRowForRow as any)(this.editor, ...args) } // prettier-ignore
  getBufferRows (...args: any[]) { return (this.utils.getRows as any)(this.editor, 'buffer', ...args) } // prettier-ignore
  getScreenRows (...args: any[]) { return (this.utils.getRows as any)(this.editor, 'screen', ...args) } // prettier-ignore
  replaceTextInRangeViaDiff (...args: any[]) { return (this.utils.replaceTextInRangeViaDiff as any)(this.editor, ...args) } // prettier-ignore
}
