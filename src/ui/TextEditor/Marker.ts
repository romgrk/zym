/*
 * Marker — a buffer range (or position) that moves with edits, backed by
 * `GtkTextMark`s.
 *
 * A position marker uses a single mark (start and end coincide); a range marker
 * uses two. The marks carry gravity so the span behaves sensibly as text is
 * typed: the start has left gravity and the end right gravity, so an insert at
 * either boundary is pulled *into* the range (the range grows to cover typed
 * text). A position marker uses right gravity, tracking the character to its
 * right like a cursor. These choices may be revisited per consumer.
 *
 * Markers are created and owned by a `MarkerLayer`; destroying one removes its
 * marks from the buffer and detaches it from the layer.
 */
import { Range } from '../../text/Range.ts';
import { Point } from '../../text/Point.ts';
import { unwrapIter, type TextMark } from './iter.ts';
import type { EditorModel } from './EditorModel.ts';

export class Marker {
  private readonly editor: EditorModel;
  private readonly startMark: TextMark;
  private readonly endMark: TextMark;
  private readonly onDestroyed: (marker: Marker) => void;
  private destroyed = false;

  constructor(
    editor: EditorModel,
    startMark: TextMark,
    endMark: TextMark,
    onDestroyed: (marker: Marker) => void,
  ) {
    this.editor = editor;
    this.startMark = startMark;
    this.endMark = endMark;
    this.onDestroyed = onDestroyed;
  }

  private positionOf(mark: TextMark): Point {
    return this.editor.pointAtIter(unwrapIter(this.editor.buffer.getIterAtMark(mark)));
  }

  getStartBufferPosition(): Point {
    return this.positionOf(this.startMark);
  }

  getEndBufferPosition(): Point {
    return this.positionOf(this.endMark);
  }

  /** The head is the end of the marked range (the moving edge). */
  getHeadBufferPosition(): Point {
    return this.getEndBufferPosition();
  }

  /** The tail is the start of the marked range (the anchor). */
  getTailBufferPosition(): Point {
    return this.getStartBufferPosition();
  }

  getRange(): Range {
    return new Range(this.getStartBufferPosition(), this.getEndBufferPosition());
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const { buffer } = this.editor;
    buffer.deleteMark(this.startMark);
    if (this.endMark !== this.startMark) buffer.deleteMark(this.endMark);
    this.onDestroyed(this);
  }
}
