/*
 * MarkerLayer — a named collection of Markers over one buffer.
 *
 * Mirrors the slice of Atom's marker-layer API the vim layer uses (vim marks,
 * search/flash highlights): create position/range markers, enumerate them, and
 * be notified when the set changes. Markers are anonymous `GtkTextMark`s, so a
 * layer can hold any number without name collisions. `onDidUpdate` fires when
 * markers are added or removed; per-edit movement is handled by GTK itself.
 */
import { Range } from '../../text/Range.ts';
import { Point } from '../../text/Point.ts';
import { Emitter, type Disposable } from '../../util/eventKit.ts';
import { Marker } from './Marker.ts';
import type { EditorModel } from './EditorModel.ts';

export interface FindMarkersOptions {
  /** Only markers whose range contains this position. */
  containsBufferPosition?: Point;
}

export class MarkerLayer {
  private readonly editor: EditorModel;
  private readonly markers = new Set<Marker>();
  private readonly emitter = new Emitter();
  private destroyed = false;

  constructor(editor: EditorModel) {
    this.editor = editor;
  }

  /** A marker at a single position, tracking the character to its right. */
  markBufferPosition(point: Point): Marker {
    const mark = this.editor.buffer.createMark(null, this.editor.iterAtPoint(point), false);
    return this.track(new Marker(this.editor, mark, mark, (m) => this.forget(m)));
  }

  /** A marker spanning a range, growing to cover text typed at its boundaries. */
  markBufferRange(range: Range): Marker {
    const { buffer } = this.editor;
    const start = buffer.createMark(null, this.editor.iterAtPoint(range.start), true);
    const end = buffer.createMark(null, this.editor.iterAtPoint(range.end), false);
    return this.track(new Marker(this.editor, start, end, (m) => this.forget(m)));
  }

  getMarkers(): Marker[] {
    return [...this.markers];
  }

  getMarkerCount(): number {
    return this.markers.size;
  }

  findMarkers(options: FindMarkersOptions = {}): Marker[] {
    let result = this.getMarkers();
    if (options.containsBufferPosition) {
      const position = options.containsBufferPosition;
      result = result.filter((marker) => marker.getRange().containsPoint(position));
    }
    return result;
  }

  /** Destroy every marker, leaving the layer itself usable. */
  clear(): void {
    for (const marker of [...this.markers]) marker.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clear();
  }

  onDidUpdate(callback: () => void): Disposable {
    return this.emitter.on('did-update', callback);
  }

  private track(marker: Marker): Marker {
    this.markers.add(marker);
    this.emitter.emit('did-update');
    return marker;
  }

  private forget(marker: Marker): void {
    this.markers.delete(marker);
    this.emitter.emit('did-update');
  }
}
