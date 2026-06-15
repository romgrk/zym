// PositionHistory — the backing store for the jump list (ctrl-o / ctrl-i) and the
// change list (g; / g,). Both are an ordered ring of buffer positions, oldest →
// newest, held as markers so they track edits, plus an `index` cursor used while
// navigating. `index === entries.length` means "at the present" (not navigating).
//
// This isn't an upstream vim-mode-plus module (vmp leans on Atom for jumps); it's
// a quilx addition that the motion layer and the misc-command ops drive.
import { Point } from '../../../text/Point.ts'

const MAX_ENTRIES = 100

export default class PositionHistory {
  constructor (vimState) {
    this.vimState = vimState
    this.editor = vimState.editor
    this.markerLayer = vimState.editor.addMarkerLayer()
    this.entries = [] // markers, oldest first
    this.index = 0 // entries.length === present (not navigating)
    vimState.onDidDestroy(() => this.destroy())
  }

  destroy () {
    if (this.markerLayer) this.markerLayer.destroy()
    this.markerLayer = null
    this.entries = []
  }

  positionAt (i) {
    return this.entries[i].getStartBufferPosition()
  }

  sameRow (marker, point) {
    return marker && marker.getStartBufferPosition().row === point.row
  }

  mark (point) {
    return this.markerLayer.markBufferPosition(this.editor.clipBufferPosition(point), {invalidate: 'never'})
  }

  // Append `point` as the newest entry and return to "present". Drops any forward
  // history left by navigation and collapses a consecutive same-row entry, so a
  // line appears once in a row (Vim's jump/change lists both dedup by line).
  add (point) {
    point = Point.fromObject(point)
    // Drop forward history beyond the current position.
    while (this.entries.length > this.index + 1) this.entries.pop().destroy()
    const last = this.entries[this.entries.length - 1]
    if (this.sameRow(last, point)) this.entries.pop().destroy()
    this.entries.push(this.mark(point))
    while (this.entries.length > MAX_ENTRIES) this.entries.shift().destroy()
    this.index = this.entries.length
  }

  // ctrl-o / g; — step `count` entries toward older positions. On the first step
  // from the present, stash `currentPoint` as the newest entry so the matching
  // forward command can return to it. Returns the target position, or null when
  // there's nothing older.
  goBackward (currentPoint, count = 1) {
    currentPoint = Point.fromObject(currentPoint)
    if (this.index >= this.entries.length) {
      if (!this.sameRow(this.entries[this.entries.length - 1], currentPoint)) {
        this.entries.push(this.mark(currentPoint))
      }
      this.index = this.entries.length - 1
    }
    if (this.index <= 0) return null
    this.index = Math.max(0, this.index - count)
    return this.positionAt(this.index)
  }

  // ctrl-i / g, — step `count` entries toward newer positions. Returns the target
  // position, or null when already at the newest.
  goForward (_currentPoint, count = 1) {
    if (this.index >= this.entries.length - 1) return null
    this.index = Math.min(this.entries.length - 1, this.index + count)
    return this.positionAt(this.index)
  }
}
