// Curated subset of xedel/vim-mode-plus's lib/operator-transform-string.js.
//
// Upstream's file is ~900 lines covering many exotic transforms (sort, rotate,
// align, reflow, external-command, select-list, URI-encode, split-arguments, …)
// that depend on Atom-only infra (BufferedProcess, select-list UI) or niche
// grammar services. quilx vendors only the high-value, self-contained operators
// — the class bodies are copied verbatim from upstream (names preserved to ease
// diffing); the rest are intentionally omitted and can be ported on demand:
//   - ChangeCase family → gU / gu / g~  (uses the local `changeCase` shim)
//   - Replace / ReplaceCharacter → r
//   - Surround / DeleteSurround / ChangeSurround → ys / ds / cs
//
// ESM conversion: `require`→`import`; the trailing `module.exports` map → eager
// `klass.register()` (matching the other vendored operation modules).
import changeCase from './changeCase.ts'
import { Operator } from './operator.js'

// TransformString
// ================================
class TransformString extends Operator {
  static command = false
  static stringTransformers = []
  trackChange = true
  stayOptionName = 'stayOnTransformString'
  autoIndent = false
  autoIndentNewline = false
  replaceByDiff = false

  static registerToSelectList () {
    this.stringTransformers.push(this)
  }

  mutateSelection (selection) {
    const text = this.getNewText(selection.getText(), selection)
    if (text) {
      if (this.replaceByDiff) {
        this.replaceTextInRangeViaDiff(selection.getBufferRange(), text)
      } else {
        selection.insertText(text, {autoIndent: this.autoIndent, autoIndentNewline: this.autoIndentNewline})
      }
    }
  }
}

class ChangeCase extends TransformString {
  static command = false
  getNewText (text) {
    const functionName = this.functionName || changeCase.lowerCaseFirst(this.name)
    // HACK: Pure Vim's `~` is too aggressive(e.g. remove punctuation, remove white spaces...).
    // Here intentionally making changeCase less aggressive by narrowing target charset.
    const charset = '[À-ʯΆ-և\\w]'
    const regex = new RegExp(`${charset}+(:?[-./]?${charset}+)*`, 'g')
    return text.replace(regex, match => changeCase[functionName](match))
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

  getNewText (text) {
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
class SurroundBase extends TransformString {
  static command = false
  surroundAction = null
  pairsByAlias = {
    '(': ['(', ')'],
    ')': ['(', ')'],
    '{': ['{', '}'],
    '}': ['{', '}'],
    '[': ['[', ']'],
    ']': ['[', ']'],
    '<': ['<', '>'],
    '>': ['<', '>'],
    b: ['(', ')'],
    B: ['{', '}'],
    r: ['[', ']'],
    a: ['<', '>']
  }

  initialize () {
    this.replaceByDiff = this.getConfig('replaceByDiffOnSurround')
    this.stayByMarker = this.replaceByDiff
    super.initialize()
  }

  getPair (char) {
    const userConfig = this.getConfig('customSurroundPairs')
    const customPairByAlias = JSON.parse(userConfig) || {}
    return customPairByAlias[char] || this.pairsByAlias[char] || [char, char]
  }

  surround (text, char, {keepLayout = false, selection} = {}) {
    let [open, close, addSpace] = this.getPair(char)
    if (!keepLayout && text.endsWith('\n')) {
      const baseIndentLevel = this.editor.indentationForBufferRow(selection.getBufferRange().start.row)
      const indentTextStartRow = this.editor.buildIndentString(baseIndentLevel)
      const indentTextOneLevel = this.editor.buildIndentString(1)

      open = indentTextStartRow + open + '\n'
      text = text.replace(/^(.+)$/gm, m => indentTextOneLevel + m)
      close = indentTextStartRow + close + '\n'
    }

    if (this.utils.isSingleLineText(text)) {
      if (addSpace || this.getConfig('charactersToAddSpaceOnSurround').includes(char)) {
        text = ' ' + text + ' '
      }
    }
    return open + text + close
  }

  getTargetPair () {
    if (this.target) {
      return this.target.pair
    }
  }

  deleteSurround (text) {
    const [open, close] = this.getTargetPair() || [text[0], text[text.length - 1]]
    const innerText = text.slice(open.length, text.length - close.length)
    return this.utils.isSingleLineText(text) && open !== close ? innerText.trim() : innerText
  }

  getNewText (text, selection) {
    if (this.surroundAction === 'surround') {
      return this.surround(text, this.input, {selection})
    } else if (this.surroundAction === 'delete-surround') {
      return this.deleteSurround(text)
    } else if (this.surroundAction === 'change-surround') {
      return this.surround(this.deleteSurround(text), this.input, {keepLayout: true})
    }
  }
}

class Surround extends SurroundBase {
  surroundAction = 'surround'
  readInputAfterSelect = true
}

class SurroundWord extends Surround {
  target = 'InnerWord'
}

class DeleteSurround extends SurroundBase {
  surroundAction = 'delete-surround'
  initialize () {
    if (!this.target) {
      this.focusInput({
        onConfirm: char => {
          this.setTarget(this.getInstance('APair', {pair: this.getPair(char)}))
          this.processOperation()
        }
      })
    }
    super.initialize()
  }
}

// Indent / Outdent
// -------------------------
class Indent extends TransformString {
  stayByMarker = true
  setToFirstCharacterOnLinewise = true
  wise = 'linewise'

  mutateSelection (selection) {
    // Need count times indentation in visual-mode and its repeat(`.`).
    if (this.target.name === 'CurrentSelection') {
      let oldText
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

  indent (selection) {
    selection.indentSelectedRows()
  }
}

class Outdent extends Indent {
  indent (selection) {
    selection.outdentSelectedRows()
  }
}

// Join
// -------------------------
class JoinTarget extends TransformString {
  flashTarget = false
  restorePositions = false

  mutateSelection (selection) {
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
  surroundAction = 'change-surround'
  readInputAfterSelect = true

  // Override to show changing char on hover
  async focusInputPromised (...args) {
    const hoverPoint = this.mutationManager.getInitialPointForSelection(this.editor.getLastSelection())
    const openSurrondText = this.getTargetPair() ? this.getTargetPair()[0] : this.editor.getSelectedText()[0]
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
