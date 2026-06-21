// Vendored from xedel/vim-mode-plus's lib/utils.js. ESM conversion plus a few
// neutralized seams: Atom-platform helpers that motions don't use (keybinding
// lookup, package activation, project-find, version checks) are stubbed, and
// `nonWordCharacters` falls back to a built-in default instead of atom.config.
// The fs-plus/semver deps are dropped; `replaceTextInRangeViaDiff` keeps its
// char-diff behavior via the `diff` package. Geometry/scan helpers are unchanged.
import { diffChars } from 'diff'
import settings from './settings.ts'
import { Range } from '../../../text/Range.ts'
import type { RangeLike } from '../../../text/Range.ts'
import { Point } from '../../../text/Point.ts'
import type { PointLike } from '../../../text/Point.ts'
import type { EditorModel, ScanMatchResult } from '../EditorModel.ts'
import type { Cursor } from '../Cursor.ts'

// Scan options shared by scanEditor/findInEditor/findPoint and friends.
// TODO(vim-ts): tighten — some callers pass extra ad-hoc props.
interface ScanOptions {
  from?: PointLike
  scanRange?: RangeLike
  contains?: boolean
  allowNextLine?: boolean
  skipEmptyRow?: boolean
  skipWhiteSpaceOnlyRow?: boolean
  row?: number
  [key: string]: any
}

type ScanDirection = 'forward' | 'next' | 'backward' | 'previous'

// Atom's default `editor.nonWordCharacters`, used for word-boundary detection.
export const DEFAULT_NON_WORD_CHARACTERS = '/\\()"\':,.;<>~!@#$%^&*|+=[]{}`?-…'

const NEWLINE_REG_EXP = /\n/g

// [Borrowed from underscore/underscore-plus
function escapeRegExp (s: string): string {
  return s ? s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') : ''
}

function getLast<T> (list: ArrayLike<T> | null | undefined): T | undefined {
  return list ? list[list.length - 1] : undefined
}

function assertWithException (condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function getKeyBindingForCommand (command: string, {packageName: _packageName}: {packageName?: string} = {}): null {
  // Keybinding hints (used by hover/demo UI) are not ported; no hints for now.
  return null
}

function debug (...messages: unknown[]): void {
  if (!settings.get('debug')) return

  switch (settings.get('debugOutput')) {
    case 'console':
      console.log(...messages)
      return
    case 'file':
      // File debug output (fs-plus) is not ported; debug to the console instead.
      console.log(...messages)
  }
}

// Return function to restore editor's scrollTop and fold state.
function saveEditorState (editor: any): (options?: {anchorPosition?: any, skipRow?: number | null}) => void {
  // TODO(vim-ts): tighten — editor.displayLayer/foldsMarkerLayer not modeled on EditorModel.
  const store: any = {scrollTop: editor.element.getScrollTop()}

  const foldRowRanges: [number, number][] = editor.displayLayer.foldsMarkerLayer.findMarkers({}).map((marker: any) => {
    const {start, end} = marker.getRange()
    return [start.row, end.row]
  })

  return function restoreEditorState (this: any, {anchorPosition, skipRow = null}: {anchorPosition?: any, skipRow?: number | null} = {}): void {
    if (anchorPosition) {
      store.anchorScreenRow = this.editor.screenPositionForBufferPosition(anchorPosition).row
      store.anchorFirstVisibileScreenRow = editor.getFirstVisibleScreenRow()
    }

    for (const [startRow, endRow] of foldRowRanges.reverse()) {
      if (skipRow! >= startRow && skipRow! <= endRow) continue
      if (!editor.isFoldedAtBufferRow(startRow)) {
        editor.foldBufferRow(startRow)
      }
    }

    if (anchorPosition) {
      const {anchorScreenRow, anchorFirstVisibileScreenRow} = store
      const shrinkedRows = anchorScreenRow - this.editor.screenPositionForBufferPosition(anchorPosition).row
      this.editor.setFirstVisibleScreenRow(anchorFirstVisibileScreenRow - shrinkedRows)
    } else {
      editor.element.setScrollTop(store.scrollTop)
    }
  }
}

function isLinewiseRange ({start, end}: Range): boolean {
  return start.row !== end.row && (start.column === 0 && end.column === 0)
}

function isEndsWithNewLineForBufferRow (editor: EditorModel, row: number): boolean {
  const {start, end} = editor.bufferRangeForBufferRow(row, {includeNewline: true})
  return start.row !== end.row
}

interface Comparable<T> { compare(other: T): number }
function sortComparables<T extends Comparable<T>> (comparables: T[]): T[] {
  return comparables.sort((a, b) => a.compare(b))
}

// This is just clarify intention, adds no value in fucntionalities.
const [sortRanges, sortCursors, sortPoints] = [sortComparables, sortComparables, sortComparables]

// Return adjusted index fit whitin given list's length
// return -1 if list is empty.
function getIndex (index: number, list: ArrayLike<unknown>): number {
  if (!list.length) return -1
  index = index % list.length
  return index >= 0 ? index : list.length + index
}

// NOTE: endRow become undefined if @editorElement is not yet attached.
// e.g. Beging called immediately after open file.
function getVisibleBufferRange (editor: any): Range | undefined {
  // TODO(vim-ts): tighten — getVisibleRowRange/bufferRowForScreenRow visibility not on EditorModel.
  const [startRow, endRow] = editor.getVisibleRowRange()

  // When editor is not attached or imediately after attached timing,
  // `editor.element.getVisibleRowRange()` return NaN.
  // As my undestanding, in vmp usage, we hit this situation only in test-spec, not in real usage.
  if (Number.isInteger(startRow) && Number.isInteger(endRow)) {
    return new Range([editor.bufferRowForScreenRow(startRow), 0], [editor.bufferRowForScreenRow(endRow), Infinity])
  }
}

function getVisibleEditors (): EditorModel[] {
  // The visible-editors set (workspace panes) is not modeled yet.
  return []
}

function getEndOfLineForBufferRow (editor: EditorModel, row: number): Point {
  return editor.bufferRangeForBufferRow(row).end
}

// Buffer Point util
// -------------------------
function pointIsAtEndOfLine (editor: EditorModel, point: PointLike): boolean {
  point = Point.fromObject(point)
  return getEndOfLineForBufferRow(editor, point.row).isEqual(point)
}

function pointIsAtWhiteSpace (editor: EditorModel, point: PointLike): boolean {
  const char = getRightCharacterForBufferPosition(editor, point)
  return !/\S/.test(char)
}

function pointIsAtNonWhiteSpace (editor: EditorModel, point: PointLike): boolean {
  const char = getRightCharacterForBufferPosition(editor, point)
  return char != null && /\S/.test(char)
}

function pointIsAtEndOfLineAtNonEmptyRow (editor: EditorModel, point: PointLike): boolean {
  point = Point.fromObject(point)
  return point.column > 0 && pointIsAtEndOfLine(editor, point)
}

function pointIsAtVimEndOfFile (editor: EditorModel, point: PointLike): boolean {
  return getVimEofBufferPosition(editor).isEqual(point)
}

function isEmptyRow (editor: EditorModel, row: number): boolean {
  return editor.bufferRangeForBufferRow(row).isEmpty()
}

function getRightCharacterForBufferPosition (editor: EditorModel, point: PointLike, amount = 1): string {
  return editor.getTextInBufferRange(Range.fromPointWithDelta(point, 0, amount))
}

function getLeftCharacterForBufferPosition (editor: EditorModel, point: PointLike, amount = 1): string {
  return editor.getTextInBufferRange(Range.fromPointWithDelta(point, 0, -amount))
}

function getTextInScreenRange (editor: any, screenRange: RangeLike): string {
  // TODO(vim-ts): tighten — bufferRangeForScreenRange not on EditorModel.
  return editor.getTextInBufferRange(editor.bufferRangeForScreenRange(screenRange))
}

function getNonWordCharactersForCursor (cursor: Cursor): string {
  if (settings.get('useLanguageIndependentNonWordCharacters')) {
    return settings.get('languageIndependentNonWordCharacters') as string
  }

  return cursor.getNonWordCharacters != null
    ? cursor.getNonWordCharacters()
    : DEFAULT_NON_WORD_CHARACTERS
}

function getRows (editor: EditorModel, bufferOrScreen: 'buffer' | 'screen', {startRow, direction}: {startRow: number, direction: 'previous' | 'next'}): number[] | undefined {
  switch (direction) {
    case 'previous':
      return startRow <= 0 ? [] : getList(startRow - 1, 0)
    case 'next': {
      const endRow = bufferOrScreen === 'buffer' ? getVimLastBufferRow(editor) : getVimLastScreenRow(editor)
      return startRow >= endRow ? [] : getList(startRow + 1, endRow)
    }
  }
}

// Return Vim's EOF position rather than Atom's EOF position.
// This function change meaning of EOF from native TextEditor::getEofBufferPosition()
// Atom is special(strange) for cursor can past very last newline character.
// Because of this, Atom's EOF position is [actualLastRow+1, 0] provided last-non-blank-row
// ends with newline char.
// But in Vim, curor can NOT past last newline. EOF is next position of very last character.
function getVimEofBufferPosition (editor: EditorModel): Point {
  const eof = editor.getEofBufferPosition()
  // In Vim the cursor can't sit past the last newline, so when the buffer ends
  // with a newline (EOF is column 0 of a trailing empty row) the Vim EOF is the
  // end of the previous row instead.
  return eof.row === 0 || eof.column > 0 ? eof : getEndOfLineForBufferRow(editor, eof.row - 1)
}

function getVimEofScreenPosition (editor: EditorModel): Point {
  return editor.screenPositionForBufferPosition(getVimEofBufferPosition(editor))
}

function getVimLastBufferRow (editor: EditorModel): number {
  return getVimEofBufferPosition(editor).row
}

function getVimLastScreenRow (editor: EditorModel): number {
  return getVimEofScreenPosition(editor).row
}

function getFirstCharacterPositionForBufferRow (editor: EditorModel, row: number): Point | undefined {
  const scanRange = editor.bufferRangeForBufferRow(row)
  return findInEditor(editor, 'forward', /^[ \t]*/, {scanRange}, event => event.range.end)
}

function getScreenPositionForScreenRow (editor: any, row: number, which: 'beginning' | 'last-character' | 'first-character', {allowOffScreenPosition = false}: {allowOffScreenPosition?: boolean} = {}): Point | undefined {
  // TODO(vim-ts): tighten — getFirstVisibleScreenColumn/getEditorWidthInChars/clipScreenPosition/bufferRangeForScreenRange not on EditorModel.
  if (which === 'beginning') {
    const column = allowOffScreenPosition ? 0 : editor.getFirstVisibleScreenColumn()
    return new Point(row, column)
  } else if (which === 'last-character') {
    const column = allowOffScreenPosition
      ? Infinity
      : editor.getFirstVisibleScreenColumn() + editor.getEditorWidthInChars()
    return new Point(row, column)
  } else if (which === 'first-character') {
    const column = allowOffScreenPosition
      ? editor.clipScreenPosition([row, 0], {skipSoftWrapIndentation: true}).column
      : editor.getFirstVisibleScreenColumn()

    const scanRange = editor.bufferRangeForScreenRange([[row, column], [row, Infinity]])
    const point = findInEditor(editor, 'forward', /\S/, {scanRange}, event => event.range.start)
    if (point) return editor.screenPositionForBufferPosition(point)
  }
}

function trimBufferRange (editor: EditorModel, range: Range): Range {
  // Trim to the first and last non-whitespace: the forward scan's first match is
  // the new start, the backward scan's first match (last in the buffer) the new
  // end. Each must stop after that first hit — without `stop()` every match
  // overwrites, leaving start=last / end=first (a reversed, empty range).
  const newRange = range.copy()
  editor.scanInBufferRange(/\S/, range, event => {
    newRange.start = event.range.start
    event.stop()
  })
  editor.backwardsScanInBufferRange(/\S/, range, event => {
    newRange.end = event.range.end
    event.stop()
  })
  return newRange
}

// Cursor motion wrapper
// -------------------------
// Set bufferRow with keeping column and goalColumn
function setBufferRow (cursor: Cursor, row: number, options?: unknown): void {
  const editor = cursor.editor
  if (editor.softTabs) {
    const column = cursor.goalColumn != null ? cursor.goalColumn : cursor.getBufferColumn()
    cursor.setBufferPosition([row, column], options)
    cursor.goalColumn = column
  } else {
    const column =
      cursor.goalColumn != null
        ? cursor.goalColumn
        : translateColumnOnHardTabEditor(editor, cursor.getBufferRow(), cursor.getBufferColumn(), true)

    cursor.setBufferPosition([row, translateColumnOnHardTabEditor(editor, row, column, false)], options)
    cursor.goalColumn = column
  }
}

function translateColumnOnHardTabEditor (editor: EditorModel, row: number, column: number, expandTab: boolean): number {
  const chars = editor.lineTextForBufferRow(row).slice(0, column)

  if (column === 0 || column === Infinity || !chars.includes('\t')) {
    return column
  }

  let newColumn = 0
  const tabLength = editor.getTabLength()
  const charLength = (char: string) => (char === '\t' ? tabLength : 1)
  if (expandTab) {
    for (const char of chars) {
      newColumn += charLength(char)
    }
  } else {
    let traversedColumn = 0
    for (const char of chars) {
      newColumn++
      traversedColumn += charLength(char)
      if (traversedColumn >= column) {
        if (traversedColumn > column) newColumn--
        break
      }
    }
  }
  return newColumn
}

function setBufferColumn (cursor: Cursor, column: number): void {
  return cursor.setBufferPosition([cursor.getBufferRow(), column])
}

function moveCursor (cursor: Cursor, keepGoalColumn: boolean | undefined, fn: (cursor: Cursor) => void): void {
  const goalColumn = keepGoalColumn ? cursor.goalColumn : undefined
  fn(cursor)
  if (goalColumn != null) {
    cursor.goalColumn = goalColumn
  }
}

interface MoveCursorOptions { allowWrap?: boolean, preventIncorrectWrap?: boolean, keepGoalColumn?: boolean }
function moveCursorLeft (cursor: Cursor, {allowWrap, preventIncorrectWrap, keepGoalColumn}: MoveCursorOptions = {}): void {
  // See t9md/vim-mode-plus#226
  // On atomicSoftTabs enabled editor, there is situation where
  // (bufferColumn >  0 && screenColumn === 0) become true.
  // So we cannot believe bufferColumn, check screenColumn to prevent wrap.
  if (preventIncorrectWrap && (cursor as any).getScreenColumn() === 0) {
    return
  }

  if (!cursor.isAtBeginningOfLine() || allowWrap) {
    moveCursor(cursor, keepGoalColumn, cursor => cursor.moveLeft())
  }
}

function moveCursorRight (cursor: Cursor, {allowWrap, keepGoalColumn}: MoveCursorOptions = {}): void {
  if (!cursor.isAtEndOfLine() || allowWrap) {
    moveCursor(cursor, keepGoalColumn, (cursor: any) => cursor.moveRight())
  }
}

function moveCursorUpScreen (cursor: Cursor, {keepGoalColumn}: MoveCursorOptions = {}): void {
  if (cursor.getScreenRow() > 0) {
    moveCursor(cursor, keepGoalColumn, (cursor: any) => cursor.moveUp())
  }
}

function moveCursorDownScreen (cursor: Cursor, {keepGoalColumn}: MoveCursorOptions = {}): void {
  if (cursor.getScreenRow() < getVimLastScreenRow(cursor.editor)) {
    moveCursor(cursor, keepGoalColumn, (cursor: any) => cursor.moveDown())
  }
}

function moveCursorToFirstCharacterAtRow (cursor: Cursor, row: number): void {
  cursor.setBufferPosition([row, 0])
  cursor.moveToFirstCharacterOfLine()
}

function getValidVimBufferRow (editor: EditorModel, row: number): number {
  return limitNumber(row, {min: 0, max: getVimLastBufferRow(editor)})
}

function getValidVimScreenRow (editor: EditorModel, row: number): number {
  return limitNumber(row, {min: 0, max: getVimLastScreenRow(editor)})
}

// By default not include column
function getLineTextToBufferPosition (editor: EditorModel, {row, column}: {row: number, column: number}, {exclusive = true}: {exclusive?: boolean} = {}): string {
  return editor.lineTextForBufferRow(row).slice(0, exclusive ? column : column + 1)
}

function getCodeFoldRanges (editor: EditorModel): Range[] {
  // quilx: foldable ranges come from the tree-sitter fold model (SyntaxController),
  // surfaced via EditorModel — not Atom's tokenizedBuffer.
  return editor.getFoldableRanges()
}

// Used in vmp-jasmine-increase-focus
function getCodeFoldRangesContainesRow (editor: EditorModel, bufferRow: number): Range[] {
  return getCodeFoldRanges(editor).filter(range => range.start.row <= bufferRow && bufferRow <= range.end.row)
}

function getClosestFoldRangeContainsRow (editor: EditorModel, bufferRow: number): Range | undefined {
  const ranges = getCodeFoldRanges(editor).filter(range => range.start.row <= bufferRow && bufferRow <= range.end.row)
  return getLast(ranges)
}

interface RangeAndIndent { range: Range, indent: number }
interface FoldInfo { listOfRangeAndIndent: RangeAndIndent[], minIndent?: number, maxIndent?: number }
function getFoldInfoByKind (editor: EditorModel): Record<string, FoldInfo> {
  const foldInfoByKind: Record<string, FoldInfo> = {}

  function updateFoldInfo (kind: string, rangeAndIndent: RangeAndIndent): void {
    if (!foldInfoByKind[kind]) {
      foldInfoByKind[kind] = {listOfRangeAndIndent: []}
    }
    const foldInfo = foldInfoByKind[kind]
    foldInfo.listOfRangeAndIndent.push(rangeAndIndent)
    const {indent} = rangeAndIndent
    foldInfo.minIndent = Math.min(foldInfo.minIndent != null ? foldInfo.minIndent : indent, indent)
    foldInfo.maxIndent = Math.max(foldInfo.maxIndent != null ? foldInfo.maxIndent : indent, indent)
  }

  for (const range of getCodeFoldRanges(editor)) {
    const rangeAndIndent = {
      range: range,
      indent: editor.indentationForBufferRow(range.start.row)
    }
    updateFoldInfo('allFold', rangeAndIndent)
    const kind = editor.isFoldedAtBufferRow(range.start.row) ? 'folded' : 'unfolded'
    updateFoldInfo(kind, rangeAndIndent)
  }
  return foldInfoByKind
}

function getBufferRangeForRowRange (editor: EditorModel, [startRow, endRow]: [number, number]): Range {
  return new Range([startRow, 0], [startRow, 0]).union(editor.bufferRangeForBufferRow(endRow, {includeNewline: true}))
}

function getTokenizedLineForRow (editor: any, row: number): any {
  // TODO(vim-ts): tighten — tokenizedBuffer not modeled on EditorModel (scope features inert).
  return editor.tokenizedBuffer.tokenizedLineForRow(row)
}

function getStartingScopesForTokenizedLine (_line: any): string[] {
  // Positive integers: Represent tokens with that length
  // Negative integers: Indicate open/close tags. Odd = start(number can be conveted to scope name), Even = stop.
  // Grammar scope lookup is not ported; scope-based features stay inert.
  return []
}

function isIncludeFunctionScopeForRow (editor: EditorModel, row: number): boolean {
  // [FIXME] Bug of upstream?
  // Sometime tokenizedLines length is less than last buffer row.
  // So tokenizedLine is not accessible even if valid row.
  // In that case I simply return empty Array.
  const tokenizedLine = getTokenizedLineForRow(editor, row)
  return tokenizedLine && getStartingScopesForTokenizedLine(tokenizedLine).some(scope => isFunctionScope(editor, scope))
}

// [FIXME] very rough state, need improvement.
function isFunctionScope (editor: any, scope: string): boolean {
  // TODO(vim-ts): tighten — editor.getGrammar() not modeled on EditorModel.
  const match = (scope: string, ...scopes: string[]) => new RegExp('^' + scopes.map(escapeRegExp).join('|')).test(scope)

  switch (editor.getGrammar().scopeName) {
    case 'source.go':
    case 'source.elixir':
    case 'source.rust':
      return match(scope, 'entity.name.function')
    case 'source.ruby':
      return match(scope, 'meta.function.', 'meta.class.', 'meta.module.')
    case 'source.ts':
      return match(scope, 'meta.function.ts', 'meta.method.declaration.ts', 'meta.interface.ts', 'meta.class.ts')
    case 'source.js':
    case 'source.js.jsx':
      // excluding "meta.function.arrow.js"
      return match(scope, 'meta.function.js', 'meta.function.method.', 'meta.class.js')
    default:
      return match(scope, 'meta.function.', 'meta.class.')
  }
}

// Determine if TreeSitter's SyntaxNode is function-like node.
// Parsed "type" field is unieque to each grammar, so need to add more grammars here.
const SharedJsFunctionTypes = [
  'arrow_function',
  'class',
  'function_declaration',
  'function',
  'method_definition'
]

const FunctionTypesByGrammar = {
  'source.go': ['function_declaration'],
  'source.js': SharedJsFunctionTypes,
  'source.jsx': SharedJsFunctionTypes,
  'source.flow': SharedJsFunctionTypes,
  'source.ts': [...SharedJsFunctionTypes, 'abstract_class'],
  'source.python': ['function_definition', 'class_definition'],
  'source.shell': ['function_definition'],
  'source.ruby': ['method', 'class', 'module'],
  'source.c': ['function_definition', 'preproc_function_def'],
  'source.cpp': ['function_definition', 'preproc_function_def', 'class_specifier']
}

function findParentNodeForFunctionType (editor: any, node: any, where: (node: any) => boolean = () => true): any {
  // TODO(vim-ts): tighten — editor.getGrammar()/tree-sitter SyntaxNode not modeled.
  const types = FunctionTypesByGrammar[editor.getGrammar().scopeName as keyof typeof FunctionTypesByGrammar]
  if (types) {
    return findClosestNodeByType(node, types, where)
  }
}

function findClosestNodeByType (node: any, types: string[], where: (node: any) => boolean): any {
  while (node) {
    if (node.isNamed && types.some(type => node.type === type) && where(node)) {
      return node
    }

    if (node.parent) {
      node = node.parent
    } else {
      break
    }
  }
}

function findFunctionBodyNode (editor: any, node: any): any {
  // TODO(vim-ts): tighten — editor.getGrammar()/tree-sitter SyntaxNode not modeled.
  const findChild = (childType: string) => node.namedChildren.find((node: any) => node.type === childType)
  let bodyNode: any

  switch (editor.getGrammar().scopeName) {
    case 'source.js':
    case 'source.jsx':
    case 'source.ts':
    case 'source.flow':
      if (SharedJsFunctionTypes.includes(node.type)) {
        bodyNode = findChild('statement_block')
      }
      break
    case 'source.c':
    case 'source.cpp':
    case 'source.shell':
      if (node.type === 'function_definition') {
        bodyNode = findChild('compound_statement')
      }
      break
    case 'source.python':
      if (node.type === 'function_definition') {
        const parameterNode = findChild('parameters')
        bodyNode = {
          range: new Range(parameterNode.range.end, node.lastChild.range.end)
        }
      }
      break
  }
  return bodyNode
}

// Scroll to bufferPosition with minimum amount to keep original visible area.
// If target position won't fit within onePageUp or onePageDown, it center target point.
function smartScrollToBufferPosition (editor: any, point: PointLike): void {
  // TODO(vim-ts): tighten — getRowsPerPage/getScrollBottom/pixelPositionForBufferPosition not on EditorModel.
  const editorElement = editor.element
  const editorAreaHeight = editor.getLineHeightInPixels() * (editor.getRowsPerPage() - 1)
  const onePageUp = editorElement.getScrollTop() - editorAreaHeight // No need to limit to min=0
  const onePageDown = editorElement.getScrollBottom() + editorAreaHeight
  const target = editorElement.pixelPositionForBufferPosition(point).top

  const exceedOnePage = onePageDown < target || target < onePageUp
  editor.scrollToBufferPosition(point, {center: exceedOnePage})
}

// NOTE(vim-ts): `hasCssClass` is a free identifier in upstream utils.js (latent
// seam — matchScopes is only reached for non-empty startInInsertModeScopes).
// Declared (not defined) to keep runtime behavior identical while typing.
declare const hasCssClass: (name: string) => boolean
function matchScopes ({classList: _classList}: {classList: any}, scopes: string[] = []): boolean {
  return scopes.some(scope => scope.split('.').every(name => hasCssClass(name)))
}

function isSingleLineText (text: string): boolean {
  return text.split(/\n|\r\n/).length === 1
}

// Return bufferRange and kind ['white-space', 'non-word', 'word']
//
// This function modify wordRegex so that it feel NATURAL in Vim's normal mode.
// In normal-mode, cursor is ractangle(not pipe(|) char).
// Cursor is like ON word rather than BETWEEN word.
// The modification is tailord like this
//   - ON white-space: Includs only white-spaces.
//   - ON non-word: Includs only non word char(=excludes normal word char).
//
// Valid options
//  - wordRegex: instance of RegExp
//  - nonWordCharacters: string
interface WordOptions {
  singleNonWordChar?: boolean
  wordRegex?: RegExp
  nonWordCharacters?: string
  cursor?: Cursor
  boundarizeForWord?: boolean
}
function getWordBufferRangeAndKindAtBufferPosition (editor: EditorModel, point: PointLike, options: WordOptions = {}): {kind: string, range: Range} {
  let kind: string
  let {singleNonWordChar = true, wordRegex, nonWordCharacters, cursor} = options
  if (!wordRegex || !nonWordCharacters) {
    // Complement from cursor
    if (!cursor) cursor = editor.getLastCursor()
    const complemented = Object.assign(options, buildWordPatternByCursor(cursor, wordRegex))
    wordRegex = complemented.wordRegex
    nonWordCharacters = complemented.nonWordCharacters
  }

  const characterAtPoint = getRightCharacterForBufferPosition(editor, point)
  const nonWordRegex = new RegExp(`[${escapeRegExp(nonWordCharacters)}]+`)

  if (/\s/.test(characterAtPoint)) {
    kind = 'white-space'
    wordRegex = new RegExp('[\\t ]+')
  } else if (nonWordRegex.test(characterAtPoint) && !wordRegex.test(characterAtPoint)) {
    kind = 'non-word'
    if (singleNonWordChar) {
      wordRegex = new RegExp(escapeRegExp(characterAtPoint))
    } else {
      wordRegex = nonWordRegex
    }
  } else {
    kind = 'word'
  }

  const range = getWordBufferRangeAtBufferPosition(editor, point, wordRegex)
  return {kind, range}
}

function getWordPatternAtBufferPosition (editor: EditorModel, point: PointLike, options: WordOptions = {}): RegExp {
  const {boundarizeForWord = true} = options
  delete options.boundarizeForWord
  const {range, kind} = getWordBufferRangeAndKindAtBufferPosition(editor, point, options)
  const text = editor.getTextInBufferRange(range)
  let pattern = escapeRegExp(text)

  if (kind === 'word' && boundarizeForWord) {
    // Set word-boundary( \b ) anchor only when it's effective #689
    const startBoundary = /^\w/.test(text) ? '\\b' : ''
    const endBoundary = /\w$/.test(text) ? '\\b' : ''
    pattern = startBoundary + pattern + endBoundary
  }
  return new RegExp(pattern, 'g')
}

function getSubwordPatternAtBufferPosition (editor: EditorModel, point: PointLike, _options: WordOptions = {}): RegExp {
  return getWordPatternAtBufferPosition(editor, point, {
    wordRegex: editor.getLastCursor().subwordRegExp(),
    boundarizeForWord: false
  })
}

// Return options used for getWordBufferRangeAtBufferPosition
function buildWordPatternByCursor (cursor: Cursor, wordRegex: RegExp | undefined): {wordRegex: RegExp, nonWordCharacters: string} {
  const nonWordCharacters = getNonWordCharactersForCursor(cursor)
  if (wordRegex == null) wordRegex = new RegExp(`^[\t ]*$|[^\\s${escapeRegExp(nonWordCharacters)}]+`)
  return {wordRegex, nonWordCharacters}
}

function getWordBufferRangeAtBufferPosition (editor: EditorModel, from: PointLike, regex: RegExp): Range {
  const options = {from, allowNextLine: false, contains: true}
  const end = findInEditor(editor, 'forward', regex, options, event => event.range.end) || options.from
  options.from = end
  const start = findInEditor(editor, 'backward', regex, options, event => event.range.start) || options.from

  return new Range(start, end)
}

// When range is linewise range, range end have column 0 of NEXT row.
// This function adjust range.end to EOL of selected line.
function shrinkRangeEndToBeforeNewLine (range: Range): Range {
  return range.end.column === 0
    ? new Range(range.start, [limitNumber(range.end.row - 1, {min: range.start.row}), Infinity])
    : range
}

function collectRangeByScan (editor: EditorModel, regex: RegExp, options?: {scanRange?: RangeLike, row?: number}): Range[] {
  const result: Range[] = []
  const collect = (event: ScanMatchResult) => result.push(event.range)

  if (!options) {
    editor.scan(regex, collect)
  } else {
    const scanRange = options.scanRange || editor.bufferRangeForBufferRow(options.row as number)
    editor.scanInBufferRange(regex, scanRange, collect)
  }
  return result
}

// take bufferPosition
function translatePointAndClip (editor: EditorModel, pointArg: PointLike, direction: 'forward' | 'backward'): Point {
  let point: Point = Point.fromObject(pointArg)

  let dontClip = false
  switch (direction) {
    case 'forward': {
      point = point.translate([0, +1])
      const eol = editor.bufferRangeForBufferRow(point.row).end

      if (point.isGreaterThanOrEqual(eol)) {
        dontClip = true // FIXME I think it's not necessary need re-think
        if (point.isGreaterThan(eol)) {
          point = point.traverse([1, 0]) // move to start of next row.
        }
      }
      point = Point.min(point, editor.getEofBufferPosition())
      break
    }

    case 'backward':
      point = point.translate([0, -1])

      if (point.column < 0) {
        dontClip = true
        const newRow = point.row - 1
        point = new Point(newRow, editor.bufferRangeForBufferRow(newRow).end.column)
      }

      point = Point.max(point, Point.ZERO)
      break
  }

  return dontClip
    ? point
    : editor.bufferPositionForScreenPosition(editor.screenPositionForBufferPosition(point, {clipDirection: direction}))
}

function getRangeByTranslatePointAndClip (editor: EditorModel, range: Range, which: 'start' | 'end', direction: 'forward' | 'backward'): Range | undefined {
  const newPoint = translatePointAndClip(editor, range[which], direction)
  switch (which) {
    case 'start':
      return new Range(newPoint, range.end)
    case 'end':
      return new Range(range.start, newPoint)
  }
}

function getPackage (_name: string): never {
  throw new Error('vim: getPackage not ported (Atom package system)')
}

function searchByProjectFind (_editor: EditorModel, _text: string): never {
  throw new Error('vim: searchByProjectFind not ported (project-find)')
}

function limitNumber (number: number, {max, min}: {max?: number, min?: number} = {}): number {
  if (max != null) number = Math.min(number, max)
  if (min != null) number = Math.max(number, min)
  return number
}

function findRangeContainsPoint (ranges: Range[], point: PointLike): Range | undefined {
  return ranges.find(range => range.containsPoint(point))
}

const negateFunction = <A extends any[]>(fn: (...args: A) => unknown) => (...args: A): boolean => !fn(...args)

const isEmpty = (target: {isEmpty(): boolean}): boolean => target.isEmpty()
const isNotEmpty = negateFunction(isEmpty)

const isSingleLineRange = (range: Range): boolean => range.isSingleLine()
const isNotSingleLineRange = negateFunction(isSingleLineRange)

const isLeadingWhiteSpaceRange = (editor: EditorModel, range: Range): boolean => {
  return range.start.column === 0 && /^[\t ]*$/.test(editor.getTextInBufferRange(range))
}
const isNotLeadingWhiteSpaceRange = negateFunction(isLeadingWhiteSpaceRange)

function isEscapedCharRange (editor: EditorModel, range: RangeLike): boolean {
  range = Range.fromObject(range)
  const chars = getLeftCharacterForBufferPosition(editor, range.start, 2)
  return chars.endsWith('\\') && !chars.endsWith('\\\\')
}

function insertTextAtBufferPosition (editor: EditorModel, point: PointLike, text: string): Range {
  return editor.setTextInBufferRange([point, point], text)
}

function ensureEndsWithNewLineForBufferRow (editor: EditorModel, row: number): void {
  if (!isEndsWithNewLineForBufferRow(editor, row)) {
    const eol = getEndOfLineForBufferRow(editor, row)
    insertTextAtBufferPosition(editor, eol, '\n')
  }
}

function toggleCaseForCharacter (char: string): string {
  const charLower = char.toLowerCase()
  return charLower === char ? char.toUpperCase() : charLower
}

function splitTextByNewLine (text: string): string[] {
  return text.endsWith('\n') ? text.trimRight().split(/\r?\n/g) : text.split(/\r?\n/g)
}

function replaceDecorationClassBy (decoration: any, fn: (cls: string) => string): void {
  // TODO(vim-ts): tighten — Decoration model not typed here.
  const props = decoration.getProperties()
  decoration.setProperties(Object.assign(props, {class: fn(props.class)}))
}

// Modify range used for undo/redo flash highlight to make it feel naturally for human.
//  - Trim starting new line("\n")
//     "\nabc" -> "abc"
//  - If range.end is EOL extend range to first column of next line.
//     "abc" -> "abc\n"
// e.g.
// - when 'c' is atEOL: "\nabc" -> "abc\n"
// - when 'c' is NOT atEOL: "\nabc" -> "abc"
//
// So always trim initial "\n" part range because flashing trailing line is counterintuitive.
function humanizeNewLineForBufferRange (editor: EditorModel, range: Range): Range {
  range = range.copy()
  if (isSingleLineRange(range) || isLinewiseRange(range)) return range

  if (pointIsAtEndOfLine(editor, range.start)) range.start = range.start.traverse([1, 0])
  if (pointIsAtEndOfLine(editor, range.end)) range.end = range.end.traverse([1, 0])
  return range
}

// [TODO] Improve further by checking oldText, newText?
// [Purpose of this function]
// Suppress flash when undo/redoing toggle-comment while flashing undo/redo of occurrence operation.
// This huristic approach never be perfect.
// Ultimately cannnot distinguish occurrence operation.
function isMultipleAndAllRangeHaveSameColumnAndConsecutiveRows (ranges: Range[]): boolean {
  if (ranges.length <= 1) {
    return false
  }

  const {start: {column: startColumn}, end: {column: endColumn}} = ranges[0]
  let previousRow: number | undefined

  for (const range of ranges) {
    const {start, end} = range
    if (start.column !== startColumn || end.column !== endColumn) return false
    if (previousRow != null && previousRow + 1 !== start.row) return false
    previousRow = start.row
  }
  return true
}

// Expand range to white space
//  1. Expand to forward direction, if suceed return new range.
//  2. Expand to backward direction, if succeed return new range.
//  3. When faild to expand either direction, return original range.
function expandRangeToWhiteSpaces (editor: EditorModel, range: Range): Range {
  const newEnd = findPoint(editor, 'forward', /\S/, 'start', {from: range.end, allowNextLine: false})
  if (newEnd) return new Range(range.start, newEnd)

  const newStart = findPoint(editor, 'backward', /\S/, 'end', {from: range.start, allowNextLine: false})
  if (newStart) return new Range(newStart, range.end)

  return range // fallback
}

// Return list of argument token.
// Token is object like {text: String, type: String}
// type should be "separator" or "argument"
interface ArgumentToken { text: string, type: string | null }
function splitArguments (text: string, joinSpaceSeparatedToken = true): ArgumentToken[] {
  const separatorChars = '\t, \r\n'
  const quoteChars = '"\'`'
  const closeCharToOpenChar: Record<string, string> = {
    ')': '(',
    '}': '{',
    ']': '['
  }
  const closePairChars = Object.keys(closeCharToOpenChar).join('')
  const openPairChars = Object.values(closeCharToOpenChar).join('')
  const escapeChar = '\\'

  let pendingToken = ''
  let inQuote = false
  let isEscaped = false
  let allTokens: ArgumentToken[] = []
  let currentSection: string | null = null

  // Parse text as list of tokens which is commma separated or white space separated.
  // e.g. 'a, fun1(b, c), d' => ['a', 'fun1(b, c), 'd']
  // Not perfect. but far better than simple string split by regex pattern.
  // let allTokens = []
  // let currentSection

  function settlePending () {
    if (pendingToken) {
      allTokens.push({text: pendingToken, type: currentSection})
      pendingToken = ''
    }
  }

  function changeSection (newSection: string): void {
    if (currentSection !== newSection) {
      if (currentSection) settlePending()
      currentSection = newSection
    }
  }

  const pairStack: string[] = []
  for (const char of text) {
    if (pairStack.length === 0 && separatorChars.includes(char)) {
      changeSection('separator')
    } else {
      changeSection('argument')
      if (isEscaped) {
        isEscaped = false
      } else if (char === escapeChar) {
        isEscaped = true
      } else if (inQuote) {
        if (quoteChars.includes(char) && getLast(pairStack) === char) {
          inQuote = false
          pairStack.pop()
        }
      } else if (quoteChars.includes(char)) {
        inQuote = true
        pairStack.push(char)
      } else if (openPairChars.includes(char)) {
        pairStack.push(char)
      } else if (closePairChars.includes(char)) {
        if (getLast(pairStack) === closeCharToOpenChar[char]) pairStack.pop()
      }
    }
    pendingToken += char
  }
  settlePending()

  if (joinSpaceSeparatedToken && allTokens.some(({type, text}) => type === 'separator' && text.includes(','))) {
    // When some separator contains `,` treat white-space separator as just part of token.
    // So we move white-space only sparator into tokens by joining mis-separatoed tokens.
    const newAllTokens: ArgumentToken[] = []
    while (allTokens.length) {
      const token = allTokens.shift()!
      switch (token.type) {
        case 'argument':
          newAllTokens.push(token)
          break
        case 'separator':
          if (token.text.includes(',')) {
            newAllTokens.push(token)
          } else {
            // 1. Concatnate white-space-separator and next-argument
            // 2. Then join into latest argument
            const lastArg = newAllTokens.length ? newAllTokens.pop()! : {text: '', type: 'argument'}
            lastArg.text += token.text + (allTokens.length ? allTokens.shift()!.text : '') // concat with next-token
            newAllTokens.push(lastArg)
          }
          break
      }
    }
    allTokens = newAllTokens
  }
  return allTokens
}

// Safe translation for point.
// Unless both point and translation was provided, it return passed point.
// So when you pass null as point, just return null.
function safeTranslatePoint (point: Point | null | undefined, translation: PointLike | null | undefined): Point | null | undefined {
  return point && translation ? point.translate(translation) : point
}

// Retern copied object without having passed props
function exceptProps<T extends Record<string, any>> (object: T, props: string[] = []): T {
  object = Object.assign({}, object) // shallow copy
  for (const prop of props) {
    delete object[prop]
  }
  return object
}

// * Options
//   * contains: {Boolean} default `false`
//   * allowNextLine: {Boolean} defualt `true`
//   * skipEmptyRow: {Boolean} skip completely empty row
//   * skipWhiteSpaceOnlyRow: {Boolean} skip non-empty but white-space contain row
function scanEditor (editor: EditorModel, direction: ScanDirection, regex: RegExp, options: ScanOptions, fn: (event: ScanMatchResult) => void): void {
  let {from, scanRange} = options
  if (!from && !scanRange) throw new Error("You must 'from' or 'scanRange' options")
  const {contains, allowNextLine = true, skipEmptyRow, skipWhiteSpaceOnlyRow} = options
  if (contains && !from) throw new Error("You must pass 'from' to check 'contains'")

  if (from) from = Point.fromObject(from)
  let scanFunction: 'scanInBufferRange' | 'backwardsScanInBufferRange'
  switch (direction) {
    case 'forward':
    case 'next':
      if (!scanRange) scanRange = [from as PointLike, getVimEofBufferPosition(editor)] as RangeLike
      scanFunction = 'scanInBufferRange'
      break
    case 'backward':
    case 'previous':
      if (!scanRange) scanRange = [[0, 0], from as PointLike] as RangeLike
      scanFunction = 'backwardsScanInBufferRange'
      break
  }

  editor[scanFunction](regex, scanRange as RangeLike, event => {
    const {range, matchText, stop} = event
    if (!allowNextLine && range.start.row !== (from as Point).row) {
      stop()
      return
    }

    // Ignore 'empty line' matches between '\r' and '\n'
    if (matchText === '' && range.start.column !== 0) return

    if (skipEmptyRow && !matchText) return
    if (skipWhiteSpaceOnlyRow && matchText && !/\S+/.test(matchText)) return
    if (contains && !range.containsPoint(from as PointLike)) return

    fn(event)
  })
}

// Once callback retuned truthy value, it stop scannning, and return returned truthy value.
// Benefit of this function is
//  - No need to call stop()
//  - No need to use temporal variable to extract found var from callback.
//  - Whatever value you can return(range, point, whatever you returned truthy value)
function findInEditor<T> (editor: EditorModel, direction: ScanDirection, regex: RegExp, options: ScanOptions, fn: (event: ScanMatchResult) => T): T | undefined {
  let result: T | undefined
  scanEditor(editor, direction, regex, options, event => {
    result = fn(event)
    if (result) {
      event.stop()
    }
  })
  // This guard avoid return `falthy` value when && or || short circuit expression was used in callback.
  if (result) return result
}

// Find point which matches regex.
//   Returns {Point} bufferPosition of start or end of regex matched range
//
// * Options
//  * from: {Point} BufferPosition to start search from
//  * regex: {RegExp}
//  * preTranslate: {Point} translation against from before start search
//  * postTranslate: {Point} translation against found point.
//  * Plus scan options supported by scanEditor()
function findPoint (editor: EditorModel, direction: ScanDirection, regex: RegExp, which: 'start' | 'end', options: ScanOptions & {preTranslate?: PointLike, postTranslate?: PointLike}): Point | null | undefined {
  const pointCompareMethod = ['next', 'forward'].includes(direction) ? 'isGreaterThan' : 'isLessThan'
  const {preTranslate, postTranslate} = options
  const from = editor.clipBufferPosition(safeTranslatePoint(options.from as Point, preTranslate) as PointLike)
  const scanOptions = exceptProps(options, ['preTranslate', 'postTranslate'])
  scanOptions.from = from

  const point = findInEditor(editor, direction, regex, scanOptions, event => {
    const pointToCompare = event.range[which]
    return (pointToCompare[pointCompareMethod](from) && pointToCompare) as Point | false
  })
  return safeTranslatePoint(point || undefined, postTranslate)
}

function adjustIndentWithKeepingLayout (editor: EditorModel, range: Range): void {
  // Adjust indentLevel with keeping original layout of pasting text.
  // Suggested indent level of range.start.row is correct as long as range.start.row have minimum indent level.
  // But when we paste following already indented three line text, we have to adjust indent level
  //  so that `varFortyTwo` line have suggestedIndentLevel.
  //
  //        varOne: value # suggestedIndentLevel is determined by this line
  //   varFortyTwo: value # We need to make final indent level of this row to be suggestedIndentLevel.
  //      varThree: value
  //
  // So what we are doing here is apply suggestedIndentLevel with fixing issue above.
  // 1. Determine minimum indent level among pasted range(= range ) excluding empty row
  // 2. Then update indentLevel of each rows to final indentLevel of minimum-indented row have suggestedIndentLevel.
  const suggestedLevel = editor.suggestedIndentForBufferRow(range.start.row)
  const rowAndActualLevels: [number, number][] = []
  let minLevel: number | undefined

  for (const row of getList(range.start.row, range.end.row, false)) {
    if (isEmptyRow(editor, row)) continue
    const actualLevel = editor.indentationForBufferRow(row)
    rowAndActualLevels.push([row, actualLevel])
    minLevel = minLevel == null ? actualLevel : Math.min(minLevel, actualLevel)
  }
  if (minLevel == null) return

  const deltaToSuggestedLevel = suggestedLevel - minLevel
  if (deltaToSuggestedLevel) {
    for (const [row, actualLevel] of rowAndActualLevels) {
      // TODO(vim-ts): tighten — setIndentationForBufferRow not yet on EditorModel.
      (editor as any).setIndentationForBufferRow(row, actualLevel + deltaToSuggestedLevel)
    }
  }
}

// Check point containment with end position exclusive
function rangeContainsPointWithEndExclusive (range: Range, point: PointLike): boolean {
  return range.start.isLessThanOrEqual(point) && range.end.isGreaterThan(point)
}

function traverseTextFromPoint (point: PointLike, text: string): Point {
  return Point.fromObject(point).traverse(getTraversalForText(text))
}

function getTraversalForText (text: string): Point {
  NEWLINE_REG_EXP.lastIndex = 0

  let row = 0
  let lastIndex = 0
  while (NEWLINE_REG_EXP.exec(text)) {
    row++
    lastIndex = NEWLINE_REG_EXP.lastIndex
  }
  return new Point(row, text.length - lastIndex)
}

function getRowAmongFoldedRowIntersectsBufferRow (editor: any, bufferRow: number, which: 'min' | 'max'): number {
  // TODO(vim-ts): tighten — displayLayer.foldsMarkerLayer not modeled on EditorModel.
  const bufferRange = editor.bufferRangeForBufferRow(bufferRow)
  const markers = editor.displayLayer.foldsMarkerLayer.findMarkers({intersectsRange: bufferRange})
  if (!markers.length) {
    throw new Error('getRowAmongFoldedRowIntersectsBufferRow() called for non-folded bufferRow!')
  }
  const ranges = markers.map((marker: any) => marker.getRange())
  return which === 'min'
    ? Math.min(...ranges.map((range: any) => range.start.row))
    : Math.max(...ranges.map((range: any) => range.end.row))
}

// Return min row among folds intersecting screenRow of bufferRow if bufferRow was folded.
function getFoldStartRowForRow (editor: EditorModel, row: number): number {
  return editor.isFoldedAtBufferRow(row) ? getRowAmongFoldedRowIntersectsBufferRow(editor, row, 'min') : row
}

// Return max row among folds intersecting screenRow of bufferRow if bufferRow was folded.
function getFoldEndRowForRow (editor: EditorModel, row: number): number {
  return editor.isFoldedAtBufferRow(row) ? getRowAmongFoldedRowIntersectsBufferRow(editor, row, 'max') : row
}

function doesRangeStartAndEndWithSameIndentLevel (editor: EditorModel, range: Range): boolean {
  return editor.indentationForBufferRow(range.start.row) === editor.indentationForBufferRow(range.end.row)
}

function getList (start: number, end: number, inclusive = true): number[] {
  const range: number[] = []
  if (start < end) {
    if (inclusive) for (let i = start; i <= end; i++) range.push(i)
    else for (let i = start; i < end; i++) range.push(i)
  } else {
    if (inclusive) for (let i = start; i >= end; i--) range.push(i)
    else for (let i = start; i > end; i--) range.push(i)
  }
  return range
}

function unindent (text: string): string {
  let indentLength: number
  const lines = text.split(/\n/)
  const minIndent = lines.reduce((maxIndentLength, line) => {
    indentLength = line === '' ? maxIndentLength : line.match(/^ */)![0].length
    return Math.min(indentLength, maxIndentLength)
  }, Infinity)
  return lines.map(line => line.slice(minIndent)).join('\n')
}

// function convertTabToSpace (text, tabLength) {
//   return text.replace(/^[\t ]+/gm, text => text.replace(/\t/g, ' '.repeat(tabLength)))
// }
//
// function convertSpaceToTab (text, tabLength) {
//   return text.replace(/^ +/gm, s => {
//     const tabs = '\t'.repeat(Math.floor(s.length / tabLength))
//     const spaces = ' '.repeat(s.length % tabLength)
//     return tabs + spaces
//   })
// }

function removeIndent (text: string, removeFirstAndLastLine = true): string {
  let indentLength: number
  const lines = text.split(/\n/)
  if (removeFirstAndLastLine) {
    lines.shift()
    lines.pop()
  }

  const minIndent = lines.reduce((maxIndentLength, line) => {
    indentLength = line === '' ? maxIndentLength : line.match(/^ */)![0].length
    return Math.min(indentLength, maxIndentLength)
  }, Infinity)

  return lines.map(line => line.slice(minIndent)).join('\n')
}

function detectMinimumIndentLengthInText (text: string): number {
  let indentLength: number
  const lines = text.split(/\n/)

  const minIndent = lines.reduce((maxIndentLength, line) => {
    indentLength = line === '' ? maxIndentLength : line.match(/^ */)![0].length
    return Math.min(indentLength, maxIndentLength)
  }, Infinity)

  return minIndent === Infinity ? 0 : minIndent
}

// FIXME: really, this is garbage.
function normalizeIndent (text: string, editor: EditorModel, targetRange: RangeLike): string {
  // text = convertTabToSpace(text, editor.getTabLength())
  const mapEachLine = (text: string, fn: (line: string) => string) =>
    text
      .split(/\n/)
      .map(fn)
      .join('\n')

  // Remove indent
  const minIndent = detectMinimumIndentLengthInText(text)
  text = mapEachLine(text, line => line.slice(minIndent))

  // Detect indent string from existing range
  const indentString = ' '.repeat(detectMinimumIndentLengthInText(editor.getTextInBufferRange(targetRange)))

  // Add indent
  text = mapEachLine(text, line => (line ? indentString : '') + line)

  // text = text.replace(/^/gm, indentString)

  // console.log(text);
  // text = convertSpaceToTab(text)
  return text
}

function atomVersionSatisfies (_condition: string): boolean {
  // No Atom version gate in quilx; treat all version checks as satisfied.
  return true
}

function getRowRangeForCommentAtBufferRow (editor: any, row: number): [number, number] | undefined {
  // TODO(vim-ts): tighten — tokenizedBuffer.isRowCommented not modeled on EditorModel.
  const isRowCommented = (row: number) => editor.tokenizedBuffer.isRowCommented(row)
  if (!isRowCommented(row)) return

  let startRow = row
  let endRow = row

  while (isRowCommented(startRow - 1)) startRow--
  while (isRowCommented(endRow + 1)) endRow++

  return [startRow, endRow]
}

function getHunkRangeAtBufferRow (editor: EditorModel, row: number): Range | undefined {
  const hunkChar = editor.lineTextForBufferRow(row)[0]
  if (hunkChar && (hunkChar === '+' || hunkChar === '-')) {
    const isHunkRow = (row: number) => {
      const lineText = editor.lineTextForBufferRow(row)
      return lineText && lineText[0] === hunkChar
    }

    let [startRow, endRow] = [row, row]

    while (isHunkRow(startRow - 1)) startRow--
    while (isHunkRow(endRow + 1)) endRow++

    return new Range([startRow, 0], [endRow, Infinity])
  }
}

// Replace given text by character based diff
// Purpose: to minimize amount of range to be replaced, which lead cleaner flash highlight
// On undo/redo highlight
function replaceTextInRangeViaDiff (editor: EditorModel, range: Range, newText: string): void {
  let row = range.start.row
  let column = range.start.column
  const point: [number, number] = [0, 0]

  const oldText = editor.getTextInBufferRange(range)
  const changes = diffChars(oldText, newText)
  editor.transact(() => {
    for (const change of changes) {
      point[0] = row
      point[1] = column

      if (change.added) {
        const newPoint = editor.setTextInBufferRange([point, point], change.value).end
        row = newPoint.row
        column = newPoint.column
      } else if (change.removed) {
        editor.setTextInBufferRange([point, [row, column + (change.count as number)]], '')
      } else {
        const newPoint = traverseTextFromPoint(point, change.value)
        row = newPoint.row
        column = newPoint.column
      }
    }
  })
}

const sortByFallback = (rowA: string, rowB: string): number => rowA.localeCompare(rowB, {sensitivity: 'base'} as any)

function changeArrayOrder<T> (array: T[], action: string, sortBy?: (a: T, b: T) => number): T[] | undefined {
  if (array.length < 2) {
    return array
  }

  switch (action) {
    case 'reverse':
      return array.slice().reverse()
    case 'sort':
      return array.slice().sort(sortBy || (sortByFallback as unknown as (a: T, b: T) => number))
    case 'rotate-right':
      return array.slice(1).concat(array[0])
    case 'rotate-left':
      return array.slice(-1).concat(array.slice(0, -1))
    case 'ramdomize':
      return shuffleArray(array)
  }
}

// Borrowed from
// https://stackoverflow.com/questions/2450954/how-to-randomize-shuffle-a-javascript-array
function shuffleArray<T> (array: T[]): T[] {
  let currentIndex = array.length
  let temporaryValue: T, randomIndex: number

  // While there remain elements to shuffle...
  while (currentIndex !== 0) {
    randomIndex = Math.floor(Math.random() * currentIndex)
    currentIndex -= 1

    temporaryValue = array[currentIndex]
    array[currentIndex] = array[randomIndex]
    array[randomIndex] = temporaryValue
  }
  return array
}

function changeCharOrder (text: string, action: string): string {
  return changeArrayOrder(text.split(''), action)!.join('')
}

function isUsingTreeSitter (editor: any): boolean {
  // TODO(vim-ts): tighten — languageMode not modeled on EditorModel.
  return !!(editor.languageMode && editor.languageMode.tree)
}

export {
  assertWithException,
  getLast,
  getKeyBindingForCommand,
  debug,
  saveEditorState,
  isLinewiseRange,
  sortRanges,
  sortCursors,
  sortPoints,
  getIndex,
  getVisibleBufferRange,
  getVisibleEditors,
  pointIsAtEndOfLine,
  pointIsAtWhiteSpace,
  pointIsAtNonWhiteSpace,
  pointIsAtEndOfLineAtNonEmptyRow,
  pointIsAtVimEndOfFile,
  getVimEofBufferPosition,
  getVimEofScreenPosition,
  getVimLastBufferRow,
  getVimLastScreenRow,
  setBufferRow,
  translateColumnOnHardTabEditor,
  setBufferColumn,
  moveCursorLeft,
  moveCursorRight,
  moveCursorUpScreen,
  moveCursorDownScreen,
  getEndOfLineForBufferRow,
  getValidVimBufferRow,
  getValidVimScreenRow,
  moveCursorToFirstCharacterAtRow,
  getLineTextToBufferPosition,
  getTextInScreenRange,
  isEmptyRow,
  getCodeFoldRanges,
  getCodeFoldRangesContainesRow,
  getClosestFoldRangeContainsRow,
  getFoldInfoByKind,
  getBufferRangeForRowRange,
  trimBufferRange,
  getFirstCharacterPositionForBufferRow,
  getScreenPositionForScreenRow,
  isIncludeFunctionScopeForRow,
  getRows,
  findParentNodeForFunctionType,
  findFunctionBodyNode,
  smartScrollToBufferPosition,
  matchScopes,
  isSingleLineText,
  getWordBufferRangeAtBufferPosition,
  getWordBufferRangeAndKindAtBufferPosition,
  getWordPatternAtBufferPosition,
  getSubwordPatternAtBufferPosition,
  getNonWordCharactersForCursor,
  shrinkRangeEndToBeforeNewLine,
  collectRangeByScan,
  translatePointAndClip,
  getRangeByTranslatePointAndClip,
  getPackage,
  searchByProjectFind,
  limitNumber,
  findRangeContainsPoint,

  isEmpty,
  isNotEmpty,
  isSingleLineRange,
  isNotSingleLineRange,

  insertTextAtBufferPosition,
  ensureEndsWithNewLineForBufferRow,
  isLeadingWhiteSpaceRange,
  isNotLeadingWhiteSpaceRange,
  isEscapedCharRange,

  toggleCaseForCharacter,
  splitTextByNewLine,
  replaceDecorationClassBy,
  humanizeNewLineForBufferRange,
  isMultipleAndAllRangeHaveSameColumnAndConsecutiveRows,
  expandRangeToWhiteSpaces,
  splitArguments,
  safeTranslatePoint,
  exceptProps,
  scanEditor,
  findInEditor,
  findPoint,
  adjustIndentWithKeepingLayout,
  rangeContainsPointWithEndExclusive,
  traverseTextFromPoint,
  getFoldStartRowForRow,
  getFoldEndRowForRow,
  doesRangeStartAndEndWithSameIndentLevel,
  getList,
  unindent,
  removeIndent,
  normalizeIndent,
  atomVersionSatisfies,
  getRowRangeForCommentAtBufferRow,
  getHunkRangeAtBufferRow,
  replaceTextInRangeViaDiff,
  changeCharOrder,
  changeArrayOrder,
  isUsingTreeSitter
}
