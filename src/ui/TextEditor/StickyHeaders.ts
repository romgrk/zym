/*
 * StickyHeaders — reusable per-excerpt sticky headers for ANY multibuffer surface (the multi-file
 * diff today, project-search next): a header pinned to the top of the viewport (VSCode-style sticky
 * scroll) while its excerpt scrolls under it (docs/text-editor/diff.md).
 *
 * A self-contained abstraction over the `BlockDecorations` primitive — the surface only supplies the
 * header set (a `viewRow` + a widget builder per excerpt) and StickyHeaders owns everything generic:
 *   - PLACEMENT: each header is an `on`-placed, `sticky` block decoration — a real widget COVERING
 *     its (empty, read-only) header line (so the caret rests on it), a child of the TEXT WINDOW (so
 *     it scrolls natively: smooth on a touchpad, never swallows scroll, clips to the viewport, stays
 *     click-to-jump), full-width and pinned to the viewport on both axes. The primitive owns the
 *     slot pooling, band reservation, timing, push-up, and the sticky clamp.
 *   - FOCUS: it follows the caret and toggles `.focused` on the header whose row the caret sits on.
 *   - NO-CURSOR: it hides the caret on the (read-only) header rows via the `no-cursor` decoration.
 *
 * So nothing here is diff-specific — the diff's chevron/stats look and search's icon/dir look are
 * just the widget the surface builds. One widget per excerpt; the primitive's push-up keeps exactly
 * one header pinned. Surfaces drive it via `setHeaders` on each structural change (re-diff / collapse).
 */
import type Gtk from 'gi:Gtk-4.0';
import type { BlockDecorations, BlockDecorationHandle } from './BlockDecorations.ts';
import type { EditorModel } from './EditorModel.ts';
import type { TextDecorations } from './TextDecorations.ts';
import { CompositeDisposable } from '../../util/eventKit.ts';

const FOCUSED_CLASS = 'mb-header-focused';

/** One excerpt's sticky header. `id` is stable per excerpt (e.g. its path); `key` is the content
 *  identity (rebuild the widget only when it changes); `viewRow` is the EMPTY navigable header block
 *  row the widget covers. */
export interface StickyHeaderSpec {
  id: string;
  key: string;
  viewRow: number;
  build: () => InstanceType<typeof Gtk.Widget>;
  /** Sever anything node-gtk roots on the built widget (the click controller) when it's replaced or
   *  removed — paired with `build` (see docs/lifecycle-and-disposal.md rule 9). */
  dispose?: () => void;
}

interface Entry {
  handle: BlockDecorationHandle;
  widget: any;
  key: string;
  viewRow: number;
  dispose?: () => void;
}

export class StickyHeaders {
  private readonly blocks: BlockDecorations;
  private readonly model: EditorModel;
  private readonly decorations: TextDecorations;
  private readonly entries = new Map<string, Entry>();
  private focusedRow: number | null = null;
  private readonly subs = new CompositeDisposable();
  private subscribed = false;

  constructor(blocks: BlockDecorations, model: EditorModel, decorations: TextDecorations) {
    this.blocks = blocks;
    this.model = model;
    this.decorations = decorations;
  }

  /** Declare the header set; reconciles in place (reuse by `id`, rebuild a widget only when its
   *  `key` changed, remove gone) and re-syncs the no-cursor decoration + focus. Call on each
   *  structural change (re-diff / collapse) — header rows shift, so anchors re-set from the fresh
   *  `viewRow`s. */
  setHeaders(specs: StickyHeaderSpec[]): void {
    this.subscribeOnce();
    const seen = new Set<string>();
    for (const spec of specs) {
      seen.add(spec.id);
      const prev = this.entries.get(spec.id);
      if (prev) {
        if (prev.key !== spec.key) {
          prev.dispose?.(); // old widget is about to be replaced — sever its rooted controllers
          prev.widget = spec.build();
          prev.handle.update({ line: spec.viewRow, widget: prev.widget });
          prev.key = spec.key;
          prev.dispose = spec.dispose;
        } else {
          prev.handle.update({ line: spec.viewRow }); // unchanged content — keep the widget, re-anchor
        }
        prev.viewRow = spec.viewRow;
      } else {
        const widget = spec.build();
        const handle = this.blocks.add({ line: spec.viewRow, widget, placement: 'on', sticky: true });
        this.entries.set(spec.id, { handle, widget, key: spec.key, viewRow: spec.viewRow, dispose: spec.dispose });
      }
    }
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) {
        entry.dispose?.();
        entry.handle.remove();
        this.entries.delete(id);
      }
    }
    this.syncNoCursor();
    this.recomputeFocusedRow();
    this.applyFocus(); // always — widgets may have been rebuilt this set()
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      entry.dispose?.(); // sever the widget's controllers before dropping it
      entry.handle.remove();
    }
    this.entries.clear();
    if (this.subscribed) this.decorations.setNoCursorRanges([]);
    this.focusedRow = null;
  }

  /** Idempotent teardown (the editor owns the underlying `BlockDecorations`; this drops our handles,
   *  severs each header widget's controllers, and detaches the caret subscription). */
  dispose(): void {
    this.subs.dispose();
    this.clear();
  }

  // --- internals -------------------------------------------------------------

  /** Follow the caret to keep the focused-header highlight in sync (lazy — a plain editor never
   *  declares headers, so it never subscribes). */
  private subscribeOnce(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.subs.connect(this.model.buffer, 'notify::cursor-position', () => this.updateFocus());
  }

  /** Hide the caret on every (read-only) header row — the band reads `.focused` instead. Spans each
   *  row's newline so the marker is present at column 0 (an empty line has no glyph). */
  private syncNoCursor(): void {
    const ranges = [...this.entries.values()].map((e) => [[e.viewRow, 0], [e.viewRow + 1, 0]] as [[number, number], [number, number]]);
    this.decorations.setNoCursorRanges(ranges);
  }

  private updateFocus(): void {
    const prev = this.focusedRow;
    this.recomputeFocusedRow();
    if (this.focusedRow !== prev) this.applyFocus();
  }

  private recomputeFocusedRow(): void {
    const row = this.model.getCursorBufferPosition().row;
    let focused: number | null = null;
    for (const entry of this.entries.values()) if (entry.viewRow === row) { focused = row; break; }
    this.focusedRow = focused;
  }

  private applyFocus(): void {
    for (const entry of this.entries.values()) {
      const on = this.focusedRow != null && entry.viewRow === this.focusedRow;
      if (on) entry.widget.addCssClass(FOCUSED_CLASS);
      else entry.widget.removeCssClass(FOCUSED_CLASS);
    }
  }
}
