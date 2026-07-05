// PositionHistory — the backing store for the per-editor jump list (the
// vim-mode-plus:jump-backward/-forward commands, unbound by default) and the
// change list (g; / g,). Both are an ordered ring of buffer positions, oldest →
// newest, held as markers so they track edits, plus an `index` cursor used while
// navigating. `index === entries.length` means "at the present" (not navigating).
//
// This isn't an upstream vim-mode-plus module (vmp leans on Atom for jumps); it's
// a zym addition that the motion layer and the misc-command ops drive.
import { Point } from '../../../text/Point.ts'
import type { PointLike } from '../../../text/Point.ts'
import { Emitter, type Disposable } from '../../../util/eventKit.ts'
import type VimState from './vim-state.ts'
import type { EditorModel } from '../EditorModel.ts'
import type { MarkerLayer } from '../MarkerLayer.ts'
import type { Marker } from '../Marker.ts'

const MAX_ENTRIES = 100

export default class PositionHistory {
  vimState: VimState
  editor: EditorModel
  // `markerLayer` is nulled out in `destroy()`.
  markerLayer: MarkerLayer | null
  entries: Marker[]
  index: number
  private readonly emitter = new Emitter()

  constructor (vimState: VimState) {
    this.vimState = vimState
    this.editor = vimState.editor
    this.markerLayer = vimState.editor.addMarkerLayer()
    this.entries = [] // markers, oldest first
    this.index = 0 // entries.length === present (not navigating)
    vimState.onDidDestroy(() => this.destroy())
  }

  destroy (): void {
    if (this.markerLayer) this.markerLayer.destroy()
    this.markerLayer = null
    this.entries = []
  }

  positionAt (i: number): Point {
    return this.entries[i].getStartBufferPosition()
  }

  sameRow (marker: Marker | undefined, point: Point): boolean {
    return Boolean(marker && marker.getStartBufferPosition().row === point.row)
  }

  mark (point: Point): Marker {
    // markBufferPosition's runtime impl ignores the options object; the cast
    // keeps the original call shape without a behavior change.
    // TODO(vim-ts): tighten if MarkerLayer.markBufferPosition gains an options arg.
    return (this.markerLayer!.markBufferPosition as any)(this.editor.clipBufferPosition(point), {invalidate: 'never'})
  }

  /** Fires with the buffer position each time an entry is recorded via `add` —
   *  the seam the workspace-wide jump list aggregates per-editor jumps through. */
  onDidAdd (fn: (point: Point) => void): Disposable {
    return this.emitter.on('did-add', fn as (value?: unknown) => void)
  }

  // Append `point` as the newest entry and return to "present". Drops any forward
  // history left by navigation and collapses a consecutive same-row entry, so a
  // line appears once in a row (Vim's jump/change lists both dedup by line).
  add (point: PointLike): void {
    point = Point.fromObject(point)
    // Drop forward history beyond the current position.
    while (this.entries.length > this.index + 1) this.entries.pop()!.destroy()
    const last = this.entries[this.entries.length - 1]
    if (this.sameRow(last, point as Point)) this.entries.pop()!.destroy()
    this.entries.push(this.mark(point as Point))
    while (this.entries.length > MAX_ENTRIES) this.entries.shift()!.destroy()
    this.index = this.entries.length
    this.emitter.emit('did-add', point)
  }

  // jump-backward / g; — step `count` entries toward older positions. On the first step
  // from the present, stash `currentPoint` as the newest entry so the matching
  // forward command can return to it. Returns the target position, or null when
  // there's nothing older.
  goBackward (currentPoint: PointLike, count = 1): Point | null {
    currentPoint = Point.fromObject(currentPoint)
    if (this.index >= this.entries.length) {
      if (!this.sameRow(this.entries[this.entries.length - 1], currentPoint as Point)) {
        this.entries.push(this.mark(currentPoint as Point))
      }
      this.index = this.entries.length - 1
    }
    if (this.index <= 0) return null
    this.index = Math.max(0, this.index - count)
    return this.positionAt(this.index)
  }

  // jump-forward / g, — step `count` entries toward newer positions. Returns the target
  // position, or null when already at the newest.
  goForward (_currentPoint: PointLike, count = 1): Point | null {
    if (this.index >= this.entries.length - 1) return null
    this.index = Math.min(this.entries.length - 1, this.index + count)
    return this.positionAt(this.index)
  }
}
