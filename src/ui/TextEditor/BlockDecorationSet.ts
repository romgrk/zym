/*
 * BlockDecorationSet — the declarative layer over the generic `BlockDecorations` primitive.
 *
 * A consumer (the project-search / continuous-diff header+gap bands, the markdown image preview)
 * declares a set of block decorations against STABLE SOURCE anchors — `{ documentKey?, row }` — and
 * calls `set(specs)` only when its LOGICAL model changes (collapse/expand, a re-diff, an image
 * added/removed). This layer reconciles the set by `id` (add new / remove gone / swap a survivor's
 * widget only when its `key` changed) and projects each anchor to a VIEW row via the editor's
 * projection.
 *
 * It deliberately does NOT subscribe to edits: the primitive anchors each decoration with a
 * left-gravity GtkTextMark that already tracks every incremental view edit/splice (write-through,
 * undo, diff retarget, collapse) on its own — see BlockDecorationAnchor.test.ts. Re-projection is
 * needed ONLY after a full re-materialize (setText drops marks); the owning TextEditor drives that
 * via `reproject()` on `onDidMaterialize`.
 *
 * "Band" is a consumer concept (a filename header band, a `⋯` gap band) — it does not appear here.
 */
import type Gtk from 'gi:Gtk-4.0';
import type { BlockDecorations, BlockDecorationHandle, BlockDecorationPlacement, BlockWidth } from './BlockDecorations.ts';

/**
 * Where a decoration is anchored. Two forms:
 *  - a SOURCE position `{ documentKey?, row }` (documentKey omitted → the sole source) — the editor
 *    projects it to a view row and can RE-PROJECT it after a materialize. Preferred: it survives
 *    collapse/reflow/reload. Used by search (headers/gaps) and markdown (images).
 *  - a direct `{ viewRow }` — for a COMPUTED surface (the continuous diff) that recomputes its own
 *    structure and re-`set()`s on every change, where the first view row may be a phantom (old-side)
 *    row with no stable source position. Not re-projectable across a materialize (the surface never
 *    materializes — it splices), so the owner must re-`set()` after any structural change.
 */
export type BlockDecorationAnchor = { documentKey?: string; row: number } | { viewRow: number };

export interface BlockDecorationSpec {
  /** Stable identity across `set()` calls — a decoration is reused/moved/removed by `id`. */
  id: string;
  /** Content identity — the widget is rebuilt only when this changes. */
  key: string;
  anchor: BlockDecorationAnchor;
  placement?: BlockDecorationPlacement;
  /** Make a non-sticky band span the row while scrolling with the text — `'viewport'` (visible width)
   *  or `'content'` (full content width, so it stays full-width at any hscroll). See `BlockDecorationOptions`. */
  fullWidth?: BlockWidth;
  /** Widget-free line-height reservation, replaced with the measured height while resident. */
  height?: number;
  build: () => InstanceType<typeof Gtk.Widget>;
  /** Called when THIS spec's built widget is dropped — replaced on a `key` change, removed when
   *  the decoration leaves the set, or on `clear()`. Use it to sever anything node-gtk roots on
   *  the widget (an event controller's signal closures), which would otherwise pin the discarded
   *  widget forever (see docs/lifecycle-and-disposal.md rule 9). Paired with the matching `build`. */
  dispose?: () => void;
}

/** Maps a source anchor to its current view row, or null when it isn't shown (collapsed / off the
 *  projection). Supplied by the owning TextEditor (closing over its projection). */
export type AnchorResolver = (anchor: BlockDecorationAnchor) => number | null;

export class BlockDecorationSet {
  private readonly entries = new Map<string, { handle: BlockDecorationHandle; key: string; line: number }>();
  private readonly blocks: BlockDecorations;
  private readonly resolve: AnchorResolver;
  private lastSpecs: BlockDecorationSpec[] = [];

  constructor(blocks: BlockDecorations, resolve: AnchorResolver) {
    this.blocks = blocks;
    this.resolve = resolve;
  }

  /** Declare the decoration set; reconciles in place. Call on logical-model changes only — between
   *  calls the primitive's marks keep each decoration positioned. */
  set(specs: BlockDecorationSpec[]): void {
    this.lastSpecs = specs;
    this.blocks.transact(() => this.reconcile(false));
  }

  /** Re-place every decoration from the current projection — for after a re-materialize, where the
   *  marks were lost. Driven by the editor's `onDidMaterialize`. */
  reproject(): void {
    this.blocks.transact(() => this.reconcile(true));
  }

  clear(): void {
    this.blocks.transact(() => {
      for (const entry of this.entries.values()) entry.handle.remove();
    });
    this.entries.clear();
    this.lastSpecs = [];
  }

  /** `force` re-seats a decoration even when its resolved line is unchanged — after a
   *  re-materialize its anchor mark is gone, so the line comparison alone would wrongly skip it. */
  private reconcile(force: boolean): void {
    const seen = new Set<string>();
    for (const spec of this.lastSpecs) {
      const line = this.resolve(spec.anchor);
      if (line == null) continue; // anchor not currently visible → treat as removed (below)
      seen.add(spec.id);
      const prev = this.entries.get(spec.id);
      if (prev) {
        if (prev.key === spec.key) {
          // The primitive verifies a changed logical row against the mark; when the splice already
          // carried it this is a native no-op, while ambiguous structural insertions get re-seated.
          if (force || prev.line !== line) prev.handle.update({ line });
        } else {
          prev.handle.update({
            line,
            build: spec.build,
            dispose: spec.dispose,
            height: spec.height,
          });
          prev.key = spec.key;
        }
        prev.line = line;
      } else {
        const handle = this.blocks.add({
          line,
          build: spec.build,
          dispose: spec.dispose,
          height: spec.height,
          placement: spec.placement,
          fullWidth: spec.fullWidth,
        });
        this.entries.set(spec.id, { handle, key: spec.key, line });
      }
    }
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) {
        entry.handle.remove();
        this.entries.delete(id);
      }
    }
  }
}
