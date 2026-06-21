// Vendored from xedel/vim-mode-plus's lib/mutation-manager.js — ESM conversion only.
// Tracks cursor/selection positions across an operator's mutation so cursors can
// be restored to the right place afterwards. Logic unchanged.
import { Point } from '../../../text/Point.ts'
import type VimState from './vim-state.ts'
import type { EditorModel } from '../EditorModel.ts'
import type { Selection } from '../Selection.ts'
import type { Range } from '../../../text/Range.ts'
import type { MarkerLayer } from '../MarkerLayer.ts'
import type { Marker } from '../Marker.ts'
import type swrap from './selection-wrapper.ts'

/** A mutation checkpoint tag (e.g. 'will-select', 'did-select', 'did-select-occurrence'). */
type Checkpoint = string

/** Options passed to the `Mutation` constructor. */
interface MutationOptions {
  selection: Selection
  initialPoint: Point
  initialPointMarker: Marker | undefined
  checkpoint: Checkpoint
  swrap: typeof swrap
}

export default class MutationManager {
  vimState: VimState
  editor: EditorModel
  swrap: typeof swrap
  markerLayer: MarkerLayer
  mutationsBySelection: Map<Selection, Mutation>
  stayByMarker?: boolean

  constructor (vimState: VimState) {
    this.vimState = vimState
    this.editor = vimState.editor
    this.swrap = this.vimState.swrap
    this.vimState.onDidDestroy(() => this.destroy())

    this.markerLayer = this.editor.addMarkerLayer()
    this.mutationsBySelection = new Map()
  }

  destroy () {
    this.markerLayer.destroy()
    this.mutationsBySelection.clear()
  }

  init ({stayByMarker}: {stayByMarker: boolean}) {
    this.stayByMarker = stayByMarker
    this.reset()
  }

  reset () {
    this.markerLayer.clear()
    this.mutationsBySelection.clear()
  }

  setCheckpoint (checkpoint: Checkpoint) {
    for (const selection of this.editor.getSelections()) {
      this.setCheckpointForSelection(selection, checkpoint)
    }
  }

  setCheckpointForSelection (selection: Selection, checkpoint: Checkpoint) {
    let resetMarker: boolean

    if (this.mutationsBySelection.has(selection)) {
      // Current non-empty selection is prioritized over existing marker's range.
      // We invalidate old marker to re-track from current selection.
      resetMarker = !selection.getBufferRange().isEmpty()
    } else {
      resetMarker = true

      let initialPointMarker: Marker | undefined
      const initialPoint = this.swrap(selection).getBufferPositionFor('head', {from: ['property', 'selection'] as any})!
      if (this.stayByMarker) {
        initialPointMarker = (this.markerLayer.markBufferPosition as any)(initialPoint, {invalidate: 'never'})
      }
      const options: MutationOptions = {selection, initialPoint, initialPointMarker, checkpoint, swrap: this.swrap}
      this.mutationsBySelection.set(selection, new Mutation(options))
    }

    const marker = resetMarker
      ? (this.markerLayer.markBufferRange as any)(selection.getBufferRange(), {invalidate: 'never'})
      : undefined
    this.mutationsBySelection.get(selection)!.update(checkpoint, marker, this.vimState.mode)
  }

  migrateMutation (oldSelection: Selection, newSelection: Selection) {
    const mutation = this.mutationsBySelection.get(oldSelection)!
    this.mutationsBySelection.delete(oldSelection)
    mutation.selection = newSelection
    this.mutationsBySelection.set(newSelection, mutation)
  }

  getMutatedBufferRangeForSelection (selection: Selection): Range | undefined {
    if (this.mutationsBySelection.has(selection)) {
      return this.mutationsBySelection.get(selection)!.marker!.getBufferRange()
    }
  }

  getSelectedBufferRangesForCheckpoint (checkpoint: Checkpoint): Range[] {
    return [...this.mutationsBySelection.values()]
      .map(mutation => mutation.bufferRangeByCheckpoint[checkpoint])
      .filter(range => range)
  }

  restoreCursorsToInitialPosition () {
    for (const selection of this.editor.getSelections()) {
      const point = this.getInitialPointForSelection(selection)
      if (point) selection.cursor.setBufferPosition(point)
    }
  }

  getInitialPointForSelection (selection: Selection): Point | undefined {
    const mutation = this.mutationsBySelection.get(selection)
    if (mutation && mutation.createdAt === 'will-select') {
      return mutation.initialPoint
    }
  }

  restoreCursorPositions ({stay, wise, setToFirstCharacterOnLinewise}: {stay: boolean; wise: string; setToFirstCharacterOnLinewise?: boolean}) {
    if (wise === 'blockwise') {
      for (const blockwiseSelection of this.vimState.getBlockwiseSelections()) {
        const {head, tail} = blockwiseSelection.getProperties()
        blockwiseSelection.setHeadBufferPosition(stay ? head : Point.min(head, tail))
        blockwiseSelection.skipNormalization()
      }
    } else {
      // Make sure destroying all temporal selection BEFORE starting to set cursors to final position.
      // This is important to avoid destroy order dependent bugs.
      for (const selection of this.editor.getSelections()) {
        const mutation = this.mutationsBySelection.get(selection)
        if (mutation && mutation.createdAt !== 'will-select') {
          selection.destroy()
        }
      }

      for (const selection of this.editor.getSelections()) {
        const mutation = this.mutationsBySelection.get(selection)
        if (!mutation) continue

        let point
        if (stay) {
          point = this.clipPoint(mutation.getStayPosition(wise))
        } else {
          point = this.clipPoint(mutation.startPositionOnDidSelect!)
          if (setToFirstCharacterOnLinewise && wise === 'linewise') {
            point = this.vimState.utils.getFirstCharacterPositionForBufferRow(this.editor, point.row)
          }
        }
        selection.cursor.setBufferPosition(point!)
      }
    }
  }

  clipPoint (point: Point): Point {
    point.row = Math.min(this.vimState.utils.getVimLastBufferRow(this.editor), point.row)
    return this.editor.clipBufferPosition(point)
  }
}

// Mutation information is created even if selection.isEmpty()
// So that we can filter selection by when it was created.
//  e.g. Some selection is created at 'will-select' checkpoint, others at 'did-select' or 'did-select-occurrence'
class Mutation {
  selection: Selection
  initialPoint: Point
  initialPointMarker: Marker | undefined
  swrap: typeof swrap
  createdAt: Checkpoint
  bufferRangeByCheckpoint: Record<Checkpoint, Range>
  marker: Marker | null
  startPositionOnDidSelect: Point | null

  constructor (options: MutationOptions) {
    this.selection = options.selection
    this.initialPoint = options.initialPoint
    this.initialPointMarker = options.initialPointMarker
    this.swrap = options.swrap
    this.createdAt = options.checkpoint

    this.bufferRangeByCheckpoint = {}
    this.marker = null
    this.startPositionOnDidSelect = null
  }

  update (checkpoint: Checkpoint, marker: Marker | undefined, mode: string) {
    if (marker) {
      if (this.marker) this.marker.destroy()
      this.marker = marker
    }
    this.bufferRangeByCheckpoint[checkpoint] = this.marker!.getBufferRange()
    // NOTE: stupidly respect pure-Vim's behavior which is inconsistent.
    // Maybe I'll remove this blindly-following-to-pure-Vim code.
    //  - `V k y`: don't move cursor
    //  - `V j y`: move curor to start of selected line.(Inconsistent!)
    if (checkpoint === 'did-select') {
      const from = mode === 'visual' && !this.selection.isReversed() ? ['selection'] : ['property', 'selection']
      this.startPositionOnDidSelect = this.swrap(this.selection).getBufferPositionFor('start', {from: from as any}) ?? null
    }
  }

  getStayPosition (wise: string): Point {
    const point = (this.initialPointMarker && this.initialPointMarker.getHeadBufferPosition()) || this.initialPoint
    const selectedRange =
      this.bufferRangeByCheckpoint['did-select-occurrence'] || this.bufferRangeByCheckpoint['did-select']
    // Check if need Clip
    if (selectedRange.isEqual(this.marker!.getBufferRange())) {
      return point
    } else {
      let {start, end} = this.marker!.getBufferRange()
      end = Point.max(start, end.translate([0, -1]))
      if (wise === 'linewise') {
        return new Point(Math.min(end.row, point.row), point.column)
      } else {
        return Point.min(end, point)
      }
    }
  }
}
