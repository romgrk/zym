// Vendored from xedel/vim-mode-plus's lib/operation-stack.js — ESM conversion
// only (`require`→`import`, `module.exports`→`export default`). Logic unchanged.
import { Disposable, CompositeDisposable } from '../../../util/eventKit.ts'
import type { Disposable as DisposableType } from '../../../util/eventKit.ts'
import { Base } from './base.ts'
import type VimState from './vim-state.ts'
import type { VimSubmode } from './vim-state.ts'
import type { EditorModel } from '../EditorModel.ts'

// `operator-pending` is a real vim mode the stack drives ('d' then a pending
// motion), but VimState.VimMode doesn't list it yet.
// TODO(vim-ts): add 'operator-pending' to VimMode in vim-state.ts and drop this.
type StackMode = 'normal' | 'insert' | 'visual' | 'operator-pending'

// opration life in operationStack
// 1. run
//    instantiated by new.
//    complement implicit Operator.VisualModeSelect operator if necessary.
//    push operation to stack.
// 2. process
//    reduce stack by, popping top of stack then set it as target of new top.
//    check if remaining top of stack is executable by calling isReady()
//    if executable, then pop stack then execute(poppedOperation)
//    if not executable, enter "operator-pending-mode"
export default class OperationStack {
  vimState: VimState
  editor: EditorModel
  editorElement: EditorModel
  // `operationToRunNext` stores the argument tuple of a pending `run(...)`.
  operationToRunNext: [unknown, Record<string, unknown>?] | null
  // `stack`/`operationSubscriptions` are nulled out in `destroy()`. Assigned
  // via `reset()` (called from the constructor), so use definite-assignment.
  stack!: Base[] | null
  running!: boolean
  operationSubscriptions!: CompositeDisposable | null
  lastCommandName!: string | null
  recordedOperation?: Base
  // Per-mode count accumulators; keyed by the modes that can collect a count.
  count!: { normal?: number | null; 'operator-pending'?: number | null }

  get mode (): StackMode { return this.vimState.mode } // prettier-ignore
  get submode (): VimSubmode { return this.vimState.submode } // prettier-ignore

  constructor (vimState: VimState) {
    this.vimState = vimState
    this.editor = vimState.editor
    this.editorElement = vimState.editorElement
    this.operationToRunNext = null

    this.vimState.onDidDestroy(() => this.destroy())
    this.reset()
  }

  // Return handler
  subscribe (handler: DisposableType): DisposableType {
    this.operationSubscriptions!.add(handler)
    return handler // DONT REMOVE
  }

  getLastCommandName (): string | null {
    return this.lastCommandName
  }

  reset (): void {
    this.resetCount()
    this.stack = []
    this.running = false

    // this has to be BEFORE this.operationSubscriptions.dispose()
    this.vimState.emitDidResetOperationStack()

    if (this.operationSubscriptions) this.operationSubscriptions.dispose()
    this.operationSubscriptions = new CompositeDisposable()

    if (this.operationToRunNext) {
      const args = this.operationToRunNext
      this.operationToRunNext = null
      this.run(...args)
    }
  }

  destroy (): void {
    if (this.operationSubscriptions) this.operationSubscriptions.dispose()
    this.stack = this.operationSubscriptions = null
  }

  peekTop (): Base {
    return this.stack![this.stack!.length - 1]
  }

  isEmpty (): boolean {
    return this.stack!.length === 0
  }

  // Main
  // -------------------------
  // `klass` may be a registered name, a class, or (on `.` repeat) an operation
  // instance to run as-is.
  run (klass: unknown, properties?: Record<string, unknown>): void {
    this.running = true

    if (this.mode === 'visual') {
      this.vimState.swrap.saveProperties(this.editor)
    }

    try {
      const type = typeof klass

      // `operation` is a `Base` instance, but it is repeatedly probed/mutated
      // through subclass-only members (setTarget, isMotion, ...); typed `any`
      // here since the runtime dispatch is dynamic.
      // TODO(vim-ts): tighten once the operation hierarchy exposes these on Base.
      let operation: any
      if (type === 'object') {
        // . repeat case we can execute as-it-is.
        operation = klass
      } else {
        if (type === 'string') {
          klass = Base.getClass(klass as string)
        }

        const stackTop = this.peekTop()
        if (stackTop && stackTop.constructor === klass) {
          // Replace operator when identical one repeated, e.g. `dd`, `cc`, `gUgU`
          klass = 'MoveToRelativeLine'
        }
        operation = Base.getInstance(this.vimState, klass as string | typeof Base, properties)
      }

      if (this.isEmpty()) {
        if ((this.mode === 'visual' && operation.isMotion()) || operation.isTextObject()) {
          const target = operation
          operation = Base.getInstance(this.vimState, 'VisualModeSelect')
          operation.setTarget(target)
        }
        this.stack!.push(operation)
        this.process()
      } else if (this.peekTop().isOperator() && (operation.isMotion() || operation.isTextObject())) {
        this.stack!.push(operation)
        this.process()
      } else {
        this.vimState.emitDidFailToPushToOperationStack()
        this.vimState.resetNormalMode()
      }
    } catch (error) {
      this.handleError(error)
    }
  }

  runNext (...args: [unknown, Record<string, unknown>?]): void {
    this.operationToRunNext = args
  }

  runRecorded (): void {
    if (!this.recordedOperation) return

    // `subscribeResetOccurrencePatternIfNeeded` is an Operator-only method.
    // TODO(vim-ts): tighten when the operation hierarchy is fully typed.
    const operation = this.recordedOperation as any
    operation.repeated = true
    if (this.hasCount()) {
      const count = this.getCount()
      operation.count = count

      // Why gurad? some opeartor have no target like ctrl-a(increase).
      if (operation.target) operation.target.count = count
    }

    operation.subscribeResetOccurrencePatternIfNeeded()
    this.run(operation)
  }

  // Currently used in repeat-search and repeat-find("n", "N", ";", ",").
  runRecordedMotion (key: 'currentFind' | 'currentSearch', {reverse = false}: {reverse?: boolean} = {}): void {
    // `recorded` is a recorded Motion pulled from globalState; mutated through
    // motion-specific members (backwards, ...).
    // TODO(vim-ts): tighten once globalState entries are typed.
    const recorded = this.vimState.globalState.get(key) as any
    if (!recorded) return

    recorded.vimState = this.vimState
    recorded.repeated = true
    recorded.operator = null
    recorded.resetCount()

    if (reverse) recorded.backwards = !recorded.backwards
    this.run(recorded)
    if (reverse) recorded.backwards = !recorded.backwards
  }

  runCurrentFind (options?: {reverse?: boolean}): void {
    this.runRecordedMotion('currentFind', options)
  }

  runCurrentSearch (options?: {reverse?: boolean}): void {
    this.runRecordedMotion('currentSearch', options)
  }

  handleError (error?: unknown): void {
    this.vimState.reset()
    throw error
  }

  isRunning (): boolean {
    return this.running
  }

  process (): void {
    if (this.stack!.length === 2) {
      // [FIXME ideally]
      // When motion was targeted and its not complete like `y s t a`.
      // We won't compose target till target become ready.
      // So that we can assume when target is set, it' target is also ready.
      // e.g. `y s t a'(surround for range from here to till a)
      if (!this.peekTop().isReady()) return

      const operation = this.stack!.pop()
      // setTarget is an Operator-only method. TODO(vim-ts): tighten.
      ;(this.peekTop() as any).setTarget(operation)
    }

    const top = this.peekTop()

    if (!top.isReady()) {
      if (this.mode === 'normal' && top.isOperator()) {
        // TODO(vim-ts): drop cast once VimMode includes 'operator-pending'.
        this.vimState.activate('operator-pending' as any)
      }
      // Temporary set while command is running to achieve operation-specific keymap scopes
      this.addToClassList(top.getCommandNameWithoutPrefix() + '-pending')
    } else {
      this.execute(this.stack!.pop()!)
    }
  }

  execute (operation: Base): void {
    // Any command that isn't the next paste in a cycle closes the cross-operation
    // paste-undo group, so the paste(s) so far commit as one undo step before this
    // command runs (notably before `u` undoes them in a single step).
    this.vimState.sequentialPasteManager.finalizePasteGroupIfInterrupted(operation as any)

    // Intentionally avoild wrapping by Promise.resolve() to make test easy.
    // Since almost all command don't return promise, finish synchronously.
    // execute() is defined on operation subclasses. TODO(vim-ts): tighten.
    const execution = (operation as any).execute()
    if (execution instanceof Promise) {
      execution.then(() => this.finish(operation)).catch(() => {
        this.handleError()
      })
    } else {
      this.finish(operation)
    }
  }

  cancel (operation: Base): void {
    if (this.mode === 'operator-pending') {
      this.vimState.mutationManager.restoreCursorsToInitialPosition()
      this.vimState.activate('normal')
    }
    this.finish(operation, true)
  }

  finish (operation: Base, cancelled?: boolean): void {
    this.vimState.emitDidFinishOperation()

    if (!cancelled) {
      if (operation.recordable) {
        this.recordedOperation = operation
      }
      this.lastCommandName = operation.name
      operation.resetState()
    }

    if (this.mode === 'normal') {
      this.clearSelectionsIfNotEmpty(operation)

      // Pull the cursor back to the last character if it ended past end-of-line,
      // unless `virtualedit=onemore` is enabled (quilx default) — then let it rest
      // one column past, like clicking past a line's end.
      if (!this.vimState.getConfig('allowCursorPastEndOfLine')) {
        const eolCursors = this.editor.getCursors().filter(cursor => cursor.isAtEndOfLine())
        eolCursors.forEach(cursor => this.vimState.utils.moveCursorLeft(cursor, {keepGoalColumn: true}))
      }
    } else if (this.mode === 'visual') {
      this.vimState.updateNarrowedState()
      this.vimState.updatePreviousSelection()
    }

    this.vimState.cursorStyleManager.refresh()
    this.vimState.reset()
  }

  clearSelectionsIfNotEmpty (operation: Base): void {
    // When @vimState.selectBlockwise() is called in non-visual-mode.
    // e.g. `.` repeat of operation targeted blockwise `CurrentSelection`.
    // We need to manually clear blockwiseSelection.
    // See #647
    this.vimState.clearBlockwiseSelections() // FIXME, should be removed
    if (this.vimState.haveSomeNonEmptySelection()) {
      if (this.vimState.getConfig('strictAssertion')) {
        const message = `Have some non-empty selection in normal-mode: ${operation.toString()}`
        this.vimState.utils.assertWithException(false, message)
      }
      this.vimState.clearSelections()
    }
  }

  addToClassList (className: string): void {
    this.editorElement.addCssClass(className)
    this.subscribe(new Disposable(() => this.editorElement.removeCssClass(className)))
  }

  setOperatorModifier (...args: any[]): void {
    const top = this.peekTop()
    if (top && top.isOperator()) {
      // setModifier is an Operator-only method. TODO(vim-ts): tighten.
      ;(top as any).setModifier(...args)
    }
  }

  // Count
  // -------------------------
  // keystroke `3d2w` delete 6(3*2) words.
  //  2nd number(2 in this case) is always enterd in operator-pending-mode.
  //  So count have two timing to be entered. that's why here we manage counter by mode.
  hasCount (): boolean {
    return this.count['normal'] != null || this.count['operator-pending'] != null
  }

  getCount (): number | null {
    if (this.hasCount()) {
      return (
        (this.count['normal'] != null ? this.count['normal'] : 1) *
        (this.count['operator-pending'] != null ? this.count['operator-pending'] : 1)
      )
    } else {
      return null
    }
  }

  setCount (number: number): void {
    const mode: 'operator-pending' | 'normal' = this.mode === 'operator-pending' ? this.mode : 'normal'
    if (this.count[mode] == null) this.count[mode] = 0
    this.count[mode] = this.count[mode]! * 10 + number
    this.vimState.hover.set(this.buildCountString())
    this.editorElement.toggleCssClass('with-count', true)
  }

  buildCountString (): string {
    return [this.count['normal'], this.count['operator-pending']].filter(n => n != null).join('x')
  }

  resetCount (): void {
    this.count = {}
    this.editorElement.removeCssClass('with-count')
  }
}
