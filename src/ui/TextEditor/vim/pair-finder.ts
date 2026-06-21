// Vendored from xedel/vim-mode-plus's lib/pair-finder.js — ESM conversion;
// underscore-plus's `partition`/`escapeRegExp` are inlined.
import { Range } from '../../../text/Range.ts'
import { Point } from '../../../text/Point.ts'
import type { EditorModel, ScanMatchResult } from '../EditorModel.ts'
import { isEscapedCharRange, collectRangeByScan, scanEditor, getLineTextToBufferPosition } from './utils.ts'

// 'open'/'close' classification of a scanned bracket/quote/tag occurrence.
type PairSide = 'open' | 'close'

// State tracked for a single scanned pair occurrence.
interface EventState {
  state: PairSide | undefined
  range: Range
  // TagFinder also records the tag name.
  name?: string
}

// Result of a successful pair match.
interface PairInfo {
  aRange: Range
  innerRange: Range
  openRange: Range
  closeRange: Range
}

interface CharacterRangeInformation {
  total: Range[]
  left: Range[]
  right: Range[]
  balanced: boolean
}

interface ScopeStateValue {
  inString: boolean
  inComment: boolean
  inDoubleQuotes: boolean
}

interface PairFinderOptions {
  allowNextLine?: boolean
  allowForwarding?: boolean
  pair?: [string, string]
  inclusive?: boolean
}

const escapeRegExp = (s: string): string => (s ? s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') : '')
const partition = <T>(array: T[], predicate: (element: T) => boolean): [T[], T[]] => {
  const pass: T[] = []
  const fail: T[] = []
  for (const element of array) (predicate(element) ? pass : fail).push(element)
  return [pass, fail]
}

function getCharacterRangeInformation (editor: EditorModel, point: Point, char: string): CharacterRangeInformation {
  const regex = new RegExp(escapeRegExp(char), 'g')
  const total = collectRangeByScan(editor, regex, {row: point.row}).filter(range => !isEscapedCharRange(editor, range))
  const [left, right] = partition(total, ({start}) => start.isLessThan(point))
  const balanced = total.length % 2 === 0
  return {total, left, right, balanced}
}

class ScopeState {
  editor: EditorModel
  state: ScopeStateValue

  constructor (editor: EditorModel, point: Point) {
    this.editor = editor
    this.state = this.getScopeStateForBufferPosition(point)
  }

  getScopeStateForBufferPosition (point: Point): ScopeStateValue {
    const scopes = this.editor.scopeDescriptorForBufferPosition(point).getScopesArray()
    return {
      inString: scopes.some(scope => scope.startsWith('string.')),
      inComment: scopes.some(scope => scope.startsWith('comment.')),
      inDoubleQuotes: this.isInDoubleQuotes(point)
    }
  }

  isInDoubleQuotes (point: Point): boolean {
    const {total, left, balanced} = getCharacterRangeInformation(this.editor, point, '"')
    return total.length > 0 && balanced && left.length % 2 === 1
  }

  isEqual (other: ScopeState): boolean {
    return (
      this.state.inString === other.state.inString &&
      this.state.inComment === other.state.inComment &&
      this.state.inDoubleQuotes === other.state.inDoubleQuotes
    )
  }

  isInNormalCodeArea (): boolean {
    return !(this.state.inString || this.state.inComment || this.state.inDoubleQuotes)
  }
}

class PairFinder {
  editor: EditorModel
  allowNextLine: boolean | undefined
  allowForwarding: boolean | undefined
  pair: [string, string] | undefined
  inclusive: boolean
  pattern!: RegExp
  closeRange?: Range | null

  constructor (editor: EditorModel, {allowNextLine, allowForwarding, pair, inclusive = true}: PairFinderOptions = {}) {
    this.editor = editor
    this.allowNextLine = allowNextLine
    this.allowForwarding = allowForwarding
    this.pair = pair
    this.inclusive = inclusive
    if (this.pair) this.setPatternForPair(this.pair)
  }

  // Overridden by subclasses to build `this.pattern` from the pair.
  setPatternForPair (_pair: [string, string]): void {}

  // Overridden by subclasses to classify a scan event.
  getEventState (_event: ScanMatchResult): EventState {
    return {state: undefined, range: (_event as ScanMatchResult).range}
  }

  getPattern (): RegExp {
    return this.pattern
  }

  filterEvent (_event?: ScanMatchResult): boolean {
    return true
  }

  findPair (which: PairSide, direction: 'forward' | 'backward', from: Point): Range | undefined {
    const stack: EventState[] = []
    let found: Range | undefined

    // Quote is not nestable. So when we encounter 'open' while finding 'close',
    // it is forwarding pair, so stoppable unless @allowForwarding
    const findingNonForwardingClosingQuote = this instanceof QuoteFinder && which === 'close' && !this.allowForwarding
    const {allowNextLine} = this
    scanEditor(this.editor, direction, this.getPattern(), {from, allowNextLine}, event => {
      const {range, stop} = event

      if (isEscapedCharRange(this.editor, range)) return
      if (!this.filterEvent(event)) return
      const eventState = this.getEventState(event)

      if (findingNonForwardingClosingQuote && eventState.state === 'open' && range.start.isGreaterThan(from)) {
        stop()
        return
      }

      if (eventState.state !== which) {
        stack.push(eventState)
      } else if (this.onFound(stack, {eventState, from})) {
        found = range
        return stop()
      }
    })

    return found
  }

  spliceStack (stack: EventState[], _eventState: EventState): EventState | undefined {
    return stack.pop()
  }

  onFound (stack: EventState[], {eventState, from}: {eventState: EventState, from: Point}): boolean | undefined {
    switch (eventState.state) {
      case 'open':
        this.spliceStack(stack, eventState)
        return stack.length === 0
      case 'close': {
        const openState = this.spliceStack(stack, eventState)
        if (!openState) return this.inclusive || eventState.range.start.isGreaterThan(from)

        if (!stack.length) {
          const {start} = openState.range
          return this.inclusive
            ? start.isEqual(from) || (this.allowForwarding && start.row === from.row)
            : start.isLessThan(from) || (this.allowForwarding && start.isGreaterThan(from) && start.row === from.row)
        }
      }
    }
  }

  findCloseForward (from: Point): Range | undefined {
    return this.findPair('close', 'forward', from)
  }

  findOpenBackward (from: Point): Range | undefined {
    return this.findPair('open', 'backward', from)
  }

  find (from: Point): PairInfo | undefined {
    const closeRange = (this.closeRange = this.findCloseForward(from))
    const openRange = closeRange ? this.findOpenBackward(closeRange.end) : undefined

    if (openRange && closeRange) {
      return {
        aRange: new Range(openRange.start, closeRange.end),
        innerRange: new Range(openRange.end, closeRange.start),
        openRange,
        closeRange
      }
    }
  }
}

class BracketFinder extends PairFinder {
  retry: boolean
  initialScope?: ScopeState
  closeRangeScope?: ScopeState | null

  constructor (...args: [EditorModel, PairFinderOptions?]) {
    super(...args)
    this.retry = false
  }

  setPatternForPair ([open, close]: [string, string]): void {
    this.pattern = new RegExp(`(${escapeRegExp(open)})|(${escapeRegExp(close)})`, 'g')
  }

  // This method can be called recursively
  find (from: Point): PairInfo | undefined {
    if (!this.initialScope) this.initialScope = new ScopeState(this.editor, from)

    const found = super.find(from)
    if (found) return found

    if (!this.retry) {
      this.retry = true
      this.closeRange = this.closeRangeScope = null
      return this.find(from)
    }
  }

  filterEvent ({range}: ScanMatchResult): boolean {
    const scope = new ScopeState(this.editor, range.start)
    if (!this.closeRange) {
      // Now finding closeRange
      if (!this.retry) {
        return this.initialScope!.isEqual(scope)
      } else {
        return this.initialScope!.isInNormalCodeArea() ? !scope.isInNormalCodeArea() : scope.isInNormalCodeArea()
      }
    } else {
      // Now finding openRange: search from same scope
      if (!this.closeRangeScope) {
        this.closeRangeScope = new ScopeState(this.editor, this.closeRange.start)
      }
      return this.closeRangeScope.isEqual(scope)
    }
  }

  getEventState ({match, range}: ScanMatchResult): EventState {
    let state: PairSide | undefined
    if (match[1]) state = 'open'
    else if (match[2]) state = 'close'
    return {state, range}
  }
}

class QuoteFinder extends PairFinder {
  // `declare` (not a plain field): `quoteChar` is assigned by setPatternForPair,
  // which the *base* PairFinder constructor calls. Node runs this .ts by stripping
  // types, so a real field declaration here would emit `quoteChar = undefined` that
  // runs after super() and clobbers that value — leaving the quote regex empty and
  // breaking every quote text object. `declare` emits no runtime field.
  declare quoteChar: string
  declare pairStates: (PairSide | undefined)[]

  setPatternForPair (pair: [string, string]): void {
    this.quoteChar = pair[0]
    this.pattern = new RegExp(`(${escapeRegExp(pair[0])})`, 'g')
  }

  find (from: Point): PairInfo | undefined {
    // HACK: Cant determine open/close from quote char itself
    // So preset open/close state to get desiable result.
    let nextQuoteIsOpen: boolean
    {
      const {left, balanced} = getCharacterRangeInformation(this.editor, from, this.quoteChar)
      if (balanced) {
        // On a balanced line every quote is paired, so an even number of quotes
        // to the left means the cursor is outside any string and the next quote
        // opens one; odd means we're inside a string and the next quote closes
        // it. Testing `left.length === 0` here mishandled a cursor sitting in the
        // gap between two complete strings (e.g. on the `,` in `'a', 'b'`): with
        // two quotes already to the left it treated the next opening quote as a
        // close and selected the gap instead of seeking forward to the string.
        nextQuoteIsOpen = left.length % 2 === 0
      } else {
        nextQuoteIsOpen = left.length === 0
      }
    }

    this.pairStates = nextQuoteIsOpen ? ['open', 'close', 'close', 'open'] : ['close', 'close', 'open']

    return super.find(from)
  }

  getEventState ({range}: ScanMatchResult): EventState {
    return {state: this.pairStates.shift(), range}
  }
}

const TAG_REGEX = /<(\/?)([^\s>]+)[^>]*>/g

class TagFinder extends PairFinder {
  static get pattern (): RegExp {
    return TAG_REGEX
  }

  constructor (...args: [EditorModel, PairFinderOptions?]) {
    super(...args)
    this.pattern = TAG_REGEX
  }

  lineTextToPointContainsNonWhiteSpace (point: Point): boolean {
    return /\S/.test(getLineTextToBufferPosition(this.editor, point))
  }

  find (from: Point): PairInfo | undefined {
    const found = super.find(from)
    if (found && this.allowForwarding) {
      const tagStart = found.aRange.start
      if (tagStart.isGreaterThan(from) && this.lineTextToPointContainsNonWhiteSpace(tagStart)) {
        // We found range but also found that we are IN another tag,
        // so will retry by excluding forwarding range.
        this.allowForwarding = false
        return this.find(from) // retry
      }
    }
    return found
  }

  getEventState (event: ScanMatchResult): EventState {
    const backslash = event.match[1]
    return {
      state: backslash === '' ? 'open' : 'close',
      name: event.match[2],
      range: event.range
    }
  }

  spliceStack (stack: EventState[], eventState: EventState): EventState | undefined {
    const pairEventState = stack
      .slice()
      .reverse()
      .find(state => state.name === eventState.name)
    if (pairEventState) stack.splice(stack.indexOf(pairEventState))
    return pairEventState
  }
}

export default {
  BracketFinder,
  QuoteFinder,
  TagFinder
}
