/*
 * BlockDecorationSet — the declarative layer over the generic `BlockDecorations` primitive.
 *
 * A consumer (the project-search / continuous-diff header+gap bands, the markdown image preview)
 * declares a set of block decorations against STABLE SOURCE anchors — `{ sourceKey?, row }` — and
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
import type { Gtk } from '../../gi.ts';
import type { BlockDecorations, BlockDecorationHandle, BlockDecorationPlacement } from './BlockDecorations.ts';

/**
 * Where a decoration is anchored. Two forms:
 *  - a SOURCE position `{ sourceKey?, row }` (sourceKey omitted → the sole source) — the editor
 *    projects it to a view row and can RE-PROJECT it after a materialize. Preferred: it survives
 *    collapse/reflow/reload. Used by search (headers/gaps) and markdown (images).
 *  - a direct `{ viewRow }` — for a COMPUTED surface (the continuous diff) that recomputes its own
 *    structure and re-`set()`s on every change, where the first view row may be a phantom (old-side)
 *    row with no stable source position. Not re-projectable across a materialize (the surface never
 *    materializes — it splices), so the owner must re-`set()` after any structural change.
 */
export type BlockDecorationAnchor = { sourceKey?: string; row: number } | { viewRow: number };

export interface BlockDecorationSpec {
  /** Stable identity across `set()` calls — a decoration is reused/moved/removed by `id`. */
  id: string;
  /** Content identity — the widget is rebuilt only when this changes. */
  key: string;
  anchor: BlockDecorationAnchor;
  placement?: BlockDecorationPlacement;
  build: () => InstanceType<typeof Gtk.Widget>;
}

/** Maps a source anchor to its current view row, or null when it isn't shown (collapsed / off the
 *  projection). Supplied by the owning TextEditor (closing over its projection). */
export type AnchorResolver = (anchor: BlockDecorationAnchor) => number | null;

export class BlockDecorationSet {
  private readonly entries = new Map<string, { handle: BlockDecorationHandle; key: string }>();
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
    this.reconcile();
  }

  /** Re-place every decoration from the current projection — for after a re-materialize, where the
   *  marks were lost. Driven by the editor's `onDidMaterialize`. */
  reproject(): void {
    this.reconcile();
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.handle.remove();
    this.entries.clear();
    this.lastSpecs = [];
  }

  private reconcile(): void {
    const seen = new Set<string>();
    for (const spec of this.lastSpecs) {
      const line = this.resolve(spec.anchor);
      if (line == null) continue; // anchor not currently visible → treat as removed (below)
      seen.add(spec.id);
      const prev = this.entries.get(spec.id);
      if (prev) {
        prev.handle.update({ line, widget: prev.key === spec.key ? undefined : spec.build() });
        prev.key = spec.key;
      } else {
        const handle = this.blocks.add({ line, widget: spec.build(), placement: spec.placement });
        this.entries.set(spec.id, { handle, key: spec.key });
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
