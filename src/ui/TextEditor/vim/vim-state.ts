// Vendored from xedel/vim-mode-plus's lib/vim-state.js with quilx adaptations:
//   - ESM (`require`→`import`, `module.exports`→`export default`);
//   - the lazy `require(file)` manager loader is replaced by MANAGER_REGISTRY
//     (see `load()`): managers are added as they are ported; unported ones throw;
//   - the Atom command-registration statics (getDispatcher/registerCommandsFromSpec
//     etc.) are removed — quilx registers commands through `quilx.commands`;
//   - `modeManager` (grim deprecation shim) and focusInput/readChar are stubbed.
// The mode/operation logic is otherwise unchanged.
import { Emitter, Disposable, CompositeDisposable } from '../../../util/eventKit.ts'
import settings from './settings.ts'
import OperationStack from './operation-stack.ts'
import MarkManager from './mark-manager.ts'
import RegisterManager from './register-manager.ts'
import MutationManager from './mutation-manager.ts'
import PositionHistory from './position-history.ts'
import swrap from './selection-wrapper.ts'
import globalState from './global-state.ts'
import { CursorStyleManager, HoverManager, FlashManager, OccurrenceManager, SequentialPasteManager, ScrollManager } from './stubs.ts'
import type { StatusBarManager } from './stubs.ts'
import * as utils from './utils.ts'
import underscorePlus from './underscorePlus.ts'
import { quilx } from '../../../quilx.ts'
import type { EditorModel } from '../EditorModel.ts'
import type { Disposable as DisposableType } from '../../../util/eventKit.ts'
import type { Key } from '../../../keymap/Key.ts'

/** The four mode tags VimState moves between. */
export type VimMode = 'normal' | 'insert' | 'visual'
/**
 * The mode's submode: the visual-mode wise (`characterwise`/`linewise`/
 * `blockwise`) or insert-mode `replace`; `null` when the mode has no submode.
 */
export type VimSubmode = 'characterwise' | 'linewise' | 'blockwise' | 'replace' | null

/** Listener for the single-character input grab (`readChar`). */
type InputHandler = { onConfirm?: (char: string) => void; onCancel?: () => void }
/** Options passed to `focusInput`/`readChar`. */
interface InputOptions {
  charsMax?: number
  purpose?: string
  onConfirm?: (input: string) => void
  onCancel?: () => void
  onChange?: (input: string) => void
  hideCursor?: boolean
}
/** A provider wired in by the host to drive multi-char / leap input. The
 * options shape is purpose-dependent (search confirms a string, leap confirms a
 * Point), so providers receive a loosely-typed options bag. */
type InputProvider = (options: any) => void

/** Generic emitter/event-subscription callback (payload shape varies per event). */
type EventCallback = (value?: any) => void

const MANAGER_REGISTRY = {
  './operation-stack': OperationStack,
  './mark-manager': MarkManager,
  './register-manager': RegisterManager,
  './mutation-manager': MutationManager,
  './selection-wrapper': swrap,
  './global-state': globalState,
  './cursor-style-manager': CursorStyleManager,
  './hover-manager': HoverManager,
  './flash-manager': FlashManager,
  './occurrence-manager': OccurrenceManager,
  './sequential-paste-manager': SequentialPasteManager,
  './scroll-manager': ScrollManager,
  './utils': utils,
}

const __vimStatesByEditor = new Map<EditorModel, VimState>()

export default class VimState {
  // Instance fields (assigned in the constructor)
  // ===========================================================================
  editor: EditorModel
  editorElement: EditorModel
  statusBarManager: StatusBarManager
  emitter: Emitter
  mode: VimMode
  submode: VimSubmode
  replaceModeDisposable: DisposableType | null
  previousSelection: { properties?: unknown; submode?: VimSubmode }
  ignoreSelectionChange: boolean
  subscriptions: CompositeDisposable

  // Set/cleared during mode transitions.
  modeDeactivator?: DisposableType | null

  // Lazily-populated manager backing fields (see the getters below).
  __mark?: MarkManager
  __register?: RegisterManager
  __hover?: HoverManager
  __hoverSearchCounter?: HoverManager
  __searchHistory?: any // TODO(vim-ts): tighten once search-history-manager is ported
  __highlightSearch?: any // TODO(vim-ts): tighten once highlight-search-manager is ported
  __highlightFind?: any // TODO(vim-ts): tighten once highlight-find-manager is ported
  __persistentSelection?: any // TODO(vim-ts): tighten once persistent-selection-manager is ported
  __occurrenceManager?: OccurrenceManager
  __mutationManager?: MutationManager
  __flashManager?: FlashManager
  // Conflated upstream: `setSearchInput` stores a multi-char input provider here,
  // while the `searchInput` getter lazy-loads the (unported) search-input manager.
  __searchInput?: any // TODO(vim-ts): split provider vs manager once search is ported
  __operationStack?: OperationStack
  __cursorStyleManager?: CursorStyleManager
  __sequentialPasteManager?: SequentialPasteManager
  __scrollManager?: ScrollManager
  __jumpList?: PositionHistory
  __changeList?: PositionHistory
  __swrap?: typeof swrap
  __utils?: typeof utils
  __globalState?: typeof globalState

  // Single-character / macro input grab state.
  __inputHandler?: InputHandler | null
  __inputGrabListener?: ((key: Key) => boolean) | null
  __leapInput?: InputProvider
  __macros?: Record<string, Key[]>

  // Proxy propperties and methods
  // ===========================================================================
  static get (editor: EditorModel): VimState | undefined { return __vimStatesByEditor.get(editor) } // prettier-ignore
  static set (editor: EditorModel, vimState: VimState): Map<EditorModel, VimState> { return __vimStatesByEditor.set(editor, vimState) } // prettier-ignore
  static has (editor: EditorModel): boolean { return __vimStatesByEditor.has(editor) } // prettier-ignore
  static delete (editor: EditorModel): boolean { return __vimStatesByEditor.delete(editor) } // prettier-ignore
  static forEach (fn: (vimState: VimState, editor: EditorModel) => void): void { return __vimStatesByEditor.forEach(fn) } // prettier-ignore
  static clear (): void { return __vimStatesByEditor.clear() } // prettier-ignore

  flash (...args: Parameters<FlashManager['flash']>): void { this.flashManager.flash(...args) } // prettier-ignore
  clearFlash (): void { if (this.__flashManager) this.flashManager.clearAllMarkers() } // prettier-ignore
  updateStatusBar (): void { this.statusBarManager.update(this.mode, this.submode) } // prettier-ignore
  setOperatorModifier (...args: any[]): void { this.operationStack.setOperatorModifier(...args) } // prettier-ignore
  subscribe (handler: any): any { return this.operationStack.subscribe(handler) } // prettier-ignore
  getCount (): number | null { return this.operationStack.getCount() } // prettier-ignore
  hasCount (): boolean { return this.operationStack.hasCount() } // prettier-ignore
  setCount (number: number): void { this.operationStack.setCount(number) } // prettier-ignore
  addToClassList (className: any): any { return this.operationStack.addToClassList(className) } // prettier-ignore
  requestScroll (...args: Parameters<ScrollManager['requestScroll']>): void { this.scrollManager.requestScroll(...args) } // prettier-ignore

  // Lazy populated properties for fast package startup
  // =====================================================
  load (file: keyof typeof MANAGER_REGISTRY | string, instantiate = true): any {
    const lib = MANAGER_REGISTRY[file as keyof typeof MANAGER_REGISTRY]
    if (!lib) throw new Error(`vim: manager not yet ported: ${file}`)
    return instantiate ? new (lib as any)(this) : lib  
  }
  get mark (): MarkManager { return this.__mark || (this.__mark = this.load('./mark-manager')) } // prettier-ignore
  get register (): RegisterManager { return this.__register || (this.__register = this.load('./register-manager')) } // prettier-ignore
  get hover (): HoverManager { return this.__hover || (this.__hover = this.load('./hover-manager')) } // prettier-ignore
  get hoverSearchCounter (): HoverManager { return this.__hoverSearchCounter || (this.__hoverSearchCounter = this.load('./hover-manager')) } // prettier-ignore
  get searchHistory (): any { return this.__searchHistory || (this.__searchHistory = this.load('./search-history-manager')) } // prettier-ignore
  get highlightSearch (): any { return this.__highlightSearch || (this.__highlightSearch = this.load('./highlight-search-manager')) } // prettier-ignore
  get highlightFind (): any { return this.__highlightFind || (this.__highlightFind = this.load('./highlight-find-manager')) } // prettier-ignore
  get persistentSelection (): any { return this.__persistentSelection || (this.__persistentSelection = this.load('./persistent-selection-manager')) } // prettier-ignore
  get occurrenceManager (): OccurrenceManager { return this.__occurrenceManager || (this.__occurrenceManager = this.load('./occurrence-manager')) } // prettier-ignore
  get mutationManager (): MutationManager { return this.__mutationManager || (this.__mutationManager = this.load('./mutation-manager')) } // prettier-ignore
  get flashManager (): FlashManager { return this.__flashManager || (this.__flashManager = this.load('./flash-manager')) } // prettier-ignore
  get searchInput (): any { return this.__searchInput || (this.__searchInput = this.load('./search-input')) } // prettier-ignore
  get operationStack (): OperationStack { return this.__operationStack || (this.__operationStack = this.load('./operation-stack')) } // prettier-ignore
  get cursorStyleManager (): CursorStyleManager { return this.__cursorStyleManager || (this.__cursorStyleManager = this.load('./cursor-style-manager')) } // prettier-ignore
  get sequentialPasteManager (): SequentialPasteManager { return this.__sequentialPasteManager || (this.__sequentialPasteManager = this.load('./sequential-paste-manager')) } // prettier-ignore
  get scrollManager (): ScrollManager { return this.__scrollManager || (this.__scrollManager = this.load('./scroll-manager')) } // prettier-ignore
  get jumpList (): PositionHistory { return this.__jumpList || (this.__jumpList = new PositionHistory(this)) } // prettier-ignore
  get changeList (): PositionHistory { return this.__changeList || (this.__changeList = new PositionHistory(this)) } // prettier-ignore
  get swrap (): typeof swrap { return this.__swrap || (this.__swrap = this.load('./selection-wrapper', false)) } // prettier-ignore
  get utils (): typeof utils { return this.__utils || (this.__utils = this.load('./utils', false)) } // prettier-ignore
  get globalState (): typeof globalState { return this.__globalState || (this.__globalState = this.load('./global-state', false)) } // prettier-ignore
  get _ (): typeof underscorePlus { return (this.constructor as typeof VimState)._ } // prettier-ignore
  static get _ (): typeof underscorePlus { return underscorePlus } // prettier-ignore

  // Atom command-registration statics removed: quilx registers vim commands and
  // keymaps through `quilx.commands`/`quilx.keymaps` (see the vim wiring module).

  constructor (editor: EditorModel, statusBarManager: StatusBarManager) {
    this.editor = editor
    this.editorElement = editor.element
    this.statusBarManager = statusBarManager
    this.emitter = new Emitter()

    this.mode = 'insert' // Bare atom is not modal editor, thus it's `insert` mode.
    this.submode = null

    this.replaceModeDisposable = null

    this.previousSelection = {}
    this.ignoreSelectionChange = false

    this.subscriptions = new CompositeDisposable(
      this.observeMouse(),
      this.editor.onDidAddSelection(_selection => this.reconcileVisualModeWithActualSelection()),
      this.editor.onDidChangeSelectionRange(_event => this.reconcileVisualModeWithActualSelection()),
      // Record edit positions for the change list (g; / g,). Per emitted batch we
      // log the last change's start; same-row entries collapse (Vim dedups by line).
      this.editor.onDidChangeText(event => {
        const changes = event && event.changes
        if (changes && changes.length) this.changeList.add(changes[changes.length - 1].newRange.start)
      })
    )

    this.editorElement.addCssClass('vim-mode-plus')

    if (this.getConfig('startInInsertMode') || this.matchScopes(this.getConfig('startInInsertModeScopes'))) {
      this.activate('insert')
    } else {
      this.activate('normal')
    }

    editor.onDidDestroy(() => this.destroy())
    ;(this.constructor as typeof VimState).set(editor, this)
  }

  getConfig (param: string): any {
    return settings.get(param)
  }

  matchScopes (scopes: string[]): number | boolean {
    // HACK: length guard to avoid utils prop populated unnecessarily
    // TODO(vim-ts): utils.matchScopes types its element as `{classList}`; EditorModel
    // is the real arg in quilx (no classList) — cast until utils is ported.
    return scopes.length && this.utils.matchScopes(this.editorElement as any, scopes)
  }

  // BlockwiseSelections
  // -------------------------
  getBlockwiseSelections (): any[] {
    return this.swrap.getBlockwiseSelections(this.editor)
  }

  getLastBlockwiseSelection (): any {
    return this.swrap.getLastBlockwiseSelections(this.editor)
  }

  getBlockwiseSelectionsOrderedByBufferPosition (): any[] {
    return this.swrap.getBlockwiseSelectionsOrderedByBufferPosition(this.editor)
  }

  clearBlockwiseSelections (): void {
    if (this.__swrap) this.swrap.clearBlockwiseSelections(this.editor)
  }

  // All subscriptions here is cleared on each operation finished.
  // -------------------------
  onDidChangeSearch (fn: EventCallback): DisposableType { return this.subscribe(this.searchInput.onDidChange(fn)) } // prettier-ignore
  onDidConfirmSearch (fn: EventCallback): DisposableType { return this.subscribe(this.searchInput.onDidConfirm(fn)) } // prettier-ignore
  onDidCancelSearch (fn: EventCallback): DisposableType { return this.subscribe(this.searchInput.onDidCancel(fn)) } // prettier-ignore
  onDidCommandSearch (fn: EventCallback): DisposableType { return this.subscribe(this.searchInput.onDidCommand(fn)) } // prettier-ignore

  onDidSetTarget (fn: EventCallback): DisposableType { return this.subscribe(this.emitter.on('did-set-target', fn)) } // prettier-ignore
  emitDidSetTarget (operator: unknown): void { this.emitter.emit('did-set-target', operator) } // prettier-ignore

  onWillSelectTarget (fn: EventCallback): DisposableType { return this.subscribe(this.emitter.on('will-select-target', fn)) } // prettier-ignore
  emitWillSelectTarget (): void { this.emitter.emit('will-select-target') } // prettier-ignore

  onDidSelectTarget (fn: EventCallback): DisposableType { return this.subscribe(this.emitter.on('did-select-target', fn)) } // prettier-ignore
  emitDidSelectTarget (): void { this.emitter.emit('did-select-target') } // prettier-ignore

  onDidFailSelectTarget (fn: EventCallback): DisposableType { return this.subscribe(this.emitter.on('did-fail-select-target', fn)) } // prettier-ignore
  emitDidFailSelectTarget (): void { this.emitter.emit('did-fail-select-target') } // prettier-ignore

  onWillFinishMutation (fn: EventCallback): DisposableType { return this.subscribe(this.emitter.on('on-will-finish-mutation', fn)) } // prettier-ignore
  emitWillFinishMutation (): void { this.emitter.emit('on-will-finish-mutation') } // prettier-ignore

  onDidFinishMutation (fn: EventCallback): DisposableType { return this.subscribe(this.emitter.on('on-did-finish-mutation', fn)) } // prettier-ignore
  emitDidFinishMutation (): void { this.emitter.emit('on-did-finish-mutation') } // prettier-ignore

  onDidFinishOperation (fn: EventCallback): DisposableType { return this.subscribe(this.emitter.on('did-finish-operation', fn)) } // prettier-ignore
  emitDidFinishOperation (): void { this.emitter.emit('did-finish-operation') } // prettier-ignore

  onDidResetOperationStack (fn: EventCallback): DisposableType { return this.subscribe(this.emitter.on('did-reset-operation-stack', fn)) } // prettier-ignore
  emitDidResetOperationStack (): void { this.emitter.emit('did-reset-operation-stack') } // prettier-ignore

  // Search highlights are owned by the host editor's SearchController (the vmp
  // highlight-search manager is not ported), so reset-normal-mode signals the
  // host to clear them rather than touching globalState.
  onDidRequestClearSearchHighlight (fn: EventCallback): DisposableType { return this.subscribe(this.emitter.on('did-request-clear-search-highlight', fn)) } // prettier-ignore
  emitDidRequestClearSearchHighlight (): void { this.emitter.emit('did-request-clear-search-highlight') } // prettier-ignore

  // Events
  // -------------------------
  onWillActivateMode (fn: EventCallback): DisposableType { return this.emitter.on('will-activate-mode', fn) } // prettier-ignore
  onDidActivateMode (fn: EventCallback): DisposableType { return this.emitter.on('did-activate-mode', fn) } // prettier-ignore
  onWillDeactivateMode (fn: EventCallback): DisposableType { return this.emitter.on('will-deactivate-mode', fn) } // prettier-ignore
  preemptWillDeactivateMode (fn: EventCallback): DisposableType { return this.emitter.preempt('will-deactivate-mode', fn) } // prettier-ignore
  onDidDeactivateMode (fn: EventCallback): DisposableType { return this.emitter.on('did-deactivate-mode', fn) } // prettier-ignore

  // (Removed the deprecated `modeManager` grim shim — use vimState.onDid* directly.)

  onDidFailToPushToOperationStack (fn: EventCallback): DisposableType { return this.emitter.on('did-fail-to-push-to-operation-stack', fn) } // prettier-ignore
  emitDidFailToPushToOperationStack (): void { this.emitter.emit('did-fail-to-push-to-operation-stack') } // prettier-ignore
  onDidDestroy (fn: EventCallback): DisposableType { return this.emitter.on('did-destroy', fn) } // prettier-ignore
  onDidSetInputChar (fn: EventCallback): DisposableType { return this.emitter.on('did-set-input-char', fn) } // prettier-ignore
  emitDidSetInputChar (char: string): void { this.emitter.emit('did-set-input-char', char) } // prettier-ignore

  // * `fn` {Function} to be called when mark was set.
  //   * `name` Name of mark such as 'a'.
  //   * `bufferPosition`: bufferPosition where mark was set.
  //   * `editor`: editor where mark was set.
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  //
  //  Usage:
  //   onDidSetMark ({name, bufferPosition}) -> do something..
  onDidSetMark (fn: EventCallback): DisposableType {
    return this.emitter.on('did-set-mark', fn)
  }

  isAlive (): boolean {
    return (this.constructor as typeof VimState).has(this.editor)
  }

  destroy (): void {
    if (!this.isAlive()) return

    (this.constructor as typeof VimState).delete(this.editor)
    this.subscriptions.dispose()

    if (this.editor.isAlive()) {
      this.resetNormalMode()
      this.reset()
      if (this.editorElement) this.editorElement.setInputEnabled(true)

      // Disable `readOnly` state of which possibly be changed by `autoDisableInputMethodWhenLeavingInsertMode`.
      // if (this.editor.component.getHiddenInput().readOnly) {
      //   this.editor.component.getHiddenInput().readOnly = false
      // }
      // TODO(vim-ts): EditorModel.removeCssClass takes a single class; upstream
      // passes two. Preserve runtime behavior, cast to satisfy the signature.
      ;(this.editorElement.removeCssClass as (...classes: string[]) => void)('vim-mode-plus', 'normal-mode')
    }
    this.emitter.emit('did-destroy')
  }

  haveSomeNonEmptySelection (): boolean {
    return this.editor.getSelections().some(selection => !selection.isEmpty())
  }

  // This function is mainly called in editor.onDidChangeSelectionRange enent
  // Purpose of this function is to auto-start/stop visual-mode when outer-vmp modify selection.
  // See. vim-mode-plus#878, #873 for detail
  //
  // - When outer-vmp command select some range(1) and clear(2) within single-command.
  // - Vmp start `visual-mode` at (1), then reset to `normal-mode` at (2).
  // - This is NOT elegant solution, but there is no other better way.
  // - We cannot determine selection is eventually cleared or not within `editor.onDidChangeSelectionRange` event.
  // - Delaying, debouncing to minimize useless mode-shift is bad for UX, user see slight delay for cursor updated.
  reconcileVisualModeWithActualSelection (shiftToNormalIfNoSelection = true): void {
    // This guard is somewhat verbose and duplicate, but I prefer duplication than increase chance of infinite loop.
    if (this.shouldIgnoreChangeSelection()) return

    this.ignoreSelectionChange = true

    const refreshCursorStyle = () => {
      this.swrap.getSelections(this.editor).forEach(($s: any) => $s.saveProperties())
      this.cursorStyleManager.refresh()
    }

    const hasSelection = this.haveSomeNonEmptySelection()
    const isVisual = this.mode === 'visual'

    if (hasSelection && isVisual) refreshCursorStyle()
    else if (hasSelection && !isVisual) this.activate('visual', this.swrap.detectWise(this.editor))
    else if (!hasSelection && isVisual) {
      if (shiftToNormalIfNoSelection) this.activate('normal')
      else refreshCursorStyle()
    }

    this.ignoreSelectionChange = false
  }

  shouldIgnoreChangeSelection (): boolean | undefined {
    return (
      this.ignoreSelectionChange || this.mode === 'insert' || (this.__operationStack && this.operationStack.isRunning())
    )
  }

  observeMouse (): DisposableType {
    /* eslint-disable @typescript-eslint/no-unused-vars -- ported but not yet wired; kept for the FIXME below (see vim-mode-plus #830) */
    const nextMouseEventTable: Record<string, string> = {
      'mousedown-capture': 'mousedown-bubble',
      'mousedown-bubble': 'mouseup',
      mouseup: 'mousedown-capture'
    }

    // Why explicitly assure mouse-event lifecycle? see #830 for detail.
    let waitingMouseEvent = 'mousedown-capture'
    const isWaiting = (mouseEvent: string): boolean => {
      const isValid = waitingMouseEvent === mouseEvent && !this.shouldIgnoreChangeSelection()
      if (isValid) waitingMouseEvent = nextMouseEventTable[mouseEvent]
      return isValid
    }

    // To keep original cursor screen range(tail range of selection) keep selected on `shift+click`
    // At this phase, cursor position is NOT yet updated, so we interact with original before-clicked cursor position.
    const onMouseDownCapture = () => {
      if (isWaiting('mousedown-capture')) {
        for (const selection of this.editor.getSelections()) {
          ;(selection as any).initialScreenRange = this.swrap(selection).getTailScreenRange()
        }
      }
    }

    const onMouseDownBubble = () => {
      if (isWaiting('mousedown-bubble')) {
        if (this.isMode('visual', 'blockwise') && !this.haveSomeNonEmptySelection()) {
          this.getBlockwiseSelections().forEach(bs => bs.skipNormalization())
        }
        for (const selection of this.editor.getSelections().filter(s => s.isEmpty())) {
          ;(selection as any).initialScreenRange = this.swrap(selection).getTailScreenRange()
        }
        // For shilft+click which not involve mousemove event.
        this.reconcileVisualModeWithActualSelection(false) // Prevent auto-shift-to-normal-mode by passing `false`
      }
    }

    const onMouseUp = () => {
      if (isWaiting('mouseup')) {
        this.reconcileVisualModeWithActualSelection()
      }
    }
    /* eslint-enable @typescript-eslint/no-unused-vars */

    // FIXME: implement this
    // this.editorElement.addEventListener('mousedown', onMouseDownCapture, true)
    // this.editorElement.addEventListener('mousedown', onMouseDownBubble, false)
    // this.editorElement.addEventListener('mouseup', onMouseUp)

    return new Disposable(() => {
      // this.editorElement.removeEventListener('mousedown', onMouseDownCapture, true)
      // this.editorElement.removeEventListener('mousedown', onMouseDownBubble, false)
      // this.editorElement.removeEventListener('mouseup', onMouseUp)
    })
  }

  // What's this?
  // clear all selections and final cursor position becomes head of last selection.
  // editor.clearSelections() does not respect last selection's head, since it merge all selections before clearing.
  clearSelections (): void {
    this.editor.setCursorBufferPosition(this.editor.getCursorBufferPosition())
  }

  resetNormalMode (options: { userInvocation?: boolean } = {}): void {
    this.clearBlockwiseSelections()

    if (options.userInvocation) {
      // TODO(vim-ts): OperationStack.lastCommandName isn't a declared field yet.
      ;(this.operationStack as any).lastCommandName = null

      if (this.editor.hasMultipleCursors()) {
        this.clearSelections()
      } else if (this.hasPersistentSelections() && this.getConfig('clearPersistentSelectionOnResetNormalMode')) {
        this.clearPersistentSelections()
      } else if (this.__occurrenceManager && this.occurrenceManager.hasPatterns()) {
        this.occurrenceManager.resetPatterns()
      }
      if (this.getConfig('clearHighlightSearchOnResetNormalMode')) {
        this.emitDidRequestClearSearchHighlight()
      }
    } else {
      this.clearSelections()
    }
    this.activate('normal')
  }

  reset (): void {
    // Reset each props only if it's already populated.
    if (this.__register) this.register.reset()
    if (this.__searchHistory) this.searchHistory.reset()
    if (this.__hover) this.hover.reset()
    if (this.__mutationManager) this.mutationManager.reset()
    if (this.__operationStack) this.operationStack.reset()
  }

  isVisible (): boolean {
    return this.utils.getVisibleEditors().includes(this.editor)
  }

  // FIXME: naming, updateLastSelectedInfo ?
  updatePreviousSelection (): void {
    let properties: any

    if (this.isMode('visual', 'blockwise')) {
      const blockwiseSelection = this.getLastBlockwiseSelection()
      properties = blockwiseSelection && blockwiseSelection.getProperties()
    } else {
      properties = this.swrap(this.editor.getLastSelection()).getProperties()
    }

    // TODO#704 when cursor is added in visual-mode, corresponding selection prop yet not exists.
    if (!properties) return

    // Copy by extracting only used item.
    properties = {head: properties.head, tail: properties.tail}

    const [whichStart, whichEnd] = properties.head.isGreaterThanOrEqual(properties.tail)
      ? ['tail', 'head']
      : ['head', 'tail']
    properties[whichEnd] = this.utils.translatePointAndClip(this.editor, properties[whichEnd], 'forward')

    this.mark.set('<', properties[whichStart])
    this.mark.set('>', properties[whichEnd])
    this.previousSelection = {properties, submode: this.submode}
  }

  // Persistent selection
  // -------------------------
  hasPersistentSelections (): boolean {
    return this.__persistentSelection ? this.persistentSelection.hasMarkers() : false
  }

  getPersistentSelectionBufferRanges (): any[] {
    return this.__persistentSelection ? this.persistentSelection.getMarkerBufferRanges() : []
  }

  clearPersistentSelections (): void {
    if (this.__persistentSelection) this.persistentSelection.clearMarkers()
  }

  // Mode Managerment
  // =========================
  isMode (mode: VimMode, submode?: VimSubmode): boolean {
    return mode === this.mode && (submode ? submode === this.submode : true)
  }

  // Use this method to change mode, DONT use other direct method.
  activate (newMode: VimMode, newSubmode: VimSubmode = null): void {
    if (newMode === 'visual' && !newSubmode) {
      throw new Error('vimState.activate("visual", null) is not allowed, specify submode as 2nd arg')
    }

    // Avoid odd state(= visual-mode but selection is empty)
    if (newMode === 'visual' && this.editor.isEmpty()) return
    this.ignoreSelectionChange = true

    this.emitter.emit('will-activate-mode', {mode: newMode, submode: newSubmode})

    if (newMode === 'visual' && newSubmode === this.submode) {
      newMode = 'normal'
      newSubmode = null
    }

    if (newMode !== this.mode) {
      this.emitter.emit('will-deactivate-mode', {mode: this.mode, submode: this.submode})
      if (this.modeDeactivator) {
        this.modeDeactivator.dispose()
        this.modeDeactivator = null
      }
      this.emitter.emit('did-deactivate-mode', {mode: this.mode, submode: this.submode})
    }

    if (newMode === 'normal') {
      this.activateNormalMode()
    } else if (newMode === 'insert') {
      this.activateInsertMode()
    } else if (newMode === 'visual') {
      this.modeDeactivator = this.activateVisualMode(newSubmode)
    }

    if (this.getConfig('autoDisableInputMethodWhenLeavingInsertMode')) {
      // FIXME: validate that we can remove this
      // this.editor.component.getHiddenInput().readOnly = newMode !== 'insert'
    }

    this.editorElement.removeCssClass(`${this.mode}-mode`)
    if (this.submode)
      this.editorElement.removeCssClass(this.submode)

    const oldMode = this.mode
    this.mode = newMode
    this.submode = newSubmode

    // Order matter, following code must be called AFTER this.mode was updated
    if (oldMode === 'visual' || this.mode === 'visual') this.updateNarrowedState()

    // Prevent swrap from loaded on initial mode-setup on startup.
    if (this.mode === 'visual') {
      this.updatePreviousSelection()
    } else {
      if (this.__swrap) this.swrap.clearProperties(this.editor)
    }

    const CursorType = (this.editorElement.constructor as typeof EditorModel).CursorType
    this.editorElement.setCursorType(
      this.mode === 'insert' ?
        CursorType.BEAM :
        CursorType.BLOCK)

    this.editorElement.addCssClass(`${this.mode}-mode`)
    if (this.submode) this.editorElement.addCssClass(this.submode)

    this.statusBarManager.update(this.mode, this.submode)
    if (this.mode === 'visual' || this.__cursorStyleManager) {
      this.cursorStyleManager.refresh()
    }

    this.emitter.emit('did-activate-mode', {mode: this.mode, submode: this.submode})
    this.ignoreSelectionChange = false
  }

  activateNormalMode (): void {
    this.reset()
    // Component is not necessary avaiable see #98.
    if (this.editorElement) {
      this.editorElement.setInputEnabled(false)
    }

    // In visual-mode, cursor can place at EOL. move left if cursor is at EOL
    // We should not do this in visual-mode deactivation phase.
    // e.g. `A` directly shift from visua-mode to `insert-mode`, and cursor should remain at EOL.
    for (const cursor of this.editor.getCursors()) {
      // Don't use utils moveCursorLeft to skip require('./utils') for faster startup.
      if (cursor.isAtEndOfLine() && !cursor.isAtBeginningOfLine()) {
        const {goalColumn} = cursor
        cursor.moveLeft()
        if (goalColumn != null) cursor.goalColumn = goalColumn
      }
    }
  }

  activateInsertMode (): void {
    this.editorElement.setInputEnabled(true)
  }

  // Visual mode
  // -------------------------
  // We treat all selection is initially NOT normalized
  //
  // 1. First we normalize selection
  // 2. Then update selection orientation(=wise).
  //
  // Regardless of selection is modified by vmp-command or outer-vmp-command like `cmd-l`.
  // When normalize, we move cursor to left(selectLeft equivalent).
  // Since Vim's visual-mode is always selectRighted.
  //
  // - un-normalized selection: This is the range we see in visual-mode.( So normal visual-mode range in user perspective ).
  // - normalized selection: One column left selcted at selection end position
  // - When selectRight at end position of normalized-selection, it become un-normalized selection
  //   which is the range in visual-mode.
  activateVisualMode (submode: VimSubmode): DisposableType {
    const swrap = this.swrap
    swrap.saveProperties(this.editor)
    swrap.normalize(this.editor)

    for (const $selection of swrap.getSelections(this.editor)) {
      $selection.applyWise(submode as 'characterwise' | 'linewise' | 'blockwise')
    }
    if (submode === 'blockwise') this.getLastBlockwiseSelection().autoscroll()

    return new Disposable(() => {
      swrap.normalize(this.editor)
      if (this.submode === 'blockwise') swrap.setReversedState(this.editor, true)
      for (const selection of this.editor.getSelections()) {
        // TODO(vim-ts): Selection.clear() ignores the autoscroll option upstream passes.
        ;(selection.clear as (options?: { autoscroll?: boolean }) => void)({autoscroll: false})
      }
    })
  }

  // Narrowed selection
  // -------------------------
  updateNarrowedState (): void {
    const isSingleRowSelection = this.isMode('visual', 'blockwise')
      ? this.getLastBlockwiseSelection().isSingleRow()
      : this.swrap(this.editor.getLastSelection()).isSingleRow()
    this.editorElement.toggleCssClass('is-narrowed', !isSingleRowSelection)
  }

  isNarrowed (): boolean {
    return this.editorElement.hasCssClass('is-narrowed')
  }

  // Single-character input (f/t/r/`/… )
  // -------------------------
  // Operations that `requireInput` (find-char, replace-char, move-to-mark) ask
  // for the next keystroke. Upstream pops a mini-editor overlay (focus-input.js)
  // or routes keys through per-char commands (read-char.js); both assume Atom's
  // DOM. quilx instead grabs the next key straight off the KeymapManager: a
  // one-shot listener runs *before* keymap dispatch (so `fi` lands on the next
  // `i` rather than entering insert mode) and feeds the char to the operation.
  //
  // Only single-char input is supported — enough for f/t. Multi-char input
  // (search's `/`) lands with the custom search box.

  focusInput (options: InputOptions = {}): void {
    const { charsMax = 1, purpose, onConfirm, onCancel } = options
    // Leap (`g s`) is fully host-driven: it reads its own chars, labels matches,
    // and hands back a target Point. Route it to the host's Leap.
    if (purpose === 'leap') {
      if (this.__leapInput) this.__leapInput(options)
      else if (onCancel) onCancel()
      return
    }
    if (charsMax === 1) {
      this.readChar({ onConfirm, onCancel })
      return
    }
    // Multi-char input — currently only search-as-motion (`d/foo`). The host
    // (TextEditor) wires `setSearchInput` to drive its SearchBar; without one
    // (e.g. a headless buffer with no bar) the input simply cancels.
    if (this.__searchInput) this.__searchInput(options)
    else if (onCancel) onCancel()
  }

  /** Wire the multi-char (search) input provider — the SearchBar, in practice. */
  setSearchInput (provider: InputProvider): void {
    this.__searchInput = provider
  }

  /** Wire the leap input provider — the host's Leap, in practice. */
  setLeapInput (provider: InputProvider): void {
    this.__leapInput = provider
  }

  // Macros (q/@). Recorded keystrokes are stored per register letter; replay
  // re-dispatches them through the KeymapManager, except insert-mode printable
  // characters which are inserted directly (no real GTK event is synthesized).
  saveMacro (register: string, keys: Key[]): void {
    if (!this.__macros) this.__macros = {}
    this.__macros[register] = keys
  }

  getMacro (register: string): Key[] | undefined {
    return this.__macros && this.__macros[register]
  }

  replayMacro (keys: Key[]): void {
    for (const key of keys) {
      if (this.mode === 'insert' && this.isPrintableKey(key)) {
        this.editor.insertText(key.string!)
      } else if (this.mode === 'insert' && (key.name === 'return' || key.name === 'KP_Enter')) {
        this.editor.insertText('\n')
      } else {
        quilx.keymaps.feedKey(key)
      }
    }
  }

  isPrintableKey (key: Key): boolean {
    return (
      !key.ctrl &&
      !key.alt &&
      key.name !== 'escape' &&
      typeof key.string === 'string' &&
      key.string.length === 1 &&
      key.string.charCodeAt(0) >= 0x20
    )
  }

  readChar ({ onConfirm, onCancel }: InputHandler = {}): void {
    this.__inputHandler = { onConfirm, onCancel }
    this.editorElement.addCssClass('input-char-waiting')

    const listener = (key: Key): boolean => {
      // Modifiers alone don't resolve the input — keep waiting (and let them
      // fall through; KeymapManager ignores modifier-only keys anyway).
      if (key.isModifier()) return false
      if (key.name === 'escape' || (key.ctrl && key.name === '[')) this.cancelInput()
      else if (key.string && key.string.charCodeAt(0) >= 0x20) this.setInputChar(key.string)
      else this.cancelInput()
      return true // claim the key; never dispatch it as a command
    }
    this.__inputGrabListener = listener
    quilx.keymaps.addListener(listener)
  }

  // Resolve a pending readChar/focusInput. Called by the key grab, or directly
  // (e.g. from tests) to inject input without a real keystroke.
  setInputChar (char: string): void {
    const handler = this.__clearInput()
    if (handler) handler.onConfirm!(char)
  }

  cancelInput (): void {
    const handler = this.__clearInput()
    if (handler) handler.onCancel!()
  }

  __clearInput (): InputHandler | null | undefined {
    if (this.__inputGrabListener) {
      quilx.keymaps.removeListener(this.__inputGrabListener)
      this.__inputGrabListener = null
    }
    this.editorElement.removeCssClass('input-char-waiting')
    const handler = this.__inputHandler
    this.__inputHandler = null
    return handler
  }
}
