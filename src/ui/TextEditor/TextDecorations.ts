/*
 * TextDecorations — the editor's generic inline decoration surface: styled
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
 * Two surfaces compose here: tag background-spans (the layers below) AND drawn
 * diagnostic squiggles — an internal `UnderlineOverlay` (Cairo waves), pushed via
 * `setUnderlines`, so a producer never holds the overlay directly. What still lives
 * with its consumer: GUTTER icons and trailing VIRTUAL TEXT (inlay hints, error
 * lens) — gutter source-marks + `GtkSourceAnnotations` (see `VirtualText`).
 */
import { Gdk, Gtk, type SourceBuffer } from '../../gi.ts';
import { Range, type RangeLike } from '../../text/Range.ts';
import { theme } from '../../theme/theme.ts';
import type { EditorModel } from './EditorModel.ts';
import { UnderlineOverlay, type Underline } from './UnderlineOverlay.ts';

export type { Underline };

// Built-in decoration styles, split by Atom's two range-tag categories: a `line`
// style paints the WHOLE line (paragraph background, full width); a `highlight`
// style paints a character RANGE. `decorate(range, style)` takes either — the
// category (LINE_STYLES) just picks paragraph- vs char-background.

/** Atom `line` decorations — full-line (paragraph) backgrounds. */
export type LineStyle =
  | 'added' // diff: an inserted line
  | 'removed' // diff: a deleted line
  | 'filler' // diff (side-by-side): a blank alignment pad on the other side
  | 'fold'; // diff: a collapsed-unchanged-lines placeholder row

/** Atom `highlight` decorations — character-range backgrounds. */
export type HighlightStyle =
  | 'highlight' // search: every match
  | 'highlight-strong' // search: the current match
  | 'word-add' // diff: the changed chars within an added line
  | 'word-del' // diff: the changed chars within a removed line
  | 'flash'; // vim: a brief flash over an operated/yanked range

export type DecorationStyle = LineStyle | HighlightStyle;

// Style → background color (hex, alpha-capable via #rrggbbaa). Backgrounds rather
// than foregrounds so they compose with syntax colors. All tints come from the
// theme palette (kept dim so text stays readable).
const STYLE_BACKGROUND: Record<DecorationStyle, string> = {
  highlight: theme.ui.searchMatch,
  'highlight-strong': theme.ui.searchMatchCurrent,
  added: theme.ui.diffAddedBg,
  removed: theme.ui.diffRemovedBg,
  filler: theme.ui.diffFillerBg, // dimmed neutral pad for an aligned-but-empty row
  'word-add': theme.ui.diffAddedWordBg, // stronger, over the added line's background
  'word-del': theme.ui.diffRemovedWordBg, // stronger, over the removed line's background
  fold: theme.ui.diffFoldBg, // faint neutral band for a collapsed-context placeholder
  flash: theme.ui.flash,
};

// The `line`-category styles (paragraph background); everything else is a char span.
// Built from `LineStyle` (so the members are checked) but typed wide enough to test a
// `DecorationStyle`.
const LINE_STYLES: ReadonlySet<DecorationStyle> = new Set<LineStyle>(['added', 'removed', 'filler', 'fold']);

/** Parse a `#rgb(a)`/`#rrggbb(aa)` string into a Gdk.RGBA. */
function parseColor(hex: string): InstanceType<typeof Gdk.RGBA> {
  const rgba = new Gdk.RGBA();
  rgba.parse(hex);
  return rgba;
}

export class TextDecorations {
  private readonly editor: EditorModel;
  private readonly buffer: SourceBuffer;
  private readonly layers = new Map<string, DecorationLayer>();
  // Drawn diagnostic squiggles live here too — an internal Cairo overlay, so producers
  // push underlines through this one surface rather than holding the overlay directly.
  private readonly underlines: UnderlineOverlay;

  constructor(editor: EditorModel) {
    this.editor = editor;
    this.buffer = editor.buffer;
    this.underlines = new UnderlineOverlay(editor.view, editor);
  }

  /** The squiggle overlay's widget — the editor adds it to its overlay layer once. */
  get underlineWidget(): InstanceType<typeof Gtk.DrawingArea> {
    return this.underlines.widget;
  }
  /** Replace the full set of drawn underlines (diagnostic squiggles). */
  setUnderlines(items: Underline[]): void {
    this.underlines.setUnderlines(items);
  }
  /** Clear all drawn underlines. */
  clearUnderlines(): void {
    this.underlines.clear();
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
  // Tags created lazily, keyed by a string (the built-in style, or a tint's
  // colors), so a repeated style/color reuses its tag and the whole layer clears
  // in one pass.
  private readonly tags = new Map<string, InstanceType<typeof Gtk.TextTag>>();

  constructor(editor: EditorModel, buffer: SourceBuffer, name: string) {
    this.editor = editor;
    this.buffer = buffer;
    this.name = name;
  }

  /** Paint a built-in `style` over `range`. Empty ranges decorate nothing. */
  decorate(range: RangeLike, style: DecorationStyle): void {
    this.apply(range, this.tagForStyle(style));
  }

  /** Paint an arbitrary background (+ optional foreground) over a range — for producers
   *  (e.g. plugins) whose colors aren't a fixed `DecorationStyle`. By default a char
   *  RANGE (Atom `highlight`); pass `wholeLine` for a full-line paragraph background
   *  (Atom `line`) — so a plugin can apply a generic line decoration too. Colors are any
   *  string `Gdk.RGBA.parse` accepts (`#rrggbb(aa)`, `rgb()/rgba()`, …). */
  tint(range: RangeLike, colors: { background: string; foreground?: string; wholeLine?: boolean }): void {
    this.apply(range, this.tagForColors(colors));
  }

  /** Remove every decoration this layer has applied (the re-sync reset). */
  clear(): void {
    const [start, end] = this.buffer.getBounds();
    for (const tag of this.tags.values()) this.buffer.removeTag(tag, start, end);
  }

  private apply(range: RangeLike, tag: InstanceType<typeof Gtk.TextTag>): void {
    const r = Range.fromObject(range);
    this.buffer.applyTag(tag, this.editor.iterAtPoint(r.start), this.editor.iterAtPoint(r.end));
  }

  private tagForStyle(style: DecorationStyle): InstanceType<typeof Gtk.TextTag> {
    // Map key namespaced so it can't collide with a tint; tag *name* unchanged
    // (`deco:<layer>:<style>`) — consumers/tests look these up by name.
    return this.tagFor(`style:${style}`, `deco:${this.name}:${style}`, (tag) => {
      // Line styles use paragraph-background (full-width); spans use char background.
      if (LINE_STYLES.has(style)) (tag as any).paragraphBackgroundRgba = parseColor(STYLE_BACKGROUND[style]);
      else (tag as any).backgroundRgba = parseColor(STYLE_BACKGROUND[style]);
    });
  }

  private tagForColors(colors: { background: string; foreground?: string; wholeLine?: boolean }): InstanceType<typeof Gtk.TextTag> {
    const key = `tint:${colors.background}|${colors.foreground ?? ''}|${colors.wholeLine ? 'L' : 'C'}`;
    return this.tagFor(key, `deco:${this.name}:${key}`, (tag) => {
      // wholeLine → paragraph-background (full width, like a `line` style); else a char span.
      if (colors.wholeLine) (tag as any).paragraphBackgroundRgba = parseColor(colors.background);
      else (tag as any).backgroundRgba = parseColor(colors.background);
      if (colors.foreground) (tag as any).foregroundRgba = parseColor(colors.foreground);
    });
  }

  /** Get (or lazily create + configure) the tag for `key` (named `name`), raised
   *  above syntax. */
  private tagFor(
    key: string,
    name: string,
    configure: (tag: InstanceType<typeof Gtk.TextTag>) => void,
  ): InstanceType<typeof Gtk.TextTag> {
    let tag = this.tags.get(key);
    if (tag) return tag;
    tag = new Gtk.TextTag({ name } as any);
    configure(tag);
    const table = this.buffer.getTagTable();
    table.add(tag);
    tag.setPriority(table.getSize() - 1); // sit above syntax tags so the decoration wins overlaps
    this.tags.set(key, tag);
    return tag;
  }
}
