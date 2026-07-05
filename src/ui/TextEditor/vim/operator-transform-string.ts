// Curated subset of xedel/vim-mode-plus's lib/operator-transform-string.js.
//
// Upstream's file is ~900 lines covering many exotic transforms (sort, rotate,
// align, reflow, external-command, select-list, URI-encode, split-arguments, …)
// that depend on Atom-only infra (BufferedProcess, select-list UI) or niche
// grammar services. zym vendors only the high-value, self-contained operators
// — the class bodies are copied verbatim from upstream (names preserved to ease
// diffing); the rest are intentionally omitted and can be ported on demand:
//   - ChangeCase family → gU / gu / g~  (uses the local `changeCase` shim)
//   - Replace / ReplaceCharacter → r
//   - Surround / DeleteSurround / ChangeSurround → ys / ds / cs
//
// ESM conversion: `require`→`import`; the trailing `module.exports` map → eager
// `klass.register()` (matching the other vendored operation modules).
import changeCase from './changeCase.ts'
import { Operator } from './operator.ts'
import type { Selection } from '../Selection.ts'
import type { Point } from '../../../text/Point.ts'

// TransformString
// ================================
class TransformString extends Operator {
  static command = false
  static stringTransformers: Array<typeof TransformString> = []
  trackChange = true
  stayOptionName = 'stayOnTransformString'
  autoIndent = false
  autoIndentNewline = false
  replaceByDiff = false

  // Implemented by subclasses; may return undefined to skip the mutation.
  getNewText? (text: string, selection?: Selection): string | undefined

  static registerToSelectList (): void {
    this.stringTransformers.push(this)
  }

  mutateSelection (selection: Selection): void {
    const text = this.getNewText!(selection.getText(), selection)
    if (text) {
      if (this.replaceByDiff) {
        this.replaceTextInRangeViaDiff(selection.getBufferRange(), text)
      } else {
        // TODO(vim-ts): Selection.insertText takes no options arg in EditorModel host.
        ;(selection.insertText as any)(text, {autoIndent: this.autoIndent, autoIndentNewline: this.autoIndentNewline})
      }
    }
  }
}

class ChangeCase extends TransformString {
  static command = false
  functionName?: string
  getNewText (text: string): string {
    const functionName = this.functionName || changeCase.lowerCaseFirst(this.name)
    // HACK: Pure Vim's `~` is too aggressive(e.g. remove punctuation, remove white spaces...).
    // Here intentionally making changeCase less aggressive by narrowing target charset.
    const charset = '[À-ʯΆ-և\\w]'
    const regex = new RegExp(`${charset}+(:?[-./]?${charset}+)*`, 'g')
    return text.replace(regex, (match: string) => (changeCase as Record<string, (text: string) => string>)[functionName](match))
  }
}

class UpperCase extends ChangeCase {} // gU
class LowerCase extends ChangeCase {} // gu

class ToggleCase extends ChangeCase {
  static displayNameSuffix = '~'
  functionName = 'swapCase'
}

class ToggleCaseAndMoveRight extends ChangeCase {
  functionName = 'swapCase'
  flashTarget = false
  restorePositions = false
  target = 'MoveRight'
}

// Replace
// -------------------------
class Replace extends TransformString {
  flashCheckpoint = 'did-select-occurrence'
  autoIndentNewline = true
  readInputAfterSelect = true

  getNewText (text: string): string | undefined {
    if (this.target.name === 'MoveRightBufferColumn' && text.length !== this.getCount()) {
      return
    }

    const input = this.input || '\n'
    if (input === '\n') {
      this.restorePositions = false
    }
    return text.replace(/./g, input)
  }
}

class ReplaceCharacter extends Replace {
  target = 'MoveRightBufferColumn'
}

// Surround
// -------------------------
type SurroundAction = 'surround' | 'delete-surround' | 'change-surround' | null

class SurroundBase extends TransformString {
  static command = false
  surroundAction: SurroundAction = null
  // The `f` (function) variants (`ysf`/`csf`) finish in insert mode so the user
  // can type the function name. `enterInsertAfter` requests it; `surroundStartPoint`
  // is where the inserted text begins (= where the cursor lands). See postMutate().
  enterInsertAfter = false
  changeFunctionName = false
  surroundStartPoint: Point | null = null
  pairsByAlias: Record<string, string[]> = {
    '(': ['(', ')'],
    ')': ['(', ')'],
    '{': ['{', '}'],
    '}': ['{', '}'],
    '[': ['[', ']'],
    ']': ['[', ']'],
    '<': ['<', '>'],
    '>': ['<', '>'],
    b: ['(', ')'],
    r: ['[', ']'],
    k: ['{', '}'], // curly alias (replaces vim-surround's `B`, to match the text objects)
    a: ['<', '>']
  }

  initialize (): void {
    this.replaceByDiff = this.getConfig('replaceByDiffOnSurround')
    this.stayByMarker = this.replaceByDiff
    super.initialize()
  }

  getPair (char: string): string[] {
    const userConfig = this.getConfig('customSurroundPairs')
    const customPairByAlias: Record<string, string[]> = JSON.parse(userConfig) || {}
    return customPairByAlias[char] || this.pairsByAlias[char] || [char, char]
  }

  surround (text: string, char: string, {keepLayout = false, selection}: {keepLayout?: boolean, selection?: Selection} = {}): string {
    let [open, close, addSpace] = this.getPair(char)
    if (!keepLayout && text.endsWith('\n')) {
      const baseIndentLevel = this.editor.indentationForBufferRow(selection!.getBufferRange().start.row)
      const indentTextStartRow = this.editor.buildIndentString(baseIndentLevel)
      const indentTextOneLevel = this.editor.buildIndentString(1)

      open = indentTextStartRow + open + '\n'
      text = text.replace(/^(.+)$/gm, (m: string) => indentTextOneLevel + m)
      close = indentTextStartRow + close + '\n'
    }

    if (this.utils.isSingleLineText(text)) {
      if (addSpace || this.getConfig('charactersToAddSpaceOnSurround').includes(char)) {
        text = ' ' + text + ' '
      }
    }
    return open + text + close
  }

  getTargetPair (): string[] | undefined {
    if (this.target) {
      return this.target.pair
    }
  }

  deleteSurround (text: string): string {
    const [open, close] = this.getTargetPair() || [text[0], text[text.length - 1]]
    const innerText = text.slice(open.length, text.length - close.length)
    return this.utils.isSingleLineText(text) && open !== close ? innerText.trim() : innerText
  }

  getNewText (text: string, selection?: Selection): string | undefined {
    if (this.surroundAction === 'surround') {
      // `ys{motion}f` — wrap in `(...)` and enter insert mode before the `(` so
      // the user types the function name (e.g. `x` -> `|(x)`). A motion that runs
      // to a line end (e.g. `ysw`) trails a newline; keep it outside the parens so
      // the call stays inline rather than spanning the line.
      if (this.input === 'f') {
        this.enterInsertAfter = true
        const newline = text.endsWith('\n') ? '\n' : ''
        return '(' + text.slice(0, text.length - newline.length) + ')' + newline
      }
      return this.surround(text, this.input, {selection})
    } else if (this.surroundAction === 'delete-surround') {
      return this.deleteSurround(text)
    } else if (this.surroundAction === 'change-surround') {
      // `csf` — strip only the function name, keep `(...)` verbatim, and enter
      // insert mode before the `(` (e.g. `fn(x)` -> `|(x)`).
      if (this.changeFunctionName) {
        this.enterInsertAfter = true
        const pair = this.getTargetPair()
        const nameLength = pair ? pair[0].length - 1 : 0 // pair[0] is `name(`
        return text.slice(Math.max(0, nameLength))
      }
      return this.surround(this.deleteSurround(text), this.input, {keepLayout: true})
    }
  }

  // Capture where the inserted text starts BEFORE the edit; the `f` variants put
  // the cursor here in insert mode afterwards (see postMutate / enterInsertAfter).
  mutateSelection (selection: Selection): void {
    this.surroundStartPoint = selection.getBufferRange().start
    super.mutateSelection(selection)
  }

  postMutate (): void {
    if (this.enterInsertAfter && this.surroundStartPoint) {
      this.groupChangesSinceBufferCheckpoint('undo')
      this.emitDidFinishMutation()
      this.editor.setCursorBufferPosition(this.surroundStartPoint)
      this.activateMode('insert')
    } else {
      super.postMutate()
    }
  }

  // The `f` (function) char targets the enclosing function *call* rather than a
  // literal pair: `dsf` deletes `name(` … `)`; `csf` (overridden below) keeps the
  // parens. Shared by Delete/ChangeSurround; read after the `ds`/`cs` prefix.
  onConfirmSurroundChar (char: string): void {
    if (char === 'f') {
      this.setTarget(this.getInstance('FunctionCall'))
    } else {
      this.setTarget(this.getInstance('APair', {pair: this.getPair(char)}))
    }
    this.processOperation()
  }
}

class Surround extends SurroundBase {
  surroundAction: SurroundAction = 'surround'
  // Read the pair char up front so `ys{motion}` never leaves the target visually
  // selected while waiting for the key. (ChangeSurround still reads after select:
  // it needs the target's existing pair to drive its hover.)
  readInputBeforeSelect = true
}

class SurroundWord extends Surround {
  target = 'InnerWord'
}

class DeleteSurround extends SurroundBase {
  surroundAction: SurroundAction = 'delete-surround'
  initialize (): void {
    if (!this.target) {
      this.focusInput({onConfirm: (char: string) => this.onConfirmSurroundChar(char)})
    }
    super.initialize()
  }
}

// Indent / Outdent
// -------------------------
class Indent extends TransformString {
  stayByMarker = true
  setToFirstCharacterOnLinewise = true
  wise = 'linewise' as const

  mutateSelection (selection: Selection): void {
    // Need count times indentation in visual-mode and its repeat(`.`).
    if (this.target.name === 'CurrentSelection') {
      let oldText: string
      // limit to 100 to avoid freezing by accidental big number.
      this.countTimes(this.limitNumber(this.getCount(), {max: 100}), ({stop}) => {
        oldText = selection.getText()
        this.indent(selection)
        if (selection.getText() === oldText) stop()
      })
    } else {
      this.indent(selection)
    }
  }

  indent (selection: Selection): void {
    selection.indentSelectedRows()
  }
}

class Outdent extends Indent {
  indent (selection: Selection): void {
    selection.outdentSelectedRows()
  }
}

// `=` — re-indent each row of the target to its syntactic level (the tree-sitter
// indent source via editor.autoIndentBufferRow). `==` re-indents the current line.
class AutoIndent extends TransformString {
  stayByMarker = true
  setToFirstCharacterOnLinewise = true
  wise = 'linewise' as const

  mutateSelection (selection: Selection): void {
    const range = selection.getBufferRange()
    // A linewise range ending at column 0 of a later row doesn't include that row.
    let lastRow = range.end.row
    if (range.end.column === 0 && range.end.row > range.start.row) lastRow--
    for (let row = range.start.row; row <= lastRow; row++) {
      this.editor.autoIndentBufferRow(row)
    }
  }
}

// ToggleLineComments (vim-commentary / nvim `g c`)
// -------------------------
// `g c {motion}` toggles the motion's rows, `g c g c` the current line (via the
// same-operator repeat), visual `g c` the selection. Delimiters come from the
// file's language through EditorModel's comment-spec source.
class ToggleLineComments extends TransformString {
  flashTarget = false
  stayByMarker = true
  wise = 'linewise' as const

  mutateSelection (selection: Selection): void {
    selection.toggleLineComments()
  }
}

// zym addition (not upstream): `g c c`, the vim-commentary current-line stroke —
// the operator with a preset current-line target (the Join/YankLine pattern).
class ToggleLineCommentsCurrentLine extends ToggleLineComments {
  target = 'MoveToRelativeLine'
}

// Join
// -------------------------
class JoinTarget extends TransformString {
  flashTarget = false
  restorePositions = false

  mutateSelection (selection: Selection): void {
    const range = selection.getBufferRange()

    // When cursor is at last BUFFER row, it select last-buffer-row, then
    // joinning result in "clear last-buffer-row text".
    // I believe this is BUG of upstream atom-core. guard this situation here
    if (!range.isSingleLine() || range.end.row !== this.editor.getLastBufferRow()) {
      if (this.utils.isLinewiseRange(range)) {
        selection.setBufferRange(range.translate([0, 0], [-1, Infinity]))
      }
      selection.joinLines()
    }
    const point = selection.getBufferRange().end.translate([0, -1])
    return selection.cursor.setBufferPosition(point)
  }
}

class Join extends JoinTarget {
  target = 'MoveToRelativeLine'
}

class ChangeSurround extends DeleteSurround {
  surroundAction: SurroundAction = 'change-surround'
  readInputAfterSelect = true

  // `csf` — change the function name: target the whole call, but skip reading a
  // "to" pair (getNewText strips the name and we enter insert mode instead).
  onConfirmSurroundChar (char: string): void {
    if (char === 'f') {
      this.changeFunctionName = true
      this.readInputAfterSelect = false
      this.setTarget(this.getInstance('FunctionCall'))
      this.processOperation()
    } else {
      super.onConfirmSurroundChar(char)
    }
  }

  // Override to show changing char on hover
  async focusInputPromised (...args: Parameters<Operator['focusInputPromised']>): Promise<string | undefined> {
    const hoverPoint = this.mutationManager.getInitialPointForSelection(this.editor.getLastSelection())
    const openSurrondText = this.getTargetPair() ? this.getTargetPair()![0] : this.editor.getSelectedText()[0]
    this.vimState.hover.set(openSurrondText, hoverPoint)
    return super.focusInputPromised(...args)
  }
}

const __operations = {
  TransformString,
  ChangeCase,
  UpperCase,
  LowerCase,
  ToggleCase,
  ToggleCaseAndMoveRight,
  Replace,
  ReplaceCharacter,
  Indent,
  Outdent,
  AutoIndent,
  ToggleLineComments,
  ToggleLineCommentsCurrentLine,
  JoinTarget,
  Join,
  SurroundBase,
  Surround,
  SurroundWord,
  DeleteSurround,
  ChangeSurround
}

for (const klass of Object.values(__operations)) klass.register()
export default __operations
