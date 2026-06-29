/*
 * EditorSourceView — the editor's GtkSource.View subclass.
 *
 * Its only addition is a snapshot hook so the editor can paint the indent guides
 * and diagnostic squiggles INSIDE the view's own snapshot, instead of as
 * viewport-pinned `Gtk.Overlay` `DrawingArea`s. Those overlays had to repaint on
 * every scroll frame because they were anchored to the viewport while the text
 * scrolled underneath. Folding them into the view's snapshot — which GTK re-runs on
 * scroll for free — drops the per-frame `value-changed`→queue_draw plumbing and the
 * two extra viewport-sized compositing layers. See docs/text-editor/index.md
 * ("Scrolling & open performance").
 *
 * We override GtkTextView's `snapshot_layer` vfunc, which GTK invokes per snapshot
 * for the BELOW_TEXT and ABOVE_TEXT layers (between the background and the text, and
 * above the text). It runs in BUFFER coordinates and does NOT touch the text render
 * itself, so overriding it leaves the cached-line text rendering untouched.
 *
 * We do NOT chain up to `super`: node-gtk's `super.<vfunc>()` segfaults here
 * (`g_vfunc_info_get_address` → `g_interface_info_get_iface_struct` assertion, even
 * for `snapshot`). So this override REPLACES GtkSourceView's own `snapshot_layer`,
 * which draws the current-line highlight + right-margin guide — verified by rendering
 * with/without. The editor re-draws the current-line highlight itself
 * (TextEditor.paintCurrentLine); the right-margin guide is imperceptible with our
 * scheme and isn't re-drawn. The text render is untouched (it's a separate phase).
 */
import GtkSource from 'gi:GtkSource-5';

// Paints one snapshot layer; `layer` is a Gtk.TextViewLayer, the snapshot is in
// BUFFER coordinates. Typed `any` like the other node-gtk vfunc overrides (see
// GutterRenderer.virtual_queryData).
export type LayerPainter = (layer: any, snapshot: any) => void;

export class EditorSourceView extends GtkSource.View {
  // Assigned by TextEditor right after construction. node-gtk preserves instance
  // props as `this` inside vfuncs (same pattern as GutterRenderer.controller), so
  // a plain field set externally is visible here.
  layerPainter?: LayerPainter;

  virtual_snapshotLayer(layer: any, snapshot: any): void {
    this.layerPainter?.(layer, snapshot);
  }
}
