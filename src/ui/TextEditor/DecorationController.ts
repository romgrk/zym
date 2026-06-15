/*
 * DecorationController — the editor's generic inline decoration surface: styled
 * spans painted over buffer ranges with GtkTextTags, grouped into named,
 * clearable *layers*.
 *
 * This is the shared rendering path for features that highlight ranges of
 * existing text (as opposed to the syntax highlighter): the search interface
 * (match highlights) and inline diff (line backgrounds) are the intended
 * consumers. Each producer owns a layer and, on every update, re-syncs it
 * (`clear()` then `decorate(...)` the current set) — search/diff recompute their
 * full set anyway, so no per-edit marker bookkeeping is needed; the underlying
 * tags move with edits between updates because GtkTextTags track the text they
 * cover.
 *
 * Tags are created lazily per (layer, style) so layers clear independently, and
 * raised to the top of the tag-table priority so a decoration sits above the
 * syntax colors.
 *
 * Two things deliberately live elsewhere: DIAGNOSTICS render their inline
 * squiggles as custom-drawn Cairo waves (`UnderlineOverlay`) plus gutter
 * source-marks (`lsp/diagnostics/DiagnosticsView`), not tags; and GUTTER icons /
 * inline VIRTUAL TEXT (inlay hints, inline-diff ghosts) want GtkSource
 * source-marks and `GtkSourceAnnotations` (5.18+; we're on 5.20), which land with
 * their consumers. This surface is text-tag background spans only.
 */
import { Gdk, Gtk, type SourceBuffer } from '../../gi.ts';
import { Range, type RangeLike } from '../../text/Range.ts';
import type { EditorModel } from './EditorModel.ts';

/** The built-in decoration styles. Producers re-sync layers using these keys. */
export type DecorationStyle =
  | 'highlight' // search: every match
  | 'highlight-strong' // search: the current match
  | 'added' // diff: an inserted line (full-line background)
  | 'removed' // diff: a deleted line (full-line background)
  | 'filler' // diff (side-by-side): a blank alignment pad on the other side
  | 'word-add' // diff: the changed chars within an added line
  | 'word-del' // diff: the changed chars within a removed line
  | 'flash'; // vim: a brief flash over an operated/yanked range

// Style → background color (hex, alpha-capable via #rrggbbaa). Backgrounds rather
// than foregrounds so they compose with syntax colors. Kept as local constants
// for now; can move to the theme palette when it grows decoration colors.
const STYLE_BACKGROUND: Record<DecorationStyle, string> = {
  highlight: '#e5a50a55',
  'highlight-strong': '#f5c21199',
  added: '#2ec27e26',
  removed: '#e01b2426',
  filler: '#88888820', // dimmed neutral pad for an aligned-but-empty row
  'word-add': '#2ec27e66', // stronger, over the added line's background
  'word-del': '#e01b2466', // stronger, over the removed line's background
  flash: '#f5c21188',
};

// Diff line styles paint the *whole line* (paragraph background, full width);
// the rest are character-span backgrounds (word-level diff, search, flash).
const LINE_STYLES = new Set<DecorationStyle>(['added', 'removed', 'filler']);

/** Parse a `#rgb(a)`/`#rrggbb(aa)` string into a Gdk.RGBA. */
function parseColor(hex: string): InstanceType<typeof Gdk.RGBA> {
  const rgba = new Gdk.RGBA();
  rgba.parse(hex);
  return rgba;
}

export class DecorationController {
  private readonly editor: EditorModel;
  private readonly buffer: SourceBuffer;
  private readonly layers = new Map<string, DecorationLayer>();

  constructor(editor: EditorModel) {
    this.editor = editor;
    this.buffer = editor.buffer;
  }

  /** Get (or create) the decoration layer `name`. One layer per producer. */
  layer(name: string): DecorationLayer {
    let layer = this.layers.get(name);
    if (!layer) {
      layer = new DecorationLayer(this.editor, this.buffer, name);
      this.layers.set(name, layer);
    }
    return layer;
  }
}

/** A named set of decorations a single producer owns and re-syncs as a unit. */
export class DecorationLayer {
  private readonly editor: EditorModel;
  private readonly buffer: SourceBuffer;
  private readonly name: string;
  private readonly tags = new Map<DecorationStyle, InstanceType<typeof Gtk.TextTag>>();

  constructor(editor: EditorModel, buffer: SourceBuffer, name: string) {
    this.editor = editor;
    this.buffer = buffer;
    this.name = name;
  }

  /** Paint `style` over `range`. Empty ranges decorate nothing. */
  decorate(range: RangeLike, style: DecorationStyle): void {
    const r = Range.fromObject(range);
    const tag = this.tagFor(style);
    this.buffer.applyTag(tag, this.editor.iterAtPoint(r.start), this.editor.iterAtPoint(r.end));
  }

  /** Remove every decoration this layer has applied (the re-sync reset). */
  clear(): void {
    const [start, end] = this.buffer.getBounds();
    for (const tag of this.tags.values()) this.buffer.removeTag(tag, start, end);
  }

  private tagFor(style: DecorationStyle): InstanceType<typeof Gtk.TextTag> {
    let tag = this.tags.get(style);
    if (tag) return tag;

    tag = new Gtk.TextTag({ name: `deco:${this.name}:${style}` } as any);
    // Line styles use paragraph-background (full-width); spans use char background.
    if (LINE_STYLES.has(style)) (tag as any).paragraphBackgroundRgba = parseColor(STYLE_BACKGROUND[style]);
    else (tag as any).backgroundRgba = parseColor(STYLE_BACKGROUND[style]);
    const table = this.buffer.getTagTable();
    table.add(tag);
    // Sit above the syntax tags so the decoration wins overlaps.
    tag.setPriority(table.getSize() - 1);
    this.tags.set(style, tag);
    return tag;
  }
}
