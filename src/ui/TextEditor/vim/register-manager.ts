// Vendored from xedel/vim-mode-plus's lib/register-manager.js — ESM conversion.
// `atom.clipboard` is replaced by zym's GTK-backed `clipboard` (see
// ./clipboard.ts); register logic is otherwise unchanged.
import { normalizeIndent } from './utils.ts'
import clipboard, { primaryClipboard } from './clipboard.ts'
import type { Clipboard } from './clipboard.ts'
import type VimState from './vim-state.ts'
import type { EditorModel } from '../EditorModel.ts'
import type { Selection } from '../Selection.ts'
import type { Disposable } from '../../../util/eventKit.ts'

/** The wise of a register's text. */
type RegisterType = 'linewise' | 'characterwise'

/** A stored register value. */
interface RegisterValue {
  text: string
  type?: RegisterType
}

/** A register value that additionally carries the originating selection (for `set`). */
interface RegisterValueWithSelection extends RegisterValue {
  selection?: Selection
}

/** An entry in the sequential-paste clipboard history. */
interface HistoryEntry {
  text: string
  type?: RegisterType
  value?: unknown
}

const REGISTERS_REGEX = /[-0-9a-zA-Z*+%_".]/
const READ_ONLY_REGISTERS_REGEX = /[%_]/

// TODO: Vim support following registers.
// x: complete, -: partially
//  [x] 1. The unnamed register ""
//  [x] 2. 10 numbered registers "0 to "9
//  [x] 3. The small delete register "-
//  [x] 4. 26 named registers "a to "z or "A to "Z
//  [-] 5. three read-only registers ":, "., "%
//  [ ] 6. alternate buffer register "#
//  [ ] 7. the expression register "=
//  [?] 8. The selection and drop registers "*, "+ and "~
//  [x] 9. The black hole register "_
//  [ ] 10. Last search pattern register "/

export default class RegisterManager {
  vimState: VimState
  editorElement: EditorModel
  data: Record<string, RegisterValue>
  subscriptionBySelection: Map<Selection, Disposable>
  clipboardBySelection: Map<Selection, string>
  historyIndex: number
  name: string | null = null
  // Caches the exact text of the last blockwise yank/delete, so a paste can be
  // recognised as blockwise even after a clipboard round-trip dropped the wise.
  lastBlockwiseText: string | null = null

  constructor (vimState: VimState) {
    this.vimState = vimState
    this.editorElement = vimState.editorElement

    this.data = this.vimState.globalState.get('register')
    this.subscriptionBySelection = new Map()
    this.clipboardBySelection = new Map()
    this.historyIndex = 0

    this.vimState.onDidDestroy(() => this.destroy())
  }

  get history (): HistoryEntry[] {
    return this.vimState.globalState.get('clipboardHistory')
  }

  set history (value: HistoryEntry[]) {
    this.vimState.globalState.set('clipboardHistory', value)
  }

  reset () {
    this.name = null
    this.editorElement.toggleCssClass('with-register', false)
  }

  destroy () {
    this.subscriptionBySelection.forEach(disposable => disposable.dispose())
    this.subscriptionBySelection.clear()
    this.clipboardBySelection.clear()
  }

  isValidName (name: string): boolean {
    return REGISTERS_REGEX.test(name)
  }

  getText (name: string | null, selection?: Selection): string {
    const value = this.get(name, selection)
    return value && value.text != null ? value.text : ''
  }

  // `*` targets the PRIMARY selection; `+` (and the clipboard-as-default unnamed
  // register) targets the regular CLIPBOARD.
  clipboardForName (name: string | null): Clipboard {
    return name === '*' ? primaryClipboard : clipboard
  }

  readClipboard (selection: Selection | undefined, name: string | null): string {
    if (selection && selection.editor.hasMultipleCursors() && this.clipboardBySelection.has(selection)) {
      return this.clipboardBySelection.get(selection)!
    } else {
      return this.clipboardForName(name).read()
    }
  }

  writeClipboard (selection: Selection | undefined, text: string, name: string | null) {
    if (selection && selection.editor.hasMultipleCursors() && !this.clipboardBySelection.has(selection)) {
      this.subscriptionBySelection.set(
        selection,
        selection.onDidDestroy(() => {
          this.subscriptionBySelection.delete(selection)
          this.clipboardBySelection.delete(selection)
        })
      )
    }

    if (!selection || selection.isLastSelection()) {
      this.clipboardForName(name).write(text)
    }

    if (selection) {
      this.clipboardBySelection.set(selection, text)
    }
  }

  getNextHistory (): HistoryEntry {
    this.historyIndex = (this.historyIndex + 1) % this.history.length
    return this.history[this.historyIndex]
  }

  saveHistory (value: HistoryEntry) {
    this.history.unshift(value)

    // Uniq
    this.history = this.history.reduce((total: HistoryEntry[], current) => {
      return total.some(member => member.value === current.value && member.text === current.text)
        ? total
        : total.concat(current)
    }, [])

    this.history.splice(this.vimState.getConfig('sequentialPasteMaxHistory'))
  }

  normalizeValue ({text, type}: {text?: string; type?: RegisterType} = {}): RegisterValue {
    if (!type) {
      type = text && (text.endsWith('\n') || text.endsWith('\r')) ? 'linewise' : 'characterwise'
    }
    return {text: text as string, type}
  }

  shouldUseClipBoard (name: string | null): boolean {
    return name === '*' || name === '+' || (name === '"' && this.vimState.getConfig('useClipboardAsDefaultRegister'))
  }

  get (name: string | null, selection?: Selection, sequentialPaste?: boolean): RegisterValue | null {
    if (name != null && !this.isValidName(name)) return null
    name = name || this.name || '"'

    // FIXME: this get function has side-effect when name is '"'
    if (name === '"') {
      if (sequentialPaste) {
        if (!this.history.length && this.vimState.getConfig('useClipboardAsDefaultRegister')) {
          this.saveHistory(this.normalizeValue({text: clipboard.read()}))
        }

        const {text, type} = this.getNextHistory()
        return {
          text: normalizeIndent(text, selection!.editor, selection!.getBufferRange()),
          type: type
        }
      } else {
        this.historyIndex = 0
      }
    }

    // There is no diff between "*" and "+"(pure vim distinguish it only if X11 systems, but vmp not).
    if (this.shouldUseClipBoard(name)) {
      return this.normalizeValue({text: this.readClipboard(selection, name)})
    } else if (name === '%') {
      // TODO(vim-ts): tighten — EditorModel has no getURI() yet.
      return this.normalizeValue({text: (this.vimState.editor as any).getURI()})
    } else if (name === '_') {
      return this.normalizeValue({text: ''}) // Blackhole always returns nothing
    } else {
      return this.normalizeValue(this.data[name.toLowerCase()])
    }
  }

  // Private: Sets the value of a given register.
  //
  // name  - The name of the register to fetch.
  // value - The value to set the register to, with following properties.
  //  text: text to save to register.
  //  type: (optional) if ommited automatically set from text.
  //
  // Returns nothing.
  set (name: string | null, value: RegisterValueWithSelection): void {
    if (READ_ONLY_REGISTERS_REGEX.test(name as string)) return

    if (name != null && !this.isValidName(name)) return
    name = name || this.name || '"'

    const {selection} = value
    delete value.selection

    value = this.normalizeValue(value)

    if (name === '"' && this.vimState.getConfig('sequentialPaste')) {
      this.saveHistory(value)
    }

    if (this.shouldUseClipBoard(name)) {
      this.writeClipboard(selection, value.text, name)
    } else if (/^[A-Z]$/.test(name)) {
      name = name.toLowerCase()
      const oldValue = this.data[name]
      this.data[name] = oldValue ? this.appendValue(oldValue, value) : value
    } else {
      if (name === '1') {
        this.data['9'] = this.data['8']
        this.data['8'] = this.data['7']
        this.data['7'] = this.data['6']
        this.data['6'] = this.data['5']
        this.data['5'] = this.data['4']
        this.data['4'] = this.data['3']
        this.data['3'] = this.data['2']
        this.data['2'] = this.data['1']
        this.data['1'] = value
      } else {
        this.data[name] = value
      }
    }
  }

  appendValue (oldValue: RegisterValue, newValue: RegisterValue): RegisterValue {
    const finalValue = Object.assign({}, oldValue) // Copy

    if (oldValue.type === 'linewise' || newValue.type === 'linewise') {
      if (finalValue.type !== 'linewise') {
        finalValue.type = 'linewise'
        finalValue.text += '\n'
      }
      if (newValue.type !== 'linewise') {
        newValue.text += '\n'
      }
    }

    finalValue.text += newValue.text
    return finalValue
  }

  isUnnamed (): boolean {
    return this.name == null || this.name === '"'
  }

  setName (name?: string | null): void {
    if (name != null) {
      this.name = name
      this.editorElement.toggleCssClass('with-register', true)
      this.vimState.hover.set('"' + this.name)
    } else {
      this.vimState.hover.set('"')
      const cancel = () => this.vimState.hover.reset()
      this.vimState.readChar({
        onConfirm: name => {
          if (this.isValidName(name)) this.setName(name)
          else cancel()
        },
        onCancel: cancel
      })
    }
  }
}
